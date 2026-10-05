package main

import (
	"context"
	"github.com/google/uuid"
	"reflect"
	"testing"
)

func TestRestaurantStaffDeliveryPricingZonesPreserveOrdersAndAudit(t *testing.T) {
	orders, store, input := restaurantGeographyFixture(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:synthetic-delivery", "staff:settings:update"})
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	zero := int64(0)
	fee := int64(999)
	enabled, disabledFlag := true, false
	_, err = store.PatchDeliveryPricing(ctx, restaurantDeliveryPricingPatch{ExpectedVersion: before.Version, Mode: "flat"})
	restaurantOrdersRequireError(t, err, "invalid_request")
	_, err = store.PatchDeliveryZone(ctx, restaurantDeliveryZonePatch{ExpectedVersion: before.Version, Zone: restaurantDeliveryZoneInput{DistrictID: "sa-d-1", FeeMinor: &zero}})
	restaurantOrdersRequireError(t, err, "invalid_request")
	zoned, err := store.PatchDeliveryZone(ctx, restaurantDeliveryZonePatch{ExpectedVersion: before.Version, Zone: restaurantDeliveryZoneInput{DistrictID: "sa-d-1", Enabled: &enabled, FeeMinor: &zero}})
	if err != nil || len(zoned.Zones) != 1 || *zoned.Zones[0].FeeMinor != 0 {
		t.Fatal("explicit free zone failed", err)
	}
	priced, err := store.PatchDeliveryPricing(ctx, restaurantDeliveryPricingPatch{ExpectedVersion: zoned.Version, Mode: "district", FeeMinor: &fee, MinimumMinor: &zero})
	if err != nil {
		t.Fatal(err)
	}
	quote, err := orders.Quote(ctx, input)
	if err != nil || quote.DeliveryFeeMinor != 0 || quote.TotalMinor != 3000 {
		t.Fatal("new quote ignored district fee", quote, err)
	}
	old, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || old.TotalMinor != 3500 || old.DeliveryFeeMinor != 500 {
		t.Fatal("historical delivery fee changed", err)
	}
	after, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	expected := before
	expected.Version = after.Version
	expected.Settings.DeliveryPricingMode = "district"
	expected.Settings.DeliveryFeeMinor = 999
	expected.Settings.DeliveryZones = []restaurantDeliveryZone{{DistrictID: "sa-d-1", Enabled: true, FeeMinor: &zero}}
	if !reflect.DeepEqual(expected, after) {
		t.Fatal("delivery edit changed unrelated data")
	}
	_, err = store.PatchDeliveryPricing(ctx, restaurantDeliveryPricingPatch{ExpectedVersion: zoned.Version, Mode: "flat", FeeMinor: &zero, MinimumMinor: &zero})
	restaurantOrdersRequireError(t, err, "catalog_changed")
	_, err = store.PatchDeliveryZone(ctx, restaurantDeliveryZonePatch{ExpectedVersion: priced.Version, Zone: restaurantDeliveryZoneInput{DistrictID: "sa-d-2", Enabled: &enabled}})
	restaurantOrdersRequireError(t, err, "invalid_delivery_zones")
	_, err = store.PatchDeliveryZone(ctx, restaurantDeliveryZonePatch{ExpectedVersion: priced.Version, Zone: restaurantDeliveryZoneInput{DistrictID: "unknown", Enabled: &enabled, FeeMinor: &zero}})
	restaurantOrdersRequireError(t, err, "invalid_delivery_zones")
	disabled, err := store.PatchDeliveryZone(ctx, restaurantDeliveryZonePatch{ExpectedVersion: priced.Version, Zone: restaurantDeliveryZoneInput{DistrictID: "sa-d-1", Enabled: &disabledFlag, FeeMinor: &zero}})
	if err != nil {
		t.Fatal(err)
	}
	_, err = orders.Quote(ctx, input)
	restaurantOrdersRequireError(t, err, "outside_delivery_area")
	var actor, scope, kind, target string
	if err = store.db.QueryRow("SELECT actor_id,actor_scope,kind,target_id FROM restaurant_catalog_audit WHERE version=$1", disabled.Version).Scan(&actor, &scope, &kind, &target); err != nil || actor != "platform:synthetic-delivery" || scope != "staff:settings:update" || kind != "delivery_zone_update" || target != "sa-d-1" {
		t.Fatal("zone attribution missing", err)
	}
	_, err = store.db.Exec(`CREATE FUNCTION reject_delivery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure';END $$; CREATE TRIGGER reject_delivery_audit BEFORE INSERT ON restaurant_catalog_audit FOR EACH ROW EXECUTE FUNCTION reject_delivery_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.PatchDeliveryPricing(ctx, restaurantDeliveryPricingPatch{ExpectedVersion: disabled.Version, Mode: "flat", FeeMinor: &zero, MinimumMinor: &zero}); err == nil {
		t.Fatal("audit failure ignored")
	}
	current, err := store.StaffDelivery(ctx)
	if err != nil || !reflect.DeepEqual(disabled, current) {
		t.Fatal("delivery audit failed to roll back", err)
	}
}
