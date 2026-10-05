package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"os"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

func restaurantTestCatalog(t *testing.T) restaurantCatalog {
	t.Helper()
	c, err := newRestaurantDemoCatalog()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func restaurantTestErrorCode(t *testing.T, err error, code string) {
	t.Helper()
	var typed *restaurantError
	if !errors.As(err, &typed) || typed.Code != code {
		t.Fatalf("expected error code %q, got %v", code, err)
	}
}

func TestRestaurantDemoCatalog(t *testing.T) {
	one := restaurantTestCatalog(t)
	two := restaurantTestCatalog(t)
	if !one.Settings.Demo || one.Settings.Currency != "SAR" || one.Settings.Address != "" || one.Settings.Phone != "" || len(one.Categories) != 3 || len(one.Items) != 8 || len(one.Tables) != 3 {
		t.Fatal("demo must be explicitly marked and have a varied menu without real restaurant contacts")
	}
	for i, table := range one.Tables {
		if len(table.Code) != 32 || table.Code == two.Tables[i].Code {
			t.Fatal("each demonstration instance must receive independently generated table codes")
		}
	}
	for _, item := range one.Items {
		if item.ImageURL != "" || item.Options == nil {
			t.Fatal("demo uses frontend illustrations and non-null option arrays")
		}
	}
	if err := validateRestaurantCatalog(one); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantCatalogValidation(t *testing.T) {
	floatPtr := func(n float64) *float64 { return &n }
	cases := []struct {
		name   string
		change func(*restaurantCatalog)
	}{
		{"missing version", func(c *restaurantCatalog) { c.Version = 0 }},
		{"blank name", func(c *restaurantCatalog) { c.Settings.Name = " \n" }},
		{"large unicode name", func(c *restaurantCatalog) { c.Settings.Name = strings.Repeat("ع", 121) }},
		{"invalid utf8", func(c *restaurantCatalog) { c.Settings.Name = string([]byte{0xff}) }},
		{"control character", func(c *restaurantCatalog) { c.Settings.Name = "hi\x00there" }},
		{"wrong default locale", func(c *restaurantCatalog) { c.Settings.DefaultLanguage = "xx" }},
		{"wrong menu locale", func(c *restaurantCatalog) { c.Settings.MenuLanguage = "de" }},
		{"invalid currency", func(c *restaurantCatalog) { c.Settings.Currency = "sar" }},
		{"unknown currency", func(c *restaurantCatalog) { c.Settings.Currency = "ZZZ" }},
		{"no order modes", func(c *restaurantCatalog) {
			c.Settings.DeliveryEnabled = false
			c.Settings.PickupEnabled = false
			c.Settings.TableEnabled = false
		}},
		{"negative fee", func(c *restaurantCatalog) { c.Settings.DeliveryFeeMinor = -1 }},
		{"huge minimum", func(c *restaurantCatalog) { c.Settings.DeliveryMinimumMinor = restaurantMaxMinor + 1 }},
		{"non-finite radius", func(c *restaurantCatalog) { c.Settings.DeliveryRadiusKm = math.NaN() }},
		{"large radius", func(c *restaurantCatalog) { c.Settings.DeliveryRadiusKm = 501 }},
		{"radius without origin", func(c *restaurantCatalog) { c.Settings.DeliveryRadiusKm = 5 }},
		{"partial origin", func(c *restaurantCatalog) { c.Settings.Latitude = floatPtr(24) }},
		{"invalid latitude", func(c *restaurantCatalog) { c.Settings.Latitude = floatPtr(91); c.Settings.Longitude = floatPtr(45) }},
		{"invalid longitude", func(c *restaurantCatalog) {
			c.Settings.Latitude = floatPtr(24)
			c.Settings.Longitude = floatPtr(math.Inf(1))
		}},
		{"blank area", func(c *restaurantCatalog) { c.Settings.DeliveryAreas = []string{""} }},
		{"duplicate area", func(c *restaurantCatalog) { c.Settings.DeliveryAreas = []string{"Downtown", " downtown "} }},
		{"invalid category ID", func(c *restaurantCatalog) { c.Categories[0].ID = "../main" }},
		{"duplicate categories", func(c *restaurantCatalog) { c.Categories = append(c.Categories, c.Categories[0]) }},
		{"unknown category", func(c *restaurantCatalog) { c.Items[0].CategoryID = "absent" }},
		{"duplicate item", func(c *restaurantCatalog) { c.Items = append(c.Items, c.Items[0]) }},
		{"negative item price", func(c *restaurantCatalog) { c.Items[0].PriceMinor = -1 }},
		{"huge item price", func(c *restaurantCatalog) { c.Items[0].PriceMinor = restaurantMaxMinor + 1 }},
		{"negative sort", func(c *restaurantCatalog) { c.Items[0].Sort = -1 }},
		{"unsafe logo", func(c *restaurantCatalog) { c.Settings.LogoURL = "javascript:alert(1)" }},
		{"unsafe item image", func(c *restaurantCatalog) { c.Items[0].ImageURL = "//images.example/a.jpg" }},
		{"negative option price", func(c *restaurantCatalog) { c.Items[0].Options[0].PriceMinor = -1 }},
		{"duplicate option", func(c *restaurantCatalog) { c.Items[0].Options = append(c.Items[0].Options, c.Items[0].Options[0]) }},
		{"large options list", func(c *restaurantCatalog) { c.Items[0].Options = make([]restaurantOption, 51) }},
		{"duplicate table", func(c *restaurantCatalog) { c.Tables = append(c.Tables, c.Tables[0]) }},
		{"short table code", func(c *restaurantCatalog) { c.Tables[0].Code = "1234" }},
		{"duplicate table code", func(c *restaurantCatalog) { c.Tables[1].Code = c.Tables[0].Code }},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			c := restaurantTestCatalog(t)
			test.change(&c)
			restaurantTestErrorCode(t, validateRestaurantCatalog(c), "invalid_request")
		})
	}
	for _, locale := range []string{"ar", "en"} {
		c := restaurantTestCatalog(t)
		c.Settings.DefaultLanguage = locale
		c.Settings.MenuLanguage = locale
		if err := validateRestaurantCatalog(c); err != nil {
			t.Fatalf("supported locale %s rejected: %v", locale, err)
		}
	}
	c := restaurantTestCatalog(t)
	c.Settings.AcceptingOrders = false
	c.Settings.DeliveryEnabled, c.Settings.PickupEnabled, c.Settings.TableEnabled = false, false, false
	if err := validateRestaurantCatalog(c); err != nil {
		t.Fatalf("a closed restaurant may disable all order modes: %v", err)
	}
}

func TestRestaurantSafeImageURL(t *testing.T) {
	for _, value := range []string{"", "https://images.example/photo.jpg", "https://images.example/photo.png?size=500", "/restaurant-media/0123456789abcdef.jpg", "/restaurant-media/photo_1.png"} {
		if !restaurantSafeImageURL(value) {
			t.Errorf("safe image URL rejected: %q", value)
		}
	}
	for _, value := range []string{
		"javascript:alert(1)", "data:image/png;base64,QQ==", "file:///a.jpg", "http://example.test/a.jpg", "//example.test/a.jpg",
		"https://name:password@example.test/a.jpg", "https://example.test/a.svg", "https://example.test/a.SVG", "https://example.test/a.%73vg",
		"https://example.test/a.svgz", "https://example.test/a.jpg#fragment", "https://example.test/\\a.jpg", "https://example.test/\na.jpg",
		"/restaurant-media/../secret.jpg", "/restaurant-media/nested/a.jpg", "/restaurant-media/a.svg", "/restaurant-media/a.jpg?x=1",
		"/other/a.jpg", "https:///a.jpg", " https://example.test/a.jpg", "https://example.test/" + strings.Repeat("a", 2048),
	} {
		if restaurantSafeImageURL(value) {
			t.Errorf("unsafe image URL accepted: %q", value)
		}
	}
}

func TestRestaurantPublicCatalog(t *testing.T) {
	c := restaurantTestCatalog(t)
	c.Items[1].Available = false
	c.Items[0].Options[1].Available = false
	original, _ := json.Marshal(c)
	public := publicRestaurantCatalog(c)
	if len(public.Tables) != 0 || len(public.Items) != 7 || len(public.Items[0].Options) != 1 {
		t.Fatal("public catalog exposes hidden items, hidden options or table codes")
	}
	if !public.Settings.Demo || public.Version != c.Version {
		t.Fatal("demo and version metadata must remain visible")
	}
	after, _ := json.Marshal(c)
	if string(original) != string(after) {
		t.Fatal("public filtering mutated the source catalog")
	}
	data, _ := json.Marshal(public)
	for _, table := range c.Tables {
		if strings.Contains(string(data), table.Code) {
			t.Fatal("serialized public catalog leaks a table code")
		}
	}
}

func TestRestaurantStableTableCodes(t *testing.T) {
	old := restaurantTestCatalog(t)
	current := restaurantTestCatalog(t)
	current.Tables = []restaurantTable{{ID: old.Tables[0].ID, Name: "Renamed", Active: true}, {ID: "new-table", Name: "New", Active: true}}
	if err := assignRestaurantTableCodes(&current, old); err != nil {
		t.Fatal(err)
	}
	if current.Tables[0].Code != old.Tables[0].Code || !restaurantTableCodePattern.MatchString(current.Tables[1].Code) {
		t.Fatal("existing codes must be preserved and new ones must be generated")
	}
	current.Tables[0].Code = old.Tables[1].Code
	restaurantTestErrorCode(t, assignRestaurantTableCodes(&current, old), "invalid_request")
	current.Tables = []restaurantTable{{ID: "new-table", Name: "New", Code: old.Tables[0].Code}}
	restaurantTestErrorCode(t, assignRestaurantTableCodes(&current, old), "invalid_request")
	if _, err := restaurantTableFromCatalog(old, old.Tables[0].Code); err != nil {
		t.Fatal(err)
	}
	old.Tables[0].Active = false
	_, err := restaurantTableFromCatalog(old, old.Tables[0].Code)
	restaurantTestErrorCode(t, err, "table_not_found")
	_, err = restaurantTableFromCatalog(old, "")
	restaurantTestErrorCode(t, err, "table_not_found")
}

// All integration tests require a deliberately named disposable database, and
// create/drop only their own cryptographically random schema. They never use
// the application's database environment variables or mutate existing tables.
func restaurantIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("TEST_RESTAURANT_PG_URL")
	if raw == "" {
		t.Skip("set TEST_RESTAURANT_PG_URL for disposable astracalls_restaurant_test database")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Path != "/astracalls_restaurant_test" || u.Query().Get("dbname") != "" {
		t.Fatal("TEST_RESTAURANT_PG_URL must explicitly name /astracalls_restaurant_test; refusing another database")
	}
	admin, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal("could not open restaurant integration database")
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	var database string
	if err := admin.QueryRowContext(ctx, "SELECT current_database()").Scan(&database); err != nil || database != "astracalls_restaurant_test" {
		t.Fatal("refusing integration writes outside astracalls_restaurant_test")
	}
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		t.Fatal(err)
	}
	schema := "restaurant_it_" + hex.EncodeToString(random)
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatal("could not create private restaurant integration schema")
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		if _, err := admin.ExecContext(cleanupCtx, `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Errorf("could not remove this test's isolated schema: %v", err)
		}
	})
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal("could not open isolated restaurant schema")
	}
	t.Cleanup(func() { _ = db.Close() })
	var actualSchema string
	if err := db.QueryRowContext(ctx, "SELECT current_schema()").Scan(&actualSchema); err != nil || actualSchema != schema {
		t.Fatal("isolated restaurant schema was not selected")
	}
	return db
}

func TestRestaurantStorePersistenceAndPublicIsolation(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	c, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	c.Settings.Name = "Our edited restaurant"
	c.Items[0].Available = false
	originalCode := c.Tables[0].Code
	c.Tables[0].Name = "Window table"
	c.Tables[0].Code = ""
	c.Tables = append(c.Tables, restaurantTable{ID: "patio", Name: "Patio", Active: true})
	saved, err := store.SaveCatalog(ctx, c)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Version != 2 || saved.Tables[0].Code != originalCode || !restaurantTableCodePattern.MatchString(saved.Tables[3].Code) {
		t.Fatal("save lost version or stable/new table codes")
	}
	if _, err := store.SaveCatalog(ctx, c); err == nil {
		t.Fatal("a stale catalog must not overwrite newer changes")
	} else {
		restaurantTestErrorCode(t, err, "catalog_changed")
	}
	restarted, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	loaded, err := restarted.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loaded, saved) {
		t.Fatal("constructor replaced persisted menu with demo data")
	}
	public, err := restarted.GetCatalog(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(public.Tables) != 0 || len(public.Items) != 7 {
		t.Fatal("public catalog leaks unavailable items or table list")
	}
	if table, err := restarted.TableByCode(ctx, originalCode); err != nil || table.Name != "Window table" {
		t.Fatal("table QR must survive rename")
	}
	loaded.Tables[0].Active = false
	if _, err := restarted.SaveCatalog(ctx, loaded); err != nil {
		t.Fatal(err)
	}
	_, err = restarted.TableByCode(ctx, originalCode)
	restaurantTestErrorCode(t, err, "table_not_found")
}

func TestRestaurantStoreConcurrentSavePreventsLostUpdate(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	c, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, name := range []string{"Admin one", "Admin two"} {
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			copy := c
			copy.Tables = append([]restaurantTable(nil), c.Tables...)
			copy.Settings.Name = name
			<-start
			_, err := store.SaveCatalog(ctx, copy)
			errs <- err
		}(name)
	}
	close(start)
	wg.Wait()
	close(errs)
	success, conflicts := 0, 0
	for err := range errs {
		if err == nil {
			success++
		} else {
			restaurantTestErrorCode(t, err, "catalog_changed")
			conflicts++
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatalf("expected exactly one save and one conflict; got %d and %d", success, conflicts)
	}
	loaded, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.Version != 2 {
		t.Fatal("concurrent update advanced catalog version incorrectly")
	}
}
