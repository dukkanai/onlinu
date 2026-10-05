package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"testing"
)

const fixtureToken = "synthetic-service-test-token-32-characters"

func fixture(t *testing.T, tenant string) *service {
	t.Helper()
	raw := os.Getenv("TENANT_TEST_DATABASE_URL")
	if raw == "" {
		t.Skip("TENANT_TEST_DATABASE_URL not set; PostgreSQL integration case not run")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Path != "/astracalls_tenant_prototype_test" || u.Query().Get("dbname") != "" {
		t.Fatal("refusing non-disposable test database")
	}
	db, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal("test database open failed")
	}
	t.Cleanup(func() { _ = db.Close() })
	var database string
	if err = db.QueryRow(`SELECT current_database()`).Scan(&database); err != nil || database != "astracalls_tenant_prototype_test" {
		t.Fatal("refusing unexpected test database")
	}
	id, err := randomID()
	if err != nil {
		t.Fatal(err)
	}
	schemaName := "tenant_test_" + id
	if _, err = db.Exec(`CREATE SCHEMA "` + schemaName + `"`); err != nil {
		t.Fatal("test schema create failed")
	}
	t.Cleanup(func() {
		if _, err := db.Exec(`DROP SCHEMA "` + schemaName + `" CASCADE`); err != nil {
			t.Error("test schema cleanup failed")
		}
	})
	query := u.Query()
	query.Set("search_path", schemaName)
	u.RawQuery = query.Encode()
	s, err := openService(context.Background(), config{TenantID: tenant, Token: fixtureToken, DatabaseURL: u.String(), Synthetic: true})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.db.Close() })
	return s
}

func request(s *service, method, path, role, id string, body any) *httptest.ResponseRecorder {
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(raw))
	r.Header.Set("Authorization", "Bearer "+s.token)
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("X-Actor-Role", role)
	r.Header.Set("X-Actor-ID", id)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	return w
}

func expectCode(t *testing.T, w *httptest.ResponseRecorder, status int, code string) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("HTTP %d wanted %d: %s", w.Code, status, w.Body.String())
	}
	if code != "" {
		var got struct {
			Error string `json:"error"`
		}
		if json.Unmarshal(w.Body.Bytes(), &got) != nil || got.Error != code {
			t.Fatalf("expected error %s: %s", code, w.Body.String())
		}
	}
}

func decodeOrder(t *testing.T, w *httptest.ResponseRecorder) order {
	t.Helper()
	var out order
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func purchase(t *testing.T, s *service, key string) order {
	t.Helper()
	price := int64(3000)
	if s.tenantID == "demo-b" {
		price = 4500
	}
	w := request(s, "POST", "/orders", "customer", "customer-alice", orderInput{[]lineInput{{"meal", 1}}, price, key})
	expectCode(t, w, 201, "")
	return decodeOrder(t, w)
}

func TestValidationAndCredentialBoundary(t *testing.T) {
	s := &service{tenantID: "demo-a", token: fixtureToken, synthetic: true}
	r := httptest.NewRequest("GET", "/menu", nil)
	w := httptest.NewRecorder()
	s.ServeHTTP(w, r)
	expectCode(t, w, 401, "unauthorized")
	r.Header.Set("Authorization", "Bearer another-restaurant-service-token")
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	expectCode(t, w, 401, "unauthorized")
	for _, body := range []string{`{"items":[],"tenantId":"demo-b"}`, `{"items":[{"itemId":"meal","quantity":1,"priceMinor":1}]}`, `{"items":[]} {}`, `{"items":[{"itemId":"meal","quantity":1.5}]}`} {
		r = httptest.NewRequest("POST", "/quote", strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("Authorization", "Bearer "+fixtureToken)
		w = httptest.NewRecorder()
		s.ServeHTTP(w, r)
		expectCode(t, w, 400, "invalid_json")
	}
	r = httptest.NewRequest("POST", "/quote", strings.NewReader(`{"items":[],"extra":"`+strings.Repeat("a", 40<<10)+`"}`))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+fixtureToken)
	w = httptest.NewRecorder()
	s.ServeHTTP(w, r)
	expectCode(t, w, 413, "body_too_large")
	for _, items := range [][]lineInput{nil, {{"meal", 0}}, {{"meal", 21}}, {{"meal", 1}, {"meal", 2}}, {{"bad/id", 1}}} {
		if _, err := normalizeLines(items); err == nil {
			t.Fatalf("accepted invalid items %+v", items)
		}
	}
	for _, role := range []string{"merchant", "service"} {
		expectCode(t, request(s, "POST", "/orders", role, "merchant-a", nil), 403, "forbidden")
	}
	expectCode(t, request(s, "GET", "/orders", "merchant", "merchant-b", nil), 403, "forbidden")
	expectCode(t, request(s, "GET", "/events", "customer", "customer-alice", nil), 403, "forbidden")
	for _, q := range []string{"after=-1", "limit=0", "limit=101", "after=no", "limit=1&limit=2", "unexpected=1"} {
		expectCode(t, request(s, "GET", "/events?"+q, "service", "platform", nil), 400, "invalid_cursor")
	}
}

func TestPostgresIdempotencyDurabilityAndConcurrentReservation(t *testing.T) {
	s := fixture(t, "demo-a")
	input := orderInput{[]lineInput{{"meal", 1}}, 3000, "same-checkout-key"}
	const count = 16
	results := make(chan *httptest.ResponseRecorder, count)
	var wg sync.WaitGroup
	for range count {
		wg.Add(1)
		go func() { defer wg.Done(); results <- request(s, "POST", "/orders", "customer", "customer-alice", input) }()
	}
	wg.Wait()
	close(results)
	id := ""
	for w := range results {
		expectCode(t, w, 201, "")
		o := decodeOrder(t, w)
		if id == "" {
			id = o.ID
		}
		if o.ID != id || o.Version != 1 || o.Status != "pending_payment" || o.PaymentStatus != "pending" {
			t.Fatal("duplicate submission diverged")
		}
	}
	var orders, stock, events int
	if err := s.db.QueryRow(`SELECT count(*) FROM orders`).Scan(&orders); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT stock FROM menu_items WHERE id='meal'`).Scan(&stock); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT count(*) FROM event_outbox`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if orders != 1 || stock != 29 || events != 1 {
		t.Fatalf("orders=%d stock=%d events=%d", orders, stock, events)
	}
	if _, err := s.db.Exec(`UPDATE menu_items SET price_minor=9000,stock=0 WHERE id='meal'`); err != nil {
		t.Fatal(err)
	}
	// Startup and retries must not overwrite stock, reprice, or create another order.
	if err := s.initialize(context.Background()); err != nil {
		t.Fatal(err)
	}
	restarted := &service{db: s.db, tenantID: s.tenantID, token: s.token, synthetic: true}
	w := request(restarted, "POST", "/orders", "customer", "customer-alice", input)
	expectCode(t, w, 201, "")
	if got := decodeOrder(t, w); got.ID != id || got.TotalMinor != 3000 {
		t.Fatal("durable receipt changed")
	}
	input.ExpectedTotalMinor = 9000
	expectCode(t, request(s, "POST", "/orders", "customer", "customer-alice", input), 409, "idempotency_conflict")
	input.ExpectedTotalMinor = 3000
	expectCode(t, request(s, "POST", "/orders", "customer", "customer-bob", input), 409, "idempotency_conflict")
}

func TestPostgresLastItemRaceAndQuoteReadOnly(t *testing.T) {
	s := fixture(t, "demo-a")
	if _, err := s.db.Exec(`UPDATE menu_items SET stock=1 WHERE id='meal'`); err != nil {
		t.Fatal(err)
	}
	expectCode(t, request(s, "POST", "/quote", "", "", cartInput{[]lineInput{{"meal", 1}}}), 200, "")
	var stock int
	if err := s.db.QueryRow(`SELECT stock FROM menu_items WHERE id='meal'`).Scan(&stock); err != nil || stock != 1 {
		t.Fatal("quote reserved stock")
	}
	const count = 12
	results := make(chan *httptest.ResponseRecorder, count)
	var wg sync.WaitGroup
	for range count {
		key, err := randomID()
		if err != nil {
			t.Fatal(err)
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- request(s, "POST", "/orders", "customer", "customer-alice", orderInput{[]lineInput{{"meal", 1}}, 3000, key})
		}()
	}
	wg.Wait()
	close(results)
	succeeded := 0
	for w := range results {
		if w.Code == 201 {
			succeeded++
		} else {
			expectCode(t, w, 409, "insufficient_stock")
		}
	}
	if succeeded != 1 {
		t.Fatalf("created %d orders for last item", succeeded)
	}
	if err := s.db.QueryRow(`SELECT stock FROM menu_items WHERE id='meal'`).Scan(&stock); err != nil || stock != 0 {
		t.Fatal("invalid stock after race")
	}
}

func TestPostgresIsolationOwnershipTransitionsAndEvents(t *testing.T) {
	a, b := fixture(t, "demo-a"), fixture(t, "demo-b")
	one, two := purchase(t, a, "shared-checkout-key"), purchase(t, b, "shared-checkout-key")
	if one.TenantID == two.TenantID || one.TotalMinor != 3000 || two.TotalMinor != 4500 {
		t.Fatal("tenant pricing isolation failed")
	}
	expectCode(t, request(a, "GET", "/orders/"+one.ID, "customer", "customer-bob", nil), 404, "order_not_found")
	expectCode(t, request(b, "GET", "/orders/"+one.ID, "customer", "customer-alice", nil), 404, "order_not_found")
	expectCode(t, request(a, "GET", "/orders/"+one.ID, "merchant", "merchant-b", nil), 403, "forbidden")
	expectCode(t, request(a, "POST", "/orders/"+one.ID+"/status", "customer", "customer-alice", map[string]any{"status": "preparing", "expectedVersion": 1}), 403, "forbidden")
	expectCode(t, request(a, "POST", "/orders/"+one.ID+"/status", "merchant", "merchant-a", map[string]any{"status": "completed", "expectedVersion": 1}), 409, "payment_required")
	expectCode(t, request(a, "POST", "/orders/"+one.ID+"/simulate-payment", "customer", "customer-bob", struct{}{}), 404, "order_not_found")
	w := request(a, "POST", "/orders/"+one.ID+"/simulate-payment", "customer", "customer-alice", struct{}{})
	expectCode(t, w, 200, "")
	o := decodeOrder(t, w)
	if o.Status != "accepted" || o.Version != 2 || o.PaymentStatus != "paid" || o.PaymentProvider != "local-simulation" {
		t.Fatal("invalid simulation transition")
	}
	w = request(a, "POST", "/orders/"+one.ID+"/simulate-payment", "customer", "customer-alice", struct{}{})
	expectCode(t, w, 200, "")
	if decodeOrder(t, w).Version != 2 {
		t.Fatal("repeated simulation advanced version")
	}
	expectCode(t, request(a, "POST", "/orders/"+one.ID+"/status", "merchant", "merchant-a", map[string]any{"status": "ready", "expectedVersion": 2}), 409, "invalid_status")
	for i, status := range []string{"preparing", "ready", "completed"} {
		w = request(a, "POST", "/orders/"+one.ID+"/status", "merchant", "merchant-a", map[string]any{"status": status, "expectedVersion": int64(i + 2)})
		expectCode(t, w, 200, "")
	}
	expectCode(t, request(a, "POST", "/orders/"+one.ID+"/status", "merchant", "merchant-a", map[string]any{"status": "preparing", "expectedVersion": 2}), 409, "version_conflict")
	expectCode(t, request(a, "POST", "/orders/"+one.ID+"/status", "merchant", "merchant-a", map[string]any{"status": "accepted", "expectedVersion": 5}), 409, "invalid_status")
	w = request(a, "GET", "/events?after=0&limit=100", "service", "platform", nil)
	expectCode(t, w, 200, "")
	var out struct {
		Events []event `json:"events"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if len(out.Events) != 5 {
		t.Fatalf("got %d outbox events", len(out.Events))
	}
	for i, e := range out.Events {
		if e.Sequence != int64(i+1) || e.Version != int64(i+1) || e.TenantID != "demo-a" || e.OwnerID != "customer-alice" {
			t.Fatal("incorrect event boundary/order")
		}
	}
	w = request(a, "GET", "/events?after=4", "service", "platform", nil)
	expectCode(t, w, 200, "")
	if json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Events) != 1 {
		t.Fatal("cursor failed")
	}
	w = request(a, "GET", "/events?after=4", "service", "platform", nil)
	expectCode(t, w, 200, "")
	if json.Unmarshal(w.Body.Bytes(), &out) != nil || len(out.Events) != 1 {
		t.Fatal("reading acknowledged events")
	}
	wrong := &service{db: a.db, tenantID: "demo-b", token: fixtureToken, synthetic: true}
	if err := wrong.initialize(context.Background()); err == nil {
		t.Fatal("accepted another tenant's database")
	}
}

func TestPostgresAtomicOutboxRollback(t *testing.T) {
	s := fixture(t, "demo-a")
	if _, err := s.db.Exec(`ALTER TABLE event_outbox ADD CONSTRAINT deliberate_test_failure CHECK(false) NOT VALID`); err != nil {
		t.Fatal(err)
	}
	expectCode(t, request(s, "POST", "/orders", "customer", "customer-alice", orderInput{[]lineInput{{"meal", 1}}, 3000, "outbox-rollback-key"}), 503, "service_unavailable")
	var stock, count, sequence int
	if err := s.db.QueryRow(`SELECT stock FROM menu_items WHERE id='meal'`).Scan(&stock); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT count(*) FROM orders`).Scan(&count); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRow(`SELECT event_sequence FROM tenant_meta`).Scan(&sequence); err != nil {
		t.Fatal(err)
	}
	if stock != 30 || count != 0 || sequence != 0 {
		t.Fatalf("partial transaction stock=%d orders=%d sequence=%d", stock, count, sequence)
	}
}

func TestPostgresSandboxPaymentBindingsAndReferenceReuse(t *testing.T) {
	s := fixture(t, "demo-a")
	o, other := purchase(t, s, "sandbox-payment-one"), purchase(t, s, "sandbox-payment-two")
	body := testPaymentInput{"moyasar-test", "fixture-invoice-001", 3000, "SAR"}
	path := "/orders/" + o.ID + "/confirm-test-payment"
	expectCode(t, request(s, "POST", path, "customer", "customer-alice", body), 403, "forbidden")
	body.AmountMinor = 2999
	expectCode(t, request(s, "POST", path, "service", "platform", body), 409, "payment_mismatch")
	body.AmountMinor = 3000
	body.Provider = "moyasar-live"
	expectCode(t, request(s, "POST", path, "service", "platform", body), 400, "invalid_payment")
	body.Provider = "moyasar-test"
	w := request(s, "POST", path, "service", "platform", body)
	expectCode(t, w, 200, "")
	if got := decodeOrder(t, w); got.Version != 2 || got.PaymentReference != body.Reference || got.PaymentProvider != "moyasar-test" {
		t.Fatal("payment proof not persisted")
	}
	w = request(s, "POST", path, "service", "platform", body)
	expectCode(t, w, 200, "")
	if decodeOrder(t, w).Version != 2 {
		t.Fatal("duplicate payment event")
	}
	expectCode(t, request(s, "POST", "/orders/"+other.ID+"/confirm-test-payment", "service", "platform", body), 409, "payment_reference_used")
	body.Reference = "fixture-invoice-002"
	expectCode(t, request(s, "POST", path, "service", "platform", body), 409, "payment_conflict")
	w = request(s, "GET", "/orders/"+other.ID, "customer", "customer-alice", nil)
	expectCode(t, w, 200, "")
	if decodeOrder(t, w).Status != "pending_payment" {
		t.Fatal("invoice reuse changed other order")
	}
	var count int
	if err := s.db.QueryRow(`SELECT count(*) FROM event_outbox`).Scan(&count); err != nil || count != 3 {
		t.Fatal("payment failure/retry created event")
	}
}

func TestPostgresIdempotencyRecoveryIsOwnedAndReadOnly(t *testing.T) {
	a, b := fixture(t, "demo-a"), fixture(t, "demo-b")
	key := "checkout:7a4c113f-f380-4a4a-9c9f-51dbe8c1f7a3"
	path := "/orders/by-idempotency?key=" + url.QueryEscape(key)
	one := purchase(t, a, key)
	// The original response may have been lost before the checkout session expired.
	// Simulate a process restart and changed stock/prices before recovering it.
	if _, err := a.db.Exec(`UPDATE menu_items SET price_minor=9000,stock=0 WHERE id='meal'`); err != nil {
		t.Fatal(err)
	}
	restarted := &service{db: a.db, tenantID: a.tenantID, token: a.token, synthetic: true}
	for range 2 {
		w := request(restarted, "GET", path, "customer", "customer-alice", nil)
		expectCode(t, w, 200, "")
		if got := decodeOrder(t, w); got.ID != one.ID || got.TotalMinor != 3000 || got.Version != 1 {
			t.Fatal("recovery changed immutable order identity or snapshot")
		}
	}
	expectCode(t, request(a, "GET", path, "customer", "customer-bob", nil), 404, "order_not_found")
	expectCode(t, request(b, "GET", path, "customer", "customer-alice", nil), 404, "order_not_found")
	expectCode(t, request(a, "GET", "/orders/by-idempotency?key=checkout%3Aabsent-key", "customer", "customer-alice", nil), 404, "order_not_found")
	for _, role := range []string{"merchant", "service"} {
		expectCode(t, request(a, "GET", path, role, "merchant-a", nil), 403, "forbidden")
	}
	for _, query := range []string{"", "?key=", "?key=short", "?key=contains%2Fslash", "?key=valid-key&key=another-key", "?key=valid-key&tenantId=demo-b", "?key=valid-key;extra=1"} {
		expectCode(t, request(a, "GET", "/orders/by-idempotency"+query, "customer", "customer-alice", nil), 400, "invalid_request")
	}
	var orders, stock, events int
	if err := a.db.QueryRow(`SELECT count(*) FROM orders`).Scan(&orders); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(`SELECT stock FROM menu_items WHERE id='meal'`).Scan(&stock); err != nil {
		t.Fatal(err)
	}
	if err := a.db.QueryRow(`SELECT count(*) FROM event_outbox`).Scan(&events); err != nil {
		t.Fatal(err)
	}
	if orders != 1 || stock != 0 || events != 1 {
		t.Fatalf("read-only recovery mutated state: orders=%d stock=%d events=%d", orders, stock, events)
	}
	if err := b.db.QueryRow(`SELECT count(*) FROM orders`).Scan(&orders); err != nil || orders != 0 {
		t.Fatal("missing recovery created an order in another tenant")
	}
	// Reusing the same opaque key in another tenant still resolves only its order.
	two := purchase(t, b, key)
	w := request(b, "GET", path, "customer", "customer-alice", nil)
	expectCode(t, w, 200, "")
	if got := decodeOrder(t, w); got.ID != two.ID || got.TenantID != "demo-b" || got.TotalMinor != 4500 {
		t.Fatal("recovery crossed tenant boundary")
	}
}
