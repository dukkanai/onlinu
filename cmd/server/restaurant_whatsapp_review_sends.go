package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

// A claim authorizes no network operation by itself. The future transport must
// recheck egress authority at handoff. Only the first successful claim contains
// text; every replay (including a crash before send) is reconciliation-only.
type restaurantWhatsappReviewSend struct {
	AttemptID, BodyHash, Locale, State, ProviderMessageID string
	Text                                                  string
	Acquired                                              bool
}

type restaurantWhatsappSendContext struct {
	tx                  *sql.Tx
	enabled             bool
	channelVersion      int64
	active              string
	review              restaurantWhatsappReview
	event               string
	checkout, quoteJSON []byte
}

// Lock order is shared with Dispatch: channel, authority, conversation, review.
// No callback may obtain another database connection while these locks are held.
func (s *restaurantWhatsappReviews) reviewSendTx(ctx context.Context, scope restaurantWhatsappScope, id string, now time.Time) (restaurantWhatsappSendContext, error) {
	var c restaurantWhatsappSendContext
	if s == nil || s.orders == nil || s.authorizeDispatch == nil {
		return c, restaurantFail(409, "channel_ordering_unavailable")
	}
	if !restaurantWhatsappValidScope(scope) || !restaurantWhatsappOpaque(id) || now.IsZero() {
		return c, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	tx, err := s.orders.store.db.BeginTx(ctx, nil)
	if err != nil {
		return c, err
	}
	c.tx = tx
	fail := func(e error) (restaurantWhatsappSendContext, error) {
		tx.Rollback()
		if e == sql.ErrNoRows {
			e = restaurantFail(404, "not_found")
		}
		return restaurantWhatsappSendContext{}, e
	}
	if err = tx.QueryRowContext(ctx, `SELECT new_orders_enabled,version FROM restaurant_order_channels WHERE channel=$1 FOR SHARE`, scope.Channel).Scan(&c.enabled, &c.channelVersion); err != nil {
		return fail(err)
	}
	if !s.authorizeDispatch(ctx, tx, scope) {
		return fail(restaurantFail(403, "whatsapp_scope_mismatch"))
	}
	var headVersion int64
	if err = tx.QueryRowContext(ctx, `SELECT version,review_id FROM restaurant_whatsapp_review_heads WHERE scope_hash=$1 FOR UPDATE`, restaurantWhatsappDigest(scope)).Scan(&headVersion, &c.active); err != nil {
		return fail(err)
	}
	r := &c.review
	err = tx.QueryRowContext(ctx, `SELECT id,version,fingerprint,state,expires_at,presented_message_id,proposal_event,checkout,quote FROM restaurant_whatsapp_reviews WHERE id=$1 AND scope_hash=$2 FOR UPDATE`, id, restaurantWhatsappDigest(scope)).Scan(&r.ID, &r.Version, &r.Fingerprint, &r.State, &r.ExpiresAt, &r.PresentedMessageID, &c.event, &c.checkout, &c.quoteJSON)
	if err != nil {
		return fail(err)
	}
	if headVersion != r.Version {
		c.active = ""
	}
	return c, nil
}

// There is deliberately no lease expiry, automatic retry or "reset unknown".
// A committed claim can have reached the provider even if the caller disappeared.
func (s *restaurantWhatsappReviews) ClaimReviewSend(ctx context.Context, scope restaurantWhatsappScope, id, locale string, now time.Time) (restaurantWhatsappReviewSend, error) {
	var result restaurantWhatsappReviewSend
	if locale != "ar" && locale != "en" {
		return result, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	c, err := s.reviewSendTx(ctx, scope, id, now)
	if err != nil {
		return result, err
	}
	tx, review := c.tx, c.review
	defer tx.Rollback()
	var fingerprint string
	err = tx.QueryRowContext(ctx, `SELECT attempt_id,body_hash,locale,state,provider_message_id,fingerprint FROM restaurant_whatsapp_review_sends WHERE review_id=$1 AND scope_hash=$2`, id, restaurantWhatsappDigest(scope)).Scan(&result.AttemptID, &result.BodyHash, &result.Locale, &result.State, &result.ProviderMessageID, &fingerprint)
	if err == nil {
		if result.Locale != locale || fingerprint != review.Fingerprint {
			return restaurantWhatsappReviewSend{}, restaurantFail(409, "whatsapp_review_changed")
		}
		// Historical status only, even after expiry, supersession or closure.
		return result, tx.Commit()
	}
	if err != sql.ErrNoRows {
		return result, err
	}
	if !c.enabled {
		return result, restaurantFail(409, "channel_ordering_disabled")
	}
	if c.active != id || review.PresentedMessageID != "" {
		return result, restaurantFail(409, "whatsapp_review_changed")
	}
	var input restaurantOrderInput
	var quote restaurantQuote
	if json.Unmarshal(c.checkout, &input) != nil || json.Unmarshal(c.quoteJSON, &quote) != nil {
		return result, restaurantFail(409, "whatsapp_review_changed")
	}
	rendered, err := restaurantRenderWhatsappReview(scope, c.event, review, input, quote, locale, now)
	if err != nil {
		return result, err
	}
	result = restaurantWhatsappReviewSend{AttemptID: uuid.NewString(), BodyHash: rendered.digest, Locale: locale, State: "unknown", Text: rendered.text, Acquired: true}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_whatsapp_review_sends(review_id,scope_hash,attempt_id,fingerprint,body_hash,locale,channel_version,started_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'unknown')`, id, restaurantWhatsappDigest(scope), result.AttemptID, review.Fingerprint, result.BodyHash, locale, c.channelVersion, now.UTC())
	if err != nil {
		return restaurantWhatsappReviewSend{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantWhatsappReviewSend{}, err
	}
	return result, nil
}

// Trusted adapter evidence only; not an endpoint and never a customer assertion.
// Accepted means provider acceptance, NOT delivery/read. Network errors leave
// the existing unknown record unchanged; only positive evidence resolves it.
// Rejected attempts are terminal too, so no future worker can blindly replay.
func (s *restaurantWhatsappReviews) RecordReviewSend(ctx context.Context, scope restaurantWhatsappScope, id, attempt, bodyHash, state, providerMessageID, evidenceHash string, now time.Time) (restaurantWhatsappReviewSend, error) {
	var result restaurantWhatsappReviewSend
	if !restaurantWhatsappOpaque(attempt) || !restaurantQuoteHashPattern.MatchString(bodyHash) || !restaurantQuoteHashPattern.MatchString(evidenceHash) ||
		(state != "accepted" && state != "rejected") || (state == "accepted" && !restaurantWhatsappOpaque(providerMessageID)) || (state == "rejected" && providerMessageID != "") {
		return result, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	c, err := s.reviewSendTx(ctx, scope, id, now)
	if err != nil {
		return result, err
	}
	tx, review := c.tx, c.review
	defer tx.Rollback()
	var fingerprint, savedEvidence string
	var savedVersion int64
	var started time.Time
	err = tx.QueryRowContext(ctx, `SELECT attempt_id,body_hash,locale,state,provider_message_id,fingerprint,evidence_hash,channel_version,started_at FROM restaurant_whatsapp_review_sends WHERE review_id=$1 AND scope_hash=$2 FOR UPDATE`, id, restaurantWhatsappDigest(scope)).Scan(&result.AttemptID, &result.BodyHash, &result.Locale, &result.State, &result.ProviderMessageID, &fingerprint, &savedEvidence, &savedVersion, &started)
	if err == sql.ErrNoRows {
		return result, restaurantFail(404, "not_found")
	}
	if err != nil {
		return result, err
	}
	if result.AttemptID != attempt || result.BodyHash != bodyHash || fingerprint != review.Fingerprint || now.Before(started) {
		return restaurantWhatsappReviewSend{}, restaurantFail(409, "whatsapp_review_changed")
	}
	if result.State != "unknown" {
		if result.State != state || result.ProviderMessageID != providerMessageID || savedEvidence != evidenceHash {
			return restaurantWhatsappReviewSend{}, restaurantFail(409, "whatsapp_review_changed")
		}
		return result, tx.Commit()
	}
	// Record late evidence without reviving a stale review or disabled policy.
	if state == "accepted" && c.enabled && c.channelVersion == savedVersion && c.active == id && review.State == "pending" && now.Before(review.ExpiresAt) {
		if review.PresentedMessageID != "" && review.PresentedMessageID != providerMessageID {
			return result, restaurantFail(409, "whatsapp_review_changed")
		}
		if _, err = tx.ExecContext(ctx, `UPDATE restaurant_whatsapp_reviews SET presented_message_id=$2 WHERE id=$1`, id, providerMessageID); err != nil {
			return result, err
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_whatsapp_review_sends SET state=$2,provider_message_id=$3,evidence_hash=$4,resolved_at=$5 WHERE review_id=$1`, id, state, providerMessageID, evidenceHash, now.UTC()); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" {
			return restaurantWhatsappReviewSend{}, restaurantFail(409, "whatsapp_review_changed")
		}
		return result, err
	}
	result.State, result.ProviderMessageID = state, providerMessageID
	return result, tx.Commit()
}
