package main

import (
	"context"
	"database/sql"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
)

func whatsappBindingFixture(t *testing.T) (*restaurantWhatsappBindings, restaurantWhatsappBindingChange, time.Time) {
	t.Helper()
	s, err := newRestaurantWhatsappBindings(context.Background(), restaurantIntegrationDB(t), "restaurant-fixture")
	if err != nil {
		t.Fatal(err)
	}
	s.db.SetMaxOpenConns(2)
	input := restaurantWhatsappBindingChange{RequestID: uuid.NewString(), Active: true, ConnectionID: "account-fixture", DeviceFingerprint: strings.Repeat("ab", 32)}
	return s, input, time.Date(2026, 10, 8, 9, 0, 0, 0, time.UTC)
}
func requireBinding(t *testing.T, s *restaurantWhatsappBindings, record restaurantWhatsappBindingRecord, fingerprint string, want bool) {
	t.Helper()
	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	scope := restaurantWhatsappScope{RestaurantID: s.tenant, Channel: "whatsapp_qr", ConnectionID: record.ConnectionID, Generation: record.Generation, PeerID: "customer-fixture"}
	err = s.RequireCurrent(context.Background(), tx, scope, fingerprint)
	if (err == nil) != want {
		t.Fatalf("current binding accepted=%v, want %v: %v", err == nil, want, err)
	}
}
func TestRestaurantWhatsappBindingDefaultDeniedAndDurableGeneration(t *testing.T) {
	s, input, now := whatsappBindingFixture(t)
	ctx := context.Background()
	if _, err := s.Change(ctx, input, now); err == nil {
		t.Fatal("default permission accepted")
	}
	s.authorizeChange = func(context.Context, *sql.Tx) bool { return false }
	if _, err := s.Change(ctx, input, now); err == nil {
		t.Fatal("denied permission accepted")
	}
	var count int
	if err := s.db.QueryRow(`SELECT count(*) FROM restaurant_whatsapp_bindings`).Scan(&count); err != nil || count != 0 {
		t.Fatal("denied write persisted", count, err)
	}
	s.authorizeChange = func(context.Context, *sql.Tx) bool { return true }
	first, err := s.Change(ctx, input, now)
	if err != nil {
		t.Fatal(err)
	}
	if first.Revision != 1 || first.Generation == "" || !first.Active {
		t.Fatal(first)
	}
	restarted, err := newRestaurantWhatsappBindings(ctx, s.db, s.tenant)
	if err != nil {
		t.Fatal(err)
	}
	requireBinding(t, restarted, first, input.DeviceFingerprint, true)
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	resolved, err := restarted.Resolve(ctx, tx, input.ConnectionID, input.DeviceFingerprint)
	tx.Rollback()
	if err != nil || resolved.Generation != first.Generation || resolved.RestaurantID != s.tenant {
		t.Fatal("restart resolution failed", resolved, err)
	}

	requireBinding(t, restarted, first, strings.Repeat("cd", 32), false)
	replay, err := s.Change(ctx, input, now.Add(time.Minute))
	if err != nil || replay != first {
		t.Fatal("retry changed generation", replay, err)
	}
	altered := input
	altered.ConnectionID = "another-account"
	if _, err := s.Change(ctx, altered, now); err == nil {
		t.Fatal("changed request reused id")
	}
	// Even rebinding the same provider identity is a new explicit binding epoch.
	next := input
	next.RequestID = uuid.NewString()
	next.ExpectedRevision = 1
	second, err := s.Change(ctx, next, now)
	if err != nil || second.Generation == first.Generation || second.Revision != 2 {
		t.Fatal(second, err)
	}
	requireBinding(t, s, first, input.DeviceFingerprint, false)
	requireBinding(t, s, second, input.DeviceFingerprint, true)
	if _, err := s.Change(ctx, input, now); err == nil {
		t.Fatal("old successful request revived stale binding")
	}
	revoke := restaurantWhatsappBindingChange{RequestID: uuid.NewString(), ExpectedRevision: 2}
	removed, err := s.Change(ctx, revoke, now)
	if err != nil || removed.Active || removed.Generation == second.Generation {
		t.Fatal(removed, err)
	}
	requireBinding(t, s, second, input.DeviceFingerprint, false)
	var audits int
	if err := s.db.QueryRow(`SELECT count(*) FROM restaurant_whatsapp_binding_changes`).Scan(&audits); err != nil || audits != 3 {
		t.Fatal(audits, err)
	}
}
func TestRestaurantWhatsappBindingConcurrentRetryAndReplacement(t *testing.T) {
	s, input, now := whatsappBindingFixture(t)
	s.authorizeChange = func(context.Context, *sql.Tx) bool { return true }
	const n = 12
	results := make(chan restaurantWhatsappBindingRecord, n)
	errs := make(chan error, n)
	var wg sync.WaitGroup
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); r, e := s.Change(context.Background(), input, now); results <- r; errs <- e }()
	}
	wg.Wait()
	close(results)
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	var generation string
	for r := range results {
		if r.Revision != 1 {
			t.Fatal(r)
		}
		if generation != "" && generation != r.Generation {
			t.Fatal("concurrent retry generated multiple epochs")
		}
		generation = r.Generation
	}
	successes := make(chan bool, n)
	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			change := input
			change.RequestID = uuid.NewString()
			change.ExpectedRevision = 1
			_, err := s.Change(context.Background(), change, now)
			successes <- err == nil
		}()
	}
	wg.Wait()
	close(successes)
	winners := 0
	for ok := range successes {
		if ok {
			winners++
		}
	}
	if winners != 1 {
		t.Fatal("CAS replacement winners", winners)
	}
}
func TestRestaurantWhatsappBindingRejectsWrongScopeAndMalformedChanges(t *testing.T) {
	s, input, now := whatsappBindingFixture(t)
	s.authorizeChange = func(context.Context, *sql.Tx) bool { return true }
	first, err := s.Change(context.Background(), input, now)
	if err != nil {
		t.Fatal(err)
	}
	good := restaurantWhatsappScope{RestaurantID: s.tenant, Channel: "whatsapp_qr", ConnectionID: first.ConnectionID, Generation: first.Generation, PeerID: "customer-fixture"}
	for _, mutate := range []func(*restaurantWhatsappScope){func(v *restaurantWhatsappScope) { v.RestaurantID = "other" }, func(v *restaurantWhatsappScope) { v.Channel = "whatsapp_cloud" }, func(v *restaurantWhatsappScope) { v.ConnectionID = "other" }, func(v *restaurantWhatsappScope) { v.Generation = uuid.NewString() }, func(v *restaurantWhatsappScope) { v.PeerID = "" }} {
		bad := good
		mutate(&bad)
		tx, e := s.db.Begin()
		if e != nil {
			t.Fatal(e)
		}
		e = s.RequireCurrent(context.Background(), tx, bad, input.DeviceFingerprint)
		tx.Rollback()
		if e == nil {
			t.Fatal("accepted foreign scope", bad)
		}
	}
	for _, mutate := range []func(*restaurantWhatsappBindingChange){func(v *restaurantWhatsappBindingChange) { v.RequestID = "bad" }, func(v *restaurantWhatsappBindingChange) { v.DeviceFingerprint = "phone" }, func(v *restaurantWhatsappBindingChange) { v.DeviceFingerprint = strings.Repeat("AB", 32) }, func(v *restaurantWhatsappBindingChange) { v.ConnectionID = " " }, func(v *restaurantWhatsappBindingChange) { v.ExpectedRevision = -1 }, func(v *restaurantWhatsappBindingChange) { v.Active = false }} {
		bad := input
		bad.RequestID = uuid.NewString()
		bad.ExpectedRevision = 1
		mutate(&bad)
		if _, err := s.Change(context.Background(), bad, now); err == nil {
			t.Fatal("accepted malformed change")
		}
	}
	requireBinding(t, s, first, input.DeviceFingerprint, true)
}

func TestRestaurantWhatsappBindingRevocationBlocksPendingOrder(t *testing.T) {
	for _, revoke := range []bool{false, true} {
		t.Run(map[bool]string{false: "current", true: "revoked"}[revoke], func(t *testing.T) {
			reviews, p, scope, input, now := whatsappReviewFixture(t)
			ctx := context.Background()
			bindings, err := newRestaurantWhatsappBindings(ctx, reviews.orders.store.db, scope.RestaurantID)
			if err != nil {
				t.Fatal(err)
			}
			bindings.authorizeChange = func(context.Context, *sql.Tx) bool { return true }
			change := restaurantWhatsappBindingChange{RequestID: uuid.NewString(), Active: true, ConnectionID: scope.ConnectionID, DeviceFingerprint: strings.Repeat("ab", 32)}
			binding, err := bindings.Change(ctx, change, now)
			if err != nil {
				t.Fatal(err)
			}
			scope.Generation = binding.Generation
			p, err = newRestaurantWhatsappProposal(scope, p.source, input.Items, now)
			if err != nil {
				t.Fatal(err)
			}
			reviews.orders.store.db.SetMaxOpenConns(2)
			reviews.authorizeDispatch = func(ctx context.Context, tx *sql.Tx, actual restaurantWhatsappScope) bool {
				return bindings.RequireCurrent(ctx, tx, actual, change.DeviceFingerprint) == nil
			}
			reviews.dispatchNow = func() time.Time { return now }
			if _, err = reviews.orders.SetOrderChannel(ctx, scope.Channel, "synthetic-owner", true, 1); err != nil {
				t.Fatal(err)
			}
			review, err := reviews.Prepare(ctx, p, scope, input, 0, now)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = reviews.Present(ctx, scope, review.ID, review.Fingerprint, "fixture-review", now); err != nil {
				t.Fatal(err)
			}
			if _, err = reviews.Decide(ctx, scope, restaurantWhatsappSource{MessageID: "fixture-confirm", SentAt: now}, review.ID, review.Fingerprint, "fixture-review", "confirmed", now); err != nil {
				t.Fatal(err)
			}
			if revoke {
				if _, err = bindings.Change(ctx, restaurantWhatsappBindingChange{RequestID: uuid.NewString(), ExpectedRevision: 1}, now); err != nil {
					t.Fatal(err)
				}
			}
			_, err = reviews.Dispatch(ctx, scope, review.ID)
			if revoke {
				restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
				restaurantAssertStock(t, reviews.orders, 4, 0)
			} else if err != nil {
				t.Fatal(err)
			} else {
				restaurantAssertStock(t, reviews.orders, 3, 1)
			}
			var count int
			if err = reviews.orders.store.db.QueryRow(`SELECT count(*) FROM restaurant_orders`).Scan(&count); err != nil {
				t.Fatal(err)
			}
			want := 1
			if revoke {
				want = 0
			}
			if count != want {
				t.Fatal("unexpected order count", count)
			}
		})
	}
}

func TestRestaurantWhatsappBindingRechecksChangeAuthorityAndReplayIntegrity(t *testing.T) {
	s, input, now := whatsappBindingFixture(t)
	checks := 0
	s.authorizeChange = func(context.Context, *sql.Tx) bool { checks++; return checks == 1 }
	if _, err := s.Change(context.Background(), input, now); err == nil {
		t.Fatal("revoked change authority accepted")
	}
	if checks != 2 {
		t.Fatal("authority was not rechecked after acquiring binding lock")
	}
	var count int
	if err := s.db.QueryRow(`SELECT count(*) FROM restaurant_whatsapp_bindings`).Scan(&count); err != nil || count != 0 {
		t.Fatal("revoked write persisted", count, err)
	}
	s.authorizeChange = func(context.Context, *sql.Tx) bool { return true }
	if _, err := s.Change(context.Background(), input, now); err != nil {
		t.Fatal(err)
	}
	// Do not turn a corrupt durable row into a successful idempotent response.
	if _, err := s.db.Exec(`UPDATE restaurant_whatsapp_bindings SET connection_id='altered-fixture'`); err != nil {
		t.Fatal(err)
	}
	_, err := s.Change(context.Background(), input, now)
	restaurantOrdersRequireError(t, err, "whatsapp_binding_inconsistent")
}

func TestRestaurantWhatsappBindingReplacementWaitsForCurrentTransaction(t *testing.T) {
	s, input, now := whatsappBindingFixture(t)
	s.authorizeChange = func(context.Context, *sql.Tx) bool { return true }
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	first, err := s.Change(ctx, input, now)
	if err != nil {
		t.Fatal(err)
	}
	held, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Rollback()
	scope := restaurantWhatsappScope{RestaurantID: s.tenant, Channel: "whatsapp_qr", ConnectionID: first.ConnectionID, Generation: first.Generation, PeerID: "fixture-peer"}
	if err = s.RequireCurrent(ctx, held, scope, input.DeviceFingerprint); err != nil {
		t.Fatal(err)
	}
	pidReady := make(chan int, 1)
	s.authorizeChange = func(ctx context.Context, tx *sql.Tx) bool {
		var pid int
		if tx.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid) != nil {
			return false
		}
		select {
		case pidReady <- pid:
		default:
		}
		return true
	}
	done := make(chan error, 1)
	go func() {
		_, e := s.Change(ctx, restaurantWhatsappBindingChange{RequestID: uuid.NewString(), ExpectedRevision: 1}, now)
		done <- e
	}()
	var pid int
	select {
	case pid = <-pidReady:
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	for {
		var waiting bool
		if err = held.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=$1 AND NOT granted)`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case err = <-done:
			t.Fatal("replacement escaped current transaction", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		default:
			time.Sleep(time.Millisecond)
		}
	}
	if err = held.Rollback(); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal(ctx.Err())
	}
	requireBinding(t, s, first, input.DeviceFingerprint, false)
}
