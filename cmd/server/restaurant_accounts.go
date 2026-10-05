package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
	"golang.org/x/text/cases"
	"golang.org/x/text/unicode/norm"
)

const (
	restaurantCustomerSessionLifetime = 7 * 24 * time.Hour
	restaurantCustomerMaxSessions     = 10
	restaurantPasswordCost            = 12
	restaurantPasswordHashPrefix      = "bcrypt-sha256-v1:"
)

// A process-wide bound also applies when multiple stores are initialized. Busy
// password operations fail fast rather than queueing unbounded expensive work.
var restaurantPasswordSlots = make(chan struct{}, 2)
var restaurantDummyPassword struct {
	sync.Once
	hash []byte
	err  error
}

type restaurantAccounts struct {
	db        *sql.DB
	dummyHash []byte
}

func newRestaurantAccounts(ctx context.Context, db *sql.DB) (*restaurantAccounts, error) {
	if db == nil {
		return nil, restaurantFail(500, "server_error")
	}
	_, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS restaurant_customers (
			id TEXT PRIMARY KEY,
			username TEXT NOT NULL UNIQUE,
			password_hash TEXT NOT NULL,
			display_name TEXT NOT NULL DEFAULT '',
			phone TEXT NOT NULL DEFAULT '',
			addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE TABLE IF NOT EXISTS restaurant_customer_sessions (
			token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash) = 32),
			customer_id TEXT NOT NULL REFERENCES restaurant_customers(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
			expires_at TIMESTAMPTZ NOT NULL
		);
		CREATE INDEX IF NOT EXISTS restaurant_customer_sessions_customer
			ON restaurant_customer_sessions(customer_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS restaurant_customer_sessions_expiry
			ON restaurant_customer_sessions(expires_at);
	`)
	if err != nil {
		return nil, err
	}
	restaurantDummyPassword.Do(func() {
		restaurantDummyPassword.hash, restaurantDummyPassword.err = bcrypt.GenerateFromPassword(restaurantPasswordInput("unusable dummy password"), restaurantPasswordCost)
	})
	if restaurantDummyPassword.err != nil {
		return nil, restaurantFail(500, "server_error")
	}
	return &restaurantAccounts{db: db, dummyHash: restaurantDummyPassword.hash}, nil
}

// SHA-256 prehashing avoids bcrypt's 72-byte limit for multilingual passwords.
// The scheme is versioned, domain-separated, and encoded before bcrypt; bcrypt
// still generates and stores an independent random salt for every password.
func restaurantPasswordInput(password string) []byte {
	digest := sha256.Sum256([]byte("astracalls-restaurant-password-v1\x00" + password))
	return []byte(base64.RawStdEncoding.EncodeToString(digest[:]))
}

func restaurantPasswordSlot(ctx context.Context) (func(), error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	select {
	case restaurantPasswordSlots <- struct{}{}:
		return func() { <-restaurantPasswordSlots }, nil
	default:
		return nil, restaurantFail(429, "rate_limited")
	}
}

func restaurantAccountUsername(value string) (string, error) {
	if !utf8.ValidString(value) || len(value) > 512 {
		return "", restaurantFail(400, "invalid_username")
	}
	value = norm.NFC.String(cases.Fold().String(strings.TrimSpace(value)))
	if n := utf8.RuneCountInString(value); n < 3 || n > 40 {
		return "", restaurantFail(400, "invalid_username")
	}
	for _, char := range value {
		if !unicode.IsLetter(char) && !unicode.IsDigit(char) && !unicode.IsMark(char) && char != '.' && char != '_' && char != '-' {
			return "", restaurantFail(400, "invalid_username")
		}
	}
	return value, nil
}

func restaurantAccountPasswordValid(password string) bool {
	if !utf8.ValidString(password) || len(password) > 512 || strings.TrimSpace(password) == "" {
		return false
	}
	if count := utf8.RuneCountInString(password); count < 10 || count > 128 {
		return false
	}
	for _, char := range password {
		if unicode.IsControl(char) {
			return false
		}
	}
	return true
}

func restaurantAccountText(value string, max int) (string, error) {
	if !utf8.ValidString(value) || len(value) > max*4 {
		return "", restaurantFail(400, "invalid_request")
	}
	value = strings.TrimSpace(value)
	if utf8.RuneCountInString(value) > max {
		return "", restaurantFail(400, "invalid_request")
	}
	for _, char := range value {
		if unicode.IsControl(char) {
			return "", restaurantFail(400, "invalid_request")
		}
	}
	return value, nil
}

func restaurantAccountRandomID() (string, error) {
	var value [16]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", restaurantFail(500, "server_error")
	}
	return hex.EncodeToString(value[:]), nil
}

func (a *restaurantAccounts) Register(ctx context.Context, username, password, displayName string) (restaurantCustomer, string, error) {
	var empty restaurantCustomer
	username, err := restaurantAccountUsername(username)
	if err != nil {
		return empty, "", err
	}
	if !restaurantAccountPasswordValid(password) {
		return empty, "", restaurantFail(400, "weak_password")
	}
	displayName, err = restaurantAccountText(displayName, 100)
	if err != nil {
		return empty, "", err
	}
	release, err := restaurantPasswordSlot(ctx)
	if err != nil {
		return empty, "", err
	}
	hash, err := bcrypt.GenerateFromPassword(restaurantPasswordInput(password), restaurantPasswordCost)
	release()
	if err != nil {
		return empty, "", restaurantFail(500, "server_error")
	}
	id, err := restaurantAccountRandomID()
	if err != nil {
		return empty, "", err
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, "", restaurantFail(500, "server_error")
	}
	defer tx.Rollback()
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_customers (id, username, password_hash, display_name) VALUES ($1, $2, $3, $4)`, id, username, restaurantPasswordHashPrefix+string(hash), displayName)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return empty, "", restaurantFail(409, "username_taken")
		}
		return empty, "", restaurantFail(500, "server_error")
	}
	token, err := a.createSession(ctx, tx, id)
	if err != nil {
		return empty, "", err
	}
	if err := tx.Commit(); err != nil {
		return empty, "", restaurantFail(500, "server_error")
	}
	return restaurantCustomer{ID: id, Username: username, DisplayName: displayName, Addresses: []restaurantAddress{}}, token, nil
}

func (a *restaurantAccounts) Login(ctx context.Context, username, password string) (restaurantCustomer, string, error) {
	var empty restaurantCustomer
	canonical, usernameErr := restaurantAccountUsername(username)
	passwordValid := restaurantAccountPasswordValid(password)
	release, err := restaurantPasswordSlot(ctx)
	if err != nil {
		return empty, "", err
	}
	var id, stored string
	var lookupErr error
	if usernameErr == nil {
		lookupErr = a.db.QueryRowContext(ctx, `SELECT id, password_hash FROM restaurant_customers WHERE username = $1`, canonical).Scan(&id, &stored)
	}
	hash := a.dummyHash
	validHash := strings.HasPrefix(stored, restaurantPasswordHashPrefix)
	if validHash {
		hash = []byte(strings.TrimPrefix(stored, restaurantPasswordHashPrefix))
		cost, costErr := bcrypt.Cost(hash)
		if costErr != nil || cost != restaurantPasswordCost {
			hash, validHash = a.dummyHash, false
		}
	}
	// Bound even invalid inputs before prehashing; the dummy bcrypt comparison
	// keeps nonexistent usernames and incorrect passwords on the same work path.
	input := "invalid password input"
	if passwordValid {
		input = password
	}
	compareErr := bcrypt.CompareHashAndPassword(hash, restaurantPasswordInput(input))
	release()
	if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
		return empty, "", restaurantFail(500, "server_error")
	}
	if usernameErr != nil || !passwordValid || !validHash || id == "" || compareErr != nil {
		return empty, "", restaurantFail(401, "invalid_credentials")
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, "", restaurantFail(500, "server_error")
	}
	defer tx.Rollback()
	customer, err := scanRestaurantCustomer(tx.QueryRowContext(ctx, `SELECT id, username, display_name, phone, addresses FROM restaurant_customers WHERE id = $1 FOR UPDATE`, id))
	if err != nil {
		return empty, "", restaurantFail(500, "server_error")
	}
	token, err := a.createSession(ctx, tx, id)
	if err != nil {
		return empty, "", err
	}
	if err := tx.Commit(); err != nil {
		return empty, "", restaurantFail(500, "server_error")
	}
	return customer, token, nil
}

// Caller holds the customer row lock (or has just inserted the customer), so
// concurrent sign-ins cannot exceed the per-customer session bound.
func (a *restaurantAccounts) createSession(ctx context.Context, tx *sql.Tx, customerID string) (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", restaurantFail(500, "server_error")
	}
	token := base64.RawURLEncoding.EncodeToString(value[:])
	digest := sha256.Sum256([]byte(token))
	_, err := tx.ExecContext(ctx, `DELETE FROM restaurant_customer_sessions WHERE customer_id = $1 AND (expires_at <= now() OR token_hash IN (
		SELECT token_hash FROM restaurant_customer_sessions WHERE customer_id = $1 ORDER BY created_at DESC, token_hash DESC OFFSET $2
	))`, customerID, restaurantCustomerMaxSessions-1)
	if err != nil {
		return "", restaurantFail(500, "server_error")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_customer_sessions (token_hash, customer_id, expires_at) VALUES ($1, $2, now() + interval '7 days')`, digest[:], customerID)
	if err != nil {
		return "", restaurantFail(500, "server_error")
	}
	return token, nil
}

func restaurantCustomerTokenDigest(token string) ([32]byte, bool) {
	if len(token) != 43 {
		return [32]byte{}, false
	}
	decoded, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil || len(decoded) != 32 || base64.RawURLEncoding.EncodeToString(decoded) != token {
		return [32]byte{}, false
	}
	return sha256.Sum256([]byte(token)), true
}

func (a *restaurantAccounts) Authenticate(ctx context.Context, token string) (restaurantCustomer, bool, error) {
	var customer restaurantCustomer
	digest, valid := restaurantCustomerTokenDigest(token)
	if !valid {
		return customer, false, nil
	}
	var addresses, storedHash []byte
	err := a.db.QueryRowContext(ctx, `SELECT c.id, c.username, c.display_name, c.phone, c.addresses, s.token_hash
		FROM restaurant_customer_sessions s JOIN restaurant_customers c ON c.id = s.customer_id
		WHERE s.token_hash = $1 AND s.expires_at > now()`, digest[:]).Scan(&customer.ID, &customer.Username, &customer.DisplayName, &customer.Phone, &addresses, &storedHash)
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantCustomer{}, false, nil
	}
	if err != nil {
		return restaurantCustomer{}, false, restaurantFail(500, "server_error")
	}
	if subtle.ConstantTimeCompare(digest[:], storedHash) != 1 {
		return restaurantCustomer{}, false, nil
	}
	if err := json.Unmarshal(addresses, &customer.Addresses); err != nil {
		return restaurantCustomer{}, false, restaurantFail(500, "server_error")
	}
	if customer.Addresses == nil {
		customer.Addresses = []restaurantAddress{}
	}
	for i := range customer.Addresses {
		customer.Addresses[i] = restaurantNormalizeLegacyAddress(customer.Addresses[i])
	}
	return customer, true, nil
}

func (a *restaurantAccounts) Logout(ctx context.Context, token string) error {
	digest, valid := restaurantCustomerTokenDigest(token)
	if !valid {
		return nil
	}
	if _, err := a.db.ExecContext(ctx, `DELETE FROM restaurant_customer_sessions WHERE token_hash = $1`, digest[:]); err != nil {
		return restaurantFail(500, "server_error")
	}
	return nil
}

func scanRestaurantCustomer(row interface{ Scan(...any) error }) (restaurantCustomer, error) {
	var customer restaurantCustomer
	var addresses []byte
	if err := row.Scan(&customer.ID, &customer.Username, &customer.DisplayName, &customer.Phone, &addresses); err != nil {
		return customer, err
	}
	if err := json.Unmarshal(addresses, &customer.Addresses); err != nil {
		return restaurantCustomer{}, err
	}
	if customer.Addresses == nil {
		customer.Addresses = []restaurantAddress{}
	}
	for i := range customer.Addresses {
		customer.Addresses[i] = restaurantNormalizeLegacyAddress(customer.Addresses[i])
	}
	return customer, nil
}

func validateRestaurantCustomerUpdate(update restaurantCustomerUpdate) (restaurantCustomerUpdate, error) {
	var err error
	update.DisplayName, err = restaurantAccountText(update.DisplayName, 100)
	if err != nil {
		return update, err
	}
	update.Phone, err = restaurantAccountText(update.Phone, 32)
	if err != nil {
		return update, err
	}
	update.Phone = restaurantNormalizePhone(update.Phone)
	if update.Phone != "" && !restaurantOrderPhone(update.Phone) {
		return update, restaurantFail(400, "invalid_request")
	}
	if len(update.Addresses) > 5 {
		return update, restaurantFail(400, "too_many_addresses")
	}
	addresses := make([]restaurantAddress, len(update.Addresses))
	seen := make(map[string]bool, len(addresses))
	for i, address := range update.Addresses {
		address, err = cleanRestaurantAccountAddress(address)
		if err != nil {
			return update, err
		}
		if seen[address.ID] {
			return update, restaurantFail(400, "invalid_request")
		}
		seen[address.ID] = true
		addresses[i] = address
	}
	update.Addresses = addresses
	return update, nil
}

func cleanRestaurantAccountAddress(address restaurantAddress) (restaurantAddress, error) {
	address.Country = strings.ToUpper(strings.TrimSpace(address.Country))
	if !restaurantSupportedCountry(address.Country) {
		return address, restaurantFail(400, "country_required")
	}
	address = restaurantStripSaudiAddressFields(address)
	fields := []struct {
		value *string
		max   int
	}{
		{&address.ID, 128}, {&address.Label, 100}, {&address.City, 120},
		{&address.District, 120}, {&address.Street, 200}, {&address.Building, 40},
		{&address.PostalCode, 30}, {&address.AdditionalNumber, 30},
		{&address.NationalAddress, 300}, {&address.AddressLine, 500}, {&address.Area, 120},
	}
	for _, field := range fields {
		value, err := restaurantAccountText(*field.value, field.max)
		if err != nil {
			return address, err
		}
		*field.value = value
	}
	if (address.Latitude == nil) != (address.Longitude == nil) {
		return address, restaurantFail(400, "invalid_request")
	}
	if address.Latitude != nil {
		lat, lon := *address.Latitude, *address.Longitude
		if math.IsNaN(lat) || math.IsInf(lat, 0) || lat < -90 || lat > 90 || math.IsNaN(lon) || math.IsInf(lon, 0) || lon < -180 || lon > 180 {
			return address, restaurantFail(400, "invalid_request")
		}
		// Detach caller-owned coordinate pointers from the validated profile.
		address.Latitude, address.Longitude = &lat, &lon
	}
	// Saved addresses satisfy the same basic completeness and length rules as
	// checkout. Restaurant-specific delivery area/radius rules are checked only
	// when ordering, because those settings may change independently.
	if err := restaurantValidateDelivery(restaurantSettings{}, address); err != nil {
		return address, err
	}
	if address.ID == "" {
		var err error
		address.ID, err = restaurantAccountRandomID()
		if err != nil {
			return address, err
		}
	}
	return address, nil
}

func (a *restaurantAccounts) Update(ctx context.Context, id string, update restaurantCustomerUpdate) (restaurantCustomer, error) {
	if len(update.Addresses) > 5 {
		return restaurantCustomer{}, restaurantFail(400, "too_many_addresses")
	}
	tx, err := a.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantCustomer{}, err
	}
	defer tx.Rollback()
	// A saved structured address follows the same hierarchy as checkout.
	// Manual legacy addresses do not require a geography dataset. Hold the
	// geography version through persistence so corrections cannot race a save.
	addressesCopy := make([]restaurantAddress, len(update.Addresses))
	for i, address := range update.Addresses {
		input := restaurantNormalizeOrderInput(restaurantOrderInput{Mode: "delivery", Address: address})
		input, err = restaurantCanonicalDeliveryInput(ctx, tx, input, true)
		if err != nil {
			return restaurantCustomer{}, err
		}
		addressesCopy[i] = input.Address
	}
	update.Addresses = addressesCopy
	update, err = validateRestaurantCustomerUpdate(update)
	if err != nil {
		return restaurantCustomer{}, err
	}
	addresses, err := json.Marshal(update.Addresses)
	if err != nil {
		return restaurantCustomer{}, restaurantFail(400, "invalid_request")
	}
	customer, err := scanRestaurantCustomer(tx.QueryRowContext(ctx, `UPDATE restaurant_customers SET display_name = $2, phone = $3, addresses = $4::jsonb, updated_at = now()
		WHERE id = $1 RETURNING id, username, display_name, phone, addresses`, id, update.DisplayName, update.Phone, string(addresses)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantCustomer{}, restaurantFail(401, "unauthorized")
	}
	if err != nil {
		return restaurantCustomer{}, restaurantFail(500, "server_error")
	}
	return customer, tx.Commit()
}
