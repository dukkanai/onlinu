package main

// Stripe events authenticate refresh hints, never payment state. The durable
// inbox deliberately keeps unresolved work until it can be bound to an identity
// already learned from Checkout creation or authoritative session retrieval.
import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"errors"
	"math/big"
	"regexp"
	"strings"
	"time"

	"github.com/google/uuid"
)

const restaurantStripeReceiptLimit = 100000
const restaurantStripePendingReceiptLimit = 1024

func restaurantInitStripeWebhookSchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
 ALTER TABLE restaurant_payment_attempts ADD COLUMN IF NOT EXISTS stripe_integration_identifier text NOT NULL DEFAULT '';
 ALTER TABLE restaurant_payment_attempts ADD COLUMN IF NOT EXISTS stripe_intent_id text NOT NULL DEFAULT '';
 ALTER TABLE restaurant_payment_attempts ADD COLUMN IF NOT EXISTS stripe_charge_id text NOT NULL DEFAULT '';
 CREATE INDEX IF NOT EXISTS restaurant_stripe_session_idx ON restaurant_payment_attempts(remote_id) WHERE provider='stripe';
 CREATE INDEX IF NOT EXISTS restaurant_stripe_intent_idx ON restaurant_payment_attempts(stripe_intent_id) WHERE provider='stripe';
 CREATE INDEX IF NOT EXISTS restaurant_stripe_charge_idx ON restaurant_payment_attempts(stripe_charge_id) WHERE provider='stripe';
 CREATE TABLE IF NOT EXISTS restaurant_stripe_webhook_receipts (
  generation text NOT NULL CHECK(length(generation)=36),
  event_id text NOT NULL CHECK(length(event_id)<=200),
  account_id text NOT NULL CHECK(length(account_id)<=200),
  event_type text NOT NULL CHECK(length(event_type)<=200),
  object_id text NOT NULL CHECK(length(object_id)<=200),
  attempt_hint text NOT NULL DEFAULT '' CHECK(length(attempt_hint)<=36),
  body_hash bytea NOT NULL CHECK(octet_length(body_hash)=32),
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','enqueued','rejected')),
  attempt_id text REFERENCES restaurant_payment_attempts(id),
  received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  next_lookup_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lookup_count integer NOT NULL DEFAULT 0 CHECK(lookup_count>=0),
  PRIMARY KEY(generation,event_id)
 );
 CREATE INDEX IF NOT EXISTS restaurant_stripe_receipt_pending_idx ON restaurant_stripe_webhook_receipts(next_lookup_at,received_at) WHERE state='pending';`)
	return err
}

var restaurantStripeIntegrationIdentifier = regexp.MustCompile(`^onlinu_sandbox_[a-z]{8}$`)

// Persist once with the attempt. Never regenerate this field when rebuilding an
// idempotent request; legacy attempts are not retried or silently backfilled.
func restaurantStripeNewIntegrationIdentifier() (string, error) {
	suffix := make([]byte, 8)
	for i := range suffix {
		n, err := rand.Int(rand.Reader, big.NewInt(26))
		if err != nil {
			return "", err
		}
		suffix[i] = byte('a' + n.Int64())
	}
	return "onlinu_sandbox_" + string(suffix), nil
}

var restaurantStripeObjectSuffix = regexp.MustCompile(`^[A-Za-z0-9_]+$`)

func restaurantStripeObjectIDValid(kind, id string) bool {
	prefix := map[string]string{"checkout.session": "cs_test_", "payment_intent": "pi_", "charge": "ch_"}[kind]
	return prefix != "" && len(id) <= 200 && strings.HasPrefix(id, prefix) && restaurantStripeObjectSuffix.MatchString(strings.TrimPrefix(id, prefix))
}

// Only this closed event set has routing semantics. Unsubscribed event types
// are acknowledged after authentication but cannot create receipts or work.
func restaurantStripeEventRoute(kind string) (object, field string) {
	switch kind {
	case "checkout.session.completed", "checkout.session.async_payment_succeeded", "checkout.session.async_payment_failed", "checkout.session.expired":
		return "checkout.session", "remote_id"
	case "payment_intent.succeeded":
		return "payment_intent", "stripe_intent_id"
	case "charge.refunded", "charge.updated":
		return "charge", "stripe_charge_id"
	}
	return "", ""
}

func (p *restaurantPayments) receiveStripeWebhook(ctx context.Context, raw []byte, signature string, now time.Time) error {
	ctx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	c, err := p.config(ctx, "stripe")
	if err != nil {
		return err
	}
	// Disabling new checkout does not discard authenticated notifications for
	// existing attempts. The immutable endpoint configuration remains required.
	if restaurantStripeSandboxReady(c) != nil {
		return restaurantFail(503, "payment_unavailable")
	}
	event, err := restaurantStripeVerifySandboxEvent(raw, signature, c.Secrets["webhookSecret"], now)
	if err != nil {
		return err
	}
	if event.APIVersion != restaurantStripeAPIVersion {
		return restaurantFail(400, "invalid_request")
	}
	object, _ := restaurantStripeEventRoute(event.Type)
	if object == "" {
		return nil
	}
	if event.Object != object || !event.ObjectTest || !restaurantStripeObjectIDValid(object, event.ObjectID) {
		return restaurantFail(400, "invalid_request")
	}
	if event.AttemptID != "" {
		id, err := uuid.Parse(event.AttemptID)
		if err != nil || id.String() != event.AttemptID {
			return restaurantFail(400, "invalid_request")
		}
	}
	hash := sha256.Sum256(raw)
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	// Serialize the bounded admission check per immutable endpoint generation.
	// Duplicates remain acceptable at capacity; new work receives a retryable 503.
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtext($1))`, "restaurant-stripe-inbox:"+c.Values["sandboxGeneration"]); err != nil {
		return err
	}
	var oldHash []byte
	err = tx.QueryRowContext(ctx, `SELECT body_hash FROM restaurant_stripe_webhook_receipts WHERE generation=$1 AND event_id=$2`, c.Values["sandboxGeneration"], event.ID).Scan(&oldHash)
	if err == nil {
		if !bytes.Equal(oldHash, hash[:]) {
			return restaurantFail(400, "invalid_request")
		}
		return tx.Commit()
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	var total, pending int
	if err = tx.QueryRowContext(ctx, `SELECT count(*),count(*) FILTER (WHERE state='pending') FROM restaurant_stripe_webhook_receipts WHERE generation=$1`, c.Values["sandboxGeneration"]).Scan(&total, &pending); err != nil {
		return err
	}
	if total >= restaurantStripeReceiptLimit || pending >= restaurantStripePendingReceiptLimit {
		return restaurantFail(503, "payment_unavailable")
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stripe_webhook_receipts(generation,event_id,account_id,event_type,object_id,attempt_hint,body_hash) VALUES($1,$2,$3,$4,$5,$6,$7)`, c.Values["sandboxGeneration"], event.ID, c.Values["accountID"], event.Type, event.ObjectID, event.AttemptID, hash[:]); err != nil {
		return err
	}
	if err = p.resolveStripeReceiptTx(ctx, tx, c.Values["sandboxGeneration"], c.Values["accountID"], event); err != nil {
		return err
	}
	return tx.Commit()
}

func (p *restaurantPayments) resolveStripeReceiptTx(ctx context.Context, tx *sql.Tx, generation, account string, event restaurantStripeSandboxEvent) error {
	_, field := restaurantStripeEventRoute(event.Type)
	if field == "" {
		return restaurantFail(400, "invalid_request")
	}
	// field comes exclusively from the closed switch above. Metadata is only a
	// conflict-detecting hint: even a signed hint cannot invent an object binding.
	rows, err := tx.QueryContext(ctx, restaurantPaymentAttemptSelect+` WHERE provider='stripe' AND (`+field+`=$1 OR ($2<>'' AND id=$2)) ORDER BY id LIMIT 3 FOR UPDATE`, event.ObjectID, event.AttemptID)
	if err != nil {
		return err
	}
	var candidates []restaurantPaymentAttempt
	for rows.Next() {
		a, e := p.readAttempt(rows)
		if e != nil {
			rows.Close()
			return e
		}
		candidates = append(candidates, a)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	state, attempt := "pending", ""
	if len(candidates) > 1 {
		state = "rejected"
	}
	if len(candidates) == 1 {
		a := candidates[0]
		if a.Mode != "test" || restaurantStripeSandboxReady(a.Config) != nil || a.Config.Values["sandboxGeneration"] != generation || a.Config.Values["accountID"] != account || event.AttemptID != "" && event.AttemptID != a.ID {
			state = "rejected"
		} else {
			var bound string
			if err = tx.QueryRowContext(ctx, `SELECT `+field+` FROM restaurant_payment_attempts WHERE id=$1`, a.ID).Scan(&bound); err != nil {
				return err
			}
			if bound != "" && bound != event.ObjectID {
				state = "rejected"
			}
			if bound == event.ObjectID && a.RemoteID != "" {
				stored, e := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, a.Number))
				if e != nil {
					return e
				}
				if !stored.order.Demo || stored.order.Currency != "SAR" {
					state = "rejected"
				} else {
					if _, err = tx.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET needs_refresh=true,refresh_version=refresh_version+1 WHERE id=$1`, a.ID); err != nil {
						return err
					}
					state, attempt = "enqueued", a.ID
				}
			}
		}
	}
	// Back off local-only unresolved lookup after its first hour. Never delete or
	// acknowledge-and-forget unresolved work; capacity rejects additional events.
	_, err = tx.ExecContext(ctx, `UPDATE restaurant_stripe_webhook_receipts SET state=$3,attempt_id=NULLIF($4,''),lookup_count=LEAST(lookup_count,2147483646)+1,next_lookup_at=clock_timestamp()+CASE WHEN received_at < now()-interval '1 hour' THEN interval '1 hour' ELSE interval '30 seconds' END WHERE generation=$1 AND event_id=$2`, generation, event.ID, state, attempt)
	return err
}

func (p *restaurantPayments) resolveStripeWebhookReceipts(ctx context.Context) error {
	// SKIP LOCKED avoids shared receipt ownership. Cross-batch attempt lock
	// contention can still abort a transaction; rollback preserves all pending
	// work for the next cycle. No provider call or order mutation occurs here.
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(ctx, `SELECT generation,account_id,event_id,event_type,object_id,attempt_hint FROM restaurant_stripe_webhook_receipts WHERE state='pending' AND next_lookup_at<=now() ORDER BY next_lookup_at,received_at LIMIT 32 FOR UPDATE SKIP LOCKED`)
	if err != nil {
		return err
	}
	type pending struct {
		generation, account string
		event               restaurantStripeSandboxEvent
	}
	var batch []pending
	for rows.Next() {
		var r pending
		if err = rows.Scan(&r.generation, &r.account, &r.event.ID, &r.event.Type, &r.event.ObjectID, &r.event.AttemptID); err != nil {
			rows.Close()
			return err
		}
		batch = append(batch, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, r := range batch {
		if err = p.resolveStripeReceiptTx(ctx, tx, r.generation, r.account, r.event); err != nil {
			return err
		}
	}
	return tx.Commit()
}
