package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestRestaurantRefundGatewayAuthoritativeBindings(t *testing.T) {
	for _, provider := range []string{"stripe", "tap", "paytabs", "myfatoorah"} {
		for _, wrong := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/wrong=%v", provider, wrong), func(t *testing.T) {
				c := restaurantPaymentConfig{ID: provider, Mode: "test", Values: map[string]string{"profileId": "123"}, Secrets: map[string]string{"secretKey": "sk_test_fake", "serverKey": "fake", "apiToken": "fake"}}
				if provider == "stripe" {
					c = restaurantStripeTestConfig()
				}
				a := restaurantPaymentAttempt{ID: "attempt_1", RemoteID: "payment_1"}
				if provider == "stripe" {
					a.RemoteID = "cs_test_refund"
				}
				r := restaurantRefund{ID: "refund_1", ProviderReference: "refund_remote", AmountMinor: 500, Currency: "SAR"}
				o := restaurantOrder{TotalMinor: 3000, Currency: "SAR", Demo: true}
				if provider == "paytabs" {
					a.RemoteID = "TST_payment"
					r.ProviderReference = "TST_refund"
				}
				if provider == "myfatoorah" {
					a.RemoteID = "1001"
					r.ProviderReference = "2002"
				}
				original := a.RemoteID
				if wrong {
					original = "different_payment"
				}
				currency := "SAR"
				calls := 0
				g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(req *http.Request) (*http.Response, error) {
					calls++
					if req.URL.Path == "/v1/account" {
						return restaurantStripeTestAccountResponse(), nil
					}
					if strings.Contains(req.URL.Path, "checkout/sessions") {
						return restaurantPaymentTestResponse(`{"id":"cs_test_refund","mode":"payment","status":"complete","payment_method_types":["card"],"client_reference_id":"attempt_1","amount_total":3000,"currency":"sar","livemode":false,"payment_status":"paid","payment_intent":{"id":"pi_refund","livemode":false,"status":"succeeded","latest_charge":{"id":"ch_refund","payment_intent":"pi_refund","amount":3000,"amount_captured":3000,"amount_refunded":0,"disputed":false,"currency":"sar","livemode":false,"paid":true,"captured":true}}}`), nil
					}
					switch provider {
					case "stripe":
						charge := "ch_refund"
						if wrong {
							charge = "ch_other"
						}
						return restaurantPaymentTestResponse(fmt.Sprintf(`{"id":"refund_remote","charge":%q,"amount":500,"currency":"sar","status":"succeeded","metadata":{"restaurant_refund":"refund_1"}}`, charge)), nil
					case "tap":
						return restaurantPaymentTestResponse(fmt.Sprintf(`{"id":"refund_remote","charge_id":%q,"amount":5,"currency":%q,"status":"REFUNDED","live_mode":false,"reference":{"merchant":"refund_1"}}`, original, currency)), nil
					case "paytabs":
						return restaurantPaymentTestResponse(fmt.Sprintf(`{"tran_ref":"TST_refund","previous_tran_ref":%q,"tran_type":"Refund","cart_id":"attempt_1","cart_description":"Restaurant refund refund_1","cart_currency":"SAR","cart_amount":5,"payment_result":{"response_status":"A"}}`, original)), nil
					default:
						invoice := "1001"
						if wrong {
							invoice = "9999"
						}
						return restaurantPaymentTestResponse(fmt.Sprintf(`{"IsSuccess":true,"Data":{"RefundStatusResult":[{"RefundId":2002,"InvoiceId":%s,"ExternalIdentifier":"refund_1","RefundStatus":"Refunded","Amount":5,"RefundAmount":5,"BaseCurrency":"SAR"}]}}`, invoice)), nil
					}
				})}}
				got, err := g.FetchRefund(context.Background(), c, a, o, r)
				if wrong {
					if err == nil || got.Status == "succeeded" {
						t.Fatal("cross-payment refund accepted")
					}
				} else if err != nil || got.Status != "succeeded" || got.ID != r.ProviderReference {
					t.Fatalf("valid refund not confirmed %+v %v", got, err)
				}
				if calls == 0 {
					t.Fatal("no authoritative query")
				}
			})
		}
	}
}
func TestRestaurantRefundStripeCreateBlockedBeforeTransport(t *testing.T) {
	for _, c := range []restaurantPaymentConfig{restaurantStripeTestConfig(), {ID: "stripe", Mode: "live", Enabled: true, Secrets: map[string]string{"secretKey": "sk_live_synthetic"}}, {ID: "stripe", Mode: "test"}} {
		calls := 0
		g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(*http.Request) (*http.Response, error) {
			calls++
			return restaurantPaymentTestResponse(`{}`), nil
		})}}
		a := restaurantPaymentAttempt{ID: "attempt_1", RemoteID: "cs_test_synthetic"}
		o := restaurantOrder{TotalMinor: 3000, Currency: "SAR", Demo: true}
		r := restaurantRefund{ID: "refund_1", AmountMinor: 500, Currency: "SAR"}
		got, err := g.CreateRefund(context.Background(), c, a, o, r, 0)
		var preflight restaurantRefundPreflightError
		if !errors.As(err, &preflight) || calls != 0 || got != (restaurantRefundRemote{}) {
			t.Fatalf("checkout-only pilot reached refund transport: %+v %v calls=%d", got, err, calls)
		}
	}
}
func TestRestaurantRefundTapPayTabsMyFatoorahCreateAndDeferredConfirmation(t *testing.T) {
	for _, provider := range []string{"tap", "paytabs", "myfatoorah"} {
		t.Run(provider, func(t *testing.T) {
			c := restaurantPaymentConfig{ID: provider, Mode: "test", Values: map[string]string{"profileId": "123"}, Secrets: map[string]string{"secretKey": "sk_test_fake", "serverKey": "fake", "apiToken": "fake"}}
			a := restaurantPaymentAttempt{ID: "attempt_1", RemoteID: "payment_1"}
			o := restaurantOrder{TotalMinor: 3000, Currency: "SAR", Demo: true}
			r := restaurantRefund{ID: "refund_1", AmountMinor: 500, Currency: "SAR"}
			if provider == "paytabs" {
				a.RemoteID = "TST_payment"
			}
			if provider == "myfatoorah" {
				a.RemoteID = "1001"
			}
			mutations := 0
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(req *http.Request) (*http.Response, error) {
				var body map[string]any
				if req.Method == "POST" {
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
						t.Fatal(err)
					}
				}
				switch provider {
				case "tap":
					if req.URL.Path == "/v2/refunds/list" {
						return restaurantPaymentTestResponse(`{"has_more":false,"refunds":[]}`), nil
					}
					if req.URL.Path == "/v2/refunds" {
						mutations++
						if body["charge_id"] != "payment_1" || body["currency"] != "SAR" || body["amount"] != float64(5) {
							t.Fatal("tap money changed")
						}
						return restaurantPaymentTestResponse(`{"id":"refund_remote","charge_id":"payment_1","amount":5,"currency":"SAR","status":"REFUNDED","live_mode":false,"reference":{"merchant":"refund_1"}}`), nil
					}
					return restaurantPaymentTestResponse(`{"id":"payment_1","amount":30,"currency":"SAR","status":"CAPTURED","live_mode":false,"reference":{"transaction":"attempt_1"}}`), nil
				case "paytabs":
					if req.URL.Path == "/payment/request" {
						mutations++
						if body["tran_type"] != "refund" || body["tran_ref"] != "TST_payment" || body["cart_amount"] != float64(5) {
							t.Fatal("paytabs mutation not bound")
						}
						return restaurantPaymentTestResponse(`{"tran_ref":"TST_refund","previous_tran_ref":"TST_payment","tran_type":"Refund","cart_id":"attempt_1","cart_description":"Restaurant refund refund_1","cart_currency":"SAR","cart_amount":5,"payment_result":{"response_status":"A"}}`), nil
					}
					sale := `{"tran_ref":"TST_payment","tran_type":"sale","cart_id":"attempt_1","cart_currency":"SAR","cart_amount":30,"payment_result":{"response_status":"A"}}`
					if body["cart_id"] != nil {
						sale = "[" + sale + "]"
					}
					return restaurantPaymentTestResponse(sale), nil
				default:
					if req.URL.Path == "/v2/MakeRefund" {
						mutations++
						if body["ServiceChargeOnCustomer"] != false || body["Key"] != "1001" || body["ExternalIdentifier"] != "refund_1" || body["Amount"] != float64(5) {
							t.Fatal("customer fee/binding changed")
						}
						return restaurantPaymentTestResponse(`{"IsSuccess":true,"Data":{"Key":"1001","RefundId":2002,"ExternalIdentifier":"refund_1","Amount":5}}`), nil
					}
					if req.URL.Path == "/v2/GetRefundStatus" {
						return restaurantPaymentTestResponse(`{"IsSuccess":true,"Data":{"RefundStatusResult":[]}}`), nil
					}
					return restaurantPaymentTestResponse(`{"IsSuccess":true,"Data":{"InvoiceId":1001,"InvoiceStatus":"Paid","CustomerReference":"attempt_1","InvoiceValue":30,"InvoiceDisplayValue":"30.00 SAR","InvoiceTransactions":[{"TransactionStatus":"Succss","Currency":"SAR","TransationValue":"30.00"}]}}`), nil
				}
			})}}
			got, err := g.CreateRefund(context.Background(), c, a, o, r, 0)
			if err != nil || got.Status != "processing" || mutations != 1 {
				t.Fatalf("create %+v %v mutations=%d", got, err, mutations)
			}
		})
	}
}
func TestRestaurantRefundUnsupportedProvidersNeverCallNetwork(t *testing.T) {
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("unsupported gateway network request")
		return nil, nil
	})}}
	for _, provider := range []string{"stripe", "moyasar", "hyperpay", "geidea", "unknown"} {
		if restaurantRefundCapabilities(provider).Automatic {
			t.Fatal("unsupported advertised")
		}
		if _, err := g.CreateRefund(context.Background(), restaurantPaymentConfig{ID: provider}, restaurantPaymentAttempt{}, restaurantOrder{}, restaurantRefund{AmountMinor: 1}, 0); err == nil {
			t.Fatal("unsupported accepted")
		}
	}
}
