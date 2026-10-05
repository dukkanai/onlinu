package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// All transports in these tests are local fixtures: no merchant account or
// sandbox/live provider is contacted. Contract tests are not acceptance tests.
func TestRestaurantRegionalPayTabs(t *testing.T) {
	cfg := restaurantPaymentConfig{ID: "paytabs", Mode: "test", Values: map[string]string{"profileId": "123"}, Secrets: map[string]string{"serverKey": "mock-only"}}
	status, kind := "A", "Sale"
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "secure.paytabs.sa" || r.Header.Get("Authorization") != "mock-only" {
			t.Fatal("wrong host/auth")
		}
		var b map[string]any
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(r.URL.Path, "/request") {
			if b["cart_id"] != "attempt" || b["cart_amount"] != 115.0 || b["cart_currency"] != "SAR" || b["tran_type"] != "sale" {
				t.Fatalf("wrong amount/reference/type: %v", b)
			}
			return restaurantPaymentTestResponse(`{"tran_ref":"TST123","redirect_url":"https://secure.paytabs.sa/payment/page/mock"}`), nil
		}
		if b["cart_id"] == "attempt" {
			return restaurantPaymentTestResponse(`[{"tran_ref":"TST123","cart_id":"attempt","tran_type":"Sale","cart_currency":"SAR","cart_amount":"115.00","payment_result":{"response_status":"A"}}]`), nil
		}
		if b["tran_ref"] != "TST123" || b["profile_id"] != 123.0 {
			t.Fatal("query not bound to stored transaction")
		}
		return restaurantPaymentTestResponse(`{"tran_ref":"TST123","cart_id":"attempt","tran_type":"` + kind + `","cart_currency":"SAR","cart_amount":"115.00","payment_result":{"response_status":"` + status + `"}}`), nil
	})}}
	r, err := g.Create(context.Background(), cfg, restaurantPaymentRequest{AttemptID: "attempt", OrderNumber: "R1", Currency: "SAR", AmountMinor: 11500})
	if err != nil || r.ID != "TST123" || r.Status == "paid" {
		t.Fatalf("create: %v %v", r, err)
	}
	for _, tc := range []struct{ s, k, want string }{{"A", "Sale", "paid"}, {"A", "Auth", "review"}, {"D", "Sale", "failed"}, {"P", "Sale", "pending"}} {
		status, kind = tc.s, tc.k
		r, err = g.Fetch(context.Background(), cfg, "TST123", "attempt")
		if err != nil || r.Status != tc.want || r.AmountMinor != 11500 || r.Reference != "attempt" {
			t.Fatalf("mapping: %v %v", r, err)
		}
	}
	cfg.Mode = "live"
	if _, err = g.Fetch(context.Background(), cfg, "TST123", "attempt"); err == nil {
		t.Fatal("testtransactionacceptedforlive")
	}
}

func TestRestaurantRegionalPhone(t *testing.T) {
	for _, tc := range []struct{ raw, code, number string }{{"0500000000", "+966", "500000000"}, {"+966500000000", "+966", "500000000"}, {"+966 (50) 000-0000", "+966", "500000000"}, {"00966500000000", "+966", "500000000"}, {"+905551234567", "+90", "5551234567"}, {"+12025550123", "+1", "2025550123"}} {
		code, n, err := restaurantPaymentPhone(tc.raw)
		if err != nil || code != tc.code || n != tc.number {
			t.Fatalf("phone %s -> %s,%s,%v", tc.raw, code, n, err)
		}
	}
	for _, raw := range []string{"", "5551234567", "+999123456789", "+966x12345678", "+000000000000"} {
		if _, _, err := restaurantPaymentPhone(raw); err == nil {
			t.Errorf("invalid phone accepted %s", raw)
		}
	}
}

func TestRestaurantRegionalGeidea(t *testing.T) {
	cfg := restaurantPaymentConfig{ID: "geidea", Mode: "test", Values: map[string]string{"merchantPublicKey": "mock-merchant"}, Secrets: map[string]string{"apiPassword": "mock-password"}}
	refunded, captured, isTest := 0, 115, true
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.Header.Get("Authorization") != restaurantPaymentBasic("mock-merchant", "mock-password") || r.URL.Host != "api.ksamerchant.geidea.net" {
			t.Fatal("auth/host")
		}
		if r.Method == http.MethodPost {
			var b struct {
				Amount                         json.Number
				Currency, Timestamp, Signature string
				Customer                       map[string]string
				Details                        map[string]string `json:"eInvoiceDetails"`
			}
			if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
				t.Fatal(err)
			}
			mac := hmac.New(sha256.New, []byte("mock-password"))
			mac.Write([]byte("mock-merchant115.00SARattempt" + b.Timestamp))
			if b.Signature != base64.StdEncoding.EncodeToString(mac.Sum(nil)) || b.Amount.String() != "115.00" || b.Customer["phoneCountryCode"] != "+966" || b.Details["merchantReferenceId"] != "attempt" {
				t.Fatal("signature/customer/reference")
			}
		}
		if strings.Contains(r.URL.Path, "/direct/order/") {
			b, _ := json.Marshal(map[string]any{"responseCode": "000", "order": map[string]any{"orderId": "order-123", "paymentIntent": map[string]string{"paymentIntentId": "intent-123"}, "currency": "SAR", "amount": 115, "totalCapturedAmount": captured, "totalRefundedAmount": refunded, "status": "Success", "detailedStatus": "Paid", "isTest": isTest}})
			return restaurantPaymentTestResponse(string(b)), nil
		}
		return restaurantPaymentTestResponse(`{"responseCode":"000","detailedResponseCode":"000","paymentIntent":{"paymentIntentId":"intent-123","link":"https://merchant.geidea.net/payByLink/mock","currency":"SAR","amount":115,"status":"Paid","eInvoiceDetails":{"merchantReferenceId":"attempt"},"orders":[{"orderId":"order-123","paymentIntentId":"intent-123","orderStatus":"Success"}]}}`), nil
	})}}
	r, err := g.Create(context.Background(), cfg, restaurantPaymentRequest{AttemptID: "attempt", OrderNumber: "R1", CustomerName: "Customer", Phone: "0500000000", Currency: "SAR", AmountMinor: 11500})
	if err != nil || r.ID != "intent-123" || r.Status == "paid" || !restaurantPaymentURL("geidea", r.URL) {
		t.Fatalf("create: %v %v", r, err)
	}
	for _, tc := range []struct {
		refund, capture int
		test            bool
		want            string
	}{{0, 115, true, "paid"}, {115, 115, true, "refunded"}, {1, 115, true, "review"}, {0, 0, true, "review"}, {0, 115, false, "review"}} {
		refunded, captured, isTest = tc.refund, tc.capture, tc.test
		r, err = g.Fetch(context.Background(), cfg, "intent-123", "attempt")
		if err != nil || r.Status != tc.want || r.AmountMinor != 11500 || r.Reference != "attempt" {
			t.Fatalf("capture/mode/refund: %v %v", r, err)
		}
	}
}

func TestRestaurantRegionalMyFatoorah(t *testing.T) {
	cfg := restaurantPaymentConfig{ID: "myfatoorah", Mode: "test", Values: map[string]string{"paymentMethodId": "2"}, Secrets: map[string]string{"apiToken": "mock-token"}}
	display, currency, txStatus, invoiceStatus := "115.00 SAR", "SAR", "Succss", "Paid"
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "apitest.myfatoorah.com" || r.Header.Get("Authorization") != "Bearer mock-token" {
			t.Fatal("wrong sandbox/auth")
		}
		var b map[string]any
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
			t.Fatal(err)
		}
		if strings.HasSuffix(r.URL.Path, "ExecutePayment") {
			if b["DisplayCurrencyIso"] != nil || b["InvoiceValue"] != 115.0 || b["CustomerReference"] != "attempt" {
				t.Fatal("wrong basecurrency/amount/reference")
			}
			return restaurantPaymentTestResponse(`{"IsSuccess":true,"Data":{"InvoiceId":123,"PaymentURL":"https://demo.myfatoorah.com/pay/mock","IsDirectPayment":false}}`), nil
		}
		if strings.HasSuffix(r.URL.Path, "GetRefundStatus") {
			return restaurantPaymentTestResponse(`{"IsSuccess":true,"Data":{"RefundStatusResult":[]}}`), nil
		}
		if b["Key"] != "123" || b["KeyType"] != "InvoiceId" {
			t.Fatal("lookupnotbound")
		}
		return restaurantPaymentTestResponse(`{"IsSuccess":true,"Data":{"InvoiceId":123,"CustomerReference":"attempt","InvoiceValue":115.00,"InvoiceDisplayValue":"` + display + `","InvoiceStatus":"` + invoiceStatus + `","InvoiceTransactions":[{"TransactionStatus":"` + txStatus + `","Currency":"` + currency + `","TransationValue":"115.00"}]}}`), nil
	})}}
	req := restaurantPaymentRequest{AttemptID: "attempt", OrderNumber: "R1", Currency: "SAR", AmountMinor: 11500}
	r, err := g.Create(context.Background(), cfg, req)
	if err != nil || r.ID != "123" || r.Status == "paid" {
		t.Fatalf("create %v %v", r, err)
	}
	for _, tc := range []struct{ status, tx, cur, want string }{{"Paid", "Succss", "SAR", "paid"}, {"Paid", "Authorize", "SAR", "review"}, {"Paid", "Succss", "KD", "review"}, {"Pending", "Failed", "SAR", "pending"}, {"Canceled", "Canceled", "SAR", "failed"}} {
		invoiceStatus, txStatus, currency = tc.status, tc.tx, tc.cur
		r, err = g.Fetch(context.Background(), cfg, "123", "attempt")
		if err != nil || r.Status != tc.want || r.AmountMinor != 11500 {
			t.Fatalf("state %v %v", r, err)
		}
	}
	display = "115.000 KD"
	if _, err = g.Create(context.Background(), cfg, req); err == nil {
		t.Fatal("SARorderexposedasKWDcheckout")
	}
	if _, err = g.Fetch(context.Background(), cfg, "123", "attempt"); err == nil {
		t.Fatal("basecurrencymismatchaccepted")
	}
}
