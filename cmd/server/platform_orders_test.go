package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func platformTestRequest(t *testing.T, private ed25519.PrivateKey, subject, method, path, key, scope string, body any, mutate func(*platformRequestClaims)) *http.Request {
	t.Helper()
	var raw []byte
	if body != nil {
		var err error
		raw, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	digest := sha256.Sum256(raw)
	claims := platformRequestClaims{Issuer: "https://platform.example", Audience: "restaurant-a", Subject: subject,
		Scope: scope, Method: method, Path: path, BodySHA256: hex.EncodeToString(digest[:]), IdempotencyKey: key,
		IssuedAt: time.Now().Unix(), ExpiresAt: time.Now().Unix() + 60}
	if mutate != nil {
		mutate(&claims)
	}
	payload, err := json.Marshal(claims)
	if err != nil {
		t.Fatal(err)
	}
	signature := ed25519.Sign(private, payload)
	r := httptest.NewRequest(method, path, bytes.NewReader(raw))
	r.Header.Set("Authorization", "Platform "+base64.RawURLEncoding.EncodeToString(payload)+"."+base64.RawURLEncoding.EncodeToString(signature))
	if key != "" {
		r.Header.Set("Idempotency-Key", key)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	return r
}

func TestPlatformRequestSignatureBindings(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	auth := &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	subject := uuid.NewString()
	input := map[string]string{"mode": "pickup"}
	raw, _ := json.Marshal(input)
	r := platformTestRequest(t, private, subject, "POST", "/platform-api/orders", "key", "orders:write", input, nil)
	owner, err := auth.verify(r, raw, "orders:write")
	if err != nil || !strings.HasPrefix(owner, "platform:") {
		t.Fatalf("valid signature: %s %v", owner, err)
	}
	for name, mutate := range map[string]func(*platformRequestClaims){
		"audience":    func(c *platformRequestClaims) { c.Audience = "restaurant-b" },
		"issuer":      func(c *platformRequestClaims) { c.Issuer = "https://other.example" },
		"scope":       func(c *platformRequestClaims) { c.Scope = "orders:read" },
		"method":      func(c *platformRequestClaims) { c.Method = "GET" },
		"path":        func(c *platformRequestClaims) { c.Path = "/different" },
		"body":        func(c *platformRequestClaims) { c.BodySHA256 = strings.Repeat("0", 64) },
		"idempotency": func(c *platformRequestClaims) { c.IdempotencyKey = "other-key" },
		"expiry":      func(c *platformRequestClaims) { c.ExpiresAt = time.Now().Unix() - 1 },
		"future":      func(c *platformRequestClaims) { c.IssuedAt = time.Now().Unix() + 120; c.ExpiresAt = c.IssuedAt + 60 },
		"long-life":   func(c *platformRequestClaims) { c.ExpiresAt = c.IssuedAt + 3600 },
		"subject":     func(c *platformRequestClaims) { c.Subject = "merchant-supplied-role" },
	} {
		t.Run(name, func(t *testing.T) {
			r := platformTestRequest(t, private, subject, "POST", "/platform-api/orders", "key", "orders:write", input, mutate)
			if _, err := auth.verify(r, raw, "orders:write"); err == nil {
				t.Fatal("invalid binding accepted")
			}
		})
	}
	_, wrong, _ := ed25519.GenerateKey(rand.Reader)
	r = platformTestRequest(t, wrong, subject, "POST", "/platform-api/orders", "key", "orders:write", input, nil)
	if _, err := auth.verify(r, raw, "orders:write"); err == nil {
		t.Fatal("wrong signer accepted")
	}
}

func TestPlatformOrdersOwnedIdempotentAndMinimal(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	current, err := s.restaurant.GetCatalog(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	catalog := restaurantOrderFixtureCatalog()
	catalog.Version = current.Version
	for i := range catalog.Tables {
		catalog.Tables[i].Code = ""
	}
	if _, err = s.restaurant.SaveCatalog(context.Background(), catalog); err != nil {
		t.Fatal(err)
	}
	actor, other, key := uuid.NewString(), uuid.NewString(), uuid.NewString()
	input := restaurantOrderFixtureInput("delivery")
	input.ExpectedTotalMinor = 3500
	send := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	var number string
	for i := 0; i < 2; i++ {
		w := send(platformTestRequest(t, private, actor, "POST", "/platform-api/orders", key, "orders:write", input, nil))
		if w.Code != 200 {
			t.Fatalf("create: %d %s", w.Code, w.Body.String())
		}
		var view platformOrderView
		if err = json.Unmarshal(w.Body.Bytes(), &view); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			number = view.Number
		} else if number != view.Number {
			t.Fatal("retry duplicated order")
		}
		for _, secret := range []string{"customerName", "trackingToken", "accessCode", "address", "phone"} {
			if strings.Contains(w.Body.String(), secret) {
				t.Fatalf("leaked %s", secret)
			}
		}
	}
	for _, path := range []string{"/platform-api/orders/" + number, "/platform-api/orders/by-idempotency/" + key} {
		if w := send(platformTestRequest(t, private, actor, "GET", path, "", "orders:read", nil, nil)); w.Code != 200 {
			t.Fatalf("owner read: %d %s", w.Code, w.Body.String())
		}
		if w := send(platformTestRequest(t, private, other, "GET", path, "", "orders:read", nil, nil)); w.Code != 404 {
			t.Fatalf("foreign actor read: %d", w.Code)
		}
	}
	w := send(platformTestRequest(t, private, other, "POST", "/platform-api/orders", key, "orders:write", input, nil))
	if w.Code != 409 {
		t.Fatalf("foreign replay: %d", w.Code)
	}
	input.CustomerName = "changed request"
	w = send(platformTestRequest(t, private, actor, "POST", "/platform-api/orders", key, "orders:write", input, nil))
	if w.Code != 409 {
		t.Fatalf("changed retry: %d", w.Code)
	}
	r := platformTestRequest(t, private, actor, "GET", "/platform-api/orders/"+number, "", "orders:read", nil, nil)
	r.Header.Set("Cookie", "untrusted=browser")
	if send(r).Code != 401 {
		t.Fatal("browser context accepted")
	}
	s.platformAuth = nil
	if send(platformTestRequest(t, private, actor, "GET", "/platform-api/orders/"+number, "", "orders:read", nil, nil)).Code != 404 {
		t.Fatal("disabled service exposed")
	}
	var count int
	if err = s.restaurant.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 1 {
		t.Fatalf("order count %d %v", count, err)
	}
}

func TestPlatformAuthConfigurationFailsClosed(t *testing.T) {
	for _, name := range []string{"WACALLS_PLATFORM_ISSUER", "WACALLS_PLATFORM_TENANT_ID", "WACALLS_PLATFORM_PUBLIC_KEY"} {
		t.Setenv(name, "")
	}
	if config, err := platformAuthFromEnv(); err != nil || config != nil {
		t.Fatal("unset integration not disabled")
	}
	t.Setenv("WACALLS_PLATFORM_ISSUER", "https://platform.example")
	if _, err := platformAuthFromEnv(); err == nil {
		t.Fatal("partial configuration accepted")
	}
	public, _, _ := ed25519.GenerateKey(rand.Reader)
	t.Setenv("WACALLS_PLATFORM_TENANT_ID", "restaurant-a")
	t.Setenv("WACALLS_PLATFORM_PUBLIC_KEY", base64.StdEncoding.EncodeToString(public))
	if _, err := platformAuthFromEnv(); err != nil {
		t.Fatal(err)
	}
}

func TestPlatformOrderNodeSignatureCompatibility(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" {
		t.Skip("set TEST_CORE_ADAPTER=1 after installing Node dependencies")
	}
	s, h := restaurantHTTPFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	current, err := s.restaurant.GetCatalog(context.Background(), false)
	if err != nil {
		t.Fatal(err)
	}
	catalog := restaurantOrderFixtureCatalog()
	catalog.Version = current.Version
	for i := range catalog.Tables {
		catalog.Tables[i].Code = ""
	}
	if _, err = s.restaurant.SaveCatalog(context.Background(), catalog); err != nil {
		t.Fatal(err)
	}
	service := httptest.NewServer(h)
	defer service.Close()
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	input := map[string]any{"mode": "delivery", "customerName": "Synthetic", "phone": "+966501234567",
		"address": map[string]string{"country": "SA", "nationalAddress": "ABCD1234"}, "paymentMethod": "cash_on_delivery",
		"items": []restaurantOrderLineInput{{ItemID: "rice", Quantity: 2, OptionIDs: []string{"extra", "free"}}}, "expectedTotalMinor": 3500}
	fixture, err := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "input": input})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "integration/core-orders-check.mjs")
	command.Dir = filepath.Join("..", "..", "prototype", "platform")
	command.Env = append(os.Environ(), "CORE_ORDER_FIXTURE="+string(fixture))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("signed integration: %v\n%s", err, output)
	}
	t.Log(string(output))
	if os.Getenv("IDENTITY_TEST_DATABASE_URL") != "" {
		flow := exec.CommandContext(ctx, "node", "integration/core-control-check.mjs")
		flow.Dir = command.Dir
		flow.Env = command.Env
		output, err = flow.CombinedOutput()
		if err != nil {
			t.Fatalf("owned checkout flow: %v\n%s", err, output)
		}
		t.Log(string(output))
		var count int
		if err = s.restaurant.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 2 {
			t.Fatalf("two independent integration flows should create exactly two orders: %d %v", count, err)
		}
	}
}
