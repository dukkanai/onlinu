package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

const paylinkTestID = "030631666083046"

func paylinkTestConfig() restaurantPaymentConfig {
	return restaurantPaymentConfig{ID: "paylink", Mode: "test", Secrets: map[string]string{"apiId": "synthetic-api-id", "secretKey": "synthetic-secret-not-a-provider-key"}}
}
func paylinkTestRequest() restaurantPaymentRequest {
	return restaurantPaymentRequest{AttemptID: "attempt_synthetic", OrderNumber: "R12345678", Currency: "SAR", AmountMinor: 11500,
		CustomerName: "Synthetic customer", Phone: "+966500000000", ReturnURL: "https://restaurant.test/payment-hooks/return/attempt_synthetic", HookURL: "https://restaurant.test/payment-hooks/paylink/attempt_synthetic"}
}
func paylinkTestInvoice(attempt string, amount int64, status string) map[string]any {
	decimal := json.Number(restaurantPaymentDecimal(amount, "SAR"))
	return map[string]any{"success": true, "transactionNo": paylinkTestID, "url": "https://paymentpilot.paylink.sa/pay/info/" + paylinkTestID,
		"orderStatus": status, "amount": decimal, "gatewayOrderRequest": map[string]any{"orderNumber": attempt, "amount": decimal, "currency": "SAR"}}
}
func paylinkTestResponse(t *testing.T, value any) *http.Response {
	t.Helper()
	b, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return restaurantPaymentTestResponse(string(b))
}

func TestRestaurantPaylinkCreateAndRead(t *testing.T) {
	cfg, req := paylinkTestConfig(), paylinkTestRequest()
	authCalls, creates, reads := 0, 0, 0
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "restpilot.paylink.sa" || r.URL.Scheme != "https" || r.URL.RawQuery != "" {
			t.Fatal("request escaped fixed sandbox API")
		}
		if _, ok := r.Context().Deadline(); !ok {
			t.Fatal("request has no timeout")
		}
		if r.Header.Get("Accept") != "application/json" || r.Header.Get("Content-Type") != "application/json" {
			t.Fatal("missing documented JSON headers")
		}
		if r.URL.Path == "/api/auth" {
			authCalls++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if r.Method != "POST" || r.Header.Get("Authorization") != "" || len(body) != 3 || body["apiId"] != cfg.Secrets["apiId"] || body["secretKey"] != cfg.Secrets["secretKey"] || body["persistToken"] != false {
				t.Fatal("incorrect short-lived server-side authentication")
			}
			return paylinkTestResponse(t, map[string]string{"id_token": fmt.Sprintf("synthetic.token.%d", authCalls)}), nil
		}
		if r.Header.Get("Authorization") != fmt.Sprintf("Bearer synthetic.token.%d", authCalls) {
			t.Fatal("cached or missing token")
		}
		switch r.URL.Path {
		case "/api/addInvoice":
			creates++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if r.Method != "POST" || len(body) != 8 || body["orderNumber"] != req.AttemptID || body["amount"] != float64(115) || body["currency"] != "SAR" || body["callBackUrl"] != req.ReturnURL || body["cancelUrl"] != req.ReturnURL || body["clientName"] != req.CustomerName || body["clientMobile"] != req.Phone {
				t.Fatal("invoice request mismatch or extra personal fields")
			}
			products := body["products"].([]any)
			product := products[0].(map[string]any)
			if len(products) != 1 || len(product) != 3 || product["price"] != float64(115) || product["qty"] != float64(1) || product["title"] != "Order "+req.OrderNumber {
				t.Fatal("gross total was changed or tax added")
			}
		case "/api/getInvoice/" + paylinkTestID:
			reads++
			if r.Method != "GET" {
				t.Fatal("query was not read-only")
			}
		default:
			t.Fatal("unexpected operation, webhook, cancellation, or refund")
		}
		return paylinkTestResponse(t, paylinkTestInvoice(req.AttemptID, req.AmountMinor, "Paid")), nil
	})}}
	created, err := g.Create(context.Background(), cfg, req)
	if err != nil || created.Status != "pending" || created.ID != paylinkTestID {
		t.Fatalf("creation may not settle: %+v %v", created, err)
	}
	for range 2 {
		read, err := g.Fetch(context.Background(), cfg, created.ID, req.AttemptID)
		if err != nil || read.Status != "paid" || read.AmountMinor != req.AmountMinor || read.Reference != req.AttemptID || read.Currency != "SAR" || read.RefundStateKnown || read.RefundedMinor != 0 {
			t.Fatalf("read evidence mismatch: %+v %v", read, err)
		}
	}
	if authCalls != 3 || creates != 1 || reads != 2 {
		t.Fatal("invoice was repeated or token retained")
	}
}

func TestRestaurantPaylinkInvoiceEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any)
		want   string
		fail   bool
	}{
		{"paid", func(m map[string]any) {}, "paid", false},
		{"pending", func(m map[string]any) { m["orderStatus"] = "Pending" }, "pending", false},
		{"declined-card-still-pending", func(m map[string]any) {
			m["orderStatus"] = "PENDING"
			m["paymentErrors"] = []any{map[string]string{"errorCode": "05", "errorMessage": "synthetic decline"}}
		}, "pending", false},
		{"canceled-is-not-refunded", func(m map[string]any) { m["orderStatus"] = "Canceled" }, "failed", false},
		{"unknown-status", func(m map[string]any) { m["orderStatus"] = "Refunded" }, "review", false},
		{"missing-status", func(m map[string]any) { delete(m, "orderStatus") }, "review", false},
		{"endpoint-success-is-not-payment", func(m map[string]any) { m["orderStatus"] = "Pending" }, "pending", false},
		{"endpoint-failure", func(m map[string]any) { m["success"] = false }, "", true},
		{"missing-success", func(m map[string]any) { delete(m, "success") }, "", true},
		{"wrong-transaction", func(m map[string]any) { m["transactionNo"] = "12345" }, "", true},
		{"missing-transaction", func(m map[string]any) { delete(m, "transactionNo") }, "", true},
		{"wrong-order", func(m map[string]any) { m["gatewayOrderRequest"].(map[string]any)["orderNumber"] = "other-attempt" }, "", true},
		{"missing-request", func(m map[string]any) { delete(m, "gatewayOrderRequest") }, "", true},
		{"non-sar", func(m map[string]any) { m["gatewayOrderRequest"].(map[string]any)["currency"] = "USD" }, "", true},
		{"missing-currency", func(m map[string]any) { delete(m["gatewayOrderRequest"].(map[string]any), "currency") }, "", true},
		{"incoherent-amount", func(m map[string]any) { m["amount"] = 114 }, "", true},
		{"missing-amount", func(m map[string]any) { delete(m, "amount") }, "", true},
		{"negative-amount", func(m map[string]any) { m["amount"] = -115 }, "", true},
		{"fractional-minor", func(m map[string]any) { m["amount"] = 115.001 }, "", true},
		{"exponent-amount", func(m map[string]any) { m["amount"] = json.Number("1.15e2") }, "", true},
		{"production-redirect", func(m map[string]any) { m["url"] = "https://payment.paylink.sa/pay/info/" + paylinkTestID }, "", true},
		{"wrong-checkout-transaction", func(m map[string]any) { m["url"] = "https://paymentpilot.paylink.sa/pay/info/12345" }, "", true},
		{"ssrf-check-url-ignored", func(m map[string]any) { m["checkUrl"] = "http://169.254.169.254/private" }, "paid", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			invoice := paylinkTestInvoice("attempt_synthetic", 11500, "Paid")
			tc.change(invoice)
			calls := 0
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Host != "restpilot.paylink.sa" {
					t.Fatal("untrusted host")
				}
				if r.URL.Path == "/api/auth" {
					return restaurantPaymentTestResponse(`{"id_token":"synthetic-token"}`), nil
				}
				if r.Method != "GET" || r.URL.Path != "/api/getInvoice/"+paylinkTestID {
					t.Fatal("untrusted operation")
				}
				return paylinkTestResponse(t, invoice), nil
			})}}
			got, err := g.Fetch(context.Background(), paylinkTestConfig(), paylinkTestID, "attempt_synthetic")
			if (err != nil) != tc.fail || !tc.fail && got.Status != tc.want || got.Status == "refunded" || got.RefundStateKnown || calls != 2 {
				t.Fatalf("wrong evidence: %+v %v calls=%d", got, err, calls)
			}
		})
	}
}

func TestRestaurantPaylinkPreflightAndURLBoundaries(t *testing.T) {
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(*http.Request) (*http.Response, error) { t.Fatal("invalid input reached network"); return nil, nil })}}
	for _, change := range []func(*restaurantPaymentRequest){
		func(r *restaurantPaymentRequest) { r.AmountMinor = 499 },
		func(r *restaurantPaymentRequest) { r.Currency = "USD" },
		func(r *restaurantPaymentRequest) { r.Phone = "" },
		func(r *restaurantPaymentRequest) { r.CustomerName = "" },
		func(r *restaurantPaymentRequest) { r.AttemptID = "../evil" },
		func(r *restaurantPaymentRequest) { r.ReturnURL = "http://restaurant.test/return" },
		func(r *restaurantPaymentRequest) { r.ReturnURL = "https://user:password@restaurant.test/return" },
	} {
		req := paylinkTestRequest()
		change(&req)
		var notSubmitted *restaurantPaylinkNotSubmittedError
		if _, err := g.Create(context.Background(), paylinkTestConfig(), req); !errors.As(err, &notSubmitted) {
			t.Fatal("invalid invoice was not classified as never submitted")
		}
	}
	for _, mode := range []string{"live", "", "sandbox"} {
		cfg := paylinkTestConfig()
		cfg.Mode = mode
		if restaurantPaymentConfigured(cfg) || restaurantPaymentValidateConfig(cfg) == nil {
			t.Fatal("unsafe config accepted")
		}
		if _, err := g.Create(context.Background(), cfg, paylinkTestRequest()); err == nil {
			t.Fatal("non-test invoice accepted")
		}
		if _, err := g.Fetch(context.Background(), cfg, paylinkTestID, "attempt_synthetic"); err == nil {
			t.Fatal("non-test query accepted")
		}
	}
	for _, id := range []string{"../123", "https://restapi.paylink.sa/api/getInvoice/123", "1?secret=x", "1/2", "abc", strings.Repeat("1", 41)} {
		if _, err := g.Fetch(context.Background(), paylinkTestConfig(), id, "attempt_synthetic"); err == nil {
			t.Fatal("untrusted ID accepted")
		}
	}
	valid := "https://paymentpilot.paylink.sa/pay/info/" + paylinkTestID
	if !restaurantPaymentURL("paylink", valid) || !restaurantPaymentAPIURL(restaurantPaylinkAPI+"/api/auth") {
		t.Fatal("documented pilot URL rejected")
	}
	for _, raw := range []string{"https://restapi.paylink.sa/api/auth", "https://restpilot.paylink.sa.evil.test/api/auth", "https://restpilot.paylink.sa:443/api/auth", "http://restpilot.paylink.sa/api/auth"} {
		if restaurantPaymentAPIURL(raw) {
			t.Fatal("unapproved Paylink API allowed")
		}
	}
	for _, raw := range []string{strings.Replace(valid, "paymentpilot", "payment", 1), valid + "?next=https://evil.test", valid + "#paid", valid + "/", strings.Replace(valid, ".sa/", ".sa:443/", 1), strings.Replace(valid, ".sa/", ".sa.evil.test/", 1), strings.Replace(valid, "https:", "http:", 1), strings.Replace(valid, "/pay/info/", "/redirect/", 1), "https://paymentpilot.paylink.sa@evil.test/pay/info/123", valid + "\n", strings.Replace(valid, "030", "%3030", 1)} {
		if restaurantPaymentURL("paylink", raw) {
			t.Fatalf("untrusted checkout allowed: %q", raw)
		}
	}
	if restaurantRefundCapabilities("paylink").Automatic {
		t.Fatal("automatic refund enabled")
	}
	if _, err := g.CreateRefund(context.Background(), paylinkTestConfig(), restaurantPaymentAttempt{}, restaurantOrder{}, restaurantRefund{AmountMinor: 500}, 0); err == nil {
		t.Fatal("refund dispatched")
	}
	if err := (&restaurantPayments{}).Hook(context.Background(), "paylink", uuid.NewString()); err == nil {
		t.Fatal("unsupported webhook accepted")
	}
}

func TestRestaurantPaylinkTransportFailuresNeverRetry(t *testing.T) {
	for _, stage := range []string{"auth", "create", "fetch", "fetch-auth"} {
		for _, failure := range []string{"expired", "timeout", "redirect", "oversize", "malformed", "missing-token", "invalid-token"} {
			t.Run(stage+"-"+failure, func(t *testing.T) {
				calls := 0
				g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
					calls++
					if stage != "auth" && stage != "fetch-auth" && r.URL.Path == "/api/auth" {
						return restaurantPaymentTestResponse(`{"id_token":"synthetic-token"}`), nil
					}
					response := restaurantPaymentTestResponse(`{"error":"synthetic-secret-not-a-provider-key"}`)
					switch failure {
					case "expired":
						response.StatusCode = 401
					case "timeout":
						return nil, context.DeadlineExceeded
					case "redirect":
						response.StatusCode = 302
						response.Header.Set("Location", "https://evil.test/steal")
					case "oversize":
						return restaurantPaymentTestResponse(strings.Repeat("x", 256*1024+1)), nil
					case "malformed":
						return restaurantPaymentTestResponse(`{"success":`), nil
					case "missing-token":
						return restaurantPaymentTestResponse(`{}`), nil
					case "invalid-token":
						return restaurantPaymentTestResponse(`{"id_token":"synthetic token with spaces"}`), nil
					}
					return response, nil
				})}}
				var err error
				if stage == "fetch" || stage == "fetch-auth" {
					_, err = g.Fetch(context.Background(), paylinkTestConfig(), paylinkTestID, "attempt_synthetic")
				} else {
					_, err = g.Create(context.Background(), paylinkTestConfig(), paylinkTestRequest())
				}
				wantCalls := 2
				if stage == "auth" || stage == "fetch-auth" {
					wantCalls = 1
				}
				if err == nil || strings.Contains(err.Error(), "synthetic-secret") || calls != wantCalls {
					t.Fatalf("failure was retried or disclosed: %v calls=%d", err, calls)
				}
				var notSubmitted *restaurantPaylinkNotSubmittedError
				if errors.As(err, &notSubmitted) != (stage == "auth") {
					t.Fatalf("incorrect pre-invoice classification at %s: %v", stage, err)
				}
			})
		}
	}
}

func TestRestaurantPaylinkAuthExpiryNextReadUsesFreshToken(t *testing.T) {
	auth, reads := 0, 0
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/auth" {
			auth++
			return paylinkTestResponse(t, map[string]string{"id_token": fmt.Sprintf("synthetic-token-%d", auth)}), nil
		}
		reads++
		if reads == 1 {
			response := restaurantPaymentTestResponse(`{}`)
			response.StatusCode = 401
			return response, nil
		}
		if r.Header.Get("Authorization") != "Bearer synthetic-token-2" {
			t.Fatal("expired token reused")
		}
		return paylinkTestResponse(t, paylinkTestInvoice("attempt_synthetic", 11500, "Pending")), nil
	})}}
	if _, err := g.Fetch(context.Background(), paylinkTestConfig(), paylinkTestID, "attempt_synthetic"); err == nil || auth != 1 || reads != 1 {
		t.Fatal("expiry did not fail closed")
	}
	got, err := g.Fetch(context.Background(), paylinkTestConfig(), paylinkTestID, "attempt_synthetic")
	if err != nil || got.Status != "pending" || auth != 2 || reads != 2 {
		t.Fatal("fresh read could not recover")
	}
}

func TestRestaurantPaylinkQuoteMinimumAndRequiredPhone(t *testing.T) {
	s := restaurantOrders{PaymentAvailable: func(context.Context, string, string) (bool, error) { return true, nil }}
	quote := restaurantQuote{Currency: "SAR", TotalMinor: 500, PaymentMethods: []string{"card"}}
	input := restaurantOrderInput{CustomerName: "Synthetic", Mode: "table", PaymentMethod: "card", PaymentProvider: "paylink", Phone: "+966500000000"}
	if _, err := s.availableQuote(context.Background(), quote, input); err != nil {
		t.Fatal(err)
	}
	quote.TotalMinor = 499
	if _, err := s.availableQuote(context.Background(), quote, input); err == nil {
		t.Fatal("sub-minimum order accepted")
	}
	quote.TotalMinor = 500
	input.Phone = ""
	if _, err := s.availableQuote(context.Background(), quote, input); err == nil {
		t.Fatal("table phone requirement ignored")
	}
}

func TestRestaurantPaymentsIntegrationPaylinkReturnAndIdempotency(t *testing.T) {
	p, _ := restaurantPaymentFixture(t)
	ctx := context.Background()
	defaultConfig, err := p.config(ctx, "paylink")
	if err != nil || defaultConfig.Enabled || restaurantPaymentConfigured(defaultConfig) {
		t.Fatal("Paylink was enabled by default")
	}
	for _, enabled := range []bool{false, true} {
		if _, err := p.Configure(ctx, "paylink", restaurantPaymentConfigInput{Enabled: enabled, Mode: "live", Secrets: paylinkTestConfig().Secrets}); err == nil {
			t.Fatal("live config accepted")
		}
	}
	config, err := p.Configure(ctx, "paylink", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: paylinkTestConfig().Secrets})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(config)
	if strings.Contains(string(raw), "synthetic-api-id") || strings.Contains(string(raw), "synthetic-secret") || !config.SecretSet["apiId"] || !config.SecretSet["secretKey"] || config.Limitation != "paylink_sandbox_only" || config.WebhookURL != "" {
		t.Fatal("secret or capability disclosure")
	}
	input := restaurantOrderFixtureInput("pickup")
	input.PaymentProvider = "paylink"
	receipt, err := p.orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	attempt := ""
	creates, reads := 0, 0
	state := "Pending"
	p.adapter = &restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "restpilot.paylink.sa" {
			t.Fatal("unexpected network")
		}
		if r.URL.Path == "/api/auth" {
			return restaurantPaymentTestResponse(`{"id_token":"synthetic-token"}`), nil
		}
		if r.URL.Path == "/api/addInvoice" && r.Method == "POST" {
			creates++
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			attempt = body["orderNumber"].(string)
		} else if r.URL.Path == "/api/getInvoice/"+paylinkTestID && r.Method == "GET" {
			reads++
		} else {
			t.Fatal("unexpected mutation")
		}
		return paylinkTestResponse(t, paylinkTestInvoice(attempt, receipt.Order.TotalMinor, state)), nil
	})}}
	started, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
	if err != nil || started.Status != "pending" {
		t.Fatalf("start failed: %+v %v", started, err)
	}
	server := &server{payments: p}
	pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
	server.registerRestaurantPaymentHandlers(pub, admin, hooks)
	for range 3 {
		for _, method := range []string{"GET", "POST"} {
			request := httptest.NewRequest(method, "/payment-hooks/return/"+started.AttemptID+"?TransactionNo=9999&OrderNumber=other&status=Paid", strings.NewReader("success=true&amount=999"))
			response := httptest.NewRecorder()
			hooks.ServeHTTP(response, request)
			if response.Code != 303 || response.Header().Get("Location") != "/payment-return?attempt="+started.AttemptID {
				t.Fatal("untrusted return affected route")
			}
		}
		if _, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink"); err != nil {
			t.Fatal(err)
		}
	}
	order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "pending" || creates != 1 || reads != 0 {
		t.Fatal("return settled/recreated invoice")
	}
	state = "Paid"
	view, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
	if err != nil || view.Status != "paid" {
		t.Fatalf("query failed: %+v %v", view, err)
	}
	for range 3 {
		if _, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, ""); err != nil {
			t.Fatal(err)
		}
	}
	if creates != 1 || reads != 1 {
		t.Fatal("repeat return/refresh bypassed lease")
	}
	state = "Canceled"
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '31 seconds' WHERE id=$1`, started.AttemptID); err != nil {
		t.Fatal(err)
	}
	view, err = p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
	if err != nil || view.Status != "review" {
		t.Fatalf("paid cancellation became refund: %+v %v", view, err)
	}
	summary, err := p.Refunds(ctx, receipt.Order.Number)
	if err != nil || summary.RefundedMinor != 0 || summary.Capability.Automatic {
		t.Fatal("refund incorrectly confirmed or enabled")
	}
}

func TestRestaurantPaymentsIntegrationPaylinkUnknownCreationNeverRetried(t *testing.T) {
	p, _ := restaurantPaymentFixture(t)
	ctx := context.Background()
	if _, err := p.Configure(ctx, "paylink", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: paylinkTestConfig().Secrets}); err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("pickup")
	input.PaymentProvider = "paylink"
	receipt, err := p.orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	creates := 0
	p.adapter = &restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/auth" {
			return restaurantPaymentTestResponse(`{"id_token":"synthetic-token"}`), nil
		}
		creates++
		return nil, errors.New("synthetic connection lost after write")
	})}}
	for range 3 {
		view, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
		if err != nil || view.Status != "review" {
			t.Fatalf("uncertain creation was not review: %+v %v", view, err)
		}
	}
	if creates != 1 {
		t.Fatal("uncertain invoice retried")
	}
}

func TestRestaurantPaymentsIntegrationPaylinkWrongServerAmountCannotSettle(t *testing.T) {
	p, _ := restaurantPaymentFixture(t)
	ctx := context.Background()
	if _, err := p.Configure(ctx, "paylink", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: paylinkTestConfig().Secrets}); err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("pickup")
	input.PaymentProvider = "paylink"
	receipt, err := p.orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	attempt := ""
	p.adapter = &restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Path == "/api/auth" {
			return restaurantPaymentTestResponse(`{"id_token":"synthetic-token"}`), nil
		}
		amount := receipt.Order.TotalMinor
		if r.URL.Path == "/api/addInvoice" {
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			attempt = body["orderNumber"].(string)
		} else {
			amount += 100
		}
		return paylinkTestResponse(t, paylinkTestInvoice(attempt, amount, "Paid")), nil
	})}}
	if _, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink"); err != nil {
		t.Fatal(err)
	}
	view, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
	if err != nil || view.Status != "review" {
		t.Fatal("wrong persisted amount settled")
	}
	summary, err := p.Refunds(ctx, receipt.Order.Number)
	if err != nil || summary.CapturedMinor != 0 {
		t.Fatal("invalid amount became captured money")
	}
}

func TestRestaurantPaylinkContextCancellationIsBounded(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) { <-r.Context().Done(); return nil, r.Context().Err() })}}
	if _, err := g.Create(ctx, paylinkTestConfig(), paylinkTestRequest()); err == nil {
		t.Fatal("canceled authentication continued")
	}
}
