package main

import (
	"context"
	"net/http"
	"reflect"
	"testing"

	"github.com/google/uuid"
)

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
