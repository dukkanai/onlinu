package main

import (
	"context"
	"math"
	"sync"
	"testing"
	"time"
)

func restaurantLocationTestInput(version int64) restaurantLocationInput {
	lat, lng, accuracy := 24.7136, 46.6753, 12.0
	return restaurantLocationInput{Latitude: &lat, Longitude: &lng, Accuracy: &accuracy, CapturedAt: time.Now().UTC().Truncate(time.Millisecond), Version: version}
}

func TestRestaurantLocationStopFencesConcurrentPublish(t *testing.T) {
	s, orders, _ := restaurantCourierFixture(t)
	ctx := context.Background()
	courier := restaurantCourierCreateTest(t, s, "location-race")
	receipt := restaurantCourierCreateOrder(t, orders)
	order, err := s.Assign(ctx, receipt.Order.Number, courier.ID, receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	for round := 0; round < 8; round++ {
		input := restaurantLocationTestInput(order.Version)
		var wg sync.WaitGroup
		wg.Add(2)
		start := make(chan struct{})
		var publishErr, stopErr error
		go func() {
			defer wg.Done()
			<-start
			_, publishErr = s.PublishLocation(ctx, courier.ID, order.Number, input)
		}()
		go func() { defer wg.Done(); <-start; stopErr = s.StopLocation(ctx, courier.ID, order.Number) }()
		close(start)
		wg.Wait()
		if stopErr != nil {
			t.Fatal(stopErr)
		}
		if publishErr != nil {
			restaurantAccountsRequireError(t, publishErr, "conflict")
		}
		point, err := s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
		if err != nil || point.Location != nil {
			t.Fatalf("location resurrected after concurrent stop: %v", err)
		}
		_, err = s.PublishLocation(ctx, courier.ID, order.Number, input)
		restaurantAccountsRequireError(t, err, "conflict")
		order, err = orders.Track(ctx, order.Number, receipt.TrackingToken, "", "")
		if err != nil {
			t.Fatal(err)
		}
	}
}
func TestRestaurantLocationValidation(t *testing.T) {
	now := time.Now().UTC()
	good := restaurantLocationTestInput(1)
	if err := validateRestaurantLocation(good, now); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*restaurantLocationInput){
		func(p *restaurantLocationInput) { p.Latitude = nil }, func(p *restaurantLocationInput) { p.Version = 0 },
		func(p *restaurantLocationInput) { v := math.NaN(); p.Longitude = &v }, func(p *restaurantLocationInput) { v := 91.0; p.Latitude = &v },
		func(p *restaurantLocationInput) { v := 5001.0; p.Accuracy = &v }, func(p *restaurantLocationInput) { p.CapturedAt = now.Add(-3 * time.Minute) },
		func(p *restaurantLocationInput) { p.CapturedAt = now.Add(time.Minute) },
	} {
		p := good
		change(&p)
		if validateRestaurantLocation(p, now) == nil {
			t.Fatal("unsafe point accepted")
		}
	}
}
func TestRestaurantLocationIsolationRevocationAndRetention(t *testing.T) {
	s, orders, db := restaurantCourierFixture(t)
	ctx := context.Background()
	a := restaurantCourierCreateTest(t, s, "location-a")
	b := restaurantCourierCreateTest(t, s, "location-b")
	receipt := restaurantCourierCreateOrder(t, orders)
	order, err := s.Assign(ctx, receipt.Order.Number, a.ID, receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantLocationTestInput(order.Version)
	_, err = s.PublishLocation(ctx, b.ID, order.Number, input)
	restaurantAccountsRequireError(t, err, "order_not_found")
	point, err := s.PublishLocation(ctx, a.ID, order.Number, input)
	if err != nil {
		t.Fatal(err)
	}
	_, err = s.Location(ctx, order.Number, "", "", false)
	restaurantAccountsRequireError(t, err, "invalid_order_access")
	_, err = s.Location(ctx, order.Number, "wrong", "another-customer", false)
	restaurantAccountsRequireError(t, err, "invalid_order_access")
	read, err := s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if err != nil || read.Location == nil {
		t.Fatalf("owner denied: %v", err)
	}
	read, err = s.Location(ctx, order.Number, "", "", true)
	if err != nil || read.Location == nil {
		t.Fatal("admin denied")
	}
	duplicate, err := s.PublishLocation(ctx, a.ID, order.Number, input)
	if err != nil || !duplicate.Location.ExpiresAt.Equal(point.Location.ExpiresAt) {
		t.Fatal("retry extends retention")
	}
	older := input
	older.CapturedAt = older.CapturedAt.Add(-time.Millisecond)
	_, err = s.PublishLocation(ctx, a.ID, order.Number, older)
	restaurantAccountsRequireError(t, err, "conflict")
	if _, err = db.ExecContext(ctx, `UPDATE restaurant_courier_locations SET received_at=now()-interval '60 seconds' WHERE order_number=$1`, order.Number); err != nil {
		t.Fatal(err)
	}
	read, err = s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if err != nil || read.Location == nil || !read.Location.Stale {
		t.Fatal("stale point not labelled")
	}
	if err = s.StopLocation(ctx, b.ID, order.Number); err != nil {
		t.Fatal(err)
	}
	read, _ = s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if read.Location == nil {
		t.Fatal("another courier stopped sharing")
	}
	order, err = s.Assign(ctx, order.Number, b.ID, order.Version)
	if err != nil {
		t.Fatal(err)
	}
	order, err = s.Assign(ctx, order.Number, a.ID, order.Version)
	if err != nil {
		t.Fatal(err)
	}
	read, _ = s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if read.Location != nil {
		t.Fatal("old location resurrected after reassignment")
	}
	input = restaurantLocationTestInput(order.Version)
	_, err = s.PublishLocation(ctx, a.ID, order.Number, input)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.StopLocation(ctx, a.ID, order.Number); err != nil {
		t.Fatal(err)
	}
	read, _ = s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if read.Location != nil {
		t.Fatal("stop left point visible")
	}
	_, err = s.PublishLocation(ctx, a.ID, order.Number, input)
	restaurantAccountsRequireError(t, err, "conflict")
	order, err = orders.Track(ctx, order.Number, receipt.TrackingToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	input.Version = order.Version
	_, err = s.PublishLocation(ctx, a.ID, order.Number, input)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `UPDATE restaurant_courier_locations SET expires_at=now()-interval '1 second' WHERE order_number=$1`, order.Number); err != nil {
		t.Fatal(err)
	}
	read, _ = s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if read.Location != nil {
		t.Fatal("expired point visible")
	}
	input.CapturedAt = input.CapturedAt.Add(time.Millisecond)
	_, err = s.PublishLocation(ctx, a.ID, order.Number, input)
	if err != nil {
		t.Fatal(err)
	}
	active := false
	if _, err = s.Update(ctx, a.ID, restaurantCourierAdminUpdate{Active: &active}); err != nil {
		t.Fatal(err)
	}
	read, _ = s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if read.Location != nil {
		t.Fatal("deactivated courier remains visible")
	}
	active = true
	if _, err = s.Update(ctx, a.ID, restaurantCourierAdminUpdate{Active: &active}); err != nil {
		t.Fatal(err)
	}
	input.CapturedAt = input.CapturedAt.Add(time.Millisecond)
	_, err = s.PublishLocation(ctx, a.ID, order.Number, input)
	if err != nil {
		t.Fatal(err)
	}
	order, err = orders.SetStatus(ctx, order.Number, "cancelled", order.Version)
	if err != nil {
		t.Fatal(err)
	}
	read, _ = s.Location(ctx, order.Number, receipt.TrackingToken, "", false)
	if read.Location != nil {
		t.Fatal("terminal location visible")
	}
	_, err = s.PublishLocation(ctx, a.ID, order.Number, restaurantLocationTestInput(order.Version))
	restaurantAccountsRequireError(t, err, "order_not_found")
	var count int
	if err = db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_courier_locations`).Scan(&count); err != nil || count != 0 {
		t.Fatal("revoked location retained")
	}
}
