package main

import (
	"context"
	"database/sql"
	"time"
)

type restaurantOrderChannelKey struct{}
type restaurantOrderChannelPolicy struct {
	Channel          string    `json:"channel"`
	NewOrdersEnabled bool      `json:"newOrdersEnabled"`
	Version          int64     `json:"version"`
	UpdatedAt        time.Time `json:"updatedAt"`
}

func restaurantKnownOrderChannel(channel string) bool {
	return channel == "web" || channel == "chatgpt" || channel == "whatsapp_qr" || channel == "whatsapp_cloud"
}

func restaurantOrderChannel(ctx context.Context) string {
	channel, ok := ctx.Value(restaurantOrderChannelKey{}).(string)
	if !ok {
		return "web"
	}
	return channel
}

func initRestaurantOrderChannels(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_order_channels (
		channel TEXT PRIMARY KEY CHECK(channel IN ('web','chatgpt','whatsapp_qr','whatsapp_cloud')),
		new_orders_enabled BOOLEAN NOT NULL, version BIGINT NOT NULL DEFAULT 1 CHECK(version>0 AND version<=9007199254740991),
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
	);
	INSERT INTO restaurant_order_channels(channel,new_orders_enabled) VALUES ('web',TRUE),('chatgpt',TRUE),('whatsapp_qr',FALSE),('whatsapp_cloud',FALSE)
		ON CONFLICT DO NOTHING;
	CREATE TABLE IF NOT EXISTS restaurant_order_channel_audit (
		channel TEXT NOT NULL REFERENCES restaurant_order_channels(channel), version BIGINT NOT NULL,
		actor_id TEXT NOT NULL, new_orders_enabled BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL,
		PRIMARY KEY(channel,version)
	)`)
	return err
}

// Called only after durable retry recovery and while holding the same transaction
// that reserves stock and creates the order. A disabling update waits for these
// shared locks; after it commits no new order can use the old policy snapshot.
func restaurantRequireNewOrderChannel(ctx context.Context, tx *sql.Tx) error {
	channel := restaurantOrderChannel(ctx)
	if !restaurantKnownOrderChannel(channel) {
		return restaurantFail(400, "invalid_order_channel")
	}
	whatsapp := channel == "whatsapp_qr" || channel == "whatsapp_cloud"
	if whatsapp {
		permit, ok := ctx.Value(restaurantWhatsappPermitKey{}).(*restaurantWhatsappPermit)
		if !ok || permit == nil {
			return restaurantFail(409, "channel_ordering_unavailable")
		}
	}
	var enabled bool
	var version int64
	if err := tx.QueryRowContext(ctx, "SELECT new_orders_enabled,version FROM restaurant_order_channels WHERE channel=$1 FOR SHARE", channel).Scan(&enabled, &version); err != nil {
		return err
	}
	if !enabled {
		return restaurantFail(409, "channel_ordering_disabled")
	}
	if whatsapp {
		if err := restaurantRequireWhatsappDispatch(ctx, tx, channel, version); err != nil {
			return err
		}
	}
	return nil
}

func (s *restaurantOrders) OrderChannels(ctx context.Context) ([]restaurantOrderChannelPolicy, error) {
	rows, err := s.store.db.QueryContext(ctx, "SELECT channel,new_orders_enabled,version,updated_at FROM restaurant_order_channels ORDER BY channel")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []restaurantOrderChannelPolicy{}
	for rows.Next() {
		var policy restaurantOrderChannelPolicy
		if err = rows.Scan(&policy.Channel, &policy.NewOrdersEnabled, &policy.Version, &policy.UpdatedAt); err != nil {
			return nil, err
		}
		result = append(result, policy)
	}
	return result, rows.Err()
}

func (s *restaurantOrders) SetOrderChannel(ctx context.Context, channel, actor string, enabled bool, version int64) (restaurantOrderChannelPolicy, error) {
	if !restaurantKnownOrderChannel(channel) || actor == "" || len(actor) > 128 || version < 1 || version >= 9007199254740991 {
		return restaurantOrderChannelPolicy{}, restaurantFail(400, "invalid_request")
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrderChannelPolicy{}, err
	}
	defer tx.Rollback()
	var policy restaurantOrderChannelPolicy
	err = tx.QueryRowContext(ctx, `UPDATE restaurant_order_channels SET new_orders_enabled=$2,version=version+1,updated_at=now()
		WHERE channel=$1 AND version=$3 RETURNING channel,new_orders_enabled,version,updated_at`, channel, enabled, version).
		Scan(&policy.Channel, &policy.NewOrdersEnabled, &policy.Version, &policy.UpdatedAt)
	if err == sql.ErrNoRows {
		return policy, restaurantFail(409, "conflict")
	}
	if err != nil {
		return policy, err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO restaurant_order_channel_audit(channel,version,actor_id,new_orders_enabled,created_at) VALUES($1,$2,$3,$4,$5)", channel, policy.Version, actor, enabled, policy.UpdatedAt)
	if err != nil {
		return policy, err
	}
	return policy, tx.Commit()
}
