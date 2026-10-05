package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"regexp"
)

var restaurantQuoteHashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Versioned positional encoding, shared with the control plane. Only reviewed
// quote values are included; contact/address and receipt capabilities are not.
func restaurantQuoteBinding(quote restaurantQuote) (string, error) {
	items := make([]any, 0, len(quote.Items))
	for _, item := range quote.Items {
		options := make([]any, 0, len(item.Options))
		for _, option := range item.Options {
			options = append(options, []any{option.ID, option.Name, option.PriceMinor, option.Available})
		}
		items = append(items, []any{item.ItemID, item.Name, item.Quantity, item.UnitPriceMinor, item.TotalMinor, options})
	}
	tax := quote.Tax
	data, err := json.Marshal([]any{"onlinu-quote-v1", quote.Currency, quote.SubtotalMinor, quote.DeliveryFeeMinor, quote.TotalMinor,
		quote.Demo, quote.TableName, append([]string{}, quote.PaymentMethods...),
		[]any{tax.Enabled, tax.RateBps, tax.Number, tax.NetMinor, tax.TaxMinor, tax.GrossMinor}, items})
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return hex.EncodeToString(digest[:]), nil
}
