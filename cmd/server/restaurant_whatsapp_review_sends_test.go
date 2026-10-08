package main

import (
	"context"
	"database/sql"
	"sync"
	"testing"
	"time"
)

func whatsappSendFixture(t *testing.T) (*restaurantWhatsappReviews, restaurantWhatsappScope, restaurantWhatsappReview, time.Time) {
	t.Helper()
	s, p, scope, input, now := whatsappReviewFixture(t)
	s.authorizeDispatch = func(_ context.Context, _ *sql.Tx, actual restaurantWhatsappScope) bool { return actual == scope }
	if _, err := s.orders.SetOrderChannel(context.Background(), scope.Channel, "synthetic-owner", true, 1); err != nil {
		t.Fatal(err)
	}
	r, err := s.Prepare(context.Background(), p, scope, input, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	return s, scope, r, now
}

func TestRestaurantWhatsappReviewSendConcurrentClaimAndRestart(t *testing.T) {
	s, scope, review, now := whatsappSendFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s.orders.store.db.SetMaxOpenConns(2)
	const n = 12
	results := make(chan restaurantWhatsappReviewSend, n)
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := s.ClaimReviewSend(ctx, scope, review.ID, "ar", now)
			results <- r
			errs <- err
		}()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first restaurantWhatsappReviewSend
	acquired := 0
	for r := range results {
		if r.State != "unknown" {
			t.Fatal("claim pretended to send")
		}
		if r.Acquired {
			acquired++
			first = r
			if r.Text == "" {
				t.Fatal("missing first payload")
			}
		} else if r.Text != "" {
			t.Fatal("retry obtained send payload")
		}
	}
	if acquired != 1 {
		t.Fatal("multiple send claims", acquired)
	}
	restarted, err := newRestaurantWhatsappReviews(ctx, s.orders)
	if err != nil {
		t.Fatal(err)
	}
	restarted.authorizeDispatch = s.authorizeDispatch
	r, err := restarted.ClaimReviewSend(ctx, scope, review.ID, "ar", now.Add(10*time.Minute))
	if err != nil || r.Acquired || r.Text != "" || r.AttemptID != first.AttemptID || r.BodyHash != first.BodyHash {
		t.Fatal("lost claim was retried", r, err)
	}
	_, err = restarted.ClaimReviewSend(ctx, scope, review.ID, "en", now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	var presented string
	if err = s.orders.store.db.QueryRow("SELECT presented_message_id FROM restaurant_whatsapp_reviews WHERE id=$1", review.ID).Scan(&presented); err != nil || presented != "" {
		t.Fatal("claim recorded presentation", err)
	}
	var count int
	if err = s.orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 0 {
		t.Fatal("claim created order", err)
	}
}

func TestRestaurantWhatsappReviewSendAcceptedEvidenceAndConfirmation(t *testing.T) {
	s, scope, review, now := whatsappSendFixture(t)
	ctx := context.Background()
	claim, err := s.ClaimReviewSend(ctx, scope, review.ID, "en", now)
	if err != nil {
		t.Fatal(err)
	}
	evidence := restaurantWhatsappDigest("synthetic-provider-acceptance")
	_, err = s.RecordReviewSend(ctx, scope, review.ID, claim.AttemptID, restaurantWhatsappDigest("wrong-body"), "accepted", "provider-1", evidence, now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	for i := 0; i < 2; i++ {
		r, err := s.RecordReviewSend(ctx, scope, review.ID, claim.AttemptID, claim.BodyHash, "accepted", "provider-1", evidence, now)
		if err != nil || r.State != "accepted" || r.Acquired || r.Text != "" {
			t.Fatal("acceptance receipt", r, err)
		}
	}
	_, err = s.RecordReviewSend(ctx, scope, review.ID, claim.AttemptID, claim.BodyHash, "accepted", "provider-2", evidence, now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	source := restaurantWhatsappSource{MessageID: "explicit-confirm", SentAt: now}
	confirmed, err := s.Decide(ctx, scope, source, review.ID, review.Fingerprint, "provider-1", "confirmed", now)
	if err != nil || confirmed.State != "confirmed" {
		t.Fatal("confirmed presented review", err)
	}
	_, err = s.RecordReviewSend(ctx, scope, review.ID, claim.AttemptID, claim.BodyHash, "rejected", "", evidence, now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
}

func TestRestaurantWhatsappReviewSendLateEvidenceNeverRevives(t *testing.T) {
	for _, kind := range []string{"expired", "policy-cycle", "superseded", "rejected"} {
		t.Run(kind, func(t *testing.T) {
			s, scope, review, now := whatsappSendFixture(t)
			ctx := context.Background()
			claim, err := s.ClaimReviewSend(ctx, scope, review.ID, "en", now)
			if err != nil {
				t.Fatal(err)
			}
			state, message := "accepted", "provider-1"
			switch kind {
			case "expired":
				now = review.ExpiresAt
			case "policy-cycle":
				if _, err = s.orders.SetOrderChannel(ctx, scope.Channel, "synthetic-owner", false, 2); err != nil {
					t.Fatal(err)
				}
				if _, err = s.orders.SetOrderChannel(ctx, scope.Channel, "synthetic-owner", true, 3); err != nil {
					t.Fatal(err)
				}
			case "superseded":
				if _, err = s.orders.store.db.Exec(`UPDATE restaurant_whatsapp_review_heads SET version=version+1,review_id='' WHERE scope_hash=$1`, restaurantWhatsappDigest(scope)); err != nil {
					t.Fatal(err)
				}
			case "rejected":
				state, message = "rejected", ""
			}
			r, err := s.RecordReviewSend(ctx, scope, review.ID, claim.AttemptID, claim.BodyHash, state, message, restaurantWhatsappDigest("synthetic-evidence"), now)
			if err != nil || r.State != state {
				t.Fatal("late evidence lost", err)
			}
			var presented string
			if err = s.orders.store.db.QueryRow("SELECT presented_message_id FROM restaurant_whatsapp_reviews WHERE id=$1", review.ID).Scan(&presented); err != nil || presented != "" {
				t.Fatal("stale evidence revived presentation", err)
			}
			r, err = s.ClaimReviewSend(ctx, scope, review.ID, "en", now)
			if err != nil || r.Acquired || r.Text != "" || r.State != state {
				t.Fatal("terminal attempt retried", err)
			}
		})
	}
}

func TestRestaurantWhatsappReviewSendRequiresAuthority(t *testing.T) {
	s, scope, review, now := whatsappSendFixture(t)
	ctx := context.Background()
	authority := s.authorizeDispatch
	s.authorizeDispatch = nil
	_, err := s.ClaimReviewSend(ctx, scope, review.ID, "en", now)
	restaurantOrdersRequireError(t, err, "channel_ordering_unavailable")
	s.authorizeDispatch = authority
	foreign := scope
	foreign.Generation = "different-generation"
	_, err = s.ClaimReviewSend(ctx, foreign, review.ID, "en", now)
	restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
	claim, err := s.ClaimReviewSend(ctx, scope, review.ID, "en", now)
	if err != nil {
		t.Fatal(err)
	}
	s.authorizeDispatch = func(context.Context, *sql.Tx, restaurantWhatsappScope) bool { return false }
	_, err = s.RecordReviewSend(ctx, scope, review.ID, claim.AttemptID, claim.BodyHash, "accepted", "provider-1", restaurantWhatsappDigest("synthetic"), now)
	restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
}

func TestRestaurantWhatsappReviewSendRejectsUnclaimedStaleReview(t *testing.T) {
	s, scope, review, now := whatsappSendFixture(t)
	ctx := context.Background()
	_, err := s.ClaimReviewSend(ctx, scope, review.ID, "en", review.ExpiresAt)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	if _, err = s.orders.SetOrderChannel(ctx, scope.Channel, "synthetic-owner", false, 2); err != nil {
		t.Fatal(err)
	}
	_, err = s.ClaimReviewSend(ctx, scope, review.ID, "en", now)
	restaurantOrdersRequireError(t, err, "channel_ordering_disabled")
	var count int
	if err = s.orders.store.db.QueryRow("SELECT count(*) FROM restaurant_whatsapp_review_sends").Scan(&count); err != nil || count != 0 {
		t.Fatal("invalid review consumed a claim", err)
	}
}

func TestRestaurantWhatsappReviewSendConflictingEvidenceRace(t *testing.T) {
	s, scope, review, now := whatsappSendFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	s.orders.store.db.SetMaxOpenConns(2)
	claim, err := s.ClaimReviewSend(ctx, scope, review.ID, "en", now)
	if err != nil {
		t.Fatal(err)
	}
	outcomes := make(chan error, 2)
	for _, state := range []string{"accepted", "rejected"} {
		go func(state string) {
			message := ""
			if state == "accepted" {
				message = "provider-1"
			}
			_, e := s.RecordReviewSend(ctx, scope, review.ID, claim.AttemptID, claim.BodyHash, state, message, restaurantWhatsappDigest(state), now)
			outcomes <- e
		}(state)
	}
	winners := 0
	for i := 0; i < 2; i++ {
		if e := <-outcomes; e == nil {
			winners++
		} else {
			restaurantOrdersRequireError(t, e, "whatsapp_review_changed")
		}
	}
	if winners != 1 {
		t.Fatal("contradictory evidence committed", winners)
	}
	var state, presented string
	if err = s.orders.store.db.QueryRow(`SELECT s.state,r.presented_message_id FROM restaurant_whatsapp_review_sends s JOIN restaurant_whatsapp_reviews r ON r.id=s.review_id WHERE r.id=$1`, review.ID).Scan(&state, &presented); err != nil {
		t.Fatal(err)
	}
	if (state == "accepted") != (presented == "provider-1") {
		t.Fatal("presentation was not atomic with result")
	}
}

func TestRestaurantWhatsappReviewSendProviderIdentityCannotBeReused(t *testing.T) {
	s, p, scope, input, now := whatsappReviewFixture(t)
	ctx := context.Background()
	s.authorizeDispatch = func(_ context.Context, _ *sql.Tx, actual restaurantWhatsappScope) bool { return actual == scope }
	if _, err := s.orders.SetOrderChannel(ctx, scope.Channel, "synthetic-owner", true, 1); err != nil {
		t.Fatal(err)
	}
	first, err := s.Prepare(ctx, p, scope, input, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	one, err := s.ClaimReviewSend(ctx, scope, first.ID, "en", now)
	if err != nil {
		t.Fatal(err)
	}
	evidence := restaurantWhatsappDigest("synthetic")
	if _, err = s.RecordReviewSend(ctx, scope, first.ID, one.AttemptID, one.BodyHash, "accepted", "same-provider-id", evidence, now); err != nil {
		t.Fatal(err)
	}
	second, err := s.Prepare(ctx, p, scope, input, 1, now)
	if err != nil {
		t.Fatal(err)
	}
	two, err := s.ClaimReviewSend(ctx, scope, second.ID, "en", now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.RecordReviewSend(ctx, scope, second.ID, two.AttemptID, two.BodyHash, "accepted", "same-provider-id", evidence, now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	var state, presented string
	if err = s.orders.store.db.QueryRow(`SELECT s.state,r.presented_message_id FROM restaurant_whatsapp_review_sends s JOIN restaurant_whatsapp_reviews r ON r.id=s.review_id WHERE r.id=$1`, second.ID).Scan(&state, &presented); err != nil || state != "unknown" || presented != "" {
		t.Fatal("rejected evidence partially committed", err)
	}
}
