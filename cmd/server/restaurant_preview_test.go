package main

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

func TestRestaurantPreviewPaymentMethodAvailability(t *testing.T) {
	ctx := context.Background()
	for _, demo := range []bool{false, true} {
		for _, tc := range []struct {
			mode    string
			methods []string
		}{
			{"pickup", []string{}},
			{"delivery", []string{"cash_on_delivery"}},
			{"table", []string{"cash_before", "cash_after"}},
		} {
			catalog := restaurantOrderFixtureCatalog()
			catalog.Settings.Demo = demo
			input := restaurantOrderFixtureInput(tc.mode)
			input.CustomerName, input.Phone, input.PaymentMethod, input.PaymentProvider = "", "", "", ""
			priced, err := restaurantPriceCart(catalog, input, false)
			if err != nil {
				t.Fatal(err)
			}
			orders := &restaurantOrders{}
			preview, err := orders.availableCartQuote(ctx, priced, input, false)
			if err != nil || !reflect.DeepEqual(preview.PaymentMethods, tc.methods) || preview.Demo != demo || preview.TotalMinor != priced.TotalMinor {
				t.Fatalf("demo=%v mode=%s: %+v %v", demo, tc.mode, preview, err)
			}
			if len(tc.methods) == 0 {
				_, err = orders.availableQuote(ctx, priced, input)
				restaurantOrdersRequireError(t, err, "payment_unavailable")
			}
		}
	}
	// An unavailable provider is an ordinary empty choice; a failed lookup must
	// not be silently presented as a successfully evaluated payment snapshot.
	wantErr := errors.New("synthetic provider lookup failure")
	orders := &restaurantOrders{PaymentAvailable: func(context.Context, string, string) (bool, error) {
		return false, wantErr
	}}
	_, err := orders.availableCartQuote(ctx, restaurantQuote{Currency: "SAR", PaymentMethods: []string{"card"}}, restaurantOrderInput{}, false)
	if !errors.Is(err, wantErr) {
		t.Fatalf("preview swallowed provider lookup error: %v", err)
	}
}

func TestRestaurantPreviewKeepsCheckoutValidation(t *testing.T) {
	catalog := restaurantOrderFixtureCatalog()
	input := restaurantOrderFixtureInput("pickup")
	full, err := restaurantPriceOrder(catalog, input)
	if err != nil {
		t.Fatal(err)
	}
	input.CustomerName, input.Phone = "", ""
	preview, err := restaurantPriceCart(catalog, input, false)
	if err != nil || !reflect.DeepEqual(preview, full) {
		t.Fatalf("preview differs: %+v %v", preview, err)
	}
	_, err = restaurantPriceOrder(catalog, input)
	restaurantOrdersRequireError(t, err, "phone_required")
}

func TestRestaurantPreviewCoverageWithoutStreetAddress(t *testing.T) {
	catalog := restaurantOrderFixtureCatalog()
	input := restaurantOrderFixtureInput("delivery")
	input.Phone, input.CustomerName = "", ""
	input.Address = restaurantAddress{Country: "SA", Area: "allowed"}
	catalog.Settings.DeliveryAreas = []string{"allowed"}
	quote, err := restaurantPriceCart(catalog, input, false)
	if err != nil || quote.DeliveryFeeMinor != 500 || quote.TotalMinor != 3500 {
		t.Fatalf("delivery preview: %+v %v", quote, err)
	}
	input.Address.Area = "outside"
	_, err = restaurantPriceCart(catalog, input, false)
	restaurantOrdersRequireError(t, err, "outside_delivery_area")
	input.Address.Area = "allowed"
	catalog.Settings.RequireDeliveryLocation = true
	_, err = restaurantPriceCart(catalog, input, false)
	restaurantOrdersRequireError(t, err, "location_required")
	catalog.Settings.RequireDeliveryLocation = false
	input.Phone = "+966501234567"
	_, err = restaurantPriceOrder(catalog, input)
	restaurantOrdersRequireError(t, err, "address_required")
}

func TestRestaurantPreviewReadOnlyAndHTTPRejectsContact(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	catalog, err := s.restaurant.GetCatalog(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	fixture := restaurantOrderFixtureCatalog()
	fixture.Version = catalog.Version
	for i := range fixture.Tables {
		fixture.Tables[i].Code = ""
	}
	if _, err = s.restaurant.SaveCatalog(context.Background(), fixture); err != nil {
		t.Fatal(err)
	}
	input := restaurantPreviewInput{Mode: "pickup", Items: restaurantOrderFixtureInput("pickup").Items}
	for i := 0; i < 2; i++ {
		w := restaurantHTTPRequest(t, h, http.MethodPost, "/storefront-api/preview", input, nil, nil)
		if w.Code != 200 {
			t.Fatalf("preview: %d %s", w.Code, w.Body.String())
		}
	}
	var count int
	if err = s.restaurant.db.QueryRow(`SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("preview created orders: %d %v", count, err)
	}
	for _, field := range []string{"customerName", "phone", "paymentMethod", "expectedTotalMinor"} {
		body := map[string]any{"mode": "pickup", "items": input.Items, field: "forbidden"}
		w := restaurantHTTPRequest(t, h, http.MethodPost, "/storefront-api/preview", body, nil, nil)
		if w.Code != 400 {
			t.Fatalf("accepted %s: %d", field, w.Code)
		}
	}
	// Reusing preview input at the order endpoint must not bypass checkout.
	w := restaurantHTTPRequest(t, h, http.MethodPost, "/storefront-api/orders", input,
		map[string]string{"Idempotency-Key": uuid.NewString()}, nil)
	if w.Code == 200 || w.Code == 201 {
		t.Fatal("incomplete preview created an order")
	}
}

func TestRestaurantPreviewWithoutPaymentStillPricesAndProtectsCheckout(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	ctx := context.Background()
	catalog, err := s.restaurant.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	fixture := restaurantOrderFixtureCatalog()
	fixture.Version = catalog.Version
	fixture.Tables = []restaurantTable{}
	fixture.Items = []restaurantItem{
		{ID: "chicken-kabsa", CategoryID: "main", Name: "Chicken kabsa", PriceMinor: 3200, Available: true,
			Options: []restaurantOption{{ID: "extra-rice", Name: "Extra rice", PriceMinor: 600, Available: true}}},
		{ID: "water", CategoryID: "main", Name: "Water", PriceMinor: 300, Available: true},
	}
	if _, err = s.restaurant.SaveCatalog(ctx, fixture); err != nil {
		t.Fatal(err)
	}
	if _, err = s.orders.SaveStock(ctx, "chicken-kabsa", restaurantStockInput{Tracked: true, Available: 2}); err != nil {
		t.Fatal(err)
	}
	stockBefore, err := s.orders.ListStock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	for _, providerState := range []string{"missing", "unavailable", "available"} {
		t.Run(providerState, func(t *testing.T) {
			s.orders.PaymentAvailable = nil
			if providerState != "missing" {
				s.orders.PaymentAvailable = func(context.Context, string, string) (bool, error) {
					return providerState == "available", nil
				}
			}
			for _, withRice := range []bool{false, true} {
				input := restaurantPreviewInput{Mode: "pickup", Items: []restaurantOrderLineInput{
					{ItemID: "chicken-kabsa", Quantity: 2}, {ItemID: "water", Quantity: 2},
				}}
				wantTotal := int64(7000)
				if withRice {
					input.Items[0].OptionIDs = []string{"extra-rice"}
					wantTotal = 8200
				}
				quote := restaurantDecodeResponse[restaurantQuote](t,
					restaurantHTTPRequest(t, h, http.MethodPost, "/storefront-api/preview", input, nil, nil), http.StatusOK)
				wantMethods := []string{}
				if providerState == "available" {
					wantMethods = []string{"card"}
				}
				if quote.TotalMinor != wantTotal || quote.SubtotalMinor != wantTotal || quote.DeliveryFeeMinor != 0 ||
					quote.Currency != "SAR" || quote.Tax.Enabled || quote.Tax.GrossMinor != wantTotal ||
					!reflect.DeepEqual(quote.PaymentMethods, wantMethods) || len(quote.Items) != 2 ||
					quote.Items[0].TotalMinor != wantTotal-600 || quote.Items[1].TotalMinor != 600 {
					t.Fatalf("incorrect preview (rice=%v): %+v", withRice, quote)
				}
				checkout := restaurantOrderFixtureInput("pickup")
				checkout.Items, checkout.ExpectedTotalMinor = input.Items, wantTotal
				if providerState != "available" {
					for _, path := range []string{"/storefront-api/quote", "/storefront-api/orders"} {
						w := restaurantHTTPRequest(t, h, http.MethodPost, path, checkout,
							map[string]string{"Idempotency-Key": uuid.NewString()}, nil)
						failure := restaurantDecodeResponse[map[string]string](t, w, http.StatusConflict)
						if failure["error"] != "payment_unavailable" {
							t.Fatalf("checkout lost payment validation: %s", w.Body.String())
						}
					}
				}
			}
		})
	}
	s.orders.PaymentAvailable = nil
	for _, tc := range []struct {
		line restaurantOrderLineInput
		code string
	}{
		{restaurantOrderLineInput{ItemID: "chicken-kabsa", Quantity: 3}, "item_unavailable"},
		{restaurantOrderLineInput{ItemID: "chicken-kabsa", Quantity: 1, OptionIDs: []string{"unknown"}}, "invalid_option"},
		{restaurantOrderLineInput{ItemID: "unknown", Quantity: 1}, "item_unavailable"},
	} {
		_, err = s.orders.Preview(ctx, restaurantPreviewInput{Mode: "pickup", Items: []restaurantOrderLineInput{tc.line}})
		restaurantOrdersRequireError(t, err, tc.code)
	}
	stockAfter, err := s.orders.ListStock(ctx)
	if err != nil || !reflect.DeepEqual(stockBefore, stockAfter) {
		t.Fatalf("preview changed stock: before=%+v after=%+v error=%v", stockBefore, stockAfter, err)
	}
	for _, table := range []string{"restaurant_orders", "restaurant_customers", "restaurant_stock_reservations"} {
		var count int
		if err = s.restaurant.db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&count); err != nil || count != 0 {
			t.Fatalf("preview/rejected checkout changed %s: %d %v", table, count, err)
		}
	}
}
