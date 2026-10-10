package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
)

// Experimental sandbox-only hosted checkout. Official references checked 2026-10-09:
// https://developer.paylink.sa/docs/environment-setup
// https://developer.paylink.sa/docs/authentication
// https://developer.paylink.sa/docs/add-invoice
// https://developer.paylink.sa/docs/get-invoice
// https://developer.paylink.sa/docs/payment-processing
// https://developer.paylink.sa/docs/recurring-payment (pilot checkout URL example)
// The ordinary addInvoice example is production. Until authorized sandbox
// acceptance establishes otherwise, accept only the documented pilot checkout
// host/path; never fall back to a production host or provider-supplied checkUrl.
const restaurantPaylinkAPI = "https://restpilot.paylink.sa"

var restaurantPaylinkID = regexp.MustCompile(`^[0-9]{1,40}$`)
var restaurantPaylinkToken = regexp.MustCompile(`^[A-Za-z0-9._~+/-]+={0,2}$`)
var restaurantPaylinkCheckout = regexp.MustCompile(`^https://paymentpilot\.paylink\.sa/pay/info/[0-9]{1,40}$`)

// Only createPaylink may produce this proof that addInvoice was never started.
// In particular, an authentication failure during Fetch says nothing about an
// earlier invoice and must never be classified as a failed creation.
type restaurantPaylinkNotSubmittedError struct{ cause error }

func (e *restaurantPaylinkNotSubmittedError) Error() string { return e.cause.Error() }
func (e *restaurantPaylinkNotSubmittedError) Unwrap() error { return e.cause }

func restaurantPaylinkRequestValid(r restaurantPaymentRequest) error {
	if r.Currency != "SAR" || r.AmountMinor < 500 || !restaurantPaymentID.MatchString(r.AttemptID) || strings.TrimSpace(r.CustomerName) == "" || !restaurantOrderText(r.CustomerName, 100, false) {
		return restaurantFail(400, "invalid_request")
	}
	if !restaurantOrderPhone(r.Phone) {
		return restaurantFail(400, "phone_required")
	}
	u, err := url.Parse(r.ReturnURL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Port() != "" || u.Fragment != "" {
		return restaurantFail(400, "invalid_request")
	}
	return nil
}

func (g *restaurantPaymentGateways) paylinkAuth(ctx context.Context, c restaurantPaymentConfig) (string, error) {
	// No live endpoint, persistent token, or token cache. A fresh short-lived
	// token is requested for each operation; expiry/auth errors fail closed and
	// neither authentication nor invoice creation is automatically retried.
	if c.Mode != "test" || !restaurantPaymentConfigured(c) {
		return "", restaurantPaymentProviderError()
	}
	var out struct {
		Token string `json:"id_token"`
	}
	body := map[string]any{"apiId": c.Secrets["apiId"], "secretKey": c.Secrets["secretKey"], "persistToken": false}
	if err := g.json(ctx, http.MethodPost, restaurantPaylinkAPI+"/api/auth", "", body, &out); err != nil {
		return "", err
	}
	if len(out.Token) > 8192 || !restaurantPaylinkToken.MatchString(out.Token) {
		return "", restaurantPaymentProviderError()
	}
	return "Bearer " + out.Token, nil
}

type restaurantPaylinkInvoice struct {
	Success bool        `json:"success"`
	ID      string      `json:"transactionNo"`
	URL     string      `json:"url"`
	Status  string      `json:"orderStatus"`
	Amount  json.Number `json:"amount"`
	Request *struct {
		Reference string      `json:"orderNumber"`
		Currency  string      `json:"currency"`
		Amount    json.Number `json:"amount"`
	} `json:"gatewayOrderRequest"`
}

func (out restaurantPaylinkInvoice) remote(attempt string) (restaurantPaymentRemote, error) {
	if !out.Success || !restaurantPaylinkID.MatchString(out.ID) || out.Request == nil || out.Request.Reference != attempt || out.Request.Currency != "SAR" {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	amount, err := restaurantPaymentMinor(out.Amount.String(), "SAR")
	requested, requestErr := restaurantPaymentMinor(out.Request.Amount.String(), "SAR")
	if err != nil || requestErr != nil || amount < 500 || amount != requested {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	if out.URL != "" && (!restaurantPaylinkCheckout.MatchString(out.URL) || out.URL != "https://paymentpilot.paylink.sa/pay/info/"+out.ID) {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	status := "review"
	switch strings.ToLower(out.Status) {
	case "pending":
		// Declined card attempts are still Pending; paymentErrors is not a
		// terminal invoice state and is deliberately neither stored nor shown.
		status = "pending"
	case "paid":
		status = "paid"
	case "canceled":
		// Cancellation/24-hour expiry is not evidence of a money refund.
		status = "failed"
	}
	return restaurantPaymentRemote{ID: out.ID, URL: out.URL, Status: status, Currency: "SAR", AmountMinor: amount, Reference: out.Request.Reference}, nil
}

func (g *restaurantPaymentGateways) createPaylink(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	if err := restaurantPaylinkRequestValid(r); err != nil {
		return restaurantPaymentRemote{}, &restaurantPaylinkNotSubmittedError{cause: err}
	}
	auth, err := g.paylinkAuth(ctx, c)
	if err != nil {
		return restaurantPaymentRemote{}, &restaurantPaylinkNotSubmittedError{cause: err}
	}
	amount := json.Number(restaurantPaymentDecimal(r.AmountMinor, r.Currency))
	// The attempt ID is the unique merchant invoice number, not a reusable
	// restaurant order label. Send one gross-total line without any SMS option,
	// extra tax, card data, address, webhook claim, or provider-generated URL.
	body := map[string]any{"orderNumber": r.AttemptID, "amount": amount, "currency": "SAR", "callBackUrl": r.ReturnURL, "cancelUrl": r.ReturnURL,
		"clientName": r.CustomerName, "clientMobile": r.Phone, "products": []map[string]any{{"title": "Order " + r.OrderNumber, "price": amount, "qty": 1}}}
	var out restaurantPaylinkInvoice
	// From this point onward, even a timeout or malformed response is ambiguous:
	// the provider may have accepted the invoice. Do not mark it not submitted.
	if err = g.json(ctx, http.MethodPost, restaurantPaylinkAPI+"/api/addInvoice", auth, body, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	remote, err := out.remote(r.AttemptID)
	if err != nil || remote.AmountMinor != r.AmountMinor || remote.URL == "" || remote.Status != "pending" && remote.Status != "paid" {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	remote.Status = "pending" // Only the later authenticated GET can settle.
	return remote, nil
}

func (g *restaurantPaymentGateways) fetchPaylink(ctx context.Context, c restaurantPaymentConfig, id, attempt string) (restaurantPaymentRemote, error) {
	if !restaurantPaylinkID.MatchString(id) || !restaurantPaymentID.MatchString(attempt) {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	auth, err := g.paylinkAuth(ctx, c)
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	var out restaurantPaylinkInvoice
	if err = g.request(ctx, http.MethodGet, restaurantPaylinkAPI+"/api/getInvoice/"+id, auth, "", nil, &out, map[string]string{"Content-Type": "application/json"}); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.ID != id {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return out.remote(attempt)
}
