package main

import (
	"context"
	"encoding/json"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func restaurantCancelledFixture(t *testing.T) (*restaurantOrders, restaurantReceipt, restaurantOrder, restaurantOrderInput) {
	t.Helper()
	orders, input := restaurantStockFixture(t, 1)
	ctx := context.Background()
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := orders.RequestCancellation(ctx, receipt.Order.Number, receipt.TrackingToken, "", "", "cancelled by mistake", uuid.NewString(), receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	return orders, receipt, cancelled, input
}

func restaurantSaveReopenTestOrder(t *testing.T, orders *restaurantOrders, order restaurantOrder) {
	t.Helper()
	raw, err := json.Marshal(order)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orders.store.db.Exec(`UPDATE restaurant_orders SET document=$2,status=$3,version=$4 WHERE number=$1`, order.Number, raw, order.Status, order.Version); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantReopenIdempotentHistorySnapshotAndCourierRevocation(t *testing.T) {
	orders, receipt, cancelled, _ := restaurantCancelledFixture(t)
	ctx := context.Background()
	cancelled.CourierID, cancelled.CourierName, cancelled.DeliveryStatus = "old-courier", "Old Courier", "assigned"
	cancelled.DeliveryEvents = []restaurantDeliveryEvent{{Status: "assigned", Actor: "admin", At: time.Now().UTC()}}
	restaurantSaveReopenTestOrder(t, orders, cancelled)
	request := restaurantReopenInput{RequestID: uuid.NewString(), Version: cancelled.Version, Reason: "correct mistaken cancellation"}
	reopened, err := orders.Reopen(ctx, cancelled.Number, request)
	if err != nil {
		t.Fatal(err)
	}
	if reopened.Status != "new" || reopened.Version != cancelled.Version+1 || reopened.StockExpiresAt == nil || reopened.Cancellation != nil || len(reopened.CancellationHistory) != 1 || !reflect.DeepEqual(reopened.CancellationHistory[0], *cancelled.Cancellation) {
		t.Fatalf("reopen history: %+v", reopened)
	}
	if reopened.CourierID != "" || reopened.CourierName != "" || reopened.DeliveryStatus != "" || len(reopened.DeliveryEvents) != 2 || reopened.DeliveryEvents[1].Status != "unassigned" {
		t.Fatal("old courier assignment survived reopen or lost its history")
	}
	if reopened.TotalMinor != receipt.Order.TotalMinor || reopened.DeliveryFeeMinor != receipt.Order.DeliveryFeeMinor || reopened.Tax != receipt.Order.Tax || !reflect.DeepEqual(reopened.Items, receipt.Order.Items) || reopened.Number != receipt.Order.Number {
		t.Fatal("reopening changed order identity or financial snapshot")
	}
	restaurantAssertStock(t, orders, 0, 1)
	tracked, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || !reflect.DeepEqual(tracked, reopened) {
		t.Fatalf("customer tracking did not show reopened state: %v", err)
	}
	retry, err := orders.Reopen(ctx, cancelled.Number, request)
	if err != nil || !reflect.DeepEqual(reopened, retry) {
		t.Fatalf("identical retry changed reopened order: %v", err)
	}
	changed := request
	changed.Reason = "different payload"
	_, err = orders.Reopen(ctx, cancelled.Number, changed)
	restaurantTestErrorCode(t, err, "conflict")
	secondCancel, err := orders.RequestCancellation(ctx, reopened.Number, receipt.TrackingToken, "", "", "cancel again", uuid.NewString(), reopened.Version)
	if err != nil {
		t.Fatal(err)
	}
	retry, err = orders.Reopen(ctx, secondCancel.Number, request)
	if err != nil || retry.Status != "cancelled" || retry.Version != secondCancel.Version {
		t.Fatalf("old retry reopened a later cancellation: %+v %v", retry, err)
	}
	changed = request
	changed.Version = secondCancel.Version
	_, err = orders.Reopen(ctx, secondCancel.Number, changed)
	restaurantTestErrorCode(t, err, "conflict")
	restaurantAssertStock(t, orders, 1, 0)
	var count int
	if err = orders.store.db.QueryRow(`SELECT count(*) FROM restaurant_order_events WHERE order_number=$1 AND kind='reopened'`, cancelled.Number).Scan(&count); err != nil || count != 1 {
		t.Fatalf("duplicate reopen event: %d %v", count, err)
	}
}

func TestRestaurantReopenConcurrentRetriesReserveOnce(t *testing.T) {
	orders, _, cancelled, _ := restaurantCancelledFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	request := restaurantReopenInput{RequestID: uuid.NewString(), Version: cancelled.Version, Reason: "mistake"}
	const workers = 10
	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := orders.Reopen(ctx, cancelled.Number, request)
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	restaurantAssertStock(t, orders, 0, 1)
	var count int
	if err := orders.store.db.QueryRow(`SELECT count(*) FROM restaurant_stock_events WHERE order_number=$1 AND kind='reopened_reserved'`, cancelled.Number).Scan(&count); err != nil || count != 1 {
		t.Fatalf("retries reserved stock %d times: %v", count, err)
	}
}

func TestRestaurantReopenCompetingAdminsAndCheckout(t *testing.T) {
	for _, newCheckout := range []bool{false, true} {
		t.Run(map[bool]string{false: "two admins", true: "last portion checkout"}[newCheckout], func(t *testing.T) {
			orders, _, cancelled, input := restaurantCancelledFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
			defer cancel()
			start := make(chan struct{})
			errs := make(chan error, 2)
			for i := 0; i < 2; i++ {
				go func(checkout bool) {
					<-start
					var err error
					if checkout {
						_, err = orders.Create(ctx, input, "", uuid.NewString())
					} else {
						_, err = orders.Reopen(ctx, cancelled.Number, restaurantReopenInput{RequestID: uuid.NewString(), Version: cancelled.Version, Reason: "mistake"})
					}
					errs <- err
				}(newCheckout && i == 1)
			}
			close(start)
			success := 0
			for i := 0; i < 2; i++ {
				if err := <-errs; err == nil {
					success++
				} else if newCheckout {
					restaurantTestErrorCode(t, err, "item_unavailable")
				} else {
					restaurantTestErrorCode(t, err, "conflict")
				}
			}
			if success != 1 {
				t.Fatalf("competing requests succeeded %d times", success)
			}
			restaurantAssertStock(t, orders, 0, 1)
		})
	}
}

func TestRestaurantReopenRejectsPaymentPreparationAndInvalidTransitions(t *testing.T) {
	for _, tc := range []struct {
		name, code string
		change     func(*testing.T, *restaurantOrders, *restaurantOrder)
	}{
		{"not cancelled", "reopen_unavailable", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.Status = "new" }},
		{"pending cancellation", "reopen_unavailable", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.Cancellation.Status = "requested" }},
		{"prepared timestamp", "reopen_prepared", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) {
			now := time.Now().UTC()
			o.PreparationStartedAt = &now
		}},
		{"courier picked up", "reopen_prepared", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.DeliveryStatus = "picked_up" }},
		{"paid", "reopen_payment", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.Payment.Status = "paid" }},
		{"pending payment", "reopen_payment", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.Payment.Status = "pending" }},
		{"refunded", "reopen_payment", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.Payment.Status = "refunded" }},
		{"amount mismatch", "reopen_payment", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.Payment.AmountMinor++ }},
		{"cash provider", "reopen_payment", func(_ *testing.T, _ *restaurantOrders, o *restaurantOrder) { o.Payment.Provider = "stripe" }},
		{"legacy prepared event", "reopen_prepared", func(t *testing.T, orders *restaurantOrders, o *restaurantOrder) {
			if _, err := orders.store.db.Exec(`INSERT INTO restaurant_order_events(order_number,version,kind,document,created_at) VALUES($1,99,'status_changed','{"from":"accepted","to":"preparing"}',now())`, o.Number); err != nil {
				t.Fatal(err)
			}
		}},
		{"wasted reservation", "reopen_prepared", func(t *testing.T, orders *restaurantOrders, o *restaurantOrder) {
			if _, err := orders.store.db.Exec(`UPDATE restaurant_stock_reservations SET state='wasted' WHERE order_number=$1`, o.Number); err != nil {
				t.Fatal(err)
			}
		}},
		{"unreleased reservation", "reopen_stock", func(t *testing.T, orders *restaurantOrders, o *restaurantOrder) {
			if _, err := orders.store.db.Exec(`UPDATE restaurant_stock_reservations SET state='held' WHERE order_number=$1`, o.Number); err != nil {
				t.Fatal(err)
			}
		}},
		{"exhausted stock", "item_unavailable", func(t *testing.T, orders *restaurantOrders, _ *restaurantOrder) {
			if _, err := orders.store.db.Exec(`UPDATE restaurant_stock SET available=0`); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			orders, _, cancelled, _ := restaurantCancelledFixture(t)
			tc.change(t, orders, &cancelled)
			restaurantSaveReopenTestOrder(t, orders, cancelled)
			_, err := orders.Reopen(context.Background(), cancelled.Number, restaurantReopenInput{RequestID: uuid.NewString(), Version: cancelled.Version, Reason: "mistake"})
			restaurantTestErrorCode(t, err, tc.code)
			var count int
			if err = orders.store.db.QueryRow(`SELECT count(*) FROM restaurant_order_support_requests WHERE kind='reopen'`).Scan(&count); err != nil || count != 0 {
				t.Fatal("failed reopen persisted idempotency or state")
			}
		})
	}
}

func TestRestaurantReopenPaymentAttemptAndRefundRemainBlocked(t *testing.T) {
	for _, activity := range []string{"attempt", "refund"} {
		t.Run(activity, func(t *testing.T) {
			payments, receipt := restaurantPaymentFixture(t)
			orders := payments.orders
			ctx := context.Background()
			cancelled, err := orders.SetStatus(ctx, receipt.Order.Number, "cancelled", receipt.Order.Version)
			if err != nil {
				t.Fatal(err)
			}
			if activity == "attempt" {
				_, err = orders.store.db.Exec(`INSERT INTO restaurant_payment_attempts(id,order_number,provider,mode,status,sealed_config) VALUES($1,$2,'stripe','test','failed',$3)`, uuid.NewString(), cancelled.Number, []byte{})
			} else {
				_, err = orders.store.db.Exec(`INSERT INTO restaurant_refunds(id,order_number,request_key,amount_minor,tax_minor,status,data) VALUES($1,$2,$3,$4,0,'review','{}')`, uuid.NewString(), cancelled.Number, uuid.NewString(), cancelled.TotalMinor)
			}
			if err != nil {
				t.Fatal(err)
			}
			_, err = orders.Reopen(ctx, cancelled.Number, restaurantReopenInput{RequestID: uuid.NewString(), Version: cancelled.Version, Reason: "mistake"})
			restaurantTestErrorCode(t, err, "reopen_payment")
		})
	}
}

func TestRestaurantReopenCoverageChangeAndHistoricalFees(t *testing.T) {
	orders, store, input := restaurantGeographyFixture(t)
	ctx := context.Background()
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	cancelled, err := orders.SetStatus(ctx, receipt.Order.Number, "cancelled", receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	catalog, _ := store.GetCatalog(ctx, false)
	catalog.Settings.DeliveryPricingMode = "district"
	catalog, err = store.SaveCatalog(ctx, catalog)
	if err != nil {
		t.Fatal(err)
	}
	request := restaurantReopenInput{RequestID: uuid.NewString(), Version: cancelled.Version, Reason: "mistake"}
	_, err = orders.Reopen(ctx, cancelled.Number, request)
	restaurantTestErrorCode(t, err, "outside_delivery_area")
	fee := int64(999)
	catalog.Settings.DeliveryZones = []restaurantDeliveryZone{{"sa-d-1", true, &fee}}
	if _, err = store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	reopened, err := orders.Reopen(ctx, cancelled.Number, request)
	if err != nil || reopened.DeliveryFeeMinor != receipt.Order.DeliveryFeeMinor || reopened.TotalMinor != receipt.Order.TotalMinor {
		t.Fatalf("reopen repriced snapshot: %+v %v", reopened, err)
	}
}
