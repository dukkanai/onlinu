package main

import (
	"context"
	"reflect"
	"testing"
)

func TestRestaurantStaffServicePreservesOrdersPricesTablesAndAudits(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:synthetic-service", "staff:settings:update"})
	before, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	receipt := restaurantCourierCreateOrder(t, orders)
	beforeOrder, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	off, on := false, true
	saved, err := store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: before.Version, AcceptingOrders: &off})
	if err != nil || saved.AcceptingOrders || saved.Version != before.Version+1 {
		t.Fatal("close service", err)
	}
	_, err = orders.Quote(ctx, restaurantOrderInput{Mode: "delivery", CustomerName: "Synthetic", Phone: "+966500000000", Address: restaurantAddress{Country: "SA", NationalAddress: "TEST1234"}, PaymentMethod: "cash_on_delivery", Items: []restaurantOrderLineInput{{ItemID: before.Items[0].ID, Quantity: 1}}})
	restaurantOrdersRequireError(t, err, "store_closed")
	after, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	expected := before
	expected.Version = saved.Version
	expected.Settings.AcceptingOrders = false
	if !reflect.DeepEqual(expected, after) {
		t.Fatal("service switch changed unrelated data")
	}
	old, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || !reflect.DeepEqual(old, beforeOrder) {
		t.Fatal("service closure changed existing order", err)
	}
	// Existing accepted work can still progress while new intake is closed.
	if _, err = orders.SetStatus(ctx, old.Number, "accepted", old.Version); err != nil {
		t.Fatal("closure blocked settlement", err)
	}
	var actor, scope, kind string
	if err = db.QueryRow(`SELECT actor_id,actor_scope,kind FROM restaurant_catalog_audit WHERE version=$1`, saved.Version).Scan(&actor, &scope, &kind); err != nil || actor != "platform:synthetic-service" || scope != "staff:settings:update" || kind != "service_update" {
		t.Fatal("service audit", err)
	}
	_, err = store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: before.Version, AcceptingOrders: &on})
	restaurantOrdersRequireError(t, err, "catalog_changed")
	_, err = store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: saved.Version})
	restaurantOrdersRequireError(t, err, "invalid_request")
	_, err = store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: saved.Version, AcceptingOrders: &on, DeliveryEnabled: &off, PickupEnabled: &off, TableEnabled: &off})
	restaurantOrdersRequireError(t, err, "invalid_service_modes")
	closed, err := store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: saved.Version, DeliveryEnabled: &off, PickupEnabled: &off, TableEnabled: &off})
	if err != nil || closed.AcceptingOrders || closed.TableEnabled || closed.PickupEnabled || closed.DeliveryEnabled {
		t.Fatal("explicit disabled service", err)
	}
	restored, err := store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: closed.Version, AcceptingOrders: &on, DeliveryEnabled: &on, PickupEnabled: &on, TableEnabled: &on})
	if err != nil || !restored.AcceptingOrders {
		t.Fatal("explicit reopen", err)
	}
	current, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	expected = before
	expected.Version = restored.Version
	if !reflect.DeepEqual(expected, current) {
		t.Fatal("round trip changed price/tax/table capabilities")
	}
	_, err = db.Exec(`CREATE FUNCTION reject_service_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic service audit failure';END $$;CREATE TRIGGER reject_service_audit BEFORE INSERT ON restaurant_catalog_audit FOR EACH ROW EXECUTE FUNCTION reject_service_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: restored.Version, AcceptingOrders: &off}); err == nil {
		t.Fatal("audit failure ignored")
	}
	unchanged, err := store.GetCatalog(ctx, false)
	if err != nil || !reflect.DeepEqual(current, unchanged) {
		t.Fatal("audit did not roll back", err)
	}
}
