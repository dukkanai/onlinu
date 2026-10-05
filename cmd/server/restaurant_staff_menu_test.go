package main

import (
	"context"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func TestRestaurantStaffMenuPatchPreservesPrivateSettingsAndOrderSnapshots(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:synthetic-menu", "staff:menu:update"})
	input := restaurantOrderFixtureInput("delivery")
	input.ExpectedTotalMinor = 3500
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	menu, err := store.StaffMenu(ctx)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(menu)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(raw), `"tables"`) || strings.Contains(string(raw), `"settings"`) || strings.Contains(string(raw), before.Tables[0].Code) {
		t.Fatal("staff menu leaked settings or QR capabilities")
	}
	price := int64(1300)
	changed, err := store.PatchMenuItem(ctx, "rice", restaurantMenuItemPatch{ExpectedVersion: before.Version, PriceMinor: &price})
	if err != nil || changed.Item.PriceMinor != 1300 || changed.Version != before.Version+1 {
		t.Fatal("menu patch failed", changed, err)
	}
	after, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(before.Settings, after.Settings) || !reflect.DeepEqual(before.Tables, after.Tables) || !reflect.DeepEqual(before.Items[0].Options, after.Items[0].Options) {
		t.Fatal("price patch changed unrelated data")
	}
	quote, err := orders.Quote(ctx, input)
	if err != nil || quote.TotalMinor != 3700 {
		t.Fatal("new quote did not use changed server price", quote.TotalMinor, err)
	}
	oldOrder, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || oldOrder.TotalMinor != 3500 || oldOrder.Items[0].UnitPriceMinor != 1500 {
		t.Fatal("menu patch repriced historical order", err)
	}
	var actor, scope, kind, target string
	if err = db.QueryRow("SELECT actor_id,actor_scope,kind,target_id FROM restaurant_catalog_audit WHERE version=$1", changed.Version).Scan(&actor, &scope, &kind, &target); err != nil || actor != "platform:synthetic-menu" || scope != "staff:menu:update" || kind != "item_update" || target != "rice" {
		t.Fatal("menu audit missing attribution", err)
	}
	after.Settings.OpeningHours = "Independent settings edit"
	settings, err := store.SaveCatalog(context.Background(), after)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.PatchMenuItem(ctx, "rice", restaurantMenuItemPatch{ExpectedVersion: changed.Version, PriceMinor: &price})
	restaurantOrdersRequireError(t, err, "catalog_changed")
	_, err = db.Exec(`CREATE FUNCTION reject_menu_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure';END $$;
		CREATE TRIGGER reject_menu_audit BEFORE INSERT ON restaurant_catalog_audit FOR EACH ROW EXECUTE FUNCTION reject_menu_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	price = 1400
	if _, err = store.PatchMenuItem(ctx, "rice", restaurantMenuItemPatch{ExpectedVersion: settings.Version, PriceMinor: &price}); err == nil {
		t.Fatal("menu save ignored failed audit")
	}
	unchanged, err := store.GetCatalog(ctx, false)
	if err != nil || unchanged.Version != settings.Version || unchanged.Items[0].PriceMinor != 1300 || unchanged.Settings.OpeningHours != "Independent settings edit" {
		t.Fatal("failed menu audit did not roll back", err)
	}
}
