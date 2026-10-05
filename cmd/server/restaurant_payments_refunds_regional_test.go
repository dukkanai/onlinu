package main

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"
)

func restaurantRegionalRefundResponse(t *testing.T, value any) *http.Response {
	t.Helper()
	raw, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return restaurantPaymentTestResponse(string(raw))
}

func TestRestaurantRegionalRefundMyFatoorah(t *testing.T) {
	base := func(id, amount int, status string) map[string]any {
		return map[string]any{"RefundId": id, "InvoiceId": 1234, "RefundStatus": status, "Amount": amount, "RefundAmount": amount, "BaseCurrency": "SAR"}
	}
	for _, scenario := range []string{"none", "full", "partial", "split", "pending", "canceled", "duplicate", "foreign_invoice", "foreign_currency", "over_total", "wrong_actual", "zero_actual", "unknown_status", "missing_results", "null_results", "unsuccessful", "too_many"} {
		t.Run(scenario, func(t *testing.T) {
			refunds := []map[string]any{}
			want := "review"
			switch scenario {
			case "none":
				want = "paid"
			case "full":
				refunds, want = []map[string]any{base(1, 115, "Refunded")}, "refunded"
			case "partial":
				refunds = []map[string]any{base(1, 10, "Refunded")}
			case "split":
				refunds, want = []map[string]any{base(1, 10, "Refunded"), base(2, 105, "Refunded")}, "refunded"
			case "pending":
				refunds = []map[string]any{base(1, 115, "Pending")}
			case "canceled":
				refunds, want = []map[string]any{base(1, 115, "Canceled")}, "paid"
			case "duplicate":
				refunds = []map[string]any{base(1, 10, "Refunded"), base(1, 105, "Refunded")}
			case "foreign_invoice":
				r := base(1, 115, "Refunded")
				r["InvoiceId"] = 9999
				refunds = []map[string]any{r}
			case "foreign_currency":
				r := base(1, 115, "Refunded")
				r["BaseCurrency"] = "KWD"
				refunds = []map[string]any{r}
			case "over_total":
				refunds = []map[string]any{base(1, 115, "Refunded"), base(2, 1, "Refunded")}
			case "wrong_actual", "zero_actual":
				r := base(1, 115, "Refunded")
				r["RefundAmount"] = 114
				if scenario == "zero_actual" {
					r["RefundAmount"] = 0
				}
				refunds = []map[string]any{r}
			case "unknown_status":
				refunds = []map[string]any{base(1, 115, "UNKNOWN")}
			case "too_many":
				for i := 0; i < 101; i++ {
					refunds = append(refunds, base(i+1, 1, "Canceled"))
				}
			}
			data := map[string]any{"RefundStatusResult": refunds}
			if scenario == "missing_results" {
				delete(data, "RefundStatusResult")
			} else if scenario == "null_results" {
				data["RefundStatusResult"] = nil
			}
			calls := 0
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != "POST" || r.URL.String() != "https://apitest.myfatoorah.com/v2/GetRefundStatus" || r.Header.Get("Authorization") != "Bearer test-only-token" {
					t.Fatal("refund lookup must use fixed authenticated read-only endpoint")
				}
				var body map[string]string
				if json.NewDecoder(r.Body).Decode(&body) != nil || len(body) != 2 || body["Key"] != "1234" || body["KeyType"] != "InvoiceId" {
					t.Fatal("refund lookup not bound to original invoice")
				}
				return restaurantRegionalRefundResponse(t, map[string]any{"IsSuccess": scenario != "unsuccessful", "Data": data}), nil
			})}}
			paid := restaurantPaymentRemote{ID: "1234", Status: "paid", Currency: "SAR", AmountMinor: 11500, Reference: "attempt-123"}
			got, err := g.checkMyFatoorahRefunds(context.Background(), restaurantPaymentConfig{ID: "myfatoorah", Mode: "test", Secrets: map[string]string{"apiToken": "test-only-token"}}, paid)
			if err != nil || got.Status != want || got.ID != paid.ID || got.Reference != paid.Reference || got.AmountMinor != paid.AmountMinor || calls != 1 {
				t.Fatalf("refund scenario %s: got status %s, want %s; err=%v calls=%d", scenario, got.Status, want, err, calls)
			}
		})
	}
}

func TestRestaurantRegionalRefundPayTabs(t *testing.T) {
	base := func(id, previous, kind string, amount int, status string) map[string]any {
		return map[string]any{"tran_ref": id, "previous_tran_ref": previous, "tran_type": kind, "cart_id": "attempt-123", "cart_currency": "SAR", "cart_amount": amount, "payment_result": map[string]string{"response_status": status}}
	}
	for _, scenario := range []string{"none", "full", "partial", "split", "pending", "declined", "duplicate", "foreign_sale", "foreign_cart", "foreign_currency", "wrong_mode", "over_total", "missing_sale", "void", "second_sale", "detail", "detail_foreign_sale", "detail_wrong_amount", "too_many"} {
		t.Run(scenario, func(t *testing.T) {
			rows := []map[string]any{base("TSTsale123", "", "Sale", 115, "A")}
			want := "review"
			switch scenario {
			case "none":
				want = "paid"
			case "full", "detail", "detail_foreign_sale", "detail_wrong_amount":
				previous := "TSTsale123"
				if scenario != "full" {
					previous = ""
				}
				rows = append(rows, base("TSTrefund1", previous, "Refund", 115, "A"))
				if scenario == "full" || scenario == "detail" {
					want = "refunded"
				}
			case "partial":
				rows = append(rows, base("TSTrefund1", "TSTsale123", "Refund", 10, "A"))
			case "split":
				rows = append(rows, base("TSTrefund1", "TSTsale123", "Refund", 10, "A"), base("TSTrefund2", "TSTsale123", "Refund", 105, "A"))
				want = "refunded"
			case "pending":
				rows = append(rows, base("TSTrefund1", "TSTsale123", "Refund", 115, "P"))
			case "declined":
				rows = append(rows, base("TSTrefund1", "TSTsale123", "Refund", 115, "D"))
				want = "paid"
			case "duplicate":
				rows = append(rows, base("TSTrefund1", "TSTsale123", "Refund", 10, "A"), base("TSTrefund1", "TSTsale123", "Refund", 105, "A"))
			case "foreign_sale":
				rows = append(rows, base("TSTrefund1", "TSTdifferent", "Refund", 115, "A"))
			case "foreign_cart", "foreign_currency":
				r := base("TSTrefund1", "TSTsale123", "Refund", 115, "A")
				if scenario == "foreign_cart" {
					r["cart_id"] = "different-attempt"
				} else {
					r["cart_currency"] = "KWD"
				}
				rows = append(rows, r)
			case "wrong_mode":
				rows = append(rows, base("liveRefund1", "TSTsale123", "Refund", 115, "A"))
			case "over_total":
				rows = append(rows, base("TSTrefund1", "TSTsale123", "Refund", 115, "A"), base("TSTrefund2", "TSTsale123", "Refund", 1, "A"))
			case "missing_sale":
				rows = []map[string]any{base("TSTrefund1", "TSTsale123", "Refund", 115, "A")}
			case "void":
				rows = append(rows, base("TSTvoid1", "TSTsale123", "Void", 115, "A"))
			case "second_sale":
				rows = append(rows, base("TSTsale2", "", "Sale", 115, "A"))
			case "too_many":
				for i := 0; i < 50; i++ {
					rows = append(rows, base("TSTrefund1", "TSTsale123", "Refund", 115, "D"))
				}
			}
			calls := 0
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if r.Method != "POST" || r.URL.String() != "https://secure.paytabs.sa/payment/query" || r.Header.Get("Authorization") != "test-only-server-key" {
					t.Fatal("refund lookup must use fixed authenticated read-only endpoint")
				}
				var body map[string]json.RawMessage
				if json.NewDecoder(r.Body).Decode(&body) != nil || string(body["profile_id"]) != "123" || len(body) != 2 {
					t.Fatal("query not bound to merchant profile")
				}
				if calls == 1 {
					if string(body["cart_id"]) != `"attempt-123"` {
						t.Fatal("cart lookup not bound to original attempt")
					}
					return restaurantRegionalRefundResponse(t, rows), nil
				}
				if calls != 2 || string(body["tran_ref"]) != `"TSTrefund1"` {
					t.Fatal("unexpected refund detail query")
				}
				full := base("TSTrefund1", "TSTsale123", "Refund", 115, "A")
				if scenario == "detail_foreign_sale" {
					full["previous_tran_ref"] = "TSTdifferent"
				} else if scenario == "detail_wrong_amount" {
					full["cart_amount"] = 114
				}
				return restaurantRegionalRefundResponse(t, full), nil
			})}}
			paid := restaurantPaymentRemote{ID: "TSTsale123", Status: "paid", Currency: "SAR", AmountMinor: 11500, Reference: "attempt-123"}
			got, err := g.checkPayTabsRefunds(context.Background(), restaurantPaymentConfig{ID: "paytabs", Mode: "test", Values: map[string]string{"profileId": "123"}, Secrets: map[string]string{"serverKey": "test-only-server-key"}}, paid)
			if err != nil || got.Status != want || got.ID != paid.ID || got.Reference != paid.Reference || got.AmountMinor != paid.AmountMinor || calls < 1 || calls > 2 {
				t.Fatalf("refund scenario %s: got status %s, want %s; err=%v calls=%d", scenario, got.Status, want, err, calls)
			}
		})
	}
}

func TestRestaurantRegionalRefundSkipsUnpaid(t *testing.T) {
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("unpaid invoice must not trigger refund lookup")
		return nil, nil
	})}}
	for _, status := range []string{"pending", "failed", "review", "refunded"} {
		in := restaurantPaymentRemote{ID: "1234", Status: status}
		if got, err := g.checkMyFatoorahRefunds(context.Background(), restaurantPaymentConfig{}, in); err != nil || got.Status != status {
			t.Fatal("unpaid MyFatoorah state changed")
		}
		if got, err := g.checkPayTabsRefunds(context.Background(), restaurantPaymentConfig{}, in); err != nil || got.Status != status {
			t.Fatal("unpaid PayTabs state changed")
		}
	}
}
