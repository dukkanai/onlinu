package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Official regional hosted-checkout APIs; no card data enters this service.
// https://docs.paytabs.com/manuals/PT-API-Endpoints/Integration-Types-Manuals/Request-Response-Parameters/Request-Response-Parameter-Tran-Ref/
// https://docs.geidea.net/reference/create-quick-payment-link-1
// https://docs.geidea.net/docs/fetch-1
// https://docs.myfatoorah.com/docs/execute-payment
// https://docs.myfatoorah.com/docs/get-payment-status
func (g *restaurantPaymentGateways) createRegional(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	switch c.ID {
	case "paytabs":
		return g.createPayTabs(ctx, c, r)
	case "geidea":
		return g.createGeidea(ctx, c, r)
	case "myfatoorah":
		return g.createMyFatoorah(ctx, c, r)
	}
	return restaurantPaymentRemote{}, restaurantPaymentProviderError()
}
func (g *restaurantPaymentGateways) fetchRegional(ctx context.Context, c restaurantPaymentConfig, id, attempt string) (restaurantPaymentRemote, error) {
	switch c.ID {
	case "paytabs":
		return g.fetchPayTabs(ctx, c, id)
	case "geidea":
		return g.fetchGeidea(ctx, c, id)
	case "myfatoorah":
		return g.fetchMyFatoorah(ctx, c, id)
	}
	return restaurantPaymentRemote{}, restaurantPaymentProviderError()
}

type restaurantPayTabsResponse struct {
	ID        string      `json:"tran_ref"`
	URL       string      `json:"redirect_url"`
	Type      string      `json:"tran_type"`
	Reference string      `json:"cart_id"`
	Currency  string      `json:"cart_currency"`
	Amount    json.Number `json:"cart_amount"`
	Result    struct {
		Status string `json:"response_status"`
	} `json:"payment_result"`
}

func (g *restaurantPaymentGateways) createPayTabs(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	body := map[string]any{"profile_id": json.Number(c.Values["profileId"]), "tran_type": "sale", "tran_class": "ecom", "cart_id": r.AttemptID, "cart_description": "Order " + r.OrderNumber, "cart_currency": r.Currency, "cart_amount": json.Number(restaurantPaymentDecimal(r.AmountMinor, r.Currency)), "callback": r.HookURL, "return": r.ReturnURL}
	var out restaurantPayTabsResponse
	if err := g.json(ctx, http.MethodPost, "https://secure.paytabs.sa/payment/request", c.Secrets["serverKey"], body, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if !restaurantPaymentID.MatchString(out.ID) || strings.HasPrefix(out.ID, "TST") != (c.Mode == "test") {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return restaurantPaymentRemote{ID: out.ID, URL: out.URL}, nil
}
func (g *restaurantPaymentGateways) fetchPayTabs(ctx context.Context, c restaurantPaymentConfig, id string) (restaurantPaymentRemote, error) {
	var out restaurantPayTabsResponse
	if err := g.json(ctx, http.MethodPost, "https://secure.paytabs.sa/payment/query", c.Secrets["serverKey"], map[string]any{"profile_id": json.Number(c.Values["profileId"]), "tran_ref": id}, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.ID != id || strings.HasPrefix(out.ID, "TST") != (c.Mode == "test") {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	amount, err := restaurantPaymentMinor(out.Amount.String(), out.Currency)
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	status := "pending"
	switch out.Result.Status {
	case "A":
		if strings.EqualFold(out.Type, "sale") || strings.EqualFold(out.Type, "capture") {
			status = "paid"
		} else {
			status = "review"
		}
	case "D", "E", "C", "V":
		status = "failed"
	}
	return g.checkPayTabsRefunds(ctx, c, restaurantPaymentRemote{ID: id, Status: status, Currency: out.Currency, AmountMinor: amount, Reference: out.Reference})
}

// Saudi national numbers are accepted for this Saudi adapter. Other countries
// must include an explicit international prefix; never invent a customer's data.
func restaurantPaymentPhone(raw string) (string, string, error) {
	p := strings.NewReplacer(" ", "", "-", "", "(", "", ")", "").Replace(restaurantNormalizePhone(raw))
	if len(p) == 10 && strings.HasPrefix(p, "05") {
		return "+966", p[1:], nil
	}
	if strings.HasPrefix(p, "00") {
		p = "+" + p[2:]
	}
	if len(p) == 12 && strings.HasPrefix(p, "966") {
		p = "+" + p
	}
	if !strings.HasPrefix(p, "+") || len(p) < 9 || len(p) > 16 {
		return "", "", restaurantFail(400, "phone_required")
	}
	p = p[1:]
	for _, v := range p {
		if v < '0' || v > '9' {
			return "", "", restaurantFail(400, "phone_required")
		}
	}
	// Assigned ITU country calling codes; the prefix set is unambiguous.
	codes := strings.Fields("1 7 20 27 30 31 32 33 34 36 39 40 41 43 44 45 46 47 48 49 51 52 53 54 55 56 57 58 60 61 62 63 64 65 66 81 82 84 86 90 91 92 93 94 95 98 211 212 213 216 218 220 221 222 223 224 225 226 227 228 229 230 231 232 233 234 235 236 237 238 239 240 241 242 243 244 245 246 247 248 249 250 251 252 253 254 255 256 257 258 260 261 262 263 264 265 266 267 268 269 290 291 297 298 299 350 351 352 353 354 355 356 357 358 359 370 371 372 373 374 375 376 377 378 380 381 382 383 385 386 387 389 420 421 423 500 501 502 503 504 505 506 507 508 509 590 591 592 593 594 595 596 597 598 599 670 672 673 674 675 676 677 678 679 680 681 682 683 685 686 687 688 689 690 691 692 850 852 853 855 856 880 886 960 961 962 963 964 965 966 967 968 970 971 972 973 974 975 976 977 992 993 994 995 996 998")
	for _, code := range codes {
		if strings.HasPrefix(p, code) && len(p)-len(code) >= 6 {
			return "+" + code, p[len(code):], nil
		}
	}
	return "", "", restaurantFail(400, "phone_required")
}

type restaurantGeideaIntentResponse struct {
	Code       string `json:"responseCode"`
	DetailCode string `json:"detailedResponseCode"`
	Intent     struct {
		ID       string      `json:"paymentIntentId"`
		URL      string      `json:"link"`
		Currency string      `json:"currency"`
		Amount   json.Number `json:"amount"`
		Status   string      `json:"status"`
		Details  struct {
			Reference string `json:"merchantReferenceId"`
		} `json:"eInvoiceDetails"`
		Orders []struct {
			ID       string `json:"orderId"`
			IntentID string `json:"paymentIntentId"`
			Status   string `json:"orderStatus"`
		} `json:"orders"`
	} `json:"paymentIntent"`
}

func (g *restaurantPaymentGateways) createGeidea(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	code, phone, err := restaurantPaymentPhone(r.Phone)
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	amount := restaurantPaymentDecimal(r.AmountMinor, r.Currency)
	stamp := time.Now().UTC().Format("1/2/2006 3:04:05 PM")
	mac := hmac.New(sha256.New, []byte(c.Secrets["apiPassword"]))
	mac.Write([]byte(c.Values["merchantPublicKey"] + amount + r.Currency + r.AttemptID + stamp))
	body := map[string]any{"amount": json.Number(amount), "currency": r.Currency, "timestamp": stamp, "signature": base64.StdEncoding.EncodeToString(mac.Sum(nil)), "customer": map[string]string{"name": r.CustomerName, "phoneCountryCode": code, "phoneNumber": phone}, "eInvoiceDetails": map[string]any{"merchantReferenceId": r.AttemptID, "callbackUrl": r.HookURL}}
	var out restaurantGeideaIntentResponse
	if err := g.json(ctx, http.MethodPost, "https://api.ksamerchant.geidea.net/payment-intent/api/v1/direct/eInvoice/quick", restaurantPaymentBasic(c.Values["merchantPublicKey"], c.Secrets["apiPassword"]), body, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	minor, err := restaurantPaymentMinor(out.Intent.Amount.String(), out.Intent.Currency)
	if err != nil || out.Code != "000" || out.DetailCode != "000" || out.Intent.Currency != r.Currency || minor != r.AmountMinor || out.Intent.Details.Reference != r.AttemptID {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return restaurantPaymentRemote{ID: out.Intent.ID, URL: out.Intent.URL}, nil
}
func (g *restaurantPaymentGateways) fetchGeidea(ctx context.Context, c restaurantPaymentConfig, id string) (restaurantPaymentRemote, error) {
	auth := restaurantPaymentBasic(c.Values["merchantPublicKey"], c.Secrets["apiPassword"])
	var out restaurantGeideaIntentResponse
	if err := g.json(ctx, http.MethodGet, "https://api.ksamerchant.geidea.net/payment-intent/api/v1/direct/eInvoice/"+url.PathEscape(id), auth, nil, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if out.Code != "000" || out.DetailCode != "000" || out.Intent.ID != id {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	amount, err := restaurantPaymentMinor(out.Intent.Amount.String(), out.Intent.Currency)
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	result := restaurantPaymentRemote{ID: id, Status: "pending", Currency: out.Intent.Currency, AmountMinor: amount, Reference: out.Intent.Details.Reference}
	if out.Intent.Status == "Expired" || out.Intent.Status == "Cancelled" {
		result.Status = "failed"
		return result, nil
	}
	if out.Intent.Status != "Paid" {
		return result, nil
	}
	// A paid link alone is not proof of capture; verify its bound payment order.
	result.Status = "review"
	if len(out.Intent.Orders) > 10 {
		return result, nil
	}
	for _, item := range out.Intent.Orders {
		if item.Status != "Success" {
			continue
		}
		if item.IntentID != id || !restaurantPaymentID.MatchString(item.ID) {
			return result, nil
		}
		var order struct {
			Code  string `json:"responseCode"`
			Order struct {
				ID             string      `json:"orderId"`
				Status         string      `json:"status"`
				DetailedStatus string      `json:"detailedStatus"`
				Currency       string      `json:"currency"`
				IsTest         *bool       `json:"isTest"`
				Amount         json.Number `json:"amount"`
				Captured       json.Number `json:"totalCapturedAmount"`
				Refunded       json.Number `json:"totalRefundedAmount"`
				Intent         struct {
					ID string `json:"paymentIntentId"`
				} `json:"paymentIntent"`
			} `json:"order"`
		}
		if err := g.json(ctx, http.MethodGet, "https://api.ksamerchant.geidea.net/pgw/api/v1/direct/order/"+url.PathEscape(item.ID), auth, nil, &order); err != nil {
			return restaurantPaymentRemote{}, err
		}
		o := order.Order
		captured, e1 := restaurantPaymentMinor(o.Captured.String(), o.Currency)
		refunded, e2 := restaurantPaymentMinor(o.Refunded.String(), o.Currency)
		gross, e3 := restaurantPaymentMinor(o.Amount.String(), o.Currency)
		if order.Code != "000" || o.ID != item.ID || o.Intent.ID != id || o.IsTest == nil || *o.IsTest != (c.Mode == "test") || o.Currency != result.Currency || e1 != nil || e2 != nil || e3 != nil || gross != amount || captured != amount {
			return result, nil
		}
		if refunded == amount {
			result.Status = "refunded"
		} else if refunded > 0 {
			result.Status = "review"
		} else if o.Status == "Success" && (o.DetailedStatus == "Paid" || o.DetailedStatus == "Captured") {
			result.Status = "paid"
		}
		return result, nil
	}
	return result, nil
}

func restaurantMyFatoorahBase(c restaurantPaymentConfig) string {
	if c.Mode == "test" {
		return "https://apitest.myfatoorah.com"
	}
	return "https://api-sa.myfatoorah.com"
}
func (g *restaurantPaymentGateways) createMyFatoorah(ctx context.Context, c restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	// Deliberately do NOT set DisplayCurrencyIso. It only converts display and
	// cannot change the merchant's base currency used by InvoiceValue.
	body := map[string]any{"InvoiceValue": json.Number(restaurantPaymentDecimal(r.AmountMinor, r.Currency)), "PaymentMethodId": json.Number(c.Values["paymentMethodId"]), "CustomerName": r.CustomerName, "CustomerReference": r.AttemptID, "CallBackUrl": r.ReturnURL, "ErrorUrl": r.ReturnURL, "WebhookUrl": r.HookURL, "Language": "AR"}
	var out struct {
		Success bool `json:"IsSuccess"`
		Data    struct {
			ID     json.Number `json:"InvoiceId"`
			URL    string      `json:"PaymentURL"`
			Direct bool        `json:"IsDirectPayment"`
		} `json:"Data"`
	}
	if err := g.json(ctx, http.MethodPost, restaurantMyFatoorahBase(c)+"/v2/ExecutePayment", "Bearer "+c.Secrets["apiToken"], body, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if !out.Success || out.Data.Direct || !restaurantPaymentNumericID.MatchString(out.Data.ID.String()) {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	// Verify the base/display currency before exposing a payable link. Default
	// KWD demo accounts must never collect a SAR order as the same number of KWD.
	verified, err := g.fetchMyFatoorah(ctx, c, out.Data.ID.String())
	if err != nil || verified.Currency != r.Currency || verified.AmountMinor != r.AmountMinor || verified.Reference != r.AttemptID {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	return restaurantPaymentRemote{ID: out.Data.ID.String(), URL: out.Data.URL}, nil
}
func (g *restaurantPaymentGateways) fetchMyFatoorah(ctx context.Context, c restaurantPaymentConfig, id string) (restaurantPaymentRemote, error) {
	var out struct {
		Success bool `json:"IsSuccess"`
		Data    struct {
			ID           json.Number `json:"InvoiceId"`
			Status       string      `json:"InvoiceStatus"`
			Reference    string      `json:"CustomerReference"`
			Amount       json.Number `json:"InvoiceValue"`
			Display      string      `json:"InvoiceDisplayValue"`
			Transactions []struct {
				Status   string `json:"TransactionStatus"`
				Currency string `json:"Currency"`
				Amount   string `json:"TransationValue"`
			} `json:"InvoiceTransactions"`
		} `json:"Data"`
	}
	if err := g.json(ctx, http.MethodPost, restaurantMyFatoorahBase(c)+"/v2/GetPaymentStatus", "Bearer "+c.Secrets["apiToken"], map[string]string{"Key": id, "KeyType": "InvoiceId"}, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if !out.Success || out.Data.ID.String() != id {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	display := strings.Fields(out.Data.Display)
	if len(display) != 2 || (display[1] != "SAR" && display[1] != "SR") {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	amount, err := restaurantPaymentMinor(out.Data.Amount.String(), "SAR")
	if err != nil {
		return restaurantPaymentRemote{}, err
	}
	displayAmount, err := restaurantPaymentMinor(display[0], "SAR")
	if err != nil || displayAmount != amount {
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}
	status := "pending"
	if out.Data.Status == "Canceled" {
		status = "failed"
	}
	if out.Data.Status == "Paid" {
		status = "review"
		for _, tx := range out.Data.Transactions {
			if tx.Status != "Succss" {
				continue
			}
			n, err := restaurantPaymentMinor(tx.Amount, "SAR")
			if err == nil && (tx.Currency == "SAR" || tx.Currency == "SR") && n == amount {
				status = "paid"
				break
			}
		}
	}
	return g.checkMyFatoorahRefunds(ctx, c, restaurantPaymentRemote{ID: id, Status: status, Currency: "SAR", AmountMinor: amount, Reference: out.Data.Reference})
}
