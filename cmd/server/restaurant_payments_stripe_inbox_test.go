package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

// These tests use only isolated PostgreSQL schemas and synthetic in-process
// adapters. A valid signature is a durable refresh hint, never payment evidence.
func restaurantStripeInboxFixture(t *testing.T) (*restaurantPayments, restaurantReceipt, restaurantPaymentView, restaurantPaymentConfig, *atomic.Int32) {
	t.Helper()
	p, receipt := restaurantPaymentFixture(t)
	calls := &atomic.Int32{}
	p.adapter = &restaurantPaymentFakeAdapter{
		create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			return restaurantPaymentRemote{ID: "cs_test_inbox", URL: "https://checkout.stripe.com/c/pay/cs_test_inbox"}, nil
		},
		fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
			calls.Add(1)
			return restaurantPaymentRemote{ID: id, Reference: ref, Status: "pending", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
		},
	}
	v, err := p.Start(context.Background(), receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil || v.Status != "pending" {
		t.Fatalf("synthetic start failed: %+v %v", v, err)
	}
	cfg, err := p.config(context.Background(), "stripe")
	if err != nil || cfg.Secrets["webhookSecret"] == "" || cfg.Values["sandboxGeneration"] == "" || cfg.Values["accountID"] == "" {
		t.Fatal("fixture has no complete synthetic sandbox configuration")
	}
	return p, receipt, v, cfg, calls
}

func restaurantStripeInboxEvent(t *testing.T, id, kind, objectID, attemptID string, created int64) []byte {
	t.Helper()
	object := "checkout.session"
	if strings.HasPrefix(kind, "payment_intent.") {
		object = "payment_intent"
	} else if strings.HasPrefix(kind, "charge.") {
		object = "charge"
	}
	obj := map[string]any{"id": objectID, "object": object, "livemode": false}
	if attemptID != "" {
		obj["metadata"] = map[string]string{"restaurant_attempt": attemptID}
	}
	raw, err := json.Marshal(map[string]any{
		"id": id, "object": "event", "type": kind, "api_version": restaurantStripeAPIVersion,
		"livemode": false, "created": created, "data": map[string]any{"object": obj},
	})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func restaurantStripeInboxSign(raw []byte, cfg restaurantPaymentConfig, now time.Time) string {
	return restaurantStripeSyntheticSignature(raw, strconv.FormatInt(now.Unix(), 10), cfg.Secrets["webhookSecret"])
}

func restaurantStripeInboxReceive(t *testing.T, p *restaurantPayments, cfg restaurantPaymentConfig, raw []byte, now time.Time) {
	t.Helper()
	if err := p.receiveStripeWebhook(context.Background(), raw, restaurantStripeInboxSign(raw, cfg, now), now); err != nil {
		t.Fatalf("signed synthetic event failed: %v", err)
	}
}

func restaurantStripeInboxQueue(t *testing.T, p *restaurantPayments, attempt string, wantDirty bool, wantVersion int64) {
	t.Helper()
	var dirty bool
	var version int64
	if err := p.db.QueryRowContext(context.Background(), `SELECT needs_refresh,refresh_version FROM restaurant_payment_attempts WHERE id=$1`, attempt).Scan(&dirty, &version); err != nil || dirty != wantDirty || version != wantVersion {
		t.Fatalf("refresh work: dirty=%v version=%d, wanted %v/%d: %v", dirty, version, wantDirty, wantVersion, err)
	}
}

func restaurantStripeInboxCount(t *testing.T, p *restaurantPayments, want int) {
	t.Helper()
	var count int
	if err := p.db.QueryRowContext(context.Background(), `SELECT count(*) FROM restaurant_stripe_webhook_receipts`).Scan(&count); err != nil || count != want {
		t.Fatalf("receipt count=%d, wanted %d: %v", count, want, err)
	}
}

func restaurantStripeInboxState(t *testing.T, p *restaurantPayments, id string) string {
	t.Helper()
	var state string
	if err := p.db.QueryRowContext(context.Background(), `SELECT state FROM restaurant_stripe_webhook_receipts WHERE event_id=$1`, id).Scan(&state); err != nil {
		t.Fatal(err)
	}
	return state
}

func restaurantStripeInboxMakeDue(t *testing.T, p *restaurantPayments) {
	t.Helper()
	if _, err := p.db.ExecContext(context.Background(), `UPDATE restaurant_stripe_webhook_receipts SET next_lookup_at=now()-interval '1 second' WHERE state='pending'`); err != nil {
		t.Fatal(err)
	}
}

func restaurantStripeInboxReplaceConfig(t *testing.T, p *restaurantPayments, cfg restaurantPaymentConfig) {
	t.Helper()
	sealed, err := p.encrypt("config:stripe", cfg)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.ExecContext(context.Background(), `UPDATE restaurant_payment_configs SET sealed=$1 WHERE provider='stripe'`, sealed); err != nil {
		t.Fatal(err)
	}
}

func TestRestaurantStripeInboxHTTPAuthenticatesExactBoundedBody(t *testing.T) {
	p, receipt, v, cfg, calls := restaurantStripeInboxFixture(t)
	s := &server{payments: p}
	pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
	s.registerRestaurantPaymentHandlers(pub, admin, hooks)
	now := time.Now().UTC()
	raw := restaurantStripeInboxEvent(t, "evt_http_synthetic", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 1)
	signature := restaurantStripeInboxSign(raw, cfg, now)
	change := func(old, replacement string) []byte { return bytes.Replace(raw, []byte(old), []byte(replacement), 1) }
	for _, tc := range []struct {
		name   string
		body   []byte
		header string
		status int
	}{
		{"unsigned", raw, "", 400},
		{"tampered whitespace", append(append([]byte{}, raw...), ' '), signature, 400},
		{"wrong secret", raw, restaurantStripeSyntheticSignature(raw, strconv.FormatInt(now.Unix(), 10), "whsec_wrong_synthetic"), 400},
		{"stale delivery", raw, restaurantStripeInboxSign(raw, cfg, now.Add(-6*time.Minute)), 400},
		{"future delivery", raw, restaurantStripeInboxSign(raw, cfg, now.Add(6*time.Minute)), 400},
		{"live event", change(`"livemode":false,"object":"event"`, `"livemode":true,"object":"event"`), "sign", 400},
		{"live object", change(`"livemode":false`, `"livemode":true`), "sign", 400},
		{"foreign account", change(`"object":"event"`, `"object":"event","account":"acct_foreign_synthetic"`), "sign", 400},
		{"organization context", change(`"object":"event"`, `"object":"event","context":"acct_foreign_synthetic"`), "sign", 400},
		{"wrong API version", change(restaurantStripeAPIVersion, "2000-01-01"), "sign", 400},
		{"missing API version", change(`"api_version":"`+restaurantStripeAPIVersion+`",`, ""), "sign", 400},
		{"wrong object type", change(`"object":"checkout.session"`, `"object":"charge"`), "sign", 400},
		{"missing object mode", change(`"id":"cs_test_inbox","livemode":false,`, `"id":"cs_test_inbox",`), "sign", 400},
		{"malformed JSON", []byte(`{"id":`), "sign", 400},
		{"second JSON value", append(append([]byte{}, raw...), []byte(` {}`)...), "sign", 400},
		{"body limit", []byte(strings.Repeat("x", 256*1024+1)), "sign", 413},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.header == "sign" {
				tc.header = restaurantStripeInboxSign(tc.body, cfg, now)
			}
			req := httptest.NewRequest(http.MethodPost, "/payment-hooks/stripe", bytes.NewReader(tc.body))
			req.Header.Set("Stripe-Signature", tc.header)
			w := httptest.NewRecorder()
			hooks.ServeHTTP(w, req)
			if w.Code != tc.status {
				t.Fatalf("rejection status=%d, wanted %d: %s", w.Code, tc.status, w.Body.String())
			}
			restaurantStripeInboxCount(t, p, 0)
			restaurantStripeInboxQueue(t, p, v.AttemptID, false, 0)
			if calls.Load() != 0 || strings.Contains(w.Body.String(), cfg.Secrets["webhookSecret"]) {
				t.Fatal("rejected delivery called provider or exposed signing secret")
			}
		})
	}
	// The account route accepts exact signed whitespace; a JSON re-encoding is
	// not the signed body. Persist no customer/status payload from this event.
	payload := bytes.Replace(raw, []byte(`"object":"checkout.session"`), []byte(`"object":"checkout.session","payment_status":"paid","amount_total":1,"customer_email":"inbox_synthetic_private_payload@example.invalid"`), 1)
	payload = append(append([]byte(" \n"), payload...), []byte("\n ")...)
	req := httptest.NewRequest(http.MethodPost, "/payment-hooks/stripe", bytes.NewReader(payload))
	req.Header.Set("Stripe-Signature", restaurantStripeInboxSign(payload, cfg, now))
	w := httptest.NewRecorder()
	hooks.ServeHTTP(w, req)
	if w.Code != http.StatusOK || calls.Load() != 0 {
		t.Fatalf("signed webhook was not a local durable enqueue: %d, provider reads=%d", w.Code, calls.Load())
	}
	restaurantStripeInboxCount(t, p, 1)
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 1)
	var stored string
	if err := p.db.QueryRowContext(context.Background(), `SELECT row_to_json(r)::text FROM restaurant_stripe_webhook_receipts r WHERE event_id='evt_http_synthetic'`).Scan(&stored); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(stored, "inbox_synthetic_private_payload") || strings.Contains(stored, "payment_status") || strings.Contains(stored, cfg.Secrets["webhookSecret"]) || !strings.Contains(stored, "body_hash") {
		t.Fatal("receipt retained customer/status payload or omitted content fingerprint")
	}
	order, err := p.orders.Track(context.Background(), receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "pending" {
		t.Fatal("webhook payload settled order")
	}
	// Neither HTTP nor direct callers can bypass authentication using an ID.
	req = httptest.NewRequest(http.MethodPost, "/payment-hooks/stripe/"+v.AttemptID, strings.NewReader(`{"status":"paid"}`))
	w = httptest.NewRecorder()
	hooks.ServeHTTP(w, req)
	if w.Code != http.StatusNotFound {
		t.Fatalf("legacy unsigned Stripe path is open: %d", w.Code)
	}
	var apiErr *restaurantError
	if err := p.Hook(context.Background(), "stripe", v.AttemptID); !errors.As(err, &apiErr) || apiErr.Status != http.StatusNotFound {
		t.Fatal("direct legacy Hook accepts Stripe")
	}
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 1)
	unknown := restaurantStripeInboxEvent(t, "evt_ignored_synthetic", "checkout.session.synthetic_unknown", "cs_test_inbox", v.AttemptID, 1)
	restaurantStripeInboxReceive(t, p, cfg, unknown, now)
	restaurantStripeInboxCount(t, p, 1)
	if calls.Load() != 0 {
		t.Fatal("HTTP webhook called provider")
	}
}

func TestRestaurantStripeInboxConcurrentDuplicateRestartAndEventOrdering(t *testing.T) {
	p, _, v, cfg, calls := restaurantStripeInboxFixture(t)
	now := time.Now().UTC()
	raw := restaurantStripeInboxEvent(t, "evt_duplicate_synthetic", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 100)
	const deliveries = 16
	results := make(chan error, deliveries)
	var wg sync.WaitGroup
	for i := 0; i < deliveries; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			results <- p.receiveStripeWebhook(context.Background(), raw, restaurantStripeInboxSign(raw, cfg, now), now)
		}()
	}
	wg.Wait()
	close(results)
	for err := range results {
		if err != nil {
			t.Fatalf("concurrent duplicate rejected: %v", err)
		}
	}
	restaurantStripeInboxCount(t, p, 1)
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 1)
	reopened, err := newRestaurantPayments(context.Background(), p.db, p.orders, p.baseURL)
	if err != nil {
		t.Fatal(err)
	}
	reopened.adapter = p.adapter
	// Simulate a lost acknowledgement and redelivery signed freshly much later.
	restaurantStripeInboxReceive(t, reopened, cfg, raw, now.Add(24*time.Hour))
	restaurantStripeInboxCount(t, reopened, 1)
	restaurantStripeInboxQueue(t, reopened, v.AttemptID, true, 1)
	changed := bytes.Replace(raw, []byte(`"created":100`), []byte(`"created":99`), 1)
	var apiErr *restaurantError
	if err := reopened.receiveStripeWebhook(context.Background(), changed, restaurantStripeInboxSign(changed, cfg, now), now); !errors.As(err, &apiErr) || apiErr.Status != http.StatusBadRequest {
		t.Fatal("same event ID with changed body did not fail closed")
	}
	restaurantStripeInboxCount(t, reopened, 1)
	restaurantStripeInboxQueue(t, reopened, v.AttemptID, true, 1)
	for i, created := range []int64{200, 50} {
		other := restaurantStripeInboxEvent(t, "evt_distinct_synthetic_"+strconv.Itoa(i), "checkout.session.expired", "cs_test_inbox", v.AttemptID, created)
		restaurantStripeInboxReceive(t, reopened, cfg, other, now)
	}
	restaurantStripeInboxCount(t, reopened, 3)
	restaurantStripeInboxQueue(t, reopened, v.AttemptID, true, 3)
	if calls.Load() != 0 {
		t.Fatal("receipt insertion/deduplication called a provider")
	}
}

func TestRestaurantStripeInboxBeforeCreateResponseSurvivesRestart(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cfg, err := p.config(ctx, "stripe")
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan restaurantPaymentRequest, 1)
	release := make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var creates, fetches atomic.Int32
	p.adapter = &restaurantPaymentFakeAdapter{
		create: func(ctx context.Context, _ restaurantPaymentConfig, req restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			creates.Add(1)
			started <- req
			select {
			case <-release:
				return restaurantPaymentRemote{ID: "cs_test_early", URL: "https://checkout.stripe.com/c/pay/cs_test_early"}, nil
			case <-ctx.Done():
				return restaurantPaymentRemote{}, ctx.Err()
			}
		},
		fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
			fetches.Add(1)
			return restaurantPaymentRemote{ID: id, Reference: ref, Status: "paid", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
		},
	}
	type startResult struct {
		v   restaurantPaymentView
		err error
	}
	done := make(chan startResult, 1)
	go func() {
		v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
		done <- startResult{v, err}
	}()
	var request restaurantPaymentRequest
	select {
	case request = <-started:
	case <-ctx.Done():
		t.Fatal("create did not reach controlled in-flight request")
	}
	now := time.Now().UTC()
	raw := restaurantStripeInboxEvent(t, "evt_before_create_synthetic", "checkout.session.completed", "cs_test_early", request.AttemptID, 1)
	restaurantStripeInboxReceive(t, p, cfg, raw, now)
	if state := restaurantStripeInboxState(t, p, "evt_before_create_synthetic"); state != "pending" {
		t.Fatalf("unbound session was not retained: %s", state)
	}
	restaurantStripeInboxQueue(t, p, request.AttemptID, false, 0)
	var remote string
	if err := p.db.QueryRowContext(ctx, `SELECT remote_id FROM restaurant_payment_attempts WHERE id=$1`, request.AttemptID).Scan(&remote); err != nil || remote != "" {
		t.Fatal("event metadata bound the unconfirmed create")
	}
	reopened, err := newRestaurantPayments(ctx, p.db, p.orders, p.baseURL)
	if err != nil {
		t.Fatal(err)
	}
	reopened.adapter = p.adapter
	restaurantStripeInboxReceive(t, reopened, cfg, raw, now)
	restaurantStripeInboxMakeDue(t, reopened)
	if err := reopened.resolveStripeWebhookReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxQueue(t, reopened, request.AttemptID, false, 0)
	if state := restaurantStripeInboxState(t, reopened, "evt_before_create_synthetic"); state != "pending" {
		t.Fatalf("local retry dropped unresolved in-flight create: %s", state)
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case result := <-done:
		if result.err != nil || result.v.AttemptID != request.AttemptID || result.v.Status != "pending" {
			t.Fatalf("create response persistence failed: %+v %v", result.v, result.err)
		}
	case <-ctx.Done():
		t.Fatal("create did not finish")
	}
	restaurantStripeInboxMakeDue(t, reopened)
	if err := reopened.resolveStripeWebhookReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	if state := restaurantStripeInboxState(t, reopened, "evt_before_create_synthetic"); state != "enqueued" {
		t.Fatalf("persisted create did not resolve durable receipt: %s", state)
	}
	restaurantStripeInboxQueue(t, reopened, request.AttemptID, true, 1)
	if creates.Load() != 1 || fetches.Load() != 0 {
		t.Fatal("local resolution made a provider call")
	}
	if err := reopened.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxQueue(t, reopened, request.AttemptID, false, 1)
	if creates.Load() != 1 || fetches.Load() != 1 {
		t.Fatal("recovery recreated payment or did not query authoritative session")
	}
}

func TestRestaurantStripeInboxConflictingHintsCannotQueueAnotherAttempt(t *testing.T) {
	p, _, first, cfg, calls := restaurantStripeInboxFixture(t)
	ctx := context.Background()
	secondReceipt, err := p.orders.Create(ctx, restaurantOrderFixtureInput("pickup"), "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	fake := p.adapter.(*restaurantPaymentFakeAdapter)
	fake.create = func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		return restaurantPaymentRemote{ID: "cs_test_second_inbox", URL: "https://checkout.stripe.com/c/pay/cs_test_second_inbox"}, nil
	}
	second, err := p.Start(ctx, secondReceipt.Order.Number, secondReceipt.TrackingToken, "", "stripe")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ id, object, hint string }{
		{"evt_conflict_other_attempt", "cs_test_inbox", second.AttemptID},
		{"evt_conflict_unknown_hint", "cs_test_inbox", uuid.NewString()},
		{"evt_conflict_wrong_session", "cs_test_unknown", first.AttemptID},
	} {
		raw := restaurantStripeInboxEvent(t, tc.id, "checkout.session.completed", tc.object, tc.hint, 1)
		restaurantStripeInboxReceive(t, p, cfg, raw, time.Now().UTC())
		if state := restaurantStripeInboxState(t, p, tc.id); state != "rejected" {
			t.Fatalf("conflicting object/hint was not rejected: %s", state)
		}
		restaurantStripeInboxQueue(t, p, first.AttemptID, false, 0)
		restaurantStripeInboxQueue(t, p, second.AttemptID, false, 0)
	}
	// A persisted session is enough without metadata; metadata is not mandatory.
	raw := restaurantStripeInboxEvent(t, "evt_without_hint", "checkout.session.completed", "cs_test_inbox", "", 1)
	restaurantStripeInboxReceive(t, p, cfg, raw, time.Now().UTC())
	restaurantStripeInboxQueue(t, p, first.AttemptID, true, 1)
	restaurantStripeInboxQueue(t, p, second.AttemptID, false, 0)
	if calls.Load() != 0 {
		t.Fatal("hint routing called a provider")
	}
}

func TestRestaurantStripeInboxAttemptAccountAndGenerationIsolation(t *testing.T) {
	for _, field := range []string{"accountID", "sandboxGeneration"} {
		t.Run(field, func(t *testing.T) {
			p, _, v, cfg, calls := restaurantStripeInboxFixture(t)
			if field == "accountID" {
				cfg.Values[field] = "acct_differentSynthetic"
			} else {
				cfg.Values[field] = uuid.NewString()
			}
			// Test a separately encrypted active configuration after replacement;
			// the already committed attempt retains its original account snapshot.
			restaurantStripeInboxReplaceConfig(t, p, cfg)
			raw := restaurantStripeInboxEvent(t, "evt_different_boundary", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 1)
			restaurantStripeInboxReceive(t, p, cfg, raw, time.Now().UTC())
			if state := restaurantStripeInboxState(t, p, "evt_different_boundary"); state != "rejected" {
				t.Fatalf("old-snapshot attempt crossed %s boundary: %s", field, state)
			}
			restaurantStripeInboxQueue(t, p, v.AttemptID, false, 0)
			if calls.Load() != 0 {
				t.Fatal("wrong-boundary event reached provider")
			}
		})
	}
}

func TestRestaurantStripeInboxNonSessionMetadataNeedsAuthoritativeIdentity(t *testing.T) {
	p, receipt, v, cfg, calls := restaurantStripeInboxFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	for _, tc := range []struct{ id, kind, object string }{
		{"evt_unknown_intent", "payment_intent.succeeded", "pi_synthetic_authoritative"},
		{"evt_unknown_charge", "charge.refunded", "ch_synthetic_authoritative"},
	} {
		raw := restaurantStripeInboxEvent(t, tc.id, tc.kind, tc.object, v.AttemptID, 1)
		restaurantStripeInboxReceive(t, p, cfg, raw, now)
		if state := restaurantStripeInboxState(t, p, tc.id); state != "pending" {
			t.Fatalf("unmapped event should wait for authoritative identity: %s", state)
		}
		restaurantStripeInboxQueue(t, p, v.AttemptID, false, 0)
	}
	var intent, charge string
	if err := p.db.QueryRowContext(ctx, `SELECT stripe_intent_id,stripe_charge_id FROM restaurant_payment_attempts WHERE id=$1`, v.AttemptID).Scan(&intent, &charge); err != nil || intent != "" || charge != "" {
		t.Fatal("event metadata invented authoritative intent/charge identities")
	}
	fake := p.adapter.(*restaurantPaymentFakeAdapter)
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls.Add(1)
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: "paid", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor, StripeIntentID: "pi_synthetic_authoritative", StripeChargeID: "ch_synthetic_authoritative"}, nil
	}
	if _, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, ""); err != nil {
		t.Fatal(err)
	}
	if err := p.db.QueryRowContext(ctx, `SELECT stripe_intent_id,stripe_charge_id FROM restaurant_payment_attempts WHERE id=$1`, v.AttemptID).Scan(&intent, &charge); err != nil || intent != "pi_synthetic_authoritative" || charge != "ch_synthetic_authoritative" {
		t.Fatalf("authoritative fetch did not learn identities: %s/%s %v", intent, charge, err)
	}
	restaurantStripeInboxMakeDue(t, p)
	if err := p.resolveStripeWebhookReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 2)
	if calls.Load() != 1 || restaurantStripeInboxState(t, p, "evt_unknown_intent") != "enqueued" || restaurantStripeInboxState(t, p, "evt_unknown_charge") != "enqueued" {
		t.Fatal("known identity resolution failed or called provider")
	}
	// Once bound, a different signed charge ID plus matching metadata still
	// cannot replace the known charge or queue that attempt.
	wrong := restaurantStripeInboxEvent(t, "evt_wrong_bound_charge", "charge.updated", "ch_synthetic_other", v.AttemptID, 1)
	restaurantStripeInboxReceive(t, p, cfg, wrong, now)
	if restaurantStripeInboxState(t, p, "evt_wrong_bound_charge") != "rejected" {
		t.Fatal("foreign charge metadata overrode known identity")
	}
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 2)
	for i := 0; i < 2; i++ {
		updated := restaurantStripeInboxEvent(t, "evt_charge_update_"+strconv.Itoa(i), "charge.updated", "ch_synthetic_authoritative", "", int64(100-i))
		restaurantStripeInboxReceive(t, p, cfg, updated, now)
	}
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 4)
}

func TestRestaurantStripeInboxReceiptAndRefreshRollbackTogether(t *testing.T) {
	p, _, v, cfg, calls := restaurantStripeInboxFixture(t)
	ctx := context.Background()
	// A synthetic database fault after receipt insertion must roll back both
	// receipt and queue state, so the provider can redeliver safely.
	if _, err := p.db.ExecContext(ctx, `CREATE FUNCTION stripe_inbox_test_reject_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic enqueue failure'; END $$;
 CREATE TRIGGER stripe_inbox_test_reject_enqueue BEFORE UPDATE OF needs_refresh ON restaurant_payment_attempts FOR EACH ROW EXECUTE FUNCTION stripe_inbox_test_reject_enqueue()`); err != nil {
		t.Fatal(err)
	}
	now := time.Now().UTC()
	raw := restaurantStripeInboxEvent(t, "evt_rollback_synthetic", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 1)
	if err := p.receiveStripeWebhook(ctx, raw, restaurantStripeInboxSign(raw, cfg, now), now); err == nil {
		t.Fatal("failed enqueue was acknowledged")
	}
	restaurantStripeInboxCount(t, p, 0)
	restaurantStripeInboxQueue(t, p, v.AttemptID, false, 0)
	if _, err := p.db.ExecContext(ctx, `DROP TRIGGER stripe_inbox_test_reject_enqueue ON restaurant_payment_attempts; DROP FUNCTION stripe_inbox_test_reject_enqueue()`); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxReceive(t, p, cfg, raw, now)
	restaurantStripeInboxCount(t, p, 1)
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 1)
	if calls.Load() != 0 {
		t.Fatal("receipt transaction reached provider")
	}
}

func TestRestaurantStripeInboxProviderOutageAndConcurrentGenerationSurvive(t *testing.T) {
	p, receipt, v, cfg, calls := restaurantStripeInboxFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	raw := restaurantStripeInboxEvent(t, "evt_before_outage", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 1)
	restaurantStripeInboxReceive(t, p, cfg, raw, now)
	fake := p.adapter.(*restaurantPaymentFakeAdapter)
	fake.fetch = func(context.Context, restaurantPaymentConfig, string, string) (restaurantPaymentRemote, error) {
		calls.Add(1)
		return restaurantPaymentRemote{}, errors.New("synthetic provider outage")
	}
	if err := p.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxQueue(t, p, v.AttemptID, true, 1)
	if calls.Load() != 1 {
		t.Fatal("worker did not attempt provider read")
	}
	if err := p.Reconcile(ctx); err != nil || calls.Load() != 1 {
		t.Fatal("outage retry bypassed durable cooldown")
	}
	reopened, err := newRestaurantPayments(ctx, p.db, p.orders, p.baseURL)
	if err != nil {
		t.Fatal(err)
	}
	reopened.adapter = fake
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '31 seconds' WHERE id=$1`, v.AttemptID); err != nil {
		t.Fatal(err)
	}
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls.Add(1)
		newer := restaurantStripeInboxEvent(t, "evt_during_fetch", "checkout.session.expired", id, ref, 0)
		restaurantStripeInboxReceive(t, reopened, cfg, newer, time.Now().UTC())
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: "paid", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
	}
	if err := reopened.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxQueue(t, reopened, v.AttemptID, true, 2)
	if calls.Load() != 2 {
		t.Fatal("restarted worker did not fetch exactly once")
	}
	order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "paid" {
		t.Fatal("signed expired payload overrode authoritative paid result")
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '31 seconds' WHERE id=$1`, v.AttemptID); err != nil {
		t.Fatal(err)
	}
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls.Add(1)
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: "refunded", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
	}
	if err := reopened.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxQueue(t, reopened, v.AttemptID, false, 2)
	old := restaurantStripeInboxEvent(t, "evt_completed_after_refund", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 1)
	restaurantStripeInboxReceive(t, reopened, cfg, old, time.Now().UTC())
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '31 seconds' WHERE id=$1`, v.AttemptID); err != nil {
		t.Fatal(err)
	}
	if err := reopened.Reconcile(ctx); err != nil {
		t.Fatal(err)
	}
	order, err = p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "refunded" || calls.Load() != 4 {
		t.Fatal("old completed event erased provider-confirmed refund")
	}
	restaurantStripeInboxQueue(t, reopened, v.AttemptID, false, 3)
}

func TestRestaurantStripeInboxStalePreCreateSnapshotDoesNotClearBoundWork(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	cfg, err := p.config(ctx, "stripe")
	if err != nil {
		t.Fatal(err)
	}
	var stale restaurantPaymentAttempt
	var calls int
	p.adapter = &restaurantPaymentFakeAdapter{
		create: func(_ context.Context, _ restaurantPaymentConfig, req restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			var err error
			stale, err = p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1`, req.AttemptID))
			if err != nil {
				return restaurantPaymentRemote{}, err
			}
			return restaurantPaymentRemote{ID: "cs_test_stale_snapshot", URL: "https://checkout.stripe.com/c/pay/cs_test_stale_snapshot"}, nil
		},
		fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
			calls++
			if id != "cs_test_stale_snapshot" || ref != stale.ID {
				t.Fatal("worker fetched invented or stale provider identity")
			}
			return restaurantPaymentRemote{ID: id, Reference: ref, Status: "paid", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
		},
	}
	v, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil || stale.RemoteID != "" || stale.ID != v.AttemptID {
		t.Fatal("controlled pre-create snapshot was not captured")
	}
	raw := restaurantStripeInboxEvent(t, "evt_after_stale_snapshot", "checkout.session.completed", "cs_test_stale_snapshot", v.AttemptID, 1)
	restaurantStripeInboxReceive(t, p, cfg, raw, time.Now().UTC())
	got, err := p.refreshAttemptAfter(ctx, stale, 30*time.Second)
	if err != nil || got.Status != "paid" || calls != 1 {
		t.Fatalf("stale empty snapshot erased bound work: status=%s calls=%d err=%v", got.Status, calls, err)
	}
	restaurantStripeInboxQueue(t, p, v.AttemptID, false, 1)
}

func TestRestaurantStripeInboxMissingEndpointConfigurationFailsClosed(t *testing.T) {
	for _, field := range []string{"webhookSecret", "accountID", "sandboxGeneration", "liveMode", "liveKey"} {
		t.Run(field, func(t *testing.T) {
			p, _, v, cfg, calls := restaurantStripeInboxFixture(t)
			now := time.Now().UTC()
			raw := restaurantStripeInboxEvent(t, "evt_invalid_config", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 1)
			signature := restaurantStripeInboxSign(raw, cfg, now)
			switch field {
			case "webhookSecret":
				delete(cfg.Secrets, field)
			case "liveMode":
				cfg.Mode = "live"
			case "liveKey":
				cfg.Secrets["secretKey"] = "rk_live_syntheticOnly"
			default:
				delete(cfg.Values, field)
			}
			restaurantStripeInboxReplaceConfig(t, p, cfg)
			s := &server{payments: p}
			pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
			s.registerRestaurantPaymentHandlers(pub, admin, hooks)
			r := httptest.NewRequest(http.MethodPost, "/payment-hooks/stripe", bytes.NewReader(raw))
			r.Header.Set("Stripe-Signature", signature)
			w := httptest.NewRecorder()
			hooks.ServeHTTP(w, r)
			if w.Code < 400 || w.Code > 599 {
				t.Fatalf("invalid endpoint configuration accepted: %d", w.Code)
			}
			restaurantStripeInboxCount(t, p, 0)
			restaurantStripeInboxQueue(t, p, v.AttemptID, false, 0)
			if calls.Load() != 0 {
				t.Fatal("invalid endpoint configuration called provider")
			}
		})
	}
}

func TestRestaurantStripeInboxUnresolvedLookupIsBoundedAndBacksOff(t *testing.T) {
	p, _, v, cfg, calls := restaurantStripeInboxFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	for i := 0; i < 40; i++ {
		raw := restaurantStripeInboxEvent(t, "evt_unrelated_"+strconv.Itoa(i), "checkout.session.completed", "cs_test_unrelated_"+strconv.Itoa(i), "", 1)
		restaurantStripeInboxReceive(t, p, cfg, raw, now)
	}
	restaurantStripeInboxMakeDue(t, p)
	if err := p.resolveStripeWebhookReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	var retried, pending int
	if err := p.db.QueryRowContext(ctx, `SELECT count(*) FILTER (WHERE lookup_count=2),count(*) FILTER (WHERE state='pending') FROM restaurant_stripe_webhook_receipts`).Scan(&retried, &pending); err != nil || retried != 32 || pending != 40 {
		t.Fatalf("local lookup did not respect bounded batch or retain unresolved work: retried=%d pending=%d %v", retried, pending, err)
	}
	if err := p.resolveStripeWebhookReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_stripe_webhook_receipts WHERE lookup_count=2`).Scan(&retried); err != nil || retried != 40 {
		t.Fatalf("remaining bounded lookup work was lost: %d %v", retried, err)
	}
	if err := p.resolveStripeWebhookReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := p.db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_stripe_webhook_receipts WHERE lookup_count<>2`).Scan(&count); err != nil || count != 0 {
		t.Fatal("unresolved receipt lookup bypassed durable cooldown")
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_stripe_webhook_receipts SET received_at=now()-interval '2 hours',next_lookup_at=now()-interval '1 second'`); err != nil {
		t.Fatal(err)
	}
	if err := p.resolveStripeWebhookReceipts(ctx); err != nil {
		t.Fatal(err)
	}
	if err := p.db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_stripe_webhook_receipts WHERE lookup_count=3 AND next_lookup_at>now()+interval '59 minutes' AND state='pending'`).Scan(&count); err != nil || count != 32 {
		t.Fatalf("old unresolved work was dropped or not backed off: %d %v", count, err)
	}
	restaurantStripeInboxQueue(t, p, v.AttemptID, false, 0)
	if calls.Load() != 0 {
		t.Fatal("unrelated receipt lookup called provider")
	}
}

func TestRestaurantStripeInboxCapacityPreservesDuplicatesAndRetryableWork(t *testing.T) {
	p, _, v, cfg, calls := restaurantStripeInboxFixture(t)
	ctx := context.Background()
	now := time.Now().UTC()
	raw := restaurantStripeInboxEvent(t, "evt_capacity_original", "checkout.session.completed", "cs_test_capacity_unknown", "", 1)
	restaurantStripeInboxReceive(t, p, cfg, raw, now)
	// Populate only minimal synthetic routing metadata; no provider payload or
	// actual credentials are needed to exercise the durable admission bound.
	if _, err := p.db.ExecContext(ctx, `INSERT INTO restaurant_stripe_webhook_receipts(generation,event_id,account_id,event_type,object_id,body_hash)
 SELECT $1,'evt_capacity_'||n,$2,'checkout.session.completed','cs_test_capacity_'||n,$3 FROM generate_series(1,$4) n`, cfg.Values["sandboxGeneration"], cfg.Values["accountID"], []byte(strings.Repeat("h", 32)), restaurantStripePendingReceiptLimit-1); err != nil {
		t.Fatal(err)
	}
	restaurantStripeInboxReceive(t, p, cfg, raw, now.Add(time.Hour))
	other := restaurantStripeInboxEvent(t, "evt_capacity_new", "checkout.session.completed", "cs_test_inbox", v.AttemptID, 1)
	var apiErr *restaurantError
	if err := p.receiveStripeWebhook(ctx, other, restaurantStripeInboxSign(other, cfg, now), now); !errors.As(err, &apiErr) || apiErr.Status != http.StatusServiceUnavailable {
		t.Fatal("capacity overflow was acknowledged instead of retryable rejection")
	}
	restaurantStripeInboxCount(t, p, restaurantStripePendingReceiptLimit)
	restaurantStripeInboxQueue(t, p, v.AttemptID, false, 0)
	if calls.Load() != 0 {
		t.Fatal("capacity admission called provider")
	}
}
