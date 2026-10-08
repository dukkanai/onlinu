package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strconv"
	"strings"
	"time"
)

type restaurantWhatsappRenderedReview struct {
	review restaurantWhatsappReview
	text   string
	digest string
	locale string
}

// Produces an entire bounded review or fails; never silently truncates money,
// destination, options or payment choice. No provider call or delivery receipt.
func restaurantRenderWhatsappReview(scope restaurantWhatsappScope, proposalEvent string, review restaurantWhatsappReview, input restaurantOrderInput, quote restaurantQuote, locale string, now time.Time) (restaurantWhatsappRenderedReview, error) {
	empty := restaurantWhatsappRenderedReview{}
	if (locale != "ar" && locale != "en") || now.IsZero() || review.State != "pending" || !now.Before(review.ExpiresAt) {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	quoteHash, err := restaurantQuoteBinding(quote)
	if err != nil {
		return empty, err
	}
	fingerprint := restaurantWhatsappDigest([]any{"whatsapp-review-v1", scope, review.ID, review.Version, proposalEvent, input, input.ExpectedQuoteHash, review.ExpiresAt.UTC().Format(time.RFC3339Nano)})
	if fingerprint != review.Fingerprint || quoteHash != input.ExpectedQuoteHash || input.ExpectedTotalMinor != quote.TotalMinor {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	label := func(en, ar string) string {
		if locale == "ar" {
			return ar
		}
		return en
	}
	money := func(amount int64) string {
		return restaurantPaymentDecimal(amount, quote.Currency) + " " + quote.Currency
	}
	// Quoting escapes line breaks, controls and bidi formatting in untrusted data
	// instead of letting names/notes impersonate the authoritative total lines.
	value := strconv.Quote
	lines := []string{label("Order review - no order has been created.", "مراجعة الطلب - لم يُنشأ طلب بعد.")}
	if quote.Demo {
		lines = append(lines, label("DEMO - test order", "وضع تجريبي - طلب اختبار"))
	}
	for i, item := range quote.Items {
		lines = append(lines, fmt.Sprintf("%d. %s × %d | %s: %s | %s: %s", i+1, value(item.Name), item.Quantity, label("Unit", "سعر الوحدة"), money(item.UnitPriceMinor), label("Line total", "إجمالي الصنف"), money(item.TotalMinor)))
		for _, option := range item.Options {
			lines = append(lines, "  "+label("Option", "خيار")+": "+value(option.Name)+" ("+money(option.PriceMinor)+")")
		}
	}
	lines = append(lines, label("Subtotal", "المجموع")+": "+money(quote.SubtotalMinor), label("Delivery fee", "رسوم التوصيل")+": "+money(quote.DeliveryFeeMinor))
	if quote.Tax.Enabled {
		lines = append(lines, label("Net before included tax", "الصافي قبل الضريبة المضمنة")+": "+money(quote.Tax.NetMinor), label("Included tax", "الضريبة المضمنة")+fmt.Sprintf(" (%d.%02d%%): %s", quote.Tax.RateBps/100, quote.Tax.RateBps%100, money(quote.Tax.TaxMinor)))
		if quote.Tax.Number != "" {
			lines = append(lines, label("Tax number", "الرقم الضريبي")+": "+value(quote.Tax.Number))
		}
	}
	lines = append(lines, label("TOTAL", "الإجمالي النهائي")+": "+money(quote.TotalMinor))
	mode := label("Pickup", "استلام")
	if input.Mode == "delivery" {
		mode = label("Delivery", "توصيل")
	} else if input.Mode != "pickup" {
		return empty, restaurantFail(400, "invalid_whatsapp_mode")
	}
	lines = append(lines, label("Service", "الخدمة")+": "+mode, label("Customer", "الاسم")+": "+value(input.CustomerName), label("Phone", "الهاتف")+": "+value(input.Phone))
	if input.Mode == "delivery" {
		a := input.Address
		fields := [][3]string{{"Country", "الدولة", a.Country}, {"Region ID", "رمز المنطقة", a.RegionID}, {"City ID", "رمز المدينة", a.CityID}, {"District ID", "رمز الحي", a.DistrictID}, {"Address label", "اسم العنوان", a.Label}, {"City", "المدينة", a.City}, {"District", "الحي", a.District}, {"Area", "المنطقة", a.Area}, {"Street", "الشارع", a.Street}, {"Building", "المبنى", a.Building}, {"Postal code", "الرمز البريدي", a.PostalCode}, {"Additional number", "الرقم الإضافي", a.AdditionalNumber}, {"National address", "العنوان الوطني", a.NationalAddress}, {"Address detail", "تفاصيل العنوان", a.AddressLine}}
		for _, field := range fields {
			if field[2] != "" {
				lines = append(lines, label(field[0], field[1])+": "+value(field[2]))
			}
		}
		if a.Latitude != nil && a.Longitude != nil {
			lines = append(lines, label("Coordinates", "الإحداثيات")+": "+strconv.FormatFloat(*a.Latitude, 'f', -1, 64)+", "+strconv.FormatFloat(*a.Longitude, 'f', -1, 64))
		}
	}
	payment := map[string][2]string{"card": {"Card", "بطاقة"}, "cash_on_delivery": {"Cash on delivery", "نقدًا عند التوصيل"}, "cash_after": {"Cash after service", "نقدًا بعد الخدمة"}}[input.PaymentMethod]
	if payment[0] == "" {
		return empty, restaurantFail(400, "payment_required")
	}
	lines = append(lines, label("Payment", "الدفع")+": "+label(payment[0], payment[1]))
	if input.PaymentProvider != "" {
		lines = append(lines, label("Payment provider", "مزود الدفع")+": "+value(input.PaymentProvider))
	}
	if input.Notes != "" {
		lines = append(lines, label("Notes", "ملاحظات")+": "+value(input.Notes))
	}
	lines = append(lines, label("Valid until", "صالحة حتى")+": "+review.ExpiresAt.UTC().Format(time.RFC3339), label("Review ID", "رقم المراجعة")+": "+review.ID, label("Confirm or cancel this exact review. Confirmation alone does not charge a card.", "أكد هذه المراجعة أو ألغها. التأكيد وحده لا يخصم مبلغًا من البطاقة."))
	text := strings.Join(lines, "\n")
	// Conservative internal UTF-8 byte limit, not a claim about provider limits.
	if len(text) > 3000 {
		return empty, restaurantFail(409, "whatsapp_review_too_large")
	}
	return restaurantWhatsappRenderedReview{review: review, text: text, digest: restaurantWhatsappDigest([]any{review.ID, review.Fingerprint, locale, text}), locale: locale}, nil
}

// Current transport authority and channel intent are required even for reading
// customer checkout data. Default nil authority keeps this private path closed.
func (s *restaurantWhatsappReviews) Render(ctx context.Context, scope restaurantWhatsappScope, id, locale string, now time.Time) (restaurantWhatsappRenderedReview, error) {
	empty := restaurantWhatsappRenderedReview{}
	if s == nil || s.orders == nil || s.authorizeDispatch == nil {
		return empty, restaurantFail(409, "channel_ordering_unavailable")
	}
	if !restaurantWhatsappValidScope(scope) || !restaurantWhatsappOpaque(id) {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	tx, err := s.orders.store.db.BeginTx(ctx, nil)
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	var enabled bool
	if err = tx.QueryRowContext(ctx, `SELECT new_orders_enabled FROM restaurant_order_channels WHERE channel=$1 FOR SHARE`, scope.Channel).Scan(&enabled); err != nil {
		return empty, err
	}
	if !enabled {
		return empty, restaurantFail(409, "channel_ordering_disabled")
	}
	if !s.authorizeDispatch(ctx, tx, scope) {
		return empty, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	// Explicit head-first locking also applies to read-only rendering. A join
	// may lock the review first and deadlock with a concurrent newer preparation.
	var active string
	var headVersion int64
	err = tx.QueryRowContext(ctx, `SELECT review_id,version FROM restaurant_whatsapp_review_heads WHERE scope_hash=$1 FOR SHARE`, restaurantWhatsappDigest(scope)).Scan(&active, &headVersion)
	if err == sql.ErrNoRows {
		return empty, restaurantFail(404, "not_found")
	}
	if err != nil {
		return empty, err
	}
	if active != id {
		return empty, restaurantFail(404, "not_found")
	}
	var review restaurantWhatsappReview
	var event string
	var checkout, quoteJSON []byte
	err = tx.QueryRowContext(ctx, `SELECT id,version,fingerprint,state,expires_at,proposal_event,checkout,quote
 FROM restaurant_whatsapp_reviews WHERE id=$1 AND scope_hash=$2 FOR SHARE`, id, restaurantWhatsappDigest(scope)).Scan(&review.ID, &review.Version, &review.Fingerprint, &review.State, &review.ExpiresAt, &event, &checkout, &quoteJSON)
	if err == sql.ErrNoRows {
		return empty, restaurantFail(404, "not_found")
	}
	if err != nil {
		return empty, err
	}
	if review.Version != headVersion {
		return empty, restaurantFail(404, "not_found")
	}
	var input restaurantOrderInput
	var quote restaurantQuote
	if json.Unmarshal(checkout, &input) != nil || json.Unmarshal(quoteJSON, &quote) != nil {
		return empty, restaurantFail(409, "whatsapp_review_changed")
	}
	rendered, err := restaurantRenderWhatsappReview(scope, event, review, input, quote, locale, now)
	if err != nil {
		return empty, err
	}
	return rendered, tx.Commit()
}
