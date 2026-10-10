package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Synthetic fixtures only. These values never contact a provider.
func restaurantStripeTestConfig() restaurantPaymentConfig {
	return restaurantPaymentConfig{ID: "stripe", Enabled: true, Mode: "test", Values: map[string]string{
		"sandboxPilot": "true", "accountID": "acct_synthetic", "country": "US", "apiVersion": restaurantStripeAPIVersion,
		"sandboxGeneration": "9d773232-04e5-4e80-a24f-f0cd6c1c22a1",
	}, Secrets: map[string]string{"secretKey": "rk_test_synthetic", "webhookSecret": "whsec_syntheticOnly"}}
}
func restaurantStripeTestConfigInput() restaurantPaymentConfigInput {
	c := restaurantStripeTestConfig()
	delete(c.Values, "sandboxGeneration")
	return restaurantPaymentConfigInput{Enabled: c.Enabled, Mode: c.Mode, Values: c.Values, Secrets: c.Secrets}
}
func restaurantStripeTestAccountResponse() *http.Response {
	return restaurantPaymentTestResponse(`{"id":"acct_synthetic","object":"account","country":"US"}`)
}
func restaurantStripeTestReadAttempt(t *testing.T, p *restaurantPayments, id string) restaurantPaymentAttempt {
	t.Helper()
	a, err := p.readAttempt(p.db.QueryRowContext(context.Background(), restaurantPaymentAttemptSelect+` WHERE id=$1`, id))
	if err != nil {
		t.Fatal(err)
	}
	return a
}

func TestRestaurantStripeSandboxFullGuard(t *testing.T) {
	if err := restaurantStripeSandboxReady(restaurantStripeTestConfig()); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		change func(*restaurantPaymentConfig)
	}{
		{"legacy key only", func(c *restaurantPaymentConfig) { c.Values = nil }},
		{"live", func(c *restaurantPaymentConfig) { c.Mode = "live" }},
		{"live key", func(c *restaurantPaymentConfig) { c.Secrets["secretKey"] = "sk_live_synthetic" }},
		{"publishable key", func(c *restaurantPaymentConfig) { c.Secrets["secretKey"] = "pk_test_synthetic" }},
		{"missing key", func(c *restaurantPaymentConfig) { delete(c.Secrets, "secretKey") }},
		{"missing signing secret", func(c *restaurantPaymentConfig) { delete(c.Secrets, "webhookSecret") }},
		{"wrong signing secret", func(c *restaurantPaymentConfig) { c.Secrets["webhookSecret"] = "rk_test_synthetic" }},
		{"pilot missing", func(c *restaurantPaymentConfig) { delete(c.Values, "sandboxPilot") }},
		{"pilot false", func(c *restaurantPaymentConfig) { c.Values["sandboxPilot"] = "false" }},
		{"account missing", func(c *restaurantPaymentConfig) { delete(c.Values, "accountID") }},
		{"account invalid", func(c *restaurantPaymentConfig) { c.Values["accountID"] = "acct_/other" }},
		{"country wrong", func(c *restaurantPaymentConfig) { c.Values["country"] = "SA" }},
		{"version missing", func(c *restaurantPaymentConfig) { delete(c.Values, "apiVersion") }},
		{"version wrong", func(c *restaurantPaymentConfig) { c.Values["apiVersion"] = "2020-08-27" }},
		{"generation missing", func(c *restaurantPaymentConfig) { delete(c.Values, "sandboxGeneration") }},
		{"generation invalid", func(c *restaurantPaymentConfig) { c.Values["sandboxGeneration"] = "not-a-generation" }},
		{"generation zero", func(c *restaurantPaymentConfig) { c.Values["sandboxGeneration"] = uuid.Nil.String() }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := restaurantStripeTestConfig()
			tc.change(&c)
			if restaurantStripeSandboxReady(c) == nil || restaurantPaymentConfigured(c) {
				t.Fatal("unsafe Stripe config is ready")
			}
			calls := 0
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(*http.Request) (*http.Response, error) {
				calls++
				return restaurantPaymentTestResponse(`{}`), nil
			})}}
			r := restaurantPaymentRequest{StripeIntegrationIdentifier: "onlinu_sandbox_abcdefgh", CreatedAt: time.Now(), Currency: "SAR", AmountMinor: 3000}
			if _, err := g.Create(context.Background(), c, r); err == nil {
				t.Fatal("unsafe create accepted")
			}
			if _, err := g.Fetch(context.Background(), c, "cs_test_synthetic", "attempt"); err == nil {
				t.Fatal("unsafe fetch accepted")
			}
			if calls != 0 {
				t.Fatal("incomplete Stripe config reached transport")
			}
		})
	}
	c := restaurantStripeTestConfig()
	c.Enabled = false
	if restaurantStripeSandboxReady(c) != nil || !restaurantPaymentConfigured(c) {
		t.Fatal("disable erased readiness for immutable snapshots")
	}
	g := restaurantPaymentGateways{}
	if _, err := g.Create(context.Background(), c, restaurantPaymentRequest{StripeIntegrationIdentifier: "onlinu_sandbox_abcdefgh", CreatedAt: time.Now(), Currency: "SAR", AmountMinor: 3000}); err == nil {
		t.Fatal("disabled create accepted")
	}
}

func TestRestaurantStripeAccountAndVersionBoundary(t *testing.T) {
	for _, tc := range []struct {
		name, response string
		status         int
		allow          bool
	}{
		{"own US sandbox", `{"id":"acct_synthetic","object":"account","country":"US"}`, 200, true},
		{"foreign account", `{"id":"acct_other","object":"account","country":"US"}`, 200, false},
		{"wrong country", `{"id":"acct_synthetic","object":"account","country":"SA"}`, 200, false},
		{"missing country", `{"id":"acct_synthetic","object":"account"}`, 200, false},
		{"wrong object", `{"id":"acct_synthetic","object":"event","country":"US"}`, 200, false},
		{"restricted permission denied", `{"error":"synthetic missing permission"}`, 403, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			for _, create := range []bool{false, true} {
				accountCalls, checkoutCalls := 0, 0
				g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
					if r.Header.Get("Stripe-Version") != restaurantStripeAPIVersion || r.Header.Get("Authorization") != "Bearer rk_test_synthetic" || r.Header.Get("Stripe-Account") != "" || r.Header.Get("Stripe-Context") != "" {
						t.Fatal("unversioned or cross-account request")
					}
					if r.URL.Host != "api.stripe.com" {
						t.Fatal("unexpected host")
					}
					if r.URL.Path == "/v1/account" {
						if r.Method != http.MethodGet {
							t.Fatal("account request mutates")
						}
						accountCalls++
						response := restaurantPaymentTestResponse(tc.response)
						response.StatusCode = tc.status
						return response, nil
					}
					checkoutCalls++
					return restaurantPaymentTestResponse(`{"id":"cs_test_synthetic","url":"https://checkout.stripe.com/c/pay/synthetic","mode":"payment","payment_method_types":["card"],"livemode":false,"amount_total":3000,"currency":"sar","client_reference_id":"attempt"}`), nil
				})}}
				var err error
				if create {
					_, err = g.Create(context.Background(), restaurantStripeTestConfig(), restaurantPaymentRequest{AttemptID: "attempt", StripeIntegrationIdentifier: "onlinu_sandbox_abcdefgh", CreatedAt: time.Now(), Currency: "SAR", AmountMinor: 3000})
				} else {
					_, err = g.Fetch(context.Background(), restaurantStripeTestConfig(), "cs_test_synthetic", "attempt")
				}
				if (err == nil) != tc.allow || accountCalls != 1 || (checkoutCalls == 1) != tc.allow {
					t.Fatalf("account boundary failure: %v account=%d checkout=%d", err, accountCalls, checkoutCalls)
				}
			}
		})
	}
}

func TestRestaurantStripeExplicitModeAndCapturedIdentity(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any, map[string]any)
		want   string
		fail   bool
	}{
		{"valid captured", func(map[string]any, map[string]any) {}, "paid", false},
		{"unexpected payment methods", func(s, c map[string]any) { s["payment_method_types"] = []string{"card", "link"} }, "", true},
		{"missing payment methods", func(s, c map[string]any) { delete(s, "payment_method_types") }, "", true},
		{"missing session mode", func(s, c map[string]any) { delete(s, "livemode") }, "", true},
		{"null session mode", func(s, c map[string]any) { s["livemode"] = nil }, "", true},
		{"live session", func(s, c map[string]any) { s["livemode"] = true }, "", true},
		{"missing session status", func(s, c map[string]any) { delete(s, "status") }, "review", false},
		{"open paid session", func(s, c map[string]any) { s["status"] = "open" }, "review", false},
		{"expired paid session", func(s, c map[string]any) { s["status"] = "expired" }, "review", false},
		{"missing intent mode", func(s, c map[string]any) { delete(s["payment_intent"].(map[string]any), "livemode") }, "review", false},
		{"null intent mode", func(s, c map[string]any) { s["payment_intent"].(map[string]any)["livemode"] = nil }, "review", false},
		{"live intent", func(s, c map[string]any) { s["payment_intent"].(map[string]any)["livemode"] = true }, "review", false},
		{"missing refund amount", func(s, c map[string]any) { delete(c, "amount_refunded") }, "review", false},
		{"null refund amount", func(s, c map[string]any) { c["amount_refunded"] = nil }, "review", false},
		{"negative refund amount", func(s, c map[string]any) { c["amount_refunded"] = -1 }, "review", false},
		{"excess refund amount", func(s, c map[string]any) { c["amount_refunded"] = 3001 }, "review", false},
		{"missing disputed", func(s, c map[string]any) { delete(c, "disputed") }, "review", false},
		{"null disputed", func(s, c map[string]any) { c["disputed"] = nil }, "review", false},
		{"missing charge mode", func(s, c map[string]any) { delete(c, "livemode") }, "review", false},
		{"null charge mode", func(s, c map[string]any) { c["livemode"] = nil }, "review", false},
		{"live charge", func(s, c map[string]any) { c["livemode"] = true }, "review", false},
		{"missing capture", func(s, c map[string]any) { delete(c, "captured") }, "review", false},
		{"foreign charge intent", func(s, c map[string]any) { c["payment_intent"] = "pi_foreign" }, "review", false},
		{"wrong charge prefix", func(s, c map[string]any) { c["id"] = "pi_synthetic" }, "review", false},
		{"wrong currency", func(s, c map[string]any) { s["currency"] = "usd" }, "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			charge := map[string]any{"id": "ch_synthetic", "payment_intent": "pi_synthetic", "paid": true, "captured": true, "livemode": false, "currency": "sar", "amount": 3000, "amount_captured": 3000, "amount_refunded": 0, "disputed": false}
			body := map[string]any{"id": "cs_test_synthetic", "mode": "payment", "payment_method_types": []string{"card"}, "livemode": false, "payment_status": "paid", "status": "complete", "amount_total": 3000, "currency": "sar", "client_reference_id": "attempt", "payment_intent": map[string]any{"id": "pi_synthetic", "livemode": false, "status": "succeeded", "latest_charge": charge}}
			tc.change(body, charge)
			raw, _ := json.Marshal(body)
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/v1/account" {
					return restaurantStripeTestAccountResponse(), nil
				}
				return restaurantPaymentTestResponse(string(raw)), nil
			})}}
			got, err := g.Fetch(context.Background(), restaurantStripeTestConfig(), "cs_test_synthetic", "attempt")
			if (err != nil) != tc.fail || got.Status != tc.want {
				t.Fatalf("bad capture mapping %+v %v", got, err)
			}
			if tc.want == "paid" && (got.StripeIntentID != "pi_synthetic" || got.StripeChargeID != "ch_synthetic") {
				t.Fatal("authoritative routing identities missing")
			}
			if strings.Contains(tc.name, "intent mode") || tc.name == "live intent" {
				if got.StripeIntentID != "" || got.StripeChargeID != "" {
					t.Fatal("unproven intent mode exposed routing identities")
				}
			}
			if strings.Contains(tc.name, "charge mode") || tc.name == "live charge" || tc.name == "foreign charge intent" || tc.name == "wrong charge prefix" || tc.name == "missing capture" {
				if got.StripeChargeID != "" {
					t.Fatal("incoherent charge became routing identity")
				}
			}
		})
	}
}

func TestRestaurantStripeIntegrationConfigurationGeneration(t *testing.T) {
	p, _ := restaurantPaymentFixture(t)
	ctx := context.Background()
	before, err := p.config(ctx, "stripe")
	if err != nil {
		t.Fatal(err)
	}
	generation := before.Values["sandboxGeneration"]
	if generation == "" || generation == restaurantStripeTestConfig().Values["sandboxGeneration"] {
		t.Fatal("generation was not server generated")
	}
	for _, in := range []restaurantPaymentConfigInput{
		{Mode: "test", Values: map[string]string{"accountID": "acct_other"}},
		{Mode: "test", Values: map[string]string{"country": "SA"}},
		{Mode: "test", Values: map[string]string{"apiVersion": "2020-08-27"}},
		{Mode: "test", Secrets: map[string]string{"webhookSecret": "whsec_changed"}},
		{Mode: "test", ClearSecrets: []string{"webhookSecret"}},
		{Mode: "test", Values: map[string]string{"sandboxGeneration": uuid.NewString()}},
	} {
		if _, err = p.Configure(ctx, "stripe", in); err == nil {
			t.Fatal("frozen routing identity changed")
		}
	}
	public, err := p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Enabled: false, Mode: "test", Secrets: map[string]string{"secretKey": "rk_test_rotated"}})
	if err != nil || public.Enabled || !public.Configured || !public.SecretSet["webhookSecret"] || public.RefundCapability.Automatic {
		t.Fatalf("rotation or disable failed %+v %v", public, err)
	}
	raw, _ := json.Marshal(public)
	if strings.Contains(string(raw), "whsec_") || strings.Contains(string(raw), "rk_test_") {
		t.Fatal("secret leaked from sanitized config")
	}
	after, err := p.config(ctx, "stripe")
	if err != nil || after.Values["sandboxGeneration"] != generation || after.Secrets["webhookSecret"] != before.Secrets["webhookSecret"] {
		t.Fatal("rotation changed endpoint identity")
	}
	if _, err = p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "test"}); err != nil {
		t.Fatal(err)
	}
	if ok, err := p.Available(ctx, "stripe", "SAR"); err != nil || !ok {
		t.Fatal("existing enable toggle failed")
	}
}

func TestRestaurantStripeIntegrationLegacyConfigFailsClosed(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	legacy := restaurantPaymentConfig{ID: "stripe", Enabled: true, Mode: "test", Values: map[string]string{}, Secrets: map[string]string{"secretKey": "sk_test_synthetic"}}
	sealed, err := p.encrypt("config:stripe", legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = p.db.ExecContext(ctx, `UPDATE restaurant_payment_configs SET sealed=$1 WHERE provider='stripe'`, sealed); err != nil {
		t.Fatal(err)
	}
	if ok, err := p.Available(ctx, "stripe", "SAR"); err != nil || ok {
		t.Fatal("legacy key-only config available")
	}
	p.adapter = &restaurantPaymentFakeAdapter{create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		t.Fatal("legacy config reached adapter")
		return restaurantPaymentRemote{}, nil
	}}
	if _, err = p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe"); err == nil {
		t.Fatal("legacy start accepted")
	}
	var count int
	if err = p.db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_payment_attempts`).Scan(&count); err != nil || count != 0 {
		t.Fatal("legacy start created an attempt")
	}
}

func TestRestaurantStripeIntegrationPartialConfigurationAndDefaults(t *testing.T) {
	orders, _, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	p, err := newRestaurantPayments(ctx, db, orders, "https://restaurant.test")
	if err != nil {
		t.Fatal(err)
	}
	initial, err := p.config(ctx, "stripe")
	if err != nil || initial.Enabled || restaurantPaymentConfigured(initial) {
		t.Fatal("default Stripe config enabled")
	}
	partial, err := p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Mode: "test", Secrets: map[string]string{"secretKey": "rk_test_synthetic"}})
	if err != nil || partial.Configured || partial.Enabled {
		t.Fatal("partial disabled config not saved safely", err)
	}
	c, err := p.config(ctx, "stripe")
	if err != nil || c.Values["sandboxGeneration"] != "" {
		t.Fatal("incomplete config generated routing identity")
	}
	if _, err = p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "test"}); err == nil {
		t.Fatal("key-only config enabled")
	}
	input := restaurantStripeTestConfigInput()
	input.Enabled = false
	complete, err := p.Configure(ctx, "stripe", input)
	if err != nil || !complete.Configured || complete.Enabled {
		t.Fatal("complete disabled config rejected", err)
	}
	if _, ok := complete.Values["sandboxGeneration"]; ok {
		t.Fatal("server generation leaked into editable values")
	}
	stored, err := p.config(ctx, "stripe")
	if err != nil || restaurantStripeSandboxReady(stored) != nil {
		t.Fatal("complete config lacks generation")
	}
	// Round-tripping the public editable fields must preserve the generation.
	if _, err = p.Configure(ctx, "stripe", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Values: complete.Values}); err != nil {
		t.Fatal("normal enable/edit round-trip failed", err)
	}
	after, err := p.config(ctx, "stripe")
	if err != nil || after.Values["sandboxGeneration"] != stored.Values["sandboxGeneration"] {
		t.Fatal("enable remapped generation")
	}
}

func TestRestaurantStripeIntegrationIdentityConflictCannotNormalizePartialRefund(t *testing.T) {
	for _, kind := range []string{"intent", "charge"} {
		t.Run(kind, func(t *testing.T) {
			p, receipt := restaurantPaymentFixture(t)
			ctx := context.Background()
			p.adapter = &restaurantPaymentFakeAdapter{create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
				return restaurantPaymentRemote{ID: "cs_test_synthetic", URL: "https://checkout.stripe.com/c/pay/synthetic"}, nil
			}}
			view, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
			if err != nil {
				t.Fatal(err)
			}
			a := restaurantStripeTestReadAttempt(t, p, view.AttemptID)
			remote := restaurantPaymentRemote{ID: a.RemoteID, Reference: a.ID, Currency: "SAR", AmountMinor: receipt.Order.TotalMinor, Status: "paid", StripeIntentID: "pi_synthetic", StripeChargeID: "ch_synthetic"}
			if _, err = p.apply(ctx, a, remote, true); err != nil {
				t.Fatal(err)
			}
			refund := restaurantRefund{ID: uuid.NewString(), Number: receipt.Order.Number, RequestID: uuid.NewString(), Provider: "stripe", Status: "succeeded", Currency: "SAR", AmountMinor: 500, Version: 1}
			raw, err := json.Marshal(refund)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = p.db.ExecContext(ctx, `INSERT INTO restaurant_refunds(id,order_number,request_key,status,amount_minor,tax_minor,data) VALUES($1,$2,$3,'succeeded',500,0,$4)`, refund.ID, refund.Number, refund.RequestID, raw); err != nil {
				t.Fatal(err)
			}
			remote.Status, remote.RefundStateKnown, remote.RefundedMinor = "review", true, 500
			if kind == "intent" {
				remote.StripeIntentID = "pi_foreign"
			} else {
				remote.StripeChargeID = "ch_foreign"
			}
			result, err := p.apply(ctx, a, remote, true)
			if err != nil || result.Status != "review" {
				t.Fatalf("identity conflict normalized to paid %+v %v", result, err)
			}
			var intentID, chargeID string
			if err = p.db.QueryRowContext(ctx, `SELECT stripe_intent_id,stripe_charge_id FROM restaurant_payment_attempts WHERE id=$1`, a.ID).Scan(&intentID, &chargeID); err != nil || intentID != "pi_synthetic" || chargeID != "ch_synthetic" {
				t.Fatal("conflict remapped immutable routing identity", err)
			}
		})
	}
}

func TestRestaurantStripeCreateRequiresPersistedIdentifierAndCardResponse(t *testing.T) {
	for _, tc := range []struct {
		name, identifier, response string
		wantCalls                  int
	}{
		{"missing identifier", "", `{}`, 0},
		{"invalid identifier", "onlinu_sandbox_12345678", `{}`, 0},
		{"missing live mode", "onlinu_sandbox_abcdefgh", `{"id":"cs_test_synthetic","url":"https://checkout.stripe.com/c/pay/synthetic","mode":"payment","payment_method_types":["card"],"amount_total":3000,"currency":"sar","client_reference_id":"attempt"}`, 2},
		{"unexpected methods", "onlinu_sandbox_abcdefgh", `{"id":"cs_test_synthetic","url":"https://checkout.stripe.com/c/pay/synthetic","mode":"payment","livemode":false,"payment_method_types":["card","link"],"amount_total":3000,"currency":"sar","client_reference_id":"attempt"}`, 2},
		{"unsafe checkout URL", "onlinu_sandbox_abcdefgh", `{"id":"cs_test_synthetic","url":"https://checkout.stripe.com.evil.invalid/session","mode":"payment","livemode":false,"payment_method_types":["card"],"amount_total":3000,"currency":"sar","client_reference_id":"attempt"}`, 2},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.URL.Path == "/v1/account" {
					return restaurantStripeTestAccountResponse(), nil
				}
				return restaurantPaymentTestResponse(tc.response), nil
			})}}
			result, err := g.Create(context.Background(), restaurantStripeTestConfig(), restaurantPaymentRequest{AttemptID: "attempt", Currency: "SAR", AmountMinor: 3000, CreatedAt: time.Now(), StripeIntegrationIdentifier: tc.identifier})
			if err == nil || calls != tc.wantCalls || result.URL != "" || result.ID != "" {
				t.Fatalf("unready or broadened checkout exposed %+v %v calls=%d", result, err, calls)
			}
		})
	}
}
