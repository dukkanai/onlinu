package main

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRestaurantOrderChannelDisablePreservesAcceptedWork(t *testing.T) {
	orders, input := restaurantStockFixture(t, 4)
	ctx := context.WithValue(context.Background(), restaurantOrderChannelKey{}, "chatgpt")
	key := uuid.NewString()
	first, err := orders.Create(ctx, input, "platform:synthetic", key)
	if err != nil {
		t.Fatal(err)
	}
	if first.Order.Channel != "chatgpt" {
		t.Fatal("missing trusted channel provenance")
	}
	policy, err := orders.SetOrderChannel(ctx, "chatgpt", "owner-test", false, 1)
	if err != nil || policy.Version != 2 || policy.NewOrdersEnabled {
		t.Fatal("disable failed", policy, err)
	}
	repeated, err := orders.Create(ctx, input, "platform:synthetic", key)
	if err != nil || repeated.Order.Number != first.Order.Number {
		t.Fatal("disable blocked accepted retry", err)
	}
	_, err = orders.Create(ctx, input, "platform:synthetic", uuid.NewString())
	restaurantOrdersRequireError(t, err, "channel_ordering_disabled")
	restaurantAssertStock(t, orders, 3, 1)
	web, err := orders.Create(context.Background(), input, "", uuid.NewString())
	if err != nil || web.Order.Channel != "web" {
		t.Fatal("independent web ordering was disabled", err)
	}
	restaurantAssertStock(t, orders, 2, 2)
	for _, source := range []string{"whatsapp_qr", "whatsapp_cloud"} {
		_, err = orders.SetOrderChannel(ctx, source, "owner-test", true, 1)
		restaurantOrdersRequireError(t, err, "invalid_request")
		_, err = orders.Create(context.WithValue(ctx, restaurantOrderChannelKey{}, source), input, "", uuid.NewString())
		restaurantOrdersRequireError(t, err, "invalid_order_channel")
	}
	_, err = orders.SetOrderChannel(ctx, "chatgpt", "owner-test", true, 1)
	restaurantOrdersRequireError(t, err, "conflict")
	advanced, err := orders.SetStatus(ctx, first.Order.Number, "accepted", first.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	paid, err := orders.CollectCash(ctx, advanced.Number, advanced.Version)
	if err != nil || paid.Payment.Status != "paid" {
		t.Fatal("disable blocked settlement", err)
	}
	var count int
	if err = orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 2 {
		t.Fatal("rejected channel created order", count, err)
	}
	if err = orders.store.db.QueryRow("SELECT count(*) FROM restaurant_order_channel_audit WHERE channel='chatgpt' AND actor_id='owner-test'").Scan(&count); err != nil || count != 1 {
		t.Fatal("channel audit mismatch", count, err)
	}
}

func TestRestaurantOrderChannelDisableSerializesWithInFlightGate(t *testing.T) {
	orders, input := restaurantStockFixture(t, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, restaurantOrderChannelKey{}, "chatgpt")
	tx, err := orders.store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var blocker int
	if err = tx.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	if err = restaurantRequireNewOrderChannel(ctx, tx); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { _, err := orders.SetOrderChannel(ctx, "chatgpt", "owner-test", false, 1); finished <- err }()
	blocked := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if err = orders.store.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE restaurant_order_channels%')`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("disable did not wait for in-flight channel gate")
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-finished; err != nil {
		t.Fatal(err)
	}
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "channel_ordering_disabled")
	restaurantAssertStock(t, orders, 2, 0)
	// A failed audit must not publish a policy change.
	_, err = orders.store.db.ExecContext(ctx, `CREATE FUNCTION reject_channel_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure';END $$;
		CREATE TRIGGER reject_channel_audit BEFORE INSERT ON restaurant_order_channel_audit FOR EACH ROW EXECUTE FUNCTION reject_channel_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orders.SetOrderChannel(ctx, "chatgpt", "owner-test", true, 2); err == nil {
		t.Fatal("failed audit accepted policy change")
	}
	policies, err := orders.OrderChannels(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, policy := range policies {
		if policy.Channel == "chatgpt" && (policy.NewOrdersEnabled || policy.Version != 2) {
			t.Fatal("policy audit failure did not roll back")
		}
	}
}

func TestRestaurantOrderChannelHTTPRequiresExplicitAdminPolicy(t *testing.T) {
	_, handler := restaurantHTTPFixture(t)
	path := "/api/restaurant/order-channels"
	if got := restaurantHTTPRequest(t, handler, "GET", path, nil, nil, nil); got.Code != 401 {
		t.Fatal("unauthenticated channel settings exposed", got.Code)
	}
	admin := map[string]string{"X-API-Key": "restaurant-test-master"}
	if got := restaurantHTTPRequest(t, handler, "GET", path, nil, admin, nil); got.Code != 200 {
		t.Fatal("admin channel listing", got.Code, got.Body.String())
	}
	if got := restaurantHTTPRequest(t, handler, "PUT", path+"/web", map[string]any{"expectedVersion": 1}, admin, nil); got.Code != 400 {
		t.Fatal("missing explicit boolean changed channel", got.Code)
	}
	if got := restaurantHTTPRequest(t, handler, "PUT", path+"/web", map[string]any{"expectedVersion": 1, "newOrdersEnabled": false, "actor": "forged"}, admin, nil); got.Code != 400 {
		t.Fatal("caller-provided actor accepted", got.Code)
	}
	if got := restaurantHTTPRequest(t, handler, "PUT", path+"/web", map[string]any{"expectedVersion": 1, "newOrdersEnabled": false}, admin, nil); got.Code != 200 {
		t.Fatal("explicit policy change failed", got.Code, got.Body.String())
	}
	if got := restaurantHTTPRequest(t, handler, "POST", "/storefront-api/orders", map[string]any{"channel": "chatgpt"}, nil, nil); got.Code != 400 {
		t.Fatal("browser selected trusted channel", got.Code)
	}
}
