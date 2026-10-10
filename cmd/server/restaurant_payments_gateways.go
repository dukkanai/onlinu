package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Official integration references (checked September 2026):
// https://docs.stripe.com/api/checkout/sessions/create
// https://docs.stripe.com/api/checkout/sessions/retrieve
// https://docs.mysr.dev/api/invoices/01-create-invoice/
// https://docs.mysr.dev/api/invoices/04-show-invoice
// https://developers.tap.company/reference/charges
// https://developers.tap.company/reference/retrieve-a-charges
// https://developers.tap.company/docs/recommendations-best-practices
// https://hyperpay.docs.oppwa.com/integrations/widget
// https://hyperpay.docs.oppwa.com/reference/resultCodes
// No endpoint accepts raw card data. Provider URLs are not administrator input.
type restaurantPaymentGateways struct{ client *http.Client }

func restaurantPaymentProviderError() error { return restaurantFail(502, "payment_unavailable") }
func restaurantPaymentDigits(currency string) int {
	switch currency {
	case "JPY", "XOF", "IRR":
		return 0
	case "KWD", "BHD", "OMR":
		return 3
	default:
		return 2
	}
}
func restaurantPaymentDecimal(minor int64, currency string) string {
	digits := restaurantPaymentDigits(currency)
	scale := int64(1)
	for i := 0; i < digits; i++ {
		scale *= 10
	}
	if digits == 0 {
		return strconv.FormatInt(minor, 10)
	}
	return fmt.Sprintf("%d.%0*d", minor/scale, digits, minor%scale)
}
func restaurantPaymentMinor(value, currency string) (int64, error) {
	if len(value) > 40 || strings.ContainsAny(value, "eE/+ ") {
		return 0, restaurantPaymentProviderError()
	}
	r, ok := new(big.Rat).SetString(value)
	if !ok || r.Sign() < 0 {
		return 0, restaurantPaymentProviderError()
	}
	scale := int64(1)
	for i := 0; i < restaurantPaymentDigits(currency); i++ {
		scale *= 10
	}
	r.Mul(r, new(big.Rat).SetInt64(scale))
	if !r.IsInt() || !r.Num().IsInt64() {
		return 0, restaurantPaymentProviderError()
	}
	return r.Num().Int64(), nil
}
func restaurantPaymentBasic(user, password string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+password))
}
func restaurantPaymentAPIURL(raw string) bool {
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return false
	}
	switch u.Hostname() {
	case "restpilot.paylink.sa", "api.stripe.com", "api.moyasar.com", "api.tap.company", "eu-test.oppwa.com", "eu-prod.oppwa.com", "secure.paytabs.sa", "api.ksamerchant.geidea.net", "apitest.myfatoorah.com", "api-sa.myfatoorah.com":
		return true
	}
	return false
}
func restaurantPaymentURL(provider, raw string) bool {
	if provider == "paylink" {
		return restaurantPaylinkCheckout.MatchString(raw)
	}
	u, e := url.Parse(raw)
	if e != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" {
		return false
	}
	hosts := map[string][]string{"stripe": {"checkout.stripe.com"}, "moyasar": {"checkout.moyasar.com"}, "tap": {"checkout.tap.company", "payment.tap.company", "tap.company"}, "paytabs": {"secure.paytabs.sa"}, "geidea": {"www.ksamerchant.geidea.net", "ksamerchant.geidea.net", "merchant.geidea.net"}, "myfatoorah": {"sa.myfatoorah.com", "demo.myfatoorah.com", "portal.myfatoorah.com"}}
	for _, h := range hosts[provider] {
		if strings.EqualFold(u.Hostname(), h) {
			return true
		}
	}
	return false
}
func (g *restaurantPaymentGateways) request(ctx context.Context, method, endpoint, auth, contentType string, data []byte, out any, headers map[string]string) error {
	if !restaurantPaymentAPIURL(endpoint) {
		return restaurantPaymentProviderError()
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	r, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(data))
	if err != nil {
		return restaurantPaymentProviderError()
	}
	r.Header.Set("Authorization", auth)
	r.Header.Set("Accept", "application/json")
	if len(data) > 0 {
		r.Header.Set("Content-Type", contentType)
	}
	for k, v := range headers {
		r.Header.Set(k, v)
	}
	client := http.Client{Timeout: 10 * time.Second}
	if g.client != nil {
		client = *g.client
	}
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := client.Do(r)
	if err != nil {
		return restaurantPaymentProviderError()
	}
	defer response.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(response.Body, 256*1024+1))
	if err != nil || len(raw) > 256*1024 || response.StatusCode < 200 || response.StatusCode >= 300 {
		return restaurantPaymentProviderError()
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if decoder.Decode(out) != nil || decoder.Decode(new(any)) != io.EOF {
		return restaurantPaymentProviderError()
	}
	return nil
}
func (g *restaurantPaymentGateways) json(ctx context.Context, method, endpoint, auth string, body any, out any) error {
	var b []byte
	var err error
	if body != nil {
		b, err = json.Marshal(body)
		if err != nil {
			return restaurantPaymentProviderError()
		}
	}
	return g.request(ctx, method, endpoint, auth, "application/json", b, out, nil)
}
func (g *restaurantPaymentGateways) form(ctx context.Context, method, endpoint, auth string, body url.Values, out any, headers map[string]string) error {
	return g.request(ctx, method, endpoint, auth, "application/x-www-form-urlencoded", []byte(body.Encode()), out, headers)
}

var restaurantPaymentID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$`)
var restaurantPaymentNumericID = regexp.MustCompile(`^[1-9][0-9]{0,19}$`)

func restaurantPaymentValidateConfig(c restaurantPaymentConfig) error {
	if c.ID == "paylink" && c.Mode != "test" {
		return restaurantFail(400, "invalid_request")
	}
	if c.ID == "stripe" || c.ID == "moyasar" || c.ID == "tap" {
		key := c.Secrets["secretKey"]
		if key != "" && !strings.HasPrefix(key, "sk_"+c.Mode+"_") {
			return restaurantFail(400, "invalid_request")
		}
	}
	for _, key := range []string{"profileId", "paymentMethodId"} {
		if v := c.Values[key]; v != "" && !restaurantPaymentNumericID.MatchString(v) {
			return restaurantFail(400, "invalid_request")
		}
	}
	if v := c.Values["entityId"]; v != "" && !restaurantPaymentID.MatchString(v) {
		return restaurantFail(400, "invalid_request")
	}
	return nil
}
func (g *restaurantPaymentGateways) Create(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	switch c.ID {
	case "stripe":
		return g.createStripe(ctx, c, r)
	case "paylink":
		return g.createPaylink(ctx, c, r)
	case "moyasar":
		return g.createMoyasar(ctx, c, r)
	case "tap":
		return g.createTap(ctx, c, r)
	case "hyperpay":
		return g.createHyperPay(ctx, c, r)
	default:
		return g.createRegional(ctx, c, r)
	}
}
func (g *restaurantPaymentGateways) Fetch(ctx context.Context, c restaurantPaymentConfig, id, attempt string) (restaurantPaymentRemote, error) {
	if !restaurantPaymentID.MatchString(id) {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	switch c.ID {
	case "stripe":
		return g.fetchStripe(ctx, c, id)
	case "paylink":
		return g.fetchPaylink(ctx, c, id, attempt)
	case "moyasar":
		return g.fetchMoyasar(ctx, c, id)
	case "tap":
		return g.fetchTap(ctx, c, id)
	case "hyperpay":
		return g.fetchHyperPay(ctx, c, id)
	default:
		return g.fetchRegional(ctx, c, id, attempt)
	}
}

type restaurantStripeSession struct {
	ID            string          `json:"id"`
	URL           string          `json:"url"`
	Status        string          `json:"status"`
	PaymentStatus string          `json:"payment_status"`
	AmountTotal   int64           `json:"amount_total"`
	Currency      string          `json:"currency"`
	Reference     string          `json:"client_reference_id"`
	LiveMode      bool            `json:"livemode"`
	Mode          string          `json:"mode"`
	PaymentIntent json.RawMessage `json:"payment_intent"`
}

func (g *restaurantPaymentGateways) createStripe(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	if r.CreatedAt.IsZero() {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	// Every parameter must stay identical for the attempt's idempotency key.
	// Use its persisted timestamp, never the current clock on a repeated call.
	// A one-minute submission margin avoids starting exactly at Stripe's
	// 30-minute minimum. This does not authorize retrying an uncertain create.
	expires := r.CreatedAt.Add(31 * time.Minute).Unix()
	v := url.Values{"mode": {"payment"}, "payment_method_types[0]": {"card"}, "success_url": {r.ReturnURL}, "cancel_url": {r.ReturnURL}, "client_reference_id": {r.AttemptID}, "metadata[restaurant_attempt]": {r.AttemptID}, "line_items[0][price_data][currency]": {strings.ToLower(r.Currency)}, "line_items[0][price_data][unit_amount]": {strconv.FormatInt(r.AmountMinor, 10)}, "line_items[0][price_data][product_data][name]": {"Order " + r.OrderNumber}, "line_items[0][quantity]": {"1"}, "expires_at": {strconv.FormatInt(expires, 10)}}
	v.Set("payment_intent_data[metadata][restaurant_attempt]", r.AttemptID)
	var out restaurantStripeSession
	err := g.form(ctx, http.MethodPost, "https://api.stripe.com/v1/checkout/sessions", "Bearer "+c.Secrets["secretKey"], v, &out, map[string]string{"Idempotency-Key": "restaurant-" + r.AttemptID})
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.LiveMode != (c.Mode == "live") || out.Reference != r.AttemptID || out.AmountTotal != r.AmountMinor || strings.ToUpper(out.Currency) != r.Currency {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return restaurantPaymentRemote{ID: out.ID, URL: out.URL}, nil
}
func (g *restaurantPaymentGateways) fetchStripe(ctx context.Context, c restaurantPaymentConfig, id string) (restaurantPaymentRemote, error) {
	var out restaurantStripeSession
	if err := g.json(ctx, http.MethodGet, "https://api.stripe.com/v1/checkout/sessions/"+url.PathEscape(id)+"?expand%5B%5D=payment_intent.latest_charge", "Bearer "+c.Secrets["secretKey"], nil, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.ID != id || out.LiveMode != (c.Mode == "live") || out.Mode != "payment" {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	status := "pending"
	refundKnown, refunded := false, int64(0)
	if out.PaymentStatus == "paid" {
		// A Checkout Session remains 'paid' after a later refund. Inspect the
		// expanded captured charge before treating it as an outstanding payment.
		// https://docs.stripe.com/api/charges/object and https://docs.stripe.com/expand
		var intent struct {
			Status string `json:"status"`
			Charge *struct {
				ID             string `json:"id"`
				Currency       string `json:"currency"`
				Captured       bool   `json:"captured"`
				Paid           bool   `json:"paid"`
				Disputed       bool   `json:"disputed"`
				Amount         int64  `json:"amount"`
				CapturedAmount int64  `json:"amount_captured"`
				RefundedAmount int64  `json:"amount_refunded"`
				Live           bool   `json:"livemode"`
			} `json:"latest_charge"`
		}
		status = "review"
		if json.Unmarshal(out.PaymentIntent, &intent) == nil && intent.Charge != nil {
			ch := intent.Charge
			if intent.Status == "succeeded" && ch.ID != "" && ch.Paid && ch.Captured && ch.Amount == out.AmountTotal && ch.CapturedAmount == out.AmountTotal && ch.Currency == out.Currency && ch.Live == (c.Mode == "live") && !ch.Disputed {
				refundKnown = ch.RefundedAmount >= 0 && ch.RefundedAmount <= out.AmountTotal
				refunded = ch.RefundedAmount
				if ch.RefundedAmount == 0 {
					status = "paid"
				} else if ch.RefundedAmount == out.AmountTotal {
					status = "refunded"
				}
			}
		}
	} else if out.Status == "expired" {
		status = "failed"
	}
	return restaurantPaymentRemote{ID: out.ID, Status: status, Currency: strings.ToUpper(out.Currency), AmountMinor: out.AmountTotal, Reference: out.Reference, RefundStateKnown: refundKnown, RefundedMinor: refunded}, nil
}

type restaurantMoyasarInvoice struct {
	ID, Status, Currency, URL string
	Amount                    int64
	Description               string
	Payments                  []restaurantMoyasarPayment
	Metadata                  map[string]string
	restaurantMoyasarMode
}

type restaurantMoyasarPayment struct {
	ID, Status, Currency string
	InvoiceID            string `json:"invoice_id"`
	Amount               int64
	// Missing or null amounts must not turn into a zero-refund/capture proof.
	Captured, Refunded *int64
	restaurantMoyasarMode
}

// Moyasar's authenticated key determines mode; the documented invoice/payment
// objects do not require mode flags. Reject contradictions if flags are present,
// including null or mistyped values, without requiring an invented response field.
type restaurantMoyasarMode struct {
	Live        json.RawMessage `json:"live"`
	LiveMode    json.RawMessage `json:"livemode"`
	LiveModeAlt json.RawMessage `json:"live_mode"`
	Test        json.RawMessage `json:"test"`
	TestMode    json.RawMessage `json:"test_mode"`
	TestModeAlt json.RawMessage `json:"testMode"`
	Mode        json.RawMessage `json:"mode"`
	Environment json.RawMessage `json:"environment"`
}

func (m restaurantMoyasarMode) matches(mode string) bool {
	if mode != "test" && mode != "live" {
		return false
	}
	for _, flag := range []json.RawMessage{m.Live, m.LiveMode, m.LiveModeAlt} {
		if len(flag) != 0 && string(flag) != strconv.FormatBool(mode == "live") {
			return false
		}
	}
	for _, flag := range []json.RawMessage{m.Test, m.TestMode, m.TestModeAlt} {
		if len(flag) != 0 && string(flag) != strconv.FormatBool(mode == "test") {
			return false
		}
	}
	for _, flag := range []json.RawMessage{m.Mode, m.Environment} {
		if len(flag) == 0 {
			continue
		}
		var value string
		if json.Unmarshal(flag, &value) != nil || (mode == "test" && value != "test" && value != "sandbox") || (mode == "live" && value != "live" && value != "production") {
			return false
		}
	}
	return true
}

func (i restaurantMoyasarInvoice) paymentStatus(mode string) string {
	// An invoice's aggregate status is not capture evidence. Require exactly one
	// coherent collected payment, bound to this invoice and its gross amount.
	// https://docs.moyasar.com/api/invoices/04-show-invoice
	if i.Amount <= 0 || !i.matches(mode) || i.Payments == nil || len(i.Payments) > 100 {
		return "review"
	}
	status := "pending"
	switch i.Status {
	case "failed", "canceled", "expired", "voided":
		status = "failed"
	case "initiated", "on_hold", "paid", "refunded":
	default:
		return "review"
	}
	seen := map[string]bool{}
	var charged *restaurantMoyasarPayment
	incomplete := false
	for n := range i.Payments {
		p := &i.Payments[n]
		if !restaurantPaymentID.MatchString(p.ID) || seen[p.ID] || p.InvoiceID != i.ID || p.Amount != i.Amount || p.Currency != i.Currency || !p.matches(mode) || p.Captured == nil || p.Refunded == nil || *p.Captured < 0 || *p.Captured > i.Amount || *p.Refunded < 0 || *p.Refunded > i.Amount {
			return "review"
		}
		seen[p.ID] = true
		switch p.Status {
		case "initiated", "authorized":
			incomplete = true
		case "paid", "captured", "refunded", "failed", "voided", "verified", "expired":
		default:
			return "review"
		}
		if p.Status == "paid" || p.Status == "captured" || p.Status == "refunded" || *p.Captured > 0 || *p.Refunded > 0 {
			if charged != nil {
				return "review"
			}
			charged = p
		}
	}
	if charged != nil {
		p := charged
		if i.Status == "paid" && !incomplete && *p.Refunded == 0 && (p.Status == "paid" && (*p.Captured == 0 || *p.Captured == i.Amount) || p.Status == "captured" && *p.Captured == i.Amount) {
			return "paid"
		}
		if i.Status == "refunded" && !incomplete && p.Status == "refunded" && *p.Refunded == i.Amount && (*p.Captured == 0 || *p.Captured == i.Amount) {
			return "refunded"
		}
		return "review"
	}
	if i.Status == "paid" || i.Status == "refunded" {
		return "review"
	}
	return status
}

func (g *restaurantPaymentGateways) createMoyasar(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	body := map[string]any{"amount": r.AmountMinor, "currency": r.Currency, "description": "Restaurant payment " + r.AttemptID, "callback_url": r.HookURL, "success_url": r.ReturnURL, "back_url": r.ReturnURL, "expired_at": time.Now().Add(30 * time.Minute).UTC().Format(time.RFC3339)}
	var out restaurantMoyasarInvoice
	err := g.json(ctx, http.MethodPost, "https://api.moyasar.com/v1/invoices", restaurantPaymentBasic(c.Secrets["secretKey"], ""), body, &out)
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.Amount != r.AmountMinor || out.Currency != r.Currency || out.Description != "Restaurant payment "+r.AttemptID || !out.matches(c.Mode) {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return restaurantPaymentRemote{ID: out.ID, URL: out.URL}, nil
}
func (g *restaurantPaymentGateways) fetchMoyasar(ctx context.Context, c restaurantPaymentConfig, id string) (restaurantPaymentRemote, error) {
	var out restaurantMoyasarInvoice
	if err := g.json(ctx, http.MethodGet, "https://api.moyasar.com/v1/invoices/"+url.PathEscape(id), restaurantPaymentBasic(c.Secrets["secretKey"], ""), nil, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.ID != id {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	status := out.paymentStatus(c.Mode)
	ref := strings.TrimPrefix(out.Description, "Restaurant payment ")
	return restaurantPaymentRemote{ID: out.ID, Status: status, Currency: out.Currency, AmountMinor: out.Amount, Reference: ref}, nil
}

type restaurantTapCharge struct {
	ID, Status, Currency string
	Amount               json.Number
	LiveMode             bool `json:"live_mode"`
	AutoReversed         bool `json:"auto_reversed"`
	Reference            struct {
		Transaction string `json:"transaction"`
	}
	Transaction struct {
		URL string `json:"url"`
	}
}

func (g *restaurantPaymentGateways) createTap(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	body := map[string]any{"amount": json.Number(restaurantPaymentDecimal(r.AmountMinor, r.Currency)), "currency": r.Currency, "customer_initiated": true, "threeDSecure": true, "save_card": false, "description": "Order " + r.OrderNumber, "reference": map[string]string{"transaction": r.AttemptID, "order": r.OrderNumber, "idempotent": r.AttemptID}, "customer": map[string]string{"first_name": r.CustomerName}, "source": map[string]string{"id": "src_card"}, "post": map[string]string{"url": r.HookURL}, "redirect": map[string]string{"url": r.ReturnURL}}
	var out restaurantTapCharge
	if err := g.json(ctx, http.MethodPost, "https://api.tap.company/v2/charges/", "Bearer "+c.Secrets["secretKey"], body, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	minor, err := restaurantPaymentMinor(out.Amount.String(), out.Currency)
	if err != nil || minor != r.AmountMinor || out.Currency != r.Currency || out.Reference.Transaction != r.AttemptID || out.LiveMode != (c.Mode == "live") {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return restaurantPaymentRemote{ID: out.ID, URL: out.Transaction.URL}, nil
}
func (g *restaurantPaymentGateways) fetchTap(ctx context.Context, c restaurantPaymentConfig, id string) (restaurantPaymentRemote, error) {
	var out restaurantTapCharge
	if err := g.json(ctx, http.MethodGet, "https://api.tap.company/v2/charges/"+url.PathEscape(id), "Bearer "+c.Secrets["secretKey"], nil, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.ID != id || out.LiveMode != (c.Mode == "live") {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	minor, err := restaurantPaymentMinor(out.Amount.String(), out.Currency)
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	status := "pending"
	switch out.Status {
	case "CAPTURED":
		status = "paid"
	case "ABANDONED", "CANCELLED", "FAILED", "DECLINED", "RESTRICTED", "VOID", "TIMEDOUT":
		status = "failed"
	case "UNKNOWN":
		status = "review"
	}
	if out.AutoReversed {
		status = "review"
	}
	if status == "paid" {
		status, err = g.tapRefundStatus(ctx, c, id, out.Currency, minor)
		if err != nil {
			return restaurantPaymentRemote{}, err
		}
	}
	return restaurantPaymentRemote{ID: out.ID, Status: status, Currency: out.Currency, AmountMinor: minor, Reference: out.Reference.Transaction}, nil
}

// Tap's charge may remain CAPTURED after a refund. This is the read-only list
// API, not POST /refunds (which would create a refund). Never infer a refund from
// an unauthenticated callback, and fail closed on incomplete/paginated results.
// https://developers.tap.company/reference/list-all-refunds
// https://developers.tap.company/reference/refunds
func (g *restaurantPaymentGateways) tapRefundStatus(ctx context.Context, c restaurantPaymentConfig, id, currency string, amount int64) (string, error) {
	var out struct {
		HasMore *bool `json:"has_more"`
		Refunds *[]struct {
			ID       string      `json:"id"`
			ChargeID string      `json:"charge_id"`
			Status   string      `json:"status"`
			Currency string      `json:"currency"`
			Amount   json.Number `json:"amount"`
			LiveMode *bool       `json:"live_mode"`
		} `json:"refunds"`
	}
	if err := g.json(ctx, http.MethodPost, "https://api.tap.company/v2/refunds/list", "Bearer "+c.Secrets["secretKey"], map[string]any{"charges": []string{id}, "limit": 50}, &out); err != nil {
		return "", err
	}
	if out.HasMore == nil || *out.HasMore || out.Refunds == nil || len(*out.Refunds) > 50 {
		return "review", nil
	}
	var total int64
	seen := map[string]bool{}
	for _, r := range *out.Refunds {
		if !restaurantPaymentID.MatchString(r.ID) || seen[r.ID] || r.ChargeID != id || r.Currency != currency || r.LiveMode == nil || *r.LiveMode != (c.Mode == "live") {
			return "review", nil
		}
		seen[r.ID] = true
		switch r.Status {
		case "FAILED", "CANCELLED":
			continue
		case "REFUNDED":
		default:
			return "review", nil
		}
		minor, err := restaurantPaymentMinor(r.Amount.String(), r.Currency)
		if err != nil || minor <= 0 || minor > amount-total {
			return "review", nil
		}
		total += minor
	}
	if total == amount && amount > 0 {
		return "refunded", nil
	}
	if total > 0 {
		return "review", nil
	}
	return "paid", nil
}

type restaurantHyperPayResponse struct {
	ID, Currency, Amount string
	PaymentType          string `json:"paymentType"`
	PaymentBrand         string `json:"paymentBrand"`
	Reference            string `json:"merchantTransactionId"`
	Result               struct {
		Code string `json:"code"`
	}
}

func restaurantHyperPayBase(c restaurantPaymentConfig) string {
	if c.Mode == "test" {
		return "https://eu-test.oppwa.com"
	}
	return "https://eu-prod.oppwa.com"
}
func (g *restaurantPaymentGateways) createHyperPay(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	if c.Mode != "test" {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	v := url.Values{"entityId": {c.Values["entityId"]}, "amount": {restaurantPaymentDecimal(r.AmountMinor, r.Currency)}, "currency": {r.Currency}, "paymentType": {"DB"}, "merchantTransactionId": {r.AttemptID}, "testMode": {"EXTERNAL"}}
	var out restaurantHyperPayResponse
	if err := g.form(ctx, http.MethodPost, restaurantHyperPayBase(c)+"/v1/checkouts", "Bearer "+c.Secrets["accessToken"], v, &out, nil); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if !restaurantPaymentID.MatchString(out.ID) || !strings.HasPrefix(out.Result.Code, "000.") {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return restaurantPaymentRemote{ID: out.ID, Widget: &restaurantPaymentWidget{CheckoutID: out.ID, ScriptURL: restaurantHyperPayBase(c) + "/v1/paymentWidgets.js?checkoutId=" + url.QueryEscape(out.ID), Brands: []string{"VISA", "MASTER", "MADA"}, ReturnURL: r.ReturnURL}}, nil
}
func (g *restaurantPaymentGateways) fetchHyperPay(ctx context.Context, c restaurantPaymentConfig, id string) (restaurantPaymentRemote, error) {
	var out restaurantHyperPayResponse
	if err := g.json(ctx, http.MethodGet, restaurantHyperPayBase(c)+"/v1/checkouts/"+url.PathEscape(id)+"/payment?entityId="+url.QueryEscape(c.Values["entityId"]), "Bearer "+c.Secrets["accessToken"], nil, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	minor, err := restaurantPaymentMinor(out.Amount, out.Currency)
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	status := "pending"
	// Restrict the unvalidated sandbox adapter to explicit successful debit
	// results, not generic risk-check/authorization/partially-approved codes.
	if restaurantPaymentID.MatchString(out.ID) && out.PaymentType == "DB" && (out.PaymentBrand == "VISA" || out.PaymentBrand == "MASTER" || out.PaymentBrand == "MADA") {
		switch out.Result.Code {
		case "000.000.000", "000.100.110", "000.100.111", "000.100.112":
			status = "paid"
		}
	}
	return restaurantPaymentRemote{ID: id, Status: status, Currency: out.Currency, AmountMinor: minor, Reference: out.Reference}, nil
}
