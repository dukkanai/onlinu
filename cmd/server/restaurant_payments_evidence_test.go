package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

func restaurantMoyasarEvidenceFixture() map[string]any {
	return map[string]any{"id": "payment_evidence", "invoice_id": "invoice_evidence", "status": "paid", "amount": 3000, "currency": "SAR", "captured": 0, "refunded": 0}
}

func TestRestaurantPaymentMoyasarEvidence(t *testing.T) {
	for _, tc := range []struct {
		name   string
		change func(map[string]any, map[string]any)
		want   string
	}{
		{"paid", func(i, p map[string]any) {}, "paid"},
		{"captured", func(i, p map[string]any) { p["status"], p["captured"] = "captured", 3000 }, "paid"},
		{"fully-refunded", func(i, p map[string]any) { i["status"], p["status"], p["refunded"] = "refunded", "refunded", 3000 }, "refunded"},
		{"missing-payments", func(i, p map[string]any) { delete(i, "payments") }, "review"},
		{"null-payments", func(i, p map[string]any) { i["payments"] = nil }, "review"},
		{"empty-payments", func(i, p map[string]any) { i["payments"] = []any{} }, "review"},
		{"authorized-only", func(i, p map[string]any) { p["status"] = "authorized" }, "review"},
		{"missing-payment-id", func(i, p map[string]any) { delete(p, "id") }, "review"},
		{"wrong-invoice-link", func(i, p map[string]any) { p["invoice_id"] = "another_invoice" }, "review"},
		{"wrong-amount", func(i, p map[string]any) { p["amount"] = 1 }, "review"},
		{"wrong-currency", func(i, p map[string]any) { p["currency"] = "USD" }, "review"},
		{"negative-refund", func(i, p map[string]any) { p["refunded"] = -1 }, "review"},
		{"excess-refund", func(i, p map[string]any) { p["refunded"] = 3001 }, "review"},
		{"missing-refund", func(i, p map[string]any) { delete(p, "refunded") }, "review"},
		{"null-refund", func(i, p map[string]any) { p["refunded"] = nil }, "review"},
		{"partial-refund", func(i, p map[string]any) { p["refunded"] = 100 }, "review"},
		{"partial-capture", func(i, p map[string]any) { p["captured"] = 100 }, "review"},
		{"missing-capture", func(i, p map[string]any) { delete(p, "captured") }, "review"},
		{"null-capture", func(i, p map[string]any) { p["captured"] = nil }, "review"},
		{"negative-capture", func(i, p map[string]any) { p["captured"] = -1 }, "review"},
		{"excess-capture", func(i, p map[string]any) { p["captured"] = 3001 }, "review"},
		{"captured-status-without-capture", func(i, p map[string]any) { p["status"] = "captured" }, "review"},
		{"unknown-payment-status", func(i, p map[string]any) { p["status"] = "unknown" }, "review"},
		{"duplicate-payment", func(i, p map[string]any) { i["payments"] = []any{p, p} }, "review"},
		{"multiple-charges", func(i, p map[string]any) {
			other := restaurantMoyasarEvidenceFixture()
			other["id"] = "other_payment"
			i["payments"] = []any{p, other}
		}, "review"},
		{"another-authorization", func(i, p map[string]any) {
			other := restaurantMoyasarEvidenceFixture()
			other["id"], other["status"] = "other_payment", "authorized"
			i["payments"] = []any{p, other}
		}, "review"},
		{"prior-failed-payment", func(i, p map[string]any) {
			other := restaurantMoyasarEvidenceFixture()
			other["id"], other["status"] = "other_payment", "failed"
			i["payments"] = []any{other, p}
		}, "paid"},
		{"invoice-mode-conflict", func(i, p map[string]any) { i["live"] = true }, "review"},
		{"payment-mode-conflict", func(i, p map[string]any) { p["test_mode"] = false }, "review"},
		{"null-mode", func(i, p map[string]any) { i["live"] = nil }, "review"},
		{"string-mode-flag", func(i, p map[string]any) { p["live"] = "false" }, "review"},
		{"explicit-test-mode", func(i, p map[string]any) { i["live"], p["mode"] = false, "sandbox" }, "paid"},
		{"contradictory-refund-invoice", func(i, p map[string]any) { i["status"] = "refunded" }, "review"},
		{"contradictory-refund-payment", func(i, p map[string]any) { p["status"], p["refunded"] = "refunded", 3000 }, "review"},
		{"refund-with-open-authorization", func(i, p map[string]any) {
			i["status"], p["status"], p["refunded"] = "refunded", "refunded", 3000
			other := restaurantMoyasarEvidenceFixture()
			other["id"], other["status"] = "other_payment", "authorized"
			i["payments"] = []any{p, other}
		}, "review"},
		{"expired-with-charge", func(i, p map[string]any) { i["status"] = "expired" }, "review"},
		{"unknown-invoice-status", func(i, p map[string]any) { i["status"] = "unknown" }, "review"},
		{"unpaid-invoice", func(i, p map[string]any) { i["status"], i["payments"] = "initiated", []any{} }, "pending"},
		{"expired-unpaid-invoice", func(i, p map[string]any) { i["status"], i["payments"] = "expired", []any{} }, "failed"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			payment := restaurantMoyasarEvidenceFixture()
			body := map[string]any{"id": "invoice_evidence", "status": "paid", "amount": 3000, "currency": "SAR", "description": "Restaurant payment attempt_evidence", "payments": []any{payment}}
			tc.change(body, payment)
			raw, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				if r.Method != http.MethodGet || r.URL.Host != "api.moyasar.com" {
					t.Fatal("unexpected provider operation")
				}
				return restaurantPaymentTestResponse(string(raw)), nil
			})}}
			got, err := g.Fetch(context.Background(), restaurantPaymentConfig{ID: "moyasar", Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_synthetic"}}, "invoice_evidence", "attempt_evidence")
			if err != nil || got.Status != tc.want {
				t.Fatalf("want %s, got %+v, %v", tc.want, got, err)
			}
		})
	}
}

func TestRestaurantPaymentsIntegrationMoyasarUnprovenCaptureCannotReserveRefund(t *testing.T) {
	p, _ := restaurantPaymentFixture(t)
	ctx := context.Background()
	if _, err := p.Configure(ctx, "moyasar", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_synthetic"}}); err != nil {
		t.Fatal(err)
	}
	in := restaurantOrderFixtureInput("pickup")
	in.PaymentProvider = "moyasar"
	receipt, err := p.orders.Create(ctx, in, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	description := ""
	p.adapter = &restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.Method == http.MethodPost {
			if r.URL.Path != "/v1/invoices" {
				t.Fatal("unexpected financial operation")
			}
			var body map[string]any
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			description = body["description"].(string)
		} else if r.Method != http.MethodGet {
			t.Fatal("unexpected financial operation")
		}
		payment := restaurantMoyasarEvidenceFixture()
		payment["status"] = "authorized"
		body := map[string]any{"id": "invoice_evidence", "status": "paid", "amount": receipt.Order.TotalMinor, "currency": "SAR", "description": description, "url": "https://checkout.moyasar.com/invoices/invoice_evidence", "payments": []any{payment}}
		raw, _ := json.Marshal(body)
		return restaurantPaymentTestResponse(string(raw)), nil
	})}}
	if _, err = p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "moyasar"); err != nil {
		t.Fatal(err)
	}
	view, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
	if err != nil || view.Status != "review" {
		t.Fatalf("unproven funds became payable: %+v %v", view, err)
	}
	order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	summary, err := p.Refunds(ctx, order.Number)
	if err != nil || summary.CapturedMinor != 0 || order.Payment.Status != "review" || order.Payment.PaidAt != nil {
		t.Fatalf("unproven capture persisted: %+v %+v %v", order.Payment, summary, err)
	}
	if _, err = p.RequestRefund(ctx, order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: order.TotalMinor, Reason: "Synthetic invalid capture", Version: order.Version}); err == nil {
		t.Fatal("refund reservation accepted without verified funds")
	}
	if restaurantRefundCapabilities("moyasar").Automatic {
		t.Fatal("Moyasar automatic refunds enabled")
	}
}

func TestRestaurantPaymentsIntegrationDashboardRefundReconciledWithoutHook(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	calls := 0
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls++
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: "refunded", AmountMinor: receipt.Order.TotalMinor, Currency: "SAR"}, nil
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '1 day' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	if err := p.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "refunded" || calls != 1 {
		t.Fatalf("dashboard refund missed: %+v calls=%d err=%v", order.Payment, calls, err)
	}
}
