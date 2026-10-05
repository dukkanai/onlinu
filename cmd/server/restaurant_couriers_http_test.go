package main

import (
	"context"
	"net/http"
	"strings"
	"testing"
)

func TestRestaurantCourierHTTPAuthCookiesAndRedaction(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	var err error
	s.couriers, err = newRestaurantCouriers(context.Background(), s.restaurant.db, s.orders)
	if err != nil {
		t.Fatal(err)
	}
	admin := map[string]string{"X-API-Key": "restaurant-test-master"}
	for _, headers := range []map[string]string{nil, {"X-API-Key": "restaurant-test-widget"}, {"X-API-Key": "incorrect"}} {
		w := restaurantHTTPRequest(t, h, "GET", "/api/restaurant/couriers", nil, headers, nil)
		if w.Code != 401 {
			t.Fatalf("courier admin list was not master-only: %d", w.Code)
		}
	}
	w := restaurantHTTPRequest(t, h, "GET", "/api/restaurant/couriers?apiKey=restaurant-test-master", nil, nil, nil)
	if w.Code != 401 {
		t.Fatal("query-only master credential accepted by courier management")
	}
	created := restaurantHTTPRequest(t, h, "POST", "/api/restaurant/couriers", map[string]any{"username": "http-driver", "name": "HTTP Driver", "phone": "+966500000000", "password": "courier HTTP test password"}, admin, nil)
	result := restaurantDecodeResponse[struct {
		Courier restaurantCourier `json:"courier"`
	}](t, created, 201)
	if result.Courier.ID == "" || strings.Contains(created.Body.String(), "password") {
		t.Fatal("courier create leaked password or lacked identity")
	}
	account := restaurantHTTPRequest(t, h, "GET", "/courier-api/account", nil, nil, nil)
	if account.Code != 200 || !strings.Contains(account.Body.String(), `"courier":null`) {
		t.Fatal("guest courier account did not return null")
	}
	for _, path := range []string{"/courier-api/orders", "/courier-api/orders?apiKey=restaurant-test-master"} {
		if w := restaurantHTTPRequest(t, h, "GET", path, nil, admin, nil); w.Code != 401 {
			t.Fatal("master key was accepted as a courier login")
		}
	}
	login := restaurantHTTPRequest(t, h, "POST", "/courier-api/login", map[string]string{"username": "http-driver", "password": "courier HTTP test password"}, nil, nil)
	restaurantDecodeResponse[struct {
		Courier restaurantCourier `json:"courier"`
	}](t, login, 200)
	cookies := login.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatalf("expected one courier cookie, got %d", len(cookies))
	}
	cookie := cookies[0]
	if cookie.Name != restaurantCourierCookieName() || cookie.Name == restaurantSessionCookieName() || cookie.Path != "/courier-api" || !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Domain != "" || cookie.MaxAge != 604800 {
		t.Fatalf("unsafe courier cookie metadata: %+v", *cookie)
	}
	if strings.Contains(login.Body.String(), cookie.Value) || strings.Contains(login.Body.String(), "password") {
		t.Fatal("courier JSON returned a credential")
	}
	w = restaurantHTTPRequest(t, h, "PATCH", "/courier-api/account", map[string]string{"availability": "available"}, nil, cookie)
	current := restaurantDecodeResponse[struct {
		Courier restaurantCourier `json:"courier"`
	}](t, w, 200)
	if current.Courier.Availability != "available" {
		t.Fatal("availability patch failed")
	}
	w = restaurantHTTPRequest(t, h, "PATCH", "/courier-api/account", map[string]string{"availability": "offline"}, map[string]string{"Origin": "https://attacker.invalid"}, cookie)
	if w.Code != 403 {
		t.Fatal("cross-origin courier mutation was accepted")
	}
	_, customerToken, err := s.customers.Register(context.Background(), "customer-alone", "customer HTTP test password", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, foreignCookie := range []*http.Cookie{{Name: restaurantSessionCookieName(), Value: customerToken}, {Name: restaurantCourierCookieName(), Value: customerToken}} {
		if w := restaurantHTTPRequest(t, h, "GET", "/courier-api/orders", nil, nil, foreignCookie); w.Code != 401 {
			t.Fatal("customer session crossed courier boundary")
		}
	}
	receipt := restaurantCourierCreateOrder(t, s.orders)
	w = restaurantHTTPRequest(t, h, "POST", "/api/restaurant/orders/"+receipt.Order.Number+"/courier", map[string]any{"courierId": result.Courier.ID, "version": receipt.Order.Version}, admin, nil)
	assigned := restaurantDecodeResponse[restaurantOrder](t, w, 200)
	w = restaurantHTTPRequest(t, h, "GET", "/courier-api/orders", nil, nil, cookie)
	listed := restaurantDecodeResponse[struct {
		Orders []restaurantOrder `json:"orders"`
	}](t, w, 200)
	if len(listed.Orders) != 1 || listed.Orders[0].Number != assigned.Number || strings.Contains(w.Body.String(), receipt.TrackingToken) || strings.Contains(w.Body.String(), receipt.AccessCode) || strings.Contains(w.Body.String(), "trackingToken") || strings.Contains(w.Body.String(), "accessCode") {
		t.Fatal("courier order listing exposed receipt credentials or wrong records")
	}
	locationPath := "/courier-api/orders/" + assigned.Number + "/location"
	locationInput := restaurantLocationTestInput(assigned.Version)
	if w = restaurantHTTPRequest(t, h, "POST", locationPath, locationInput, admin, nil); w.Code != 401 {
		t.Fatal("master header substituted for courier location consent")
	}
	if w = restaurantHTTPRequest(t, h, "POST", locationPath, locationInput, map[string]string{"Origin": "https://attacker.invalid"}, cookie); w.Code != 403 {
		t.Fatal("cross-origin location publish accepted")
	}
	w = restaurantHTTPRequest(t, h, "POST", locationPath, locationInput, nil, cookie)
	point := restaurantDecodeResponse[restaurantLocationResult](t, w, 200)
	if point.Location == nil {
		t.Fatal("authorized courier location missing")
	}
	publicLocationPath := "/storefront-api/orders/" + assigned.Number + "/location"
	for _, headers := range []map[string]string{nil, admin, {"X-Order-Token": "wrong"}} {
		if w = restaurantHTTPRequest(t, h, "GET", publicLocationPath, nil, headers, nil); w.Code != 404 {
			t.Fatal("public location disclosed without receipt ownership")
		}
	}
	w = restaurantHTTPRequest(t, h, "GET", publicLocationPath, nil, map[string]string{"X-Order-Token": receipt.TrackingToken}, nil)
	if restaurantDecodeResponse[restaurantLocationResult](t, w, 200).Location == nil {
		t.Fatal("receipt owner could not read point")
	}
	w = restaurantHTTPRequest(t, h, "GET", "/api/restaurant/orders/"+assigned.Number+"/location", nil, admin, nil)
	if restaurantDecodeResponse[restaurantLocationResult](t, w, 200).Location == nil {
		t.Fatal("master admin could not read point")
	}
	stopInput := map[string]any{"version": assigned.Version}
	if w = restaurantHTTPRequest(t, h, "DELETE", locationPath, stopInput, map[string]string{"Origin": "https://attacker.invalid"}, cookie); w.Code != 403 {
		t.Fatal("cross-origin location stop accepted")
	}
	if w = restaurantHTTPRequest(t, h, "DELETE", locationPath, stopInput, nil, cookie); w.Code != 204 {
		t.Fatalf("stop failed: %d", w.Code)
	}
	if w = restaurantHTTPRequest(t, h, "POST", locationPath, locationInput, nil, cookie); w.Code != 409 {
		t.Fatal("old publish resurrected stopped point")
	}
	w = restaurantHTTPRequest(t, h, "GET", publicLocationPath, nil, map[string]string{"X-Order-Token": receipt.TrackingToken}, nil)
	if restaurantDecodeResponse[restaurantLocationResult](t, w, 200).Location != nil {
		t.Fatal("stopped point remains visible")
	}
	reset := restaurantHTTPRequest(t, h, "PATCH", "/api/restaurant/couriers/"+result.Courier.ID, map[string]any{"password": "new courier HTTP password"}, admin, nil)
	if reset.Code != 200 {
		t.Fatalf("admin password reset failed: %d", reset.Code)
	}
	if w := restaurantHTTPRequest(t, h, "GET", "/courier-api/orders", nil, nil, cookie); w.Code != 401 {
		t.Fatal("HTTP password reset did not revoke old session")
	}
	w = restaurantHTTPRequest(t, h, "POST", "/courier-api/logout", map[string]any{}, nil, cookie)
	if w.Code != 204 || len(w.Result().Cookies()) != 1 || w.Result().Cookies()[0].MaxAge >= 0 {
		t.Fatal("courier logout did not expire its cookie")
	}
	firstName := restaurantCourierCookieName()
	t.Setenv("WACALLS_API_KEY", "different-instance-test-key")
	if restaurantCourierCookieName() == firstName {
		t.Fatal("courier cookie namespace is shared across installations")
	}
}
