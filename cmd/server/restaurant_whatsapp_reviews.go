package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"

	"github.com/google/uuid"
)

// Private preparation only: no startup hook, provider transport or order dispatch.
// Confirmation records customer intent; it is never an accepted order receipt.
type restaurantWhatsappReviews struct {
	orders *restaurantOrders
	// Unwired by default. A future trusted transport must check and lock its
	// current binding/entitlement using this same transaction, never a new pool.
	authorizeDispatch func(context.Context, *sql.Tx, restaurantWhatsappScope) bool
	dispatchNow       func() time.Time
	// Private fixture seam for lost-result tests; nil uses the original core.
	dispatchCreate func(context.Context, restaurantOrderInput, string, string) (restaurantReceipt, error)
}
type restaurantWhatsappReview struct {
	ID                 string
	Version            int64
	Fingerprint        string
	State              string
	ExpiresAt          time.Time
	PresentedMessageID string
	Duplicate          bool
}

func newRestaurantWhatsappReviews(ctx context.Context, orders *restaurantOrders) (*restaurantWhatsappReviews, error) {
	if orders == nil || orders.store == nil {
		return nil, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	_, err := orders.store.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_whatsapp_review_heads (
 scope_hash TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>=0 AND version<=9007199254740991), review_id TEXT NOT NULL DEFAULT ''
 );
 CREATE TABLE IF NOT EXISTS restaurant_whatsapp_reviews (
 id TEXT PRIMARY KEY, scope_hash TEXT NOT NULL REFERENCES restaurant_whatsapp_review_heads(scope_hash),
 version BIGINT NOT NULL CHECK(version>0 AND version<=9007199254740991),
 fingerprint TEXT NOT NULL, proposal_event TEXT NOT NULL, checkout JSONB NOT NULL, quote JSONB NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL, created_at TIMESTAMPTZ NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','confirmed','cancelled')),
 presented_message_id TEXT NOT NULL DEFAULT '', decision_event TEXT NOT NULL DEFAULT '', decision_hash TEXT NOT NULL DEFAULT '',
 UNIQUE(scope_hash,version)
 );
 CREATE TABLE IF NOT EXISTS restaurant_whatsapp_dispatches (
 review_id TEXT PRIMARY KEY REFERENCES restaurant_whatsapp_reviews(id),
 scope_hash TEXT NOT NULL, dispatch_key TEXT NOT NULL UNIQUE,
 input_hash TEXT NOT NULL, fingerprint TEXT NOT NULL, channel_version BIGINT NOT NULL,
 order_number TEXT NOT NULL DEFAULT '', created_at TIMESTAMPTZ NOT NULL
 )`)
	if err != nil {
		return nil, err
	}
	return &restaurantWhatsappReviews{orders: orders}, nil
}

// Prepare freezes complete checkout details and a fresh authoritative quote.
// New drafts use expectedVersion=0; later preparations must name the current
// conversation version. Every new preparation supersedes the previous review.
func (s *restaurantWhatsappReviews) Prepare(ctx context.Context, p *restaurantWhatsappProposal, scope restaurantWhatsappScope, input restaurantOrderInput, expectedVersion int64, now time.Time) (restaurantWhatsappReview, error) {
	empty := restaurantWhatsappReview{}
	if s == nil || s.orders == nil || expectedVersion < 0 || expectedVersion >= 9007199254740991 {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	if _, err := p.previewInput(scope, input.Mode, restaurantPreviewAddress{}, now); err != nil {
		return empty, err
	}
	canonical, err := newRestaurantWhatsappProposal(scope, p.source, input.Items, now)
	if err != nil || canonical.payloadHash != p.payloadHash || canonical.eventKey != p.eventKey || !canonical.expiresAt.Equal(p.expiresAt) {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	input.Items = canonical.items
	// Core handles required contact/address, catalogue, availability and money.
	quote, err := s.orders.Quote(ctx, input)
	if err != nil {
		return empty, err
	}
	input.ExpectedTotalMinor = quote.TotalMinor
	input.ExpectedQuoteHash, err = restaurantQuoteBinding(quote)
	if err != nil {
		return empty, err
	}
	checkout, err := json.Marshal(input)
	if err != nil {
		return empty, restaurantFail(400, "invalid_request")
	}
	quoteJSON, err := json.Marshal(quote)
	if err != nil {
		return empty, err
	}
	expires := now.Add(5 * time.Minute)
	if p.expiresAt.Before(expires) {
		expires = p.expiresAt
	}
	review := restaurantWhatsappReview{ID: uuid.NewString(), Version: expectedVersion + 1, State: "pending", ExpiresAt: expires.UTC().Truncate(time.Microsecond)}
	review.Fingerprint = restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, p.eventKey, input, input.ExpectedQuoteHash, review.ExpiresAt.Format(time.RFC3339Nano)})
	scopeHash := restaurantWhatsappDigest(scope)
	tx, err := s.orders.store.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_whatsapp_review_heads(scope_hash,version) VALUES($1,0) ON CONFLICT DO NOTHING`, scopeHash); err != nil {
		return empty, err
	}
	var version int64
	if err = tx.QueryRowContext(ctx, `SELECT version FROM restaurant_whatsapp_review_heads WHERE scope_hash=$1 FOR UPDATE`, scopeHash).Scan(&version); err != nil {
		return empty, err
	}
	if version != expectedVersion {
		return empty, restaurantFail(409, "conflict")
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_whatsapp_reviews(id,scope_hash,version,fingerprint,proposal_event,checkout,quote,expires_at,created_at,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending')`, review.ID, scopeHash, review.Version, review.Fingerprint, p.eventKey, checkout, quoteJSON, review.ExpiresAt, now.UTC())
	if err != nil {
		return empty, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_whatsapp_review_heads SET version=$2,review_id=$3 WHERE scope_hash=$1`, scopeHash, review.Version, review.ID); err != nil {
		return empty, err
	}
	return review, tx.Commit()
}

// Presentation must be recorded only after a future adapter has reconciled the
// exact rendered review and provider message ID. This private call itself is
// not proof of send/delivery, and cannot be exposed to an untrusted customer.
func (s *restaurantWhatsappReviews) Present(ctx context.Context, scope restaurantWhatsappScope, id, fingerprint, providerMessageID string, now time.Time) (restaurantWhatsappReview, error) {
	if !restaurantWhatsappOpaque(providerMessageID) {
		return restaurantWhatsappReview{}, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	return s.transition(ctx, scope, id, fingerprint, providerMessageID, "", "", "", now)
}

// Only a verified current direct event, explicitly mapped to this review's own
// confirmation/cancel action and replied-to presentation ID, may be passed here.
// A text "yes" parser or caller-supplied peer identity is not sufficient.
func (s *restaurantWhatsappReviews) Decide(ctx context.Context, scope restaurantWhatsappScope, source restaurantWhatsappSource, id, fingerprint, replyTo, decision string, now time.Time) (restaurantWhatsappReview, error) {
	if err := restaurantWhatsappValidateSource(scope, source, now); err != nil {
		return restaurantWhatsappReview{}, err
	}
	if decision != "confirmed" && decision != "cancelled" {
		return restaurantWhatsappReview{}, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	if !restaurantWhatsappOpaque(replyTo) {
		return restaurantWhatsappReview{}, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	event := restaurantWhatsappDigest([]any{"whatsapp-proposal-v1", scope, source.MessageID})
	payload := restaurantWhatsappDigest([]any{source.SentAt.UTC().Format(time.RFC3339Nano), id, fingerprint, replyTo, decision})
	return s.transition(ctx, scope, id, fingerprint, replyTo, decision, event, payload, now)
}

func (s *restaurantWhatsappReviews) transition(ctx context.Context, scope restaurantWhatsappScope, id, fingerprint, messageID, decision, event, decisionHash string, now time.Time) (restaurantWhatsappReview, error) {
	empty := restaurantWhatsappReview{}
	if s == nil || s.orders == nil || !restaurantWhatsappValidScope(scope) || now.IsZero() || !restaurantWhatsappOpaque(id) || !restaurantQuoteHashPattern.MatchString(fingerprint) {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	// Quote outside the review transaction: never request another pool
	// connection while concurrent confirmations hold/wait on the head lock.
	// This is an intent check; final Create must atomically revalidate again.
	var currentHash string
	var quoteCheckErr error
	if decision == "confirmed" {
		var candidateJSON []byte
		var candidateState string
		readErr := s.orders.store.db.QueryRowContext(ctx, `SELECT checkout,state FROM restaurant_whatsapp_reviews WHERE id=$1 AND scope_hash=$2`, id, restaurantWhatsappDigest(scope)).Scan(&candidateJSON, &candidateState)
		if readErr == sql.ErrNoRows {
			return empty, restaurantFail(404, "not_found")
		}
		if readErr != nil {
			return empty, readErr
		}
		if candidateState == "pending" {
			var candidate restaurantOrderInput
			if json.Unmarshal(candidateJSON, &candidate) != nil {
				return empty, restaurantFail(409, "whatsapp_review_changed")
			}
			current, checkErr := s.orders.Quote(ctx, candidate)
			quoteCheckErr = checkErr
			if checkErr == nil {
				currentHash, quoteCheckErr = restaurantQuoteBinding(current)
			}
		}
	}
	tx, err := s.orders.store.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	var version int64
	var active string
	scopeHash := restaurantWhatsappDigest(scope)
	err = tx.QueryRowContext(ctx, `SELECT version,review_id FROM restaurant_whatsapp_review_heads WHERE scope_hash=$1 FOR UPDATE`, scopeHash).Scan(&version, &active)
	if err == sql.ErrNoRows {
		return empty, restaurantFail(404, "not_found")
	}
	if err != nil {
		return empty, err
	}
	var review restaurantWhatsappReview
	var decidedEvent, proposalEvent, savedDecisionHash string
	var checkout, quoteJSON []byte
	err = tx.QueryRowContext(ctx, `SELECT id,version,fingerprint,state,expires_at,presented_message_id,decision_event,proposal_event,decision_hash,checkout,quote FROM restaurant_whatsapp_reviews WHERE id=$1 AND scope_hash=$2 FOR UPDATE`, id, scopeHash).
		Scan(&review.ID, &review.Version, &review.Fingerprint, &review.State, &review.ExpiresAt, &review.PresentedMessageID, &decidedEvent, &proposalEvent, &savedDecisionHash, &checkout, &quoteJSON)
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
	storedQuoteHash, hashErr := restaurantQuoteBinding(quote)
	expectedFingerprint := restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, proposalEvent, input, input.ExpectedQuoteHash, review.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	if hashErr != nil || storedQuoteHash != input.ExpectedQuoteHash || quote.TotalMinor != input.ExpectedTotalMinor || expectedFingerprint != review.Fingerprint {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	if review.Fingerprint != fingerprint {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	if decision != "" && event == proposalEvent {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	if decision != "" && review.State == decision && decidedEvent == event && savedDecisionHash == decisionHash && review.PresentedMessageID == messageID {
		// Historical acknowledgement only, never permission to dispatch a new order.
		review.Duplicate = true
		return review, tx.Commit()
	}
	if active != review.ID || version != review.Version || review.State != "pending" || !now.Before(review.ExpiresAt) {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	if decision == "" {
		if review.PresentedMessageID != "" && review.PresentedMessageID != messageID {
			return empty, restaurantFail(409, "whatsapp_review_changed")
		}
		review.Duplicate = review.PresentedMessageID == messageID
		_, err = tx.ExecContext(ctx, `UPDATE restaurant_whatsapp_reviews SET presented_message_id=$2 WHERE id=$1`, id, messageID)
		review.PresentedMessageID = messageID
	} else {
		if review.PresentedMessageID == "" || review.PresentedMessageID != messageID {
			return empty, restaurantFail(409, "whatsapp_review_not_presented")
		}
		if decision == "confirmed" {
			if quoteCheckErr != nil {
				return empty, quoteCheckErr
			}
			if currentHash != input.ExpectedQuoteHash {
				return empty, restaurantFail(409, "whatsapp_review_changed")
			}
		}
		_, err = tx.ExecContext(ctx, `UPDATE restaurant_whatsapp_reviews SET state=$2,decision_event=$3,decision_hash=$4 WHERE id=$1`, id, decision, event, decisionHash)
		review.State = decision
	}
	if err != nil {
		return empty, err
	}
	return review, tx.Commit()
}
