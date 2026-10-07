package main

import (
	"context"
	"encoding/json"
	"reflect"
	"testing"
	"time"

	"github.com/google/uuid"
)

func openingFixture() restaurantOpeningDocument {
	return restaurantOpeningDocument{Enabled: true, TimeZone: "Asia/Riyadh", Weekly: make([][]restaurantOpeningWindow, 7)}
}

func TestRestaurantOpeningScheduleClosingPreservesReceiptAndStock(t *testing.T) {
	orders, input := restaurantStockFixture(t, 2)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"synthetic-hours-owner", "staff:settings:update"})
	at, _ := time.Parse(time.RFC3339, "2026-10-07T06:00:00Z")
	orders.openingNow = func() time.Time { return at }
	enabled := true
	patch := restaurantOpeningPatch{ExpectedVersion: 1, Reviewed: true, Enabled: &enabled, TimeZone: "Asia/Riyadh", Weekly: make([][]restaurantOpeningWindow, 7)}
	patch.Weekly[3] = []restaurantOpeningWindow{{540, 1080}}
	if _, err := orders.store.PatchOpeningSchedule(ctx, patch); err != nil {
		t.Fatal(err)
	}
	if _, err := orders.Quote(ctx, input); err != nil {
		t.Fatal("opening boundary blocked quote", err)
	}
	key := uuid.NewString()
	first, err := orders.Create(ctx, input, "platform:synthetic", key)
	if err != nil {
		t.Fatal(err)
	}
	at = at.Add(9 * time.Hour)
	if _, err := orders.Quote(ctx, input); err == nil {
		t.Fatal("closing boundary allowed quote")
	} else {
		restaurantOrdersRequireError(t, err, "store_closed")
	}
	_, err = orders.Create(ctx, input, "platform:synthetic", uuid.NewString())
	restaurantOrdersRequireError(t, err, "store_closed")
	repeated, err := orders.Create(ctx, input, "platform:synthetic", key)
	if err != nil || repeated.Order.Number != first.Order.Number {
		t.Fatal("closing blocked durable receipt recovery", err)
	}
	restaurantAssertStock(t, orders, 1, 1)
	if _, err := orders.SetStatus(ctx, first.Order.Number, "accepted", first.Order.Version); err != nil {
		t.Fatal("closing blocked existing fulfillment", err)
	}
	status, err := orders.OpeningStatus(ctx)
	if err != nil || status.WithinHours == nil || *status.WithinHours || status.AcceptingOrders || !status.EvaluatedAt.Equal(at) {
		t.Fatal("public status disagrees with order gate", status, err)
	}
}

func TestRestaurantOpeningScheduleUpdateWaitsForInFlightOrderGate(t *testing.T) {
	orders, input := restaurantStockFixture(t, 2)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ctx = context.WithValue(ctx, platformStaffActorKey{}, platformStaffActor{"synthetic-hours-owner", "staff:settings:update"})
	tx, err := orders.store.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	var blocker int
	if err = tx.QueryRowContext(ctx, "SELECT pg_backend_pid()").Scan(&blocker); err != nil {
		t.Fatal(err)
	}
	if err = restaurantRequireOpening(ctx, tx, true, time.Now()); err != nil {
		t.Fatal(err)
	}
	enabled := true
	patch := restaurantOpeningPatch{ExpectedVersion: 1, Reviewed: true, Enabled: &enabled, TimeZone: "Asia/Riyadh", Weekly: make([][]restaurantOpeningWindow, 7)}
	finished := make(chan error, 1)
	go func() { _, err := orders.store.PatchOpeningSchedule(ctx, patch); finished <- err }()
	blocked := false
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if err = orders.store.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE 'UPDATE restaurant_opening_schedule%')`, blocker).Scan(&blocked); err != nil {
			t.Fatal(err)
		}
		if blocked {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if !blocked {
		t.Fatal("schedule update bypassed in-flight order lock")
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = <-finished; err != nil {
		t.Fatal(err)
	}
	_, err = orders.Create(ctx, input, "", uuid.NewString())
	restaurantOrdersRequireError(t, err, "store_closed")
}

func TestRestaurantOpeningScheduleLocalDayAndHalfOpenBoundaries(t *testing.T) {
	doc := openingFixture()
	doc.Weekly[3] = []restaurantOpeningWindow{{540, 1080}}
	for _, tc := range []struct {
		at   string
		open bool
	}{
		{"2026-10-07T05:59:59Z", false}, {"2026-10-07T06:00:00Z", true},
		{"2026-10-07T14:59:59Z", true}, {"2026-10-07T15:00:00Z", false},
		{"2026-10-08T06:00:00Z", false},
	} {
		at, _ := time.Parse(time.RFC3339, tc.at)
		got, err := restaurantOpeningAllows(doc, at)
		if err != nil || got != tc.open {
			t.Fatalf("%s: open=%v err=%v", tc.at, got, err)
		}
	}
	doc.Enabled = false
	if open, err := restaurantOpeningAllows(doc, time.Now()); err != nil || !open {
		t.Fatal("disabled schedule changed legacy behavior", err)
	}
}

func TestRestaurantOpeningScheduleMidnightAndDateExceptions(t *testing.T) {
	doc := openingFixture()
	doc.Weekly[2] = []restaurantOpeningWindow{{1380, 1440}}
	doc.Weekly[3] = []restaurantOpeningWindow{{0, 120}}
	at, _ := time.Parse(time.RFC3339, "2026-10-06T21:00:00Z") // Wednesday midnight in Riyadh.
	if open, _ := restaurantOpeningAllows(doc, at); !open {
		t.Fatal("split overnight window lost next day")
	}
	doc.Exceptions = []restaurantOpeningException{{Date: "2026-10-07", Windows: []restaurantOpeningWindow{}}}
	if open, _ := restaurantOpeningAllows(doc, at); open {
		t.Fatal("closed exception did not replace the whole local date")
	}
	if open, _ := restaurantOpeningAllows(doc, at.Add(-time.Second)); !open {
		t.Fatal("exception leaked into previous local date")
	}
	doc.Exceptions[0].Windows = []restaurantOpeningWindow{{60, 90}}
	if open, _ := restaurantOpeningAllows(doc, at.Add(time.Hour)); !open {
		t.Fatal("special opening window not used")
	}
	if open, _ := restaurantOpeningAllows(doc, at.Add(90*time.Minute)); open {
		t.Fatal("exception end is not exclusive")
	}
}

func TestRestaurantOpeningScheduleValidationAndIndependentCopy(t *testing.T) {
	good := openingFixture()
	good.Weekly[0] = []restaurantOpeningWindow{{900, 1000}, {60, 120}}
	good.Exceptions = []restaurantOpeningException{{Date: "2026-12-25", Windows: []restaurantOpeningWindow{{0, 1440}}}}
	normalized, err := normalizeRestaurantOpening(good)
	if err != nil || normalized.Weekly[0][0].StartMinute != 60 {
		t.Fatal("normalization failed", err)
	}
	normalized.Weekly[0][0].StartMinute = 1
	normalized.Exceptions[0].Windows[0].EndMinute = 1
	if good.Weekly[0][1].StartMinute != 60 || good.Exceptions[0].Windows[0].EndMinute != 1440 {
		t.Fatal("normalized document aliases caller slices")
	}
	for _, change := range []func(*restaurantOpeningDocument){
		func(d *restaurantOpeningDocument) { d.TimeZone = "UTC" },
		func(d *restaurantOpeningDocument) { d.Weekly = d.Weekly[:6] },
		func(d *restaurantOpeningDocument) { d.Weekly[0] = []restaurantOpeningWindow{{-1, 60}} },
		func(d *restaurantOpeningDocument) { d.Weekly[0] = []restaurantOpeningWindow{{0, 1441}} },
		func(d *restaurantOpeningDocument) { d.Weekly[0] = []restaurantOpeningWindow{{600, 600}} },
		func(d *restaurantOpeningDocument) { d.Weekly[0] = []restaurantOpeningWindow{{1380, 120}} },
		func(d *restaurantOpeningDocument) { d.Weekly[0] = []restaurantOpeningWindow{{60, 120}, {119, 180}} },
		func(d *restaurantOpeningDocument) { d.Exceptions = []restaurantOpeningException{{Date: "2026-02-30"}} },
		func(d *restaurantOpeningDocument) {
			d.Exceptions = []restaurantOpeningException{{Date: "2026-01-01"}, {Date: "2026-01-01"}}
		},
		func(d *restaurantOpeningDocument) { d.Exceptions = make([]restaurantOpeningException, 65) },
	} {
		doc := openingFixture()
		change(&doc)
		if _, err := normalizeRestaurantOpening(doc); err == nil {
			t.Fatal("invalid opening policy accepted", doc)
		}
	}
	for _, raw := range []string{`{}`, `{"endMinute":60}`, `{"startMinute":0}`, `{"startMinute":0,"endMinute":60,"extra":1}`, `null`} {
		var window restaurantOpeningWindow
		if json.Unmarshal([]byte(raw), &window) == nil {
			t.Fatal("missing or unknown interval boundary accepted", raw)
		}
	}
}

func TestRestaurantOpeningScheduleDurableCASAndAuditRollback(t *testing.T) {
	_, store, db := restaurantOrdersFixtureDB(t)
	if err := initRestaurantOpeningSchedule(context.Background(), db); err != nil {
		t.Fatal(err)
	}
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"synthetic-hours-owner", "staff:settings:update"})
	initial, err := store.OpeningSchedule(ctx)
	if err != nil || initial.Enabled || initial.Version != 1 {
		t.Fatal("default must preserve manual service behavior", initial, err)
	}
	enabled := true
	patch := restaurantOpeningPatch{ExpectedVersion: 1, Reviewed: true, Enabled: &enabled, TimeZone: "Asia/Riyadh", Weekly: make([][]restaurantOpeningWindow, 7)}
	patch.Weekly[3] = []restaurantOpeningWindow{{540, 1080}}
	if _, err := store.PatchOpeningSchedule(context.Background(), patch); err == nil {
		t.Fatal("missing staff authority accepted")
	}
	updated, err := store.PatchOpeningSchedule(ctx, patch)
	if err != nil || !updated.Enabled || updated.Version != 2 {
		t.Fatal("schedule update failed", updated, err)
	}
	if _, err := store.PatchOpeningSchedule(ctx, patch); err == nil {
		t.Fatal("stale schedule version accepted")
	}
	if err := initRestaurantOpeningSchedule(ctx, db); err != nil {
		t.Fatal(err)
	}
	preserved, err := store.OpeningSchedule(ctx)
	if err != nil || !reflect.DeepEqual(preserved, updated) {
		t.Fatal("restart overwrote schedule", err)
	}
	catalog, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.OpeningHours = "Legacy informational text remains independent"
	if _, err := store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	preserved, err = store.OpeningSchedule(ctx)
	if err != nil || !reflect.DeepEqual(preserved, updated) {
		t.Fatal("legacy catalogue save overwrote structured schedule", err)
	}
	var actor, scope string
	if err = db.QueryRow("SELECT actor_id,actor_scope FROM restaurant_opening_schedule_audit WHERE version=2").Scan(&actor, &scope); err != nil || actor != "synthetic-hours-owner" || scope != "staff:settings:update" {
		t.Fatal("schedule audit missing", err)
	}
	_, err = db.Exec(`CREATE FUNCTION reject_hours_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic failure'; END $$; CREATE TRIGGER reject_hours_audit BEFORE INSERT ON restaurant_opening_schedule_audit FOR EACH ROW EXECUTE FUNCTION reject_hours_audit()`)
	if err != nil {
		t.Fatal(err)
	}
	patch.ExpectedVersion = 2
	if _, err := store.PatchOpeningSchedule(ctx, patch); err == nil {
		t.Fatal("audit failure ignored")
	}
	unchanged, err := store.OpeningSchedule(ctx)
	if err != nil || !reflect.DeepEqual(unchanged, updated) {
		t.Fatal("audit failure did not roll back", err)
	}
}

func TestRestaurantOpeningScheduleCorruptStorageFailsClosed(t *testing.T) {
	orders, input := restaurantStockFixture(t, 2)
	if _, err := orders.store.db.Exec(`UPDATE restaurant_opening_schedule SET document=document-'enabled' WHERE id=1`); err != nil {
		t.Fatal(err)
	}
	if _, err := orders.store.OpeningSchedule(context.Background()); err == nil {
		t.Fatal("missing stored enabled flag became a disabled schedule")
	}
	if _, err := orders.Create(context.Background(), input, "", uuid.NewString()); err == nil {
		t.Fatal("corrupt policy accepted new order")
	}
	restaurantAssertStock(t, orders, 2, 0)
}
