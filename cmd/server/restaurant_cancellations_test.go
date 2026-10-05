package main

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRestaurantCancellationEarlyAuthorizedIdempotent(t *testing.T) {
	orders, input := restaurantStockFixture(t, 1)
	ctx := context.Background()
	r, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	key := uuid.NewString()
	_, err = orders.RequestCancellation(ctx, r.Order.Number, "", "", "", "changed plans", key, r.Order.Version)
	restaurantOrdersRequireError(t, err, "invalid_order_access")
	_, err = orders.RequestCancellation(ctx, r.Order.Number, r.TrackingToken, "", "", " ", key, r.Order.Version)
	restaurantOrdersRequireError(t, err, "invalid_request")
	o, err := orders.RequestCancellation(ctx, r.Order.Number, r.TrackingToken, "", "", "changed plans", key, r.Order.Version)
	if err != nil || o.Status != "cancelled" || o.Cancellation == nil || o.Cancellation.Status != "approved" || !o.Cancellation.RequestedBeforePreparation || o.Cancellation.DecidedAt == nil {
		t.Fatalf("early cancellation: %+v %v", o, err)
	}
	if o.TotalMinor != r.Order.TotalMinor || o.Tax != r.Order.Tax {
		t.Fatal("cancellation changed financial snapshot")
	}
	restaurantAssertStock(t, orders, 1, 0)
	again, err := orders.RequestCancellation(ctx, r.Order.Number, r.TrackingToken, "", "", "changed plans", key, r.Order.Version)
	if err != nil || again.Version != o.Version {
		t.Fatalf("retry not idempotent: %v", err)
	}
	_, err = orders.RequestCancellation(ctx, r.Order.Number, r.TrackingToken, "", "", "different reason", key, r.Order.Version)
	restaurantOrdersRequireError(t, err, "conflict")
	var count int
	if err = orders.store.db.QueryRow(`SELECT count(*) FROM restaurant_refunds`).Scan(&count); err != nil || count != 0 {
		t.Fatal("unpaid COD created money refund")
	}
}

func TestRestaurantCancellationPaidCashCreatesOneReviewRefund(t *testing.T) {
	orders, store, _ := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("table")
	input.TableCode = catalog.Tables[0].Code
	input.PaymentMethod = "cash_before"
	r, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	o, err := orders.CollectCash(ctx, r.Order.Number, r.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	originalPayment := o.Payment
	key := uuid.NewString()
	o, err = orders.RequestCancellation(ctx, o.Number, r.TrackingToken, "", "", "cancel before preparation", key, o.Version)
	if err != nil {
		t.Fatal(err)
	}
	if o.Payment.Status != "paid" || o.Payment.PaidAt == nil || o.Payment.AmountMinor != originalPayment.AmountMinor {
		t.Fatal("cash cancellation fabricated refund")
	}
	var count int
	var total int64
	var status string
	if err = orders.store.db.QueryRow(`SELECT count(*),COALESCE(sum(amount_minor),0),min(status) FROM restaurant_refunds WHERE order_number=$1`, o.Number).Scan(&count, &total, &status); err != nil || count != 1 || total != o.TotalMinor || status != "review" {
		t.Fatalf("refund intent %d %d %s %v", count, total, status, err)
	}
	if _, err = orders.RequestCancellation(ctx, o.Number, r.TrackingToken, "", "", "cancel before preparation", key, o.Version); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantCancellationPreparationRace(t *testing.T) {
	orders, input := restaurantStockFixture(t, 1)
	ctx := context.Background()
	r, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	o, err := orders.SetStatus(ctx, r.Order.Number, "accepted", r.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	start := make(chan struct{})
	errs := make(chan error, 2)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		<-start
		_, e := orders.SetStatus(ctx, o.Number, "preparing", o.Version)
		errs <- e
	}()
	go func() {
		defer wg.Done()
		<-start
		_, e := orders.RequestCancellation(ctx, o.Number, r.TrackingToken, "", "", "changed plans", uuid.NewString(), o.Version)
		errs <- e
	}()
	close(start)
	wg.Wait()
	close(errs)
	success := 0
	for err := range errs {
		if err == nil {
			success++
		} else {
			restaurantOrdersRequireError(t, err, "conflict")
		}
	}
	if success != 1 {
		t.Fatalf("race success count %d", success)
	}
	o, err = orders.Track(ctx, o.Number, r.TrackingToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if o.Status == "cancelled" {
		if o.PreparationStartedAt != nil {
			t.Fatal("preparation started after eligible cancel")
		}
		restaurantAssertStock(t, orders, 1, 0)
	} else if o.Status == "preparing" {
		if o.PreparationStartedAt == nil {
			t.Fatal("missing real preparation timestamp")
		}
		restaurantAssertStock(t, orders, 0, 0)
		o, err = orders.RequestCancellation(ctx, o.Number, r.TrackingToken, "", "", "changed plans", uuid.NewString(), o.Version)
		if err != nil || o.Status != "preparing" || o.Cancellation.Status != "requested" || o.Cancellation.RequestedBeforePreparation {
			t.Fatalf("late cancellation did not review: %v", err)
		}
	} else {
		t.Fatalf("unexpected final state %s", o.Status)
	}
}

func TestRestaurantCancellationPreparedReviewRejectThenApprove(t *testing.T) {
	orders, input := restaurantStockFixture(t, 1)
	ctx := context.Background()
	r, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	o := r.Order
	for _, status := range []string{"accepted", "preparing"} {
		o, err = orders.SetStatus(ctx, o.Number, status, o.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	preparedAt := *o.PreparationStartedAt
	o, err = orders.RequestCancellation(ctx, o.Number, r.TrackingToken, "", "", "changed plans", uuid.NewString(), o.Version)
	if err != nil {
		t.Fatal(err)
	}
	_, err = orders.SetStatus(ctx, o.Number, "ready", o.Version)
	restaurantOrdersRequireError(t, err, "invalid_status")
	_, err = orders.DecideCancellation(ctx, o.Number, "", false, o.Version)
	restaurantOrdersRequireError(t, err, "invalid_request")
	_, err = orders.DecideCancellation(ctx, o.Number, "already cooking", false, o.Version-1)
	restaurantOrdersRequireError(t, err, "conflict")
	o, err = orders.DecideCancellation(ctx, o.Number, "already cooking", false, o.Version)
	if err != nil || o.Status != "preparing" || o.Cancellation.Status != "rejected" {
		t.Fatalf("reject: %v", err)
	}
	o, err = orders.RequestCancellation(ctx, o.Number, r.TrackingToken, "", "", "urgent reason", uuid.NewString(), o.Version)
	if err != nil {
		t.Fatal(err)
	}
	o, err = orders.DecideCancellation(ctx, o.Number, "manager exception", true, o.Version)
	if err != nil || o.Status != "cancelled" || o.Cancellation.Status != "approved" || !o.PreparationStartedAt.Equal(preparedAt) {
		t.Fatalf("approve: %v", err)
	}
	restaurantAssertStock(t, orders, 0, 0)
	var state string
	if err = orders.store.db.QueryRow(`SELECT state FROM restaurant_stock_reservations WHERE order_number=$1`, o.Number).Scan(&state); err != nil || state != "wasted" {
		t.Fatalf("prepared portion returned %s %v", state, err)
	}
}

func TestRestaurantComplaintsAuthorizationIdempotencyResolution(t *testing.T) {
	orders, input := restaurantStockFixture(t, 2)
	ctx := context.Background()
	r, err := orders.Create(ctx, input, "owner-one", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	key := uuid.NewString()
	_, err = orders.ReportComplaint(ctx, r.Order.Number, "", "", "owner-two", "missing sauce", key, r.Order.Version)
	restaurantOrdersRequireError(t, err, "invalid_order_access")
	o, err := orders.ReportComplaint(ctx, r.Order.Number, "", "", "owner-one", "missing sauce", key, r.Order.Version)
	if err != nil || len(o.Complaints) != 1 || o.Complaints[0].Status != "open" {
		t.Fatalf("complaint %v", err)
	}
	again, err := orders.ReportComplaint(ctx, r.Order.Number, "", "", "owner-one", "missing sauce", key, r.Order.Version)
	if err != nil || again.Version != o.Version {
		t.Fatalf("retry %v", err)
	}
	_, err = orders.RequestCancellation(ctx, r.Order.Number, "", "", "owner-one", "missing sauce", key, o.Version)
	restaurantOrdersRequireError(t, err, "conflict")
	_, err = orders.ReportComplaint(ctx, r.Order.Number, "", "", "owner-one", strings.Repeat("ع", 1001), uuid.NewString(), o.Version)
	restaurantOrdersRequireError(t, err, "invalid_request")
	o, err = orders.ResolveComplaint(ctx, o.Number, key, "replacement agreed", o.Version)
	if err != nil || o.Complaints[0].Status != "resolved" || o.Complaints[0].ResolvedAt == nil {
		t.Fatalf("resolution %v", err)
	}
	if o.TotalMinor != r.Order.TotalMinor || o.Status != r.Order.Status {
		t.Fatal("complaint secretly changed order/payment")
	}
	_, err = orders.ResolveComplaint(ctx, o.Number, key, "overwrite", o.Version)
	restaurantOrdersRequireError(t, err, "invalid_status")
}

func TestRestaurantCancellationPaidUnknownCardDoesNotClaimRefunded(t *testing.T) {
	orders, _, db := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	r, err := orders.Create(ctx, restaurantOrderFixtureInput("pickup"), "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	o := r.Order
	now := time.Now().UTC()
	o.Payment.Status = "paid"
	o.Payment.PaidAt = &now
	raw, _ := json.Marshal(o)
	if _, err = db.ExecContext(ctx, `UPDATE restaurant_orders SET document=$2 WHERE number=$1`, o.Number, raw); err != nil {
		t.Fatal(err)
	}
	o, err = orders.RequestCancellation(ctx, o.Number, r.TrackingToken, "", "", "changed plans", uuid.NewString(), o.Version)
	if err != nil {
		t.Fatal(err)
	}
	if o.Payment.Status != "review" || o.Payment.PaidAt == nil {
		t.Fatal("unverified legacy card was marked refunded")
	}
	var status string
	if err = db.QueryRowContext(ctx, `SELECT status FROM restaurant_refunds WHERE order_number=$1`, o.Number).Scan(&status); err != nil || status != "review" {
		t.Fatalf("unsafe refund intent %s %v", status, err)
	}
}

func TestRestaurantCancellationLegacyPreparationUsesEvidenceOnly(t *testing.T) {
	for _, hasEvent := range []bool{true, false} {
		t.Run(map[bool]string{true: "recorded", false: "unknown"}[hasEvent], func(t *testing.T) {
			orders, input := restaurantStockFixture(t, 1)
			ctx := context.Background()
			r, err := orders.Create(ctx, input, "", uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			o := r.Order
			var actual time.Time
			if hasEvent {
				for _, status := range []string{"accepted", "preparing"} {
					o, err = orders.SetStatus(ctx, o.Number, status, o.Version)
					if err != nil {
						t.Fatal(err)
					}
				}
				actual = *o.PreparationStartedAt
			} else {
				o.Status = "preparing"
			}
			o.PreparationStartedAt = nil
			o.UpdatedAt = time.Now().UTC().Add(time.Hour)
			raw, _ := json.Marshal(o)
			if _, err = orders.store.db.ExecContext(ctx, `UPDATE restaurant_orders SET document=$2,status=$3 WHERE number=$1`, o.Number, raw, o.Status); err != nil {
				t.Fatal(err)
			}
			o, err = orders.SetStatus(ctx, o.Number, "cancelled", o.Version)
			if err != nil {
				t.Fatal(err)
			}
			if hasEvent {
				// PostgreSQL event timestamps have microsecond precision.
				if o.PreparationStartedAt == nil || o.PreparationStartedAt.Sub(actual).Abs() >= time.Microsecond {
					t.Fatal("invented a legacy preparation time")
				}
			} else if o.PreparationStartedAt != nil {
				t.Fatal("invented time without historical evidence")
			}
			restaurantAssertStock(t, orders, 0, 0)
			var state string
			if err = orders.store.db.QueryRowContext(ctx, `SELECT state FROM restaurant_stock_reservations WHERE order_number=$1`, o.Number).Scan(&state); err != nil || state != "wasted" {
				t.Fatalf("legacy prepared stock restored: %s %v", state, err)
			}
		})
	}
}
