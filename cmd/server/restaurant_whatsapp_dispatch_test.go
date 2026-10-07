package main

import (
	"context"
	"database/sql"
	"errors"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func whatsappDispatchFixture(t *testing.T, channel string) (*restaurantWhatsappReviews, restaurantWhatsappScope, restaurantWhatsappReview, time.Time) {
	t.Helper()
	reviews, p, scope, input, now := whatsappReviewFixture(t)
	scope.Channel = channel
	var err error
	p, err = newRestaurantWhatsappProposal(scope, p.source, input.Items, now)
	if err != nil {
		t.Fatal(err)
	}
	reviews.authorizeDispatch = func(_ context.Context, _ *sql.Tx, actual restaurantWhatsappScope) bool { return actual == scope }
	reviews.dispatchNow = func() time.Time { return now }
	if _, err = reviews.orders.SetOrderChannel(context.Background(), channel, "synthetic-owner", true, 1); err != nil {
		t.Fatal(err)
	}
	review, err := reviews.Prepare(context.Background(), p, scope, input, 0, now)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = reviews.Present(context.Background(), scope, review.ID, review.Fingerprint, "review-presented", now); err != nil {
		t.Fatal(err)
	}
	review, err = reviews.Decide(context.Background(), scope, restaurantWhatsappSource{MessageID: "review-confirmed", SentAt: now}, review.ID, review.Fingerprint, "review-presented", "confirmed", now)
	if err != nil {
		t.Fatal(err)
	}
	return reviews, scope, review, now
}

func TestRestaurantWhatsappDispatchOriginalCoreExactlyOnce(t *testing.T) {
	for _, channel := range []string{"whatsapp_qr", "whatsapp_cloud"} {
		t.Run(channel, func(t *testing.T) {
			reviews, scope, review, now := whatsappDispatchFixture(t, channel)
			reviews.orders.store.db.SetMaxOpenConns(2)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			const workers = 12
			results := make(chan restaurantReceipt, workers)
			errs := make(chan error, workers)
			var wg sync.WaitGroup
			for i := 0; i < workers; i++ {
				wg.Add(1)
				go func() {
					defer wg.Done()
					r, e := reviews.Dispatch(ctx, scope, review.ID)
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
			for err := range errs {
				t.Error(err)
			}
			var first restaurantReceipt
			count := 0
			for r := range results {
				if count == 0 {
					first = r
				}
				count++
				if r.Order.Number != first.Order.Number || r.TrackingToken != first.TrackingToken || r.Order.Channel != channel || r.Order.Payment.Status != "unpaid" {
					t.Fatal("inconsistent original receipt")
				}
			}
			if count != workers {
				t.Fatal("missing dispatch results", count)
			}
			restaurantAssertStock(t, reviews.orders, 3, 1)
			var orders int
			if err := reviews.orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&orders); err != nil || orders != 1 {
				t.Fatal("duplicate original order", orders, err)
			}
			if _, err := reviews.orders.SetOrderChannel(ctx, channel, "synthetic-owner", false, 2); err != nil {
				t.Fatal(err)
			}
			reviews.dispatchNow = func() time.Time { return now.Add(time.Hour) }
			replay, err := reviews.Dispatch(ctx, scope, review.ID)
			if err != nil || replay.Order.Number != first.Order.Number || replay.TrackingToken != first.TrackingToken {
				t.Fatal("accepted receipt not recoverable after closure/expiry", err)
			}
			restaurantAssertStock(t, reviews.orders, 3, 1)
		})
	}
}

func TestRestaurantWhatsappDispatchLostCommittedResultAndUnsentExpiry(t *testing.T) {
	for _, committed := range []bool{false, true} {
		t.Run(map[bool]string{false: "before-create", true: "after-commit"}[committed], func(t *testing.T) {
			reviews, scope, review, now := whatsappDispatchFixture(t, "whatsapp_qr")
			reviews.dispatchCreate = func(ctx context.Context, input restaurantOrderInput, owner, key string) (restaurantReceipt, error) {
				if committed {
					if _, err := reviews.orders.Create(ctx, input, owner, key); err != nil {
						return restaurantReceipt{}, err
					}
				}
				return restaurantReceipt{}, errors.New("synthetic lost result")
			}
			if _, err := reviews.Dispatch(context.Background(), scope, review.ID); err == nil {
				t.Fatal("expected uncertain result")
			}
			var before string
			if err := reviews.orders.store.db.QueryRow("SELECT dispatch_key FROM restaurant_whatsapp_dispatches WHERE review_id=$1", review.ID).Scan(&before); err != nil {
				t.Fatal(err)
			}
			reviews.dispatchCreate = nil
			reviews.dispatchNow = func() time.Time { return now.Add(6 * time.Minute) }
			receipt, err := reviews.Dispatch(context.Background(), scope, review.ID)
			if committed {
				if err != nil || receipt.Order.Number == "" {
					t.Fatal("lost committed receipt not recovered", err)
				}
				restaurantAssertStock(t, reviews.orders, 3, 1)
			} else {
				restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
				restaurantAssertStock(t, reviews.orders, 4, 0)
			}
			var after string
			if err = reviews.orders.store.db.QueryRow("SELECT dispatch_key FROM restaurant_whatsapp_dispatches WHERE review_id=$1", review.ID).Scan(&after); err != nil || before != after {
				t.Fatal("retry replaced durable key", err)
			}
		})
	}
}

func TestRestaurantWhatsappDispatchPolicyCycleAndCurrentAuthority(t *testing.T) {
	reviews, scope, review, _ := whatsappDispatchFixture(t, "whatsapp_qr")
	reviews.dispatchCreate = func(context.Context, restaurantOrderInput, string, string) (restaurantReceipt, error) {
		return restaurantReceipt{}, errors.New("synthetic no dispatch")
	}
	if _, err := reviews.Dispatch(context.Background(), scope, review.ID); err == nil {
		t.Fatal("expected simulated failure")
	}
	if _, err := reviews.orders.SetOrderChannel(context.Background(), scope.Channel, "synthetic-owner", false, 2); err != nil {
		t.Fatal(err)
	}
	if _, err := reviews.orders.SetOrderChannel(context.Background(), scope.Channel, "synthetic-owner", true, 3); err != nil {
		t.Fatal(err)
	}
	reviews.dispatchCreate = nil
	_, err := reviews.Dispatch(context.Background(), scope, review.ID)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	restaurantAssertStock(t, reviews.orders, 4, 0)
	reviews.authorizeDispatch = nil
	_, err = reviews.Dispatch(context.Background(), scope, review.ID)
	restaurantOrdersRequireError(t, err, "channel_ordering_unavailable")
}

func TestRestaurantWhatsappDispatchRejectsAlteredPayloadAndRevokedBinding(t *testing.T) {
	for _, mode := range []string{"payload", "owner", "key", "binding"} {
		t.Run(mode, func(t *testing.T) {
			reviews, scope, review, _ := whatsappDispatchFixture(t, "whatsapp_cloud")
			if mode == "payload" || mode == "owner" || mode == "key" {
				reviews.dispatchCreate = func(ctx context.Context, input restaurantOrderInput, owner, key string) (restaurantReceipt, error) {
					if mode == "payload" {
						input.Notes = "changed after review"
					} else if mode == "owner" {
						owner = "different-owner"
					} else {
						key = "11111111-1111-4111-8111-111111111111"
					}
					return reviews.orders.Create(ctx, input, owner, key)
				}
			} else {
				var checks atomic.Int32
				reviews.authorizeDispatch = func(context.Context, *sql.Tx, restaurantWhatsappScope) bool { return checks.Add(1) == 1 }
			}
			_, err := reviews.Dispatch(context.Background(), scope, review.ID)
			if mode == "payload" || mode == "owner" || mode == "key" {
				restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
			} else {
				restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
			}
			restaurantAssertStock(t, reviews.orders, 4, 0)
		})
	}
}

func TestRestaurantWhatsappDispatchRechecksPriceAndStock(t *testing.T) {
	for _, mode := range []string{"price", "stock"} {
		t.Run(mode, func(t *testing.T) {
			reviews, scope, review, _ := whatsappDispatchFixture(t, "whatsapp_qr")
			ctx := context.Background()
			if mode == "price" {
				catalog, err := reviews.orders.store.GetCatalog(ctx, false)
				if err != nil {
					t.Fatal(err)
				}
				catalog.Items[0].PriceMinor++
				if _, err = reviews.orders.store.SaveCatalog(ctx, catalog); err != nil {
					t.Fatal(err)
				}
			} else {
				stock, err := reviews.orders.ListStock(ctx)
				if err != nil {
					t.Fatal(err)
				}
				if _, err = reviews.orders.SaveStock(ctx, "rice", restaurantStockInput{Tracked: true, Available: 0, Version: stock[0].Version}); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := reviews.Dispatch(ctx, scope, review.ID); err == nil {
				t.Fatal("stale quote/stock accepted")
			}
			var orders int
			if err := reviews.orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&orders); err != nil || orders != 0 {
				t.Fatal("rejected dispatch created order", orders, err)
			}
		})
	}
}

func TestRestaurantWhatsappDispatchRejectsSupersededReviewAndUnwiredContext(t *testing.T) {
	reviews, scope, review, now := whatsappDispatchFixture(t, "whatsapp_qr")
	_, source, items, _ := whatsappProposalFixture()
	source.MessageID = "newer-cart"
	proposal, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("pickup")
	input.Items = items
	if _, err = reviews.Prepare(context.Background(), proposal, scope, input, 1, now); err != nil {
		t.Fatal(err)
	}
	_, err = reviews.Dispatch(context.Background(), scope, review.ID)
	restaurantOrdersRequireError(t, err, "whatsapp_review_changed")
	restaurantAssertStock(t, reviews.orders, 4, 0)
	foreign := scope
	foreign.PeerID = "different-peer"
	_, err = reviews.Dispatch(context.Background(), foreign, review.ID)
	restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
	reviews.dispatchNow = func() time.Time { return time.Time{} }
	_, err = reviews.Dispatch(context.Background(), scope, review.ID)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
}
