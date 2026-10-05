package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func restaurantOrderFixtureCatalog() restaurantCatalog {
	return restaurantCatalog{
		Version:    1,
		Settings:   restaurantSettings{Name: "Test restaurant", Currency: "SAR", DefaultLanguage: "ar", MenuLanguage: "ar", Demo: true, AcceptingOrders: true, DeliveryEnabled: true, PickupEnabled: true, TableEnabled: true, DeliveryFeeMinor: 500, Country: "SA", PrimaryColor: restaurantDefaultPrimaryColor, AccentColor: restaurantDefaultAccentColor, BackgroundColor: restaurantDefaultBackgroundColor, PaymentMethods: restaurantDefaultPaymentMethods()},
		Categories: []restaurantCategory{{ID: "main", Name: "Main dishes"}},
		Items: []restaurantItem{{ID: "rice", CategoryID: "main", Name: "Rice", PriceMinor: 1200, Available: true, Options: []restaurantOption{
			{ID: "extra", Name: "Extra", PriceMinor: 300, Available: true}, {ID: "free", Name: "Free sauce", PriceMinor: 0, Available: true}, {ID: "sold", Name: "Sold out", PriceMinor: 100, Available: false},
		}}},
		Tables: []restaurantTable{{ID: "one", Name: "Table 1", Code: strings.Repeat("A", 43), Active: true}, {ID: "two", Name: "Table 2", Code: strings.Repeat("B", 43), Active: true}, {ID: "off", Name: "Disabled", Code: strings.Repeat("C", 43), Active: false}},
	}
}

func restaurantOrderFixtureInput(mode string) restaurantOrderInput {
	input := restaurantOrderInput{Mode: mode, CustomerName: "Guest", Phone: "+966501234567", Address: restaurantAddress{Country: "SA", NationalAddress: "ABCD1234"}, TableCode: strings.Repeat("A", 43), Items: []restaurantOrderLineInput{{ItemID: "rice", Quantity: 2, OptionIDs: []string{"extra", "free"}}}, ExpectedTotalMinor: 3000}
	switch mode {
	case "table":
		input.PaymentMethod = "cash_after"
	case "delivery":
		input.PaymentMethod = "cash_on_delivery"
	default:
		input.PaymentMethod, input.PaymentProvider = "card", "stripe"
	}
	return input
}

func restaurantOrdersRequireError(t *testing.T, err error, code string) {
	t.Helper()
	var apiErr *restaurantError
	if !errors.As(err, &apiErr) || apiErr.Code != code {
		t.Fatalf("wanted %s, got %v", code, err)
	}
}

func TestRestaurantOrderQuoteServerPricesAndOptions(t *testing.T) {
	catalog := restaurantOrderFixtureCatalog()
	input := restaurantOrderFixtureInput("pickup")
	input.ExpectedTotalMinor = 1 // A browser-supplied total has no authority over pricing.
	quote, err := restaurantPriceOrder(catalog, input)
	if err != nil {
		t.Fatal(err)
	}
	if quote.SubtotalMinor != 3000 || quote.TotalMinor != 3000 || quote.Items[0].UnitPriceMinor != 1500 || len(quote.Items[0].Options) != 2 || quote.Items[0].Options[1].PriceMinor != 0 {
		t.Fatalf("unexpected quote: %+v", quote)
	}
	for _, tc := range []struct {
		name    string
		options []string
	}{
		{"duplicate", []string{"extra", "extra"}},
		{"unavailable", []string{"sold"}},
		{"foreign", []string{"other-item-option"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			input.Items[0].OptionIDs = tc.options
			_, err := restaurantPriceOrder(catalog, input)
			restaurantOrdersRequireError(t, err, "invalid_option")
		})
	}
	input = restaurantOrderFixtureInput("pickup")
	input.Items[0].Quantity = 0
	_, err = restaurantPriceOrder(catalog, input)
	restaurantOrdersRequireError(t, err, "invalid_quantity")
	input.Items[0].Quantity = 100
	_, err = restaurantPriceOrder(catalog, input)
	restaurantOrdersRequireError(t, err, "invalid_quantity")
	input = restaurantOrderFixtureInput("pickup")
	catalog.Items[0].Available = false
	_, err = restaurantPriceOrder(catalog, input)
	restaurantOrdersRequireError(t, err, "item_unavailable")
}

func TestRestaurantOrderQuoteAvailabilityAndDetails(t *testing.T) {
	for _, tc := range []struct {
		name, mode, code string
		change           func(*restaurantCatalog, *restaurantOrderInput)
	}{
		{"closed", "pickup", "store_closed", func(c *restaurantCatalog, i *restaurantOrderInput) { c.Settings.AcceptingOrders = false }},
		{"pickup disabled", "pickup", "mode_unavailable", func(c *restaurantCatalog, i *restaurantOrderInput) { c.Settings.PickupEnabled = false }},
		{"delivery disabled", "delivery", "mode_unavailable", func(c *restaurantCatalog, i *restaurantOrderInput) { c.Settings.DeliveryEnabled = false }},
		{"table disabled", "table", "mode_unavailable", func(c *restaurantCatalog, i *restaurantOrderInput) { c.Settings.TableEnabled = false }},
		{"unknown mode", "unrecognized", "invalid_request", func(c *restaurantCatalog, i *restaurantOrderInput) {}},
		{"missing table", "table", "table_not_found", func(c *restaurantCatalog, i *restaurantOrderInput) { i.TableCode = "invalid" }},
		{"inactive table", "table", "table_not_found", func(c *restaurantCatalog, i *restaurantOrderInput) { i.TableCode = c.Tables[2].Code }},
		{"phone required", "pickup", "phone_required", func(c *restaurantCatalog, i *restaurantOrderInput) { i.Phone = "" }},
		{"phone invalid", "delivery", "phone_required", func(c *restaurantCatalog, i *restaurantOrderInput) { i.Phone = "send email" }},
		{"notes bounded", "pickup", "invalid_request", func(c *restaurantCatalog, i *restaurantOrderInput) { i.Notes = strings.Repeat("a", 1001) }},
		{"name controls", "pickup", "invalid_request", func(c *restaurantCatalog, i *restaurantOrderInput) { i.CustomerName = "bad\x00name" }},
		{"delivery minimum", "delivery", "delivery_minimum", func(c *restaurantCatalog, i *restaurantOrderInput) { c.Settings.DeliveryMinimumMinor = 3001 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			catalog := restaurantOrderFixtureCatalog()
			input := restaurantOrderFixtureInput(tc.mode)
			tc.change(&catalog, &input)
			_, err := restaurantPriceOrder(catalog, input)
			restaurantOrdersRequireError(t, err, tc.code)
		})
	}
	catalog := restaurantOrderFixtureCatalog()
	input := restaurantOrderFixtureInput("table")
	input.Phone = ""
	quote, err := restaurantPriceOrder(catalog, input)
	if err != nil || quote.TableName != "Table 1" {
		t.Fatalf("table order should not require a phone: %+v, %v", quote, err)
	}
	input = restaurantOrderFixtureInput("delivery")
	catalog.Settings.DeliveryMinimumMinor = 3000
	quote, err = restaurantPriceOrder(catalog, input)
	if err != nil || quote.TotalMinor != 3500 {
		t.Fatalf("delivery fee/minimum equality: %+v, %v", quote, err)
	}
}

func restaurantOrdersFloat(value float64) *float64 { return &value }

func TestRestaurantOrderDeliveryBoundaries(t *testing.T) {
	settings := restaurantOrderFixtureCatalog().Settings
	address := restaurantAddress{Country: "SA", NationalAddress: "ABCD1234", Latitude: restaurantOrdersFloat(0), Longitude: restaurantOrdersFloat(0)}
	settings.Latitude, settings.Longitude = restaurantOrdersFloat(0), restaurantOrdersFloat(0)
	settings.DeliveryRadiusKm = 1
	if err := restaurantValidateDelivery(settings, address); err != nil {
		t.Fatalf("zero coordinates are valid, not missing: %v", err)
	}
	address.Longitude = restaurantOrdersFloat(1)
	settings.DeliveryRadiusKm = restaurantDistanceKm(0, 0, 0, 1)
	if err := restaurantValidateDelivery(settings, address); err != nil {
		t.Fatalf("exact radius boundary: %v", err)
	}
	settings.DeliveryRadiusKm -= 0.0001
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "outside_delivery_area")
	settings.DeliveryRadiusKm = 1
	for _, bad := range []float64{math.NaN(), math.Inf(1), math.Inf(-1), 180.1, -180.1} {
		address.Latitude = restaurantOrdersFloat(0)
		address.Longitude = restaurantOrdersFloat(bad)
		restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "invalid_request")
	}
	address.Latitude = restaurantOrdersFloat(90.1)
	address.Longitude = restaurantOrdersFloat(0)
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "invalid_request")
	address.Latitude = nil
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "location_required")
	address.Longitude = nil
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "location_required")
	settings.DeliveryRadiusKm = 0
	settings.RequireDeliveryLocation = true
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "location_required")
	settings.RequireDeliveryLocation = false
	settings.DeliveryAreas = []string{"Central"}
	address.Area = " central "
	if err := restaurantValidateDelivery(settings, address); err != nil {
		t.Fatal(err)
	}
	address.Area = "Elsewhere"
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "outside_delivery_area")
	settings.DeliveryAreas = nil
	address = restaurantAddress{Country: "GB"}
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "country_required")
	address.AddressLine = "Street 4, Building 9"
	restaurantOrdersRequireError(t, restaurantValidateDelivery(settings, address), "country_required")
	address.Country = "SA"
	if err := restaurantValidateDelivery(settings, address); err != nil {
		t.Fatalf("Saudi freeform address must still work: %v", err)
	}
}

func TestRestaurantOrderStatusRules(t *testing.T) {
	for _, mode := range []string{"pickup", "table", "delivery"} {
		chain := []string{"new", "accepted", "preparing", "ready"}
		if mode == "delivery" {
			chain = append(chain, "out_for_delivery")
		}
		chain = append(chain, "completed")
		for n := 1; n < len(chain); n++ {
			if !restaurantStatusTransition(mode, chain[n-1], chain[n]) {
				t.Fatalf("missing transition %s: %s to %s", mode, chain[n-1], chain[n])
			}
		}
		for _, status := range chain[:len(chain)-1] {
			if !restaurantStatusTransition(mode, status, "cancelled") {
				t.Fatalf("cancellation denied: %s", status)
			}
		}
		if restaurantStatusTransition(mode, "completed", "new") || restaurantStatusTransition(mode, "cancelled", "preparing") || restaurantStatusTransition(mode, "new", "completed") {
			t.Fatal("illegal terminal/skip transition accepted")
		}
	}
	if restaurantStatusTransition("pickup", "ready", "out_for_delivery") || restaurantStatusTransition("table", "ready", "out_for_delivery") || restaurantStatusTransition("delivery", "ready", "completed") {
		t.Fatal("mode-specific transition not enforced")
	}
}

func TestRestaurantOrderCredentials(t *testing.T) {
	one, err := restaurantNewOrderSecrets()
	if err != nil {
		t.Fatal(err)
	}
	two, err := restaurantNewOrderSecrets()
	if err != nil {
		t.Fatal(err)
	}
	if len(one.AccessCode) != 10 || len(one.TrackingToken) != 43 || one == two {
		t.Fatal("invalid independent credential generation")
	}
	tokenHash := sha256.Sum256([]byte(one.TrackingToken))
	codeHash := restaurantCodeHash("R00000001", one.AccessCode)
	stored := restaurantOrderStored{order: restaurantOrder{Number: "R00000001"}, customerID: "owner", tokenHash: tokenHash[:], codeHash: codeHash[:]}
	if restaurantCanAccess(stored, "", "", "") || restaurantCanAccess(stored, "", "", "other") || restaurantCanAccess(stored, two.TrackingToken, two.AccessCode, "other") {
		t.Fatal("unauthorized access")
	}
	if !restaurantCanAccess(stored, one.TrackingToken, "", "") || !restaurantCanAccess(stored, "", strings.ToLower(one.AccessCode), "") || !restaurantCanAccess(stored, "", "", "owner") {
		t.Fatal("authorized access denied")
	}
	stored.order.Number = "R00000002"
	if restaurantCanAccess(stored, "", one.AccessCode, "") {
		t.Fatal("access code hash must be order scoped")
	}
}

func restaurantOrdersFixtureDB(t *testing.T) (*restaurantOrders, *restaurantStore, *sql.DB) {
	t.Helper()
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	fixture := restaurantOrderFixtureCatalog()
	fixture.Version = catalog.Version
	// New table codes are server-generated. Discover them after saving.
	for i := range fixture.Tables {
		fixture.Tables[i].Code = ""
	}
	if _, err = store.SaveCatalog(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	orders, err := newRestaurantOrders(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	// Test-only capability: no real provider configuration, network, or charge.
	orders.PaymentAvailable = func(_ context.Context, provider, currency string) (bool, error) {
		return (provider == "" || provider == "stripe") && currency == "SAR", nil
	}
	return orders, store, db
}

func TestRestaurantOrdersIntegrationDurableIdempotency(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	input := restaurantOrderFixtureInput("pickup")
	key := uuid.NewString()
	const workers = 12
	results := make(chan restaurantReceipt, workers)
	errorsCh := make(chan error, workers)
	var wg sync.WaitGroup
	for range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			receipt, err := orders.Create(ctx, input, "", key)
			if err != nil {
				errorsCh <- err
			} else {
				results <- receipt
			}
		}()
	}
	wg.Wait()
	close(results)
	close(errorsCh)
	for err := range errorsCh {
		t.Errorf("concurrent creation: %v", err)
	}
	var first restaurantReceipt
	count := 0
	for receipt := range results {
		if count == 0 {
			first = receipt
		}
		if receipt.Order.Number != first.Order.Number || receipt.TrackingToken != first.TrackingToken || receipt.AccessCode != first.AccessCode {
			t.Fatal("retry generated another order/credential")
		}
		count++
	}
	if count != workers {
		t.Fatalf("only %d successful creates", count)
	}
	var rows int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&rows); err != nil || rows != 1 {
		t.Fatalf("duplicate durable orders: %d, %v", rows, err)
	}
	var encrypted, document []byte
	if err := db.QueryRowContext(ctx, `SELECT sealed_secrets,document FROM restaurant_orders WHERE number=$1`, first.Order.Number).Scan(&encrypted, &document); err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{first.TrackingToken, first.AccessCode} {
		if bytes.Contains(encrypted, []byte(secret)) || bytes.Contains(document, []byte(secret)) {
			t.Fatal("order credentials stored in plaintext")
		}
	}
	// No new environment key is required after a restart, and retries survive
	// a closed/changed catalog without creating another order.
	restarted, err := newRestaurantOrders(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.AcceptingOrders = false
	catalog.Items[0].PriceMinor = 9900
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	again, err := restarted.Create(ctx, input, "", key)
	if err != nil {
		t.Fatal(err)
	}
	if again.TrackingToken != first.TrackingToken || again.AccessCode != first.AccessCode || again.Order.TotalMinor != 3000 {
		t.Fatal("durable retry changed original receipt")
	}
	input.Notes = "different body"
	_, err = restarted.Create(ctx, input, "", key)
	restaurantOrdersRequireError(t, err, "conflict")
}

func TestRestaurantOrdersIntegrationPricesAccessAndSnapshots(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	input := restaurantOrderFixtureInput("pickup")
	input.ExpectedTotalMinor = 1
	_, err := orders.Create(ctx, input, "alice", uuid.NewString())
	restaurantOrdersRequireError(t, err, "price_changed")
	input.ExpectedTotalMinor = 3000
	_, err = orders.Create(ctx, input, "alice", "predictable")
	restaurantOrdersRequireError(t, err, "invalid_request")
	key := uuid.NewString()
	receipt, err := orders.Create(ctx, input, "alice", key)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ number, token, code, owner string }{
		{receipt.Order.Number, "", "", ""}, {receipt.Order.Number, "", "", "bob"}, {receipt.Order.Number, "wrong", "bad", "bob"}, {"R99999999", "", "", "alice"},
	} {
		_, err = orders.Track(ctx, tc.number, tc.token, tc.code, tc.owner)
		restaurantOrdersRequireError(t, err, "invalid_order_access")
	}
	for _, tc := range []struct{ token, code, owner string }{{receipt.TrackingToken, "", ""}, {"", receipt.AccessCode, ""}, {"", "", "alice"}} {
		got, err := orders.Track(ctx, receipt.Order.Number, tc.token, tc.code, tc.owner)
		if err != nil || got.Phone != input.Phone {
			t.Fatalf("authorized receipt unavailable: %v", err)
		}
	}
	looked, err := orders.Lookup(ctx, receipt.Order.Number, strings.ToLower(receipt.AccessCode))
	if err != nil || looked.TrackingToken != receipt.TrackingToken {
		t.Fatalf("code lookup failed: %v", err)
	}
	_, err = orders.Lookup(ctx, receipt.Order.Number, "")
	restaurantOrdersRequireError(t, err, "invalid_order_access")
	bobOrders, err := orders.ListCustomer(ctx, "bob")
	if err != nil || len(bobOrders) != 0 {
		t.Fatal("cross-account listing")
	}
	aliceOrders, err := orders.ListCustomer(ctx, "alice")
	if err != nil || len(aliceOrders) != 1 {
		t.Fatalf("own orders listing: %v", err)
	}
	// Identity changes (including a cookie expiring into guest mode) must not
	// create a second order or reveal another owner's receipt.
	for _, owner := range []string{"bob", ""} {
		_, err = orders.Create(ctx, input, owner, key)
		restaurantOrdersRequireError(t, err, "conflict")
	}
	var count int
	if err = store.db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("identity change duplicated submission: %d, %v", count, err)
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Items[0].Name = "Replacement dish"
	catalog.Items[0].PriceMinor = 9999
	catalog.Items[0].Options = nil
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	got, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if got.Items[0].Name != "Rice" || got.TotalMinor != 3000 || len(got.Items[0].Options) != 2 || got.Items[0].Options[0].Name != "Extra" {
		t.Fatal("catalog edit rewrote order snapshot")
	}
	if got.Address.NationalAddress != "" {
		t.Fatal("pickup unnecessarily retained delivery address")
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 1 {
		t.Fatal("rejected create inserted an order")
	}
}

func TestRestaurantOrdersIntegrationIndependentTablesAndStatus(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("table")
	input.TableCode = catalog.Tables[0].Code
	input.Phone = ""
	one, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	two, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if one.Order.Number == two.Order.Number {
		t.Fatal("table orders were merged")
	}
	_, err = orders.ChangeTable(ctx, one.Order.Number, "", "", "", catalog.Tables[1].Code)
	restaurantOrdersRequireError(t, err, "invalid_order_access")
	_, err = orders.ChangeTable(ctx, one.Order.Number, one.TrackingToken, "", "", catalog.Tables[2].Code)
	restaurantOrdersRequireError(t, err, "table_not_found")
	moved, err := orders.ChangeTable(ctx, one.Order.Number, "", one.AccessCode, "", catalog.Tables[1].Code)
	if err != nil {
		t.Fatal(err)
	}
	if moved.TableID != catalog.Tables[1].ID || moved.Version != 2 || len(moved.TableChanges) != 1 || moved.TableChanges[0].From != "Table 1" || moved.TableChanges[0].To != "Table 2" {
		t.Fatalf("missing table history: %+v", moved)
	}
	unchanged, err := orders.Track(ctx, two.Order.Number, two.TrackingToken, "", "")
	if err != nil || unchanged.TableID != catalog.Tables[0].ID || unchanged.Version != 1 {
		t.Fatal("moving one order moved another")
	}
	same, err := orders.ChangeTable(ctx, one.Order.Number, one.TrackingToken, "", "", catalog.Tables[1].Code)
	if err != nil || same.Version != moved.Version {
		t.Fatal("same-table move should be a no-op")
	}
	// Table moves participate in the admin's optimistic version contract.
	_, err = orders.SetStatus(ctx, one.Order.Number, "accepted", 1)
	restaurantOrdersRequireError(t, err, "conflict")
	statuses := []string{"accepted", "preparing", "ready", "completed"}
	current := moved
	for _, status := range statuses {
		if status == "completed" {
			_, err = orders.SetStatus(ctx, one.Order.Number, status, current.Version)
			restaurantOrdersRequireError(t, err, "payment_required")
			current, err = orders.CollectCash(ctx, one.Order.Number, current.Version)
			if err != nil {
				t.Fatal(err)
			}
		}
		current, err = orders.SetStatus(ctx, one.Order.Number, status, current.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	_, err = orders.ChangeTable(ctx, one.Order.Number, one.TrackingToken, "", "", catalog.Tables[0].Code)
	restaurantOrdersRequireError(t, err, "table_change_unavailable")
	_, err = orders.SetStatus(ctx, one.Order.Number, "new", current.Version)
	restaurantOrdersRequireError(t, err, "invalid_status")
	var events int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_order_events WHERE order_number=$1`, one.Order.Number).Scan(&events); err != nil || events != 7 {
		t.Fatalf("durable audit events: %d, %v", events, err)
	}
	var event []byte
	if err = db.QueryRowContext(ctx, `SELECT document FROM restaurant_order_events WHERE order_number=$1 AND version=2`, one.Order.Number).Scan(&event); err != nil {
		t.Fatal(err)
	}
	var change restaurantTableChange
	if err = json.Unmarshal(event, &change); err != nil || change.To != "Table 2" {
		t.Fatal("table move audit missing")
	}
}

func TestRestaurantOrdersIntegrationConcurrentStatus(t *testing.T) {
	orders, _, _ := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	receipt, err := orders.Create(ctx, restaurantOrderFixtureInput("pickup"), "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	for _, status := range []string{"accepted", "cancelled"} {
		go func(status string) {
			<-start
			_, err := orders.SetStatus(ctx, receipt.Order.Number, status, 1)
			results <- err
		}(status)
	}
	close(start)
	success, conflict := 0, 0
	for range 2 {
		err := <-results
		if err == nil {
			success++
		} else {
			restaurantOrdersRequireError(t, err, "conflict")
			conflict++
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatalf("optimistic race: success=%d conflict=%d", success, conflict)
	}
}

func TestRestaurantOrderMultilingualPhoneNormalization(t *testing.T) {
	for _, raw := range []string{
		"+966 50 123 4567", "+٩٦٦ ٥٠ ١٢٣ ٤٥٦٧", "+۹۶۶ ۵۰ ۱۲۳ ۴۵۶۷", "+९६६ ५० १२३ ४५६७", "+９６６ ５０ １２３ ４５６７",
	} {
		if got := restaurantNormalizePhone(raw); got != "+966 50 123 4567" {
			t.Errorf("phone %q normalized to %q", raw, got)
		}
		input := restaurantNormalizeOrderInput(restaurantOrderInput{Phone: raw})
		if input.Phone != "+966 50 123 4567" || !restaurantOrderPhone(input.Phone) {
			t.Errorf("phone %q not usable at checkout", raw)
		}
	}
}

func TestRestaurantOrdersIntegrationTableChangeHistoryBound(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("table")
	input.TableCode = catalog.Tables[0].Code
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	var moved restaurantOrder
	for i := 0; i < 50; i++ {
		moved, err = orders.ChangeTable(ctx, receipt.Order.Number, receipt.TrackingToken, "", "", catalog.Tables[(i+1)%2].Code)
		if err != nil {
			t.Fatalf("table move %d failed: %v", i+1, err)
		}
	}
	if len(moved.TableChanges) != 50 || moved.Version != 51 {
		t.Fatal("valid table history was lost")
	}
	_, err = orders.ChangeTable(ctx, receipt.Order.Number, receipt.TrackingToken, "", "", catalog.Tables[1].Code)
	restaurantOrdersRequireError(t, err, "table_change_unavailable")
	same, err := orders.ChangeTable(ctx, receipt.Order.Number, receipt.TrackingToken, "", "", catalog.Tables[0].Code)
	if err != nil || same.Version != moved.Version {
		t.Fatal("same-table no-op should remain possible at history limit")
	}
	var events int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_order_events WHERE order_number=$1`, receipt.Order.Number).Scan(&events); err != nil || events != 51 {
		t.Fatalf("table history audit was not bounded: %d %v", events, err)
	}
}
