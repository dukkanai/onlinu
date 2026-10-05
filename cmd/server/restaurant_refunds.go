package main

// Refund intents are durable before any provider mutation. An ambiguous POST is
// NEVER retried: only authenticated read-only reconciliation or manual review is
// permitted. Order row locking is the common serialization boundary with payment,
// cancellation, stock and courier updates.
import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math/big"
	"strings"
	"time"

	"github.com/google/uuid"
)

type restaurantRefundCapability struct {
	Automatic bool   `json:"automatic"`
	Partial   bool   `json:"partial"`
	Manual    bool   `json:"manual"`
	Reason    string `json:"reason"`
}
type restaurantRefund struct {
	ID                string    `json:"id"`
	Number            string    `json:"number"`
	RequestID         string    `json:"requestId"`
	Status            string    `json:"status"`
	Provider          string    `json:"provider"`
	Currency          string    `json:"currency"`
	AmountMinor       int64     `json:"amountMinor"`
	TaxMinor          int64     `json:"taxMinor"`
	Reason            string    `json:"reason"`
	ProviderReference string    `json:"providerReference,omitempty"`
	ManualReference   string    `json:"manualReference,omitempty"`
	ResolutionReason  string    `json:"resolutionReason,omitempty"`
	Confirmation      string    `json:"confirmation"`
	Version           int64     `json:"version"`
	Authorized        bool      `json:"authorized"`
	Submitted         bool      `json:"submitted"`
	CreatedAt         time.Time `json:"createdAt"`
	UpdatedAt         time.Time `json:"updatedAt"`
}
type restaurantRefundInput struct {
	RequestID   string `json:"requestId"`
	AmountMinor int64  `json:"amountMinor"`
	Reason      string `json:"reason"`
	Version     int64  `json:"version"`
}
type restaurantRefundResolution struct {
	Reference string `json:"reference"`
	Reason    string `json:"reason"`
	Version   int64  `json:"version"`
}
type restaurantRefundSummary struct {
	order          restaurantOrder            // Private snapshot; never serialized by legacy refund endpoints.
	Refunds        []restaurantRefund         `json:"refunds"`
	CapturedMinor  int64                      `json:"capturedMinor"`
	ReservedMinor  int64                      `json:"reservedMinor"`
	RefundedMinor  int64                      `json:"refundedMinor"`
	AvailableMinor int64                      `json:"availableMinor"`
	Capability     restaurantRefundCapability `json:"capability"`
}
type restaurantRefundRemote struct{ ID, Status string }
type restaurantRefundAdapter interface {
	CreateRefund(context.Context, restaurantPaymentConfig, restaurantPaymentAttempt, restaurantOrder, restaurantRefund, int64) (restaurantRefundRemote, error)
	FetchRefund(context.Context, restaurantPaymentConfig, restaurantPaymentAttempt, restaurantOrder, restaurantRefund) (restaurantRefundRemote, error)
}

func restaurantRefundCapabilities(provider string) restaurantRefundCapability {
	switch provider {
	case "stripe", "tap", "paytabs", "myfatoorah":
		return restaurantRefundCapability{Automatic: true, Partial: true, Manual: true, Reason: "provider_verified"}
	default:
		return restaurantRefundCapability{Partial: true, Manual: true, Reason: "manual_review_required"}
	}
}

func restaurantInitRefundSchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_refunds (
 id text PRIMARY KEY,order_number text NOT NULL REFERENCES restaurant_orders(number),request_key text NOT NULL,
 status text NOT NULL CHECK(status IN ('requested','processing','succeeded','failed','review','manual_reported')),
 amount_minor bigint NOT NULL CHECK(amount_minor>0), tax_minor bigint NOT NULL CHECK(tax_minor>=0 AND tax_minor<=amount_minor),
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 submitted_at timestamptz,checked_at timestamptz,authorized boolean NOT NULL DEFAULT false,UNIQUE(order_number,request_key));
 ALTER TABLE restaurant_refunds ADD COLUMN IF NOT EXISTS authorized boolean NOT NULL DEFAULT false;
 CREATE INDEX IF NOT EXISTS restaurant_refunds_pending_idx ON restaurant_refunds(status,updated_at);
 CREATE UNIQUE INDEX IF NOT EXISTS restaurant_refunds_remote_unique_idx ON restaurant_refunds(order_number,(data->>'providerReference')) WHERE COALESCE(data->>'providerReference','')<>'';
 CREATE TABLE IF NOT EXISTS restaurant_refund_events(id bigserial PRIMARY KEY,refund_id text NOT NULL REFERENCES restaurant_refunds(id),kind text NOT NULL,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS platform_staff_refund_audit(refund_id TEXT NOT NULL REFERENCES restaurant_refunds(id),version BIGINT NOT NULL,actor_id TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(refund_id,version));`)
	return err
}

func restaurantReadRefund(row interface{ Scan(...any) error }) (restaurantRefund, error) {
	var r restaurantRefund
	var raw []byte
	err := row.Scan(&raw)
	if err == nil {
		err = json.Unmarshal(raw, &r)
	}
	return r, err
}
func restaurantRefundTotals(ctx context.Context, tx *sql.Tx, number string) (reserved, refunded, tax int64, err error) {
	err = tx.QueryRowContext(ctx, `SELECT COALESCE(sum(amount_minor) FILTER(WHERE status<>'failed'),0),COALESCE(sum(amount_minor) FILTER(WHERE status='succeeded'),0),COALESCE(sum(tax_minor) FILTER(WHERE status<>'failed'),0) FROM restaurant_refunds WHERE order_number=$1`, number).Scan(&reserved, &refunded, &tax)
	return
}
func restaurantRefundCaptured(ctx context.Context, tx *sql.Tx, o restaurantOrder) (int64, error) {
	if o.Payment.Method != "card" {
		if o.Payment.PaidAt != nil && o.Payment.AmountMinor == o.TotalMinor {
			return o.TotalMinor, nil
		}
		return 0, nil
	}
	var exists bool
	if err := tx.QueryRowContext(ctx, `SELECT to_regclass('restaurant_payment_attempts') IS NOT NULL`).Scan(&exists); err != nil {
		return 0, err
	}
	if !exists {
		return 0, nil
	}
	var captured int64
	err := tx.QueryRowContext(ctx, `SELECT captured_minor FROM restaurant_payment_attempts WHERE order_number=$1 AND capture_verified`, o.Number).Scan(&captured)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, nil
	}
	return captured, err
}
func restaurantInsertRefundTx(ctx context.Context, tx *sql.Tx, o restaurantOrder, key, reason, status string, amount int64) (restaurantRefund, error) {
	reserved, _, allocatedTax, err := restaurantRefundTotals(ctx, tx, o.Number)
	if err != nil {
		return restaurantRefund{}, err
	}
	if amount <= 0 || amount > o.TotalMinor-reserved {
		return restaurantRefund{}, restaurantFail(409, "invalid_status")
	}
	// A cumulative allocation preserves every cent on a final full refund and
	// never edits the original tax/order snapshots. These are internal financial
	// adjustments, not certified credit notes or ZATCA e-invoices.
	tax := int64(0)
	if o.Tax.Enabled && o.TotalMinor > 0 {
		// Products of valid large order amounts can exceed int64 even though
		// the final proportional tax is bounded by the original tax snapshot.
		n := new(big.Int).Mul(big.NewInt(o.Tax.TaxMinor), big.NewInt(reserved+amount))
		n.Add(n, big.NewInt(o.TotalMinor/2)).Quo(n, big.NewInt(o.TotalMinor))
		if !n.IsInt64() {
			return restaurantRefund{}, restaurantFail(409, "invalid_status")
		}
		tax = n.Int64() - allocatedTax
	}
	if tax < 0 || tax > amount {
		return restaurantRefund{}, restaurantFail(409, "invalid_status")
	}
	now := time.Now().UTC()
	r := restaurantRefund{ID: uuid.NewString(), Number: o.Number, RequestID: key, Status: status, Provider: o.Payment.Provider, Currency: o.Currency, AmountMinor: amount, TaxMinor: tax, Reason: reason, Confirmation: "none", Version: 1, CreatedAt: now, UpdatedAt: now}
	raw, err := json.Marshal(r)
	if err != nil {
		return r, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_refunds(id,order_number,request_key,status,amount_minor,tax_minor,data) VALUES($1,$2,$3,$4,$5,$6,$7)`, r.ID, r.Number, key, r.Status, r.AmountMinor, r.TaxMinor, raw)
	if err == nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_refund_events(refund_id,kind,data) VALUES($1,'requested',$2)`, r.ID, raw)
	}
	if err == nil {
		err = writePlatformStaffRefundAudit(ctx, tx, r, "requested")
	}
	return r, err
}

// Caller holds the order FOR UPDATE lock. Uncertain/legacy payments create a
// review intent, not authority to send money. A later verified paid observation
// can safely promote this exact intent instead of creating another refund.
func restaurantEnsureCancellationRefundTx(ctx context.Context, tx *sql.Tx, o restaurantOrder, reason string) error {
	if o.Status != "cancelled" || o.TotalMinor <= 0 || o.Payment.Status == "refunded" {
		return nil
	}
	if o.Payment.Method != "card" && o.Payment.PaidAt == nil {
		return nil
	}
	if o.Payment.Method == "card" && (o.Payment.Status == "unpaid" || o.Payment.Status == "failed") {
		return nil
	}
	key := "cancellation:" + o.Number
	existing, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE order_number=$1 AND request_key=$2`, o.Number, key))
	captured, captureErr := restaurantRefundCaptured(ctx, tx, o)
	if captureErr != nil {
		return captureErr
	}
	if err == nil {
		if existing.Status == "review" && captured >= existing.AmountMinor && restaurantRefundCapabilities(o.Payment.Provider).Automatic {
			var submitted bool
			if e := tx.QueryRowContext(ctx, `SELECT submitted_at IS NOT NULL FROM restaurant_refunds WHERE id=$1`, existing.ID).Scan(&submitted); e != nil {
				return e
			}
			if !submitted && existing.ResolutionReason == "" {
				existing.Status = "requested"
				return restaurantSaveRefundTx(ctx, tx, &existing, "capture_verified")
			}
		}
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	reserved, _, _, err := restaurantRefundTotals(ctx, tx, o.Number)
	if err != nil {
		return err
	}
	if reserved >= o.TotalMinor {
		return nil
	}
	status := "review"
	if captured == o.TotalMinor && restaurantRefundCapabilities(o.Payment.Provider).Automatic {
		status = "requested"
	}
	_, err = restaurantInsertRefundTx(ctx, tx, o, key, strings.TrimSpace(reason), status, o.TotalMinor-reserved)
	return err
}
func restaurantSaveRefundTx(ctx context.Context, tx *sql.Tx, r *restaurantRefund, kind string) error {
	r.Version++
	r.UpdatedAt = time.Now().UTC()
	raw, err := json.Marshal(r)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `UPDATE restaurant_refunds SET status=$2,data=$3,authorized=$4,updated_at=now() WHERE id=$1`, r.ID, r.Status, raw, r.Authorized)
	if err == nil {
		_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_refund_events(refund_id,kind,data) VALUES($1,$2,$3)`, r.ID, kind, raw)
	}
	if err == nil {
		err = writePlatformStaffRefundAudit(ctx, tx, *r, kind)
	}
	return err
}
func (p *restaurantPayments) Refunds(ctx context.Context, number string) (restaurantRefundSummary, error) {
	out := restaurantRefundSummary{Refunds: []restaurantRefund{}}
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, number))
	if errors.Is(err, sql.ErrNoRows) {
		return out, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return out, err
	}
	out.order = stored.order
	out.Capability = restaurantRefundCapabilities(stored.order.Payment.Provider)
	out.CapturedMinor, err = restaurantRefundCaptured(ctx, tx, stored.order)
	if err != nil {
		return out, err
	}
	out.ReservedMinor, out.RefundedMinor, _, err = restaurantRefundTotals(ctx, tx, number)
	if err != nil {
		return out, err
	}
	out.AvailableMinor = out.CapturedMinor - out.ReservedMinor
	if stored.order.Payment.Status == "refunded" || out.AvailableMinor < 0 {
		out.AvailableMinor = 0
	}
	rows, err := tx.QueryContext(ctx, `SELECT data FROM restaurant_refunds WHERE order_number=$1 ORDER BY created_at,id LIMIT 100`, number)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		r, e := restaurantReadRefund(rows)
		if e != nil {
			return out, e
		}
		out.Refunds = append(out.Refunds, r)
	}
	return out, rows.Err()
}
func (p *restaurantPayments) RequestRefund(ctx context.Context, number string, in restaurantRefundInput) (restaurantRefund, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if _, err := uuid.Parse(in.RequestID); err != nil || len(in.RequestID) != 36 || len(in.Reason) < 3 || len(in.Reason) > 1000 || in.AmountMinor <= 0 {
		return restaurantRefund{}, restaurantFail(400, "invalid_request")
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantRefund{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number))
	if err != nil {
		return restaurantRefund{}, err
	}
	o := stored.order
	r, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE order_number=$1 AND request_key=$2`, number, in.RequestID))
	if err == nil {
		if r.AmountMinor != in.AmountMinor || r.Reason != in.Reason {
			return r, restaurantFail(409, "invalid_request")
		}
		return r, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return r, err
	}
	if o.Version != in.Version {
		return r, restaurantFail(409, "conflict")
	}
	captured, err := restaurantRefundCaptured(ctx, tx, o)
	if err != nil {
		return r, err
	}
	reserved, _, _, err := restaurantRefundTotals(ctx, tx, number)
	if err != nil {
		return r, err
	}
	if o.Payment.Status == "refunded" || in.AmountMinor > captured-reserved {
		return r, restaurantFail(409, "invalid_status")
	}
	status := "review"
	if restaurantRefundCapabilities(o.Payment.Provider).Automatic {
		status = "requested"
	}
	r, err = restaurantInsertRefundTx(ctx, tx, o, in.RequestID, in.Reason, status, in.AmountMinor)
	if err != nil {
		return r, err
	}
	r.Authorized = true
	if err = restaurantSaveRefundTx(ctx, tx, &r, "admin_authorized"); err != nil {
		return r, err
	}
	if err = restaurantPaymentWriteOrder(ctx, tx, &o, o.Payment.Status); err != nil {
		return r, err
	}
	if err = tx.Commit(); err != nil {
		return r, err
	}
	// The durable worker, not a browser request lifetime, dispatches the intent.
	return r, nil
}

// Explicit administrative authorization is required for cancellation-created
// intents. Migration and background reconciliation never authorize refunds.
func (p *restaurantPayments) AuthorizeRefund(ctx context.Context, number, id string, version int64) (restaurantRefund, error) {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantRefund{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number))
	if err != nil {
		return restaurantRefund{}, err
	}
	r, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 AND order_number=$2 FOR UPDATE`, id, number))
	if err != nil {
		return r, err
	}
	if r.Authorized && r.Status == "requested" {
		return r, nil
	}
	if r.Version != version {
		return r, restaurantFail(409, "conflict")
	}
	captured, err := restaurantRefundCaptured(ctx, tx, stored.order)
	if err != nil {
		return r, err
	}
	if (r.Status != "requested" && r.Status != "review") || r.Submitted || captured != stored.order.TotalMinor || !restaurantRefundCapabilities(r.Provider).Automatic {
		return r, restaurantFail(409, "invalid_status")
	}
	r.Authorized = true
	r.Status = "requested"
	r.ResolutionReason = ""
	if err = restaurantSaveRefundTx(ctx, tx, &r, "admin_authorized"); err != nil {
		return r, err
	}
	return r, tx.Commit()
}

func (p *restaurantPayments) ResolveRefundManual(ctx context.Context, number, id string, in restaurantRefundResolution) (restaurantRefund, error) {
	in.Reference = strings.TrimSpace(in.Reference)
	in.Reason = strings.TrimSpace(in.Reason)
	if len(in.Reference) < 3 || len(in.Reference) > 200 || len(in.Reason) < 3 || len(in.Reason) > 1000 {
		return restaurantRefund{}, restaurantFail(400, "invalid_request")
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantRefund{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number))
	if err != nil {
		return restaurantRefund{}, err
	}
	r, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 AND order_number=$2 FOR UPDATE`, id, number))
	if err != nil {
		return r, err
	}
	if r.Status == "manual_reported" && r.ManualReference == in.Reference && r.ResolutionReason == in.Reason {
		return r, nil
	}
	if r.Version != in.Version {
		return r, restaurantFail(409, "conflict")
	}
	// A pending automated request could still pay out. Never invite an extra
	// manual payment while its result is unresolved.
	var submitted bool
	if err = tx.QueryRowContext(ctx, `SELECT submitted_at IS NOT NULL FROM restaurant_refunds WHERE id=$1`, id).Scan(&submitted); err != nil {
		return r, err
	}
	if submitted || r.Status != "review" {
		return r, restaurantFail(409, "invalid_status")
	}
	captured, err := restaurantRefundCaptured(ctx, tx, stored.order)
	if err != nil {
		return r, err
	}
	if captured < r.AmountMinor {
		return r, restaurantFail(409, "invalid_status")
	}
	r.Status = "manual_reported"
	r.Confirmation = "manual"
	r.ManualReference = in.Reference
	r.ResolutionReason = in.Reason
	if err = restaurantSaveRefundTx(ctx, tx, &r, "manual_reported"); err != nil {
		return r, err
	}
	o := stored.order
	if err = restaurantPaymentWriteOrder(ctx, tx, &o, o.Payment.Status); err != nil {
		return r, err
	}
	return r, tx.Commit()
}

func (p *restaurantPayments) processRefund(ctx context.Context, id string) error {
	adapter, ok := p.adapter.(restaurantRefundAdapter)
	if !ok {
		return nil
	}
	var number string
	if err := p.db.QueryRowContext(ctx, `SELECT order_number FROM restaurant_refunds WHERE id=$1`, id).Scan(&number); err != nil {
		return err
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number))
	if err != nil {
		return err
	}
	o := stored.order
	r, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return err
	}
	if r.Status != "requested" || !r.Authorized {
		return nil
	}
	a, err := p.readAttempt(tx.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE order_number=$1`, number))
	if err != nil {
		return err
	}
	captured, err := restaurantRefundCaptured(ctx, tx, o)
	if err != nil {
		return err
	}
	reserved, refunded, _, err := restaurantRefundTotals(ctx, tx, number)
	if err != nil {
		return err
	}
	// Serialize outbound refunds too. Unknown, manual or in-flight other
	// intents block a new provider POST even though total reservations fit.
	var uncertain bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM restaurant_refunds WHERE order_number=$1 AND id<>$2 AND status IN ('processing','review','manual_reported'))`, number, id).Scan(&uncertain); err != nil {
		return err
	}
	if uncertain {
		if _, err = tx.ExecContext(ctx, `UPDATE restaurant_refunds SET checked_at=now() WHERE id=$1`, id); err != nil {
			return err
		}
		return tx.Commit()
	}
	// Read using the same transaction/connection: blocked concurrent workers
	// must not exhaust the pool while the lock owner requests another connection.
	var sealed []byte
	err = tx.QueryRowContext(ctx, `SELECT sealed FROM restaurant_payment_configs WHERE provider=$1`, a.Provider).Scan(&sealed)
	cfg := restaurantPaymentConfig{ID: a.Provider}
	if err == nil {
		cfg, err = p.decrypt("config:"+a.Provider, sealed)
	} else if errors.Is(err, sql.ErrNoRows) {
		err = nil
	}
	if err != nil {
		return err
	}
	if captured != o.TotalMinor || reserved > captured || !cfg.Enabled || cfg.Mode != a.Mode || !restaurantRefundCapabilities(a.Provider).Automatic || o.Payment.Status == "refunded" {
		r.Status = "review"
		r.ResolutionReason = "refund_preflight_required"
		if err = restaurantSaveRefundTx(ctx, tx, &r, "review"); err != nil {
			return err
		}
		return tx.Commit()
	}
	r.Status = "processing"
	r.Submitted = true
	if err = restaurantSaveRefundTx(ctx, tx, &r, "dispatch_claimed"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_refunds SET submitted_at=now(),checked_at=now() WHERE id=$1`, id); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	remote, postErr := adapter.CreateRefund(ctx, a.Config, a, o, r, refunded)
	saveCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var preflight restaurantRefundPreflightError
	if errors.As(postErr, &preflight) {
		return p.refundPreflightFailed(saveCtx, number, id)
	}
	// Even an apparently successful POST only establishes the remote ID; an
	// independent authenticated status query confirms money movement.
	if postErr != nil || !restaurantPaymentID.MatchString(remote.ID) {
		return p.applyRefund(saveCtx, number, id, restaurantRefundRemote{Status: "review"}, false)
	}
	if err = p.applyRefund(saveCtx, number, id, restaurantRefundRemote{ID: remote.ID, Status: "processing"}, false); err != nil {
		return err
	}
	_, err = p.refreshRefund(ctx, number, id, false)
	return err
}

func (p *restaurantPayments) refundPreflightFailed(ctx context.Context, number, id string) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number)); err != nil {
		return err
	}
	r, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return err
	}
	if r.Status != "processing" || r.ProviderReference != "" {
		return restaurantFail(409, "invalid_status")
	}
	r.Status = "review"
	r.Submitted = false
	r.Authorized = false
	r.ResolutionReason = "refund_preflight_required"
	if err = restaurantSaveRefundTx(ctx, tx, &r, "preflight_failed_no_dispatch"); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_refunds SET submitted_at=NULL WHERE id=$1`, id); err != nil {
		return err
	}
	return tx.Commit()
}
func (p *restaurantPayments) applyRefund(ctx context.Context, number, id string, remote restaurantRefundRemote, verified bool) error {
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number))
	if err != nil {
		return err
	}
	o := stored.order
	r, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 AND order_number=$2 FOR UPDATE`, id, number))
	if err != nil {
		return err
	}
	if r.Status == "succeeded" || r.Status == "manual_reported" {
		return nil
	}
	if r.ProviderReference != "" && remote.ID != "" && r.ProviderReference != remote.ID {
		return restaurantFail(409, "invalid_status")
	}
	if remote.ID != "" {
		r.ProviderReference = remote.ID
	}
	status := remote.Status
	if status != "processing" && status != "succeeded" && status != "failed" {
		status = "review"
	}
	if !verified && (status == "succeeded" || status == "failed") {
		status = "review"
	}
	r.Status = status
	if status == "succeeded" {
		r.Confirmation = "provider"
	}
	if err = restaurantSaveRefundTx(ctx, tx, &r, "provider_"+status); err != nil {
		return err
	}
	_, refunded, _, err := restaurantRefundTotals(ctx, tx, number)
	if err != nil {
		return err
	}
	if refunded == o.TotalMinor {
		o.Payment.Status = "refunded"
		if _, err = tx.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET status='refunded',updated_at=now() WHERE order_number=$1`, number); err != nil {
			return err
		}
	}
	if err = restaurantPaymentWriteOrder(ctx, tx, &o, o.Payment.Status); err != nil {
		return err
	}
	return tx.Commit()
}
func (p *restaurantPayments) RefreshRefund(ctx context.Context, number, id string) (restaurantRefund, error) {
	return p.refreshRefund(ctx, number, id, true)
}

// Recover an ambiguous dispatch without sending money again. The administrator
// supplies an already-existing provider refund ID, NOT proof of settlement.
// Identity/amount/mode/request bindings are verified by the adapter first. The
// unique provider-reference index prevents counting the same refund twice.
func (p *restaurantPayments) ConfirmRefundReference(ctx context.Context, number, id string, in restaurantRefundResolution) (restaurantRefund, error) {
	in.Reference = strings.TrimSpace(in.Reference)
	in.Reason = strings.TrimSpace(in.Reason)
	if !restaurantPaymentID.MatchString(in.Reference) || len(in.Reason) < 3 || len(in.Reason) > 1000 {
		return restaurantRefund{}, restaurantFail(400, "invalid_request")
	}
	r, err := restaurantReadRefund(p.db.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 AND order_number=$2`, id, number))
	if err != nil {
		return r, err
	}
	if r.ProviderReference == in.Reference {
		return p.RefreshRefund(ctx, number, id)
	}
	if r.Version != in.Version {
		return r, restaurantFail(409, "conflict")
	}
	if r.Status != "review" || !r.Submitted || r.ProviderReference != "" {
		return r, restaurantFail(409, "invalid_status")
	}
	a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE order_number=$1`, number))
	if err != nil {
		return r, err
	}
	stored, err := restaurantReadStored(p.db.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, number))
	if err != nil {
		return r, err
	}
	adapter, ok := p.adapter.(restaurantRefundAdapter)
	if !ok {
		return r, restaurantFail(409, "payment_unavailable")
	}
	candidate := r
	candidate.ProviderReference = in.Reference
	remote, err := adapter.FetchRefund(ctx, a.Config, a, stored.order, candidate)
	if err != nil {
		return r, err
	}
	if remote.ID != in.Reference || remote.Status != "succeeded" && remote.Status != "processing" && remote.Status != "failed" {
		return r, restaurantFail(409, "invalid_status")
	}
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return r, err
	}
	defer tx.Rollback()
	if _, err = restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number)); err != nil {
		return r, err
	}
	r, err = restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 FOR UPDATE`, id))
	if err != nil {
		return r, err
	}
	if r.Version != in.Version || r.Status != "review" || !r.Submitted || r.ProviderReference != "" {
		return r, restaurantFail(409, "conflict")
	}
	var duplicate bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM restaurant_refunds WHERE order_number=$1 AND id<>$2 AND data->>'providerReference'=$3)`, number, id, in.Reference).Scan(&duplicate); err != nil {
		return r, err
	}
	if duplicate {
		return r, restaurantFail(409, "invalid_status")
	}
	r.ProviderReference = in.Reference
	r.ResolutionReason = in.Reason
	r.Status = "processing"
	if err = restaurantSaveRefundTx(ctx, tx, &r, "provider_reference_verified"); err != nil {
		return r, err
	}
	if err = tx.Commit(); err != nil {
		return r, err
	}
	if err = p.applyRefund(ctx, number, id, remote, true); err != nil {
		return r, err
	}
	return restaurantReadRefund(p.db.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1`, id))
}
func (p *restaurantPayments) refreshRefund(ctx context.Context, number, id string, rateLimit bool) (restaurantRefund, error) {
	r, err := restaurantReadRefund(p.db.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 AND order_number=$2`, id, number))
	if err != nil {
		return r, err
	}
	if r.ProviderReference == "" || r.Status == "succeeded" || r.Status == "manual_reported" || r.Status == "failed" {
		return r, nil
	}
	if rateLimit {
		result, e := p.db.ExecContext(ctx, `UPDATE restaurant_refunds SET checked_at=now() WHERE id=$1 AND (checked_at IS NULL OR checked_at<now()-interval '30 seconds')`, id)
		if e != nil {
			return r, e
		}
		n, _ := result.RowsAffected()
		if n == 0 {
			return r, nil
		}
	}
	a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE order_number=$1`, number))
	if err != nil {
		return r, err
	}
	stored, err := restaurantReadStored(p.db.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, number))
	if err != nil {
		return r, err
	}
	adapter, ok := p.adapter.(restaurantRefundAdapter)
	if !ok {
		return r, restaurantFail(409, "payment_unavailable")
	}
	remote, err := adapter.FetchRefund(ctx, a.Config, a, stored.order, r)
	if err != nil {
		return r, err
	}
	if remote.ID != r.ProviderReference {
		remote.Status = "review"
		remote.ID = r.ProviderReference
	}
	if err = p.applyRefund(ctx, number, id, remote, true); err != nil {
		return r, err
	}
	return restaurantReadRefund(p.db.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1`, id))
}
func (p *restaurantPayments) ReconcileRefunds(ctx context.Context) error {
	// Crash after dispatch claim is ambiguous, never automatically retry POST.
	rows, err := p.db.QueryContext(ctx, `SELECT data FROM restaurant_refunds WHERE ((status='requested' AND authorized) OR (status='processing' AND submitted_at IS NOT NULL) OR (status='review' AND COALESCE(data->>'providerReference','')<>'')) AND (checked_at IS NULL OR checked_at<now()-interval '30 seconds') ORDER BY checked_at NULLS FIRST,updated_at LIMIT 10`)
	if err != nil {
		return err
	}
	var list []restaurantRefund
	for rows.Next() {
		r, e := restaurantReadRefund(rows)
		if e != nil {
			rows.Close()
			return e
		}
		list = append(list, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, r := range list {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		if r.Status == "requested" {
			_ = p.processRefund(ctx, r.ID)
		} else if r.ProviderReference != "" {
			_, _ = p.RefreshRefund(ctx, r.Number, r.ID)
		} else if r.Status == "processing" && time.Since(r.UpdatedAt) > time.Minute {
			_ = p.applyRefund(ctx, r.Number, r.ID, restaurantRefundRemote{Status: "review"}, false)
		}
	}
	return nil
}
