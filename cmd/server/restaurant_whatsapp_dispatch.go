package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

type restaurantWhatsappSubmissionKey struct{}
type restaurantWhatsappSubmission struct{ Key, Hash, Owner string }
type restaurantWhatsappPermitKey struct{}
type restaurantWhatsappPermit struct {
	reviewID    string
	scope       restaurantWhatsappScope
	fingerprint string
	authorize   func(context.Context, *sql.Tx, restaurantWhatsappScope) bool
	now         func() time.Time
}

// Runs inside the original order/stock transaction and only after accepted-order
// recovery. New orders require the current confirmed review, immutable dispatch
// key/input and current channel policy; an expired retry can only recover a
// previously committed order, never create an unseen one.
func restaurantRequireWhatsappDispatch(ctx context.Context, tx *sql.Tx, channel string, channelVersion int64) error {
	permit, ok := ctx.Value(restaurantWhatsappPermitKey{}).(*restaurantWhatsappPermit)
	submission, actual := ctx.Value(restaurantWhatsappSubmissionKey{}).(restaurantWhatsappSubmission)
	if !ok || permit == nil || !actual || permit.authorize == nil || permit.now == nil || permit.scope.Channel != channel {
		return restaurantFail(409, "channel_ordering_unavailable")
	}
	if !permit.authorize(ctx, tx, permit.scope) {
		return restaurantFail(403, "whatsapp_scope_mismatch")
	}
	var key, inputHash, fingerprint, state, active, orderNumber string
	var version, headVersion, claimChannelVersion int64
	var expires time.Time
	err := tx.QueryRowContext(ctx, `SELECT d.dispatch_key,d.input_hash,r.fingerprint,r.state,r.expires_at,h.review_id,r.version,h.version,d.order_number,d.channel_version
 FROM restaurant_whatsapp_dispatches d JOIN restaurant_whatsapp_reviews r ON r.id=d.review_id
 JOIN restaurant_whatsapp_review_heads h ON h.scope_hash=r.scope_hash
 WHERE d.review_id=$1 AND d.scope_hash=$2 AND r.scope_hash=$2 AND d.fingerprint=r.fingerprint
 FOR SHARE OF d,r,h`, permit.reviewID, restaurantWhatsappDigest(permit.scope)).Scan(&key, &inputHash, &fingerprint, &state, &expires, &active, &version, &headVersion, &orderNumber, &claimChannelVersion)
	if err == sql.ErrNoRows {
		return restaurantFail(409, "whatsapp_review_changed")
	}
	if err != nil {
		return err
	}
	if submission.Owner != "whatsapp:"+restaurantWhatsappDigest(permit.scope) || key != submission.Key || inputHash != submission.Hash || fingerprint != permit.fingerprint || state != "confirmed" ||
		claimChannelVersion != channelVersion || active != permit.reviewID || version != headVersion || orderNumber != "" || permit.now().IsZero() || !permit.now().Before(expires) {
		return restaurantFail(409, "whatsapp_review_changed")
	}
	return nil
}

// No public endpoint or transport calls this method. authorizeDispatch is nil
// until explicitly wired by a future trusted adapter. It must not be replaced by
// a customer boolean or by merely knowing an account/session ID.
func (s *restaurantWhatsappReviews) Dispatch(ctx context.Context, scope restaurantWhatsappScope, id string) (restaurantReceipt, error) {
	empty := restaurantReceipt{}
	if s == nil || s.orders == nil || s.authorizeDispatch == nil {
		return empty, restaurantFail(409, "channel_ordering_unavailable")
	}
	if !restaurantWhatsappValidScope(scope) || !restaurantWhatsappOpaque(id) {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	now := s.dispatchNow
	if now == nil {
		now = time.Now
	}
	if now().IsZero() {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	scopeHash := restaurantWhatsappDigest(scope)
	tx, err := s.orders.store.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	// Keep lock order aligned with the original core: channel, current
	// transport authority, then conversation head and review.
	var channelEnabled bool
	var channelVersion int64
	if err = tx.QueryRowContext(ctx, `SELECT new_orders_enabled,version FROM restaurant_order_channels WHERE channel=$1 FOR SHARE`, scope.Channel).Scan(&channelEnabled, &channelVersion); err != nil {
		return empty, err
	}
	if !s.authorizeDispatch(ctx, tx, scope) {
		return empty, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	var active string
	var headVersion int64
	err = tx.QueryRowContext(ctx, `SELECT version,review_id FROM restaurant_whatsapp_review_heads WHERE scope_hash=$1 FOR UPDATE`, scopeHash).Scan(&headVersion, &active)
	if err == sql.ErrNoRows {
		return empty, restaurantFail(404, "not_found")
	}
	if err != nil {
		return empty, err
	}
	var version int64
	var fingerprint, proposalEvent, state string
	var expires time.Time
	var checkout, quoteJSON []byte
	err = tx.QueryRowContext(ctx, `SELECT version,fingerprint,proposal_event,state,expires_at,checkout,quote FROM restaurant_whatsapp_reviews WHERE id=$1 AND scope_hash=$2 FOR UPDATE`, id, scopeHash).Scan(&version, &fingerprint, &proposalEvent, &state, &expires, &checkout, &quoteJSON)
	if err == sql.ErrNoRows {
		return empty, restaurantFail(404, "not_found")
	}
	if err != nil {
		return empty, err
	}
	var input restaurantOrderInput
	var quote restaurantQuote
	if json.Unmarshal(checkout, &input) != nil || json.Unmarshal(quoteJSON, &quote) != nil {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	quoteHash, err := restaurantQuoteBinding(quote)
	if err != nil {
		return empty, err
	}
	expected := restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, id, version, proposalEvent, input, input.ExpectedQuoteHash, expires.UTC().Format(time.RFC3339Nano)})
	if expected != fingerprint || quoteHash != input.ExpectedQuoteHash || quote.TotalMinor != input.ExpectedTotalMinor || state != "confirmed" {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	input = restaurantNormalizeOrderInput(input)
	inputHash := restaurantWhatsappDigest(input)
	var key, savedHash, savedFingerprint string
	err = tx.QueryRowContext(ctx, `SELECT dispatch_key,input_hash,fingerprint FROM restaurant_whatsapp_dispatches WHERE review_id=$1 AND scope_hash=$2`, id, scopeHash).Scan(&key, &savedHash, &savedFingerprint)
	if err == sql.ErrNoRows {
		if !channelEnabled {
			return empty, restaurantFail(409, "channel_ordering_disabled")
		}
		if active != id || headVersion != version || !now().Before(expires) {
			return empty, restaurantFail(409, "whatsapp_review_changed")
		}
		key = uuid.NewString()
		_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_whatsapp_dispatches(review_id,scope_hash,dispatch_key,input_hash,fingerprint,channel_version,created_at) VALUES($1,$2,$3,$4,$5,$6,$7)`, id, scopeHash, key, inputHash, fingerprint, channelVersion, now().UTC())
		if err != nil {
			return empty, err
		}
	} else if err != nil {
		return empty, err
	} else if savedHash != inputHash || savedFingerprint != fingerprint {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	if err = tx.Commit(); err != nil {
		return empty, err
	}
	permit := &restaurantWhatsappPermit{reviewID: id, scope: scope, fingerprint: fingerprint, authorize: s.authorizeDispatch, now: now}
	createCtx := context.WithValue(ctx, restaurantOrderChannelKey{}, scope.Channel)
	createCtx = context.WithValue(createCtx, restaurantWhatsappPermitKey{}, permit)
	create := s.dispatchCreate
	if create == nil {
		create = s.orders.Create
	}
	receipt, err := create(createCtx, input, "whatsapp:"+scopeHash, key)
	if err != nil {
		return empty, err
	} // Claim remains durable; never replace its key.
	result, err := s.orders.store.db.ExecContext(ctx, `UPDATE restaurant_whatsapp_dispatches SET order_number=$3 WHERE review_id=$1 AND dispatch_key=$2 AND (order_number='' OR order_number=$3)`, id, key, receipt.Order.Number)
	if err != nil {
		return empty, err
	} // Original core receipt still permits recovery.
	rows, err := result.RowsAffected()
	if err != nil {
		return empty, err
	}
	if rows != 1 {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	return receipt, nil
}
