package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"strings"

	"github.com/jackc/pgx/v5/pgconn"
	"golang.org/x/crypto/bcrypt"
)

type restaurantCouriers struct {
	db        *sql.DB
	orders    *restaurantOrders
	dummyHash []byte
}

type restaurantCourierCreateInput struct {
	Username string `json:"username"`
	Name     string `json:"name"`
	Phone    string `json:"phone"`
	Password string `json:"password"`
	Active   *bool  `json:"active,omitempty"`
}

type restaurantCourierAdminUpdate struct {
	Name     *string `json:"name,omitempty"`
	Phone    *string `json:"phone,omitempty"`
	Active   *bool   `json:"active,omitempty"`
	Password *string `json:"password,omitempty"`
}

const restaurantCourierColumns = `id,username,name,phone,active,availability,created_at,updated_at`

func newRestaurantCouriers(ctx context.Context, db *sql.DB, orders *restaurantOrders) (*restaurantCouriers, error) {
	if db == nil || orders == nil || orders.store == nil || orders.store.db != db {
		return nil, restaurantFail(500, "server_error")
	}
	_, err := db.ExecContext(ctx, `
		CREATE TABLE IF NOT EXISTS restaurant_couriers (
			id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE,
			name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '',
			password_hash TEXT NOT NULL, active BOOLEAN NOT NULL DEFAULT true,
			availability TEXT NOT NULL DEFAULT 'offline' CHECK (availability IN ('available','busy','offline')),
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
		CREATE TABLE IF NOT EXISTS restaurant_courier_sessions (
			token_hash BYTEA PRIMARY KEY CHECK (octet_length(token_hash)=32),
			courier_id TEXT NOT NULL REFERENCES restaurant_couriers(id) ON DELETE CASCADE,
			created_at TIMESTAMPTZ NOT NULL DEFAULT now(), expires_at TIMESTAMPTZ NOT NULL
		);
		CREATE INDEX IF NOT EXISTS restaurant_courier_sessions_owner ON restaurant_courier_sessions(courier_id,created_at DESC);
		CREATE INDEX IF NOT EXISTS restaurant_courier_sessions_expiry ON restaurant_courier_sessions(expires_at);
		CREATE INDEX IF NOT EXISTS restaurant_orders_courier_active ON restaurant_orders((document->>'courierId'),created_at DESC)
			WHERE status NOT IN ('completed','cancelled');
	`)
	if err != nil {
		return nil, err
	}
	if err = initRestaurantLocations(ctx, db); err != nil {
		return nil, err
	}
	restaurantDummyPassword.Do(func() {
		restaurantDummyPassword.hash, restaurantDummyPassword.err = bcrypt.GenerateFromPassword(restaurantPasswordInput("unusable dummy password"), restaurantPasswordCost)
	})
	if restaurantDummyPassword.err != nil {
		return nil, restaurantFail(500, "server_error")
	}
	return &restaurantCouriers{db: db, orders: orders, dummyHash: restaurantDummyPassword.hash}, nil
}

func scanRestaurantCourier(row interface{ Scan(...any) error }) (restaurantCourier, error) {
	var courier restaurantCourier
	err := row.Scan(&courier.ID, &courier.Username, &courier.Name, &courier.Phone, &courier.Active, &courier.Availability, &courier.CreatedAt, &courier.UpdatedAt)
	return courier, err
}

func restaurantCourierProfile(name, phone string) (string, string, error) {
	name, err := restaurantAccountText(name, 100)
	if err != nil || name == "" {
		return "", "", restaurantFail(400, "invalid_request")
	}
	phone = restaurantNormalizePhone(phone)
	if phone != "" && !restaurantOrderPhone(phone) {
		return "", "", restaurantFail(400, "phone_required")
	}
	return name, phone, nil
}

func restaurantCourierPassword(ctx context.Context, password string) (string, error) {
	if !restaurantAccountPasswordValid(password) {
		return "", restaurantFail(400, "weak_password")
	}
	release, err := restaurantPasswordSlot(ctx)
	if err != nil {
		return "", err
	}
	defer release()
	hash, err := bcrypt.GenerateFromPassword(restaurantPasswordInput(password), restaurantPasswordCost)
	if err != nil {
		return "", restaurantFail(500, "server_error")
	}
	return restaurantPasswordHashPrefix + string(hash), nil
}

func (s *restaurantCouriers) List(ctx context.Context) ([]restaurantCourier, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+restaurantCourierColumns+` FROM restaurant_couriers ORDER BY active DESC,name,id LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []restaurantCourier{}
	for rows.Next() {
		courier, err := scanRestaurantCourier(rows)
		if err != nil {
			return nil, err
		}
		result = append(result, courier)
	}
	return result, rows.Err()
}

func (s *restaurantCouriers) Create(ctx context.Context, input restaurantCourierCreateInput) (restaurantCourier, error) {
	username, err := restaurantAccountUsername(input.Username)
	if err != nil {
		return restaurantCourier{}, err
	}
	name, phone, err := restaurantCourierProfile(input.Name, input.Phone)
	if err != nil {
		return restaurantCourier{}, err
	}
	hash, err := restaurantCourierPassword(ctx, input.Password)
	if err != nil {
		return restaurantCourier{}, err
	}
	id, err := restaurantAccountRandomID()
	if err != nil {
		return restaurantCourier{}, err
	}
	active := input.Active == nil || *input.Active
	courier, err := scanRestaurantCourier(s.db.QueryRowContext(ctx, `INSERT INTO restaurant_couriers(id,username,name,phone,password_hash,active)
		VALUES($1,$2,$3,$4,$5,$6) RETURNING `+restaurantCourierColumns, id, username, name, phone, hash, active))
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return restaurantCourier{}, restaurantFail(409, "username_taken")
		}
		return restaurantCourier{}, err
	}
	return courier, nil
}

// Password reset and deactivation revoke every login session atomically. We do
// not silently reassign live deliveries: the admin makes that audited choice.
func (s *restaurantCouriers) Update(ctx context.Context, id string, input restaurantCourierAdminUpdate) (restaurantCourier, error) {
	if input.Name == nil && input.Phone == nil && input.Active == nil && input.Password == nil {
		return restaurantCourier{}, restaurantFail(400, "invalid_request")
	}
	var hash string
	var err error
	if input.Password != nil {
		hash, err = restaurantCourierPassword(ctx, *input.Password)
		if err != nil {
			return restaurantCourier{}, err
		}
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantCourier{}, err
	}
	defer tx.Rollback()
	courier, err := scanRestaurantCourier(tx.QueryRowContext(ctx, `SELECT `+restaurantCourierColumns+` FROM restaurant_couriers WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantCourier{}, restaurantFail(404, "not_found")
	}
	if err != nil {
		return restaurantCourier{}, err
	}
	if input.Name != nil {
		courier.Name = *input.Name
	}
	if input.Phone != nil {
		courier.Phone = *input.Phone
	}
	courier.Name, courier.Phone, err = restaurantCourierProfile(courier.Name, courier.Phone)
	if err != nil {
		return restaurantCourier{}, err
	}
	if input.Active != nil {
		courier.Active = *input.Active
	}
	if !courier.Active {
		courier.Availability = "offline"
	}
	courier, err = scanRestaurantCourier(tx.QueryRowContext(ctx, `UPDATE restaurant_couriers SET name=$2,phone=$3,active=$4,availability=$5,
		password_hash=CASE WHEN $6='' THEN password_hash ELSE $6 END,updated_at=now() WHERE id=$1 RETURNING `+restaurantCourierColumns,
		id, courier.Name, courier.Phone, courier.Active, courier.Availability, hash))
	if err != nil {
		return restaurantCourier{}, err
	}
	if hash != "" || !courier.Active {
		if _, err = tx.ExecContext(ctx, `DELETE FROM restaurant_courier_sessions WHERE courier_id=$1`, id); err != nil {
			return restaurantCourier{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return restaurantCourier{}, err
	}
	return courier, nil
}

func (s *restaurantCouriers) Login(ctx context.Context, username, password string) (restaurantCourier, string, error) {
	username, usernameErr := restaurantAccountUsername(username)
	validPassword := restaurantAccountPasswordValid(password)
	release, err := restaurantPasswordSlot(ctx)
	if err != nil {
		return restaurantCourier{}, "", err
	}
	var id, stored string
	var active bool
	var lookupErr error
	if usernameErr == nil {
		lookupErr = s.db.QueryRowContext(ctx, `SELECT id,password_hash,active FROM restaurant_couriers WHERE username=$1`, username).Scan(&id, &stored, &active)
	}
	hash := s.dummyHash
	validHash := strings.HasPrefix(stored, restaurantPasswordHashPrefix)
	if validHash {
		hash = []byte(strings.TrimPrefix(stored, restaurantPasswordHashPrefix))
		cost, err := bcrypt.Cost(hash)
		if err != nil || cost != restaurantPasswordCost {
			hash, validHash = s.dummyHash, false
		}
	}
	input := "invalid password input"
	if validPassword {
		input = password
	}
	compareErr := bcrypt.CompareHashAndPassword(hash, restaurantPasswordInput(input))
	release()
	if lookupErr != nil && !errors.Is(lookupErr, sql.ErrNoRows) {
		return restaurantCourier{}, "", lookupErr
	}
	if usernameErr != nil || !validPassword || !validHash || !active || compareErr != nil {
		return restaurantCourier{}, "", restaurantFail(401, "invalid_credentials")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantCourier{}, "", err
	}
	defer tx.Rollback()
	var currentHash string
	if err = tx.QueryRowContext(ctx, `SELECT password_hash FROM restaurant_couriers WHERE id=$1 FOR UPDATE`, id).Scan(&currentHash); err != nil {
		return restaurantCourier{}, "", err
	}
	courier, err := scanRestaurantCourier(tx.QueryRowContext(ctx, `SELECT `+restaurantCourierColumns+` FROM restaurant_couriers WHERE id=$1`, id))
	if err != nil {
		return restaurantCourier{}, "", err
	}
	// A reset/deactivation that won the lock while bcrypt was running must not
	// be bypassed by a login verified against the old password snapshot.
	if !courier.Active || subtle.ConstantTimeCompare([]byte(currentHash), []byte(stored)) != 1 {
		return restaurantCourier{}, "", restaurantFail(401, "invalid_credentials")
	}
	token, err := s.createSession(ctx, tx, id)
	if err != nil {
		return restaurantCourier{}, "", err
	}
	if err := tx.Commit(); err != nil {
		return restaurantCourier{}, "", err
	}
	return courier, token, nil
}

func (s *restaurantCouriers) createSession(ctx context.Context, tx *sql.Tx, id string) (string, error) {
	var value [32]byte
	if _, err := rand.Read(value[:]); err != nil {
		return "", err
	}
	token := base64.RawURLEncoding.EncodeToString(value[:])
	digest := sha256.Sum256([]byte(token))
	_, err := tx.ExecContext(ctx, `DELETE FROM restaurant_courier_sessions WHERE courier_id=$1 AND (expires_at<=now() OR token_hash IN (
		SELECT token_hash FROM restaurant_courier_sessions WHERE courier_id=$1 ORDER BY created_at DESC,token_hash DESC OFFSET $2
	))`, id, restaurantCustomerMaxSessions-1)
	if err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_courier_sessions(token_hash,courier_id,expires_at) VALUES($1,$2,now()+interval '7 days')`, digest[:], id); err != nil {
		return "", err
	}
	return token, nil
}

func (s *restaurantCouriers) Authenticate(ctx context.Context, token string) (restaurantCourier, bool, error) {
	digest, valid := restaurantCustomerTokenDigest(token)
	if !valid {
		return restaurantCourier{}, false, nil
	}
	var courier restaurantCourier
	var storedHash []byte
	err := s.db.QueryRowContext(ctx, `SELECT c.id,c.username,c.name,c.phone,c.active,c.availability,c.created_at,c.updated_at,s.token_hash
		FROM restaurant_courier_sessions s JOIN restaurant_couriers c ON c.id=s.courier_id
		WHERE s.token_hash=$1 AND s.expires_at>now() AND c.active`, digest[:]).Scan(&courier.ID, &courier.Username, &courier.Name, &courier.Phone, &courier.Active, &courier.Availability, &courier.CreatedAt, &courier.UpdatedAt, &storedHash)
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantCourier{}, false, nil
	}
	if err != nil {
		return restaurantCourier{}, false, err
	}
	if subtle.ConstantTimeCompare(digest[:], storedHash) != 1 {
		return restaurantCourier{}, false, nil
	}
	return courier, true, nil
}

func (s *restaurantCouriers) Logout(ctx context.Context, token string) error {
	digest, valid := restaurantCustomerTokenDigest(token)
	if !valid {
		return nil
	}
	_, err := s.db.ExecContext(ctx, `DELETE FROM restaurant_courier_sessions WHERE token_hash=$1`, digest[:])
	return err
}

func (s *restaurantCouriers) SetAvailability(ctx context.Context, id, value string) (restaurantCourier, error) {
	if value != "available" && value != "busy" && value != "offline" {
		return restaurantCourier{}, restaurantFail(400, "invalid_request")
	}
	courier, err := scanRestaurantCourier(s.db.QueryRowContext(ctx, `UPDATE restaurant_couriers SET availability=$2,updated_at=now() WHERE id=$1 AND active RETURNING `+restaurantCourierColumns, id, value))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantCourier{}, restaurantFail(401, "unauthorized")
	}
	return courier, err
}
