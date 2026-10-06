package main

import (
	"context"
	"encoding/json"
	"github.com/google/uuid"
	"math"
	"reflect"
	"testing"
)

func TestRestaurantDeliveryLocationInput(t *testing.T) {
	radius := 1.0
	for _, raw := range []string{`{}`, `[]`, `true`, `{"latitude":0}`, `{"latitude":null,"longitude":0}`, `{"latitude":91,"longitude":0}`, `{"latitude":0,"longitude":181}`, `{"latitude":"0","longitude":0}`, `{"latitude":0,"longitude":0,"extra":1}`, `{"latitude":0,"longitude":0} {}`} {
		_, err := (restaurantDeliveryLocationPatch{ExpectedVersion: 1, Origin: json.RawMessage(raw)}).origin()
		restaurantOrdersRequireError(t, err, "invalid_request")
	}
	for _, value := range []float64{-1, 501, math.NaN(), math.Inf(1)} {
		_, err := (restaurantDeliveryLocationPatch{ExpectedVersion: 1, RadiusKm: &value}).origin()
		restaurantOrdersRequireError(t, err, "invalid_request")
	}
	for _, patch := range []restaurantDeliveryLocationPatch{{ExpectedVersion: 1}, {ExpectedVersion: 0, RadiusKm: &radius}} {
		_, err := patch.origin()
		restaurantOrdersRequireError(t, err, "invalid_request")
	}
	for _, raw := range []string{`null`, ` null `, `{"latitude":0,"longitude":0}`, `{"latitude":-90,"longitude":180}`} {
		if _, err := (restaurantDeliveryLocationPatch{ExpectedVersion: 1, Origin: json.RawMessage(raw)}).origin(); err != nil {
			t.Fatal(raw, err)
		}
	}
	if _, err := (restaurantDeliveryLocationPatch{ExpectedVersion: 1, RadiusKm: &radius}).origin(); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantDeliveryLocationPreservesCatalogueOrdersAndAudit(t *testing.T) {
	orders, store, input := restaurantGeographyFixture(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:location-fixture", "staff:settings:update"})
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	radius, zero, near, far := 1.0, 0.0, 0.001, 1.0
	view, err := store.PatchDeliveryLocation(ctx, restaurantDeliveryLocationPatch{ExpectedVersion: before.Version, Origin: json.RawMessage(`{"latitude":0,"longitude":0}`), RadiusKm: &radius})
	if err != nil || view.Latitude == nil || *view.Latitude != 0 || view.Longitude == nil || *view.Longitude != 0 || view.RadiusKm != 1 {
		t.Fatal("origin/radius not saved", view, err)
	}
	_, err = orders.Quote(ctx, input)
	restaurantOrdersRequireError(t, err, "location_required")
	input.Address.Latitude, input.Address.Longitude = &near, &near
	quote, err := orders.Quote(ctx, input)
	if err != nil || quote.DeliveryFeeMinor != 500 {
		t.Fatal("coverage changed fee", quote, err)
	}
	input.Address.Latitude = &far
	_, err = orders.Quote(ctx, input)
	restaurantOrdersRequireError(t, err, "outside_delivery_area")
	after, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	expected := before
	expected.Version = after.Version
	expected.Settings.Latitude = &zero
	expected.Settings.Longitude = &zero
	expected.Settings.DeliveryRadiusKm = radius
	if !reflect.DeepEqual(expected, after) {
		t.Fatal("unrelated catalogue data changed")
	}
	_, err = store.PatchDeliveryLocation(ctx, restaurantDeliveryLocationPatch{ExpectedVersion: before.Version, RadiusKm: &zero})
	restaurantOrdersRequireError(t, err, "catalog_changed")
	_, err = store.PatchDeliveryLocation(ctx, restaurantDeliveryLocationPatch{ExpectedVersion: view.Version, Origin: json.RawMessage(`null`)})
	restaurantOrdersRequireError(t, err, "invalid_request")
	current, err := store.StaffDelivery(ctx)
	if err != nil || !reflect.DeepEqual(current, view) {
		t.Fatal("invalid clear changed state", err)
	}
	noRadius, err := store.PatchDeliveryLocation(ctx, restaurantDeliveryLocationPatch{ExpectedVersion: view.Version, RadiusKm: &zero})
	if err != nil || noRadius.Latitude == nil || *noRadius.Latitude != 0 {
		t.Fatal("omitted origin was cleared", err)
	}
	required := true
	cleared, err := store.PatchDeliveryLocation(ctx, restaurantDeliveryLocationPatch{ExpectedVersion: noRadius.Version, Origin: json.RawMessage(`null`), RequireLocation: &required})
	if err != nil || cleared.Latitude != nil || cleared.Longitude != nil || !cleared.RequireLocation {
		t.Fatal("explicit clear/require failed", err)
	}
	input.Address.Latitude, input.Address.Longitude = nil, nil
	_, err = orders.Quote(ctx, input)
	restaurantOrdersRequireError(t, err, "location_required")
	old, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || old.TotalMinor != 3500 || old.DeliveryFeeMinor != 500 {
		t.Fatal("historical order changed", err)
	}
	var actor, scope, kind string
	err = store.db.QueryRow("SELECT actor_id,actor_scope,kind FROM restaurant_catalog_audit WHERE version=$1", cleared.Version).Scan(&actor, &scope, &kind)
	if err != nil || actor != "platform:location-fixture" || scope != "staff:settings:update" || kind != "delivery_location_update" {
		t.Fatal("audit attribution missing", err)
	}
	_, err = store.db.Exec(`CREATE FUNCTION reject_location_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure';END $$; CREATE TRIGGER reject_location_audit BEFORE INSERT ON restaurant_catalog_audit FOR EACH ROW EXECUTE FUNCTION reject_location_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	required = false
	if _, err = store.PatchDeliveryLocation(ctx, restaurantDeliveryLocationPatch{ExpectedVersion: cleared.Version, RequireLocation: &required}); err == nil {
		t.Fatal("audit failure ignored")
	}
	current, err = store.StaffDelivery(ctx)
	if err != nil || !reflect.DeepEqual(current, cleared) {
		t.Fatal("audit failure did not roll back", err)
	}
}
