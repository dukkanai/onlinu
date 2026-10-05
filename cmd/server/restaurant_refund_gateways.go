package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"strconv"
	"strings"
)

// This error proves execution stopped before the mutation request. Ordinary
// transport/parse errors after POST are never wrapped with this marker.
type restaurantRefundPreflightError struct{ error }

// Primary references checked 2026-09-27. No unknown provider endpoint is guessed.
// https://docs.stripe.com/api/refunds/create
// https://docs.stripe.com/api/refunds/retrieve
// https://developers.tap.company/reference/refunds
// https://developers.tap.company/reference/retrieve-a-refund
// https://paytabshelp.freshdesk.com/en/support/solutions/articles/60000807026-7-4-hosted-payment-page-apis-refund-transaction
// https://docs.myfatoorah.com/docs/make-refund
// https://docs.myfatoorah.com/docs/getrefundstatus
// Moyasar's aggregate payment refund endpoint and Geidea's order-level refunds
// need additional unambiguous request attribution before enabling automatic
// dispatch here; HyperPay remains test-only/manual refund. These capabilities
// must not be advertised as supported automatic refunds.
// https://docs.mysr.dev/api/payments/05-refund-payment
// https://docs.geidea.net/docs/refund-2

func (g *restaurantPaymentGateways) refundPreflight(ctx context.Context, c restaurantPaymentConfig, a restaurantPaymentAttempt, o restaurantOrder, expected int64) error {
	paid, err := g.Fetch(ctx, c, a.RemoteID, a.ID)
	if err != nil {
		return err
	}
	if paid.ID != a.RemoteID || paid.Reference != a.ID || paid.AmountMinor != o.TotalMinor || paid.Currency != o.Currency || (c.Mode == "test") != o.Demo {
		return restaurantPaymentProviderError()
	}
	if c.ID == "tap" {
		// The ordinary payment query intentionally maps any partial/pending
		// refund to review. Here we additionally prove the exact known balance.
		var charge restaurantTapCharge
		if err = g.json(ctx, http.MethodGet, "https://api.tap.company/v2/charges/"+url.PathEscape(a.RemoteID), "Bearer "+c.Secrets["secretKey"], nil, &charge); err != nil {
			return err
		}
		if charge.Status != "CAPTURED" || charge.AutoReversed || charge.ID != a.RemoteID || charge.Reference.Transaction != a.ID || charge.LiveMode != (c.Mode == "live") {
			return restaurantPaymentProviderError()
		}
		total, e := g.refundTapBalance(ctx, c, a.RemoteID, o.Currency)
		if e != nil {
			return e
		}
		if total != expected {
			return restaurantPaymentProviderError()
		}
		return nil
	}
	if expected == 0 && paid.Status == "paid" {
		return nil
	}
	if !paid.RefundStateKnown || paid.RefundedMinor != expected || (paid.Status != "paid" && paid.Status != "review") {
		return restaurantPaymentProviderError()
	}
	return nil
}
func (g *restaurantPaymentGateways) CreateRefund(ctx context.Context, c restaurantPaymentConfig, a restaurantPaymentAttempt, o restaurantOrder, r restaurantRefund, expected int64) (restaurantRefundRemote, error) {
	if !restaurantRefundCapabilities(c.ID).Automatic || r.AmountMinor <= 0 || r.AmountMinor > o.TotalMinor-expected || !restaurantPaymentID.MatchString(a.RemoteID) {
		return restaurantRefundRemote{}, restaurantRefundPreflightError{restaurantPaymentProviderError()}
	}
	if err := g.refundPreflight(ctx, c, a, o, expected); err != nil {
		return restaurantRefundRemote{}, restaurantRefundPreflightError{err}
	}
	switch c.ID {
	case "stripe":
		charge, err := g.refundStripeCharge(ctx, c, a, o)
		if err != nil {
			return restaurantRefundRemote{}, restaurantRefundPreflightError{err}
		}
		var out restaurantStripeRefund
		body := url.Values{"charge": {charge}, "amount": {strconv.FormatInt(r.AmountMinor, 10)}, "reason": {"requested_by_customer"}, "metadata[restaurant_refund]": {r.ID}}
		err = g.form(ctx, http.MethodPost, "https://api.stripe.com/v1/refunds", "Bearer "+c.Secrets["secretKey"], body, &out, map[string]string{"Idempotency-Key": "restaurant-refund-" + r.ID})
		if err != nil {
			return restaurantRefundRemote{}, err
		}
		if out.Charge != charge || out.Metadata["restaurant_refund"] != r.ID || out.Amount != r.AmountMinor || strings.ToUpper(out.Currency) != r.Currency {
			return restaurantRefundRemote{}, restaurantPaymentProviderError()
		}
		return restaurantRefundRemote{ID: out.ID, Status: "processing"}, nil
	case "tap":
		var out restaurantTapRefund
		body := map[string]any{"charge_id": a.RemoteID, "amount": json.Number(restaurantPaymentDecimal(r.AmountMinor, r.Currency)), "currency": r.Currency, "reason": "requested_by_customer", "description": "Restaurant refund " + r.ID, "reference": map[string]string{"merchant": r.ID, "idempotent": r.ID}, "metadata": map[string]string{"restaurant_refund": r.ID}}
		if err := g.json(ctx, http.MethodPost, "https://api.tap.company/v2/refunds", "Bearer "+c.Secrets["secretKey"], body, &out); err != nil {
			return restaurantRefundRemote{}, err
		}
		if err := out.validate(c, a, r); err != nil {
			return restaurantRefundRemote{}, err
		}
		return restaurantRefundRemote{ID: out.ID, Status: "processing"}, nil
	case "paytabs":
		var out restaurantPayTabsRefundQuery
		body := map[string]any{"profile_id": json.Number(c.Values["profileId"]), "tran_type": "refund", "tran_class": "ecom", "cart_id": a.ID, "cart_currency": r.Currency, "cart_amount": json.Number(restaurantPaymentDecimal(r.AmountMinor, r.Currency)), "cart_description": "Restaurant refund " + r.ID, "tran_ref": a.RemoteID}
		if err := g.json(ctx, http.MethodPost, "https://secure.paytabs.sa/payment/request", c.Secrets["serverKey"], body, &out); err != nil {
			return restaurantRefundRemote{}, err
		}
		if err := restaurantValidatePayTabsRefund(c, a, r, out); err != nil {
			return restaurantRefundRemote{}, err
		}
		return restaurantRefundRemote{ID: out.ID, Status: "processing"}, nil
	case "myfatoorah":
		var out struct {
			Success bool `json:"IsSuccess"`
			Data    struct {
				Key      string      `json:"Key"`
				ID       json.Number `json:"RefundId"`
				External string      `json:"ExternalIdentifier"`
				Amount   json.Number `json:"Amount"`
			} `json:"Data"`
		}
		body := map[string]any{"Key": a.RemoteID, "KeyType": "InvoiceId", "ServiceChargeOnCustomer": false, "Amount": json.Number(restaurantPaymentDecimal(r.AmountMinor, r.Currency)), "ExternalIdentifier": r.ID, "Comment": "Restaurant refund " + r.ID}
		if err := g.json(ctx, http.MethodPost, restaurantMyFatoorahBase(c)+"/v2/MakeRefund", "Bearer "+c.Secrets["apiToken"], body, &out); err != nil {
			return restaurantRefundRemote{}, err
		}
		amount, e := restaurantPaymentMinor(out.Data.Amount.String(), r.Currency)
		if e != nil || !out.Success || out.Data.Key != a.RemoteID || out.Data.External != r.ID || amount != r.AmountMinor || !restaurantPaymentNumericID.MatchString(out.Data.ID.String()) {
			return restaurantRefundRemote{}, restaurantPaymentProviderError()
		}
		return restaurantRefundRemote{ID: out.Data.ID.String(), Status: "processing"}, nil
	}
	return restaurantRefundRemote{}, restaurantPaymentProviderError()
}

type restaurantStripeRefund struct {
	ID       string            `json:"id"`
	Charge   string            `json:"charge"`
	Amount   int64             `json:"amount"`
	Currency string            `json:"currency"`
	Status   string            `json:"status"`
	Metadata map[string]string `json:"metadata"`
}

func (g *restaurantPaymentGateways) refundStripeCharge(ctx context.Context, c restaurantPaymentConfig, a restaurantPaymentAttempt, o restaurantOrder) (string, error) {
	var out restaurantStripeSession
	if err := g.json(ctx, http.MethodGet, "https://api.stripe.com/v1/checkout/sessions/"+url.PathEscape(a.RemoteID)+"?expand%5B%5D=payment_intent.latest_charge", "Bearer "+c.Secrets["secretKey"], nil, &out); err != nil {
		return "", err
	}
	var intent struct {
		Status string `json:"status"`
		Charge struct {
			ID             string `json:"id"`
			Amount         int64  `json:"amount"`
			CapturedAmount int64  `json:"amount_captured"`
			Currency       string `json:"currency"`
			Live           bool   `json:"livemode"`
			Paid           bool   `json:"paid"`
			Captured       bool   `json:"captured"`
			Disputed       bool   `json:"disputed"`
		} `json:"latest_charge"`
	}
	if json.Unmarshal(out.PaymentIntent, &intent) != nil {
		return "", restaurantPaymentProviderError()
	}
	ch := intent.Charge
	if out.ID != a.RemoteID || out.Reference != a.ID || out.AmountTotal != o.TotalMinor || strings.ToUpper(out.Currency) != o.Currency || out.LiveMode != (c.Mode == "live") || out.PaymentStatus != "paid" || intent.Status != "succeeded" || !ch.Paid || !ch.Captured || ch.Disputed || ch.Amount != o.TotalMinor || ch.CapturedAmount != o.TotalMinor || strings.ToUpper(ch.Currency) != o.Currency || ch.Live != (c.Mode == "live") || !restaurantPaymentID.MatchString(ch.ID) {
		return "", restaurantPaymentProviderError()
	}
	return ch.ID, nil
}

type restaurantTapRefund struct {
	ID        string      `json:"id"`
	Charge    string      `json:"charge_id"`
	Status    string      `json:"status"`
	Currency  string      `json:"currency"`
	Amount    json.Number `json:"amount"`
	Live      *bool       `json:"live_mode"`
	Reference struct {
		Merchant string `json:"merchant"`
	} `json:"reference"`
	Metadata map[string]string `json:"metadata"`
}

func (r restaurantTapRefund) validate(c restaurantPaymentConfig, a restaurantPaymentAttempt, want restaurantRefund) error {
	amount, err := restaurantPaymentMinor(r.Amount.String(), r.Currency)
	if err != nil || r.Live == nil || *r.Live != (c.Mode == "live") || r.Charge != a.RemoteID || r.Currency != want.Currency || amount != want.AmountMinor || !restaurantPaymentID.MatchString(r.ID) || (r.Reference.Merchant != want.ID && r.Metadata["restaurant_refund"] != want.ID) {
		return restaurantPaymentProviderError()
	}
	return nil
}
func restaurantValidatePayTabsRefund(c restaurantPaymentConfig, a restaurantPaymentAttempt, r restaurantRefund, out restaurantPayTabsRefundQuery) error {
	amount, err := restaurantPaymentMinor(out.Amount.String(), out.Currency)
	if err != nil || !strings.EqualFold(out.Type, "refund") || out.Previous != a.RemoteID || out.Reference != a.ID || out.Description != "Restaurant refund "+r.ID || out.Currency != r.Currency || amount != r.AmountMinor || !restaurantPaymentID.MatchString(out.ID) || strings.HasPrefix(out.ID, "TST") != (c.Mode == "test") {
		return restaurantPaymentProviderError()
	}
	return nil
}
func (g *restaurantPaymentGateways) FetchRefund(ctx context.Context, c restaurantPaymentConfig, a restaurantPaymentAttempt, o restaurantOrder, r restaurantRefund) (restaurantRefundRemote, error) {
	if !restaurantPaymentID.MatchString(r.ProviderReference) {
		return restaurantRefundRemote{}, restaurantPaymentProviderError()
	}
	result := restaurantRefundRemote{ID: r.ProviderReference, Status: "review"}
	switch c.ID {
	case "stripe":
		charge, err := g.refundStripeCharge(ctx, c, a, o)
		if err != nil {
			return result, err
		}
		var out restaurantStripeRefund
		if err = g.json(ctx, http.MethodGet, "https://api.stripe.com/v1/refunds/"+url.PathEscape(r.ProviderReference), "Bearer "+c.Secrets["secretKey"], nil, &out); err != nil {
			return result, err
		}
		if out.ID != r.ProviderReference || out.Charge != charge || out.Metadata["restaurant_refund"] != r.ID || out.Amount != r.AmountMinor || strings.ToUpper(out.Currency) != r.Currency {
			return result, restaurantPaymentProviderError()
		}
		switch out.Status {
		case "succeeded":
			result.Status = "succeeded"
		case "pending", "requires_action":
			result.Status = "processing"
		case "failed", "canceled":
			result.Status = "failed"
		}
	case "tap":
		var out restaurantTapRefund
		if err := g.json(ctx, http.MethodGet, "https://api.tap.company/v2/refunds/"+url.PathEscape(r.ProviderReference), "Bearer "+c.Secrets["secretKey"], nil, &out); err != nil {
			return result, err
		}
		if err := out.validate(c, a, r); err != nil {
			return result, err
		}
		if out.ID != r.ProviderReference {
			return result, restaurantPaymentProviderError()
		}
		switch out.Status {
		case "REFUNDED":
			result.Status = "succeeded"
		case "PENDING", "ACCEPTED":
			result.Status = "processing"
		case "DECLINED", "FAILED", "RESTRICTED":
			result.Status = "failed"
		}
	case "paytabs":
		var out restaurantPayTabsRefundQuery
		if err := g.json(ctx, http.MethodPost, "https://secure.paytabs.sa/payment/query", c.Secrets["serverKey"], map[string]any{"profile_id": json.Number(c.Values["profileId"]), "tran_ref": r.ProviderReference}, &out); err != nil {
			return result, err
		}
		if err := restaurantValidatePayTabsRefund(c, a, r, out); err != nil {
			return result, err
		}
		if out.ID != r.ProviderReference {
			return result, restaurantPaymentProviderError()
		}
		switch out.Result.Status {
		case "A":
			result.Status = "succeeded"
		case "P", "H":
			result.Status = "processing"
		case "D", "E", "C":
			result.Status = "failed"
		}
	case "myfatoorah":
		var out struct {
			Success bool `json:"IsSuccess"`
			Data    struct {
				Refunds []struct {
					ID       json.Number `json:"RefundId"`
					Invoice  json.Number `json:"InvoiceId"`
					External string      `json:"ExternalIdentifier"`
					Status   string      `json:"RefundStatus"`
					Amount   json.Number `json:"Amount"`
					Actual   json.Number `json:"RefundAmount"`
					Currency string      `json:"BaseCurrency"`
				} `json:"RefundStatusResult"`
			} `json:"Data"`
		}
		if err := g.json(ctx, http.MethodPost, restaurantMyFatoorahBase(c)+"/v2/GetRefundStatus", "Bearer "+c.Secrets["apiToken"], map[string]string{"Key": r.ProviderReference, "KeyType": "RefundId"}, &out); err != nil {
			return result, err
		}
		if !out.Success || len(out.Data.Refunds) != 1 {
			return result, restaurantPaymentProviderError()
		}
		row := out.Data.Refunds[0]
		currency := row.Currency
		if currency == "SR" {
			currency = "SAR"
		}
		amount, err := restaurantPaymentMinor(row.Amount.String(), currency)
		if err != nil || row.ID.String() != r.ProviderReference || row.Invoice.String() != a.RemoteID || row.External != r.ID || currency != r.Currency || amount != r.AmountMinor {
			return result, restaurantPaymentProviderError()
		}
		switch row.Status {
		case "Refunded":
			actual, err := restaurantPaymentMinor(row.Actual.String(), currency)
			if err != nil || actual != r.AmountMinor {
				return result, restaurantPaymentProviderError()
			}
			result.Status = "succeeded"
		case "Pending":
			result.Status = "processing"
		case "Canceled":
			result.Status = "failed"
		}
	default:
		return result, restaurantPaymentProviderError()
	}
	return result, nil
}
func (g *restaurantPaymentGateways) refundTapBalance(ctx context.Context, c restaurantPaymentConfig, charge, currency string) (int64, error) {
	var out struct {
		HasMore *bool                  `json:"has_more"`
		Refunds *[]restaurantTapRefund `json:"refunds"`
	}
	if err := g.json(ctx, http.MethodPost, "https://api.tap.company/v2/refunds/list", "Bearer "+c.Secrets["secretKey"], map[string]any{"charges": []string{charge}, "limit": 50}, &out); err != nil {
		return 0, err
	}
	if out.HasMore == nil || *out.HasMore || out.Refunds == nil || len(*out.Refunds) > 50 {
		return 0, restaurantPaymentProviderError()
	}
	total := int64(0)
	seen := map[string]bool{}
	for _, r := range *out.Refunds {
		amount, err := restaurantPaymentMinor(r.Amount.String(), r.Currency)
		if err != nil || amount <= 0 || r.Charge != charge || r.Currency != currency || r.Live == nil || *r.Live != (c.Mode == "live") || !restaurantPaymentID.MatchString(r.ID) || seen[r.ID] {
			return 0, restaurantPaymentProviderError()
		}
		seen[r.ID] = true
		switch r.Status {
		case "REFUNDED":
			if total > int64(^uint64(0)>>1)-amount {
				return 0, restaurantPaymentProviderError()
			}
			total += amount
		case "FAILED", "DECLINED", "RESTRICTED":
		default:
			return 0, restaurantPaymentProviderError()
		}
	}
	return total, nil
}
