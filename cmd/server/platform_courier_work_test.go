package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func TestPlatformCourierOwnWorkPrivacyCashAndRevocation(t *testing.T) {
	couriers, orders, db := restaurantCourierFixture(t)
	ctx := context.Background()
	a := restaurantCourierCreateTest(t, couriers, "owned-a")
	b := restaurantCourierCreateTest(t, couriers, "owned-b")
	refA := platformPrincipalRef("https://platform.example", "a", "11111111-1111-4111-8111-111111111111")
	refB := platformPrincipalRef("https://platform.example", "a", "22222222-2222-4222-8222-222222222222")
	admin := context.WithValue(ctx, platformStaffActorKey{}, platformStaffActor{refB, "staff:couriers:link"})
	for _, entry := range []struct{ id, ref string }{{a.ID, refA}, {b.ID, refB}} {
		if _, err := couriers.SetPlatformLink(admin, entry.id, platformLinkInput(0, entry.ref)); err != nil {
			t.Fatal(err)
		}
	}
	first := restaurantCourierCreateOrder(t, orders)
	second := restaurantCourierCreateOrder(t, orders)
	one, err := couriers.Assign(ctx, first.Order.Number, a.ID, first.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	two, err := couriers.Assign(ctx, second.Order.Number, b.ID, second.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	binding := platformCourierBinding{OwnerRef: refA, Version: 1}
	own := context.WithValue(ctx, platformCourierBindingKey{}, binding)
	own = context.WithValue(own, platformStaffActorKey{}, platformStaffActor{refA, "courier:orders:update"})
	list, err := couriers.ListOrders(own, a.ID)
	if err != nil || len(list) != 1 || list[0].Number != one.Number {
		t.Fatal("own list isolation", err)
	}
	detail, err := couriers.PlatformOwnDetail(own, binding, one.Number)
	if err != nil || detail.Phone != "+966500000000" || detail.CustomerName != "Test recipient" || detail.BindingVersion != 1 {
		t.Fatal("own delivery detail", err)
	}
	raw, _ := json.Marshal(detail)
	for _, forbidden := range []string{"receiptToken", "accessToken", "password", "customerId", "paymentAttempts"} {
		if strings.Contains(string(raw), forbidden) {
			t.Fatal("private field leaked", forbidden)
		}
	}
	_, err = couriers.PlatformOwnDetail(own, binding, two.Number)
	restaurantOrdersRequireError(t, err, "order_not_found")
	_, err = couriers.UpdateOrder(own, a.ID, two.Number, "picked_up", two.Version, false)
	restaurantOrdersRequireError(t, err, "order_not_found")
	one = restaurantCourierReady(t, orders, one)
	cashBinding := binding
	cashBinding.CashOnly = true
	cash := context.WithValue(own, platformCourierBindingKey{}, cashBinding)
	cash = context.WithValue(cash, platformStaffActorKey{}, platformStaffActor{refA, "courier:cash:collect"})
	for _, stage := range []string{"picked_up", "on_the_way", "nearby", "at_door"} {
		_, err = couriers.UpdateOrder(cash, a.ID, one.Number, "at_door", one.Version, true)
		restaurantOrdersRequireError(t, err, "invalid_status")
		one, err = couriers.UpdateOrder(own, a.ID, one.Number, stage, one.Version, false)
		if err != nil {
			t.Fatal(stage, err)
		}
	}
	_, err = couriers.UpdateOrder(own, a.ID, one.Number, "delivered", one.Version, false)
	restaurantOrdersRequireError(t, err, "payment_required")
	one, err = couriers.UpdateOrder(cash, a.ID, one.Number, "at_door", one.Version, true)
	if err != nil || one.Payment.Status != "paid" {
		t.Fatal("cash settlement", err, one.Payment.Status)
	}
	one, err = couriers.UpdateOrder(own, a.ID, one.Number, "delivered", one.Version, false)
	if err != nil || one.Status != "completed" {
		t.Fatal("delivery completion", err)
	}
	list, err = couriers.ListOrders(own, a.ID)
	if err != nil || len(list) != 0 {
		t.Fatal("completed task still visible", err)
	}
	_, err = couriers.PlatformOwnDetail(own, binding, one.Number)
	restaurantOrdersRequireError(t, err, "order_not_found")
	var audit int
	if err = db.QueryRow(`SELECT count(*) FROM platform_staff_order_audit WHERE actor_id=$1`, refA).Scan(&audit); err != nil || audit != 6 {
		t.Fatal("verified actor audit", audit, err)
	}
	// A stale cached binding cannot mutate after an explicit unlink.
	third := restaurantCourierCreateOrder(t, orders)
	next, err := couriers.Assign(ctx, third.Order.Number, a.ID, third.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	next = restaurantCourierReady(t, orders, next)
	if _, err = couriers.SetPlatformLink(admin, a.ID, platformLinkInput(1, "")); err != nil {
		t.Fatal(err)
	}
	_, err = couriers.UpdateOrder(own, a.ID, next.Number, "picked_up", next.Version, false)
	restaurantOrdersRequireError(t, err, "forbidden")
	_, err = couriers.PlatformOwnDetail(own, binding, next.Number)
	restaurantOrdersRequireError(t, err, "order_not_found")
}

func TestPlatformCourierQueuedMutationRechecksRevokedBinding(t *testing.T) {
	couriers, orders, db := restaurantCourierFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	courier := restaurantCourierCreateTest(t, couriers, "queued-revocation")
	ref := platformPrincipalRef("https://platform.example", "a", "11111111-1111-4111-8111-111111111111")
	admin := context.WithValue(ctx, platformStaffActorKey{}, platformStaffActor{ref, "staff:couriers:link"})
	if _, err := couriers.SetPlatformLink(admin, courier.ID, platformLinkInput(0, ref)); err != nil {
		t.Fatal(err)
	}
	receipt := restaurantCourierCreateOrder(t, orders)
	order, err := couriers.Assign(ctx, receipt.Order.Number, courier.ID, receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	order = restaurantCourierReady(t, orders, order)
	blocker, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	if _, err = blocker.ExecContext(ctx, `SELECT number FROM restaurant_orders WHERE number=$1 FOR UPDATE`, order.Number); err != nil {
		t.Fatal(err)
	}
	own := context.WithValue(ctx, platformCourierBindingKey{}, platformCourierBinding{OwnerRef: ref, Version: 1})
	result := make(chan error, 1)
	go func() {
		_, changeErr := couriers.UpdateOrder(own, courier.ID, order.Number, "picked_up", order.Version, false)
		result <- changeErr
	}()
	// Hold the order lock while the explicit link revocation commits. Updating an
	// order must recheck identity after acquiring its locks, not just at HTTP entry.
	if _, err = couriers.SetPlatformLink(admin, courier.ID, platformLinkInput(1, "")); err != nil {
		t.Fatal(err)
	}
	if err = blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-result:
		restaurantOrdersRequireError(t, err, "forbidden")
	case <-ctx.Done():
		t.Fatal("queued mutation did not settle")
	}
	current, err := orders.Track(ctx, order.Number, receipt.TrackingToken, "", "")
	if err != nil || current.Version != order.Version || current.DeliveryStatus != "assigned" {
		t.Fatal("revoked queued mutation changed order", err)
	}
}

func TestPlatformCourierAvailabilityAuditRollback(t *testing.T) {
	couriers, _, db := restaurantCourierFixture(t)
	courier := restaurantCourierCreateTest(t, couriers, "availability-audit")
	ref := platformPrincipalRef("https://platform.example", "a", "11111111-1111-4111-8111-111111111111")
	admin := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{ref, "staff:couriers:link"})
	if _, err := couriers.SetPlatformLink(admin, courier.ID, platformLinkInput(0, ref)); err != nil {
		t.Fatal(err)
	}
	own := context.WithValue(context.Background(), platformCourierBindingKey{}, platformCourierBinding{OwnerRef: ref, Version: 1})
	current, err := couriers.SetAvailability(own, courier.ID, "available")
	if err != nil || current.Availability != "available" {
		t.Fatal(err)
	}
	_, err = db.Exec(`CREATE FUNCTION reject_presence_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic availability audit failure';END $$; CREATE TRIGGER reject_presence_audit BEFORE INSERT ON platform_courier_audit FOR EACH ROW EXECUTE FUNCTION reject_presence_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = couriers.SetAvailability(own, courier.ID, "busy"); err == nil {
		t.Fatal("audit failure ignored")
	}
	currentBinding, ok, err := couriers.BoundPlatformCourier(own, ref)
	if err != nil || !ok || currentBinding.Availability != "available" {
		t.Fatal("availability audit did not roll back", err)
	}
}
