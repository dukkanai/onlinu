package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func restaurantCourierFixture(t *testing.T) (*restaurantCouriers, *restaurantOrders, *sql.DB) {
	t.Helper()
	db := restaurantIntegrationDB(t)
	ctx := context.Background()
	store, err := newRestaurantStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	orders, err := newRestaurantOrders(ctx, store)
	if err != nil {
		t.Fatal(err)
	}
	couriers, err := newRestaurantCouriers(ctx, db, orders)
	if err != nil {
		t.Fatal(err)
	}
	return couriers, orders, db
}

func restaurantCourierCreateTest(t *testing.T, s *restaurantCouriers, username string) restaurantCourier {
	t.Helper()
	courier, err := s.Create(context.Background(), restaurantCourierCreateInput{Username: username, Name: "Test " + username, Phone: "+٩٦٦ ٥٠ ٠٠٠ ٠٠٠٠", Password: "test courier passphrase"})
	if err != nil {
		t.Fatal(err)
	}
	return courier
}

func restaurantCourierCreateOrder(t *testing.T, orders *restaurantOrders) restaurantReceipt {
	t.Helper()
	ctx := context.Background()
	catalog, err := orders.store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderInput{Mode: "delivery", CustomerName: "Test recipient", Phone: "+966500000000", Address: restaurantAddress{Country: "SA", NationalAddress: "TEST1234"}, PaymentMethod: "cash_on_delivery", Items: []restaurantOrderLineInput{{ItemID: catalog.Items[0].ID, Quantity: 1, OptionIDs: []string{}}}}
	quote, err := orders.Quote(ctx, input)
	if err != nil {
		t.Fatal(err)
	}
	input.ExpectedTotalMinor = quote.TotalMinor
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return receipt
}

func restaurantCourierReady(t *testing.T, orders *restaurantOrders, order restaurantOrder) restaurantOrder {
	t.Helper()
	for _, status := range []string{"accepted", "preparing", "ready"} {
		var err error
		order, err = orders.SetStatus(context.Background(), order.Number, status, order.Version)
		if err != nil {
			t.Fatal(err)
		}
	}
	return order
}

func TestRestaurantCourierTransitionRules(t *testing.T) {
	stages := []string{"assigned", "picked_up", "on_the_way", "nearby", "at_door", "delivered"}
	for i, from := range stages {
		for j, to := range stages {
			if restaurantDeliveryTransition(from, to) != (j == i+1) {
				t.Errorf("incorrect transition %s -> %s", from, to)
			}
		}
	}
	if restaurantDeliveryTransition("", "assigned") || restaurantDeliveryTransition("delivered", "assigned") {
		t.Fatal("only admin may initialize/reassign deliveries")
	}
	if _, _, err := restaurantCourierProfile("   ", ""); err == nil {
		t.Fatal("courier name is required")
	}
	if _, _, err := restaurantCourierProfile("driver", "not a phone"); err == nil {
		t.Fatal("invalid phone accepted")
	}
}

func TestRestaurantCourierIntegrationAccountsSessionsAndReset(t *testing.T) {
	s, _, db := restaurantCourierFixture(t)
	ctx := context.Background()
	alice := restaurantCourierCreateTest(t, s, "Driver-A")
	bob := restaurantCourierCreateTest(t, s, "driver-b")
	if alice.Username != "driver-a" || alice.Availability != "offline" || !alice.Active || alice.Phone != "+966 50 000 0000" {
		t.Fatalf("unexpected normalized courier: %+v", alice)
	}
	_, err := s.Create(ctx, restaurantCourierCreateInput{Username: "DRIVER-A", Name: "Another", Password: "test courier passphrase"})
	restaurantAccountsRequireError(t, err, "username_taken")
	_, _, err = s.Login(ctx, "driver-a", "wrong password")
	restaurantAccountsRequireError(t, err, "invalid_credentials")
	_, _, err = s.Login(ctx, "missing-driver", "test courier passphrase")
	restaurantAccountsRequireError(t, err, "invalid_credentials")
	_, token, err := s.Login(ctx, " DRIVER-A ", "test courier passphrase")
	if err != nil {
		t.Fatal(err)
	}
	_, otherToken, err := s.Login(ctx, bob.Username, "test courier passphrase")
	if err != nil {
		t.Fatal(err)
	}
	var stored []byte
	var ttl float64
	if err = db.QueryRowContext(ctx, `SELECT token_hash,extract(epoch FROM expires_at-created_at) FROM restaurant_courier_sessions WHERE courier_id=$1`, alice.ID).Scan(&stored, &ttl); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte(token))
	if string(stored) != string(digest[:]) || ttl != restaurantCustomerSessionLifetime.Seconds() {
		t.Fatal("courier session is not hashed with seven-day expiry")
	}
	accounts, err := newRestaurantAccounts(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	_, customerToken, err := accounts.Register(ctx, alice.Username, "test customer passphrase", "")
	if err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Authenticate(ctx, customerToken); err != nil || ok {
		t.Fatal("customer token crossed into courier authentication")
	}
	if _, ok, err := accounts.Authenticate(ctx, token); err != nil || ok {
		t.Fatal("courier token crossed into customer authentication")
	}
	current, err := s.SetAvailability(ctx, alice.ID, "busy")
	if err != nil || current.Availability != "busy" {
		t.Fatalf("availability: %v", err)
	}
	_, err = s.SetAvailability(ctx, alice.ID, "delivered")
	restaurantAccountsRequireError(t, err, "invalid_request")
	password := "a changed courier passphrase"
	if _, err = s.Update(ctx, alice.ID, restaurantCourierAdminUpdate{Password: &password}); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Authenticate(ctx, token); err != nil || ok {
		t.Fatal("password reset did not revoke sessions")
	}
	_, _, err = s.Login(ctx, alice.Username, "test courier passphrase")
	restaurantAccountsRequireError(t, err, "invalid_credentials")
	_, token, err = s.Login(ctx, alice.Username, password)
	if err != nil {
		t.Fatal(err)
	}
	inactive := false
	if _, err = s.Update(ctx, alice.ID, restaurantCourierAdminUpdate{Active: &inactive}); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Authenticate(ctx, token); err != nil || ok {
		t.Fatal("deactivation did not revoke login")
	}
	_, _, err = s.Login(ctx, alice.Username, password)
	restaurantAccountsRequireError(t, err, "invalid_credentials")
	if _, ok, err := s.Authenticate(ctx, otherToken); err != nil || !ok {
		t.Fatal("deactivation affected another courier")
	}
	active := true
	current, err = s.Update(ctx, alice.ID, restaurantCourierAdminUpdate{Active: &active})
	if err != nil || current.Availability != "offline" {
		t.Fatal("reactivation should keep availability offline")
	}
	_, token, err = s.Login(ctx, alice.Username, password)
	if err != nil {
		t.Fatal(err)
	}
	digest = sha256.Sum256([]byte(token))
	if _, err = db.ExecContext(ctx, `UPDATE restaurant_courier_sessions SET expires_at=now()-interval '1 second' WHERE token_hash=$1`, digest[:]); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Authenticate(ctx, token); err != nil || ok {
		t.Fatal("expired session still authenticates")
	}
	if err = s.Logout(ctx, otherToken); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := s.Authenticate(ctx, otherToken); err != nil || ok {
		t.Fatal("logout failed to revoke session")
	}
	all, err := s.List(ctx)
	if err != nil || len(all) != 2 {
		t.Fatalf("list accounts: %v", err)
	}
	raw, _ := json.Marshal(all)
	if strings.Contains(string(raw), "password") || strings.Contains(string(raw), "token") {
		t.Fatal("public courier DTO leaked credentials")
	}
}

func TestRestaurantCourierIntegrationSessionLimit(t *testing.T) {
	s, _, db := restaurantCourierFixture(t)
	ctx := context.Background()
	courier := restaurantCourierCreateTest(t, s, "session-driver")
	var first, last string
	for i := 0; i < 12; i++ {
		tx, err := db.BeginTx(ctx, nil)
		if err != nil {
			t.Fatal(err)
		}
		var id string
		if err = tx.QueryRowContext(ctx, `SELECT id FROM restaurant_couriers WHERE id=$1 FOR UPDATE`, courier.ID).Scan(&id); err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		last, err = s.createSession(ctx, tx, courier.ID)
		if err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
		if i == 0 {
			first = last
		}
	}
	var count int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_courier_sessions WHERE courier_id=$1`, courier.ID).Scan(&count); err != nil || count != 10 {
		t.Fatalf("session cap: %d %v", count, err)
	}
	if _, ok, err := s.Authenticate(ctx, first); err != nil || ok {
		t.Fatal("oldest session not removed")
	}
	if _, ok, err := s.Authenticate(ctx, last); err != nil || !ok {
		t.Fatal("newest session not valid")
	}
}

func TestRestaurantCourierIntegrationAssignmentDeliveryAndCash(t *testing.T) {
	s, orders, db := restaurantCourierFixture(t)
	ctx := context.Background()
	alice := restaurantCourierCreateTest(t, s, "delivery-a")
	bob := restaurantCourierCreateTest(t, s, "delivery-b")
	receipt := restaurantCourierCreateOrder(t, orders)
	order, err := s.Assign(ctx, receipt.Order.Number, alice.ID, receipt.Order.Version)
	if err != nil || order.DeliveryStatus != "assigned" || len(order.DeliveryEvents) != 1 {
		t.Fatalf("assignment: %v", err)
	}
	_, err = s.UpdateOrder(ctx, alice.ID, order.Number, "picked_up", order.Version, false)
	restaurantAccountsRequireError(t, err, "invalid_status")
	_, err = s.Assign(ctx, order.Number, bob.ID, receipt.Order.Version)
	restaurantAccountsRequireError(t, err, "conflict")
	_, err = s.UpdateOrder(ctx, bob.ID, order.Number, "picked_up", order.Version, false)
	restaurantAccountsRequireError(t, err, "order_not_found")
	listed, err := s.ListOrders(ctx, alice.ID)
	if err != nil || len(listed) != 1 {
		t.Fatalf("assigned list: %v", err)
	}
	listed, err = s.ListOrders(ctx, bob.ID)
	if err != nil || len(listed) != 0 {
		t.Fatal("unassigned courier saw another order")
	}
	order = restaurantCourierReady(t, orders, order)
	_, err = s.UpdateOrder(ctx, alice.ID, order.Number, "nearby", order.Version, false)
	restaurantAccountsRequireError(t, err, "invalid_status")
	_, err = s.UpdateOrder(ctx, alice.ID, order.Number, "picked_up", order.Version, true)
	restaurantAccountsRequireError(t, err, "forbidden")
	for _, status := range []string{"picked_up", "on_the_way", "nearby", "at_door"} {
		order, err = s.UpdateOrder(ctx, alice.ID, order.Number, status, order.Version, false)
		if err != nil {
			t.Fatalf("%s: %v", status, err)
		}
	}
	_, err = s.UpdateOrder(ctx, alice.ID, order.Number, "delivered", order.Version, false)
	restaurantAccountsRequireError(t, err, "payment_required")
	order, err = s.UpdateOrder(ctx, alice.ID, order.Number, "delivered", order.Version, true)
	if err != nil || order.Status != "completed" || order.Payment.Status != "paid" || order.Payment.PaidAt == nil || order.DeliveryStatus != "delivered" {
		t.Fatalf("COD delivery: %+v %v", order, err)
	}
	listed, err = s.ListOrders(ctx, alice.ID)
	if err != nil || len(listed) != 0 {
		t.Fatal("terminal order remained on active courier list")
	}
	_, err = s.Assign(ctx, order.Number, bob.ID, order.Version)
	restaurantAccountsRequireError(t, err, "invalid_status")
	var events int64
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_order_events WHERE order_number=$1`, order.Number).Scan(&events); err != nil || events != order.Version {
		t.Fatalf("every version must have one durable event: %d/%d %v", events, order.Version, err)
	}
	tracked, err := orders.Track(ctx, order.Number, receipt.TrackingToken, "", "")
	if err != nil || tracked.DeliveryStatus != "delivered" || len(tracked.DeliveryEvents) != 6 {
		t.Fatalf("customer tracking lost delivery events: %v", err)
	}
}

func TestRestaurantCourierIntegrationReassignmentIsolationAndCardGate(t *testing.T) {
	s, orders, db := restaurantCourierFixture(t)
	ctx := context.Background()
	alice := restaurantCourierCreateTest(t, s, "reassign-a")
	bob := restaurantCourierCreateTest(t, s, "reassign-b")
	receipt := restaurantCourierCreateOrder(t, orders)
	order, err := s.Assign(ctx, receipt.Order.Number, alice.ID, receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	order = restaurantCourierReady(t, orders, order)
	order, err = s.UpdateOrder(ctx, alice.ID, order.Number, "picked_up", order.Version, false)
	if err != nil {
		t.Fatal(err)
	}
	order, err = s.Assign(ctx, order.Number, bob.ID, order.Version)
	if err != nil || order.DeliveryStatus != "assigned" {
		t.Fatal("reassignment failed")
	}
	_, err = s.UpdateOrder(ctx, alice.ID, order.Number, "on_the_way", order.Version, false)
	restaurantAccountsRequireError(t, err, "order_not_found")
	if listed, err := s.ListOrders(ctx, alice.ID); err != nil || len(listed) != 0 {
		t.Fatal("old courier retained order access")
	}
	order, err = s.UpdateOrder(ctx, bob.ID, order.Number, "picked_up", order.Version, false)
	if err != nil {
		t.Fatalf("reassigned in-flight order cannot be picked up: %v", err)
	}
	// Simulate a payment becoming unpaid after preparation in this isolated
	// database, never a provider transaction. A courier cannot bypass that gate.
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	order.Payment = restaurantOrderPayment{Method: "card", Provider: "stripe", Status: "unpaid", AmountMinor: order.TotalMinor}
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		tx.Rollback()
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	_, err = s.UpdateOrder(ctx, bob.ID, order.Number, "on_the_way", order.Version, false)
	restaurantAccountsRequireError(t, err, "payment_required")
	_, err = s.UpdateOrder(ctx, bob.ID, order.Number, "on_the_way", order.Version, true)
	restaurantAccountsRequireError(t, err, "forbidden")
	inactive := false
	if _, err = s.Update(ctx, bob.ID, restaurantCourierAdminUpdate{Active: &inactive}); err != nil {
		t.Fatal(err)
	}
	if listed, err := s.ListOrders(ctx, bob.ID); err != nil || len(listed) != 0 {
		t.Fatal("deactivated courier retained assigned data")
	}
	_, err = s.UpdateOrder(ctx, bob.ID, order.Number, "on_the_way", order.Version, false)
	restaurantAccountsRequireError(t, err, "unauthorized")
	order, err = s.Assign(ctx, order.Number, "", order.Version)
	if err != nil || order.CourierID != "" || order.DeliveryStatus != "" {
		t.Fatalf("admin unassignment failed: %v", err)
	}
	_, err = s.Assign(ctx, order.Number, bob.ID, order.Version)
	restaurantAccountsRequireError(t, err, "not_found")
}

func TestRestaurantCourierIntegrationConcurrentVersion(t *testing.T) {
	s, orders, _ := restaurantCourierFixture(t)
	ctx := context.Background()
	courier := restaurantCourierCreateTest(t, s, "concurrent-driver")
	receipt := restaurantCourierCreateOrder(t, orders)
	order, err := s.Assign(ctx, receipt.Order.Number, courier.ID, receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	order = restaurantCourierReady(t, orders, order)
	var wait sync.WaitGroup
	errors := make(chan error, 2)
	for i := 0; i < 2; i++ {
		wait.Add(1)
		go func() {
			defer wait.Done()
			_, err := s.UpdateOrder(ctx, courier.ID, order.Number, "picked_up", order.Version, false)
			errors <- err
		}()
	}
	wait.Wait()
	close(errors)
	success := 0
	for err := range errors {
		if err == nil {
			success++
		} else {
			restaurantAccountsRequireError(t, err, "conflict")
		}
	}
	if success != 1 {
		t.Fatalf("expected one committed version, got %d", success)
	}
}
