package main

import (
	"context"
	"github.com/google/uuid"
	"testing"
)

func TestRestaurantQuoteBindingGolden(t *testing.T) {
	q := restaurantQuote{Currency: "SAR", SubtotalMinor: 100, TotalMinor: 100, Demo: true, PaymentMethods: []string{"cash_on_delivery"},
		Tax: restaurantTaxSummary{NetMinor: 100, GrossMinor: 100}, Items: []restaurantOrderLine{{ItemID: "rice", Name: "<Rice>&\u2028🍚", Quantity: 1, UnitPriceMinor: 100, TotalMinor: 100,
			Options: []restaurantOption{{ID: "extra", Name: "Free\u2029Sauce", Available: true}}}}}
	hash, err := restaurantQuoteBinding(q)
	if err != nil || hash != "896ee9e55665b5ed69b6a17f4f72898438f91eb334e68a6bc22b820d4f32f542" {
		t.Fatal(hash, err)
	}
}

func TestRestaurantQuoteBindingRejectsSameTotalTaxChange(t *testing.T) {
	orders, store, _ := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	input := restaurantOrderFixtureInput("delivery")
	input.ExpectedTotalMinor = 3500
	quote, err := orders.Quote(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedQuoteHash, err = restaurantQuoteBinding(quote)
	if err != nil {
		t.Fatal(err)
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.TaxEnabled = true
	catalog.Settings.TaxRateBps = 1500
	catalog.Settings.TaxNumber = "300000000000003"
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "quote_changed")
	fresh, err := orders.Quote(ctx, input)
	if err != nil || fresh.TotalMinor != quote.TotalMinor {
		t.Fatal(fresh, err)
	}
	input.ExpectedQuoteHash, err = restaurantQuoteBinding(fresh)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orders.Create(ctx, input, "", uuid.NewString()); err != nil {
		t.Fatal(err)
	}
}
