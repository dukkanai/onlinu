package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
)

// Refund checks only perform authenticated, read-only provider queries. They
// never issue a refund, capture, payment, or other financial mutation.
// Official response/binding references:
// https://docs.myfatoorah.com/docs/getrefundstatus
// https://docs.paytabs.com/manuals/PT-API-Endpoints/Integration-Types-Manuals/Invoices-APIs/Invoices-Step-7-Manage-Transactions/Invoices-Step-7-Query-Transaction/
// https://docs.paytabs.com/manuals/PT-API-Endpoints/Integration-Types-Manuals/Invoices-APIs/Invoices-Step-7-Manage-Transactions/Invoices-Step-7-Refund-Transaction/

// checkMyFatoorahRefunds must be called after the original invoice has been
// verified paid, with its exact amount, currency, ID, and merchant reference.
// The provider supports listing all refund requests using the invoice ID, so
// neither an untrusted webhook refund ID nor browser-supplied status is needed.
func (g *restaurantPaymentGateways) checkMyFatoorahRefunds(ctx context.Context, c restaurantPaymentConfig, paid restaurantPaymentRemote) (restaurantPaymentRemote, error) {
	if paid.Status != "paid" {
		return paid, nil
	}
	if c.ID != "myfatoorah" || !restaurantPaymentNumericID.MatchString(paid.ID) || paid.Currency != "SAR" || paid.AmountMinor <= 0 {
		paid.Status = "review"
		return paid, nil
	}
	var out struct {
		Success bool `json:"IsSuccess"`
		Data    *struct {
			Refunds *[]struct {
				ID           json.Number `json:"RefundId"`
				InvoiceID    json.Number `json:"InvoiceId"`
				Status       string      `json:"RefundStatus"`
				Amount       json.Number `json:"Amount"`
				RefundAmount json.Number `json:"RefundAmount"`
				Currency     string      `json:"BaseCurrency"`
			} `json:"RefundStatusResult"`
		} `json:"Data"`
	}
	if err := g.json(ctx, http.MethodPost, restaurantMyFatoorahBase(c)+"/v2/GetRefundStatus", "Bearer "+c.Secrets["apiToken"], map[string]string{"Key": paid.ID, "KeyType": "InvoiceId"}, &out); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if !out.Success || out.Data == nil || out.Data.Refunds == nil || len(*out.Data.Refunds) > 100 {
		paid.Status = "review"
		return paid, nil
	}
	seen := map[string]bool{}
	var total int64
	uncertain := false
	for _, refund := range *out.Data.Refunds {
		id := refund.ID.String()
		amount, amountErr := restaurantPaymentMinor(refund.Amount.String(), paid.Currency)
		actual, actualErr := restaurantPaymentMinor(refund.RefundAmount.String(), paid.Currency)
		if !restaurantPaymentNumericID.MatchString(id) || seen[id] || refund.InvoiceID.String() != paid.ID || (refund.Currency != paid.Currency && refund.Currency != "SR") || amountErr != nil || actualErr != nil || amount <= 0 || amount > paid.AmountMinor || actual > amount {
			paid.Status = "review"
			return paid, nil
		}
		seen[id] = true
		switch refund.Status {
		case "Refunded":
			if actual <= 0 || actual != amount || actual > paid.AmountMinor-total {
				paid.Status = "review"
				return paid, nil
			}
			total += actual
		case "Canceled":
			// A canceled request is not money returned. The response's
			// RefundAmount can still contain its requested amount.
		case "Pending":
			uncertain = true
		default:
			uncertain = true
		}
	}
	if uncertain || total > 0 && total < paid.AmountMinor {
		paid.Status = "review"
	} else if total == paid.AmountMinor {
		paid.Status = "refunded"
	}
	paid.RefundStateKnown = !uncertain
	paid.RefundedMinor = total
	return paid, nil
}

type restaurantPayTabsRefundQuery struct {
	ID          string      `json:"tran_ref"`
	Previous    string      `json:"previous_tran_ref"`
	Type        string      `json:"tran_type"`
	Reference   string      `json:"cart_id"`
	Description string      `json:"cart_description"`
	Currency    string      `json:"cart_currency"`
	Amount      json.Number `json:"cart_amount"`
	Result      struct {
		Status string `json:"response_status"`
	} `json:"payment_result"`
}

// checkPayTabsRefunds detects linked refunds sharing the original cart ID.
// PayTabs permits merchants to supply a DIFFERENT cart ID for a refund, which
// this query cannot discover. Complete reconciliation of such manually created
// refunds additionally needs their provider-verified IPN transaction identifiers;
// do not claim this helper provides that unsupported discovery capability.
// Missing linkage/unknown statuses are held for review, never assumed paid.
func (g *restaurantPaymentGateways) checkPayTabsRefunds(ctx context.Context, c restaurantPaymentConfig, paid restaurantPaymentRemote) (restaurantPaymentRemote, error) {
	if paid.Status != "paid" {
		return paid, nil
	}
	if c.ID != "paytabs" || !restaurantPaymentID.MatchString(paid.ID) || !restaurantPaymentID.MatchString(paid.Reference) || paid.Currency != "SAR" || paid.AmountMinor <= 0 || strings.HasPrefix(paid.ID, "TST") != (c.Mode == "test") {
		paid.Status = "review"
		return paid, nil
	}
	var rows []restaurantPayTabsRefundQuery
	query := func(body map[string]any, response any) error {
		return g.json(ctx, http.MethodPost, "https://secure.paytabs.sa/payment/query", c.Secrets["serverKey"], body, response)
	}
	if err := query(map[string]any{"profile_id": json.Number(c.Values["profileId"]), "cart_id": paid.Reference}, &rows); err != nil {
		return restaurantPaymentRemote{}, err
	}
	if len(rows) == 0 || len(rows) > 50 {
		paid.Status = "review"
		return paid, nil
	}
	seen := map[string]bool{}
	foundSale, uncertain := false, false
	var total int64
	lookups := 0
	for _, row := range rows {
		if !restaurantPaymentID.MatchString(row.ID) || seen[row.ID] || row.Reference != paid.Reference || row.Currency != paid.Currency || strings.HasPrefix(row.ID, "TST") != (c.Mode == "test") {
			paid.Status = "review"
			return paid, nil
		}
		seen[row.ID] = true
		amount, err := restaurantPaymentMinor(row.Amount.String(), row.Currency)
		if err != nil || amount <= 0 || amount > paid.AmountMinor {
			paid.Status = "review"
			return paid, nil
		}
		kind := strings.ToLower(row.Type)
		if row.ID == paid.ID {
			if (kind != "sale" && kind != "capture") || row.Result.Status != "A" || amount != paid.AmountMinor {
				paid.Status = "review"
				return paid, nil
			}
			foundSale = true
			continue
		}
		if kind != "refund" {
			// An additional approved charge, void/release, or unknown
			// transaction type cannot establish the outstanding balance.
			uncertain = true
			continue
		}
		if row.Previous == "" {
			// Cart searches can omit details. Query the exact refund ID
			// to verify the original transaction relationship explicitly.
			lookups++
			if lookups > 10 {
				paid.Status = "review"
				return paid, nil
			}
			var full restaurantPayTabsRefundQuery
			if err := query(map[string]any{"profile_id": json.Number(c.Values["profileId"]), "tran_ref": row.ID}, &full); err != nil {
				return restaurantPaymentRemote{}, err
			}
			fullAmount, err := restaurantPaymentMinor(full.Amount.String(), full.Currency)
			if err != nil || full.ID != row.ID || !strings.EqualFold(full.Type, "refund") || full.Reference != paid.Reference || full.Currency != paid.Currency || fullAmount != amount {
				paid.Status = "review"
				return paid, nil
			}
			row = full
		}
		if row.Previous != paid.ID {
			paid.Status = "review"
			return paid, nil
		}
		switch row.Result.Status {
		case "A":
			if amount > paid.AmountMinor-total {
				paid.Status = "review"
				return paid, nil
			}
			total += amount
		case "D", "E", "C":
			// Declined, failed, or canceled refund requests are not paid.
		default:
			uncertain = true
		}
	}
	if !foundSale || uncertain || total > 0 && total < paid.AmountMinor {
		paid.Status = "review"
	} else if total == paid.AmountMinor {
		paid.Status = "refunded"
	}
	paid.RefundStateKnown = foundSale && !uncertain
	paid.RefundedMinor = total
	return paid, nil
}
