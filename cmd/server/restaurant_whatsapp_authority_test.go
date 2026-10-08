package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRestaurantWhatsappAuthorityDedicatedSignedScope(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	principal := uuid.NewString()
	now := time.Now().Truncate(time.Second)
	auth := &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: func() time.Time { return now }}
	bindings := &restaurantWhatsappBindings{db: new(sql.DB), tenant: "restaurant-a"}
	input := restaurantWhatsappDispatchRequest{RestaurantID: "restaurant-a", ConnectionID: "connection-fixture", Generation: uuid.NewString(), PeerID: "peer-fixture", DeviceFingerprint: strings.Repeat("ab", 32), ReviewID: "review-fixture"}
	makeRequest := func(scope string, mutate func(*platformRequestClaims)) (*http.Request, []byte) {
		r := platformTestRequest(t, private, principal, "POST", restaurantWhatsappDispatchPath, uuid.NewString(), scope, input, mutate)
		raw, e := io.ReadAll(r.Body)
		if e != nil {
			t.Fatal(e)
		}
		return r, raw
	}
	r, raw := makeRequest(restaurantWhatsappDispatchScope, nil)
	authority, err := newRestaurantWhatsappDispatchAuthority(auth, bindings, principal, r, raw)
	if err != nil {
		t.Fatal(err)
	}
	input.PeerID = "altered-peer"
	r.Header.Set("Authorization", "altered")
	for i := range raw {
		raw[i] = ' '
	}
	if authority.scope.PeerID != "peer-fixture" || authority.reviewID != "review-fixture" {
		t.Fatal("verified authority retained mutable request")
	}
	for name, mutate := range map[string]func(*platformRequestClaims){
		"staff principal":    func(c *platformRequestClaims) { c.Subject = uuid.NewString() },
		"staff scope":        func(c *platformRequestClaims) { c.Scope = "staff:channels:manage" },
		"audience":           func(c *platformRequestClaims) { c.Audience = "restaurant-b" },
		"expiry":             func(c *platformRequestClaims) { c.ExpiresAt = now.Unix() },
		"missing request id": func(c *platformRequestClaims) { c.IdempotencyKey = "" },
	} {
		t.Run(name, func(t *testing.T) {
			r, body := makeRequest(restaurantWhatsappDispatchScope, mutate)
			if _, e := newRestaurantWhatsappDispatchAuthority(auth, bindings, principal, r, body); e == nil {
				t.Fatal("accepted wrong operation authority")
			}
		})
	}
	for _, scope := range []string{"orders:write", "staff:channels:manage", "transport:whatsapp:read"} {
		r, body := makeRequest(scope, nil)
		if _, e := newRestaurantWhatsappDispatchAuthority(auth, bindings, principal, r, body); e == nil {
			t.Fatal("scope escalation", scope)
		}
	}
	for _, change := range []func(*restaurantWhatsappDispatchRequest){func(v *restaurantWhatsappDispatchRequest) { v.RestaurantID = "restaurant-b" }, func(v *restaurantWhatsappDispatchRequest) { v.Generation = "" }, func(v *restaurantWhatsappDispatchRequest) { v.DeviceFingerprint = "phone" }, func(v *restaurantWhatsappDispatchRequest) { v.ReviewID = "" }} {
		saved := input
		change(&input)
		r, body := makeRequest(restaurantWhatsappDispatchScope, nil)
		if _, e := newRestaurantWhatsappDispatchAuthority(auth, bindings, principal, r, body); e == nil {
			t.Fatal("accepted malformed operation")
		}
		input = saved
	}
	r, body := makeRequest(restaurantWhatsappDispatchScope, nil)
	body = append(body, ' ')
	if _, e := newRestaurantWhatsappDispatchAuthority(auth, bindings, principal, r, body); e == nil {
		t.Fatal("body tampering accepted")
	}
}

func TestRestaurantWhatsappAuthorityRechecksInsideOriginalOrderTransaction(t *testing.T) {
	for _, mode := range []string{"current", "expired-before-dispatch", "expired-before-create", "revoked-before-create", "expired-waiting-binding", "expired-waiting-review"} {
		t.Run(mode, func(t *testing.T) {
			reviews, p, scope, input, now := whatsappReviewFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			bindings, err := newRestaurantWhatsappBindings(ctx, reviews.orders.store.db, scope.RestaurantID)
			if err != nil {
				t.Fatal(err)
			}
			bindings.authorizeChange = func(context.Context, *sql.Tx) bool { return true }
			fingerprint := strings.Repeat("ab", 32)
			record, err := bindings.Change(ctx, restaurantWhatsappBindingChange{RequestID: uuid.NewString(), Active: true, ConnectionID: scope.ConnectionID, DeviceFingerprint: fingerprint}, now)
			if err != nil {
				t.Fatal(err)
			}
			scope.Generation = record.Generation
			p, err = newRestaurantWhatsappProposal(scope, p.source, input.Items, now)
			if err != nil {
				t.Fatal(err)
			}
			reviews.orders.store.db.SetMaxOpenConns(2)
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
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			principal := uuid.NewString()
			var clock atomic.Int64
			clock.Store(now.Unix())
			auth := &platformRequestAuth{issuer: "https://platform.example", tenantID: scope.RestaurantID, publicKey: public, now: func() time.Time { return time.Unix(clock.Load(), 0) }}
			request := restaurantWhatsappDispatchRequest{RestaurantID: scope.RestaurantID, ConnectionID: scope.ConnectionID, Generation: scope.Generation, PeerID: scope.PeerID, DeviceFingerprint: fingerprint, ReviewID: review.ID}
			r := platformTestRequest(t, private, principal, "POST", restaurantWhatsappDispatchPath, uuid.NewString(), restaurantWhatsappDispatchScope, request, func(c *platformRequestClaims) {
				c.Audience = scope.RestaurantID
				c.IssuedAt = now.Unix()
				c.ExpiresAt = now.Add(time.Minute).Unix()
			})
			raw, _ := json.Marshal(request)
			authority, err := newRestaurantWhatsappDispatchAuthority(auth, bindings, principal, r, raw)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "expired-before-dispatch" {
				clock.Add(61)
			}
			reviews.dispatchCreate = func(ctx context.Context, input restaurantOrderInput, owner, key string) (restaurantReceipt, error) {
				if mode == "expired-before-create" {
					clock.Add(61)
				}
				if mode == "revoked-before-create" {
					if _, e := bindings.Change(ctx, restaurantWhatsappBindingChange{RequestID: uuid.NewString(), ExpectedRevision: 1}, now); e != nil {
						return restaurantReceipt{}, e
					}
				}
				return reviews.orders.Create(ctx, input, owner, key)
			}
			var receipt restaurantReceipt
			if mode == "expired-waiting-binding" || mode == "expired-waiting-review" {
				held, e := bindings.db.BeginTx(ctx, nil)
				if e != nil {
					t.Fatal(e)
				}
				defer held.Rollback()
				lockQuery := `SELECT 1 FROM restaurant_whatsapp_bindings WHERE restaurant_id=$1 FOR UPDATE`
				lockID := scope.RestaurantID
				waitingQuery := "SELECT active,connection_id,generation,device_fingerprint FROM restaurant_whatsapp_bindings%"
				if mode == "expired-waiting-review" {
					lockQuery = `SELECT 1 FROM restaurant_whatsapp_review_heads WHERE scope_hash=$1 FOR UPDATE`
					lockID = restaurantWhatsappDigest(scope)
					waitingQuery = "SELECT version,review_id FROM restaurant_whatsapp_review_heads%"
				}
				if _, e = held.ExecContext(ctx, lockQuery, lockID); e != nil {
					t.Fatal(e)
				}
				result := make(chan error, 1)
				go func() { _, e := authority.Dispatch(ctx, reviews); result <- e }()
				for {
					// PostgreSQL statistics snapshots are cached for a transaction;
					// refresh before observing a waiter started after the first read.
					if _, e = held.ExecContext(ctx, `SELECT pg_stat_clear_snapshot()`); e != nil {
						t.Fatal(e)
					}
					var waiting bool
					e = held.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND datname=current_database() AND wait_event_type='Lock' AND query LIKE $1)`, waitingQuery).Scan(&waiting)
					if e != nil {
						t.Fatal(e)
					}
					if waiting {
						break
					}
					select {
					case e = <-result:
						t.Fatal("dispatch did not wait", e)
					case <-ctx.Done():
						t.Fatal(ctx.Err())
					default:
						time.Sleep(time.Millisecond)
					}
				}
				clock.Add(61)
				if e = held.Rollback(); e != nil {
					t.Fatal(e)
				}
				select {
				case err = <-result:
				case <-ctx.Done():
					t.Fatal(ctx.Err())
				}
			} else {
				receipt, err = authority.Dispatch(ctx, reviews)
			}
			if mode == "current" {
				if err != nil {
					t.Fatal(err)
				}
				replay, e := authority.Dispatch(ctx, reviews)
				if e != nil || replay.Order.Number != receipt.Order.Number {
					t.Fatal("operation replay duplicated order", e)
				}
				restaurantAssertStock(t, reviews.orders, 3, 1)
			} else {
				restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
				restaurantAssertStock(t, reviews.orders, 4, 0)
			}
			if reviews.authorizeDispatch != nil {
				t.Fatal("operation authority escaped into shared service")
			}
			var count int
			if e := reviews.orders.store.db.QueryRow(`SELECT count(*) FROM restaurant_orders`).Scan(&count); e != nil {
				t.Fatal(e)
			}
			want := 0
			if mode == "current" {
				want = 1
			}
			if count != want {
				t.Fatal("unexpected orders", count)
			}
		})
	}
}
