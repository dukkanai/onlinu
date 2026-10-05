package main

import (
	"context"
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func restaurantStockFixture(t *testing.T, quantity int64) (*restaurantOrders, restaurantOrderInput) {
	t.Helper()
	orders, _, _ := restaurantOrdersFixtureDB(t)
	if _, err := orders.SaveStock(context.Background(), "rice", restaurantStockInput{Tracked: true, Available: quantity}); err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("delivery")
	input.Items[0].Quantity = 1
	input.ExpectedTotalMinor = 2000
	return orders, input
}

func restaurantAssertStock(t *testing.T, orders *restaurantOrders, available, held int64) {
	t.Helper()
	items, err := orders.ListStock(context.Background())
	if err != nil || len(items) != 1 {
		t.Fatalf("stock: %+v %v", items, err)
	}
	if items[0].Available != available || items[0].Held != held {
		t.Fatalf("stock available/held want %d/%d, got %+v", available, held, items[0])
	}
}

func TestRestaurantStockNamesComeFromCurrentCatalogueWithoutChangingCounters(t *testing.T) {
	orders, _, _ := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	catalog, err := loadRestaurantCatalog(ctx, orders.store.db, false)
	if err != nil {
		t.Fatal(err)
	}
	items, err := orders.ListStock(ctx)
	if err != nil || len(items) != 1 || items[0].Name != catalog.Items[0].Name || items[0].Version != 0 || items[0].Tracked {
		t.Fatalf("unconfigured stock label: %+v %v", items, err)
	}
	changed, err := orders.SaveStock(ctx, items[0].ItemID, restaurantStockInput{Tracked: true, Available: 7})
	if err != nil || changed.Name != catalog.Items[0].Name || changed.Available != 7 || changed.Held != 0 {
		t.Fatalf("recount label: %+v %v", changed, err)
	}
}

func TestRestaurantStockStaffRecountKeepsHoldsAndAuditsAtomically(t *testing.T) {
	orders, input := restaurantStockFixture(t, 5)
	if _, err := orders.Create(context.Background(), input, "", uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	items, err := orders.ListStock(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:synthetic-staff", "staff:stock:update"})
	changed, err := orders.SaveStock(ctx, "rice", restaurantStockInput{Tracked: true, Available: 9, Version: items[0].Version})
	if err != nil {
		t.Fatal(err)
	}
	restaurantAssertStock(t, orders, 9, 1)
	var actor, scope string
	if err = orders.store.db.QueryRow("SELECT actor_id,actor_scope FROM restaurant_stock_events WHERE kind='recount' ORDER BY id DESC LIMIT 1").Scan(&actor, &scope); err != nil || actor != "platform:synthetic-staff" || scope != "staff:stock:update" {
		t.Fatal("missing staff inventory attribution", err)
	}
	_, err = orders.store.db.Exec(`CREATE FUNCTION reject_stock_recount_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.kind='recount' THEN RAISE EXCEPTION 'synthetic audit failure';END IF;RETURN NEW;END $$;
		CREATE TRIGGER reject_stock_recount_audit BEFORE INSERT ON restaurant_stock_events FOR EACH ROW EXECUTE FUNCTION reject_stock_recount_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orders.SaveStock(ctx, "rice", restaurantStockInput{Tracked: true, Available: 3, Version: changed.Version}); err == nil {
		t.Fatal("recount ignored failed audit")
	}
	restaurantAssertStock(t, orders, 9, 1)
}

func TestRestaurantStockActorMigrationPreservesHistoricalEvents(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	_, err := db.ExecContext(ctx, `CREATE TABLE restaurant_stock_events (
		id bigserial PRIMARY KEY,item_id text NOT NULL,order_number text NOT NULL DEFAULT '',kind text NOT NULL,
		quantity bigint NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
		INSERT INTO restaurant_stock_events(item_id,kind,quantity) VALUES('old-item','recount',5)`)
	if err != nil {
		t.Fatal(err)
	}
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = newRestaurantOrders(ctx, store); err != nil {
		t.Fatal(err)
	}
	var actor, scope string
	var quantity int
	if err = db.QueryRowContext(ctx, "SELECT actor_id,actor_scope,quantity FROM restaurant_stock_events WHERE item_id='old-item'").Scan(&actor, &scope, &quantity); err != nil || actor != "" || scope != "" || quantity != 5 {
		t.Fatal("migration invented historical actors or changed stock history", err)
	}
}

func TestRestaurantStockConcurrentLastPortion(t *testing.T) {
	orders, input := restaurantStockFixture(t, 1)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	const workers = 16
	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			_, err := orders.Create(ctx, input, "", uuid.NewString())
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	success := 0
	for err := range errs {
		if err == nil {
			success++
		} else {
			restaurantOrdersRequireError(t, err, "item_unavailable")
		}
	}
	if success != 1 {
		t.Fatalf("last portion sold %d times", success)
	}
	restaurantAssertStock(t, orders, 0, 1)
	var count int
	if err := orders.store.db.QueryRow(`SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 1 {
		t.Fatalf("rolled-back oversells left orders: %d %v", count, err)
	}
}

func TestRestaurantStockConcurrentIdempotentRetryAtZero(t *testing.T) {
	orders, input := restaurantStockFixture(t, 1)
	ctx := context.Background()
	key := uuid.NewString()
	const workers = 12
	start := make(chan struct{})
	results := make(chan restaurantReceipt, workers)
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			r, err := orders.Create(ctx, input, "", key)
			results <- r
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	number := ""
	for r := range results {
		if number != "" && number != r.Order.Number {
			t.Fatal("duplicate order")
		}
		number = r.Order.Number
		if r.Order.StockExpiresAt == nil {
			t.Fatal("missing hold deadline")
		}
	}
	restaurantAssertStock(t, orders, 0, 1)
	_, err := orders.Quote(ctx, input)
	restaurantOrdersRequireError(t, err, "item_unavailable")
	catalog, err := orders.store.GetCatalog(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	if len(catalog.Items) != 0 {
		t.Fatal("sold-out product still public")
	}
	catalog, err = orders.store.GetCatalog(ctx, false)
	if err != nil || len(catalog.Items) != 1 {
		t.Fatal("admin lost product")
	}
}

func TestRestaurantStockCountsDuplicateProductLines(t *testing.T) {
	orders, input := restaurantStockFixture(t, 1)
	input.Items = append(input.Items, input.Items[0])
	input.ExpectedTotalMinor = 3500
	_, err := orders.Create(context.Background(), input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "item_unavailable")
	restaurantAssertStock(t, orders, 1, 0)
}

func TestRestaurantStockCancellationReleaseVersusWaste(t *testing.T) {
	for _, prepare := range []bool{false, true} {
		t.Run(map[bool]string{false: "unprepared", true: "prepared"}[prepare], func(t *testing.T) {
			orders, input := restaurantStockFixture(t, 2)
			ctx := context.Background()
			receipt, err := orders.Create(ctx, input, "", uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			o := receipt.Order
			o, err = orders.SetStatus(ctx, o.Number, "accepted", o.Version)
			if err != nil {
				t.Fatal(err)
			}
			restaurantAssertStock(t, orders, 1, 0)
			if prepare {
				o, err = orders.SetStatus(ctx, o.Number, "preparing", o.Version)
				if err != nil || o.PreparationStartedAt == nil {
					t.Fatalf("preparation timestamp: %v", err)
				}
			}
			o, err = orders.SetStatus(ctx, o.Number, "cancelled", o.Version)
			if err != nil {
				t.Fatal(err)
			}
			wantAvailable, wantState := int64(2), "released"
			if prepare {
				wantAvailable, wantState = 1, "wasted"
			}
			restaurantAssertStock(t, orders, wantAvailable, 0)
			var state string
			if err = orders.store.db.QueryRow(`SELECT state FROM restaurant_stock_reservations WHERE order_number=$1`, o.Number).Scan(&state); err != nil || state != wantState {
				t.Fatalf("reservation state %s %v", state, err)
			}
			if _, err = orders.SetStatus(ctx, o.Number, "cancelled", o.Version); err != nil {
				t.Fatal(err)
			}
			restaurantAssertStock(t, orders, wantAvailable, 0)
		})
	}
}

func TestRestaurantStockRecountVersionAndActiveModeGuard(t *testing.T) {
	orders, input := restaurantStockFixture(t, 2)
	ctx := context.Background()
	stock, err := orders.ListStock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	r, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	_, err = orders.SaveStock(ctx, "rice", restaurantStockInput{Tracked: true, Available: 99, Version: stock[0].Version})
	restaurantOrdersRequireError(t, err, "conflict")
	stock, err = orders.ListStock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	_, err = orders.SaveStock(ctx, "rice", restaurantStockInput{Tracked: false, Version: stock[0].Version})
	restaurantOrdersRequireError(t, err, "conflict")
	if _, err = orders.SetStatus(ctx, r.Order.Number, "cancelled", r.Order.Version); err != nil {
		t.Fatal(err)
	}
	stock, err = orders.ListStock(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = orders.SaveStock(ctx, "rice", restaurantStockInput{Tracked: false, Version: stock[0].Version}); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantStockExpiryNeverReleasesUncertainPayment(t *testing.T) {
	for _, paymentStatus := range []string{"unpaid", "pending", "review", "paid"} {
		t.Run(paymentStatus, func(t *testing.T) {
			orders, input := restaurantStockFixture(t, 1)
			ctx := context.Background()
			r, err := orders.Create(ctx, input, "", uuid.NewString())
			if err != nil {
				t.Fatal(err)
			}
			o := r.Order
			past := time.Now().Add(-time.Hour)
			o.StockExpiresAt = &past
			o.Payment.Status = paymentStatus
			raw, _ := json.Marshal(o)
			if _, err = orders.store.db.ExecContext(ctx, `UPDATE restaurant_orders SET document=$2 WHERE number=$1`, o.Number, raw); err != nil {
				t.Fatal(err)
			}
			if _, err = orders.store.db.ExecContext(ctx, `UPDATE restaurant_stock_reservations SET expires_at=$2 WHERE order_number=$1`, o.Number, past); err != nil {
				t.Fatal(err)
			}
			n, err := orders.ExpireStockReservations(ctx, 100)
			if err != nil {
				t.Fatal(err)
			}
			if paymentStatus == "unpaid" {
				if n != 1 {
					t.Fatal("unpaid order not expired")
				}
				restaurantAssertStock(t, orders, 1, 0)
			} else {
				if n != 0 {
					t.Fatal("uncertain/paid order expired")
				}
				restaurantAssertStock(t, orders, 0, 1)
			}
		})
	}
}

func TestRestaurantStockExpiryPreservesAnyPaymentAttempt(t *testing.T) {
	orders, input := restaurantStockFixture(t, 1)
	ctx := context.Background()
	r, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	// Even inconsistent legacy metadata must fail safe: an unpaid local order
	// with a remote attempt cannot be assumed never charged.
	if _, err = orders.store.db.ExecContext(ctx, `CREATE TABLE restaurant_payment_attempts(order_number text PRIMARY KEY)`); err != nil {
		t.Fatal(err)
	}
	if _, err = orders.store.db.ExecContext(ctx, `INSERT INTO restaurant_payment_attempts VALUES($1)`, r.Order.Number); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	o := r.Order
	o.StockExpiresAt = &past
	raw, _ := json.Marshal(o)
	if _, err = orders.store.db.ExecContext(ctx, `UPDATE restaurant_orders SET document=$2 WHERE number=$1`, o.Number, raw); err != nil {
		t.Fatal(err)
	}
	if _, err = orders.store.db.ExecContext(ctx, `UPDATE restaurant_stock_reservations SET expires_at=$2 WHERE order_number=$1`, o.Number, past); err != nil {
		t.Fatal(err)
	}
	n, err := orders.ExpireStockReservations(ctx, 100)
	if err != nil || n != 0 {
		t.Fatalf("payment attempt released: %d %v", n, err)
	}
	restaurantAssertStock(t, orders, 0, 1)
}

func TestRestaurantStockConcurrentFirstSetupHasOneVersionWinner(t *testing.T) {
	orders, _, _ := restaurantOrdersFixtureDB(t)
	ctx := context.Background()
	const workers = 12
	start := make(chan struct{})
	errs := make(chan error, workers)
	var wg sync.WaitGroup
	for i := 0; i < workers; i++ {
		wg.Add(1)
		go func(quantity int64) {
			defer wg.Done()
			<-start
			_, err := orders.SaveStock(ctx, "rice", restaurantStockInput{Tracked: true, Available: quantity})
			errs <- err
		}(int64(i + 1))
	}
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
		t.Fatalf("initial missing-row stock config had %d winners", success)
	}
}

func TestRestaurantStockInitialTrackingSerializesWithCheckout(t *testing.T) {
	orders, _, db := restaurantOrdersFixtureDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	setup, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer setup.Rollback()
	if err = restaurantLockStockItem(ctx, setup, "rice"); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, createErr := orders.Create(ctx, restaurantOrderFixtureInput("pickup"), "", uuid.NewString())
		finished <- createErr
	}()
	// This transaction represents a first-time setup that has taken the item
	// lock but not inserted its row. A missing-row checkout must wait for it.
	select {
	case err = <-finished:
		t.Fatalf("checkout bypassed first-time stock setup: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	if _, err = setup.ExecContext(ctx, `INSERT INTO restaurant_stock(item_id,tracked,available,version,updated_at) VALUES('rice',true,0,1,now())`); err != nil {
		t.Fatal(err)
	}
	if err = setup.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-finished:
		restaurantOrdersRequireError(t, err, "item_unavailable")
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	var count int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("checkout escaped tracking activation: count=%d %v", count, err)
	}
}
