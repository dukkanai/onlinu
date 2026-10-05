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
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync/atomic"
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
	for _, path := range []string{"/platform-api/orders/" + number, "/platform-api/orders/by-idempotency/" + key, "/platform-api/order-details/" + number} {
		if w := send(platformTestRequest(t, private, actor, "GET", path, "", "orders:read", nil, nil)); w.Code != 200 {
			t.Fatalf("owner read: %d %s", w.Code, w.Body.String())
		}
		if w := send(platformTestRequest(t, private, other, "GET", path, "", "orders:read", nil, nil)); w.Code != 404 {
			t.Fatalf("foreign actor read: %d", w.Code)
		}
	}
	details := send(platformTestRequest(t, private, actor, "GET", "/platform-api/order-details/"+number, "", "orders:read", nil, nil))
	var summary platformOrderDetails
	if err = json.Unmarshal(details.Body.Bytes(), &summary); err != nil || len(summary.Items) != 1 || summary.SubtotalMinor != 3000 || summary.DeliveryFeeMinor != 500 {
		t.Fatal("invalid owned financial summary", err)
	}
	for _, secret := range []string{"customerName", "phone", "address", "trackingToken", "accessCode"} {
		if strings.Contains(details.Body.String(), secret) {
			t.Fatalf("owned summary leaked %s", secret)
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
	probe := platformTestRequest(t, private, actor, "GET", "/platform-api/orders/"+number, "", "orders:read", nil, nil)
	owner, err := s.platformAuth.verify(probe, nil, "orders:read")
	if err != nil {
		t.Fatal(err)
	}
	feed, err := s.orders.platformEvents(context.Background(), owner, 0, 100)
	if err != nil || len(feed) != 1 || feed[0].Sequence != 1 {
		t.Fatalf("initial outbox: %+v %v", feed, err)
	}
	order, err := s.orders.Track(context.Background(), number, "", "", owner)
	if err != nil {
		t.Fatal(err)
	}
	tx, err := s.restaurant.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	order.Version++
	order.UpdatedAt = time.Now().UTC()
	if err = restaurantUpdateOrder(context.Background(), tx, order); err != nil {
		t.Fatal(err)
	}
	if err = restaurantWriteOrderEvent(context.Background(), tx, order, "test", map[string]string{"fixture": "rollback"}); err != nil {
		t.Fatal(err)
	}
	if err = tx.Rollback(); err != nil {
		t.Fatal(err)
	}
	if _, err = s.orders.SetStatus(context.Background(), number, "accepted", 1); err != nil {
		t.Fatal(err)
	}
	feed, err = s.orders.platformEvents(context.Background(), owner, 0, 100)
	if err != nil || len(feed) != 2 || feed[1].Sequence != 2 || feed[1].Order.Status != "accepted" {
		t.Fatalf("rollback consumed cursor: %+v %v", feed, err)
	}
	staffPath := "/platform-api/staff/orders"
	if send(platformTestRequest(t, private, actor, "GET", staffPath, "", "orders:read", nil, nil)).Code != 401 {
		t.Fatal("customer scope elevated to staff")
	}
	listed := send(platformTestRequest(t, private, actor, "GET", staffPath, "", "staff:orders:read", nil, nil))
	if listed.Code != 200 || strings.Contains(listed.Body.String(), `"phone"`) || strings.Contains(listed.Body.String(), `"customerName"`) {
		t.Fatalf("staff summary exposure: %d %s", listed.Code, listed.Body.String())
	}
	_, err = s.restaurant.db.Exec(`CREATE FUNCTION reject_platform_staff_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure';END $$;
		CREATE TRIGGER reject_platform_staff_audit BEFORE INSERT ON platform_staff_order_audit FOR EACH ROW EXECUTE FUNCTION reject_platform_staff_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	changePath := staffPath + "/" + number + "/status"
	change := map[string]any{"status": "preparing", "version": 2}
	if send(platformTestRequest(t, private, actor, "POST", changePath, "", "staff:orders:update", change, nil)).Code != 500 {
		t.Fatal("staff operation ignored failed transactional audit")
	}
	unchanged, err := s.orders.Track(context.Background(), number, "", "", owner)
	if err != nil || unchanged.Version != 2 || unchanged.Status != "accepted" {
		t.Fatal("failed audit did not roll back order")
	}
	if _, err = s.restaurant.db.Exec("DROP TRIGGER reject_platform_staff_audit ON platform_staff_order_audit"); err != nil {
		t.Fatal(err)
	}
	changed := send(platformTestRequest(t, private, actor, "POST", changePath, "", "staff:orders:update", change, nil))
	if changed.Code != 200 {
		t.Fatalf("staff change: %d %s", changed.Code, changed.Body.String())
	}
	var auditActor, auditScope string
	if err = s.restaurant.db.QueryRow("SELECT actor_id,scope FROM platform_staff_order_audit WHERE order_number=$1 AND version=3", number).Scan(&auditActor, &auditScope); err != nil || auditActor != owner || auditScope != "staff:orders:update" {
		t.Fatal("missing staff attribution", err)
	}
	feed, err = s.orders.platformEvents(context.Background(), owner, 0, 100)
	if err != nil || len(feed) != 3 || feed[2].Sequence != 3 {
		t.Fatal("failed staff audit consumed outbox sequence", err)
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
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
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
	payments, err := newRestaurantPayments(context.Background(), s.restaurant.db, s.orders, "https://restaurant.test")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = payments.Configure(context.Background(), "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_unit_only"}}); err != nil {
		t.Fatal(err)
	}
	s.payments = payments
	s.orders.PaymentAvailable = payments.Available
	var calls atomic.Int32
	var attempt atomic.Value
	payments.adapter = &restaurantPaymentFakeAdapter{
		create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			calls.Add(1)
			attempt.Store(r.AttemptID)
			return restaurantPaymentRemote{ID: "cs_test_signed", URL: "https://checkout.stripe.com/c/test", Status: "paid", Currency: "SAR", AmountMinor: 3000, Reference: r.AttemptID}, nil
		},
		fetch: func(_ context.Context, _ restaurantPaymentConfig, id, reference string) (restaurantPaymentRemote, error) {
			if id != "cs_test_signed" || reference != attempt.Load() {
				t.Error("unbound payment verification")
			}
			return restaurantPaymentRemote{ID: id, Status: "paid", Currency: "SAR", AmountMinor: 3000, Reference: reference}, nil
		},
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
	fixture, err := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der})), "input": input, "imageBase64": base64.StdEncoding.EncodeToString(platformImageFixture(t))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
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
		if err = s.restaurant.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 3 {
			t.Fatalf("integration flows should create exactly three orders including browser card checkout: %d %v", count, err)
		}
	}
	paymentFlow := exec.CommandContext(ctx, "node", "integration/core-payment-check.mjs")
	paymentFlow.Dir = command.Dir
	paymentFlow.Env = command.Env
	output, err = paymentFlow.CombinedOutput()
	if err != nil {
		t.Fatalf("signed payment integration: %v\n%s", err, output)
	}
	expectedCalls := int32(1)
	if os.Getenv("IDENTITY_TEST_DATABASE_URL") != "" {
		expectedCalls++
	}
	if calls.Load() != expectedCalls {
		t.Fatalf("duplicate provider invocation: %d", calls.Load())
	}
	t.Log(string(output))
}

func platformImageFixture(t *testing.T) []byte {
	t.Helper()
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 3, 3))); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes()
}
func TestPlatformStaffImagesRawSignatureAndNormalization(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	actor := uuid.NewString()
	send := func(raw []byte, scope string, tamper bool) *httptest.ResponseRecorder {
		digest := sha256.Sum256(raw)
		r := platformTestRequest(t, private, actor, "POST", "/platform-api/staff/images", "", scope, nil, func(claims *platformRequestClaims) { claims.BodySHA256 = hex.EncodeToString(digest[:]) })
		if tamper {
			raw = append(append([]byte{}, raw...), 1)
		}
		r.Body = io.NopCloser(bytes.NewReader(raw))
		r.ContentLength = int64(len(raw))
		r.Header.Set("Content-Type", "application/octet-stream")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	raw := append(platformImageFixture(t), []byte("PRIVATE-TRAILER")...)
	if w := send(raw, "orders:write", false); w.Code != 401 {
		t.Fatal("customer scope could upload", w.Code)
	}
	if w := send(raw, "staff:media:write", true); w.Code != 401 {
		t.Fatal("tampered bytes accepted", w.Code)
	}
	if w := send([]byte("<svg/>"), "staff:media:write", false); w.Code != 400 {
		t.Fatal("SVG accepted", w.Code)
	}
	if w := send(make([]byte, restaurantImageLimit+1), "staff:media:write", false); w.Code != 413 {
		t.Fatal("oversized raw upload accepted", w.Code)
	}
	w := send(raw, "staff:media:write", false)
	if w.Code != 201 {
		t.Fatal(w.Code, w.Body.String())
	}
	var result map[string]string
	if err = json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	fetched := httptest.NewRecorder()
	h.ServeHTTP(fetched, httptest.NewRequest("GET", result["url"], nil))
	if fetched.Code != 200 || bytes.Contains(fetched.Body.Bytes(), []byte("PRIVATE-TRAILER")) {
		t.Fatal("uploaded bytes were not normalized")
	}
}
