package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

func TestPlatformCourierNodeAndDartIsolation(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" || os.Getenv("IDENTITY_TEST_DATABASE_URL") == "" {
		t.Skip("requires isolated Go/Node/Postgres fixture")
	}
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
	s, h := restaurantHTTPFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	s.couriers, err = newRestaurantCouriers(context.Background(), s.restaurant.db, s.orders)
	if err != nil {
		t.Fatal(err)
	}
	a := restaurantCourierCreateTest(t, s.couriers, "native-owned-a")
	b := restaurantCourierCreateTest(t, s.couriers, "native-owned-b")
	first := restaurantCourierCreateOrder(t, s.orders)
	second := restaurantCourierCreateOrder(t, s.orders)
	one := restaurantCourierReady(t, s.orders, first.Order)
	two := restaurantCourierReady(t, s.orders, second.Order)
	service := httptest.NewServer(h)
	defer service.Close()
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "courierA": a.ID, "courierB": b.ID, "orderA": one.Number, "orderB": two.Number})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "integration/courier-control-check.mjs")
	command.Dir = filepath.Join("..", "..", "prototype", "platform")
	command.Env = append(os.Environ(), "CORE_COURIER_FIXTURE="+string(fixture))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("native courier fixture: %v\n%s", err, output)
	}
	t.Log(string(output))
	current, err := s.orders.Track(context.Background(), two.Number, second.TrackingToken, "", "")
	if err != nil || current.DeliveryStatus != "assigned" || current.Payment.Status != "unpaid" {
		t.Fatal("other courier order was changed", err)
	}
}
