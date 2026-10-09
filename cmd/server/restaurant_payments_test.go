package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type restaurantPaymentTestTransport func(*http.Request) (*http.Response, error)

func (f restaurantPaymentTestTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	return f(r)
}
func restaurantPaymentTestResponse(value string) *http.Response {
	return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(value))}
}
func TestRestaurantPaymentAmountAndURLValidation(t *testing.T) {
	for _, tc := range []struct {
		minor          int64
		currency, text string
	}{{11500, "SAR", "115.00"}, {1, "KWD", "0.001"}, {123, "JPY", "123"}} {
		if got := restaurantPaymentDecimal(tc.minor, tc.currency); got != tc.text {
			t.Fatalf("decimal %s != %s", got, tc.text)
		}
		minor, err := restaurantPaymentMinor(tc.text, tc.currency)
		if err != nil || minor != tc.minor {
			t.Fatalf("minor conversion failed")
		}
	}
	for _, v := range []string{"1.001", "1e2", "-1", "NaN", "9999999999999999999999999999", "1/2"} {
		if _, err := restaurantPaymentMinor(v, "SAR"); err == nil {
			t.Errorf("unsafe amount accepted: %s", v)
		}
	}
	for _, raw := range []string{"https://checkout.stripe.com.evil.test/a", "http://checkout.stripe.com/a", "https://checkout.stripe.com@evil.test/a", "https://checkout.stripe.com:444/a", "javascript:alert(1)"} {
		if restaurantPaymentURL("stripe", raw) {
			t.Errorf("unsafe redirect accepted")
		}
	}
	if !restaurantPaymentURL("stripe", "https://checkout.stripe.com/c/pay/id#fragment") || restaurantPaymentURL("moyasar", "https://checkout.stripe.com/c/pay/id") {
		t.Fatal("provider redirect isolation")
	}
}
func TestRestaurantPaymentHTTPBoundaries(t *testing.T) {
	calls := 0
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.Query().Get("secret") != "" {
			t.Fatal("credential in URL")
		}
		return restaurantPaymentTestResponse(`{"ok":true}`), nil
	})}}
	var out map[string]any
	if err := g.json(context.Background(), "GET", "https://evil.test/status", "Bearer secret", nil, &out); err == nil || calls != 0 {
		t.Fatal("SSRF allowed")
	}
	if err := g.json(context.Background(), "GET", "https://api.stripe.com/v1/test", "Bearer secret", nil, &out); err != nil || calls != 1 {
		t.Fatal("valid mock request failed")
	}
	g.client.Transport = restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		resp := restaurantPaymentTestResponse(`{"error":"sk_test_secret_provider_response"}`)
		resp.StatusCode = 401
		return resp, nil
	})
	if err := g.json(context.Background(), "GET", "https://api.stripe.com/v1/test", "Bearer secret", nil, &out); err == nil || strings.Contains(err.Error(), "sk_test_secret") {
		t.Fatal("unsafe error")
	}
	g.client.Transport = restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		return restaurantPaymentTestResponse(strings.Repeat("x", 256*1024+1)), nil
	})
	if err := g.json(context.Background(), "GET", "https://api.stripe.com/v1/test", "Bearer secret", nil, &out); err == nil {
		t.Fatal("oversized body accepted")
	}
	g.client.Transport = restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		resp := restaurantPaymentTestResponse(`{}`)
		resp.StatusCode = 302
		resp.Header.Set("Location", "https://evil.test/steal")
		return resp, nil
	})
	if err := g.json(context.Background(), "GET", "https://api.stripe.com/v1/test", "Bearer secret", nil, &out); err == nil {
		t.Fatal("redirect accepted")
	}
}
func TestRestaurantPaymentStripeCreateAndRequery(t *testing.T) {
	cfg := restaurantPaymentConfig{ID: "stripe", Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_mock"}}
	attempt := uuid.NewString()
	calls := 0
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("Authorization") != "Bearer sk_test_mock" {
			t.Fatal("missing auth")
		}
		if r.Method == "POST" {
			if r.Header.Get("Idempotency-Key") != "restaurant-"+attempt {
				t.Fatal("missing stable idempotency")
			}
			if err := r.ParseForm(); err != nil {
				t.Fatal(err)
			}
			if r.Form.Get("line_items[0][price_data][unit_amount]") != "11500" || r.Form.Get("client_reference_id") != attempt || r.Form.Get("automatic_tax[enabled]") != "" {
				t.Fatal("amount/reference modified or tax added")
			}
		}
		return restaurantPaymentTestResponse(`{"id":"cs_test_one","url":"https://checkout.stripe.com/c/pay/cs_test_one","mode":"payment","livemode":false,"payment_status":"paid","status":"complete","amount_total":11500,"currency":"sar","client_reference_id":"` + attempt + `","payment_intent":{"status":"succeeded","latest_charge":{"id":"ch_mock","paid":true,"captured":true,"amount":11500,"amount_captured":11500,"amount_refunded":0,"currency":"sar","livemode":false}}}`), nil
	})}}
	req := restaurantPaymentRequest{AttemptID: attempt, OrderNumber: "R1", AmountMinor: 11500, Currency: "SAR", ReturnURL: "https://restaurant.test/payment-return?attempt=" + attempt}
	remote, err := g.Create(context.Background(), cfg, req)
	if err != nil || remote.ID != "cs_test_one" || remote.Status == "paid" {
		t.Fatalf("creation must not confirm payment: %v", err)
	}
	remote, err = g.Fetch(context.Background(), cfg, remote.ID, attempt)
	if err != nil || remote.Status != "paid" || remote.Reference != attempt || remote.AmountMinor != 11500 || calls != 2 {
		t.Fatalf("query failed: %+v %v", remote, err)
	}
	cfg.Mode = "live"
	if _, err = g.Fetch(context.Background(), cfg, "cs_test_one", attempt); err == nil {
		t.Fatal("test/live mismatch accepted")
	}
}
func TestRestaurantPaymentMoyasarTapAndHyperpayMappings(t *testing.T) {
	attempt := uuid.NewString()
	ctx := context.Background()
	for _, tc := range []struct{ provider, id, response, status string }{
		{"moyasar", "invoice_id", `{"id":"invoice_id","amount":11500,"currency":"SAR","status":"paid","description":"Restaurant payment ` + attempt + `","payments":[{"id":"payment_id","invoice_id":"invoice_id","status":"paid","amount":11500,"currency":"SAR","captured":0,"refunded":0}]}`, "paid"},
		{"moyasar", "invoice_id", `{"id":"invoice_id","amount":11500,"currency":"SAR","status":"failed","description":"Restaurant payment ` + attempt + `","payments":[]}`, "failed"},
		{"moyasar", "invoice_id", `{"id":"invoice_id","amount":11500,"currency":"SAR","status":"paid","description":"Restaurant payment ` + attempt + `","payments":[{"id":"payment_id","invoice_id":"invoice_id","status":"paid","amount":11500,"currency":"SAR","captured":0,"refunded":100}]}`, "review"},
		{"tap", "charge_id", `{"id":"charge_id","amount":115.00,"currency":"SAR","status":"CAPTURED","live_mode":false,"reference":{"transaction":"` + attempt + `"}}`, "paid"},
		{"tap", "charge_id", `{"id":"charge_id","amount":115.00,"currency":"SAR","status":"AUTHORIZED","live_mode":false,"reference":{"transaction":"` + attempt + `"}}`, "pending"},
		{"hyperpay", "checkout.uat01", `{"id":"transaction","amount":"115.00","currency":"SAR","paymentType":"DB","paymentBrand":"VISA","merchantTransactionId":"` + attempt + `","result":{"code":"000.100.110"}}`, "paid"},
		{"hyperpay", "checkout.uat01", `{"id":"transaction","amount":"115.00","currency":"SAR","paymentType":"PA","merchantTransactionId":"` + attempt + `","result":{"code":"000.100.110"}}`, "pending"},
	} {
		t.Run(tc.provider+tc.status, func(t *testing.T) {
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/v2/refunds/list" {
					return restaurantPaymentTestResponse(`{"has_more":false,"refunds":[]}`), nil
				}
				return restaurantPaymentTestResponse(tc.response), nil
			})}}
			c := restaurantPaymentConfig{ID: tc.provider, Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_mock", "accessToken": "token"}, Values: map[string]string{"entityId": "entity"}}
			r, err := g.Fetch(ctx, c, tc.id, attempt)
			if err != nil || r.Status != tc.status || r.AmountMinor != 11500 || r.Reference != attempt {
				t.Fatalf("mapping %v %v", r, err)
			}
		})
	}
	g := restaurantPaymentGateways{}
	if _, err := g.createHyperPay(ctx, restaurantPaymentConfig{Mode: "live"}, restaurantPaymentRequest{}); err == nil {
		t.Fatal("unverified live widget enabled")
	}
}

func TestRestaurantPaymentStripeRefundAndAuthorization(t *testing.T) {
	for _, tc := range []struct {
		name     string
		captured bool
		refunded int64
		disputed bool
		want     string
	}{{"captured", true, 0, false, "paid"}, {"authorized", false, 0, false, "review"}, {"partial", true, 100, false, "review"}, {"refunded", true, 11500, false, "refunded"}, {"disputed", true, 0, true, "review"}} {
		t.Run(tc.name, func(t *testing.T) {
			body := map[string]any{"id": "cs_test_one", "mode": "payment", "livemode": false, "payment_status": "paid", "amount_total": 11500, "currency": "sar", "client_reference_id": "attempt", "payment_intent": map[string]any{"status": "succeeded", "latest_charge": map[string]any{"id": "ch_mock", "paid": true, "captured": tc.captured, "amount": 11500, "amount_captured": 11500, "amount_refunded": tc.refunded, "disputed": tc.disputed, "currency": "sar", "livemode": false}}}
			raw, _ := json.Marshal(body)
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Query().Get("expand[]") != "payment_intent.latest_charge" {
					t.Fatal("missing expanded capture check")
				}
				return restaurantPaymentTestResponse(string(raw)), nil
			})}}
			got, err := g.Fetch(context.Background(), restaurantPaymentConfig{ID: "stripe", Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_mock"}}, "cs_test_one", "attempt")
			if err != nil || got.Status != tc.want {
				t.Fatalf("wanted %s got %v %v", tc.want, got, err)
			}
		})
	}
}

func TestRestaurantPaymentHostedCreateContracts(t *testing.T) {
	attempt := uuid.NewString()
	req := restaurantPaymentRequest{AttemptID: attempt, OrderNumber: "R1", AmountMinor: 11500, Currency: "SAR", CustomerName: "Customer", Phone: "+966501234567", ReturnURL: "https://restaurant.test/payment-hooks/return/" + attempt, HookURL: "https://restaurant.test/payment-hooks/provider/" + attempt}
	for _, provider := range []string{"moyasar", "tap", "hyperpay"} {
		t.Run(provider, func(t *testing.T) {
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				if r.Method != "POST" || r.Header.Get("Authorization") == "" {
					t.Fatal("not authenticated create")
				}
				raw, _ := io.ReadAll(r.Body)
				if strings.Contains(string(raw), "card_number") || strings.Contains(string(raw), "cvc") {
					t.Fatal("raw card data on server")
				}
				switch provider {
				case "moyasar":
					var body map[string]any
					if json.Unmarshal(raw, &body) != nil || body["amount"] != float64(11500) || body["callback_url"] != req.HookURL || body["success_url"] != req.ReturnURL {
						t.Fatal("invoice request contract")
					}
					return restaurantPaymentTestResponse(`{"id":"invoice_mock","amount":11500,"currency":"SAR","description":"Restaurant payment ` + attempt + `","url":"https://checkout.moyasar.com/invoices/invoice_mock"}`), nil
				case "tap":
					var body map[string]any
					if json.Unmarshal(raw, &body) != nil || body["amount"] != float64(115) || body["source"].(map[string]any)["id"] != "src_card" || body["reference"].(map[string]any)["idempotent"] != attempt {
						t.Fatal("Tap request contract")
					}
					return restaurantPaymentTestResponse(`{"id":"chg_mock","amount":115,"currency":"SAR","live_mode":false,"reference":{"transaction":"` + attempt + `"},"transaction":{"url":"https://checkout.tap.company/charge/chg_mock"}}`), nil
				default:
					form, err := url.ParseQuery(string(raw))
					if err != nil || form.Get("paymentType") != "DB" || form.Get("merchantTransactionId") != attempt || form.Get("amount") != "115.00" || r.URL.Host != "eu-test.oppwa.com" {
						t.Fatal("HyperPay request contract")
					}
					return restaurantPaymentTestResponse(`{"id":"checkout.uat01","result":{"code":"000.200.100"}}`), nil
				}
			})}}
			cfg := restaurantPaymentConfig{ID: provider, Mode: "test", Values: map[string]string{"entityId": "entity"}, Secrets: map[string]string{"secretKey": "sk_test_mock", "accessToken": "token"}}
			out, err := g.Create(context.Background(), cfg, req)
			if err != nil || out.ID == "" || out.Status == "paid" {
				t.Fatalf("create response %v %v", out, err)
			}
			if provider == "hyperpay" {
				if out.Widget == nil || out.Widget.CheckoutID != out.ID || !strings.HasPrefix(out.Widget.ScriptURL, "https://eu-test.oppwa.com/v1/paymentWidgets.js?") {
					t.Fatal("widget contract")
				}
			} else if !restaurantPaymentURL(provider, out.URL) {
				t.Fatal("hosted URL contract")
			}
		})
	}
}

func TestRestaurantPaymentTapRefundLookup(t *testing.T) {
	for _, tc := range []struct {
		name, status string
		amount       int64
		more         bool
		want         string
	}{{"none", "", 0, false, "paid"}, {"full", "REFUNDED", 11500, false, "refunded"}, {"partial", "REFUNDED", 100, false, "review"}, {"pending", "PENDING", 11500, false, "review"}, {"failed", "FAILED", 11500, false, "paid"}, {"truncated", "REFUNDED", 100, true, "review"}} {
		t.Run(tc.name, func(t *testing.T) {
			refunds := []map[string]any{}
			if tc.status != "" {
				refunds = append(refunds, map[string]any{"id": "re_mock", "charge_id": "chg_mock", "currency": "SAR", "live_mode": false, "status": tc.status, "amount": json.Number(restaurantPaymentDecimal(tc.amount, "SAR"))})
			}
			raw, _ := json.Marshal(map[string]any{"has_more": tc.more, "refunds": refunds})
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				if r.Method != "POST" || r.URL.Path != "/v2/refunds/list" {
					t.Fatal("unexpected refund mutation endpoint")
				}
				var body struct {
					Charges []string `json:"charges"`
					Limit   int      `json:"limit"`
				}
				if json.NewDecoder(r.Body).Decode(&body) != nil || len(body.Charges) != 1 || body.Charges[0] != "chg_mock" || body.Limit != 50 {
					t.Fatal("unbound refund query")
				}
				return restaurantPaymentTestResponse(string(raw)), nil
			})}}
			got, err := g.tapRefundStatus(context.Background(), restaurantPaymentConfig{Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_mock"}}, "chg_mock", "SAR", 11500)
			if err != nil || got != tc.want {
				t.Fatalf("wanted %s got %s %v", tc.want, got, err)
			}
		})
	}
}

type restaurantPaymentFakeAdapter struct {
	create func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error)
	fetch  func(context.Context, restaurantPaymentConfig, string, string) (restaurantPaymentRemote, error)
}

func (f *restaurantPaymentFakeAdapter) Create(c context.Context, cfg restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	return f.create(c, cfg, r)
}
func (f *restaurantPaymentFakeAdapter) Fetch(c context.Context, cfg restaurantPaymentConfig, id, attempt string) (restaurantPaymentRemote, error) {
	return f.fetch(c, cfg, id, attempt)
}
func restaurantPaymentFixture(t *testing.T) (*restaurantPayments, restaurantReceipt) {
	t.Helper()
	orders, _, db := restaurantOrdersFixtureDB(t)
	p, err := newRestaurantPayments(context.Background(), db, orders, "https://restaurant.test")
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.Configure(context.Background(), "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_unit_only"}})
	if err != nil {
		t.Fatal(err)
	}
	orders.PaymentAvailable = p.Available
	receipt, err := orders.Create(context.Background(), restaurantOrderFixtureInput("pickup"), "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return p, receipt
}
func TestRestaurantPaymentsIntegrationEncryptionAndConfiguration(t *testing.T) {
	p, _ := restaurantPaymentFixture(t)
	ctx := context.Background()
	configs, err := p.Admin(ctx)
	if err != nil || len(configs) != 8 {
		t.Fatal("configuration list")
	}
	raw, _ := json.Marshal(configs)
	if strings.Contains(string(raw), "sk_test_unit_only") {
		t.Fatal("credential disclosed")
	}
	var sealed []byte
	if err = p.db.QueryRowContext(ctx, `SELECT sealed FROM restaurant_payment_configs WHERE provider='stripe'`).Scan(&sealed); err != nil || strings.Contains(string(sealed), "sk_test_unit_only") {
		t.Fatal("credential unencrypted")
	}
	cfg, err := p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: map[string]string{"secretKey": ""}})
	if err != nil || !cfg.SecretSet["secretKey"] {
		t.Fatal("blank secret not preserved")
	}
	cfg, err = p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Mode: "test", ClearSecrets: []string{"secretKey"}})
	if err != nil || cfg.Configured || cfg.SecretSet["secretKey"] {
		t.Fatal("explicit clear failed")
	}
	if ok, _ := p.Available(ctx, "", "SAR"); ok {
		t.Fatal("disabled gateway available")
	}
	if _, err = p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: map[string]string{"secretKey": "sk_live_bad"}}); err == nil {
		t.Fatal("mode/key mismatch accepted")
	}
	if _, err = p.decrypt("attempt:wrong", sealed); err == nil {
		t.Fatal("cipher not bound to purpose")
	}
	sealed[len(sealed)-1] ^= 1
	if _, err = p.decrypt("config:stripe", sealed); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
}

func TestRestaurantPaymentsIntegrationDemoModeIsolation(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	p.adapter = &restaurantPaymentFakeAdapter{create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		t.Fatal("wrong-mode payment creation attempted")
		return restaurantPaymentRemote{}, nil
	}}
	catalog, err := p.orders.store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.Demo = false
	if _, err = p.orders.store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	if ok, err := p.Available(ctx, "stripe", "SAR"); err != nil || ok {
		t.Fatal("sandbox available for real orders")
	}
	if _, err = p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe"); err == nil {
		t.Fatal("catalog mode switch ignored")
	}
	if _, err = p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "live", Secrets: map[string]string{"secretKey": "sk_live_unit_only"}}); err != nil {
		t.Fatal(err)
	}
	if ok, err := p.Available(ctx, "stripe", "SAR"); err != nil || !ok {
		t.Fatal("proper live availability failed")
	}
	if _, err = p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe"); err == nil {
		t.Fatal("live charge allowed for old demo order")
	}
	if ok, _ := p.Available(ctx, "stripe", "USD"); ok {
		t.Fatal("unverified currency available")
	}
	catalog, _ = p.orders.store.GetCatalog(ctx, false)
	catalog.Settings.Demo = true
	if _, err = p.orders.store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	if ok, _ := p.Available(ctx, "stripe", "SAR"); ok {
		t.Fatal("live gateway visible for demo catalog")
	}
}
func TestRestaurantPaymentsIntegrationConcurrentCreationAndSettlement(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	var calls atomic.Int32
	var attempt string
	var mu sync.Mutex
	p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		calls.Add(1)
		mu.Lock()
		attempt = r.AttemptID
		mu.Unlock()
		time.Sleep(25 * time.Millisecond)
		return restaurantPaymentRemote{ID: "cs_test_one", URL: "https://checkout.stripe.com/c/pay/cs_test_one"}, nil
	}, fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		return restaurantPaymentRemote{ID: id, Status: "paid", Currency: "SAR", AmountMinor: 3000, Reference: ref}, nil
	}}
	var wg sync.WaitGroup
	for i := 0; i < 12; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
			if err != nil || v.Status != "pending" {
				t.Errorf("start %v %v", v, err)
			}
		}()
	}
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatalf("duplicate remote creations: %d", calls.Load())
	}
	mu.Lock()
	id := attempt
	mu.Unlock()
	if _, err := p.Start(ctx, receipt.Order.Number, "wrong", "", "stripe"); err == nil {
		t.Fatal("foreign owner can pay")
	}
	if _, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "tap"); err == nil {
		t.Fatal("provider snapshot changed")
	}
	// Credential rotation must not change the account used by an in-flight
	// payment. Its encrypted original configuration is a durable snapshot.
	if _, err := p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_rotated"}}); err != nil {
		t.Fatal(err)
	}
	originalFetch := p.adapter.(*restaurantPaymentFakeAdapter).fetch
	p.adapter.(*restaurantPaymentFakeAdapter).fetch = func(c context.Context, cfg restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		if cfg.Secrets["secretKey"] != "sk_test_unit_only" {
			t.Fatal("pending payment changed merchant credentials")
		}
		return originalFetch(c, cfg, id, ref)
	}
	v, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
	if err != nil || v.Status != "paid" {
		t.Fatalf("settlement %v %v", v, err)
	}
	order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.PaidAt == nil || order.Payment.AmountMinor != 3000 || order.Tax != receipt.Order.Tax {
		t.Fatal("payment/tax snapshot corrupted")
	}
	version := order.Version
	a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1`, id))
	if err != nil {
		t.Fatal(err)
	}
	_, err = p.apply(ctx, a, restaurantPaymentRemote{ID: a.RemoteID, Status: "paid", Currency: "SAR", AmountMinor: 3000, Reference: id}, true)
	if err != nil {
		t.Fatal(err)
	}
	order, _ = p.orders.Track(ctx, order.Number, receipt.TrackingToken, "", "")
	if order.Version != version {
		t.Fatal("duplicate event mutated order")
	}
	restarted, err := newRestaurantPayments(ctx, p.db, p.orders, p.baseURL)
	if err != nil {
		t.Fatal(err)
	}
	v, err = restarted.Status(ctx, order.Number, receipt.TrackingToken, "")
	if err != nil || v.Status != "paid" || v.AttemptID != id {
		t.Fatal("restart lost durable payment")
	}
}
func TestRestaurantPaymentsIntegrationMismatchCancellationAndAmbiguity(t *testing.T) {
	for _, scenario := range []string{"amount", "currency", "reference", "remote", "cancelled", "ambiguous"} {
		t.Run(scenario, func(t *testing.T) {
			p, receipt := restaurantPaymentFixture(t)
			ctx := context.Background()
			var creates atomic.Int32
			p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
				creates.Add(1)
				if scenario == "ambiguous" {
					return restaurantPaymentRemote{}, errors.New("timeout")
				}
				return restaurantPaymentRemote{ID: "cs_test_one", URL: "https://checkout.stripe.com/c/pay/cs_test_one"}, nil
			}, fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
				r := restaurantPaymentRemote{ID: id, Status: "paid", Currency: "SAR", AmountMinor: 3000, Reference: ref}
				switch scenario {
				case "amount":
					r.AmountMinor++
				case "currency":
					r.Currency = "USD"
				case "reference":
					r.Reference = uuid.NewString()
				case "remote":
					r.ID = "cs_other"
				}
				return r, nil
			}}
			v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
			if err != nil {
				t.Fatal(err)
			}
			if scenario == "cancelled" {
				o, _ := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
				if _, err = p.orders.SetStatus(ctx, o.Number, "cancelled", o.Version); err != nil {
					t.Fatal(err)
				}
			}
			if scenario != "ambiguous" {
				v, err = p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
				if err != nil {
					t.Fatal(err)
				}
			}
			if v.Status != "review" {
				t.Fatalf("unsafe settlement %v", v)
			}
			o, _ := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
			if o.Payment.Status != "review" || o.Payment.PaidAt != nil || scenario == "cancelled" && o.Status != "cancelled" {
				t.Fatal("order resurrected/paid")
			}
			if scenario != "cancelled" {
				v, err = p.Start(ctx, o.Number, receipt.TrackingToken, "", "stripe")
				if err != nil || v.Status != "review" || creates.Load() != 1 {
					t.Fatal("review created another payment")
				}
			}
		})
	}
}
func TestRestaurantPaymentsIntegrationForgedHookUsesProviderQuery(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	var queries atomic.Int32
	p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		return restaurantPaymentRemote{ID: "cs_test_one", URL: "https://checkout.stripe.com/c/pay/cs_test_one"}, nil
	}, fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		queries.Add(1)
		return restaurantPaymentRemote{ID: id, Status: "pending", Currency: "SAR", AmountMinor: 3000, Reference: ref}, nil
	}}
	v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil {
		t.Fatal(err)
	}
	s := &server{payments: p}
	pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
	s.registerRestaurantPaymentHandlers(pub, admin, hooks)
	for i := 0; i < 3; i++ {
		r := httptest.NewRequest("POST", "/payment-hooks/stripe/"+v.AttemptID, strings.NewReader(`{"status":"paid","amount":3000}`))
		w := httptest.NewRecorder()
		hooks.ServeHTTP(w, r)
		if w.Code != 200 {
			t.Fatalf("hook rejected %d", w.Code)
		}
	}
	if queries.Load() != 1 {
		t.Fatal("durable hook query throttle failed")
	}
	o, _ := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if o.Payment.Status != "pending" {
		t.Fatal("forged webhook marked paid")
	}
}

func TestRestaurantPaymentsIntegrationStaleCreationAndReturn(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		return restaurantPaymentRemote{}, errors.New("ambiguous create")
	}}
	v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil {
		t.Fatal(err)
	}
	// Model a process crash after committing creating but before saving outcome.
	if _, err = p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET status='creating',created_at=now()-interval '2 minutes',checked_at=NULL WHERE id=$1`, v.AttemptID); err != nil {
		t.Fatal(err)
	}
	if err = p.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	var status string
	var checked *time.Time
	if err = p.db.QueryRowContext(ctx, `SELECT status,checked_at FROM restaurant_payment_attempts WHERE id=$1`, v.AttemptID).Scan(&status, &checked); err != nil || status != "review" || checked == nil {
		t.Fatal("stale creation not reviewed/throttled")
	}
	s := &server{payments: p}
	pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
	s.registerRestaurantPaymentHandlers(pub, admin, hooks)
	for _, method := range []string{"GET", "POST"} {
		r := httptest.NewRequest(method, "/payment-hooks/return/"+v.AttemptID+"?status=paid&url=https://evil.test", strings.NewReader("status=paid"))
		w := httptest.NewRecorder()
		hooks.ServeHTTP(w, r)
		if w.Code != 303 || w.Header().Get("Location") != "/payment-return?attempt="+v.AttemptID {
			t.Fatal("unsafe payment return")
		}
	}
	o, _ := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if o.Payment.Status != "review" {
		t.Fatal("browser redirect settled payment")
	}
}

func TestRestaurantPaymentsIntegrationRefundHookInsideCooldownSurvives(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	status := "paid"
	calls := 0
	p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		return restaurantPaymentRemote{ID: "cs_test_one", URL: "https://checkout.stripe.com/c/pay/cs_test_one"}, nil
	}, fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls++
		return restaurantPaymentRemote{ID: id, Status: status, Currency: "SAR", AmountMinor: 3000, Reference: ref}, nil
	}}
	v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, ""); err != nil {
		t.Fatal(err)
	}
	status = "refunded"
	if err = p.Hook(ctx, "stripe", v.AttemptID); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal("cooldown bypassed")
	}
	var dirty bool
	if err = p.db.QueryRowContext(ctx, `SELECT needs_refresh FROM restaurant_payment_attempts WHERE id=$1`, v.AttemptID).Scan(&dirty); err != nil || !dirty {
		t.Fatal("throttled paid refund notification lost")
	}
	if _, err = p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '31 seconds',created_at=now()-interval '10 days' WHERE id=$1`, v.AttemptID); err != nil {
		t.Fatal(err)
	}
	if err = p.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	o, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || o.Payment.Status != "refunded" || calls != 2 {
		t.Fatal("paid/old attempt refund not reconciled")
	}
	if err = p.db.QueryRowContext(ctx, `SELECT needs_refresh FROM restaurant_payment_attempts WHERE id=$1`, v.AttemptID).Scan(&dirty); err != nil || dirty {
		t.Fatal("completed work not acknowledged")
	}
}

func TestRestaurantPaymentsIntegrationConcurrentHookGeneration(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		return restaurantPaymentRemote{ID: "cs_test_one", URL: "https://checkout.stripe.com/c/pay/cs_test_one"}, nil
	}, fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		// Models a newer notification arriving while the authenticated query is in flight.
		if err := p.Hook(ctx, "stripe", ref); err != nil {
			t.Fatal(err)
		}
		return restaurantPaymentRemote{ID: id, Status: "paid", Currency: "SAR", AmountMinor: 3000, Reference: ref}, nil
	}}
	v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil {
		t.Fatal(err)
	}
	if err = p.Hook(ctx, "stripe", v.AttemptID); err != nil {
		t.Fatal(err)
	}
	var dirty bool
	var generation int64
	if err = p.db.QueryRowContext(ctx, `SELECT needs_refresh,refresh_version FROM restaurant_payment_attempts WHERE id=$1`, v.AttemptID).Scan(&dirty, &generation); err != nil || !dirty || generation != 2 {
		t.Fatal("newer notification erased by older query completion")
	}
}
