package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
)

func TestRestaurantBrandValidation(t *testing.T) {
	brand := restaurantEffectiveBrand(restaurantTestCatalog(t).Settings)
	if err := validateRestaurantBrand(brand); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*restaurantBrand)
		code   string
	}{
		{"low primary contrast", func(b *restaurantBrand) { b.PrimaryTextColor = b.PrimaryColor }, "brand_contrast"},
		{"low card contrast", func(b *restaurantBrand) { b.CardColor = b.BodyColor }, "brand_contrast"},
		{"unsafe photo", func(b *restaurantBrand) { b.IntroImageURL = "javascript:alert(1)" }, "brand_invalid"},
		{"invalid radius", func(b *restaurantBrand) { b.Radius = "calc(1px)" }, "brand_invalid"},
		{"invalid color", func(b *restaurantBrand) { b.PrimaryColor = "red" }, "brand_invalid"},
		{"invalid storefront template", func(b *restaurantBrand) { b.StorefrontTemplate = "warm" }, "brand_invalid"},
		{"invalid heading font", func(b *restaurantBrand) { b.HeadingFont = "url(https://example.com/font)" }, "brand_invalid"},
		{"invalid body font", func(b *restaurantBrand) { b.BodyFont = "unknown" }, "brand_invalid"},
		{"invalid button font", func(b *restaurantBrand) { b.ButtonFont = "Cairo" }, "brand_invalid"},
		{"legacy font still restricted", func(b *restaurantBrand) { b.Font = "cairo" }, "brand_invalid"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy := brand
			tc.change(&copy)
			restaurantTestErrorCode(t, validateRestaurantBrand(copy), tc.code)
		})
	}
	if restaurantBrandContrast("#000000", "#ffffff") != 21 {
		t.Fatal("contrast ratio")
	}
}

func TestRestaurantBrandTypographyAndLayoutCompatibility(t *testing.T) {
	brand := restaurantEffectiveBrand(restaurantTestCatalog(t).Settings)
	for _, layout := range []string{"classic", "bistro", "editorial", "compact", "showcase"} {
		for _, font := range []string{"system", "serif", "cairo", "amiri", "tajawal"} {
			copy := brand
			copy.StorefrontTemplate = layout
			copy.HeadingFont, copy.BodyFont, copy.ButtonFont = font, font, font
			if err := validateRestaurantBrand(copy); err != nil {
				t.Fatalf("layout %s, font %s: %v", layout, font, err)
			}
		}
	}
	for _, legacyFont := range []string{"system", "serif"} {
		legacy := brand
		legacy.Font = legacyFont
		legacy.Template = "warm"
		legacy.Layout = "list"
		legacy.StorefrontTemplate, legacy.HeadingFont, legacy.BodyFont, legacy.ButtonFont = "", "", "", ""
		if err := validateRestaurantBrand(legacy); err != nil {
			t.Fatalf("legacy brand rejected: %v", err)
		}
		effective := restaurantEffectiveBrand(restaurantSettings{Brand: &legacy})
		if effective.StorefrontTemplate != "classic" || effective.Font != legacyFont || effective.HeadingFont != "" || effective.BodyFont != "" || effective.ButtonFont != "" {
			t.Fatalf("legacy font %s did not survive defaulting: %+v", legacyFont, effective)
		}
		if effective.Template != "warm" || effective.Layout != "list" || legacy.HeadingFont != "" || legacy.StorefrontTemplate != "" {
			t.Fatal("defaulting mutated legacy data or repurposed color/grid options")
		}
		legacy.HeadingFont = "amiri"
		effective = normalizeRestaurantBrandDefaults(legacy)
		if effective.HeadingFont != "amiri" || effective.BodyFont != "" || effective.ButtonFont != "" || effective.Font != legacyFont {
			t.Fatal("explicit font and per-slot legacy inheritance were not independent")
		}
	}
}

func TestRestaurantBrandDraftPublishAndRevertIsolation(t *testing.T) {
	ctx := context.Background()
	db := restaurantIntegrationDB(t)
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	initial, err := store.BrandState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	brand := initial.Live
	brand.IntroTitle = "Private draft"
	brand.HideHero = true
	brand.StorefrontTemplate = "editorial"
	brand.HeadingFont, brand.BodyFont, brand.ButtonFont = "amiri", "cairo", "tajawal"
	draft, err := store.SaveBrandDraft(ctx, initial.Version, brand)
	if err != nil {
		t.Fatal(err)
	}
	live, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if live.Settings.Brand != nil || draft.Live.IntroTitle != "" || draft.Live.StorefrontTemplate != "classic" || draft.Draft == nil || *draft.Draft != brand {
		t.Fatal("draft leaked to live catalog")
	}
	_, err = store.SaveBrandDraft(ctx, initial.Version, brand)
	restaurantTestErrorCode(t, err, "brand_changed")
	published, err := store.PublishBrand(ctx, draft.Version, false)
	if err != nil {
		t.Fatal(err)
	}
	if published.Live != brand || published.Draft != nil || !published.HasPrevious {
		t.Fatal("publication failed")
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.Name = "Changed independently"
	catalog.Items[0].Name = "Changed dish"
	catalog.Settings.Brand = &restaurantBrand{} // Generic save cannot publish a draft.
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	_, err = store.PublishBrand(ctx, published.Version, true)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err = store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if catalog.Settings.Name != "Changed independently" || catalog.Items[0].Name != "Changed dish" || catalog.Settings.Brand.IntroTitle != "" || catalog.Settings.Brand.StorefrontTemplate != "classic" || catalog.Settings.Brand.HeadingFont != "" || catalog.Settings.Brand.Font != "system" {
		t.Fatal("revert affected unrelated settings or failed")
	}
}

func TestRestaurantBrandLegacySavedDraftAndPrevious(t *testing.T) {
	ctx := context.Background()
	db := restaurantIntegrationDB(t)
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.BrandState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	legacy := state.Live
	legacy.Font = "serif"
	legacy.Template = "warm"
	legacy.StorefrontTemplate, legacy.HeadingFont, legacy.BodyFont, legacy.ButtonFont = "", "", "", ""
	// Simulate persisted pre-upgrade JSON, including the complete absence of the
	// new keys, rather than saving it through the new normalizing writer.
	data, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	var historical map[string]any
	if err = json.Unmarshal(data, &historical); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{"storefrontTemplate", "headingFont", "bodyFont", "buttonFont"} {
		delete(historical, key)
	}
	data, err = json.Marshal(historical)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `UPDATE restaurant_brand_state SET draft=$1,previous=$1 WHERE id=1`, data); err != nil {
		t.Fatal(err)
	}
	state, err = store.BrandState(ctx)
	if err != nil || state.Draft == nil || state.Draft.HeadingFont != "" || state.Draft.Font != "serif" || state.Draft.StorefrontTemplate != "classic" {
		t.Fatalf("historical draft not normalized: %+v, %v", state, err)
	}
	// Reverting a historical previous appearance must retain an in-progress
	// draft and preserve the legacy serif choice when exposing new fields.
	state, err = store.PublishBrand(ctx, state.Version, true)
	if err != nil || state.Live != normalizeRestaurantBrandDefaults(legacy) || state.Draft == nil {
		t.Fatalf("historical previous brand did not revert: %+v, %v", state, err)
	}
	state, err = store.PublishBrand(ctx, state.Version, false)
	if err != nil || state.Live != normalizeRestaurantBrandDefaults(legacy) || state.Draft != nil {
		t.Fatalf("historical draft did not publish: %+v, %v", state, err)
	}
}

func TestRestaurantBrandConcurrentDraftCAS(t *testing.T) {
	ctx := context.Background()
	db := restaurantIntegrationDB(t)
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.BrandState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	results := make(chan error, 8)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			_, err := store.SaveBrandDraft(ctx, state.Version, state.Live)
			results <- err
		}()
	}
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else {
			restaurantTestErrorCode(t, err, "brand_changed")
		}
	}
	if success != 1 {
		t.Fatalf("wanted one successful draft update, got %d", success)
	}
}

func TestRestaurantBrandFontInheritanceSurvivesSavePublishAndLaterBaseChange(t *testing.T) {
	ctx := context.Background()
	db := restaurantIntegrationDB(t)
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.BrandState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	brand := state.Live
	brand.Font = "system"
	brand.HeadingFont, brand.BodyFont, brand.ButtonFont = "amiri", "", ""
	state, err = store.SaveBrandDraft(ctx, state.Version, brand)
	if err != nil || state.Draft == nil || state.Draft.BodyFont != "" || state.Draft.ButtonFont != "" {
		t.Fatalf("draft converted inherited fonts into fixed choices: %+v %v", state, err)
	}
	state, err = store.PublishBrand(ctx, state.Version, false)
	if err != nil {
		t.Fatal(err)
	}
	// Read back the persisted public brand, as a newly opened editor would.
	catalog, err := store.GetCatalog(ctx, true)
	if err != nil || catalog.Settings.Brand == nil {
		t.Fatalf("published brand missing: %v", err)
	}
	brand = *catalog.Settings.Brand
	if brand.BodyFont != "" || brand.ButtonFont != "" || brand.HeadingFont != "amiri" {
		t.Fatal("API read flattened inherited font choices")
	}
	brand.Font = "serif"
	state, err = store.SaveBrandDraft(ctx, state.Version, brand)
	if err != nil {
		t.Fatal(err)
	}
	if state.Live.Font != "system" {
		t.Fatal("saving the new base font published it before confirmation")
	}
	state, err = store.PublishBrand(ctx, state.Version, false)
	if err != nil || state.Live.Font != "serif" || state.Live.HeadingFont != "amiri" || state.Live.BodyFont != "" || state.Live.ButtonFont != "" {
		t.Fatalf("later base-font change lost inheritance or explicit heading: %+v %v", state, err)
	}
	var body, button, heading, base string
	if err = db.QueryRowContext(ctx, `SELECT document->'settings'->'brand'->>'bodyFont',document->'settings'->'brand'->>'buttonFont',document->'settings'->'brand'->>'headingFont',document->'settings'->'brand'->>'font' FROM restaurant_catalog WHERE id=1`).Scan(&body, &button, &heading, &base); err != nil || body != "" || button != "" || heading != "amiri" || base != "serif" {
		t.Fatalf("stored inheritance changed: body=%q button=%q heading=%q base=%q %v", body, button, heading, base, err)
	}
	state, err = store.PublishBrand(ctx, state.Version, true)
	if err != nil || state.Live.Font != "system" || state.Live.HeadingFont != "amiri" || state.Live.BodyFont != "" || state.Live.ButtonFont != "" {
		t.Fatalf("revert lost inheritance: %+v %v", state, err)
	}
}
