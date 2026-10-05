package main

import (
	"context"
	"testing"

	"github.com/google/uuid"
)

func TestRestaurantGeographyHTTPPublicReadAdminWriteAndVersionConflict(t *testing.T) {
	s, handler := restaurantHTTPFixture(t)
	if err := restaurantImportGeographyRecords(context.Background(), s.restaurant.db, restaurantGeographyFixtureRecords(), "http-fixture"); err != nil {
		t.Fatal(err)
	}
	admin := map[string]string{"X-API-Key": "restaurant-test-master"}
	directory := restaurantDecodeResponse[restaurantGeography](t, restaurantHTTPRequest(t, handler, "GET", "/storefront-api/geography?kind=districts&cityId=sa-c-1", nil, nil, nil), 200)
	if len(directory.Districts) != 1 {
		t.Fatal("public geography not available to guests")
	}
	input := restaurantGeographyDistrictInput{Version: directory.Version, CityID: "sa-c-1", NameAr: "حي جديد", NameEn: "New district"}
	for _, headers := range []map[string]string{nil, {"X-API-Key": "restaurant-test-widget"}} {
		for _, path := range []string{"/api/restaurant/geography", "/api/restaurant/geography/district"} {
			method := "GET"
			if path == "/api/restaurant/geography/district" {
				method = "PUT"
			}
			if response := restaurantHTTPRequest(t, handler, method, path, input, headers, nil); response.Code != 401 {
				t.Fatalf("geography admin authorization bypass: %d", response.Code)
			}
		}
	}
	saved := restaurantDecodeResponse[restaurantGeographyDistrictResult](t, restaurantHTTPRequest(t, handler, "PUT", "/api/restaurant/geography/district", input, admin, nil), 200)
	if saved.Version != input.Version+1 || !saved.District.Custom {
		t.Fatal("district creation result not versioned")
	}
	if response := restaurantHTTPRequest(t, handler, "PUT", "/api/restaurant/geography/district", input, admin, nil); response.Code != 409 {
		t.Fatalf("stale directory edit accepted: %d", response.Code)
	}
	if response := restaurantHTTPRequest(t, handler, "GET", "/storefront-api/geography?kind=cities&regionId=../", nil, nil, nil); response.Code != 400 {
		t.Fatalf("malformed hierarchy accepted: %d", response.Code)
	}
}

func TestRestaurantReopenHTTPAdminOnlyAndCustomerTracking(t *testing.T) {
	s, handler := restaurantHTTPFixture(t)
	ctx := context.Background()
	catalog, err := s.restaurant.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderInput{Mode: "table", PaymentMethod: "cash_after", TableCode: catalog.Tables[0].Code, Items: []restaurantOrderLineInput{{ItemID: catalog.Items[0].ID, Quantity: 1, OptionIDs: []string{}}}}
	quote, err := s.orders.Quote(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedTotalMinor = quote.TotalMinor
	receipt, err := s.orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := s.orders.SetStatus(ctx, receipt.Order.Number, "cancelled", receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	request := restaurantReopenInput{RequestID: uuid.NewString(), Version: cancelled.Version, Reason: "correct cancellation"}
	path := "/api/restaurant/orders/" + cancelled.Number + "/reopen"
	for _, headers := range []map[string]string{nil, {"X-API-Key": "restaurant-test-widget"}, {"X-Order-Token": receipt.TrackingToken}} {
		if response := restaurantHTTPRequest(t, handler, "POST", path, request, headers, nil); response.Code != 401 {
			t.Fatalf("guest/widget reopened order: %d", response.Code)
		}
	}
	admin := map[string]string{"X-API-Key": "restaurant-test-master"}
	invalid := request
	invalid.Reason = " "
	if response := restaurantHTTPRequest(t, handler, "POST", path, invalid, admin, nil); response.Code != 400 {
		t.Fatalf("blank correction reason accepted: %d", response.Code)
	}
	reopened := restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, handler, "POST", path, request, admin, nil), 200)
	if reopened.Status != "new" || reopened.Version != cancelled.Version+1 {
		t.Fatal("administrative reopen failed")
	}
	tracked := restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, handler, "GET", "/storefront-api/orders/"+cancelled.Number, nil, map[string]string{"X-Order-Token": receipt.TrackingToken}, nil), 200)
	if tracked.Status != "new" || tracked.Version != reopened.Version {
		t.Fatal("customer did not see reopened order")
	}
}
