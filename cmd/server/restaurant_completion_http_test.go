package main

import (
	"context"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func TestRestaurantCompletionHTTPPrivateBoundaries(t *testing.T) {
	_, h := restaurantHTTPFixture(t)
	for _, path := range []string{"/api/restaurant/stock", "/api/restaurant/brand", "/api/restaurant/archive/policy", "/api/restaurant/orders/absent/refunds"} {
		for _, headers := range []map[string]string{nil, {"X-API-Key": "restaurant-test-widget"}} {
			w := restaurantHTTPRequest(t, h, http.MethodGet, path, nil, headers, nil)
			if w.Code != 401 {
				t.Fatalf("private endpoint %s status %d", path, w.Code)
			}
		}
		if w := restaurantHTTPRequest(t, h, http.MethodGet, path+"?apiKey=restaurant-test-master", nil, nil, nil); w.Code != 401 {
			t.Fatalf("URL key authorized %s", path)
		}
	}
	for _, headers := range []map[string]string{nil, {"X-API-Key": "restaurant-test-widget"}} {
		w := restaurantHTTPRequest(t, h, http.MethodGet, "/recordings/example.mp3", nil, headers, nil)
		if w.Code != 404 {
			t.Fatalf("removed recording route unexpectedly available: %d", w.Code)
		}
		if w.Header().Get("Access-Control-Allow-Origin") != "" {
			t.Fatal("recording allowed wildcard cross-origin access")
		}
	}
}

func TestRestaurantCompletionHTTPGuestStockCancellation(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	admin := map[string]string{"X-API-Key": "restaurant-test-master"}
	catalog := restaurantDecodeResponse[restaurantCatalog](t, restaurantHTTPRequest(t, h, "GET", "/api/restaurant/catalog", nil, admin, nil), 200)
	product := catalog.Items[0].ID
	stock := restaurantDecodeResponse[restaurantStockItem](t, restaurantHTTPRequest(t, h, "PUT", "/api/restaurant/stock/"+product, restaurantStockInput{Tracked: true, Available: 1}, admin, nil), 200)
	if stock.Available != 1 || !stock.Tracked {
		t.Fatal("stock not set")
	}
	in := restaurantOrderInput{Mode: "table", PaymentMethod: "cash_after", CustomerName: "Synthetic guest", TableCode: catalog.Tables[0].Code, Items: []restaurantOrderLineInput{{ItemID: product, Quantity: 1}}}
	quote := restaurantDecodeResponse[restaurantQuote](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/quote", in, nil, nil), 200)
	in.ExpectedTotalMinor = quote.TotalMinor
	createHeaders := map[string]string{"Idempotency-Key": uuid.NewString()}
	receipt := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", in, createHeaders, nil), 201)
	if receipt.Order.StockExpiresAt == nil {
		t.Fatal("no persisted reservation deadline")
	}
	path := "/storefront-api/orders/" + receipt.Order.Number + "/cancel"
	body := map[string]any{"reason": "Changed plans before preparation", "version": receipt.Order.Version}
	key := uuid.NewString()
	if w := restaurantHTTPRequest(t, h, "POST", path, body, map[string]string{"Idempotency-Key": key}, nil); w.Code != 404 {
		t.Fatalf("order number authorized cancellation: %d", w.Code)
	}
	headers := map[string]string{"X-Order-Token": receipt.TrackingToken, "Idempotency-Key": key}
	cancelled := restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, h, "POST", path, body, headers, nil), 200)
	if cancelled.Status != "cancelled" || cancelled.Cancellation == nil || cancelled.Cancellation.Status != "approved" {
		t.Fatal("early cancellation not approved")
	}
	retry := restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, h, "POST", path, body, headers, nil), 200)
	if retry.Version != cancelled.Version {
		t.Fatal("retry changed order again")
	}
	items, err := s.orders.ListStock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, item := range items {
		if item.ItemID == product && (item.Available != 1 || item.Held != 0) {
			t.Fatal("cancellation did not release exactly one portion")
		}
	}
	problemPath := "/storefront-api/orders/" + receipt.Order.Number + "/complaints"
	complaintHeaders := map[string]string{"X-Order-Token": receipt.TrackingToken, "Idempotency-Key": uuid.NewString()}
	complaint := restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, h, "POST", problemPath, map[string]any{"reason": "Question about cancellation", "version": cancelled.Version}, complaintHeaders, nil), 200)
	if len(complaint.Complaints) != 1 || complaint.Complaints[0].Status != "open" {
		t.Fatal("protected complaint not recorded")
	}
}
