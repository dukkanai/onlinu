package main

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
)

func TestRestaurantOperationsCatalogValidation(t *testing.T) {
	tests := []struct {
		name   string
		change func(*restaurantCatalog)
	}{
		{"missing country", func(c *restaurantCatalog) { c.Settings.Country = "" }},
		{"unknown country", func(c *restaurantCatalog) { c.Settings.Country = "ZZ" }},
		{"foreign country", func(c *restaurantCatalog) { c.Settings.Country = "TR" }},
		{"lowercase country", func(c *restaurantCatalog) { c.Settings.Country = "sa" }},
		{"short color", func(c *restaurantCatalog) { c.Settings.PrimaryColor = "#123" }},
		{"css color injection", func(c *restaurantCatalog) { c.Settings.AccentColor = "red;display:none" }},
		{"css background url", func(c *restaurantCatalog) { c.Settings.BackgroundColor = "url(https://example.test)" }},
		{"unsafe cover", func(c *restaurantCatalog) { c.Settings.CoverURL = "javascript:alert(1)" }},
		{"negative tax rate", func(c *restaurantCatalog) { c.Settings.TaxRateBps = -1 }},
		{"excess tax rate", func(c *restaurantCatalog) { c.Settings.TaxRateBps = 10001 }},
		{"missing tax number", func(c *restaurantCatalog) { c.Settings.TaxEnabled = true }},
		{"multiline tax number", func(c *restaurantCatalog) { c.Settings.TaxNumber = "123\n456" }},
		{"long tax number", func(c *restaurantCatalog) { c.Settings.TaxNumber = strings.Repeat("1", 81) }},
		{"missing payment policy", func(c *restaurantCatalog) { c.Settings.PaymentMethods = nil }},
		{"unknown payment mode", func(c *restaurantCatalog) { c.Settings.PaymentMethods["other"] = []string{"card"} }},
		{"missing payment mode", func(c *restaurantCatalog) { delete(c.Settings.PaymentMethods, "table") }},
		{"duplicate payment method", func(c *restaurantCatalog) { c.Settings.PaymentMethods["table"] = []string{"card", "card"} }},
		{"cash for pickup", func(c *restaurantCatalog) { c.Settings.PaymentMethods["pickup"] = []string{"cash_after"} }},
		{"table delivery cash", func(c *restaurantCatalog) { c.Settings.PaymentMethods["table"] = []string{"cash_on_delivery"} }},
		{"delivery table cash", func(c *restaurantCatalog) { c.Settings.PaymentMethods["delivery"] = []string{"cash_before"} }},
		{"unknown payment method", func(c *restaurantCatalog) { c.Settings.PaymentMethods["table"] = []string{"crypto"} }},
		{"empty enabled policy", func(c *restaurantCatalog) { c.Settings.PaymentMethods["pickup"] = []string{} }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			catalog := restaurantTestCatalog(t)
			test.change(&catalog)
			restaurantTestErrorCode(t, validateRestaurantCatalog(catalog), "invalid_request")
		})
	}
	catalog := restaurantTestCatalog(t)
	if catalog.Settings.TaxEnabled || catalog.Settings.TaxNumber != "" || catalog.Settings.TaxRateBps != 1500 || catalog.Settings.Country != "SA" {
		t.Fatal("demo defaults must never invent tax registration or enable tax")
	}
	catalog.Settings.TaxEnabled = true
	catalog.Settings.TaxNumber = "merchant-provided-example"
	catalog.Settings.TaxRateBps = 0
	catalog.Settings.PrimaryColor = "#ABCDEF"
	catalog.Settings.PickupEnabled = false
	catalog.Settings.PaymentMethods["pickup"] = []string{}
	if err := validateRestaurantCatalog(catalog); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantOperationsLegacyCatalogDefaults(t *testing.T) {
	catalog := restaurantTestCatalog(t)
	raw, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	var settings map[string]json.RawMessage
	if err = json.Unmarshal(document["settings"], &settings); err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{"country", "primaryColor", "accentColor", "backgroundColor", "coverUrl", "taxEnabled", "taxRateBps", "taxNumber", "paymentMethods"} {
		delete(settings, field)
	}
	document["settings"], err = json.Marshal(settings)
	if err != nil {
		t.Fatal(err)
	}
	legacy, err := json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	var normalized restaurantCatalog
	if err = json.Unmarshal(legacy, &normalized); err != nil {
		t.Fatal(err)
	}
	if err = normalizeRestaurantCatalogDefaults(&normalized, legacy); err != nil {
		t.Fatal(err)
	}
	if normalized.Settings.Country != "SA" || normalized.Settings.TaxEnabled || normalized.Settings.TaxNumber != "" || normalized.Settings.TaxRateBps != 1500 {
		t.Fatal("unsafe legacy tax defaults")
	}
	if normalized.Version != catalog.Version || normalized.Items[0].PriceMinor != catalog.Items[0].PriceMinor || normalized.Tables[0].Code != catalog.Tables[0].Code {
		t.Fatal("defaults altered existing restaurant data")
	}
	if err = validateRestaurantCatalog(normalized); err != nil {
		t.Fatal(err)
	}
	// A deliberate zero rate is not replaced by the default SA rate.
	catalog.Settings.TaxRateBps = 0
	raw, err = json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	if err = normalizeRestaurantCatalogDefaults(&catalog, raw); err != nil {
		t.Fatal(err)
	}
	if catalog.Settings.TaxRateBps != 0 {
		t.Fatal("explicit zero tax was overwritten")
	}
	// A historical foreign setting remains visible on read, but cannot be saved
	// as the country of a newly configured Saudi-only restaurant.
	catalog.Settings.Country = "TR"
	raw, err = json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	if err = normalizeRestaurantCatalogDefaults(&catalog, raw); err != nil {
		t.Fatal(err)
	}
	if catalog.Settings.Country != "TR" {
		t.Fatal("read defaults relabeled a historical restaurant country")
	}
	restaurantTestErrorCode(t, validateRestaurantCatalog(catalog), "invalid_request")
}

func TestRestaurantOperationsLegacyCatalogReadDoesNotWrite(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `UPDATE restaurant_catalog SET document=jsonb_set(document,'{settings}',(document->'settings')-ARRAY['country','primaryColor','accentColor','backgroundColor','coverUrl','taxEnabled','taxRateBps','taxNumber','paymentMethods']) WHERE id=1`)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Settings.Country != "SA" || catalog.Settings.TaxEnabled || catalog.Settings.TaxNumber != "" {
		t.Fatal("invalid normalized legacy catalog")
	}
	var hasCountry bool
	var version int64
	if err = db.QueryRowContext(ctx, `SELECT document->'settings' ? 'country',version FROM restaurant_catalog WHERE id=1`).Scan(&hasCountry, &version); err != nil {
		t.Fatal(err)
	}
	if hasCountry || version != 1 {
		t.Fatal("read-time defaults unexpectedly rewrote stored data")
	}
	saved, err := store.SaveCatalog(ctx, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != 2 || saved.Settings.TaxEnabled {
		t.Fatal("explicit save did not preserve safe defaults")
	}
}

func TestRestaurantCountryAllowlist(t *testing.T) {
	codes := strings.Fields(restaurantCountryCodes)
	if len(codes) != 1 || codes[0] != "SA" {
		t.Fatalf("only Saudi Arabia should be enabled, got %v", codes)
	}
	seen := map[string]bool{}
	for _, code := range codes {
		if seen[code] || !restaurantSupportedCountry(code) {
			t.Fatalf("invalid country entry %q", code)
		}
		seen[code] = true
	}
	for _, code := range []string{"", "ZZ", "XK", "sa", " SA", "SA ", "S", "SA AE", "USA", "TR", "US", "AE", "GB"} {
		if restaurantSupportedCountry(code) {
			t.Errorf("invalid country accepted %q", code)
		}
	}
}
