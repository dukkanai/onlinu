package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func restaurantHTTPFixture(t *testing.T) (*server, http.Handler) {
	t.Helper()
	t.Setenv("WACALLS_API_KEY", "restaurant-test-master")
	t.Setenv("WACALLS_WIDGET_KEY", "restaurant-test-widget")
	t.Setenv("WACALLS_PUBLIC_BASE_URL", "https://restaurant.example")
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	accounts, err := newRestaurantAccounts(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	orders, err := newRestaurantOrders(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	// This HTTP fixture exercises order/auth policy, not external gateways.
	orders.PaymentAvailable = func(context.Context, string, string) (bool, error) { return true, nil }
	s := &server{restaurant: store, customers: accounts, orders: orders}
	return s, s.routes()
}

func restaurantHTTPRequest(t *testing.T, h http.Handler, method, path string, body any, headers map[string]string, cookie *http.Cookie) *httptest.ResponseRecorder {
	t.Helper()
	var input io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		input = bytes.NewReader(raw)
	}
	r := httptest.NewRequest(method, "https://restaurant.example"+path, input)
	r.RemoteAddr = "198.51.100.21:4321"
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	r.Header.Set("Origin", "https://restaurant.example")
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func restaurantDecodeResponse[T any](t *testing.T, w *httptest.ResponseRecorder, status int) T {
	t.Helper()
	if w.Code != status {
		t.Fatalf("status=%d want=%d body=%s", w.Code, status, w.Body.String())
	}
	var v T
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestRestaurantHTTPAuthAndOrigins(t *testing.T) {
	_, h := restaurantHTTPFixture(t)
	for _, headers := range []map[string]string{nil, {"X-API-Key": "restaurant-test-widget"}, {"X-API-Key": "wrong"}} {
		w := restaurantHTTPRequest(t, h, "GET", "/api/restaurant/catalog", nil, headers, nil)
		if w.Code != 401 {
			t.Fatalf("unauthorized status=%d", w.Code)
		}
	}
	w := restaurantHTTPRequest(t, h, "GET", "/api/restaurant/catalog?apiKey=restaurant-test-master", nil, nil, nil)
	if w.Code != 401 {
		t.Fatal("query-only master bypassed restaurant guard")
	}
	headers := map[string]string{"X-API-Key": "restaurant-test-master"}
	catalog := restaurantDecodeResponse[restaurantCatalog](t, restaurantHTTPRequest(t, h, "GET", "/api/restaurant/catalog", nil, headers, nil), 200)
	if len(catalog.Tables) == 0 {
		t.Fatal("admin cannot see QR tables")
	}
	pub := restaurantHTTPRequest(t, h, "GET", "/storefront-api/catalog", nil, nil, nil)
	if pub.Header().Get("Access-Control-Allow-Origin") != "" {
		t.Fatal("cookie API must not enable wildcard CORS")
	}
	public := restaurantDecodeResponse[restaurantCatalog](t, pub, 200)
	if len(public.Tables) != 0 {
		t.Fatal("public catalog leaked QR table list")
	}
	for _, origin := range []string{"https://evil.example", "null", "http://restaurant.example", "https://restaurant.example.evil"} {
		w = restaurantHTTPRequest(t, h, "POST", "/storefront-api/quote", map[string]any{}, map[string]string{"Origin": origin}, nil)
		if w.Code != 403 {
			t.Fatalf("origin %s status %d", origin, w.Code)
		}
	}
	w = restaurantHTTPRequest(t, h, "GET", "/storefront-api/account", nil, map[string]string{"Sec-Fetch-Site": "cross-site"}, nil)
	if w.Code != 403 {
		t.Fatal("crosssite metadata bypassed guard")
	}
	w = restaurantHTTPRequest(t, h, "PUT", "/api/restaurant/catalog", map[string]any{"version": 1, "unexpected": true}, headers, nil)
	if w.Code != 400 {
		t.Fatal("unknown fields accepted")
	}
	t.Setenv("WACALLS_API_KEY", "")
	w = restaurantHTTPRequest(t, h, "GET", "/api/restaurant/catalog", nil, headers, nil)
	if w.Code != 401 {
		t.Fatal("empty master auth must fail closed")
	}
}

func TestRestaurantHTTPGuestOrderJourney(t *testing.T) {
	_, h := restaurantHTTPFixture(t)
	admin := map[string]string{"X-API-Key": "restaurant-test-master"}
	catalog := restaurantDecodeResponse[restaurantCatalog](t, restaurantHTTPRequest(t, h, "GET", "/api/restaurant/catalog", nil, admin, nil), 200)
	in := restaurantOrderInput{Mode: "table", PaymentMethod: "cash_after", CustomerName: "Test guest", TableCode: catalog.Tables[0].Code, Items: []restaurantOrderLineInput{{ItemID: catalog.Items[0].ID, Quantity: 1, OptionIDs: []string{}}}}
	quote := restaurantDecodeResponse[restaurantQuote](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/quote", in, nil, nil), 200)
	in.ExpectedTotalMinor = quote.TotalMinor
	createHeaders := map[string]string{"Idempotency-Key": uuid.NewString()}
	receipt := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", in, createHeaders, nil), 201)
	retry := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", in, createHeaders, nil), 201)
	if retry.Order.Number != receipt.Order.Number || retry.TrackingToken != receipt.TrackingToken {
		t.Fatal("HTTP idempotency lost receipt")
	}
	number := receipt.Order.Number
	if w := restaurantHTTPRequest(t, h, "GET", "/storefront-api/orders/"+number, nil, nil, nil); w.Code != 404 {
		t.Fatal("order number authorized guest")
	}
	if w := restaurantHTTPRequest(t, h, "GET", "/storefront-api/orders/"+number+"?trackingToken="+receipt.TrackingToken, nil, nil, nil); w.Code != 404 {
		t.Fatal("query secret accepted")
	}
	tracked := restaurantHTTPRequest(t, h, "GET", "/storefront-api/orders/"+number, nil, map[string]string{"X-Order-Token": receipt.TrackingToken}, nil)
	restaurantDecodeResponse[restaurantOrder](t, tracked, 200)
	if tracked.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("private order cacheable")
	}
	lookup := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders/lookup", map[string]string{"number": number, "accessCode": receipt.AccessCode}, nil, nil), 200)
	if lookup.TrackingToken != receipt.TrackingToken {
		t.Fatal("lookup receipt mismatch")
	}
	w := restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders/"+number+"/table", map[string]string{"tableCode": catalog.Tables[1].Code}, nil, nil)
	if w.Code != 404 {
		t.Fatal("table QR itself granted order write")
	}
	moved := restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders/"+number+"/table", map[string]string{"tableCode": catalog.Tables[1].Code}, map[string]string{"X-Order-Token": receipt.TrackingToken}, nil), 200)
	if moved.Number != number || moved.TableID != catalog.Tables[1].ID || len(moved.TableChanges) != 1 {
		t.Fatal("incorrect table move")
	}
	updated := restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, h, "PATCH", "/api/restaurant/orders/"+number, map[string]any{"status": "accepted", "version": moved.Version}, admin, nil), 200)
	if updated.Status != "accepted" {
		t.Fatal("admin status update failed")
	}
	w = restaurantHTTPRequest(t, h, "PATCH", "/api/restaurant/orders/"+number, map[string]any{"status": "preparing", "version": moved.Version}, admin, nil)
	if w.Code != 409 {
		t.Fatal("stale order status overwrite")
	}
	for _, mode := range []string{"pickup", "delivery"} {
		in.Mode = mode
		in.PaymentMethod, in.PaymentProvider = "card", "stripe"
		if mode == "delivery" {
			in.PaymentMethod, in.PaymentProvider = "cash_on_delivery", ""
		}
		in.Phone = "+966500000000"
		in.TableCode = ""
		in.Address = restaurantAddress{Country: "SA", City: "Test city", District: "Test district", Street: "Test street", Building: "1234", NationalAddress: "ABCD1234"}
		q := restaurantDecodeResponse[restaurantQuote](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/quote", in, nil, nil), 200)
		in.ExpectedTotalMinor = q.TotalMinor
		r := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", in, map[string]string{"Idempotency-Key": uuid.NewString()}, nil), 201)
		if r.Order.Number == number || r.Order.Mode != mode || !r.Order.Demo {
			t.Fatal("modes not independent/demo")
		}
		if mode == "delivery" && (r.Order.Address.NationalAddress != "ABCD1234" || r.Order.DeliveryFeeMinor != catalog.Settings.DeliveryFeeMinor) {
			t.Fatal("delivery data mismatch")
		}
	}
}

func TestRestaurantHTTPAccountCookiesAndOwnership(t *testing.T) {
	_, h := restaurantHTTPFixture(t)
	registered := restaurantHTTPRequest(t, h, "POST", "/storefront-api/account/register", map[string]string{"username": "http_guest", "password": "test-only-password-123", "displayName": "Test user"}, nil, nil)
	restaurantDecodeResponse[map[string]restaurantCustomer](t, registered, 201)
	cookies := registered.Result().Cookies()
	if len(cookies) != 1 {
		t.Fatal("missing cookie")
	}
	cookie := cookies[0]
	if !cookie.HttpOnly || !cookie.Secure || cookie.SameSite != http.SameSiteLaxMode || cookie.Path != "/storefront-api" || cookie.MaxAge != 604800 {
		t.Fatal("unsafe cookie attributes")
	}
	account := restaurantDecodeResponse[map[string]restaurantCustomer](t, restaurantHTTPRequest(t, h, "GET", "/storefront-api/account", nil, nil, cookie), 200)
	if account["customer"].Username != "http_guest" {
		t.Fatal("cookie session unavailable")
	}
	catalog := restaurantDecodeResponse[restaurantCatalog](t, restaurantHTTPRequest(t, h, "GET", "/storefront-api/catalog", nil, nil, nil), 200)
	in := restaurantOrderInput{Mode: "pickup", PaymentMethod: "card", PaymentProvider: "stripe", CustomerName: "Signed in", Phone: "+966500000000", Items: []restaurantOrderLineInput{{ItemID: catalog.Items[0].ID, Quantity: 1}}}
	q := restaurantDecodeResponse[restaurantQuote](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/quote", in, nil, cookie), 200)
	in.ExpectedTotalMinor = q.TotalMinor
	receipt := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", in, map[string]string{"Idempotency-Key": uuid.NewString()}, cookie), 201)
	restaurantDecodeResponse[restaurantOrder](t, restaurantHTTPRequest(t, h, "GET", "/storefront-api/orders/"+receipt.Order.Number, nil, nil, cookie), 200)
	history := restaurantDecodeResponse[map[string][]restaurantOrder](t, restaurantHTTPRequest(t, h, "GET", "/storefront-api/account/orders", nil, nil, cookie), 200)
	if len(history["orders"]) != 1 {
		t.Fatal("own order absent from account")
	}
	if w := restaurantHTTPRequest(t, h, "GET", "/storefront-api/account/orders", nil, nil, nil); w.Code != 401 {
		t.Fatal("anonymous account history exposed")
	}
	logout := restaurantHTTPRequest(t, h, "POST", "/storefront-api/account/logout", map[string]any{}, nil, cookie)
	if logout.Code != 204 || logout.Result().Cookies()[0].MaxAge != -1 {
		t.Fatal("logout failed")
	}
	if w := restaurantHTTPRequest(t, h, "GET", "/storefront-api/orders/"+receipt.Order.Number, nil, nil, cookie); w.Code != 404 {
		t.Fatal("logout cookie still grants access")
	}
}

func TestRestaurantHTTPExpiredCookieCannotCreateGuestRetry(t *testing.T) {
	s, h := restaurantHTTPFixture(t)
	registered := restaurantHTTPRequest(t, h, "POST", "/storefront-api/account/register", map[string]string{
		"username": "expiry_test", "password": "test-only-password-123", "displayName": "Expiry test",
	}, nil, nil)
	restaurantDecodeResponse[map[string]restaurantCustomer](t, registered, 201)
	cookie := registered.Result().Cookies()[0]
	catalog, err := s.restaurant.GetCatalog(context.Background(), true)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderInput{Mode: "pickup", PaymentMethod: "card", PaymentProvider: "stripe", Phone: "+966500000000", Items: []restaurantOrderLineInput{{ItemID: catalog.Items[0].ID, Quantity: 1}}}
	quote, err := s.orders.Quote(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedTotalMinor = quote.TotalMinor
	headers := map[string]string{"Idempotency-Key": uuid.NewString()}
	original := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", input, headers, cookie), 201)
	// Simulate a response lost at the exact point the authenticated session
	// expires. The same submission must not become an independent guest order.
	if _, err := s.customers.db.ExecContext(context.Background(), `UPDATE restaurant_customer_sessions SET expires_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	for _, stale := range []*http.Cookie{cookie, {Name: restaurantSessionCookieName(), Value: "malformed-session"}} {
		response := restaurantDecodeResponse[map[string]string](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", input, headers, stale), 401)
		if response["error"] != "session_expired" {
			t.Fatal("stale session must be reported explicitly")
		}
	}
	// Dropping the cookie must also not recreate or disclose the account order.
	restaurantDecodeResponse[map[string]string](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", input, headers, nil), 409)
	var count int
	if err := s.customers.db.QueryRowContext(context.Background(), `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("expired-cookie retry created extra orders: %d %v", count, err)
	}
	login := restaurantHTTPRequest(t, h, "POST", "/storefront-api/account/login", map[string]string{"username": "expiry_test", "password": "test-only-password-123"}, nil, nil)
	restaurantDecodeResponse[map[string]restaurantCustomer](t, login, 200)
	retry := restaurantDecodeResponse[restaurantReceipt](t, restaurantHTTPRequest(t, h, "POST", "/storefront-api/orders", input, headers, login.Result().Cookies()[0]), 201)
	if retry.Order.Number != original.Order.Number || retry.TrackingToken != original.TrackingToken {
		t.Fatal("signing back in must recover the original durable receipt")
	}
}

type restaurantDeadlineRecorder struct {
	*httptest.ResponseRecorder
	deadlines []time.Time
}

func (w *restaurantDeadlineRecorder) SetReadDeadline(deadline time.Time) error {
	w.deadlines = append(w.deadlines, deadline)
	return nil
}

func TestRestaurantHTTPReadDeadlineSurvivesEarlyReturn(t *testing.T) {
	s := &server{}
	w := &restaurantDeadlineRecorder{ResponseRecorder: httptest.NewRecorder()}
	r := httptest.NewRequest("POST", "/storefront-api/orders", strings.NewReader("{"))
	r.Header.Set("Content-Type", "application/json")
	// No stores: the guard rejects without consuming the body. The deadline
	// must survive return to bound net/http's post-handler body draining too.
	s.routes().ServeHTTP(w, r)
	if w.Code != 503 || len(w.deadlines) != 1 || w.deadlines[0].IsZero() {
		t.Fatalf("read deadline missing/reset on early return: status=%d deadlines=%v", w.Code, w.deadlines)
	}
	remaining := time.Until(w.deadlines[0])
	if remaining <= 0 || remaining > 15*time.Second {
		t.Fatalf("unexpected request-body deadline: %v", remaining)
	}
}

func TestRestaurantHTTPImagesAndStaticRoutes(t *testing.T) {
	_, h := restaurantHTTPFixture(t)
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
	upload := func(data []byte) *httptest.ResponseRecorder {
		var body bytes.Buffer
		mw := multipart.NewWriter(&body)
		file, err := mw.CreateFormFile("image", "dish.png")
		if err != nil {
			t.Fatal(err)
		}
		_, _ = file.Write(data)
		_ = mw.Close()
		req := httptest.NewRequest("POST", "https://restaurant.example/api/restaurant/images", &body)
		req.Header.Set("X-API-Key", "restaurant-test-master")
		req.Header.Set("Content-Type", mw.FormDataContentType())
		req.Header.Set("Origin", "https://restaurant.example")
		response := httptest.NewRecorder()
		h.ServeHTTP(response, req)
		return response
	}
	if w := upload([]byte(`<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`)); w.Code != 400 {
		t.Fatal("SVG upload accepted")
	}
	pic := image.NewRGBA(image.Rect(0, 0, 3, 3))
	pic.Set(1, 1, color.RGBA{R: 255, A: 255})
	var buf bytes.Buffer
	_ = png.Encode(&buf, pic)
	buf.WriteString("PRIVATE-EXIF-TRAILER")
	uploaded := restaurantDecodeResponse[map[string]string](t, upload(buf.Bytes()), 201)
	w := restaurantHTTPRequest(t, h, "GET", uploaded["url"], nil, nil, nil)
	if w.Code != 200 || bytes.Contains(w.Body.Bytes(), []byte("PRIVATE-EXIF-TRAILER")) {
		t.Fatal("image upload not normalized")
	}
	if w := restaurantHTTPRequest(t, h, "GET", "/restaurant-media/.env", nil, nil, nil); w.Code != 404 {
		t.Fatal("media path escaped")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("restaurant-spa"), 0600); err != nil {
		t.Fatal(err)
	}
	static := restaurantStatic(dir)
	for _, path := range []string{"/", "/order", "/track", "/account", "/admin", "/admin/calls"} {
		w := httptest.NewRecorder()
		static.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 200 || !strings.Contains(w.Body.String(), "restaurant-spa") {
			t.Fatalf("SPA route %s failed", path)
		}
	}
	for _, path := range []string{"/api/missing", "/storefront-api/missing", "/.env", "/missing.js", "/unknown"} {
		w := httptest.NewRecorder()
		static.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
		if w.Code != 404 {
			t.Fatalf("unexpected SPA fallback %s", path)
		}
	}
}

func TestRestaurantRateLimiterAndProxyIP(t *testing.T) {
	t.Setenv("WACALLS_API_KEY", "instance-one-private-key")
	firstCookieName := restaurantSessionCookieName()
	t.Setenv("WACALLS_API_KEY", "instance-two-private-key")
	if firstCookieName == restaurantSessionCookieName() || strings.Contains(firstCookieName, "private-key") {
		t.Fatal("separate instances share a cookie name or reveal credential material")
	}
	limiter := restaurantRateLimiter{entries: make(map[string]restaurantRateEntry)}
	for i := 0; i < 10; i++ {
		if !limiter.allow("a", 10) {
			t.Fatal("premature limit")
		}
	}
	if limiter.allow("a", 10) || !limiter.allow("b", 10) {
		t.Fatal("limit/isolation")
	}
	r := httptest.NewRequest("GET", "/", nil)
	r.RemoteAddr = "198.51.100.3:123"
	r.Header.Set("X-Forwarded-For", "203.0.113.1")
	if restaurantClientIP(r) != "198.51.100.3" {
		t.Fatal("trusted external spoofed header")
	}
	r.RemoteAddr = "172.20.0.1:321"
	r.Header.Set("X-Forwarded-For", "203.0.113.99, 198.51.100.8")
	if restaurantClientIP(r) != "198.51.100.8" {
		t.Fatal("did not use verified rightmost proxy hop")
	}
}
