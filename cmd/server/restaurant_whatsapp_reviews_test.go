package main

import (
	"context"
	"sync"
	"testing"
	"time"
)

func whatsappReviewFixture(t *testing.T) (*restaurantWhatsappReviews, *restaurantWhatsappProposal, restaurantWhatsappScope, restaurantOrderInput, time.Time) {
	t.Helper()
	orders, input := restaurantStockFixture(t, 4)
	input.Mode = "pickup"
	input.PaymentMethod = "card"
	input.PaymentProvider = "stripe"
	scope, source, _, now := whatsappProposalFixture()
	proposal, err := newRestaurantWhatsappProposal(scope, source, input.Items, now)
	if err != nil {
		t.Fatal(err)
	}
	reviews, err := newRestaurantWhatsappReviews(context.Background(), orders)
	if err != nil {
		t.Fatal(err)
	}
	return reviews, proposal, scope, input, now
}

func TestRestaurantWhatsappReviewConfirmationConcurrentAndRestart(t *testing.T) {
	reviews, p, scope, input, now := whatsappReviewFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	reviews.orders.store.db.SetMaxOpenConns(2)
	review, err := reviews.Prepare(ctx, p, scope, input, 0, now)
	if err != nil || review.Version != 1 {
		t.Fatal("prepare", review, err)
	}
	source := restaurantWhatsappSource{MessageID: "confirm-test", SentAt: now}
	_, err = reviews.Decide(ctx, scope, source, review.ID, review.Fingerprint, "presented-test", "confirmed", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_not_presented")
	if _, err = reviews.Present(ctx, scope, review.ID, review.Fingerprint, "presented-test", now); err != nil {
		t.Fatal(err)
	}
	const workers = 12
	results := make(chan restaurantWhatsappReview, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := reviews.Decide(ctx, scope, source, review.ID, review.Fingerprint, "presented-test", "confirmed", now)
			if e != nil {
				errs <- e
			} else {
				results <- r
			}
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for e := range errs {
		t.Error(e)
	}
	first, duplicates := 0, 0
	for r := range results {
		if r.State != "confirmed" {
			t.Fatal("not confirmed")
		}
		if r.Duplicate {
			duplicates++
		} else {
			first++
		}
	}
	if first != 1 || duplicates != workers-1 {
		t.Fatal("confirmation not idempotent", first, duplicates)
	}
	restarted, err := newRestaurantWhatsappReviews(ctx, reviews.orders)
	if err != nil {
		t.Fatal(err)
	}
	r, err := restarted.Decide(ctx, scope, source, review.ID, review.Fingerprint, "presented-test", "confirmed", now.Add(6*time.Minute))
	if err != nil || !r.Duplicate || r.ExpiresAt.After(now.Add(6*time.Minute)) {
		t.Fatal("expired historical receipt not preserved", r, err)
	}
	altered := source
	altered.SentAt = altered.SentAt.Add(time.Second)
	_, err = restarted.Decide(ctx, scope, altered, review.ID, review.Fingerprint, "presented-test", "confirmed", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	var count int
	if err = reviews.orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 0 {
		t.Fatal("intent confirmation created an order", count, err)
	}
	restaurantAssertStock(t, reviews.orders, 4, 0)
}

func TestRestaurantWhatsappReviewSupersessionCancelExpiryAndIsolation(t *testing.T) {
	reviews, p, scope, input, now := whatsappReviewFixture(t)
	ctx := context.Background()
	first, err := reviews.Prepare(ctx, p, scope, input, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reviews.Present(ctx, scope, first.ID, first.Fingerprint, "first-presentation", now); err != nil {
		t.Fatal(err)
	}
	_, err = reviews.Prepare(ctx, p, scope, input, 0, now)
	restaurantOrdersRequireError(t, err, "conflict")
	second, err := reviews.Prepare(ctx, p, scope, input, 1, now)
	if err != nil {
		t.Fatal(err)
	}
	source := restaurantWhatsappSource{MessageID: "decision-test", SentAt: now}
	_, err = reviews.Decide(ctx, scope, source, first.ID, first.Fingerprint, "first-presentation", "confirmed", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	foreign := scope
	foreign.Generation = "other-generation"
	_, err = reviews.Present(ctx, foreign, second.ID, second.Fingerprint, "second-presentation", now)
	restaurantOrdersRequireError(t, err, "not_found")
	if _, err = reviews.Present(ctx, scope, second.ID, second.Fingerprint, "second-presentation", now); err != nil {
		t.Fatal(err)
	}
	_, err = reviews.Present(ctx, scope, second.ID, second.Fingerprint, "different-presentation", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	_, err = reviews.Decide(ctx, scope, source, second.ID, second.Fingerprint, "wrong-reply", "confirmed", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_not_presented")
	cancelled, err := reviews.Decide(ctx, scope, source, second.ID, second.Fingerprint, "second-presentation", "cancelled", now)
	if err != nil || cancelled.State != "cancelled" {
		t.Fatal("cancel", err)
	}
	source.MessageID = "later-confirm"
	_, err = reviews.Decide(ctx, scope, source, second.ID, second.Fingerprint, "second-presentation", "confirmed", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	third, err := reviews.Prepare(ctx, p, scope, input, 2, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = reviews.Present(ctx, scope, third.ID, third.Fingerprint, "late-presentation", third.ExpiresAt)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
}

func TestRestaurantWhatsappReviewRejectsChangedPriceCartAndStoredData(t *testing.T) {
	reviews, p, scope, input, now := whatsappReviewFixture(t)
	ctx := context.Background()
	changed := input
	changed.Items = append([]restaurantOrderLineInput{}, input.Items...)
	changed.Items[0].Quantity++
	_, err := reviews.Prepare(ctx, p, scope, changed, 0, now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	review, err := reviews.Prepare(ctx, p, scope, input, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reviews.Present(ctx, scope, review.ID, review.Fingerprint, "presented", now); err != nil {
		t.Fatal(err)
	}
	catalog, err := reviews.orders.store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Items[0].PriceMinor++
	if _, err = reviews.orders.store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	source := restaurantWhatsappSource{MessageID: "confirm-price", SentAt: now}
	_, err = reviews.Decide(ctx, scope, source, review.ID, review.Fingerprint, "presented", "confirmed", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	var state string
	if err = reviews.orders.store.db.QueryRow("SELECT state FROM restaurant_whatsapp_reviews WHERE id=$1", review.ID).Scan(&state); err != nil || state != "pending" {
		t.Fatal("price failure changed state", state, err)
	}
	_, err = reviews.orders.store.db.Exec(`UPDATE restaurant_whatsapp_reviews SET checkout=jsonb_set(checkout,'{customerName}','"changed"'::jsonb) WHERE id=$1`, review.ID)
	if err != nil {
		t.Fatal(err)
	}
	_, err = reviews.Present(ctx, scope, review.ID, review.Fingerprint, "presented", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	restaurantAssertStock(t, reviews.orders, 4, 0)
}

func TestRestaurantWhatsappReviewCancelVersusConfirmAndSourceExpiry(t *testing.T) {
	reviews, p, scope, input, now := whatsappReviewFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	late := now.Add(12 * time.Minute)
	review, err := reviews.Prepare(ctx, p, scope, input, 0, late)
	if err != nil || !review.ExpiresAt.Equal(p.expiresAt) {
		t.Fatal("review extended proposal expiry", review, err)
	}
	if _, err = reviews.Present(ctx, scope, review.ID, review.Fingerprint, "presented-race", late); err != nil {
		t.Fatal(err)
	}
	results := make(chan restaurantWhatsappReview, 2)
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	for _, decision := range []string{"confirmed", "cancelled"} {
		wg.Add(1)
		go func(action string) {
			defer wg.Done()
			source := restaurantWhatsappSource{MessageID: "race-" + action, SentAt: late}
			r, e := reviews.Decide(ctx, scope, source, review.ID, review.Fingerprint, "presented-race", action, late)
			if e != nil {
				errs <- e
			} else {
				results <- r
			}
		}(decision)
	}
	wg.Wait()
	close(results)
	close(errs)
	successes, conflicts := 0, 0
	for range results {
		successes++
	}
	for e := range errs {
		restaurantOrdersRequireError(t, e, "whatsapp_review_changed")
		conflicts++
	}
	if successes != 1 || conflicts != 1 {
		t.Fatal("both decisions took effect", successes, conflicts)
	}
	_, err = reviews.Prepare(ctx, p, scope, input, 1, p.expiresAt)
	restaurantOrdersRequireError(t, err, "whatsapp_message_expired")
}
