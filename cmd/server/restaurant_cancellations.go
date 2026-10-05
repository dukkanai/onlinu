package main

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
)

type restaurantCancellation struct {
	ID                         string     `json:"id"`
	Status                     string     `json:"status"`
	Reason                     string     `json:"reason"`
	DecisionReason             string     `json:"decisionReason"`
	RequestedAt                time.Time  `json:"requestedAt"`
	DecidedAt                  *time.Time `json:"decidedAt,omitempty"`
	RequestedBeforePreparation bool       `json:"requestedBeforePreparation"`
}

type restaurantComplaint struct {
	ID          string     `json:"id"`
	Status      string     `json:"status"`
	Reason      string     `json:"reason"`
	Resolution  string     `json:"resolution"`
	RequestedAt time.Time  `json:"requestedAt"`
	ResolvedAt  *time.Time `json:"resolvedAt,omitempty"`
}

func restaurantInitCancellationSchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_order_support_requests (
	 order_number text NOT NULL REFERENCES restaurant_orders(number), request_id text NOT NULL,
	 kind text NOT NULL, reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
	 PRIMARY KEY(order_number,request_id));
 CREATE INDEX IF NOT EXISTS restaurant_order_support_pending_idx ON restaurant_orders(created_at,number) WHERE document->'cancellation'->>'status'='requested' OR document @> '{"complaints":[{"status":"open"}]}'::jsonb;`)
	return err
}

// The order can have a later cancellation request after a rejection, but an
// old browser retry must still be recognizable after that newer request.
func restaurantSupportRepeated(ctx context.Context, tx *sql.Tx, number, key, kind, reason string) (bool, error) {
	var oldKind, oldReason string
	err := tx.QueryRowContext(ctx, `SELECT kind,reason FROM restaurant_order_support_requests WHERE order_number=$1 AND request_id=$2`, number, key).Scan(&oldKind, &oldReason)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if oldKind != kind || oldReason != reason {
		return false, restaurantFail(409, "conflict")
	}
	return true, nil
}

func restaurantRememberSupportRequest(ctx context.Context, tx *sql.Tx, number, key, kind, reason string) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO restaurant_order_support_requests(order_number,request_id,kind,reason) VALUES($1,$2,$3,$4)`, number, key, kind, reason)
	return err
}

func restaurantValidateSupportRequest(reason, key string, version int64) error {
	parsed, err := uuid.Parse(key)
	if err != nil || len(key) != 36 || parsed.Version() != 4 || parsed.Variant() != uuid.RFC4122 || version < 1 || reason == "" || !restaurantOrderText(reason, 1000, true) {
		return restaurantFail(400, "invalid_request")
	}
	return nil
}

func (s *restaurantOrders) lockCustomerOrder(ctx context.Context, tx *sql.Tx, number, token, code, customerID string) (restaurantOrder, error) {
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) || err == nil && !restaurantCanAccess(stored, token, code, customerID) {
		return restaurantOrder{}, restaurantFail(404, "invalid_order_access")
	}
	return stored.order, err
}

// Preparation is the exact cut-off; acceptance is not preparation. The row
// lock serializes this request with kitchen actions and verified payment
// callbacks. A cancellation never invokes a payment gateway inside the txn.
func (s *restaurantOrders) RequestCancellation(ctx context.Context, number, token, code, customerID, reason, key string, version int64) (restaurantOrder, error) {
	reason = strings.TrimSpace(reason)
	if err := restaurantValidateSupportRequest(reason, key, version); err != nil {
		return restaurantOrder{}, err
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	o, err := s.lockCustomerOrder(ctx, tx, number, token, code, customerID)
	if err != nil {
		return restaurantOrder{}, err
	}
	if repeated, repeatErr := restaurantSupportRepeated(ctx, tx, o.Number, key, "cancellation", reason); repeatErr != nil {
		return restaurantOrder{}, repeatErr
	} else if repeated {
		return o, nil
	}
	if c := o.Cancellation; c != nil && c.ID == key {
		if c.Reason != reason {
			return restaurantOrder{}, restaurantFail(409, "conflict")
		}
		return o, nil
	}
	if o.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if o.Status == "cancelled" || o.Status == "completed" || o.Cancellation != nil && o.Cancellation.Status != "rejected" {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	// A request key must not silently change from complaint to cancellation.
	for _, complaint := range o.Complaints {
		if complaint.ID == key {
			return restaurantOrder{}, restaurantFail(409, "conflict")
		}
	}
	now := time.Now().UTC()
	c := &restaurantCancellation{ID: key, Status: "requested", Reason: reason, RequestedAt: now, RequestedBeforePreparation: !restaurantOrderWasPrepared(o)}
	o.Cancellation = c
	if c.RequestedBeforePreparation {
		c.Status = "approved"
		c.DecidedAt = &now
		c.DecisionReason = "before_preparation"
		if err = restaurantCancelOrderTx(ctx, tx, &o, "customer_before_preparation"); err != nil {
			return restaurantOrder{}, err
		}
	}
	o.Version++
	o.UpdatedAt = now
	if err = restaurantRememberSupportRequest(ctx, tx, o.Number, key, "cancellation", reason); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantUpdateOrder(ctx, tx, o); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, o, "cancellation_requested", c); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return o, nil
}

func restaurantCancelOrderTx(ctx context.Context, tx *sql.Tx, o *restaurantOrder, reason string) error {
	// Recover a real historical kitchen event for legacy orders, never invent
	// a preparation time from the latest unrelated update. Imported records
	// without that event still keep prepared stock as waste; the customer-facing
	// timestamp remains unknown.
	if restaurantOrderWasPrepared(*o) && o.PreparationStartedAt == nil {
		var at sql.NullTime
		if err := tx.QueryRowContext(ctx, `SELECT min(created_at) FROM restaurant_order_events WHERE order_number=$1 AND kind='status_changed' AND document->>'to'='preparing'`, o.Number).Scan(&at); err != nil {
			return err
		}
		if at.Valid {
			o.PreparationStartedAt = &at.Time
		} else {
			if err := restaurantTransitionOrderStock(ctx, tx, *o, "wasted"); err != nil {
				return err
			}
		}
	}
	o.Status = "cancelled"
	if err := restaurantEnsureCancellationRefundTx(ctx, tx, *o, reason); err != nil {
		return err
	}
	if o.Payment.Method == "card" && o.Payment.Status == "paid" {
		o.Payment.Status = "review"
	}
	return nil
}

func (s *restaurantOrders) DecideCancellation(ctx context.Context, number, reason string, approve bool, version int64) (restaurantOrder, error) {
	reason = strings.TrimSpace(reason)
	if version < 1 || reason == "" || !restaurantOrderText(reason, 1000, true) {
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
	o := stored.order
	if o.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if o.Cancellation == nil || o.Cancellation.Status != "requested" || o.Status == "completed" || o.Status == "cancelled" {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	now := time.Now().UTC()
	c := o.Cancellation
	c.DecisionReason = reason
	c.DecidedAt = &now
	c.Status = "rejected"
	if approve {
		c.Status = "approved"
		if err = restaurantCancelOrderTx(ctx, tx, &o, reason); err != nil {
			return restaurantOrder{}, err
		}
	}
	o.Version++
	o.UpdatedAt = now
	if err = restaurantUpdateOrder(ctx, tx, o); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, o, "cancellation_decided", c); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return o, nil
}

func (s *restaurantOrders) ReportComplaint(ctx context.Context, number, token, code, customerID, reason, key string, version int64) (restaurantOrder, error) {
	reason = strings.TrimSpace(reason)
	if err := restaurantValidateSupportRequest(reason, key, version); err != nil {
		return restaurantOrder{}, err
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	o, err := s.lockCustomerOrder(ctx, tx, number, token, code, customerID)
	if err != nil {
		return restaurantOrder{}, err
	}
	if repeated, repeatErr := restaurantSupportRepeated(ctx, tx, o.Number, key, "complaint", reason); repeatErr != nil {
		return restaurantOrder{}, repeatErr
	} else if repeated {
		return o, nil
	}
	for _, complaint := range o.Complaints {
		if complaint.ID == key {
			if complaint.Reason != reason {
				return restaurantOrder{}, restaurantFail(409, "conflict")
			}
			return o, nil
		}
	}
	if o.Cancellation != nil && o.Cancellation.ID == key {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if o.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if len(o.Complaints) >= 10 {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	now := time.Now().UTC()
	complaint := restaurantComplaint{ID: key, Status: "open", Reason: reason, RequestedAt: now}
	o.Complaints = append(o.Complaints, complaint)
	o.Version++
	o.UpdatedAt = now
	if err = restaurantRememberSupportRequest(ctx, tx, o.Number, key, "complaint", reason); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantUpdateOrder(ctx, tx, o); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, o, "complaint_opened", complaint); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return o, nil
}

func (s *restaurantOrders) ResolveComplaint(ctx context.Context, number, id, reason string, version int64) (restaurantOrder, error) {
	reason = strings.TrimSpace(reason)
	if version < 1 || reason == "" || !restaurantOrderText(reason, 1000, true) {
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
	o := stored.order
	if o.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	i := -1
	for index, c := range o.Complaints {
		if c.ID == id {
			i = index
			break
		}
	}
	if i < 0 {
		return restaurantOrder{}, restaurantFail(404, "not_found")
	}
	if o.Complaints[i].Status != "open" {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	now := time.Now().UTC()
	o.Complaints[i].Status = "resolved"
	o.Complaints[i].Resolution = reason
	o.Complaints[i].ResolvedAt = &now
	o.Version++
	o.UpdatedAt = now
	if err = restaurantUpdateOrder(ctx, tx, o); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, o, "complaint_resolved", o.Complaints[i]); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return o, nil
}
