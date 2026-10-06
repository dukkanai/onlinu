package main

import (
	"context"
	"github.com/google/uuid"
	"reflect"
	"testing"
)

func TestStaffPaymentMethodsPatchValidation(t *testing.T) {
	for _, p := range []restaurantPaymentMethodsPatch{
		{ExpectedVersion: 0, Mode: "delivery", Methods: []string{"card"}},
		{ExpectedVersion: 1, Mode: "unknown", Methods: []string{"card"}},
		{ExpectedVersion: 1, Mode: "delivery"},
		{ExpectedVersion: 1, Mode: "delivery", Methods: []string{"card", "card"}},
		{ExpectedVersion: 1, Mode: "pickup", Methods: []string{"cash_on_delivery"}},
		{ExpectedVersion: 1, Mode: "delivery", Methods: []string{"cash_before"}},
		{ExpectedVersion: 1, Mode: "table", Methods: []string{"cash_on_delivery"}},
		{ExpectedVersion: 1, Mode: "table", Methods: []string{"card", "cash_before", "cash_after", "other"}},
	} {
		restaurantOrdersRequireError(t, p.validate(), "invalid_request")
	}
	for _, p := range []restaurantPaymentMethodsPatch{
		{ExpectedVersion: 1, Mode: "delivery", Methods: []string{"card", "cash_on_delivery"}},
		{ExpectedVersion: 1, Mode: "pickup", Methods: []string{}},
		{ExpectedVersion: 1, Mode: "table", Methods: []string{"card", "cash_before", "cash_after"}},
	} {
		if err := p.validate(); err != nil {
			t.Fatal(p, err)
		}
	}
}

func TestStaffPaymentMethodsPreserveOrdersAndOtherSettings(t *testing.T) {
	orders, store, input := restaurantGeographyFixture(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:payment-method-fixture", "staff:settings:update"})
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	before, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	changed, err := store.PatchPaymentMethods(ctx, restaurantPaymentMethodsPatch{ExpectedVersion: before.Version, Mode: "delivery", Methods: []string{"card"}})
	if err != nil || changed.Version != before.Version+1 || changed.Demo != before.Settings.Demo {
		t.Fatal("payment-method update failed", err)
	}
	_, err = orders.Quote(ctx, input)
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	// Selecting card does not configure a provider. Only the original runtime
	// availability callback may expose it to a customer quote.
	input.PaymentMethod = "card"
	_, err = orders.Quote(ctx, input)
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	orders.PaymentAvailable = func(_ context.Context, provider, currency string) (bool, error) {
		if provider != "" || currency != "SAR" {
			t.Fatal("unexpected provider probe")
		}
		return true, nil
	}
	quote, err := orders.Quote(ctx, input)
	if err != nil || !reflect.DeepEqual(quote.PaymentMethods, []string{"card"}) {
		t.Fatal("original availability was not reused", quote, err)
	}
	after, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	expected := before
	expected.Version = after.Version
	expected.Settings.PaymentMethods["delivery"] = []string{"card"}
	if !reflect.DeepEqual(expected, after) {
		t.Fatal("unrelated catalogue fields changed")
	}
	old, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || old.Payment != receipt.Order.Payment || old.TotalMinor != 3500 {
		t.Fatal("historical order changed", old, err)
	}
	_, err = store.PatchPaymentMethods(ctx, restaurantPaymentMethodsPatch{ExpectedVersion: before.Version, Mode: "delivery", Methods: []string{"cash_on_delivery"}})
	restaurantOrdersRequireError(t, err, "catalog_changed")
	_, err = store.PatchPaymentMethods(ctx, restaurantPaymentMethodsPatch{ExpectedVersion: changed.Version, Mode: "delivery", Methods: []string{}})
	restaurantOrdersRequireError(t, err, "invalid_request")
	var actor, scope, kind, target string
	err = store.db.QueryRow("SELECT actor_id,actor_scope,kind,target_id FROM restaurant_catalog_audit WHERE version=$1", changed.Version).Scan(&actor, &scope, &kind, &target)
	if err != nil || actor != "platform:payment-method-fixture" || scope != "staff:settings:update" || kind != "payment_methods_update" || target != "delivery" {
		t.Fatal("payment settings attribution missing", err)
	}
	disabled := false
	service, err := store.PatchService(ctx, restaurantServicePatch{ExpectedVersion: changed.Version, PickupEnabled: &disabled})
	if err != nil {
		t.Fatal(err)
	}
	cleared, err := store.PatchPaymentMethods(ctx, restaurantPaymentMethodsPatch{ExpectedVersion: service.Version, Mode: "pickup", Methods: []string{}})
	if err != nil {
		t.Fatal("disabled service empty methods rejected", err)
	}
	_, err = store.db.Exec(`CREATE FUNCTION reject_payment_method_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure';END $$; CREATE TRIGGER reject_payment_method_audit BEFORE INSERT ON restaurant_catalog_audit FOR EACH ROW EXECUTE FUNCTION reject_payment_method_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = store.PatchPaymentMethods(ctx, restaurantPaymentMethodsPatch{ExpectedVersion: cleared.Version, Mode: "delivery", Methods: []string{"cash_on_delivery"}}); err == nil {
		t.Fatal("audit error ignored")
	}
	current, err := store.StaffPaymentMethods(ctx)
	if err != nil || !reflect.DeepEqual(current, cleared) {
		t.Fatal("audit failure did not roll back", err)
	}
}
