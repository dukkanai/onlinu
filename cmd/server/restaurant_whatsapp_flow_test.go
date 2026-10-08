package main

import (
	"context"
	"database/sql"
	"testing"
	"time"
)

// Synthetic boundary composition, not a live conversational adapter. Catalogue
// mapping and checkout collection are explicit fixture inputs, never inferred
// from the incoming text or a provider's quoted price.
func TestRestaurantWhatsappQRReviewedOrderBoundaryComposition(t *testing.T) {
	s, _, _, input, _ := whatsappReviewFixture(t)
	binding, own, evt, now := whatsappQRDecisionFixture("تأكيد")
	source := restaurantWhatsappSource{MessageID: "cart-fixture", SentAt: now.Add(-time.Minute)}
	parsed, err := restaurantWhatsappQRDecision(binding, own, evt, now)
	if err != nil {
		t.Fatal(err)
	}
	scope := parsed.scope
	s.authorizeDispatch = func(_ context.Context, _ *sql.Tx, actual restaurantWhatsappScope) bool { return actual == scope }
	s.dispatchNow = func() time.Time { return now }
	ctx := context.Background()
	if _, err = s.orders.SetOrderChannel(ctx, scope.Channel, "synthetic-owner", true, 1); err != nil {
		t.Fatal(err)
	}
	proposal, err := newRestaurantWhatsappProposal(scope, source, input.Items, now)
	if err != nil {
		t.Fatal(err)
	}
	inbox, err := newRestaurantWhatsappInbox(ctx, s.orders.store.db)
	if err != nil {
		t.Fatal(err)
	}
	if r, e := inbox.Record(ctx, proposal, now); e != nil || r.Duplicate {
		t.Fatal("first proposal", e)
	}
	quote, err := s.orders.Quote(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	review, err := s.Prepare(ctx, proposal, scope, input, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	send, err := s.ClaimReviewSend(ctx, scope, review.ID, "ar", now)
	if err != nil || !send.Acquired {
		t.Fatal("review claim", err)
	}
	// An explicit-looking reply cannot confirm a review whose send is unknown.
	_, err = s.Decide(ctx, scope, parsed.source, review.ID, review.Fingerprint, parsed.replyTo, parsed.decision, now)
	restaurantOrdersRequireError(t, err, "whatsapp_review_not_presented")
	if _, err = s.RecordReviewSend(ctx, scope, review.ID, send.AttemptID, send.BodyHash, "accepted", parsed.replyTo, restaurantWhatsappDigest("synthetic-acceptance-only"), now); err != nil {
		t.Fatal(err)
	}
	var original restaurantReceipt
	for i := 0; i < 2; i++ {
		decision, e := s.Decide(ctx, scope, parsed.source, review.ID, review.Fingerprint, parsed.replyTo, parsed.decision, now)
		if e != nil || decision.Duplicate != (i == 1) {
			t.Fatal("decision idempotency", e)
		}
		receipt, e := s.Dispatch(ctx, scope, review.ID)
		if e != nil {
			t.Fatal(e)
		}
		if i == 0 {
			original = receipt
		}
		if receipt.Order.Number != original.Order.Number || receipt.Order.TotalMinor != quote.TotalMinor || receipt.Order.Payment.Status != "unpaid" {
			t.Fatal("core authority or replay changed")
		}
	}
	duplicate, err := inbox.Record(ctx, proposal, now)
	if err != nil || !duplicate.Duplicate {
		t.Fatal("source replay lost", err)
	}
	again, err := s.ClaimReviewSend(ctx, scope, review.ID, "ar", now)
	if err != nil || again.Acquired || again.Text != "" {
		t.Fatal("source replay would resend", err)
	}
	var count int
	if err = s.orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 1 {
		t.Fatal("unexpected order count", count, err)
	}
	restaurantAssertStock(t, s.orders, 3, 1)
}
