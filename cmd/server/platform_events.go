package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
)

func initPlatformEventSchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS platform_event_sequences (
		owner_id TEXT PRIMARY KEY, value BIGINT NOT NULL CHECK(value>0 AND value<=9007199254740991)
	);
	CREATE TABLE IF NOT EXISTS platform_order_outbox (
		owner_id TEXT NOT NULL, sequence BIGINT NOT NULL, order_number TEXT NOT NULL REFERENCES restaurant_orders(number),
		version BIGINT NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL,
		PRIMARY KEY(owner_id,sequence), UNIQUE(order_number,version)
	)`)
	return err
}

func writePlatformOrderEvent(ctx context.Context, tx *sql.Tx, order restaurantOrder) error {
	var owner string
	if err := tx.QueryRowContext(ctx, `SELECT customer_id FROM restaurant_orders WHERE number=$1`, order.Number).Scan(&owner); err != nil {
		return err
	}
	if !strings.HasPrefix(owner, "platform:") {
		return nil
	}
	// Transactional per-owner counter, not a sequence allocated before commit.
	// A rollback cannot consume the cursor or let a later committed event hide it.
	var sequence int64
	err := tx.QueryRowContext(ctx, `INSERT INTO platform_event_sequences(owner_id,value) VALUES($1,1)
		ON CONFLICT(owner_id) DO UPDATE SET value=platform_event_sequences.value+1
		WHERE platform_event_sequences.value<9007199254740991 RETURNING value`, owner).Scan(&sequence)
	if err != nil {
		return fmt.Errorf("platform event sequence: %w", err)
	}
	document, err := json.Marshal(publicPlatformOrder(order))
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO platform_order_outbox(owner_id,sequence,order_number,version,document,created_at)
		VALUES($1,$2,$3,$4,$5,$6)`, owner, sequence, order.Number, order.Version, document, order.UpdatedAt)
	return err
}

type platformOrderEvent struct {
	Sequence int64             `json:"sequence"`
	Order    platformOrderView `json:"order"`
}

func (s *restaurantOrders) platformEvents(ctx context.Context, owner string, after int64, limit int) ([]platformOrderEvent, error) {
	if after < 0 || after > 9007199254740991 || limit < 1 || limit > 100 {
		return nil, restaurantFail(400, "invalid_request")
	}
	rows, err := s.store.db.QueryContext(ctx, `SELECT sequence,document FROM platform_order_outbox WHERE owner_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3`, owner, after, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []platformOrderEvent{}
	for rows.Next() {
		var event platformOrderEvent
		var raw []byte
		if err = rows.Scan(&event.Sequence, &raw); err != nil {
			return nil, err
		}
		if err = json.Unmarshal(raw, &event.Order); err != nil {
			return nil, err
		}
		events = append(events, event)
	}
	return events, rows.Err()
}
