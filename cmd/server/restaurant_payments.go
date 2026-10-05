package main

// Payment credentials and attempt snapshots are encrypted with a dedicated
// database singleton key. Back up the entire database. This prevents accidental
// disclosure through ordinary configuration/attempt reads; it is not protection
// against a complete database compromise. No credential is returned by HTTP.
import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/google/uuid"
)

type restaurantPaymentField struct {
	Key      string `json:"key"`
	Label    string `json:"label"`
	Secret   bool   `json:"secret"`
	Required bool   `json:"required"`
}
type restaurantPaymentDefinition struct {
	ID, Name string
	Fields   []restaurantPaymentField
}

var restaurantPaymentDefinitions = []restaurantPaymentDefinition{
	{"stripe", "Stripe", []restaurantPaymentField{{"secretKey", "Secret API key", true, true}}},
	{"moyasar", "Moyasar", []restaurantPaymentField{{"secretKey", "Secret API key", true, true}}},
	{"tap", "Tap", []restaurantPaymentField{{"secretKey", "Secret API key", true, true}}},
	{"hyperpay", "HyperPay", []restaurantPaymentField{{"entityId", "Entity ID", false, true}, {"accessToken", "Access token", true, true}}},
	{"paytabs", "PayTabs", []restaurantPaymentField{{"profileId", "Profile ID", false, true}, {"serverKey", "Server key", true, true}}},
	{"geidea", "Geidea", []restaurantPaymentField{{"merchantPublicKey", "Merchant public key", false, true}, {"apiPassword", "API password", true, true}}},
	{"myfatoorah", "MyFatoorah", []restaurantPaymentField{{"apiToken", "API token", true, true}, {"paymentMethodId", "Payment method ID", false, true}}},
}

type restaurantPaymentConfig struct {
	ID      string            `json:"id"`
	Enabled bool              `json:"enabled"`
	Mode    string            `json:"mode"`
	Values  map[string]string `json:"values"`
	Secrets map[string]string `json:"secrets"`
}
type restaurantPaymentConfigInput struct {
	Enabled      bool              `json:"enabled"`
	Mode         string            `json:"mode"`
	Values       map[string]string `json:"values"`
	Secrets      map[string]string `json:"secrets"`
	ClearSecrets []string          `json:"clearSecrets"`
}
type restaurantPaymentPublicConfig struct {
	ID               string                     `json:"id"`
	Name             string                     `json:"name"`
	Enabled          bool                       `json:"enabled"`
	Mode             string                     `json:"mode"`
	Configured       bool                       `json:"configured"`
	Fields           []restaurantPaymentField   `json:"fields"`
	Values           map[string]string          `json:"values"`
	SecretSet        map[string]bool            `json:"secretSet"`
	Limitation       string                     `json:"limitation,omitempty"`
	WebhookURL       string                     `json:"webhookUrl,omitempty"`
	RefundCapability restaurantRefundCapability `json:"refundCapability"`
}
type restaurantPaymentWidget struct {
	CheckoutID string   `json:"checkoutId"`
	ScriptURL  string   `json:"scriptUrl"`
	Brands     []string `json:"brands"`
	ReturnURL  string   `json:"returnUrl"`
}
type restaurantPaymentView struct {
	AttemptID string                   `json:"attemptId"`
	Status    string                   `json:"status"`
	Provider  string                   `json:"provider"`
	Mode      string                   `json:"mode"`
	URL       string                   `json:"url,omitempty"`
	Widget    *restaurantPaymentWidget `json:"widget,omitempty"`
}
type restaurantPaymentRequest struct {
	AttemptID, OrderNumber, Currency, CustomerName, Phone, ReturnURL, HookURL string
	AmountMinor                                                               int64
}
type restaurantPaymentRemote struct {
	ID, URL, Status, Currency, Reference string
	AmountMinor                          int64
	Widget                               *restaurantPaymentWidget
	RefundStateKnown                     bool
	RefundedMinor                        int64
}
type restaurantPaymentAdapter interface {
	Create(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error)
	Fetch(context.Context, restaurantPaymentConfig, string, string) (restaurantPaymentRemote, error)
}
type restaurantPaymentAttempt struct {
	ID, Number, Provider, Mode, Status, RemoteID, URL string
	Widget                                            *restaurantPaymentWidget
	Config                                            restaurantPaymentConfig
	CreatedAt                                         time.Time
}
type restaurantPayments struct {
	db      *sql.DB
	orders  *restaurantOrders
	seal    cipher.AEAD
	baseURL string
	adapter restaurantPaymentAdapter
}

func newRestaurantPayments(ctx context.Context, db *sql.DB, orders *restaurantOrders, publicBaseURL string) (*restaurantPayments, error) {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_payment_secret (id integer PRIMARY KEY CHECK(id=1),secret bytea NOT NULL CHECK(octet_length(secret)=32));
 CREATE TABLE IF NOT EXISTS restaurant_payment_configs (provider text PRIMARY KEY, sealed bytea NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
	CREATE TABLE IF NOT EXISTS restaurant_payment_attempts (id text PRIMARY KEY,order_number text NOT NULL UNIQUE REFERENCES restaurant_orders(number),provider text NOT NULL, mode text NOT NULL,status text NOT NULL,remote_id text NOT NULL DEFAULT '',url text NOT NULL DEFAULT '',widget jsonb, sealed_config bytea NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),checked_at timestamptz);
	ALTER TABLE restaurant_payment_attempts ADD COLUMN IF NOT EXISTS needs_refresh boolean NOT NULL DEFAULT false;
	ALTER TABLE restaurant_payment_attempts ADD COLUMN IF NOT EXISTS refresh_version bigint NOT NULL DEFAULT 0;
	ALTER TABLE restaurant_payment_attempts ADD COLUMN IF NOT EXISTS capture_verified boolean NOT NULL DEFAULT false;
	ALTER TABLE restaurant_payment_attempts ADD COLUMN IF NOT EXISTS captured_minor bigint NOT NULL DEFAULT 0;
 CREATE INDEX IF NOT EXISTS restaurant_payment_attempt_status_idx ON restaurant_payment_attempts(status,updated_at);`)
	if err != nil {
		return nil, err
	}
	if err = restaurantInitRefundSchema(ctx, db); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err = rand.Read(key); err != nil {
		return nil, err
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO restaurant_payment_secret(id,secret) VALUES(1,$1) ON CONFLICT(id) DO NOTHING`, key); err != nil {
		return nil, err
	}
	if err = db.QueryRowContext(ctx, `SELECT secret FROM restaurant_payment_secret WHERE id=1`).Scan(&key); err != nil {
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
	p := &restaurantPayments{db: db, orders: orders, seal: seal, baseURL: strings.TrimRight(publicBaseURL, "/"), adapter: &restaurantPaymentGateways{client: &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}}
	return p, nil
}
func restaurantPaymentDefinitionByID(id string) (restaurantPaymentDefinition, bool) {
	for _, d := range restaurantPaymentDefinitions {
		if d.ID == id {
			return d, true
		}
	}
	return restaurantPaymentDefinition{}, false
}
func (p *restaurantPayments) encrypt(id string, cfg restaurantPaymentConfig) ([]byte, error) {
	data, err := json.Marshal(cfg)
	if err != nil {
		return nil, err
	}
	nonce := make([]byte, p.seal.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, err
	}
	return p.seal.Seal(nonce, nonce, data, []byte("restaurant-payment-v1:"+id)), nil
}
func (p *restaurantPayments) decrypt(id string, data []byte) (restaurantPaymentConfig, error) {
	var c restaurantPaymentConfig
	if len(data) < p.seal.NonceSize() {
		return c, errors.New("payment credentials unavailable")
	}
	plain, err := p.seal.Open(nil, data[:p.seal.NonceSize()], data[p.seal.NonceSize():], []byte("restaurant-payment-v1:"+id))
	if err != nil {
		return c, errors.New("payment credentials unavailable")
	}
	err = json.Unmarshal(plain, &c)
	return c, err
}
func (p *restaurantPayments) config(ctx context.Context, id string) (restaurantPaymentConfig, error) {
	c := restaurantPaymentConfig{ID: id, Mode: "test", Values: map[string]string{}, Secrets: map[string]string{}}
	var b []byte
	err := p.db.QueryRowContext(ctx, `SELECT sealed FROM restaurant_payment_configs WHERE provider=$1`, id).Scan(&b)
	if errors.Is(err, sql.ErrNoRows) {
		return c, nil
	}
	if err != nil {
		return c, err
	}
	return p.decrypt("config:"+id, b)
}
func restaurantPaymentConfigured(c restaurantPaymentConfig) bool {
	d, ok := restaurantPaymentDefinitionByID(c.ID)
	if !ok || c.Mode != "test" && c.Mode != "live" {
		return false
	}
	for _, f := range d.Fields {
		v := c.Values[f.Key]
		if f.Secret {
			v = c.Secrets[f.Key]
		}
		if f.Required && v == "" {
			return false
		}
	}
	return true
}
func restaurantPaymentSanitize(c restaurantPaymentConfig) restaurantPaymentPublicConfig {
	d, _ := restaurantPaymentDefinitionByID(c.ID)
	out := restaurantPaymentPublicConfig{ID: c.ID, Name: d.Name, Enabled: c.Enabled, Mode: c.Mode, Configured: restaurantPaymentConfigured(c), Fields: d.Fields, Values: c.Values, SecretSet: map[string]bool{}}
	out.RefundCapability = restaurantRefundCapabilities(c.ID)
	for _, f := range d.Fields {
		if f.Secret {
			out.SecretSet[f.Key] = c.Secrets[f.Key] != ""
		}
	}
	switch c.ID {
	case "hyperpay":
		out.Limitation = "hyperpay_test_only"
	case "paytabs", "geidea":
		out.Limitation = "merchant_mode_credentials"
	case "stripe":
		out.Limitation = "stripe_merchant_eligibility"
	case "myfatoorah":
		out.Limitation = "merchant_sar_currency"
	}
	return out
}
func (p *restaurantPayments) Admin(ctx context.Context) ([]restaurantPaymentPublicConfig, error) {
	out := []restaurantPaymentPublicConfig{}
	for _, d := range restaurantPaymentDefinitions {
		c, err := p.config(ctx, d.ID)
		if err != nil {
			return nil, err
		}
		v := restaurantPaymentSanitize(c)
		if c.ID == "stripe" {
			v.WebhookURL = p.baseURL + "/payment-hooks/stripe"
		}
		out = append(out, v)
	}
	return out, nil
}
func (p *restaurantPayments) Configure(ctx context.Context, id string, in restaurantPaymentConfigInput) (restaurantPaymentPublicConfig, error) {
	d, ok := restaurantPaymentDefinitionByID(id)
	if !ok {
		return restaurantPaymentPublicConfig{}, restaurantFail(404, "invalid_request")
	}
	if in.Mode != "test" && in.Mode != "live" {
		return restaurantPaymentPublicConfig{}, restaurantFail(400, "invalid_request")
	}
	// Serialize edits across processes so omitted secrets cannot restore stale credentials.
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantPaymentPublicConfig{}, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "restaurant-payment-config:"+id); err != nil {
		return restaurantPaymentPublicConfig{}, err
	}
	c := restaurantPaymentConfig{ID: id, Mode: in.Mode, Values: map[string]string{}, Secrets: map[string]string{}}
	var b []byte
	err = tx.QueryRowContext(ctx, `SELECT sealed FROM restaurant_payment_configs WHERE provider=$1`, id).Scan(&b)
	if err == nil {
		c, err = p.decrypt("config:"+id, b)
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return restaurantPaymentPublicConfig{}, err
	}
	c.Enabled, c.Mode = in.Enabled, in.Mode
	fields := map[string]restaurantPaymentField{}
	for _, f := range d.Fields {
		fields[f.Key] = f
	}
	for k, v := range in.Values {
		f, ok := fields[k]
		if !ok || f.Secret || len(v) > 256 || strings.ContainsAny(v, "\r\n\x00") {
			return restaurantPaymentPublicConfig{}, restaurantFail(400, "invalid_request")
		}
		c.Values[k] = strings.TrimSpace(v)
	}
	for k, v := range in.Secrets {
		f, ok := fields[k]
		if !ok || !f.Secret || len(v) > 8192 || strings.ContainsAny(v, "\r\n\x00") {
			return restaurantPaymentPublicConfig{}, restaurantFail(400, "invalid_request")
		}
		if strings.TrimSpace(v) != "" {
			c.Secrets[k] = strings.TrimSpace(v)
		}
	}
	for _, k := range in.ClearSecrets {
		f, ok := fields[k]
		if !ok || !f.Secret {
			return restaurantPaymentPublicConfig{}, restaurantFail(400, "invalid_request")
		}
		delete(c.Secrets, k)
	}
	if err = restaurantPaymentValidateConfig(c); err != nil {
		return restaurantPaymentPublicConfig{}, err
	}
	if c.Enabled && !restaurantPaymentConfigured(c) {
		return restaurantPaymentPublicConfig{}, restaurantFail(400, "invalid_request")
	}
	b, err = p.encrypt("config:"+id, c)
	if err != nil {
		return restaurantPaymentPublicConfig{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_payment_configs(provider,sealed) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET sealed=EXCLUDED.sealed,updated_at=now()`, id, b); err != nil {
		return restaurantPaymentPublicConfig{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantPaymentPublicConfig{}, err
	}
	return restaurantPaymentSanitize(c), nil
}
func (p *restaurantPayments) Available(ctx context.Context, provider, currency string) (bool, error) {
	// Initial Saudi gateway rollout deliberately permits SAR only. More merchant
	// currencies must be verified per gateway instead of assuming universal support.
	if currency != "SAR" || !restaurantPaymentBaseURL(p.baseURL) {
		return false, nil
	}
	catalog, err := p.orders.store.GetCatalog(ctx, false)
	if err != nil {
		return false, err
	}
	for _, d := range restaurantPaymentDefinitions {
		if provider != "" && provider != d.ID {
			continue
		}
		c, err := p.config(ctx, d.ID)
		if err != nil {
			return false, err
		}
		if c.ID == "hyperpay" && c.Mode != "test" {
			continue
		}
		if (c.Mode == "test") != catalog.Settings.Demo {
			continue
		}
		if c.Enabled && restaurantPaymentConfigured(c) {
			return true, nil
		}
	}
	return false, nil
}
func restaurantPaymentBaseURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && u.Scheme == "https" && u.Host != "" && u.User == nil && u.RawQuery == "" && u.Fragment == "" && (u.Path == "" || u.Path == "/")
}
func (p *restaurantPayments) Public(ctx context.Context, currency string) ([]map[string]string, error) {
	out := []map[string]string{}
	for _, d := range restaurantPaymentDefinitions {
		ok, err := p.Available(ctx, d.ID, currency)
		if err != nil {
			return nil, err
		}
		if ok {
			c, err := p.config(ctx, d.ID)
			if err != nil {
				return nil, err
			}
			out = append(out, map[string]string{"id": d.ID, "name": d.Name, "mode": c.Mode})
		}
	}
	return out, nil
}

const restaurantPaymentAttemptSelect = `SELECT id,order_number,provider,mode,status,remote_id,url,widget,sealed_config,created_at FROM restaurant_payment_attempts`

func (p *restaurantPayments) readAttempt(row interface{ Scan(...any) error }) (restaurantPaymentAttempt, error) {
	var a restaurantPaymentAttempt
	var b, w []byte
	if err := row.Scan(&a.ID, &a.Number, &a.Provider, &a.Mode, &a.Status, &a.RemoteID, &a.URL, &w, &b, &a.CreatedAt); err != nil {
		return a, err
	}
	var err error
	a.Config, err = p.decrypt("attempt:"+a.ID, b)
	if err != nil {
		return a, err
	}
	if len(w) > 0 && string(w) != "null" {
		err = json.Unmarshal(w, &a.Widget)
	}
	return a, err
}
func (a restaurantPaymentAttempt) view() restaurantPaymentView {
	status := a.Status
	if status == "creating" {
		status = "pending"
	}
	v := restaurantPaymentView{AttemptID: a.ID, Status: status, Provider: a.Provider, Mode: a.Mode}
	if status == "pending" {
		v.URL, v.Widget = a.URL, a.Widget
	}
	return v
}
func (p *restaurantPayments) Status(ctx context.Context, number, token, customerID string) (restaurantPaymentView, error) {
	o, err := p.orders.Track(ctx, number, token, "", customerID)
	if err != nil {
		return restaurantPaymentView{}, err
	}
	a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE order_number=$1`, o.Number))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantPaymentView{Status: o.Payment.Status, Provider: o.Payment.Provider}, nil
	}
	if o.Payment.Status == "review" {
		a.Status = "review"
	}
	return a.view(), err
}
func (p *restaurantPayments) Start(ctx context.Context, number, token, customerID, provider string) (restaurantPaymentView, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantPaymentView{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number))
	if errors.Is(err, sql.ErrNoRows) || err == nil && !restaurantCanAccess(stored, token, "", customerID) {
		return restaurantPaymentView{}, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return restaurantPaymentView{}, err
	}
	o := stored.order
	if o.Payment.Method != "card" || provider != o.Payment.Provider || o.Status == "cancelled" || o.Status == "completed" {
		return restaurantPaymentView{}, restaurantFail(409, "invalid_status")
	}
	a, err := p.readAttempt(tx.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE order_number=$1`, number))
	if err == nil {
		return a.view(), nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return restaurantPaymentView{}, err
	}
	if o.Payment.Status != "unpaid" {
		return restaurantPaymentView{}, restaurantFail(409, "invalid_status")
	}
	if provider == "geidea" {
		if _, _, err := restaurantPaymentPhone(o.Phone); err != nil {
			return restaurantPaymentView{}, restaurantFail(400, "phone_required")
		}
	}
	available, err := p.Available(ctx, provider, o.Currency)
	if err != nil {
		return restaurantPaymentView{}, err
	}
	if !available {
		return restaurantPaymentView{}, restaurantFail(409, "payment_unavailable")
	}
	cfg, err := p.config(ctx, provider)
	if err != nil {
		return restaurantPaymentView{}, err
	}
	if !cfg.Enabled || !restaurantPaymentConfigured(cfg) || cfg.ID == "hyperpay" && cfg.Mode != "test" || (cfg.Mode == "test") != o.Demo {
		return restaurantPaymentView{}, restaurantFail(409, "payment_unavailable")
	}
	a = restaurantPaymentAttempt{ID: uuid.NewString(), Number: number, Provider: provider, Mode: cfg.Mode, Status: "creating", Config: cfg, CreatedAt: time.Now().UTC()}
	sealed, err := p.encrypt("attempt:"+a.ID, cfg)
	if err != nil {
		return restaurantPaymentView{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_payment_attempts(id,order_number,provider,mode,status,sealed_config) VALUES($1,$2,$3,$4,$5,$6)`, a.ID, a.Number, a.Provider, a.Mode, a.Status, sealed); err != nil {
		return restaurantPaymentView{}, err
	}
	o.Payment.Status = "pending"
	if err = restaurantPaymentWriteOrder(ctx, tx, &o, "pending"); err != nil {
		return restaurantPaymentView{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantPaymentView{}, err
	}
	req := restaurantPaymentRequest{AttemptID: a.ID, OrderNumber: o.Number, AmountMinor: o.TotalMinor, Currency: o.Currency, CustomerName: o.CustomerName, Phone: o.Phone, ReturnURL: p.baseURL + "/payment-hooks/return/" + url.PathEscape(a.ID), HookURL: p.baseURL + "/payment-hooks/" + provider + "/" + a.ID}
	remote, createErr := p.adapter.Create(ctx, cfg, req)
	// Persist uncertainty using a fresh bounded context, even if browser canceled.
	saveCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if createErr != nil || !restaurantPaymentID.MatchString(remote.ID) || remote.URL == "" && remote.Widget == nil {
		_, err = p.apply(saveCtx, a, restaurantPaymentRemote{Status: "review"}, false)
		if err != nil {
			return restaurantPaymentView{}, err
		}
		return restaurantPaymentView{AttemptID: a.ID, Status: "review", Provider: provider, Mode: cfg.Mode}, nil
	}
	if remote.URL != "" && !restaurantPaymentURL(provider, remote.URL) {
		_, _ = p.apply(saveCtx, a, restaurantPaymentRemote{ID: remote.ID, Status: "review"}, false)
		return restaurantPaymentView{}, restaurantFail(502, "payment_unavailable")
	}
	remote.Status = "pending" // A creation response is never a payment confirmation.
	return p.apply(saveCtx, a, remote, false)
}
func restaurantPaymentWriteOrder(ctx context.Context, tx *sql.Tx, o *restaurantOrder, status string) error {
	o.Version++
	o.UpdatedAt = time.Now().UTC()
	if err := restaurantUpdateOrder(ctx, tx, *o); err != nil {
		return err
	}
	return restaurantWriteOrderEvent(ctx, tx, *o, "payment", map[string]string{"status": status})
}
func (p *restaurantPayments) apply(ctx context.Context, a restaurantPaymentAttempt, r restaurantPaymentRemote, verified bool) (restaurantPaymentView, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantPaymentView{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, a.Number))
	if err != nil {
		return restaurantPaymentView{}, err
	}
	o := stored.order
	current, err := p.readAttempt(tx.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1 FOR UPDATE`, a.ID))
	if err != nil {
		return restaurantPaymentView{}, err
	}
	a = current
	if verified && (r.ID != a.RemoteID || r.Currency != o.Currency || r.AmountMinor != o.TotalMinor || r.Reference != a.ID || (a.Mode == "test") != o.Demo) {
		r.Status = "review"
	}
	if (r.Status == "paid" || r.Status == "refunded") && !verified {
		r.Status = "review"
	}
	// A known, provider-confirmed partial refund does not erase the original
	// payment or stop fulfillment of the customer's agreed remaining items.
	// Unknown external partial refunds still require review.
	if verified && r.ID == a.RemoteID && r.Currency == o.Currency && r.AmountMinor == o.TotalMinor && r.Reference == a.ID && (a.Mode == "test") == o.Demo && r.Status == "review" && r.RefundStateKnown && r.RefundedMinor > 0 && r.RefundedMinor < o.TotalMinor && o.Payment.Status == "paid" && o.Status != "cancelled" {
		_, known, _, e := restaurantRefundTotals(ctx, tx, o.Number)
		if e != nil {
			return restaurantPaymentView{}, e
		}
		if known == r.RefundedMinor {
			r.Status = "paid"
		}
	}
	// Preserve factual captured funds independently from the fulfillment status.
	// A cancelled order remains cancelled/review but may still need a refund.
	validCapture := verified && r.Status == "paid"
	if validCapture {
		if _, err = tx.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET capture_verified=true,captured_minor=$2 WHERE id=$1`, a.ID, o.TotalMinor); err != nil {
			return restaurantPaymentView{}, err
		}
	}
	switch r.Status {
	case "pending", "paid", "failed", "refunded", "review":
	default:
		r.Status = "review"
	}
	if r.URL != "" && !restaurantPaymentURL(a.Provider, r.URL) {
		r.URL = ""
		r.Status = "review"
	}
	if o.Payment.Status == "review" && r.Status != "refunded" {
		r.Status = "review"
	}
	if a.Status == "paid" && o.Status == "cancelled" && r.Status != "refunded" {
		r.Status = "review"
	}
	if a.Status == "paid" && verified && r.Status == "failed" {
		// A newly queried explicit failure/reversal is not an old webhook
		// status. Stop further fulfillment until the merchant reconciles it.
		r.Status = "review"
	}
	if a.Status == "paid" && r.Status != "refunded" && r.Status != "review" {
		return a.view(), tx.Commit()
	}
	if a.Status == "refunded" {
		return a.view(), nil
	}
	if r.Status == "paid" && (o.Status == "cancelled" || o.Payment.Status == "review") {
		r.Status = "review"
	}
	if r.ID != "" && a.RemoteID == "" {
		a.RemoteID = r.ID
	}
	if r.URL != "" {
		a.URL = r.URL
	}
	if r.Widget != nil {
		a.Widget = r.Widget
	}
	a.Status = r.Status
	w, err := json.Marshal(a.Widget)
	if err != nil {
		return restaurantPaymentView{}, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET status=$2,remote_id=$3,url=$4,widget=$5,updated_at=now() WHERE id=$1`, a.ID, a.Status, a.RemoteID, a.URL, w); err != nil {
		return restaurantPaymentView{}, err
	}
	if o.Payment.Status != a.Status {
		o.Payment.Status = a.Status
		if a.Status == "paid" {
			now := time.Now().UTC()
			o.Payment.PaidAt = &now
		}
		if err = restaurantPaymentWriteOrder(ctx, tx, &o, a.Status); err != nil {
			return restaurantPaymentView{}, err
		}
	}
	if validCapture && o.Status == "cancelled" {
		if err = restaurantEnsureCancellationRefundTx(ctx, tx, o, "late_verified_payment"); err != nil {
			return restaurantPaymentView{}, err
		}
	}
	if err = tx.Commit(); err != nil {
		return restaurantPaymentView{}, err
	}
	return a.view(), nil
}
func (p *restaurantPayments) Refresh(ctx context.Context, number, token, customerID string) (restaurantPaymentView, error) {
	if _, err := p.orders.Track(ctx, number, token, "", customerID); err != nil {
		return restaurantPaymentView{}, err
	}
	a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE order_number=$1`, number))
	if errors.Is(err, sql.ErrNoRows) {
		return p.Status(ctx, number, token, customerID)
	}
	if err != nil {
		return restaurantPaymentView{}, err
	}
	return p.refreshAttempt(ctx, a)
}
func (p *restaurantPayments) refreshAttempt(ctx context.Context, a restaurantPaymentAttempt) (restaurantPaymentView, error) {
	// Shared durable rate limit/lease also prevents forged notifications from
	// producing unbounded provider requests. Hooks never consume supplied status.
	var generation int64
	err := p.db.QueryRowContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now() WHERE id=$1 AND (checked_at IS NULL OR checked_at < now()-interval '30 seconds') RETURNING refresh_version`, a.ID).Scan(&generation)
	if errors.Is(err, sql.ErrNoRows) {
		return a.view(), nil
	}
	if err != nil {
		return restaurantPaymentView{}, err
	}
	complete := func(v restaurantPaymentView, e error) (restaurantPaymentView, error) {
		if e != nil {
			return v, e
		}
		// A newer hook increments generation, so it survives this completion.
		_, e = p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET needs_refresh=false WHERE id=$1 AND refresh_version=$2`, a.ID, generation)
		return v, e
	}
	if a.RemoteID == "" {
		if a.Status == "creating" && time.Since(a.CreatedAt) > time.Minute {
			v, e := p.apply(ctx, a, restaurantPaymentRemote{Status: "review"}, false)
			return complete(v, e)
		}
		return complete(a.view(), nil)
	}
	r, err := p.adapter.Fetch(ctx, a.Config, a.RemoteID, a.ID)
	if err != nil {
		// A failed authenticated lookup must not discard a paid/refund event.
		retryCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		_, _ = p.db.ExecContext(retryCtx, `UPDATE restaurant_payment_attempts SET needs_refresh=true WHERE id=$1`, a.ID)
		cancel()
		return a.view(), restaurantFail(502, "payment_unavailable")
	}
	v, e := p.apply(ctx, a, r, true)
	return complete(v, e)
}
func (p *restaurantPayments) Hook(ctx context.Context, provider, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return restaurantFail(404, "invalid_request")
	}
	a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1 AND provider=$2`, id, provider))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantFail(404, "invalid_request")
	}
	if err != nil {
		return err
	}
	_, err = p.notifyAttempt(ctx, a)
	return err
}

// Persist notification work before acknowledging it. Generation-checked clearing
// after settlement preserves concurrent notifications and a crash during lookup.
func (p *restaurantPayments) notifyAttempt(ctx context.Context, a restaurantPaymentAttempt) (restaurantPaymentView, error) {
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET needs_refresh=true,refresh_version=refresh_version+1 WHERE id=$1`, a.ID); err != nil {
		return restaurantPaymentView{}, err
	}
	return p.refreshAttempt(ctx, a)
}

// Run reconciles bounded batches independently of the customer's tab and webhook
// timing. Only pending/uncertain or durably notified attempts are read; it never creates a
// payment, captures an authorization, retries a charge, or sends a refund.
func (p *restaurantPayments) Run(ctx context.Context) {
	ticker := time.NewTicker(time.Minute)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			batchCtx, cancel := context.WithTimeout(ctx, 45*time.Second)
			_ = p.Reconcile(batchCtx)
			_ = p.ReconcileRefunds(batchCtx)
			cancel()
		}
	}
}
func (p *restaurantPayments) Reconcile(ctx context.Context) error {
	rows, err := p.db.QueryContext(ctx, restaurantPaymentAttemptSelect+` WHERE needs_refresh OR (status IN ('creating','pending','review') AND created_at > now()-interval '7 days') ORDER BY needs_refresh DESC,checked_at NULLS FIRST LIMIT 10`)
	if err != nil {
		return err
	}
	attempts := []restaurantPaymentAttempt{}
	for rows.Next() {
		a, e := p.readAttempt(rows)
		if e != nil {
			rows.Close()
			return e
		}
		attempts = append(attempts, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, a := range attempts {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, _ = p.refreshAttempt(ctx, a)
	}
	return nil
}
