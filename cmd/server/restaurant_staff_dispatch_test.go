package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRestaurantStaffDispatchAttributionAndAuditRollback(t *testing.T) {
	couriers, orders, db := restaurantCourierFixture(t)
	courier := restaurantCourierCreateTest(t, couriers, "synthetic-dispatch")
	receipt := restaurantCourierCreateOrder(t, orders)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:synthetic-dispatcher", "staff:delivery:assign"})
	assigned, err := couriers.Assign(ctx, receipt.Order.Number, courier.ID, receipt.Order.Version)
	if err != nil || assigned.CourierID != courier.ID || assigned.DeliveryEvents[0].Actor != "platform:synthetic-dispatcher" {
		t.Fatal("dispatch failed attribution", err)
	}
	var actor, scope, kind string
	if err = db.QueryRow("SELECT actor_id,scope,kind FROM platform_staff_order_audit WHERE order_number=$1 AND version=$2", assigned.Number, assigned.Version).Scan(&actor, &scope, &kind); err != nil || actor != "platform:synthetic-dispatcher" || scope != "staff:delivery:assign" || kind != "courier_assigned" {
		t.Fatal("dispatch audit missing", err)
	}
	raw, _ := json.Marshal(staffOrderSummary(assigned))
	for _, key := range []string{`"phone"`, `"address"`, `"trackingToken"`, `"customerName"`, `"username"`} {
		if strings.Contains(string(raw), key) {
			t.Fatal("dispatch summary leaks private fields", key)
		}
	}
	_, err = couriers.Assign(ctx, assigned.Number, "", receipt.Order.Version)
	restaurantOrdersRequireError(t, err, "conflict")
	_, err = db.Exec(`CREATE FUNCTION reject_dispatch_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure';END $$; CREATE TRIGGER reject_dispatch_audit BEFORE INSERT ON platform_staff_order_audit FOR EACH ROW EXECUTE FUNCTION reject_dispatch_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = couriers.Assign(ctx, assigned.Number, "", assigned.Version); err == nil {
		t.Fatal("failed dispatch audit ignored")
	}
	current, err := orders.Track(ctx, assigned.Number, receipt.TrackingToken, "", "")
	if err != nil || current.Version != assigned.Version || current.CourierID != courier.ID || len(current.DeliveryEvents) != len(assigned.DeliveryEvents) {
		t.Fatal("failed dispatch audit did not roll back", err)
	}
}
