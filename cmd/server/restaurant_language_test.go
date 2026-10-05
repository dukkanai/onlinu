package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
)

var restaurantFormerInterfaceLocales = []string{"tr", "ps", "fa", "ru", "uk", "fr", "es", "sw", "ha", "ur", "hi"}

func TestRestaurantBilingualCatalogValidation(t *testing.T) {
	for _, locale := range append(append([]string{}, restaurantFormerInterfaceLocales...), "", "de", "AR", "en-US", " en ") {
		if restaurantSupportedLocale(locale) {
			t.Fatalf("unsupported restaurant interface locale accepted: %q", locale)
		}
		catalog := restaurantTestCatalog(t)
		catalog.Settings.DefaultLanguage = locale
		restaurantTestErrorCode(t, validateRestaurantCatalog(catalog), "invalid_request")
		catalog.Settings.DefaultLanguage = "ar"
		catalog.Settings.MenuLanguage = locale
		restaurantTestErrorCode(t, validateRestaurantCatalog(catalog), "invalid_request")
	}
	for _, locale := range []string{"ar", "en"} {
		catalog := restaurantTestCatalog(t)
		catalog.Settings.DefaultLanguage, catalog.Settings.MenuLanguage = locale, locale
		if err := validateRestaurantCatalog(catalog); err != nil {
			t.Fatalf("supported restaurant locale %q rejected: %v", locale, err)
		}
	}
}

func TestRestaurantBilingualReadDefaultsPreserveMenuMetadataAndContent(t *testing.T) {
	for _, locale := range append(append([]string{}, restaurantFormerInterfaceLocales...), "", "unknown") {
		catalog := restaurantTestCatalog(t)
		catalog.Settings.DefaultLanguage, catalog.Settings.MenuLanguage = locale, locale
		catalog.Items[0].Name = "Crème brûlée — имя блюда — نام غذا"
		catalog.Items[0].Description = "Merchant text is independent of interface language."
		raw, err := json.Marshal(catalog)
		if err != nil {
			t.Fatal(err)
		}
		var got restaurantCatalog
		if err = json.Unmarshal(raw, &got); err != nil {
			t.Fatal(err)
		}
		if err = normalizeRestaurantCatalogDefaults(&got, raw); err != nil {
			t.Fatal(err)
		}
		if got.Settings.DefaultLanguage != "ar" || got.Settings.MenuLanguage != locale || !reflect.DeepEqual(got.Items, catalog.Items) || !reflect.DeepEqual(got.Categories, catalog.Categories) || !reflect.DeepEqual(got.Tables, catalog.Tables) {
			t.Fatalf("normalizing UI language %q relabeled merchant content", locale)
		}
	}
	for _, locale := range []string{"ar", "en"} {
		catalog := restaurantTestCatalog(t)
		catalog.Settings.DefaultLanguage = locale
		raw, err := json.Marshal(catalog)
		if err != nil {
			t.Fatal(err)
		}
		if err = normalizeRestaurantCatalogDefaults(&catalog, raw); err != nil || catalog.Settings.DefaultLanguage != locale {
			t.Fatalf("supported default %q was overwritten: %v", locale, err)
		}
	}
}

func TestRestaurantBilingualLegacyMenuCanBeRetainedButNotNewlySelected(t *testing.T) {
	_, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	for _, locale := range restaurantFormerInterfaceLocales {
		// Simulate an existing pre-update catalog without exercising the new
		// write validator. No production database is used by this fixture.
		if _, err := db.ExecContext(ctx, `UPDATE restaurant_catalog SET document=jsonb_set(jsonb_set(document,'{settings,defaultLanguage}',to_jsonb($1::text)),'{settings,menuLanguage}',to_jsonb($1::text)) WHERE id=1`, locale); err != nil {
			t.Fatal(err)
		}
		var before string
		if err := db.QueryRowContext(ctx, `SELECT document::text FROM restaurant_catalog WHERE id=1`).Scan(&before); err != nil {
			t.Fatal(err)
		}
		loaded, err := store.GetCatalog(ctx, false)
		if err != nil || loaded.Settings.DefaultLanguage != "ar" || loaded.Settings.MenuLanguage != locale {
			t.Fatalf("legacy %q read: %+v %v", locale, loaded.Settings, err)
		}
		public, err := store.GetCatalog(ctx, true)
		if err != nil || public.Settings.DefaultLanguage != "ar" || public.Settings.MenuLanguage != locale {
			t.Fatalf("public %q read: %+v %v", locale, public.Settings, err)
		}
		var unchanged bool
		if err = db.QueryRowContext(ctx, `SELECT document=$1::jsonb FROM restaurant_catalog WHERE id=1`, before).Scan(&unchanged); err != nil || !unchanged {
			t.Fatal("read-time language fallback rewrote stored data")
		}
		loaded.Settings.Name = "Unrelated edit " + locale
		saved, err := store.SaveCatalog(ctx, loaded)
		if err != nil || saved.Settings.DefaultLanguage != "ar" || saved.Settings.MenuLanguage != locale || !reflect.DeepEqual(saved.Items, loaded.Items) || !reflect.DeepEqual(saved.Tables, loaded.Tables) {
			t.Fatalf("unrelated legacy %q save lost metadata or content: %v", locale, err)
		}
		for _, rejected := range []string{"fr", "tr"} {
			if rejected == locale {
				continue
			}
			attempt := saved
			attempt.Settings.MenuLanguage = rejected
			_, err = store.SaveCatalog(ctx, attempt)
			restaurantTestErrorCode(t, err, "invalid_request")
		}
		attempt := saved
		attempt.Settings.DefaultLanguage = locale
		_, err = store.SaveCatalog(ctx, attempt)
		restaurantTestErrorCode(t, err, "invalid_request")
		again, err := store.GetCatalog(ctx, false)
		if err != nil || !reflect.DeepEqual(again, saved) {
			t.Fatal("rejected locale selection changed the saved catalog")
		}
		// The merchant can explicitly select one of the remaining languages.
		saved.Settings.DefaultLanguage, saved.Settings.MenuLanguage = "en", "en"
		saved, err = store.SaveCatalog(ctx, saved)
		if err != nil || saved.Settings.DefaultLanguage != "en" || saved.Settings.MenuLanguage != "en" {
			t.Fatalf("explicit English selection failed: %v", err)
		}
		attempt = saved
		attempt.Settings.MenuLanguage = locale
		_, err = store.SaveCatalog(ctx, attempt)
		restaurantTestErrorCode(t, err, "invalid_request")
	}
}

func TestRestaurantBilingualHTTPKeepsLegacyMenuMetadataOnUnrelatedSave(t *testing.T) {
	s, handler := restaurantHTTPFixture(t)
	ctx := context.Background()
	if _, err := s.restaurant.db.ExecContext(ctx, `UPDATE restaurant_catalog SET document=jsonb_set(jsonb_set(document,'{settings,defaultLanguage}','"fr"'),'{settings,menuLanguage}','"fr"') WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	admin := map[string]string{"X-API-Key": "restaurant-test-master"}
	catalog := restaurantDecodeResponse[restaurantCatalog](t, restaurantHTTPRequest(t, handler, "GET", "/api/restaurant/catalog", nil, admin, nil), 200)
	if catalog.Settings.DefaultLanguage != "ar" || catalog.Settings.MenuLanguage != "fr" {
		t.Fatal("catalog API did not distinguish UI defaults from menu metadata")
	}
	catalog.Settings.Name = "Unrelated API edit"
	saved := restaurantDecodeResponse[restaurantCatalog](t, restaurantHTTPRequest(t, handler, "PUT", "/api/restaurant/catalog", catalog, admin, nil), 200)
	if saved.Settings.MenuLanguage != "fr" || saved.Settings.DefaultLanguage != "ar" {
		t.Fatal("save API relabeled existing menu content")
	}
	saved.Settings.MenuLanguage = "tr"
	if response := restaurantHTTPRequest(t, handler, "PUT", "/api/restaurant/catalog", saved, admin, nil); response.Code != 400 {
		t.Fatalf("API accepted a newly selected removed locale: %d", response.Code)
	}
}
