package main

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

func TestRestaurantStaffProfilePreservesPrivateSettingsAndAudits(t *testing.T) {
	_, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:synthetic-profile", "staff:settings:update"})
	before, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	view, err := store.StaffProfile(ctx)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(view)
	for _, hidden := range []string{`"tables"`, `"taxNumber"`, `"paymentMethods"`, `"brand"`, `"deliveryFeeMinor"`, before.Tables[0].Code} {
		if strings.Contains(string(raw), hidden) {
			t.Fatal("profile leaked unrelated settings", hidden)
		}
	}
	name, hours := "Synthetic updated restaurant", "09:00–18:00 (text only)"
	saved, err := store.PatchProfile(ctx, restaurantProfilePatch{ExpectedVersion: before.Version, Name: &name, OpeningHours: &hours})
	if err != nil || saved.Name != name || saved.OpeningHours != hours || saved.Version != before.Version+1 {
		t.Fatal("profile update failed", saved, err)
	}
	after, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	expected := before
	expected.Version = saved.Version
	expected.Settings.Name = name
	expected.Settings.OpeningHours = hours
	if !reflect.DeepEqual(expected, after) {
		t.Fatal("narrow profile patch changed unrelated catalogue data")
	}
	var actor, scope, kind string
	if err = db.QueryRow("SELECT actor_id,actor_scope,kind FROM restaurant_catalog_audit WHERE version=$1", saved.Version).Scan(&actor, &scope, &kind); err != nil || actor != "platform:synthetic-profile" || scope != "staff:settings:update" || kind != "profile_update" {
		t.Fatal("profile audit missing", err)
	}
	_, err = store.PatchProfile(ctx, restaurantProfilePatch{ExpectedVersion: before.Version, Name: &name})
	restaurantOrdersRequireError(t, err, "catalog_changed")
	blank := "  "
	_, err = store.PatchProfile(ctx, restaurantProfilePatch{ExpectedVersion: saved.Version, Name: &blank})
	restaurantOrdersRequireError(t, err, "invalid_request")
	_, err = store.PatchProfile(ctx, restaurantProfilePatch{ExpectedVersion: saved.Version})
	restaurantOrdersRequireError(t, err, "invalid_request")
	_, err = db.Exec(`CREATE FUNCTION reject_profile_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure';END $$; CREATE TRIGGER reject_profile_audit BEFORE INSERT ON restaurant_catalog_audit FOR EACH ROW EXECUTE FUNCTION reject_profile_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	name = "Must roll back"
	if _, err = store.PatchProfile(ctx, restaurantProfilePatch{ExpectedVersion: saved.Version, Name: &name}); err == nil {
		t.Fatal("profile update ignored audit failure")
	}
	unchanged, err := store.GetCatalog(ctx, false)
	if err != nil || !reflect.DeepEqual(after, unchanged) {
		t.Fatal("failed audit did not roll back", err)
	}
}
