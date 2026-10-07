package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base32"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/google/uuid"
)

// Orders deliberately do not share state with WhatsApp, table sessions, or the
// customer's browser cart. Every successful Create creates one independent
// immutable set of item/price snapshots. A retry of that operation is not a new
// order: its receipt (including guest credentials) survives process restarts.
type restaurantOrders struct {
	store *restaurantStore
	seal  cipher.AEAD
	// Private deterministic clock for opening-policy tests, never request input.
	openingNow func() time.Time
	// Injected once at server startup. An absent capability always disables
	// card payments; creating an order must never initiate a provider charge.
	PaymentAvailable func(context.Context, string, string) (bool, error)
}

type restaurantOrderSecrets struct {
	TrackingToken string `json:"trackingToken"`
	AccessCode    string `json:"accessCode"`
}

type restaurantOrderStored struct {
	order         restaurantOrder
	customerID    string
	tokenHash     []byte
	codeHash      []byte
	requestHash   []byte
	sealedSecrets []byte
}

func newRestaurantOrders(ctx context.Context, store *restaurantStore) (*restaurantOrders, error) {
	_, err := store.db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS restaurant_order_secret (
			id integer PRIMARY KEY CHECK (id = 1),
			secret bytea NOT NULL CHECK (octet_length(secret) = 32)
		);
		CREATE SEQUENCE IF NOT EXISTS restaurant_order_number_seq;
		CREATE TABLE IF NOT EXISTS restaurant_orders (
			number text PRIMARY KEY,
			customer_id text NOT NULL DEFAULT '',
			status text NOT NULL,
			version bigint NOT NULL CHECK (version > 0),
			document jsonb NOT NULL,
			token_hash bytea NOT NULL CHECK (octet_length(token_hash) = 32),
			code_hash bytea NOT NULL CHECK (octet_length(code_hash) = 32),
			sealed_secrets bytea NOT NULL,
			request_hash bytea NOT NULL CHECK (octet_length(request_hash) = 32),
			idempotency_hash bytea NOT NULL UNIQUE CHECK (octet_length(idempotency_hash) = 32),
			created_at timestamptz NOT NULL,
			updated_at timestamptz NOT NULL
		);
		CREATE INDEX IF NOT EXISTS restaurant_orders_created_idx ON restaurant_orders (created_at DESC);
		CREATE INDEX IF NOT EXISTS restaurant_orders_customer_idx ON restaurant_orders (customer_id, created_at DESC);
		CREATE INDEX IF NOT EXISTS restaurant_orders_status_idx ON restaurant_orders (status, created_at DESC);
		CREATE TABLE IF NOT EXISTS restaurant_order_events (
			order_number text NOT NULL REFERENCES restaurant_orders(number),
			version bigint NOT NULL,
			kind text NOT NULL,
			document jsonb NOT NULL,
			created_at timestamptz NOT NULL,
			PRIMARY KEY (order_number, version)
		)`)
	if err != nil {
		return nil, err
	}
	if err = restaurantInitStockSchema(ctx, store.db); err != nil {
		return nil, err
	}
	if err = initPlatformEventSchema(ctx, store.db); err != nil {
		return nil, err
	}
	if err = initRestaurantOrderChannels(ctx, store.db); err != nil {
		return nil, err
	}
	if err = restaurantInitCancellationSchema(ctx, store.db); err != nil {
		return nil, err
	}
	if err = restaurantInitRefundSchema(ctx, store.db); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return nil, err
	}
	// Keep this singleton when backing up the database. It is intentionally not
	// an application API key, not published by any API, and never logged. This
	// protects accidental credential exposure from ordinary order-table reads;
	// a full database compromise still compromises receipts and customer PII.
	if _, err = store.db.ExecContext(ctx, `INSERT INTO restaurant_order_secret (id,secret) VALUES (1,$1) ON CONFLICT (id) DO NOTHING`, key); err != nil {
		return nil, err
	}
	if err = store.db.QueryRowContext(ctx, `SELECT secret FROM restaurant_order_secret WHERE id=1`).Scan(&key); err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	seal, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	return &restaurantOrders{store: store, seal: seal}, nil
}

func (s *restaurantOrders) Quote(ctx context.Context, input restaurantOrderInput) (restaurantQuote, error) {
	return s.quote(ctx, input, false)
}

// Preview prices a cart without collecting checkout contact/address details.
// Coverage, tax, payment availability and stock checks stay authoritative.
// It does not create an order or reserve stock; Create still validates checkout.
func (s *restaurantOrders) Preview(ctx context.Context, input restaurantPreviewInput) (restaurantQuote, error) {
	return s.quote(ctx, input.orderInput(), true)
}

func (s *restaurantOrders) quote(ctx context.Context, input restaurantOrderInput, preview bool) (restaurantQuote, error) {
	// Fees, coverage and canonical names must come from one consistent view.
	tx, err := s.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return restaurantQuote{}, err
	}
	defer tx.Rollback()
	catalog, err := loadRestaurantCatalog(ctx, tx, false)
	if err != nil {
		return restaurantQuote{}, err
	}
	input = restaurantNormalizeOrderInput(input)
	input, err = restaurantCanonicalDeliveryInput(ctx, tx, input, false)
	if err != nil {
		return restaurantQuote{}, err
	}
	if err = restaurantRequireOpening(ctx, tx, false, s.openingTime()); err != nil {
		return restaurantQuote{}, err
	}
	quote, err := restaurantPriceCart(catalog, input, !preview)
	if err != nil {
		return restaurantQuote{}, err
	}
	if err = restaurantCheckStock(ctx, tx, quote.Items); err != nil {
		return restaurantQuote{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantQuote{}, err
	}
	return s.availableQuote(ctx, quote, input)
}

func (s *restaurantOrders) Create(ctx context.Context, input restaurantOrderInput, customerID, idempotencyKey string) (restaurantReceipt, error) {
	parsedKey, err := uuid.Parse(idempotencyKey)
	if err != nil || len(idempotencyKey) != 36 || parsedKey.Version() != 4 || parsedKey.Variant() != uuid.RFC4122 || len(customerID) > 128 {
		return restaurantReceipt{}, restaurantFail(400, "invalid_request")
	}
	input = restaurantNormalizeOrderInput(input)
	request, err := json.Marshal(input)
	if err != nil {
		return restaurantReceipt{}, restaurantFail(400, "invalid_request")
	}
	requestHash := sha256.Sum256(request)
	ctx = context.WithValue(ctx, restaurantWhatsappSubmissionKey{}, restaurantWhatsappSubmission{Key: parsedKey.String(), Hash: hex.EncodeToString(requestHash[:]), Owner: customerID})
	// A submission stays unique even when its customer's cookie expires or
	// another account signs in. Identity mismatches reject rather than creating
	// a duplicate or returning the original owner's private receipt.
	idempotencyHash := sha256.Sum256([]byte("restaurant-submission-v1\x00" + parsedKey.String()))
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantReceipt{}, err
	}
	defer tx.Rollback()
	// Check the durable receipt before consulting the current catalog. A
	// successful retry must remain successful after the restaurant closes or
	// changes its menu. A key reused with another body must not expose a receipt.
	existing, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE idempotency_hash=$1`, idempotencyHash[:]))
	if err == nil {
		return s.repeatedReceiptForInput(existing, requestHash[:], customerID, input)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return restaurantReceipt{}, err
	}
	catalog, err := loadRestaurantCatalog(ctx, tx, true)
	if err != nil {
		return restaurantReceipt{}, err
	}
	// Another request may have committed while this one waited for the
	// catalog lock. Resolve that retry before repricing/checking depleted stock.
	existing, err = restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE idempotency_hash=$1`, idempotencyHash[:]))
	if err == nil {
		return s.repeatedReceiptForInput(existing, requestHash[:], customerID, input)
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return restaurantReceipt{}, err
	}
	if err = restaurantRequireNewOrderChannel(ctx, tx); err != nil {
		return restaurantReceipt{}, err
	}
	if err = restaurantRequireOpening(ctx, tx, true, s.openingTime()); err != nil {
		return restaurantReceipt{}, err
	}
	input, err = restaurantCanonicalDeliveryInput(ctx, tx, input, true)
	if err != nil {
		return restaurantReceipt{}, err
	}
	quote, err := restaurantPriceOrder(catalog, input)
	if err != nil {
		return restaurantReceipt{}, err
	}
	if input.ExpectedTotalMinor != quote.TotalMinor {
		return restaurantReceipt{}, restaurantFail(409, "price_changed")
	}
	if input.PaymentMethod == "" {
		return restaurantReceipt{}, restaurantFail(400, "payment_required")
	}
	quote, err = s.availableQuote(ctx, quote, input)
	if err != nil {
		return restaurantReceipt{}, err
	}
	if input.ExpectedQuoteHash != "" {
		if !restaurantQuoteHashPattern.MatchString(input.ExpectedQuoteHash) {
			return restaurantReceipt{}, restaurantFail(400, "invalid_request")
		}
		actual, err := restaurantQuoteBinding(quote)
		if err != nil {
			return restaurantReceipt{}, err
		}
		if subtle.ConstantTimeCompare([]byte(actual), []byte(input.ExpectedQuoteHash)) != 1 {
			return restaurantReceipt{}, restaurantFail(409, "quote_changed")
		}
	}
	if input.PaymentMethod == "card" {
		if input.PaymentProvider == "" || quote.TotalMinor <= 0 {
			return restaurantReceipt{}, restaurantFail(409, "payment_unavailable")
		}
	} else if input.PaymentProvider != "" {
		return restaurantReceipt{}, restaurantFail(400, "invalid_request")
	}
	var sequence int64
	if err = tx.QueryRowContext(ctx, `SELECT nextval('restaurant_order_number_seq')`).Scan(&sequence); err != nil {
		return restaurantReceipt{}, err
	}
	now := time.Now().UTC()
	order := restaurantOrder{
		Number: fmt.Sprintf("R%08d", sequence), Version: 1, Status: "new", Mode: input.Mode, Channel: restaurantOrderChannel(ctx),
		CustomerName: input.CustomerName, Phone: input.Phone, Address: input.Address,
		TableChanges: []restaurantTableChange{}, Notes: input.Notes, Items: quote.Items,
		SubtotalMinor: quote.SubtotalMinor, DeliveryFeeMinor: quote.DeliveryFeeMinor,
		TotalMinor: quote.TotalMinor, Currency: quote.Currency, Demo: quote.Demo,
		Tax:            quote.Tax,
		Payment:        restaurantOrderPayment{Method: input.PaymentMethod, Provider: input.PaymentProvider, Status: "unpaid", AmountMinor: quote.TotalMinor},
		DeliveryEvents: []restaurantDeliveryEvent{},
		CreatedAt:      now, UpdatedAt: now,
	}
	if input.Mode == "table" {
		table, tableErr := restaurantTableFromCatalog(catalog, input.TableCode)
		if tableErr != nil {
			return restaurantReceipt{}, tableErr
		}
		order.TableID, order.TableName = table.ID, table.Name
	}
	// Do not store irrelevant delivery data on pickup/table orders.
	if input.Mode != "delivery" {
		order.Address = restaurantAddress{}
	}
	secrets, err := restaurantNewOrderSecrets()
	if err != nil {
		return restaurantReceipt{}, err
	}
	sealed, err := s.sealOrderSecrets(order.Number, secrets)
	if err != nil {
		return restaurantReceipt{}, err
	}
	tokenHash := sha256.Sum256([]byte(secrets.TrackingToken))
	codeHash := restaurantCodeHash(order.Number, secrets.AccessCode)
	document, err := json.Marshal(order)
	if err != nil {
		return restaurantReceipt{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO restaurant_orders
		(number,customer_id,status,version,document,token_hash,code_hash,sealed_secrets,request_hash,idempotency_hash,created_at,updated_at)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
		ON CONFLICT (idempotency_hash) DO NOTHING`,
		order.Number, customerID, order.Status, order.Version, document, tokenHash[:], codeHash[:], sealed, requestHash[:], idempotencyHash[:], now)
	if err != nil {
		return restaurantReceipt{}, err
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return restaurantReceipt{}, err
	}
	if affected == 0 {
		// A concurrent identical request may have inserted while this transaction
		// was pricing. READ COMMITTED now sees its committed receipt.
		existing, err = restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE idempotency_hash=$1`, idempotencyHash[:]))
		if err != nil {
			return restaurantReceipt{}, err
		}
		return s.repeatedReceiptForInput(existing, requestHash[:], customerID, input)
	}
	if err = restaurantReserveStock(ctx, tx, &order); err != nil {
		return restaurantReceipt{}, err
	}
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return restaurantReceipt{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "created", map[string]string{"status": order.Status}); err != nil {
		return restaurantReceipt{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantReceipt{}, err
	}
	return restaurantReceipt{Order: order, TrackingToken: secrets.TrackingToken, AccessCode: secrets.AccessCode}, nil
}

const restaurantOrderSelect = `SELECT document,customer_id,token_hash,code_hash,request_hash,sealed_secrets FROM restaurant_orders`

func restaurantReadStored(row interface{ Scan(...any) error }) (restaurantOrderStored, error) {
	var stored restaurantOrderStored
	var raw []byte
	if err := row.Scan(&raw, &stored.customerID, &stored.tokenHash, &stored.codeHash, &stored.requestHash, &stored.sealedSecrets); err != nil {
		return stored, err
	}
	if err := json.Unmarshal(raw, &stored.order); err != nil {
		return stored, err
	}
	restaurantNormalizeLegacyOrder(&stored.order)
	return stored, nil
}

// Read compatibility does not invent a payment, tax registration, or paid
// status. The old ordering service used Saudi-specific address fields. Keep
// those legacy addresses usable without accepting missing countries for new
// delivery requests.
func restaurantNormalizeLegacyOrder(order *restaurantOrder) {
	if order.Payment.Method == "" && order.Mode == "delivery" && order.Address.Country == "" {
		order.Address.Country = "SA"
	}
	if order.Payment.Method == "" && !order.Tax.Enabled && order.Tax.GrossMinor == 0 {
		order.Tax.NetMinor, order.Tax.GrossMinor = order.TotalMinor, order.TotalMinor
	}
	if order.DeliveryEvents == nil {
		order.DeliveryEvents = []restaurantDeliveryEvent{}
	}
	if order.Complaints == nil {
		order.Complaints = []restaurantComplaint{}
	}
}

func (s *restaurantOrders) repeatedReceiptForInput(stored restaurantOrderStored, hash []byte, customerID string, input restaurantOrderInput) (restaurantReceipt, error) {
	if stored.customerID == customerID && stored.order.Payment.Method == "" && input.PaymentMethod == "" && input.PaymentProvider == "" && input.Address.Country == "" {
		legacyHash, err := restaurantLegacyOrderInputHash(input)
		if err == nil && subtle.ConstantTimeCompare(stored.requestHash, legacyHash[:]) == 1 {
			return s.receipt(stored)
		}
	}
	return s.repeatedReceipt(stored, hash, customerID)
}

// Field order and tags reproduce the pre-payment request exactly. This is
// only considered when retrieving an already committed legacy receipt.
func restaurantLegacyOrderInputHash(input restaurantOrderInput) ([32]byte, error) {
	type legacyAddress struct {
		ID               string   `json:"id,omitempty"`
		Label            string   `json:"label,omitempty"`
		City             string   `json:"city"`
		District         string   `json:"district"`
		Street           string   `json:"street"`
		Building         string   `json:"building"`
		PostalCode       string   `json:"postalCode"`
		AdditionalNumber string   `json:"additionalNumber"`
		NationalAddress  string   `json:"nationalAddress"`
		AddressLine      string   `json:"addressLine"`
		Area             string   `json:"area"`
		Latitude         *float64 `json:"latitude"`
		Longitude        *float64 `json:"longitude"`
	}
	a := input.Address
	legacy := struct {
		Mode               string                     `json:"mode"`
		CustomerName       string                     `json:"customerName"`
		Phone              string                     `json:"phone"`
		Address            legacyAddress              `json:"address"`
		TableCode          string                     `json:"tableCode"`
		Notes              string                     `json:"notes"`
		Items              []restaurantOrderLineInput `json:"items"`
		ExpectedTotalMinor int64                      `json:"expectedTotalMinor"`
	}{input.Mode, input.CustomerName, input.Phone, legacyAddress{a.ID, a.Label, a.City, a.District, a.Street, a.Building, a.PostalCode, a.AdditionalNumber, a.NationalAddress, a.AddressLine, a.Area, a.Latitude, a.Longitude}, input.TableCode, input.Notes, input.Items, input.ExpectedTotalMinor}
	raw, err := json.Marshal(legacy)
	if err != nil {
		return [32]byte{}, err
	}
	return sha256.Sum256(raw), nil
}

func (s *restaurantOrders) repeatedReceipt(stored restaurantOrderStored, hash []byte, customerID string) (restaurantReceipt, error) {
	if stored.customerID != customerID || subtle.ConstantTimeCompare(stored.requestHash, hash) != 1 {
		return restaurantReceipt{}, restaurantFail(409, "conflict")
	}
	return s.receipt(stored)
}

func (s *restaurantOrders) receipt(stored restaurantOrderStored) (restaurantReceipt, error) {
	data := stored.sealedSecrets
	if len(data) < s.seal.NonceSize()+s.seal.Overhead() {
		return restaurantReceipt{}, errors.New("invalid sealed restaurant receipt")
	}
	raw, err := s.seal.Open(nil, data[:s.seal.NonceSize()], data[s.seal.NonceSize():], []byte(stored.order.Number))
	if err != nil {
		return restaurantReceipt{}, errors.New("invalid sealed restaurant receipt")
	}
	var secrets restaurantOrderSecrets
	if err = json.Unmarshal(raw, &secrets); err != nil {
		return restaurantReceipt{}, err
	}
	return restaurantReceipt{Order: stored.order, TrackingToken: secrets.TrackingToken, AccessCode: secrets.AccessCode}, nil
}

func (s *restaurantOrders) sealOrderSecrets(number string, secrets restaurantOrderSecrets) ([]byte, error) {
	raw, err := json.Marshal(secrets)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, s.seal.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return s.seal.Seal(nonce, nonce, raw, []byte(number)), nil
}

func restaurantNewOrderSecrets() (restaurantOrderSecrets, error) {
	tokenBytes := make([]byte, 32)
	codeBytes := make([]byte, 7)
	if _, err := rand.Read(tokenBytes); err != nil {
		return restaurantOrderSecrets{}, err
	}
	if _, err := rand.Read(codeBytes); err != nil {
		return restaurantOrderSecrets{}, err
	}
	encoding := base32.NewEncoding("ABCDEFGHJKLMNPQRSTUVWXYZ23456789").WithPadding(base32.NoPadding)
	return restaurantOrderSecrets{
		TrackingToken: base64.RawURLEncoding.EncodeToString(tokenBytes),
		AccessCode:    encoding.EncodeToString(codeBytes)[:10], // 50 random bits; endpoint also rate limited.
	}, nil
}

func restaurantCodeHash(number, code string) [32]byte {
	code = strings.ToUpper(strings.TrimSpace(code))
	code = strings.NewReplacer("-", "", " ", "").Replace(code)
	return sha256.Sum256([]byte(number + "\x00" + code))
}

func restaurantCanAccess(stored restaurantOrderStored, token, code, customerID string) bool {
	// Compare fixed-size hashes rather than supplied secrets or opaque token
	// lengths. A customer account never inherits a guest order by phone/name.
	tokenHash := sha256.Sum256([]byte(token))
	codeHash := restaurantCodeHash(stored.order.Number, code)
	tokenOK := subtle.ConstantTimeCompare(stored.tokenHash, tokenHash[:]) == 1 && token != ""
	codeOK := subtle.ConstantTimeCompare(stored.codeHash, codeHash[:]) == 1 && strings.TrimSpace(code) != ""
	ownerOK := customerID != "" && stored.customerID != "" && customerID == stored.customerID
	return tokenOK || codeOK || ownerOK
}

func (s *restaurantOrders) Track(ctx context.Context, number, token, code, customerID string) (restaurantOrder, error) {
	stored, err := restaurantReadStored(s.store.db.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOrder{}, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	if !restaurantCanAccess(stored, token, code, customerID) {
		return restaurantOrder{}, restaurantFail(404, "invalid_order_access")
	}
	return stored.order, nil
}

func (s *restaurantOrders) Lookup(ctx context.Context, number, code string) (restaurantReceipt, error) {
	stored, err := restaurantReadStored(s.store.db.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantReceipt{}, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return restaurantReceipt{}, err
	}
	if !restaurantCanAccess(stored, "", code, "") {
		return restaurantReceipt{}, restaurantFail(404, "invalid_order_access")
	}
	return s.receipt(stored)
}

func (s *restaurantOrders) ChangeTable(ctx context.Context, number, token, code, customerID, tableCode string) (restaurantOrder, error) {
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	// Catalog then order is the same lock order as creation. A table cannot be
	// disabled between checking it and committing a move.
	catalog, err := loadRestaurantCatalog(ctx, tx, true)
	if err != nil {
		return restaurantOrder{}, err
	}
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOrder{}, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	if !restaurantCanAccess(stored, token, code, customerID) {
		return restaurantOrder{}, restaurantFail(404, "invalid_order_access")
	}
	order := stored.order
	if order.Mode != "table" || order.Status == "completed" || order.Status == "cancelled" || !catalog.Settings.TableEnabled {
		return restaurantOrder{}, restaurantFail(409, "table_change_unavailable")
	}
	table, err := restaurantTableFromCatalog(catalog, strings.TrimSpace(tableCode))
	if err != nil {
		return restaurantOrder{}, err
	}
	if table.ID == order.TableID {
		return order, nil
	}
	// A simple dining order does not need an unlimited table-move log. Keep
	// both the snapshot and audit writes bounded even for a malicious owner.
	if len(order.TableChanges) >= 50 {
		return restaurantOrder{}, restaurantFail(409, "table_change_unavailable")
	}
	now := time.Now().UTC()
	change := restaurantTableChange{From: order.TableName, To: table.Name, At: now}
	order.TableID, order.TableName = table.ID, table.Name
	order.TableChanges = append(order.TableChanges, change)
	order.Version++
	order.UpdatedAt = now
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "table_changed", change); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return order, nil
}

func (s *restaurantOrders) ListAdmin(ctx context.Context, status, search string, limit int) ([]restaurantOrder, error) {
	if status != "" && !restaurantKnownStatus(status) {
		return nil, restaurantFail(400, "invalid_status")
	}
	search = strings.TrimSpace(search)
	if utf8.RuneCountInString(search) > 100 {
		return nil, restaurantFail(400, "invalid_request")
	}
	if limit < 1 || limit > 100 {
		limit = 100
	}
	// strpos treats wildcard characters literally and avoids search SQL syntax.
	rows, err := s.store.db.QueryContext(ctx, `SELECT document FROM restaurant_orders
		WHERE ($1='' OR status=$1) AND ($2='' OR strpos(lower(number),lower($2))>0
		OR strpos(lower(document->>'customerName'),lower($2))>0 OR strpos(document->>'phone',$2)>0)
		ORDER BY created_at DESC,number DESC LIMIT $3`, status, search, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return restaurantReadOrders(rows)
}

func (s *restaurantOrders) ListCustomer(ctx context.Context, customerID string) ([]restaurantOrder, error) {
	if customerID == "" {
		return nil, restaurantFail(401, "unauthorized")
	}
	rows, err := s.store.db.QueryContext(ctx, `SELECT document FROM restaurant_orders WHERE customer_id=$1 ORDER BY created_at DESC,number DESC LIMIT 100`, customerID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return restaurantReadOrders(rows)
}

func restaurantReadOrders(rows *sql.Rows) ([]restaurantOrder, error) {
	orders := []restaurantOrder{}
	for rows.Next() {
		var raw []byte
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		var order restaurantOrder
		if err := json.Unmarshal(raw, &order); err != nil {
			return nil, err
		}
		restaurantNormalizeLegacyOrder(&order)
		orders = append(orders, order)
	}
	return orders, rows.Err()
}

func (s *restaurantOrders) SetStatus(ctx context.Context, number, status string, version int64) (restaurantOrder, error) {
	if !restaurantKnownStatus(status) || version < 1 {
		return restaurantOrder{}, restaurantFail(400, "invalid_status")
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOrder{}, restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	order := stored.order
	if order.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if status == order.Status {
		return order, nil
	}
	if !restaurantStatusTransition(order.Mode, order.Status, status) {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	if err = restaurantRequirePaymentForStatus(order, status); err != nil {
		return restaurantOrder{}, err
	}
	oldStatus := order.Status
	if status == "cancelled" {
		if err = restaurantCancelOrderTx(ctx, tx, &order, "restaurant_cancelled"); err != nil {
			return restaurantOrder{}, err
		}
		if order.Cancellation != nil && order.Cancellation.Status == "requested" {
			now := time.Now().UTC()
			order.Cancellation.Status = "approved"
			order.Cancellation.DecisionReason = "restaurant_cancelled"
			order.Cancellation.DecidedAt = &now
		}
	} else {
		order.Status = status
	}
	if status == "preparing" && order.PreparationStartedAt == nil {
		now := time.Now().UTC()
		order.PreparationStartedAt = &now
	}
	order.Version++
	order.UpdatedAt = time.Now().UTC()
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "status_changed", map[string]string{"from": oldStatus, "to": status}); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return order, nil
}

// CollectCash is an administrator-only service operation; its HTTP caller
// must enforce master authentication. Couriers use the pure helper below
// after locking and checking their own active assignment.
func (s *restaurantOrders) CollectCash(ctx context.Context, number string, version int64) (restaurantOrder, error) {
	if version < 1 {
		return restaurantOrder{}, restaurantFail(400, "invalid_request")
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOrder{}, restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	order := stored.order
	if order.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	wasPaid := order.Payment.Status == "paid"
	if err = restaurantMarkCashCollected(&order, "admin"); err != nil {
		return restaurantOrder{}, err
	}
	if wasPaid {
		return order, nil
	}
	order.Version++
	order.UpdatedAt = time.Now().UTC()
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "cash_collected", map[string]any{"actor": "admin", "method": order.Payment.Method, "amountMinor": order.Payment.AmountMinor}); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return order, nil
}

// Mutation-only helper: no SQL, version increment, or implicit status change.
// actor is a server-created role/ID, never a browser-supplied string. Courier
// callers must also verify that the account is active and at the collection
// stage while holding the order and courier locks.
func restaurantMarkCashCollected(order *restaurantOrder, actor string) error {
	if order == nil {
		return restaurantFail(400, "invalid_request")
	}
	if actor != "admin" {
		courierID := strings.TrimPrefix(actor, "courier:")
		if !strings.HasPrefix(actor, "courier:") || courierID == "" || courierID != order.CourierID || order.Payment.Method != "cash_on_delivery" || order.Mode != "delivery" {
			return restaurantFail(403, "forbidden")
		}
	}
	if !restaurantCashMethod(order.Mode, order.Payment.Method) || order.Payment.Provider != "" || order.Payment.AmountMinor != order.TotalMinor || order.Payment.AmountMinor < 0 {
		return restaurantFail(409, "payment_unavailable")
	}
	if order.Payment.Status == "paid" {
		return nil
	}
	if order.Cancellation != nil && order.Cancellation.Status == "requested" {
		return restaurantFail(409, "invalid_status")
	}
	if order.Status == "cancelled" || order.Status == "completed" || order.Payment.Status != "unpaid" {
		return restaurantFail(409, "payment_unavailable")
	}
	now := time.Now().UTC()
	order.Payment.Status, order.Payment.PaidAt = "paid", &now
	return nil
}

func restaurantCashMethod(mode, method string) bool {
	return mode == "table" && (method == "cash_before" || method == "cash_after") || mode == "delivery" && method == "cash_on_delivery"
}

// Shared by administrator and courier transitions. Legacy orders keep their
// pre-update workflow but do not acquire a fabricated payment status.
func restaurantRequirePaymentForStatus(order restaurantOrder, nextStatus string) error {
	// A pending cancellation needs an explicit decision before the kitchen or
	// courier advances the order. Otherwise completion could silently strand
	// an unresolved request and make the promised review impossible.
	if order.Cancellation != nil && order.Cancellation.Status == "requested" && nextStatus != "cancelled" {
		return restaurantFail(409, "invalid_status")
	}
	if order.Payment.Method == "" || nextStatus == "cancelled" || nextStatus == "new" || nextStatus == "accepted" {
		return nil
	}
	if order.Payment.Method != "card" && !restaurantCashMethod(order.Mode, order.Payment.Method) {
		return restaurantFail(409, "payment_required")
	}
	if order.Payment.AmountMinor != order.TotalMinor || order.Payment.AmountMinor < 0 {
		return restaurantFail(409, "payment_required")
	}
	requiresPaid := nextStatus == "completed" || order.Payment.Method == "card" || order.Payment.Method == "cash_before"
	if requiresPaid && order.Payment.Status != "paid" {
		return restaurantFail(409, "payment_required")
	}
	return nil
}

func restaurantKnownStatus(status string) bool {
	switch status {
	case "new", "accepted", "preparing", "ready", "out_for_delivery", "completed", "cancelled":
		return true
	}
	return false
}

func restaurantStatusTransition(mode, from, to string) bool {
	if from == "completed" || from == "cancelled" {
		return false
	}
	if to == "cancelled" {
		return true
	}
	switch from {
	case "new":
		return to == "accepted"
	case "accepted":
		return to == "preparing"
	case "preparing":
		return to == "ready"
	case "ready":
		if mode == "delivery" {
			return to == "out_for_delivery"
		}
		return to == "completed"
	case "out_for_delivery":
		return mode == "delivery" && to == "completed"
	}
	return false
}

func restaurantUpdateOrder(ctx context.Context, tx *sql.Tx, order restaurantOrder) error {
	if err := restaurantReconcileOrderStock(ctx, tx, order); err != nil {
		return err
	}
	document, err := json.Marshal(order)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE restaurant_orders SET document=$2,status=$3,version=$4,updated_at=$5 WHERE number=$1`, order.Number, document, order.Status, order.Version, order.UpdatedAt)
	return err
}

func restaurantWriteOrderEvent(ctx context.Context, tx *sql.Tx, order restaurantOrder, kind string, event any) error {
	document, err := json.Marshal(event)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_order_events (order_number,version,kind,document,created_at) VALUES ($1,$2,$3,$4,$5)`, order.Number, order.Version, kind, document, order.UpdatedAt)
	if err != nil {
		return err
	}
	if err = writePlatformStaffAudit(ctx, tx, order, kind); err != nil {
		return err
	}
	return writePlatformOrderEvent(ctx, tx, order)
}

func restaurantNormalizeOrderInput(input restaurantOrderInput) restaurantOrderInput {
	input.CustomerName = strings.TrimSpace(input.CustomerName)
	input.Phone = restaurantNormalizePhone(input.Phone)
	input.TableCode = strings.TrimSpace(input.TableCode)
	input.Notes = strings.TrimSpace(input.Notes)
	input.PaymentMethod = strings.TrimSpace(input.PaymentMethod)
	input.PaymentProvider = strings.TrimSpace(input.PaymentProvider)
	a := &input.Address
	a.Country = strings.ToUpper(strings.TrimSpace(a.Country))
	a.RegionID = strings.TrimSpace(a.RegionID)
	a.CityID = strings.TrimSpace(a.CityID)
	a.DistrictID = strings.TrimSpace(a.DistrictID)
	a.ID = strings.TrimSpace(a.ID)
	a.Label = strings.TrimSpace(a.Label)
	a.City = strings.TrimSpace(a.City)
	a.District = strings.TrimSpace(a.District)
	a.Street = strings.TrimSpace(a.Street)
	a.Building = strings.TrimSpace(a.Building)
	a.PostalCode = strings.TrimSpace(a.PostalCode)
	a.AdditionalNumber = strings.TrimSpace(a.AdditionalNumber)
	a.NationalAddress = strings.TrimSpace(a.NationalAddress)
	a.AddressLine = strings.TrimSpace(a.AddressLine)
	a.Area = strings.TrimSpace(a.Area)
	// Empty country is retained for legacy idempotency matching and rejected
	// for NEW delivery orders. Explicit foreign addresses never persist the
	// Saudi-specific fields, even when a client submits stale hidden inputs.
	if a.Country != "" && a.Country != "SA" {
		a.NationalAddress, a.AdditionalNumber = "", ""
	}
	return input
}

func restaurantPriceOrder(catalog restaurantCatalog, input restaurantOrderInput) (restaurantQuote, error) {
	return restaurantPriceCart(catalog, input, true)
}

func restaurantPriceCart(catalog restaurantCatalog, input restaurantOrderInput, requireCheckout bool) (restaurantQuote, error) {
	settings := catalog.Settings
	if !settings.AcceptingOrders {
		return restaurantQuote{}, restaurantFail(409, "store_closed")
	}
	switch input.Mode {
	case "delivery":
		if !settings.DeliveryEnabled {
			return restaurantQuote{}, restaurantFail(409, "mode_unavailable")
		}
	case "pickup":
		if !settings.PickupEnabled {
			return restaurantQuote{}, restaurantFail(409, "mode_unavailable")
		}
	case "table":
		if !settings.TableEnabled {
			return restaurantQuote{}, restaurantFail(409, "mode_unavailable")
		}
	default:
		return restaurantQuote{}, restaurantFail(400, "invalid_request")
	}
	if !restaurantOrderText(input.CustomerName, 100, false) || !restaurantOrderText(input.Notes, 1000, true) || len(input.TableCode) > 128 {
		return restaurantQuote{}, restaurantFail(400, "invalid_request")
	}
	if input.Phone != "" && !restaurantOrderPhone(input.Phone) || requireCheckout && input.Mode != "table" && input.Phone == "" {
		return restaurantQuote{}, restaurantFail(400, "phone_required")
	}
	if len(input.Items) < 1 || len(input.Items) > 50 {
		return restaurantQuote{}, restaurantFail(400, "invalid_request")
	}
	quote := restaurantQuote{Items: []restaurantOrderLine{}, Currency: settings.Currency, Demo: settings.Demo, PaymentMethods: restaurantPaymentMethodsForMode(settings, input.Mode)}
	var err error
	if input.Mode == "table" {
		table, err := restaurantTableFromCatalog(catalog, input.TableCode)
		if err != nil {
			return restaurantQuote{}, err
		}
		quote.TableName = table.Name
	}
	items := make(map[string]restaurantItem, len(catalog.Items))
	for _, item := range catalog.Items {
		items[item.ID] = item
	}
	quantityTotal := 0
	for _, line := range input.Items {
		if line.Quantity < 1 || line.Quantity > 99 {
			return restaurantQuote{}, restaurantFail(400, "invalid_quantity")
		}
		quantityTotal += line.Quantity
		if quantityTotal > 500 {
			return restaurantQuote{}, restaurantFail(400, "invalid_quantity")
		}
		item, ok := items[line.ItemID]
		if !ok || !item.Available {
			return restaurantQuote{}, restaurantFail(409, "item_unavailable")
		}
		if item.PriceMinor < 0 || item.PriceMinor > restaurantMaxMinor {
			return restaurantQuote{}, restaurantFail(409, "item_unavailable")
		}
		unit := item.PriceMinor
		options := []restaurantOption{}
		if len(line.OptionIDs) > 30 {
			return restaurantQuote{}, restaurantFail(400, "invalid_option")
		}
		availableOptions := make(map[string]restaurantOption, len(item.Options))
		for _, option := range item.Options {
			availableOptions[option.ID] = option
		}
		seen := make(map[string]bool, len(line.OptionIDs))
		for _, id := range line.OptionIDs {
			option, ok := availableOptions[id]
			if !ok || !option.Available || seen[id] || option.PriceMinor < 0 || option.PriceMinor > restaurantMaxMinor {
				return restaurantQuote{}, restaurantFail(400, "invalid_option")
			}
			seen[id] = true
			unit += option.PriceMinor
			options = append(options, option)
		}
		total := unit * int64(line.Quantity)
		quote.Items = append(quote.Items, restaurantOrderLine{ItemID: item.ID, Name: item.Name, Quantity: line.Quantity, UnitPriceMinor: unit, Options: options, TotalMinor: total})
		quote.SubtotalMinor += total
	}
	if input.Mode == "delivery" {
		if err := restaurantValidateDeliveryForCart(settings, input.Address, requireCheckout); err != nil {
			return restaurantQuote{}, err
		}
		if settings.DeliveryMinimumMinor < 0 || settings.DeliveryFeeMinor < 0 || settings.DeliveryFeeMinor > restaurantMaxMinor {
			return restaurantQuote{}, restaurantFail(409, "delivery_unavailable")
		}
		if quote.SubtotalMinor < settings.DeliveryMinimumMinor {
			return restaurantQuote{}, restaurantFail(409, "delivery_minimum")
		}
		quote.DeliveryFeeMinor, err = restaurantDeliveryFee(settings, input.Address)
		if err != nil {
			return restaurantQuote{}, err
		}
	}
	quote.TotalMinor = quote.SubtotalMinor + quote.DeliveryFeeMinor
	quote.Tax, err = restaurantTaxForGross(settings, quote.TotalMinor)
	if err != nil {
		return restaurantQuote{}, err
	}
	return quote, nil
}

// Return a copy, with only policy-valid methods, so callers can remove card
// when no configured gateway is available without mutating catalog settings.
func restaurantPaymentMethodsForMode(settings restaurantSettings, mode string) []string {
	methods, exists := settings.PaymentMethods[mode]
	if !exists && settings.PaymentMethods == nil {
		switch mode {
		case "table":
			methods = []string{"cash_before", "cash_after", "card"}
		case "delivery":
			methods = []string{"cash_on_delivery", "card"}
		case "pickup":
			methods = []string{"card"}
		}
	}
	result := []string{}
	seen := map[string]bool{}
	for _, method := range methods {
		if !seen[method] && (method == "card" || restaurantCashMethod(mode, method)) && (mode == "table" || mode == "delivery" || mode == "pickup") {
			result = append(result, method)
			seen[method] = true
		}
	}
	return result
}

func (s *restaurantOrders) availableQuote(ctx context.Context, quote restaurantQuote, input restaurantOrderInput) (restaurantQuote, error) {
	// Geidea requires a routable country code and subscriber number. Validate
	// before the immutable order is created, not only when checkout starts;
	// the generic contact validator intentionally also accepts local numbers.
	if input.PaymentMethod == "card" && input.PaymentProvider == "geidea" {
		if _, _, err := restaurantPaymentPhone(input.Phone); err != nil {
			return restaurantQuote{}, restaurantFail(400, "phone_required")
		}
	}
	methods := []string{}
	selected := input.PaymentMethod == ""
	for _, method := range quote.PaymentMethods {
		if method == "card" {
			if s.PaymentAvailable == nil {
				continue
			}
			// Empty provider means any eligible configured provider. When the
			// client has selected one, check that exact provider instead.
			provider := ""
			if input.PaymentMethod == "card" {
				provider = input.PaymentProvider
			}
			available, err := s.PaymentAvailable(ctx, provider, quote.Currency)
			if err != nil {
				return restaurantQuote{}, err
			}
			if !available {
				continue
			}
		}
		methods = append(methods, method)
		if method == input.PaymentMethod {
			selected = true
		}
	}
	if len(methods) == 0 || !selected {
		return restaurantQuote{}, restaurantFail(409, "payment_unavailable")
	}
	quote.PaymentMethods = methods
	return quote, nil
}

func restaurantTaxForGross(settings restaurantSettings, gross int64) (restaurantTaxSummary, error) {
	if gross < 0 {
		return restaurantTaxSummary{}, restaurantFail(400, "invalid_request")
	}
	result := restaurantTaxSummary{NetMinor: gross, GrossMinor: gross}
	if !settings.TaxEnabled {
		return result, nil
	}
	rate := settings.TaxRateBps
	if rate < 0 || rate > 10000 || strings.TrimSpace(settings.TaxNumber) == "" || !restaurantOrderText(settings.TaxNumber, 80, false) {
		return restaurantTaxSummary{}, restaurantFail(400, "invalid_request")
	}
	denominator := int64(10000) + rate
	// All catalog amounts are far below this bound; check explicitly so this
	// arithmetic also remains safe if limits change in a later release.
	if rate > 0 && gross > (math.MaxInt64-denominator/2)/rate {
		return restaurantTaxSummary{}, restaurantFail(400, "invalid_request")
	}
	result.Enabled, result.RateBps, result.Number = true, rate, settings.TaxNumber
	result.TaxMinor = (gross*rate + denominator/2) / denominator
	result.NetMinor = gross - result.TaxMinor
	return result, nil
}

func restaurantOrderText(value string, max int, multiline bool) bool {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > max {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) && !(multiline && (r == '\n' || r == '\r' || r == '\t')) {
			return false
		}
	}
	return true
}

func restaurantOrderPhone(value string) bool {
	value = restaurantNormalizePhone(value)
	if len(value) > 32 {
		return false
	}
	digits := 0
	for _, r := range value {
		if r >= '0' && r <= '9' {
			digits++
			continue
		}
		if r != '+' && r != '-' && r != ' ' && r != '(' && r != ')' {
			return false
		}
	}
	return digits >= 7 && digits <= 15
}

// Normalize decimal digits from every supported writing system to the same
// contact number. Unicode's Nd ranges contain consecutive 0–9 digit sets;
// the modulo also handles contiguous mathematical digit styles in R32.
func restaurantNormalizePhone(value string) string {
	return strings.Map(func(r rune) rune {
		if r >= '0' && r <= '9' {
			return r
		}
		for _, span := range unicode.Digit.R16 {
			if r >= rune(span.Lo) && r <= rune(span.Hi) && (r-rune(span.Lo))%rune(span.Stride) == 0 {
				return '0' + (r-rune(span.Lo))/rune(span.Stride)%10
			}
		}
		for _, span := range unicode.Digit.R32 {
			if r >= rune(span.Lo) && r <= rune(span.Hi) && (r-rune(span.Lo))%rune(span.Stride) == 0 {
				return '0' + (r-rune(span.Lo))/rune(span.Stride)%10
			}
		}
		return r
	}, strings.TrimSpace(value))
}

func restaurantValidateDelivery(settings restaurantSettings, address restaurantAddress) error {
	return restaurantValidateDeliveryForCart(settings, address, true)
}

func restaurantValidateDeliveryForCart(settings restaurantSettings, address restaurantAddress, requireCheckout bool) error {
	if !restaurantSupportedCountry(address.Country) {
		return restaurantFail(400, "country_required")
	}
	for _, field := range []struct {
		value string
		max   int
	}{
		{address.ID, 128}, {address.Label, 100}, {address.City, 120}, {address.District, 120}, {address.Street, 200},
		{address.Building, 40}, {address.PostalCode, 30}, {address.AdditionalNumber, 30}, {address.NationalAddress, 300},
		{address.AddressLine, 500}, {address.Area, 120},
	} {
		if !restaurantOrderText(field.value, field.max, false) {
			return restaurantFail(400, "invalid_request")
		}
	}
	// A national/short address can stand on its own; a normal address remains
	// available for customers who do not know it. Never request an identity ID.
	nationalEnough := address.Country == "SA" && utf8.RuneCountInString(strings.TrimSpace(address.NationalAddress)) >= 8
	freeformEnough := utf8.RuneCountInString(strings.TrimSpace(address.AddressLine)) >= 5
	structuredEnough := address.City != "" && (address.Street != "" || address.District != "") && address.Building != ""
	if requireCheckout && !nationalEnough && !freeformEnough && !structuredEnough {
		return restaurantFail(400, "address_required")
	}
	if (address.Latitude == nil) != (address.Longitude == nil) {
		return restaurantFail(400, "location_required")
	}
	if address.Latitude != nil && !restaurantCoordinatesValid(*address.Latitude, *address.Longitude) {
		return restaurantFail(400, "invalid_request")
	}
	if (settings.RequireDeliveryLocation || settings.DeliveryRadiusKm > 0) && address.Latitude == nil {
		return restaurantFail(400, "location_required")
	}
	if len(settings.DeliveryAreas) > 0 {
		match := false
		for _, area := range settings.DeliveryAreas {
			if strings.EqualFold(strings.TrimSpace(area), strings.TrimSpace(address.Area)) {
				match = true
				break
			}
		}
		if !match {
			return restaurantFail(409, "outside_delivery_area")
		}
	}
	if math.IsNaN(settings.DeliveryRadiusKm) || math.IsInf(settings.DeliveryRadiusKm, 0) || settings.DeliveryRadiusKm < 0 {
		return restaurantFail(409, "delivery_unavailable")
	}
	if settings.DeliveryRadiusKm > 0 {
		if settings.Latitude == nil || settings.Longitude == nil || !restaurantCoordinatesValid(*settings.Latitude, *settings.Longitude) {
			return restaurantFail(409, "delivery_unavailable")
		}
		distance := restaurantDistanceKm(*settings.Latitude, *settings.Longitude, *address.Latitude, *address.Longitude)
		if distance > settings.DeliveryRadiusKm+1e-9 {
			return restaurantFail(409, "outside_delivery_area")
		}
	}
	return nil
}

func restaurantCoordinatesValid(lat, lng float64) bool {
	return !math.IsNaN(lat) && !math.IsNaN(lng) && !math.IsInf(lat, 0) && !math.IsInf(lng, 0) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

func restaurantDistanceKm(lat1, lng1, lat2, lng2 float64) float64 {
	const rad = math.Pi / 180
	dLat, dLng := (lat2-lat1)*rad, (lng2-lng1)*rad
	a := math.Sin(dLat/2)*math.Sin(dLat/2) + math.Cos(lat1*rad)*math.Cos(lat2*rad)*math.Sin(dLng/2)*math.Sin(dLng/2)
	a = math.Max(0, math.Min(1, a))
	return 6371.0088 * 2 * math.Atan2(math.Sqrt(a), math.Sqrt(1-a))
}
