package main

import (
	"context"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/google/uuid"
)

func restaurantGeographyFixtureRecords() []restaurantGeographyRecord {
	return []restaurantGeographyRecord{
		{"sa-r-1", "region", "", "sa-r-1", "الرياض", "Riyadh"},
		{"sa-r-2", "region", "", "sa-r-2", "مكة", "Makkah"},
		{"sa-c-1", "city", "sa-r-1", "sa-r-1", "الرياض", "Riyadh"},
		{"sa-c-2", "city", "sa-r-2", "sa-r-2", "جدة", "Jeddah"},
		{"sa-d-1", "district", "sa-c-1", "sa-r-1", "السلام", "As Salam"},
		{"sa-d-2", "district", "sa-c-2", "sa-r-2", "السلام", "As Salam"},
	}
}

func restaurantGeographyFixture(t *testing.T) (*restaurantOrders, *restaurantStore, restaurantOrderInput) {
	t.Helper()
	orders, store, db := restaurantOrdersFixtureDB(t)
	if err := restaurantImportGeographyRecords(context.Background(), db, restaurantGeographyFixtureRecords(), "fixture-v1"); err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("delivery")
	input.Address.RegionID, input.Address.CityID, input.Address.DistrictID = "sa-r-1", "sa-c-1", "sa-d-1"
	input.Address.City, input.Address.District, input.Address.Area = "forged city", "forged district", "forged area"
	input.ExpectedTotalMinor = 3500
	return orders, store, input
}

func TestRestaurantGeographyPinnedSourceAndValidation(t *testing.T) {
	records, err := restaurantLoadGeographyFiles(filepath.Join("..", "..", "data", "saudi-geography"))
	if err != nil || len(records) != 13+4581+3732 {
		t.Fatalf("pinned source must load and validate: %d %v", len(records), err)
	}
	for _, record := range records {
		if record.ID == "sa-d-10502038005" && record.NameEn != "Al Awal Dist." {
			t.Fatalf("known upstream CRLF duplicate was not normalized: %q", record.NameEn)
		}
	}
	if _, err := restaurantLoadGeographyFiles(t.TempDir()); err == nil {
		t.Fatal("missing source accepted")
	}
	for _, change := range []func([]restaurantGeographyRecord) []restaurantGeographyRecord{
		func(r []restaurantGeographyRecord) []restaurantGeographyRecord { return append(r, r[0]) },
		func(r []restaurantGeographyRecord) []restaurantGeographyRecord { r[5].Region = "sa-r-1"; return r },
		func(r []restaurantGeographyRecord) []restaurantGeographyRecord { r[5].Parent = "missing"; return r },
		func(r []restaurantGeographyRecord) []restaurantGeographyRecord { r[0].NameAr = " "; return r },
		func(r []restaurantGeographyRecord) []restaurantGeographyRecord { r[0].NameAr = "bad\nname"; return r },
	} {
		if err := restaurantValidateGeographyRecords(change(restaurantGeographyFixtureRecords())); err == nil {
			t.Fatal("invalid source accepted")
		}
	}
}

func TestRestaurantGeographyPinnedSourceImport(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	t.Setenv("RESTAURANT_GEOGRAPHY_DATA_DIR", filepath.Join("..", "..", "data", "saudi-geography"))
	if err := initRestaurantGeography(ctx, db); err != nil {
		t.Fatalf("startup with the real pinned dataset failed: %v", err)
	}
	if err := initRestaurantGeography(ctx, db); err != nil {
		t.Fatalf("restart with the real pinned dataset failed: %v", err)
	}
	var count int
	var version int64
	var revision string
	if err := db.QueryRow(`SELECT count(*) FROM restaurant_geography_entities WHERE active=TRUE`).Scan(&count); err != nil || count != 13+4581+3732 {
		t.Fatalf("imported record count: %d %v", count, err)
	}
	if err := db.QueryRow(`SELECT version,revision FROM restaurant_geography_state WHERE id=1`).Scan(&version, &revision); err != nil || version != 2 || revision != restaurantGeographyRevision {
		t.Fatalf("source revision not durable/idempotent: %d %s %v", version, revision, err)
	}
}

func TestRestaurantGeographyImportsCorrectionsAndRetiredAncestors(t *testing.T) {
	_, store, _ := restaurantGeographyFixture(t)
	ctx := context.Background()
	initial, err := store.GetGeography(ctx, "districts", "", "sa-c-1", false)
	if err != nil || initial.Version != 2 || len(initial.Districts) != 1 {
		t.Fatalf("initial geography: %+v %v", initial, err)
	}
	for _, name := range []string{"", "  ", "bad\nname"} {
		_, err := store.SaveGeographyDistrict(ctx, restaurantGeographyDistrictInput{Version: 2, CityID: "sa-c-1", NameAr: name})
		restaurantTestErrorCode(t, err, "invalid_geography")
	}
	correction, err := store.SaveGeographyDistrict(ctx, restaurantGeographyDistrictInput{Version: 2, ID: "sa-d-1", CityID: "sa-c-1", NameAr: "السلام المصحح", NameEn: "Corrected"})
	if err != nil || correction.Version != 3 {
		t.Fatalf("correction: %+v %v", correction, err)
	}
	_, err = store.SaveGeographyDistrict(ctx, restaurantGeographyDistrictInput{Version: 2, ID: "sa-d-1", CityID: "sa-c-1", NameAr: "stale"})
	restaurantTestErrorCode(t, err, "geography_changed")
	_, err = store.SaveGeographyDistrict(ctx, restaurantGeographyDistrictInput{Version: 3, ID: "sa-d-1", CityID: "sa-c-2", NameAr: "wrong parent"})
	restaurantTestErrorCode(t, err, "invalid_geography")
	local, err := store.SaveGeographyDistrict(ctx, restaurantGeographyDistrictInput{Version: 3, CityID: "sa-c-1", NameAr: "حي محلي"})
	if err != nil || !local.District.Custom {
		t.Fatalf("local addition: %+v %v", local, err)
	}
	if err = restaurantImportGeographyRecords(ctx, store.db, restaurantGeographyFixtureRecords(), "fixture-v1"); err != nil {
		t.Fatal(err)
	}
	unchanged, _ := store.GetGeography(ctx, "districts", "", "sa-c-1", false)
	if unchanged.Version != local.Version || len(unchanged.Districts) != 2 {
		t.Fatal("restarting the same source changed the version or lost local rows")
	}
	updated := restaurantGeographyFixtureRecords()
	updated[4].NameAr = "اسم المصدر الجديد"
	if err = restaurantImportGeographyRecords(ctx, store.db, updated, "fixture-v2"); err != nil {
		t.Fatal(err)
	}
	got, _ := store.GetGeography(ctx, "districts", "", "sa-c-1", false)
	if got.Version != local.Version+1 || len(got.Districts) != 2 {
		t.Fatalf("refresh: %+v", got)
	}
	for _, district := range got.Districts {
		if district.ID == "sa-d-1" && (district.NameAr != correction.District.NameAr || !district.Custom) {
			t.Fatal("source refresh overwrote a local correction")
		}
	}
	reparented := restaurantGeographyFixtureRecords()
	reparented[4].Parent, reparented[4].Region = "sa-c-2", "sa-r-2"
	if err = restaurantImportGeographyRecords(ctx, store.db, reparented, "fixture-invalid"); err == nil {
		t.Fatal("source silently reparented a priced district ID")
	}
	after, _ := store.GetGeography(ctx, "districts", "", "sa-c-1", false)
	if !reflect.DeepEqual(got, after) {
		t.Fatal("failed import was not atomic")
	}
	// Retain a local correction/addition in storage while hiding its retired city.
	retired := []restaurantGeographyRecord{updated[0], updated[1], updated[3], updated[5]}
	if err = restaurantImportGeographyRecords(ctx, store.db, retired, "fixture-v3"); err != nil {
		t.Fatal(err)
	}
	after, _ = store.GetGeography(ctx, "districts", "", "sa-c-1", false)
	if len(after.Districts) != 0 {
		t.Fatal("inactive parent left an orderable local district in the directory")
	}
	var retained bool
	if err = store.db.QueryRow(`SELECT is_local FROM restaurant_geography_entities WHERE id=$1`, local.District.ID).Scan(&retained); err != nil || !retained {
		t.Fatal("source retirement deleted local work")
	}
	fee := int64(700)
	catalog, _ := store.GetCatalog(ctx, false)
	catalog.Settings.DeliveryZones = []restaurantDeliveryZone{{DistrictID: local.District.ID, Enabled: true, FeeMinor: &fee}}
	_, err = store.SaveCatalog(ctx, catalog)
	restaurantTestErrorCode(t, err, "invalid_delivery_zones")
	catalog.Settings.DeliveryZones[0].Enabled = false
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatalf("cannot retain disabled retired-zone configuration: %v", err)
	}
}

func TestRestaurantDistrictPricingCoverageCanonicalSnapshotsAndRetries(t *testing.T) {
	orders, store, input := restaurantGeographyFixture(t)
	ctx := context.Background()
	fee := int64(750)
	catalog, _ := store.GetCatalog(ctx, false)
	catalog.Settings.DeliveryPricingMode = "district"
	catalog.Settings.DeliveryZones = []restaurantDeliveryZone{{"sa-d-1", true, &fee}}
	catalog.Settings.TaxEnabled, catalog.Settings.TaxRateBps, catalog.Settings.TaxNumber = true, 1500, "test-tax-number"
	var err error
	catalog, err = store.SaveCatalog(ctx, catalog)
	if err != nil {
		t.Fatal(err)
	}
	regions, err := store.GetGeography(ctx, "regions", "", "", true)
	if err != nil || len(regions.Regions) != 1 || regions.Regions[0].ID != "sa-r-1" {
		t.Fatalf("public coverage: %+v %v", regions, err)
	}
	all, _ := store.GetGeography(ctx, "regions", "", "", false)
	if len(all.Regions) != 2 {
		t.Fatal("admin directory was filtered by restaurant coverage")
	}
	quote, err := orders.Quote(ctx, input)
	if err != nil || quote.DeliveryFeeMinor != 750 || quote.TotalMinor != 3750 || quote.Tax.NetMinor+quote.Tax.TaxMinor != quote.TotalMinor {
		t.Fatalf("district quote: %+v %v", quote, err)
	}
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantTestErrorCode(t, err, "price_changed")
	input.ExpectedTotalMinor = quote.TotalMinor
	key := uuid.NewString()
	receipt, err := orders.Create(ctx, input, "", key)
	if err != nil || receipt.Order.Address.City != "الرياض" || receipt.Order.Address.District != "السلام" || receipt.Order.Address.Area != "السلام" {
		t.Fatalf("canonical order: %+v %v", receipt.Order.Address, err)
	}
	_, err = store.SaveGeographyDistrict(ctx, restaurantGeographyDistrictInput{Version: regions.Version, ID: "sa-d-1", CityID: "sa-c-1", NameAr: "اسم مصحح"})
	if err != nil {
		t.Fatal(err)
	}
	fee = 900
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	retried, err := orders.Create(ctx, input, "", key)
	restaurantNormalizeLegacyOrder(&receipt.Order)
	if err != nil || !reflect.DeepEqual(receipt.Order, retried.Order) {
		t.Fatalf("correction/price change broke original retry snapshot: %v", err)
	}
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantTestErrorCode(t, err, "price_changed")
	for _, tc := range []struct{ region, city, district, code string }{
		{"", "", "", "district_required"},
		{"sa-r-1", "", "sa-d-1", "invalid_district"},
		{"sa-r-1", "sa-c-2", "sa-d-1", "invalid_district"},
		{"sa-r-2", "sa-c-2", "sa-d-2", "outside_delivery_area"},
		{"sa-r-1", "sa-c-1", "missing", "invalid_district"},
	} {
		bad := input
		bad.Address.RegionID, bad.Address.CityID, bad.Address.DistrictID = tc.region, tc.city, tc.district
		_, err := orders.Quote(ctx, bad)
		restaurantTestErrorCode(t, err, tc.code)
	}
}

func TestRestaurantDistrictZoneValidationFreeDeliveryAndLegacyLimits(t *testing.T) {
	fee, negative, excessive := int64(0), int64(-1), int64(restaurantMaxMinor+1)
	for _, settings := range []restaurantSettings{
		{DeliveryPricingMode: "unknown"},
		{DeliveryZones: []restaurantDeliveryZone{{"sa-d-1", true, nil}}},
		{DeliveryZones: []restaurantDeliveryZone{{"sa-d-1", false, &negative}}},
		{DeliveryZones: []restaurantDeliveryZone{{"sa-d-1", false, &excessive}}},
		{DeliveryZones: []restaurantDeliveryZone{{"sa-d-1", false, nil}, {"sa-d-1", true, &fee}}},
	} {
		restaurantTestErrorCode(t, restaurantValidateDeliveryZoneSettings(settings), "invalid_delivery_zones")
	}
	catalog := restaurantOrderFixtureCatalog()
	input := restaurantOrderFixtureInput("delivery")
	input.Address.RegionID, input.Address.CityID, input.Address.DistrictID = "sa-r-1", "sa-c-1", "sa-d-1"
	catalog.Settings.DeliveryPricingMode = "district"
	catalog.Settings.DeliveryZones = []restaurantDeliveryZone{{"sa-d-1", true, &fee}}
	quote, err := restaurantPriceOrder(catalog, input)
	if err != nil || quote.DeliveryFeeMinor != 0 {
		t.Fatalf("explicit free delivery: %+v %v", quote, err)
	}
	catalog.Settings.DeliveryZones[0].FeeMinor = nil
	_, err = restaurantPriceOrder(catalog, input)
	restaurantTestErrorCode(t, err, "outside_delivery_area")
	catalog.Settings.DeliveryZones[0].FeeMinor = &fee
	catalog.Settings.DeliveryAreas = []string{"legacy area"}
	_, err = restaurantPriceOrder(catalog, input)
	restaurantTestErrorCode(t, err, "outside_delivery_area")
	input.Address.Area = "legacy area"
	lat, lon, far := 24.7136, 46.6753, 25.0
	catalog.Settings.Latitude, catalog.Settings.Longitude, catalog.Settings.DeliveryRadiusKm = &lat, &lon, 5
	_, err = restaurantPriceOrder(catalog, input)
	restaurantTestErrorCode(t, err, "location_required")
	input.Address.Latitude, input.Address.Longitude = &far, &lon
	_, err = restaurantPriceOrder(catalog, input)
	restaurantTestErrorCode(t, err, "outside_delivery_area")
	input.Address.Latitude = &lat
	if _, err = restaurantPriceOrder(catalog, input); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"", "flat"} {
		catalog.Settings.DeliveryPricingMode = mode
		input.Address.RegionID, input.Address.CityID, input.Address.DistrictID = "", "", ""
		quote, err = restaurantPriceOrder(catalog, input)
		if err != nil || quote.DeliveryFeeMinor != 500 {
			t.Fatalf("legacy flat pricing changed: %+v %v", quote, err)
		}
	}
}

func TestRestaurantSavedGeographyAddressesCanonicalAndAtomic(t *testing.T) {
	_, store, input := restaurantGeographyFixture(t)
	ctx := context.Background()
	accounts, err := newRestaurantAccounts(ctx, store.db)
	if err != nil {
		t.Fatal(err)
	}
	customer, token, err := accounts.Register(ctx, "geography_test", "test-only-password", "Geography test")
	if err != nil {
		t.Fatal(err)
	}
	address := input.Address
	address.NationalAddress, address.City, address.District, address.Area, address.Building = "", "", "", "", "123"
	address.RegionID = " sa-r-1 "
	update := restaurantCustomerUpdate{Addresses: []restaurantAddress{address}}
	saved, err := accounts.Update(ctx, customer.ID, update)
	if err != nil || saved.Addresses[0].City != "الرياض" || saved.Addresses[0].District != "السلام" || saved.Addresses[0].RegionID != "sa-r-1" {
		t.Fatalf("saved canonical address: %+v %v", saved.Addresses, err)
	}
	if update.Addresses[0].City != "" {
		t.Fatal("save mutated caller input")
	}
	for _, district := range []string{"", "missing", strings.Repeat("x", 2000), "sa-d-2"} {
		bad := saved.Addresses[0]
		bad.DistrictID = district
		_, err = accounts.Update(ctx, customer.ID, restaurantCustomerUpdate{Addresses: []restaurantAddress{bad}})
		restaurantTestErrorCode(t, err, "invalid_district")
	}
	loaded, ok, err := accounts.Authenticate(ctx, token)
	if err != nil || !ok || !reflect.DeepEqual(loaded.Addresses, saved.Addresses) {
		t.Fatal("rejected address update changed the saved address")
	}
	manual := restaurantAddress{Country: "SA", NationalAddress: "ABCD1234", City: "manual city"}
	saved, err = accounts.Update(ctx, customer.ID, restaurantCustomerUpdate{Addresses: []restaurantAddress{manual}})
	if err != nil || saved.Addresses[0].City != manual.City || saved.Addresses[0].DistrictID != "" {
		t.Fatalf("manual legacy address changed: %+v %v", saved.Addresses, err)
	}
}

func TestRestaurantRetiredConfiguredZoneCanBeDisabledWithoutLosingItsFee(t *testing.T) {
	orders, store, input := restaurantGeographyFixture(t)
	ctx := context.Background()
	fee := int64(850)
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.DeliveryPricingMode = "district"
	catalog.Settings.DeliveryZones = []restaurantDeliveryZone{{DistrictID: "sa-d-1", Enabled: true, FeeMinor: &fee}}
	catalog, err = store.SaveCatalog(ctx, catalog)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orders.Quote(ctx, input); err != nil {
		t.Fatalf("original configured zone was not usable: %v", err)
	}
	records := restaurantGeographyFixtureRecords()
	records = append(records[:4], records[5:]...)
	if err = restaurantImportGeographyRecords(ctx, store.db, records, "fixture-retired-zone"); err != nil {
		t.Fatal(err)
	}
	directory, err := store.GetGeography(ctx, "districts", "", "sa-c-1", false)
	if err != nil || len(directory.Districts) != 0 {
		t.Fatal("retired district remained selectable")
	}
	_, err = orders.Quote(ctx, input)
	restaurantTestErrorCode(t, err, "invalid_district")
	catalog.Settings.Name = "Unrelated edit with retired zone"
	_, err = store.SaveCatalog(ctx, catalog)
	restaurantTestErrorCode(t, err, "invalid_delivery_zones")
	catalog.Settings.DeliveryZones[0].Enabled = false
	saved, err := store.SaveCatalog(ctx, catalog)
	if err != nil || len(saved.Settings.DeliveryZones) != 1 || saved.Settings.DeliveryZones[0].Enabled || saved.Settings.DeliveryZones[0].DistrictID != "sa-d-1" || saved.Settings.DeliveryZones[0].FeeMinor == nil || *saved.Settings.DeliveryZones[0].FeeMinor != fee {
		t.Fatalf("disabled retired-zone identity/fee lost: %+v %v", saved.Settings.DeliveryZones, err)
	}
	saved.Settings.Name = "Another unrelated edit"
	if _, err = store.SaveCatalog(ctx, saved); err != nil {
		t.Fatalf("disabled retired zone blocked later unrelated edits: %v", err)
	}
}
