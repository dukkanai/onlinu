package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"time"
)

// Private durable intake journal. Not initialized by server startup and not
// exposed by any route or transport. It records proposals, never accepted orders.
type restaurantWhatsappInbox struct{ db *sql.DB }
type restaurantWhatsappInboxReceipt struct {
	EventKey    string
	PayloadHash string
	FirstSeenAt time.Time
	ExpiresAt   time.Time
	Duplicate   bool
	Expired     bool
}

func newRestaurantWhatsappInbox(ctx context.Context, db *sql.DB) (*restaurantWhatsappInbox, error) {
	if db == nil {
		return nil, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_whatsapp_inbox (
 event_key TEXT PRIMARY KEY CHECK(event_key ~ '^[0-9a-f]{64}$'),
 payload_hash TEXT NOT NULL CHECK(payload_hash ~ '^[0-9a-f]{64}$'),
 scope_hash TEXT NOT NULL CHECK(scope_hash ~ '^[0-9a-f]{64}$'),
 source_sent_at TIMESTAMPTZ NOT NULL,
 expires_at TIMESTAMPTZ NOT NULL,
 first_seen_at TIMESTAMPTZ NOT NULL,
 items JSONB NOT NULL CHECK(jsonb_typeof(items)='array'),
 CHECK(expires_at>source_sent_at)
 )`)
	if err != nil {
		return nil, err
	}
	return &restaurantWhatsappInbox{db: db}, nil
}

// An already recorded message may return its original receipt after expiration;
// Expired stays true and no timestamp/state is renewed. A new expired message is
// rejected. Equal provider IDs with different canonical content are conflicts.
// The caller must authenticate/recheck current account authority before use.
func (s *restaurantWhatsappInbox) Record(ctx context.Context, p *restaurantWhatsappProposal, now time.Time) (restaurantWhatsappInboxReceipt, error) {
	if s == nil || s.db == nil || p == nil || now.IsZero() {
		return restaurantWhatsappInboxReceipt{}, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	// Rebuild and compare all derived fields; a mutated in-process proposal cannot
	// persist a mismatched event identity, payload hash or extended expiry.
	canonical, err := newRestaurantWhatsappProposal(p.scope, p.source, p.items, p.source.SentAt)
	if err != nil {
		return restaurantWhatsappInboxReceipt{}, err
	}
	if canonical.eventKey != p.eventKey || canonical.payloadHash != p.payloadHash || !canonical.expiresAt.Equal(p.expiresAt) || p.source.SentAt.After(now.Add(30*time.Second)) {
		return restaurantWhatsappInboxReceipt{}, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return restaurantWhatsappInboxReceipt{}, err
	}
	defer tx.Rollback()
	read := func(duplicate bool) (restaurantWhatsappInboxReceipt, error) {
		var receipt restaurantWhatsappInboxReceipt
		var scopeHash string
		var items []byte
		var sent time.Time
		err := tx.QueryRowContext(ctx, `SELECT event_key,payload_hash,scope_hash,source_sent_at,expires_at,first_seen_at,items FROM restaurant_whatsapp_inbox WHERE event_key=$1`, p.eventKey).
			Scan(&receipt.EventKey, &receipt.PayloadHash, &scopeHash, &sent, &receipt.ExpiresAt, &receipt.FirstSeenAt, &items)
		if err != nil {
			return receipt, err
		}
		if receipt.PayloadHash != p.payloadHash || scopeHash != restaurantWhatsappDigest(p.scope) {
			return restaurantWhatsappInboxReceipt{}, restaurantFail(409, "whatsapp_message_conflict")
		}
		// Verify durable payload against its fingerprint. PostgreSQL timestamps have
		// microsecond precision, so source comparisons use that same precision.
		var saved []restaurantOrderLineInput
		if json.Unmarshal(items, &saved) != nil || restaurantWhatsappDigest(saved) != restaurantWhatsappDigest(p.items) || !sent.Equal(p.source.SentAt.Truncate(time.Microsecond)) || !receipt.ExpiresAt.Equal(p.expiresAt.Truncate(time.Microsecond)) {
			return restaurantWhatsappInboxReceipt{}, restaurantFail(409, "whatsapp_inbox_inconsistent")
		}
		receipt.Duplicate = duplicate
		receipt.Expired = !now.Before(receipt.ExpiresAt)
		return receipt, nil
	}
	receipt, err := read(true)
	if err == nil {
		return receipt, tx.Commit()
	}
	if err != sql.ErrNoRows {
		return restaurantWhatsappInboxReceipt{}, err
	}
	if !now.Before(p.expiresAt) {
		return restaurantWhatsappInboxReceipt{}, restaurantFail(409, "whatsapp_message_expired")
	}
	items, err := json.Marshal(p.items)
	if err != nil {
		return restaurantWhatsappInboxReceipt{}, err
	}
	result, err := tx.ExecContext(ctx, `INSERT INTO restaurant_whatsapp_inbox(event_key,payload_hash,scope_hash,source_sent_at,expires_at,first_seen_at,items)
 VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(event_key) DO NOTHING`, p.eventKey, p.payloadHash, restaurantWhatsappDigest(p.scope), p.source.SentAt.Truncate(time.Microsecond), p.expiresAt.Truncate(time.Microsecond), now.UTC().Truncate(time.Microsecond), items)
	if err != nil {
		return restaurantWhatsappInboxReceipt{}, err
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return restaurantWhatsappInboxReceipt{}, err
	}
	receipt, err = read(rows == 0)
	if err != nil {
		return restaurantWhatsappInboxReceipt{}, err
	}
	return receipt, tx.Commit()
}
