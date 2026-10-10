package main

import (
	"encoding/json"
	"reflect"
	"testing"
	"time"
)

func TestRestaurantPaymentPublicViewCheckoutPayloadContract(t *testing.T) {
	widget := &restaurantPaymentWidget{
		CheckoutID: "synthetic-checkout",
		ScriptURL:  "https://provider.test/paymentWidgets.js?checkoutId=synthetic-checkout",
		Brands:     []string{"VISA", "MASTER"},
		ReturnURL:  "https://restaurant.test/payment-hooks/return/synthetic-attempt",
	}
	for _, state := range []struct {
		stored, public string
		checkout       bool
	}{
		{"paid", "paid", false},
		{"failed", "failed", false},
		{"refunded", "refunded", false},
		{"review", "review", false},
		{"pending", "pending", true},
		{"creating", "pending", true},
	} {
		t.Run(state.stored, func(t *testing.T) {
			for _, payload := range []struct {
				name, url string
				widget    *restaurantPaymentWidget
			}{
				{"redirect", "https://provider.test/pay/synthetic-checkout", nil},
				{"widget", "", widget},
				{"both", "https://provider.test/pay/synthetic-checkout", widget},
				{"none", "", nil},
			} {
				t.Run(payload.name, func(t *testing.T) {
					// Retained checkout data must not become actionable again once
					// an attempt is paid, failed, refunded, or awaiting review.
					attempt := restaurantPaymentAttempt{
						ID: "synthetic-attempt", Number: "synthetic-order", Provider: "hyperpay", Mode: "test",
						Status: state.stored, RemoteID: "synthetic-remote", URL: payload.url, Widget: payload.widget,
						Config: restaurantPaymentConfig{
							ID: "hyperpay", Mode: "test",
							Secrets: map[string]string{"accessToken": "synthetic-not-a-credential"},
						},
						CreatedAt: time.Date(2026, time.January, 1, 0, 0, 0, 0, time.UTC),
					}
					view := attempt.view()
					want := restaurantPaymentView{
						AttemptID: attempt.ID, Status: state.public, Provider: attempt.Provider, Mode: attempt.Mode,
					}
					if state.checkout {
						want.URL, want.Widget = payload.url, payload.widget
					}
					if !reflect.DeepEqual(view, want) {
						t.Fatalf("public payment view = %+v, want %+v", view, want)
					}

					encoded, err := json.Marshal(view)
					if err != nil {
						t.Fatal(err)
					}
					var gotJSON map[string]any
					if err := json.Unmarshal(encoded, &gotJSON); err != nil {
						t.Fatal(err)
					}
					wantJSON := map[string]any{
						"attemptId": attempt.ID, "status": state.public, "provider": attempt.Provider, "mode": attempt.Mode,
					}
					if state.checkout && payload.url != "" {
						wantJSON["url"] = payload.url
					}
					if state.checkout && payload.widget != nil {
						wantJSON["widget"] = map[string]any{
							"checkoutId": widget.CheckoutID,
							"scriptUrl":  widget.ScriptURL,
							"brands":     []any{"VISA", "MASTER"},
							"returnUrl":  widget.ReturnURL,
						}
					}
					// Compare the complete wire shape: suppressed fields must be
					// absent, not empty/null, and internal attempt data stays private.
					if !reflect.DeepEqual(gotJSON, wantJSON) {
						t.Fatalf("public payment JSON = %s, want %+v", encoded, wantJSON)
					}
				})
			}
		})
	}
}
