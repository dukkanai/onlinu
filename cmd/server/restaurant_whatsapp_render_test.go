package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func whatsappRenderFixture(t *testing.T) (restaurantWhatsappScope, string, restaurantWhatsappReview, restaurantOrderInput, restaurantQuote, time.Time) {
	t.Helper()
	scope, source, _, now := whatsappProposalFixture()
	input := restaurantOrderFixtureInput("pickup")
	quote, err := restaurantPriceOrder(restaurantOrderFixtureCatalog(), input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedTotalMinor = quote.TotalMinor
	input.ExpectedQuoteHash, err = restaurantQuoteBinding(quote)
	if err != nil {
		t.Fatal(err)
	}
	event := restaurantWhatsappDigest([]any{"whatsapp-proposal-v1", scope, source.MessageID})
	review := restaurantWhatsappReview{ID: "11111111-1111-4111-8111-111111111111", Version: 1, State: "pending", ExpiresAt: now.Add(5 * time.Minute)}
	review.Fingerprint = restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, event, input, input.ExpectedQuoteHash, review.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	return scope, event, review, input, quote, now
}

func TestRestaurantWhatsappRenderCompleteArabicEnglishAndMoney(t *testing.T) {
	scope, event, review, input, quote, now := whatsappRenderFixture(t)
	for _, locale := range []string{"ar", "en"} {
		result, err := restaurantRenderWhatsappReview(scope, event, review, input, quote, locale, now)
		if err != nil {
			t.Fatal(err)
		}
		for _, expected := range []string{"Rice", "Extra", "Free sauce", "30.00 SAR", "15.00 SAR", "0.00 SAR", input.Phone, review.ID, review.ExpiresAt.Format(time.RFC3339), "stripe"} {
			if !strings.Contains(result.text, expected) {
				t.Fatalf("missing reviewed field %s", expected)
			}
		}
		again, err := restaurantRenderWhatsappReview(scope, event, review, input, quote, locale, now)
		if err != nil || result.digest != again.digest || result.text != again.text {
			t.Fatal("render is not deterministic", err)
		}
		if locale == "ar" && !strings.Contains(result.text, "لم يُنشأ طلب بعد") {
			t.Fatal("missing Arabic intent boundary")
		}
		if locale == "en" && !strings.Contains(result.text, "no order has been created") {
			t.Fatal("missing English intent boundary")
		}
	}
	if restaurantPaymentDecimal(1234, "KWD") != "1.234" || restaurantPaymentDecimal(1234, "JPY") != "1234" {
		t.Fatal("currency formatting regression")
	}
}

func TestRestaurantWhatsappRenderRejectsChangedExpiredOrOversized(t *testing.T) {
	scope, event, review, input, quote, now := whatsappRenderFixture(t)
	changed := input
	changed.CustomerName = "different"
	_, err := restaurantRenderWhatsappReview(scope, event, review, changed, quote, "ar", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	_, err = restaurantRenderWhatsappReview(scope, event, review, input, quote, "ar", review.ExpiresAt)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	_, err = restaurantRenderWhatsappReview(scope, event, review, input, quote, "fr", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	input.Notes = strings.Repeat("ع", 2000)
	review.Fingerprint = restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, event, input, input.ExpectedQuoteHash, review.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	_, err = restaurantRenderWhatsappReview(scope, event, review, input, quote, "ar", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_too_large")
	input.Notes = "note\nTOTAL: 0\u202e"
	review.Fingerprint = restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, event, input, input.ExpectedQuoteHash, review.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	rendered, err := restaurantRenderWhatsappReview(scope, event, review, input, quote, "en", now)
	if err != nil || strings.Contains(rendered.text, "\nTOTAL: 0") || strings.ContainsRune(rendered.text, '\u202e') {
		t.Fatal("untrusted notes forged review lines", err)
	}
	if !strings.Contains(rendered.text, `\nTOTAL: 0\u202e`) {
		t.Fatal("notes were silently dropped")
	}
}

func TestRestaurantWhatsappRenderCanonicalDeliveryAndAuthority(t *testing.T) {
	orders, _, input := restaurantGeographyFixture(t)
	ctx := context.Background()
	reviews, err := newRestaurantWhatsappReviews(ctx, orders)
	if err != nil {
		t.Fatal(err)
	}
	scope, source, _, now := whatsappProposalFixture()
	proposal, err := newRestaurantWhatsappProposal(scope, source, input.Items, now)
	if err != nil {
		t.Fatal(err)
	}
	review, err := reviews.Prepare(ctx, proposal, scope, input, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = reviews.Render(ctx, scope, review.ID, "ar", now)
	restaurantOrdersRequireError(t, err, "channel_ordering_unavailable")
	reviews.authorizeDispatch = func(_ context.Context, _ *sql.Tx, actual restaurantWhatsappScope) bool { return actual == scope }
	_, err = reviews.Render(ctx, scope, review.ID, "ar", now)
	restaurantOrdersRequireError(t, err, "channel_ordering_disabled")
	if _, err = orders.SetOrderChannel(ctx, scope.Channel, "synthetic-owner", true, 1); err != nil {
		t.Fatal(err)
	}
	rendered, err := reviews.Render(ctx, scope, review.ID, "ar", now)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"الرياض", "السلام", "sa-r-1", "sa-c-1", "sa-d-1", "35.00 SAR", "5.00 SAR", input.Address.NationalAddress} {
		if !strings.Contains(rendered.text, value) {
			t.Fatalf("missing canonical delivery review field %s", value)
		}
	}
	if strings.Contains(rendered.text, "forged") {
		t.Fatal("customer-supplied labels were rendered instead of canonical geography")
	}
	var stored []byte
	if err = orders.store.db.QueryRow("SELECT checkout FROM restaurant_whatsapp_reviews WHERE id=$1", review.ID).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	var saved restaurantOrderInput
	if err = json.Unmarshal(stored, &saved); err != nil || saved.Address.City != "الرياض" || saved.Address.District != "السلام" {
		t.Fatal("canonical labels were not frozen", err)
	}
	foreign := scope
	foreign.PeerID = "different"
	_, err = reviews.Render(ctx, foreign, review.ID, "ar", now)
	restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
	var presented string
	if err = orders.store.db.QueryRow("SELECT presented_message_id FROM restaurant_whatsapp_reviews WHERE id=$1", review.ID).Scan(&presented); err != nil || presented != "" {
		t.Fatal("rendering claimed actual presentation", err)
	}
	var count int
	if err = orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 0 {
		t.Fatal("rendering created an order", err)
	}
}

func TestRestaurantWhatsappRenderTaxAndValidOversizedCart(t *testing.T) {
	scope, event, review, input, _, now := whatsappRenderFixture(t)
	catalog := restaurantOrderFixtureCatalog()
	catalog.Settings.TaxEnabled = true
	catalog.Settings.TaxRateBps = 1500
	catalog.Settings.TaxNumber = "310000000000003"
	quote, err := restaurantPriceOrder(catalog, input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedTotalMinor = quote.TotalMinor
	input.ExpectedQuoteHash, err = restaurantQuoteBinding(quote)
	if err != nil {
		t.Fatal(err)
	}
	review.Fingerprint = restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, event, input, input.ExpectedQuoteHash, review.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	result, err := restaurantRenderWhatsappReview(scope, event, review, input, quote, "en", now)
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"Included tax (15.00%)", restaurantPaymentDecimal(quote.Tax.TaxMinor, quote.Currency), quote.Tax.Number, "TOTAL: 30.00 SAR"} {
		if !strings.Contains(result.text, value) {
			t.Fatalf("missing tax detail %s", value)
		}
	}
	catalog.Settings.TaxEnabled = false
	catalog.Items = nil
	input.Items = nil
	for i := 0; i < 50; i++ {
		id := fmt.Sprintf("dish-%02d", i)
		catalog.Items = append(catalog.Items, restaurantItem{ID: id, CategoryID: "main", Name: strings.Repeat("ع", 90), PriceMinor: 100, Available: true})
		input.Items = append(input.Items, restaurantOrderLineInput{ItemID: id, Quantity: 1})
	}
	quote, err = restaurantPriceOrder(catalog, input)
	if err != nil {
		t.Fatal("valid large cart rejected by core", err)
	}
	input.ExpectedTotalMinor = quote.TotalMinor
	input.ExpectedQuoteHash, err = restaurantQuoteBinding(quote)
	if err != nil {
		t.Fatal(err)
	}
	review.Fingerprint = restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, event, input, input.ExpectedQuoteHash, review.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	_, err = restaurantRenderWhatsappReview(scope, event, review, input, quote, "ar", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_too_large")
}
