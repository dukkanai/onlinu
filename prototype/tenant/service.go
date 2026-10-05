package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

//go:embed schema.sql
var schema string

type config struct {
	TenantID, Token, DatabaseURL string
	Synthetic                    bool
}

type service struct {
	db              *sql.DB
	tenantID, token string
	synthetic       bool
}

type failure struct {
	status int
	code   string
}

func (e failure) Error() string          { return e.code }
func fail(status int, code string) error { return failure{status, code} }

type lineInput struct {
	ItemID   string `json:"itemId"`
	Quantity int64  `json:"quantity"`
}
type cartInput struct {
	Items []lineInput `json:"items"`
}
type orderInput struct {
	Items              []lineInput `json:"items"`
	ExpectedTotalMinor int64       `json:"expectedTotalMinor"`
	IdempotencyKey     string      `json:"idempotencyKey"`
}
type item struct {
	ID         string `json:"id"`
	Name       string `json:"name"`
	PriceMinor int64  `json:"priceMinor"`
	Stock      int64  `json:"stock"`
}
type line struct {
	ItemID         string `json:"itemId"`
	Name           string `json:"name"`
	Quantity       int64  `json:"quantity"`
	UnitPriceMinor int64  `json:"unitPriceMinor"`
	TotalMinor     int64  `json:"totalMinor"`
}
type quote struct {
	TenantID   string `json:"tenantId"`
	Currency   string `json:"currency"`
	TotalMinor int64  `json:"totalMinor"`
	Items      []line `json:"items"`
}
type order struct {
	ID               string `json:"id"`
	TenantID         string `json:"tenantId"`
	OwnerID          string `json:"ownerId"`
	Currency         string `json:"currency"`
	TotalMinor       int64  `json:"totalMinor"`
	Status           string `json:"status"`
	PaymentStatus    string `json:"paymentStatus"`
	PaymentProvider  string `json:"paymentProvider,omitempty"`
	PaymentReference string `json:"paymentReference,omitempty"`
	Version          int64  `json:"version"`
	Items            []line `json:"items"`
}
type event struct {
	Sequence      int64     `json:"sequence"`
	EventID       string    `json:"eventId"`
	TenantID      string    `json:"tenantId"`
	OrderID       string    `json:"orderId"`
	OwnerID       string    `json:"ownerId"`
	Status        string    `json:"status"`
	PaymentStatus string    `json:"paymentStatus"`
	Version       int64     `json:"version"`
	OccurredAt    time.Time `json:"occurredAt"`
}
type actor struct{ id, role string }
type testPaymentInput struct {
	Provider    string `json:"provider"`
	Reference   string `json:"reference"`
	AmountMinor int64  `json:"amountMinor"`
	Currency    string `json:"currency"`
}

var identifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)

func randomID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func (s *service) initialize(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Bootstrap uses this prototype database's restricted owner, never a cluster
	// provisioner. The production migration/runtime-role split is not implemented.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(706836454138)`); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, schema); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO tenant_meta(singleton,tenant_id) VALUES(true,$1) ON CONFLICT DO NOTHING`, s.tenantID); err != nil {
		return err
	}
	var storedTenant string
	if err = tx.QueryRowContext(ctx, `SELECT tenant_id FROM tenant_meta WHERE singleton`).Scan(&storedTenant); err != nil {
		return err
	}
	if storedTenant != s.tenantID {
		return errors.New("tenant database mismatch")
	}
	price, drink, mealName := int64(3000), int64(500), "Demo A grilled meal"
	if s.tenantID == "demo-b" {
		price, drink, mealName = 4500, 700, "Demo B rice meal"
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO menu_items(id,name,price_minor,stock) VALUES ('meal',$1,$2,30),('drink','Demo drink',$3,30) ON CONFLICT DO NOTHING`, mealName, price, drink)
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *service) menu(ctx context.Context) (any, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id,name,price_minor,stock FROM menu_items ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []item{}
	for rows.Next() {
		var value item
		if err = rows.Scan(&value.ID, &value.Name, &value.PriceMinor, &value.Stock); err != nil {
			return nil, err
		}
		items = append(items, value)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	name := "Demo Restaurant A"
	if s.tenantID == "demo-b" {
		name = "Demo Restaurant B"
	}
	return struct {
		TenantID string `json:"tenantId"`
		Name     string `json:"name"`
		Currency string `json:"currency"`
		Items    []item `json:"items"`
	}{s.tenantID, name, "SAR", items}, nil
}

func normalizeLines(input []lineInput) ([]lineInput, error) {
	if len(input) == 0 || len(input) > 20 {
		return nil, fail(400, "invalid_items")
	}
	items := append([]lineInput(nil), input...)
	seen := make(map[string]bool, len(items))
	for _, row := range items {
		if !identifier.MatchString(row.ItemID) || row.Quantity < 1 || row.Quantity > 20 || seen[row.ItemID] {
			return nil, fail(400, "invalid_items")
		}
		seen[row.ItemID] = true
	}
	sort.Slice(items, func(i, j int) bool { return items[i].ItemID < items[j].ItemID })
	return items, nil
}

func (s *service) price(ctx context.Context, tx *sql.Tx, input []lineInput, lock bool) (quote, error) {
	q := quote{TenantID: s.tenantID, Currency: "SAR", Items: []line{}}
	ids := make([]string, len(input))
	for i, row := range input {
		ids[i] = row.ItemID
	}
	query := `SELECT id,name,price_minor,stock FROM menu_items WHERE id=ANY($1) ORDER BY id`
	if lock {
		query += ` FOR UPDATE`
	}
	rows, err := tx.QueryContext(ctx, query, ids)
	if err != nil {
		return q, err
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var value item
		if err = rows.Scan(&value.ID, &value.Name, &value.PriceMinor, &value.Stock); err != nil {
			return q, err
		}
		if i >= len(input) || value.ID != input[i].ItemID {
			return q, fail(400, "unknown_item")
		}
		quantity := input[i].Quantity
		if value.Stock < quantity {
			return q, fail(409, "insufficient_stock")
		}
		amount := value.PriceMinor * quantity
		q.Items = append(q.Items, line{value.ID, value.Name, quantity, value.PriceMinor, amount})
		q.TotalMinor += amount
		i++
	}
	if err = rows.Err(); err != nil {
		return q, err
	}
	if i != len(input) {
		return q, fail(400, "unknown_item")
	}
	return q, nil
}

func (s *service) quote(ctx context.Context, input []lineInput) (quote, error) {
	items, err := normalizeLines(input)
	if err != nil {
		return quote{}, err
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return quote{}, err
	}
	defer tx.Rollback()
	q, err := s.price(ctx, tx, items, false)
	if err != nil {
		return quote{}, err
	}
	return q, tx.Commit()
}

func (s *service) create(ctx context.Context, owner string, input orderInput) (order, error) {
	items, err := normalizeLines(input.Items)
	if err != nil {
		return order{}, err
	}
	if !validOrderKey(input.IdempotencyKey) || input.ExpectedTotalMinor < 1 || input.ExpectedTotalMinor > 40000000000 {
		return order{}, fail(400, "invalid_request")
	}
	input.Items = items
	body, err := json.Marshal(input)
	if err != nil {
		return order{}, err
	}
	requestHash := sha256.Sum256(body)
	keyHash := orderKeyHash(input.IdempotencyKey)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return order{}, err
	}
	defer tx.Rollback()
	// A durable transaction lock serializes identical submissions across processes
	// before consulting changing prices/stock. Hash collisions only add contention.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock($1)`, int64(binary.BigEndian.Uint64(keyHash[:8]))); err != nil {
		return order{}, err
	}
	var raw, existingHash []byte
	var existingOwner string
	err = tx.QueryRowContext(ctx, `SELECT owner_id,request_hash,document FROM orders WHERE idempotency_hash=$1`, keyHash[:]).Scan(&existingOwner, &existingHash, &raw)
	if err == nil {
		if existingOwner != owner || string(existingHash) != string(requestHash[:]) {
			return order{}, fail(409, "idempotency_conflict")
		}
		var existing order
		if err = json.Unmarshal(raw, &existing); err != nil {
			return order{}, err
		}
		return existing, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return order{}, err
	}
	q, err := s.price(ctx, tx, items, true)
	if err != nil {
		return order{}, err
	}
	if q.TotalMinor != input.ExpectedTotalMinor {
		return order{}, fail(409, "price_changed")
	}
	id, err := randomID()
	if err != nil {
		return order{}, err
	}
	o := order{ID: id, TenantID: s.tenantID, OwnerID: owner, Currency: "SAR", TotalMinor: q.TotalMinor, Status: "pending_payment", PaymentStatus: "pending", Version: 1, Items: q.Items}
	raw, err = json.Marshal(o)
	if err != nil {
		return order{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO orders(id,owner_id,idempotency_hash,request_hash,document,created_at) VALUES($1,$2,$3,$4,$5,$6)`, o.ID, owner, keyHash[:], requestHash[:], raw, time.Now().UTC()); err != nil {
		return order{}, err
	}
	for _, row := range items {
		result, updateErr := tx.ExecContext(ctx, `UPDATE menu_items SET stock=stock-$2 WHERE id=$1 AND stock >= $2`, row.ItemID, row.Quantity)
		if updateErr != nil {
			return order{}, updateErr
		}
		count, countErr := result.RowsAffected()
		if countErr != nil {
			return order{}, countErr
		}
		if count != 1 {
			return order{}, fail(409, "insufficient_stock")
		}
	}
	if err = s.appendEvent(ctx, tx, o); err != nil {
		return order{}, err
	}
	return o, tx.Commit()
}

func validOrderKey(key string) bool {
	return len(key) >= 8 && identifier.MatchString(key)
}

func orderKeyHash(key string) [32]byte {
	return sha256.Sum256([]byte("synthetic-order-v1\x00" + key))
}

// Recovery reads the committed order without consulting current stock/prices or
// repeating a purchase. A key is a lookup hint, never proof of ownership.
func (s *service) getByIdempotency(ctx context.Context, key string, a actor) (order, error) {
	if a.role != "customer" || a.id == "" {
		return order{}, fail(403, "forbidden")
	}
	if !validOrderKey(key) {
		return order{}, fail(400, "invalid_request")
	}
	keyHash := orderKeyHash(key)
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT document FROM orders WHERE idempotency_hash=$1 AND owner_id=$2`, keyHash[:], a.id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return order{}, fail(404, "order_not_found")
	}
	if err != nil {
		return order{}, err
	}
	var o order
	if err = json.Unmarshal(data, &o); err != nil {
		return order{}, err
	}
	return o, nil
}

func (s *service) get(ctx context.Context, id string, a actor) (order, error) {
	var data []byte
	err := s.db.QueryRowContext(ctx, `SELECT document FROM orders WHERE id=$1`, id).Scan(&data)
	if errors.Is(err, sql.ErrNoRows) {
		return order{}, fail(404, "order_not_found")
	}
	if err != nil {
		return order{}, err
	}
	var o order
	if err = json.Unmarshal(data, &o); err != nil {
		return order{}, err
	}
	if a.role != "merchant" && o.OwnerID != a.id {
		return order{}, fail(404, "order_not_found")
	}
	return o, nil
}

func (s *service) list(ctx context.Context) ([]order, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT document FROM orders ORDER BY created_at DESC,id DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []order{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var o order
		if err = json.Unmarshal(raw, &o); err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, rows.Err()
}

func (s *service) mutate(ctx context.Context, id string, a actor, next string, expected int64, simulate bool) (order, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return order{}, err
	}
	defer tx.Rollback()
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT document FROM orders WHERE id=$1 FOR UPDATE`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return order{}, fail(404, "order_not_found")
	}
	if err != nil {
		return order{}, err
	}
	var o order
	if err = json.Unmarshal(raw, &o); err != nil {
		return order{}, err
	}
	if simulate {
		if !s.synthetic {
			return order{}, fail(404, "not_found")
		}
		if a.role != "customer" || o.OwnerID != a.id {
			return order{}, fail(404, "order_not_found")
		}
		if o.PaymentStatus == "paid" {
			return o, nil
		}
		if o.Status != "pending_payment" {
			return order{}, fail(409, "invalid_status")
		}
		o.PaymentStatus, o.Status = "paid", "accepted"
		o.PaymentProvider, o.PaymentReference = "local-simulation", o.ID
	} else {
		if o.Version != expected {
			return order{}, fail(409, "version_conflict")
		}
		if o.PaymentStatus != "paid" {
			return order{}, fail(409, "payment_required")
		}
		if next == o.Status {
			return o, nil
		}
		allowed := map[string]string{"accepted": "preparing", "preparing": "ready", "ready": "completed"}
		if allowed[o.Status] != next || next == "" {
			return order{}, fail(409, "invalid_status")
		}
		o.Status = next
	}
	o.Version++
	raw, err = json.Marshal(o)
	if err != nil {
		return order{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE orders SET document=$2,payment_provider=$3,payment_reference=$4 WHERE id=$1`, id, raw, o.PaymentProvider, o.PaymentReference); err != nil {
		return order{}, err
	}
	if err = s.appendEvent(ctx, tx, o); err != nil {
		return order{}, err
	}
	return o, tx.Commit()
}

// The platform must first verify the invoice with its sandbox provider key.
// This internal endpoint deliberately does not accept customer assertions.
func (s *service) confirmTestPayment(ctx context.Context, id string, in testPaymentInput) (order, error) {
	if !s.synthetic {
		return order{}, fail(404, "not_found")
	}
	if in.Provider != "moyasar-test" || !identifier.MatchString(in.Reference) || in.Currency != "SAR" || in.AmountMinor <= 0 {
		return order{}, fail(400, "invalid_payment")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return order{}, err
	}
	defer tx.Rollback()
	var raw []byte
	err = tx.QueryRowContext(ctx, `SELECT document FROM orders WHERE id=$1 FOR UPDATE`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return order{}, fail(404, "order_not_found")
	}
	if err != nil {
		return order{}, err
	}
	var o order
	if err = json.Unmarshal(raw, &o); err != nil {
		return order{}, err
	}
	if o.TotalMinor != in.AmountMinor || o.Currency != in.Currency {
		return order{}, fail(409, "payment_mismatch")
	}
	if o.PaymentStatus == "paid" {
		if o.PaymentProvider != in.Provider || o.PaymentReference != in.Reference {
			return order{}, fail(409, "payment_conflict")
		}
		return o, nil
	}
	if o.Status != "pending_payment" || o.PaymentStatus != "pending" {
		return order{}, fail(409, "invalid_status")
	}
	o.Status, o.PaymentStatus, o.PaymentProvider, o.PaymentReference = "accepted", "paid", in.Provider, in.Reference
	o.Version++
	raw, err = json.Marshal(o)
	if err != nil {
		return order{}, err
	}
	_, err = tx.ExecContext(ctx, `UPDATE orders SET document=$2,payment_provider=$3,payment_reference=$4 WHERE id=$1`, id, raw, in.Provider, in.Reference)
	if err != nil {
		var pgError *pgconn.PgError
		if errors.As(err, &pgError) && pgError.Code == "23505" {
			return order{}, fail(409, "payment_reference_used")
		}
		return order{}, err
	}
	if err = s.appendEvent(ctx, tx, o); err != nil {
		return order{}, err
	}
	return o, tx.Commit()
}

func (s *service) appendEvent(ctx context.Context, tx *sql.Tx, o order) error {
	id, err := randomID()
	if err != nil {
		return err
	}
	e := event{EventID: id, TenantID: s.tenantID, OrderID: o.ID, OwnerID: o.OwnerID, Status: o.Status, PaymentStatus: o.PaymentStatus, Version: o.Version, OccurredAt: time.Now().UTC()}
	// A PostgreSQL sequence can commit out of order and lose events for an `after`
	// cursor. This transactional counter is held until commit, preserving order.
	if err = tx.QueryRowContext(ctx, `UPDATE tenant_meta SET event_sequence=event_sequence+1 WHERE singleton AND tenant_id=$1 RETURNING event_sequence`, s.tenantID).Scan(&e.Sequence); err != nil {
		return err
	}
	raw, err := json.Marshal(e)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO event_outbox(sequence,event_id,order_id,version,document) VALUES($1,$2,$3,$4,$5)`, e.Sequence, e.EventID, e.OrderID, e.Version, raw)
	return err
}

func (s *service) events(ctx context.Context, after int64, limit int) ([]event, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT document FROM event_outbox WHERE sequence>$1 ORDER BY sequence LIMIT $2`, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []event{}
	for rows.Next() {
		var raw []byte
		if err = rows.Scan(&raw); err != nil {
			return nil, err
		}
		var e event
		if err = json.Unmarshal(raw, &e); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}
