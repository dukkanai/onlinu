package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"math"
	"reflect"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestRestaurantOrderInclusiveTaxArithmetic(t *testing.T) {
	settings := restaurantOrderFixtureCatalog().Settings
	settings.TaxEnabled, settings.TaxRateBps, settings.TaxNumber = true, 1500, "TEST-TAX-NUMBER"
	for _, tc := range []struct{ gross, rate, tax int64 }{
		{11500, 1500, 1500}, {3500, 1500, 457}, {100, 1500, 13}, {1, 1500, 0},
		{0, 1500, 0}, {1, 10000, 1}, {3, 10000, 2}, {900000000000, 10000, 450000000000}, {100, 0, 0},
	} {
		settings.TaxRateBps = tc.rate
		got, err := restaurantTaxForGross(settings, tc.gross)
		if err != nil || got.GrossMinor != tc.gross || got.TaxMinor != tc.tax || got.NetMinor+got.TaxMinor != tc.gross || !got.Enabled || got.Number != settings.TaxNumber {
			t.Fatalf("inclusive tax gross=%d rate=%d: %+v %v", tc.gross, tc.rate, got, err)
		}
	}
	settings.TaxRateBps = 1500
	catalog := restaurantOrderFixtureCatalog()
	catalog.Settings = settings
	quote, err := restaurantPriceOrder(catalog, restaurantOrderFixtureInput("delivery"))
	if err != nil || quote.TotalMinor != 3500 || quote.SubtotalMinor != 3000 || quote.DeliveryFeeMinor != 500 || quote.Tax.TaxMinor != 457 || quote.Tax.NetMinor != 3043 {
		t.Fatalf("tax must include options and fee without adding to gross prices: %+v %v", quote, err)
	}
	settings.TaxEnabled = false
	disabled, err := restaurantTaxForGross(settings, 3500)
	if err != nil || disabled.Enabled || disabled.Number != "" || disabled.RateBps != 0 || disabled.TaxMinor != 0 || disabled.NetMinor != 3500 || disabled.GrossMinor != 3500 {
		t.Fatalf("disabled tax must not invent registration: %+v %v", disabled, err)
	}
	settings.TaxEnabled = true
	for _, rate := range []int64{-1, 10001} {
		settings.TaxRateBps = rate
		_, err = restaurantTaxForGross(settings, 100)
		restaurantOrdersRequireError(t, err, "invalid_request")
	}
	settings.TaxRateBps = 10000
	_, err = restaurantTaxForGross(settings, math.MaxInt64)
	restaurantOrdersRequireError(t, err, "invalid_request")
	settings.TaxNumber = ""
	_, err = restaurantTaxForGross(settings, 100)
	restaurantOrdersRequireError(t, err, "invalid_request")
}

func TestRestaurantOrderPaymentPolicyAndReadiness(t *testing.T) {
	settings := restaurantOrderFixtureCatalog().Settings
	for _, tc := range []struct {
		mode string
		want []string
	}{
		{"table", []string{"cash_before", "cash_after", "card"}},
		{"delivery", []string{"cash_on_delivery", "card"}},
		{"pickup", []string{"card"}},
	} {
		if got := restaurantPaymentMethodsForMode(settings, tc.mode); !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("%s policy: %v", tc.mode, got)
		}
	}
	// Even a malformed in-memory catalog cannot make cash valid for pickup.
	settings.PaymentMethods["pickup"] = []string{"cash_after", "cash_on_delivery"}
	if len(restaurantPaymentMethodsForMode(settings, "pickup")) != 0 {
		t.Fatal("pickup cash policy bypass")
	}
	orders := &restaurantOrders{}
	quote := restaurantQuote{Currency: "SAR", PaymentMethods: []string{"cash_after", "card"}}
	got, err := orders.availableQuote(context.Background(), quote, restaurantOrderInput{Mode: "table", PaymentMethod: "cash_after"})
	if err != nil || !reflect.DeepEqual(got.PaymentMethods, []string{"cash_after"}) {
		t.Fatal("missing capability must remove card without removing cash")
	}
	_, err = orders.availableQuote(context.Background(), quote, restaurantOrderInput{Mode: "table", PaymentMethod: "card", PaymentProvider: "stripe"})
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	orders.PaymentAvailable = func(_ context.Context, provider, currency string) (bool, error) {
		return (provider == "" || provider == "stripe") && currency == "SAR", nil
	}
	got, err = orders.availableQuote(context.Background(), quote, restaurantOrderInput{Mode: "table"})
	if err != nil || len(got.PaymentMethods) != 2 {
		t.Fatal("available card was omitted")
	}
	_, err = orders.availableQuote(context.Background(), quote, restaurantOrderInput{Mode: "table", PaymentMethod: "card", PaymentProvider: "not-configured"})
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	orders.PaymentAvailable = func(context.Context, string, string) (bool, error) {
		return false, errors.New("test storage unavailable")
	}
	if _, err = orders.availableQuote(context.Background(), quote, restaurantOrderInput{Mode: "table", PaymentMethod: "card"}); err == nil {
		t.Fatal("capability failure did not fail closed")
	}
}

func TestRestaurantOrderPaymentTransitionGates(t *testing.T) {
	for _, tc := range []struct {
		mode, method string
		before       bool
	}{
		{"table", "cash_before", true}, {"table", "cash_after", false}, {"delivery", "cash_on_delivery", false},
		{"table", "card", true}, {"delivery", "card", true}, {"pickup", "card", true},
	} {
		t.Run(tc.mode+"/"+tc.method, func(t *testing.T) {
			order := restaurantOrder{Mode: tc.mode, TotalMinor: 100, Payment: restaurantOrderPayment{Method: tc.method, Status: "unpaid", AmountMinor: 100}}
			if err := restaurantRequirePaymentForStatus(order, "accepted"); err != nil {
				t.Fatal(err)
			}
			if err := restaurantRequirePaymentForStatus(order, "cancelled"); err != nil {
				t.Fatal(err)
			}
			for _, status := range []string{"preparing", "ready", "out_for_delivery"} {
				err := restaurantRequirePaymentForStatus(order, status)
				if tc.before {
					restaurantOrdersRequireError(t, err, "payment_required")
				} else if err != nil {
					t.Fatal(err)
				}
			}
			restaurantOrdersRequireError(t, restaurantRequirePaymentForStatus(order, "completed"), "payment_required")
			order.Payment.Status = "paid"
			if err := restaurantRequirePaymentForStatus(order, "completed"); err != nil {
				t.Fatal(err)
			}
			order.Payment.AmountMinor = 1
			restaurantOrdersRequireError(t, restaurantRequirePaymentForStatus(order, "completed"), "payment_required")
		})
	}
	legacy := restaurantOrder{Mode: "pickup", TotalMinor: 100}
	if err := restaurantRequirePaymentForStatus(legacy, "completed"); err != nil || legacy.Payment.Status != "" {
		t.Fatal("legacy workflow changed or fabricated paid status")
	}
	for _, status := range []string{"pending", "failed", "refunded", "review", ""} {
		order := restaurantOrder{Mode: "pickup", TotalMinor: 100, Payment: restaurantOrderPayment{Method: "card", Status: status, AmountMinor: 100}}
		restaurantOrdersRequireError(t, restaurantRequirePaymentForStatus(order, "preparing"), "payment_required")
	}
}

func TestRestaurantOrderGeideaPhonePreflight(t *testing.T) {
	orders := &restaurantOrders{PaymentAvailable: func(context.Context, string, string) (bool, error) { return true, nil }}
	quote := restaurantQuote{Currency: "SAR", TotalMinor: 100, PaymentMethods: []string{"card"}}
	for _, tc := range []struct{ mode, phone string }{{"table", ""}, {"pickup", "1234567"}, {"delivery", "+999123456789"}} {
		input := restaurantOrderInput{Mode: tc.mode, Phone: tc.phone, PaymentMethod: "card", PaymentProvider: "geidea"}
		_, err := orders.availableQuote(context.Background(), quote, input)
		restaurantOrdersRequireError(t, err, "phone_required")
	}
	for _, phone := range []string{"+966501234567", "0501234567", "+966 50 123 4567", "+966-(50)-123-4567"} {
		input := restaurantOrderInput{Mode: "table", Phone: phone, PaymentMethod: "card", PaymentProvider: "geidea"}
		if _, err := orders.availableQuote(context.Background(), quote, input); err != nil {
			t.Fatalf("checkout/provider phone validation diverged for %q: %v", phone, err)
		}
	}
	// Other table providers retain their own contact requirements; do not
	// accidentally make all table orders require Geidea's phone format.
	if _, err := orders.availableQuote(context.Background(), quote, restaurantOrderInput{Mode: "table", PaymentMethod: "card", PaymentProvider: "stripe"}); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantOrdersIntegrationGeideaRejectsUnpayableOrder(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	orders.PaymentAvailable = func(context.Context, string, string) (bool, error) { return true, nil }
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("table")
	input.TableCode, input.PaymentMethod, input.PaymentProvider = catalog.Tables[0].Code, "card", "geidea"
	for _, phone := range []string{"", "1234567"} {
		input.Phone = phone
		_, err = orders.Quote(ctx, input)
		restaurantOrdersRequireError(t, err, "phone_required")
		_, err = orders.Create(ctx, input, "", uuid.NewString())
		restaurantOrdersRequireError(t, err, "phone_required")
	}
	var count int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 0 {
		t.Fatal("provider-invalid contact created an immutable unpaid order")
	}
	input.Phone = "+966 50 123 4567"
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil || receipt.Order.Payment.Provider != "geidea" || receipt.Order.Payment.Status != "unpaid" {
		t.Fatalf("valid provider-compatible contact rejected: %v", err)
	}
}

func TestRestaurantOrderCashCollectionAuthorization(t *testing.T) {
	base := restaurantOrder{Mode: "delivery", Status: "out_for_delivery", CourierID: "courier-one", TotalMinor: 100, Payment: restaurantOrderPayment{Method: "cash_on_delivery", Status: "unpaid", AmountMinor: 100}}
	for _, actor := range []string{"", "customer", "courier:", "courier:other"} {
		order := base
		restaurantOrdersRequireError(t, restaurantMarkCashCollected(&order, actor), "forbidden")
		if order.Payment.Status != "unpaid" {
			t.Fatal("unauthorized mutation")
		}
	}
	for _, actor := range []string{"admin", "courier:courier-one"} {
		order := base
		if err := restaurantMarkCashCollected(&order, actor); err != nil || order.Payment.Status != "paid" || order.Payment.PaidAt == nil || order.Payment.AmountMinor != 100 {
			t.Fatalf("collection: %+v %v", order, err)
		}
		paidAt := *order.Payment.PaidAt
		if err := restaurantMarkCashCollected(&order, actor); err != nil || !order.Payment.PaidAt.Equal(paidAt) {
			t.Fatal("duplicate collection changed payment")
		}
	}
	for _, tc := range []struct {
		name string
		edit func(*restaurantOrder)
	}{
		{"card", func(o *restaurantOrder) { o.Payment.Method = "card"; o.Payment.Provider = "stripe" }},
		{"terminal", func(o *restaurantOrder) { o.Status = "cancelled" }},
		{"completed", func(o *restaurantOrder) { o.Status = "completed" }},
		{"review", func(o *restaurantOrder) { o.Payment.Status = "review" }},
		{"wrong amount", func(o *restaurantOrder) { o.Payment.AmountMinor = 1 }},
		{"legacy", func(o *restaurantOrder) { o.Payment = restaurantOrderPayment{} }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			order := base
			tc.edit(&order)
			restaurantOrdersRequireError(t, restaurantMarkCashCollected(&order, "admin"), "payment_unavailable")
		})
	}
	order := base
	order.Mode = "table"
	order.Payment.Method = "cash_after"
	restaurantOrdersRequireError(t, restaurantMarkCashCollected(&order, "courier:courier-one"), "forbidden")
}

func TestRestaurantOrderCountryNormalization(t *testing.T) {
	input := restaurantOrderFixtureInput("delivery")
	input.Address.Country = " gb "
	input.Address.AdditionalNumber = "1234"
	input.Address.AddressLine = "14 Example Street"
	normalized := restaurantNormalizeOrderInput(input)
	if normalized.Address.Country != "GB" || normalized.Address.NationalAddress != "" || normalized.Address.AdditionalNumber != "" {
		t.Fatal("foreign address retained Saudi fields")
	}
	restaurantOrdersRequireError(t, restaurantValidateDelivery(restaurantOrderFixtureCatalog().Settings, normalized.Address), "country_required")
	for _, country := range []string{"", "ZZ", "SA<script>", "Saudi Arabia", "TR", "AE", "US"} {
		input.Address.Country = country
		restaurantOrdersRequireError(t, restaurantValidateDelivery(restaurantOrderFixtureCatalog().Settings, restaurantNormalizeOrderInput(input).Address), "country_required")
	}
	input.Address.Country = " sa "
	input.Address.AddressLine = ""
	normalized = restaurantNormalizeOrderInput(input)
	if normalized.Address.Country != "SA" || normalized.Address.NationalAddress != "ABCD1234" || normalized.Address.AdditionalNumber != "1234" {
		t.Fatal("Saudi delivery address did not normalize correctly")
	}
	if err := restaurantValidateDelivery(restaurantOrderFixtureCatalog().Settings, normalized.Address); err != nil {
		t.Fatal(err)
	}
	legacy := restaurantOrder{Mode: "delivery", TotalMinor: 100, Address: restaurantAddress{NationalAddress: "ABCD1234"}}
	restaurantNormalizeLegacyOrder(&legacy)
	if legacy.Address.Country != "SA" || legacy.Payment.Method != "" || legacy.Payment.Status != "" || legacy.Tax.Enabled || legacy.Tax.GrossMinor != 100 {
		t.Fatal("legacy address normalization invented payment/tax")
	}
	foreign := restaurantAddress{Country: "GB", AddressLine: "a historical address", NationalAddress: "ABCD1234", AdditionalNumber: "1234"}
	legacy.Address = foreign
	restaurantNormalizeLegacyOrder(&legacy)
	if !reflect.DeepEqual(legacy.Address, foreign) {
		t.Fatal("read compatibility relabeled a historical foreign order address")
	}
}

func TestRestaurantOrdersIntegrationSaudiOnlyPreservesHistoricalRetry(t *testing.T) {
	orders, _, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	input := restaurantOrderFixtureInput("delivery")
	input.ExpectedTotalMinor = 3500
	input.Address.Country = "GB"
	input.Address.AddressLine = "a historical delivery address"
	_, err := orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "country_required")
	var count int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 0 {
		t.Fatal("a rejected foreign delivery request persisted")
	}
	input.Address.Country = " sa "
	key := uuid.NewString()
	receipt, err := orders.Create(ctx, input, "", key)
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Order.Address.Country != "SA" {
		t.Fatal("new Saudi delivery country was not normalized")
	}
	// Reconstruct a previously committed foreign request, as accepted before the
	// Saudi-only policy. Receipt recovery must precede the new write validation.
	input.Address.Country = "GB"
	input = restaurantNormalizeOrderInput(input)
	request, err := json.Marshal(input)
	if err != nil {
		t.Fatal(err)
	}
	requestHash := sha256.Sum256(request)
	address, err := json.Marshal(input.Address)
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.ExecContext(ctx, `UPDATE restaurant_orders SET document=jsonb_set(document,'{address}',$2::jsonb),request_hash=$3 WHERE number=$1`, receipt.Order.Number, address, requestHash[:])
	if err != nil {
		t.Fatal(err)
	}
	var before, after []byte
	if err = db.QueryRowContext(ctx, `SELECT document FROM restaurant_orders WHERE number=$1`, receipt.Order.Number).Scan(&before); err != nil {
		t.Fatal(err)
	}
	repeated, err := orders.Create(ctx, input, "", key)
	if err != nil {
		t.Fatal(err)
	}
	if repeated.Order.Number != receipt.Order.Number || repeated.TrackingToken != receipt.TrackingToken || repeated.AccessCode != receipt.AccessCode || !reflect.DeepEqual(repeated.Order.Address, input.Address) {
		t.Fatal("historical foreign retry changed the receipt or address")
	}
	tracked, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || !reflect.DeepEqual(tracked.Address, input.Address) {
		t.Fatal("tracking a historical foreign order changed its address")
	}
	if err = db.QueryRowContext(ctx, `SELECT document FROM restaurant_orders WHERE number=$1`, receipt.Order.Number).Scan(&after); err != nil || string(before) != string(after) {
		t.Fatal("historical foreign receipt recovery mutated the stored order")
	}
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "country_required")
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 1 {
		t.Fatal("retry or rejected foreign request created another order")
	}
}

func TestRestaurantOrdersIntegrationPaymentPolicyAndTaxSnapshot(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	input := restaurantOrderFixtureInput("pickup")
	orders.PaymentAvailable = nil
	_, err := orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	input.PaymentMethod, input.PaymentProvider = "cash_after", ""
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	input.PaymentMethod = ""
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "payment_required")
	input.PaymentMethod = "card"
	orders.PaymentAvailable = func(context.Context, string, string) (bool, error) { return true, nil }
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	var count int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 0 {
		t.Fatal("rejected payment requests persisted")
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.TaxEnabled, catalog.Settings.TaxRateBps, catalog.Settings.TaxNumber = true, 1500, "TEST-TAX-NUMBER"
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	input = restaurantOrderFixtureInput("delivery")
	input.ExpectedTotalMinor = 3500
	input.Address.Country = "sa"
	input.Address.AddressLine = "14 Example Street"
	input.Address.AdditionalNumber = "1111"
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	if receipt.Order.Address.Country != "SA" || receipt.Order.Address.NationalAddress != "ABCD1234" || receipt.Order.Address.AdditionalNumber != "1111" || receipt.Order.Payment.Method != "cash_on_delivery" || receipt.Order.Payment.Status != "unpaid" || receipt.Order.Payment.AmountMinor != 3500 || receipt.Order.Tax.TaxMinor != 457 || receipt.Order.TotalMinor != 3500 {
		t.Fatalf("new immutable snapshot: %+v", receipt.Order)
	}
	catalog, err = store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.TaxEnabled = false
	catalog.Settings.TaxNumber = ""
	catalog.Settings.DeliveryFeeMinor = 9999
	catalog.Settings.PaymentMethods["delivery"] = []string{"card"}
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	got, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got.Tax, receipt.Order.Tax) || got.Payment != receipt.Order.Payment || got.TotalMinor != 3500 || got.DeliveryFeeMinor != 500 {
		t.Fatal("catalog changes rewrote tax/payment snapshot")
	}
	collected, err := orders.CollectCash(ctx, got.Number, got.Version)
	if err != nil {
		t.Fatal(err)
	}
	if collected.Payment.Status != "paid" || collected.Version != got.Version+1 || collected.Payment.PaidAt == nil || !reflect.DeepEqual(collected.Tax, got.Tax) {
		t.Fatal("cash collection mutated immutable snapshot")
	}
	if _, err = orders.CollectCash(ctx, got.Number, got.Version); err == nil {
		t.Fatal("stale collection bypassed optimistic version")
	}
	_, err = orders.CollectCash(ctx, got.Number, collected.Version)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_order_events WHERE order_number=$1 AND kind='cash_collected'`, got.Number).Scan(&count); err != nil || count != 1 {
		t.Fatal("cash retry duplicated audit")
	}
}

func TestRestaurantOrdersIntegrationPaymentGateCashAndCancellation(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("table")
	input.TableCode = catalog.Tables[0].Code
	input.PaymentMethod = "cash_before"
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	accepted, err := orders.SetStatus(ctx, receipt.Order.Number, "accepted", 1)
	if err != nil {
		t.Fatal(err)
	}
	_, err = orders.SetStatus(ctx, receipt.Order.Number, "preparing", accepted.Version)
	restaurantOrdersRequireError(t, err, "payment_required")
	collected, err := orders.CollectCash(ctx, receipt.Order.Number, accepted.Version)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orders.SetStatus(ctx, receipt.Order.Number, "preparing", collected.Version); err != nil {
		t.Fatal(err)
	}
	card, err := orders.Create(ctx, restaurantOrderFixtureInput("pickup"), "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	_, err = orders.CollectCash(ctx, card.Order.Number, card.Order.Version)
	restaurantOrdersRequireError(t, err, "payment_unavailable")
	// Simulate a trusted provider settlement in this disposable database only.
	paid := card.Order
	paid.Payment.Status = "paid"
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err = restaurantUpdateOrder(ctx, tx, paid); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	cancelled, err := orders.SetStatus(ctx, paid.Number, "cancelled", paid.Version)
	if err != nil {
		t.Fatal(err)
	}
	if cancelled.Status != "cancelled" || cancelled.Payment.Status != "review" || cancelled.Payment.AmountMinor != paid.TotalMinor {
		t.Fatal("cancelled paid card did not require reconciliation")
	}
}

func TestRestaurantOrdersIntegrationConcurrentCashCollection(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("table")
	input.TableCode = catalog.Tables[0].Code
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	results := make(chan error, 2)
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := orders.CollectCash(ctx, receipt.Order.Number, receipt.Order.Version)
			results <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	success := 0
	for err := range results {
		if err == nil {
			success++
		} else {
			restaurantOrdersRequireError(t, err, "conflict")
		}
	}
	if success != 1 {
		t.Fatalf("collection winners=%d", success)
	}
	var count int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_order_events WHERE order_number=$1 AND kind='cash_collected'`, receipt.Order.Number).Scan(&count); err != nil || count != 1 {
		t.Fatal("multiple collection events")
	}
}

func TestRestaurantOrdersIntegrationLegacyIdempotencyAcrossUpgrade(t *testing.T) {
	orders, _, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	input := restaurantOrderFixtureInput("pickup")
	key := uuid.NewString()
	receipt, err := orders.Create(ctx, input, "", key)
	if err != nil {
		t.Fatal(err)
	}
	// Reproduce a pre-upgrade stored order and its exact original request hash.
	legacyInput := input
	legacyInput.PaymentMethod, legacyInput.PaymentProvider, legacyInput.Address.Country = "", "", ""
	legacyHash, err := restaurantLegacyOrderInputHash(legacyInput)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(receipt.Order)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err = json.Unmarshal(raw, &document); err != nil {
		t.Fatal(err)
	}
	delete(document, "payment")
	delete(document, "tax")
	delete(document, "deliveryEvents")
	raw, err = json.Marshal(document)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `UPDATE restaurant_orders SET document=$2,request_hash=$3 WHERE number=$1`, receipt.Order.Number, raw, legacyHash[:]); err != nil {
		t.Fatal(err)
	}
	orders.PaymentAvailable = nil
	again, err := orders.Create(ctx, legacyInput, "", key)
	if err != nil {
		t.Fatal(err)
	}
	if again.Order.Number != receipt.Order.Number || again.TrackingToken != receipt.TrackingToken || again.AccessCode != receipt.AccessCode || again.Order.Payment.Status != "" {
		t.Fatal("legacy retry lost original receipt or fabricated payment")
	}
	legacyInput.Notes = "changed"
	_, err = orders.Create(ctx, legacyInput, "", key)
	restaurantOrdersRequireError(t, err, "conflict")
	legacyInput.Notes = ""
	_, err = orders.Create(ctx, legacyInput, "another-account", key)
	restaurantOrdersRequireError(t, err, "conflict")
	_, err = orders.Create(ctx, legacyInput, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "payment_required")
}
