package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestRemovedMessagingRoutesNeverServeApplication(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("restaurant-app"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("WACALLS_API_KEY", "synthetic-admin")
	s := &server{staticDir: dir, restaurant: &restaurantStore{}, orders: &restaurantOrders{}, customers: &restaurantAccounts{}}
	h := s.routes()
	for _, path := range []string{"/api/sessions", "/api/sessions/test/pair", "/api/sessions/test/messages/text", "/api/events", "/webhooks/whatsapp/test", "/admin/calls", "/widget.js", "/astracalls-passkey.zip", "/api/restaurant/archive"} {
		for _, method := range []string{http.MethodGet, http.MethodPost} {
			req := httptest.NewRequest(method, path, nil)
			req.Header.Set("X-API-Key", "synthetic-admin")
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != 404 && w.Code != 405 {
				t.Fatalf("removed %s %s returned %d", method, path, w.Code)
			}
		}
	}
}

func TestOnlyActiveChannelsReturnedWithLegacyRowsPreserved(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	// Simulate the old schema without deleting any historical channel/audit data.
	_, err := db.Exec(`CREATE TABLE restaurant_order_channels(channel TEXT PRIMARY KEY,new_orders_enabled BOOLEAN NOT NULL,version BIGINT NOT NULL DEFAULT 1,updated_at TIMESTAMPTZ NOT NULL DEFAULT now()); INSERT INTO restaurant_order_channels(channel,new_orders_enabled) VALUES ('whatsapp_qr',true),('whatsapp_cloud',false)`)
	if err != nil {
		t.Fatal(err)
	}
	if err = initRestaurantOrderChannels(ctx, db); err != nil {
		t.Fatal(err)
	}
	orders := &restaurantOrders{store: &restaurantStore{db: db}}
	rows, err := orders.OrderChannels(ctx)
	if err != nil || len(rows) != 2 {
		t.Fatalf("active channels: %v %v", rows, err)
	}
	for _, row := range rows {
		if row.Channel != "web" && row.Channel != "chatgpt" {
			t.Fatal("retired channel exposed")
		}
	}
	var n int
	if err = db.QueryRow(`SELECT count(*) FROM restaurant_order_channels WHERE channel LIKE 'whatsapp_%'`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("legacy rows changed: %d %v", n, err)
	}
	_, err = orders.SetOrderChannel(ctx, "whatsapp_qr", "owner", true, 1)
	restaurantOrdersRequireError(t, err, "invalid_request")
}
