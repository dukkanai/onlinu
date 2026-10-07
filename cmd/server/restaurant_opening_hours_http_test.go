package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRestaurantOpeningScheduleSignedScopesAndPublicSnapshot(t *testing.T) {
	s, handler := restaurantHTTPFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	actor := uuid.NewString()
	path := "/platform-api/staff/opening-schedule"
	for _, scope := range []string{"orders:read", "staff:settings:update", "staff:tax:read"} {
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, platformTestRequest(t, private, actor, "GET", path, "", scope, nil, nil))
		if response.Code != 401 {
			t.Fatal("wrong read scope accepted", scope, response.Code)
		}
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(t, private, actor, "GET", path, "", "staff:settings:read", nil, nil))
	if response.Code != 200 {
		t.Fatal(response.Code, response.Body.String())
	}
	var current restaurantOpeningSchedule
	if err := json.Unmarshal(response.Body.Bytes(), &current); err != nil || current.Version != 1 || current.Enabled {
		t.Fatal("bad schedule response", err, response.Body.String())
	}
	status := httptest.NewRecorder()
	handler.ServeHTTP(status, httptest.NewRequest("GET", "/storefront-api/opening-status", nil))
	var before restaurantOpeningStatus
	if status.Code != 200 || json.Unmarshal(status.Body.Bytes(), &before) != nil || before.WithinHours != nil {
		t.Fatal("disabled schedule invented public hours", status.Code, status.Body.String())
	}
	patch := map[string]any{"expectedVersion": 1, "reviewed": true, "enabled": true, "timeZone": "Asia/Riyadh", "weekly": make([][]restaurantOpeningWindow, 7), "exceptions": []restaurantOpeningException{}}
	missing := map[string]any{"expectedVersion": 1, "enabled": true, "timeZone": "Asia/Riyadh", "weekly": make([][]restaurantOpeningWindow, 7)}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(t, private, actor, "POST", path, "", "staff:settings:update", missing, nil))
	if response.Code != 400 {
		t.Fatal("unreviewed policy accepted", response.Code)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(t, private, actor, "POST", path, "", "staff:settings:read", patch, nil))
	if response.Code != 401 {
		t.Fatal("read-only actor changed schedule", response.Code)
	}
	response = httptest.NewRecorder()
	handler.ServeHTTP(response, platformTestRequest(t, private, actor, "POST", path, "", "staff:settings:update", patch, nil))
	if response.Code != 200 {
		t.Fatal("reviewed policy failed", response.Code, response.Body.String())
	}
	status = httptest.NewRecorder()
	handler.ServeHTTP(status, httptest.NewRequest("GET", "/storefront-api/opening-status", nil))
	var after restaurantOpeningStatus
	if status.Code != 200 || json.Unmarshal(status.Body.Bytes(), &after) != nil || after.AcceptingOrders || after.WithinHours == nil || *after.WithinHours || after.Version != 2 {
		t.Fatal("closed status mismatch", status.Code, status.Body.String())
	}
	if status.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("time-dependent status was cacheable")
	}
	status = httptest.NewRecorder()
	handler.ServeHTTP(status, httptest.NewRequest("GET", "/storefront-api/opening-status?at=arbitrary", nil))
	if status.Code != 400 {
		t.Fatal("caller selected the status clock")
	}
}
