package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestRestaurantStripeCreateUsesPersistedTimestamp(t *testing.T) {
	created := time.Date(2025, 1, 2, 3, 4, 5, 123456000, time.UTC)
	r := restaurantPaymentRequest{AttemptID: "synthetic_attempt", OrderNumber: "R1234", Currency: "SAR", AmountMinor: 11500, CreatedAt: created, ReturnURL: "https://restaurant.test/payment-hooks/return/synthetic_attempt", CustomerName: "Synthetic customer", Phone: "synthetic-phone"}
	var bodies, keys []string
	g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(req *http.Request) (*http.Response, error) {
		if req.Method != http.MethodPost || req.URL.String() != "https://api.stripe.com/v1/checkout/sessions" {
			t.Fatal("unexpected provider operation")
		}
		raw, err := io.ReadAll(req.Body)
		if err != nil {
			t.Fatal(err)
		}
		bodies = append(bodies, string(raw))
		keys = append(keys, req.Header.Get("Idempotency-Key"))
		return restaurantPaymentTestResponse(`{"id":"cs_test_synthetic","url":"https://checkout.stripe.com/c/pay/synthetic","mode":"payment","livemode":false,"amount_total":11500,"currency":"sar","client_reference_id":"synthetic_attempt"}`), nil
	})}}
	cfg := restaurantPaymentConfig{ID: "stripe", Mode: "test", Secrets: map[string]string{"secretKey": "sk_test_synthetic"}}
	for i := 0; i < 2; i++ {
		if remote, err := g.Create(context.Background(), cfg, r); err != nil || remote.Status == "paid" {
			t.Fatalf("synthetic create failed or settled: %v", err)
		}
	}
	if bodies[0] != bodies[1] || keys[0] != "restaurant-synthetic_attempt" || keys[1] != keys[0] {
		t.Fatal("request bytes or idempotency key changed")
	}
	form, err := url.ParseQuery(bodies[0])
	if err != nil || form.Get("expires_at") != strconv.FormatInt(created.Add(31*time.Minute).Unix(), 10) {
		t.Fatal("expiry did not use immutable persisted creation time")
	}
	for key, value := range map[string]string{"mode": "payment", "payment_method_types[0]": "card", "line_items[0][price_data][currency]": "sar", "line_items[0][price_data][unit_amount]": "11500", "line_items[0][quantity]": "1", "client_reference_id": r.AttemptID, "metadata[restaurant_attempt]": r.AttemptID, "payment_intent_data[metadata][restaurant_attempt]": r.AttemptID, "success_url": r.ReturnURL, "cancel_url": r.ReturnURL} {
		if form.Get(key) != value {
			t.Fatalf("immutable field %s changed", key)
		}
	}
	if strings.Contains(bodies[0], "Synthetic+customer") || strings.Contains(bodies[0], r.Phone) || form.Has("automatic_tax[enabled]") || form.Has("allow_promotion_codes") {
		t.Fatal("PII or repricing option was sent")
	}
	r.CreatedAt = time.Time{}
	if _, err := g.Create(context.Background(), cfg, r); err == nil || len(bodies) != 2 {
		t.Fatal("missing persisted timestamp reached transport")
	}
}

func TestRestaurantStripeSandboxConfigGuard(t *testing.T) {
	for _, key := range []string{"rk_test_syntheticOnly", "sk_test_syntheticOnly"} {
		if err := restaurantStripeSandboxConfigValid(restaurantPaymentConfig{ID: "stripe", Mode: "test", Secrets: map[string]string{"secretKey": key}}); err != nil {
			t.Fatal("synthetic test key rejected")
		}
	}
	for _, tc := range []struct{ provider, mode, key string }{
		{"stripe", "live", "rk_test_synthetic"}, {"stripe", "", "rk_test_synthetic"}, {"paylink", "test", "rk_test_synthetic"},
		{"stripe", "test", "rk_live_synthetic"}, {"stripe", "test", "sk_live_synthetic"}, {"stripe", "test", "pk_test_synthetic"},
		{"stripe", "test", ""}, {"stripe", "test", "rk_test_"}, {"stripe", "test", " rk_test_synthetic"},
		{"stripe", "test", "rk_test_synthetic\n"}, {"stripe", "test", "rk_test_synthetic/evil"}, {"stripe", "test", "rk_test_" + strings.Repeat("a", 481)},
	} {
		err := restaurantStripeSandboxConfigValid(restaurantPaymentConfig{ID: tc.provider, Mode: tc.mode, Secrets: map[string]string{"secretKey": tc.key}})
		if err == nil || err.Error() != restaurantFail(400, "invalid_request").Error() {
			t.Fatal("unsafe configuration accepted or secret disclosed")
		}
	}
	// This increment must not silently wire or activate restricted-key support.
	if err := restaurantPaymentValidateConfig(restaurantPaymentConfig{ID: "stripe", Mode: "test", Secrets: map[string]string{"secretKey": "rk_test_synthetic"}}); err == nil {
		t.Fatal("unreviewed sandbox guard integration")
	}
}

func restaurantStripeSyntheticSignature(raw []byte, timestamp, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(raw)
	return "t=" + timestamp + ",v1=" + hex.EncodeToString(mac.Sum(nil))
}

func TestRestaurantStripeSandboxRawSignature(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	timestamp := strconv.FormatInt(now.Unix(), 10)
	secret := "whsec_synthetic_only"
	raw := []byte(` {"id":"evt_synthetic","object":"event","type":"checkout.session.completed","livemode":false,"created":1,"data":{"object":{"id":"cs_test_synthetic","metadata":{"restaurant_attempt":"synthetic_attempt"},"payment_status":"paid","amount_total":1}}} `)
	signature := restaurantStripeSyntheticSignature(raw, timestamp, secret)
	event, err := restaurantStripeVerifySandboxEvent(raw, signature, secret, now)
	if err != nil || event.ID != "evt_synthetic" || event.Type != "checkout.session.completed" || event.ObjectID != "cs_test_synthetic" || event.AttemptID != "synthetic_attempt" {
		t.Fatalf("valid signed sandbox lookup hint rejected: %+v %v", event, err)
	}
	for _, header := range []string{signature + ",v0=" + strings.Repeat("0", 64), "v1=" + strings.Repeat("0", 64) + "," + signature, signature + ",v1=" + strings.Repeat("0", 64)} {
		if _, err := restaurantStripeVerifySandboxEvent(raw, header, secret, now); err != nil {
			t.Fatal("multiple-signature rotation rejected")
		}
	}
	for _, tc := range []struct {
		name, header, secret string
		body                 []byte
		now                  time.Time
	}{
		{"body changed", signature, secret, append(append([]byte{}, raw...), ' '), now},
		{"parsed then reserialized", signature, secret, []byte(strings.TrimSpace(string(raw))), now},
		{"wrong secret", signature, "whsec_wrong", raw, now},
		{"missing secret", signature, "", raw, now},
		{"API key is not signing secret", signature, "sk_test_synthetic", raw, now},
		{"missing header", "", secret, raw, now},
		{"v0 only", strings.Replace(signature, "v1=", "v0=", 1), secret, raw, now},
		{"unknown version", strings.Replace(signature, "v1=", "v2=", 1), secret, raw, now},
		{"wrong digest", "t=" + timestamp + ",v1=" + strings.Repeat("0", 64), secret, raw, now},
		{"malformed digest", "t=" + timestamp + ",v1=nothex", secret, raw, now},
		{"missing timestamp", strings.Split(signature, ",")[1], secret, raw, now},
		{"duplicate timestamp", signature + ",t=" + timestamp, secret, raw, now},
		{"old delivery", signature, secret, raw, now.Add(5*time.Minute + time.Second)},
		{"future delivery", signature, secret, raw, now.Add(-5*time.Minute - time.Second)},
		{"missing clock", signature, secret, raw, time.Time{}},
		{"negative timestamp", restaurantStripeSyntheticSignature(raw, "-1", secret), secret, raw, now},
		{"overflow timestamp", restaurantStripeSyntheticSignature(raw, "9223372036854775808", secret), secret, raw, now},
		{"max timestamp", restaurantStripeSyntheticSignature(raw, "9223372036854775807", secret), secret, raw, now},
		{"noncanonical timestamp", restaurantStripeSyntheticSignature(raw, "0"+timestamp, secret), secret, raw, now},
		{"newline header", signature + "\n", secret, raw, now},
		{"oversize header", signature + strings.Repeat("x", 8192), secret, raw, now},
		{"empty body", signature, secret, nil, now},
		{"oversize body", signature, secret, []byte(strings.Repeat("x", 256*1024+1)), now},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := restaurantStripeVerifySandboxEvent(tc.body, tc.header, tc.secret, tc.now)
			if err == nil || got != (restaurantStripeSandboxEvent{}) || err.Error() != restaurantFail(400, "invalid_request").Error() {
				t.Fatal("invalid delivery accepted or leaked payload/secret")
			}
		})
	}
}

func TestRestaurantStripeSandboxAuthenticatedEnvelope(t *testing.T) {
	now := time.Date(2026, 10, 10, 12, 0, 0, 0, time.UTC)
	secret := "whsec_synthetic_only"
	timestamp := strconv.FormatInt(now.Unix(), 10)
	base := `{"id":"evt_synthetic","object":"event","type":"checkout.session.completed","livemode":false,"data":{"object":{"id":"cs_test_synthetic"}}}`
	for _, bad := range []string{
		strings.Replace(base, `"livemode":false`, `"livemode":true`, 1),
		strings.Replace(base, `"livemode":false,`, "", 1),
		strings.Replace(base, `"livemode":false`, `"livemode":null`, 1),
		strings.Replace(base, `"livemode":false`, `"livemode":false,"account":"acct_foreign"`, 1),
		strings.Replace(base, `"livemode":false`, `"livemode":false,"context":"acct_foreign"`, 1),
		strings.Replace(base, `"id":"evt_synthetic"`, `"id":"cs_wrong"`, 1),
		strings.Replace(base, `"object":"event"`, `"object":"charge"`, 1),
		strings.Replace(base, `"type":"checkout.session.completed"`, `"type":""`, 1),
		base + `{}`, `{`, `null`,
	} {
		raw := []byte(bad)
		if _, err := restaurantStripeVerifySandboxEvent(raw, restaurantStripeSyntheticSignature(raw, timestamp, secret), secret, now); err == nil {
			t.Fatal("wrong-mode/account or malformed authenticated envelope accepted")
		}
	}
	// Event age is not delivery freshness. Out-of-order events and duplicates
	// still verify; the future durable inbox owns deduplication and re-querying.
	for _, created := range []string{"100", "50", "100"} {
		raw := []byte(strings.Replace(base, `"livemode":false`, `"livemode":false,"created":`+created, 1))
		if _, err := restaurantStripeVerifySandboxEvent(raw, restaurantStripeSyntheticSignature(raw, timestamp, secret), secret, now); err != nil {
			t.Fatal("signed delayed delivery rejected based on event order")
		}
	}
}

func TestRestaurantStripeIntegrationPersistedCreateAndUncertaintyFence(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	calls := 0
	var captured restaurantPaymentRequest
	p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		calls++
		captured = r
		var persisted time.Time
		if err := p.db.QueryRowContext(ctx, `SELECT created_at FROM restaurant_payment_attempts WHERE id=$1`, r.AttemptID).Scan(&persisted); err != nil || !persisted.Equal(r.CreatedAt) || r.CreatedAt.IsZero() {
			t.Fatal("create did not use committed database timestamp")
		}
		return restaurantPaymentRemote{}, errors.New("synthetic uncertain transport")
	}}
	first, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil || first.Status != "review" || calls != 1 {
		t.Fatalf("uncertainty fence failed: %+v %v", first, err)
	}
	reopened, err := newRestaurantPayments(ctx, p.db, p.orders, p.baseURL)
	if err != nil {
		t.Fatal(err)
	}
	reopened.adapter = p.adapter
	for i := 0; i < 3; i++ {
		got, err := reopened.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
		if err != nil || got.Status != "review" || got.AttemptID != first.AttemptID || calls != 1 {
			t.Fatal("restart/repeated start created a second provider attempt")
		}
	}
	a, err := reopened.readAttempt(reopened.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1`, first.AttemptID))
	if err != nil || !a.CreatedAt.Equal(captured.CreatedAt) || a.RemoteID != "" {
		t.Fatal("restart changed timestamp or invented remote identity")
	}
}

func TestRestaurantStripeIntegrationCreationTimeAfterOrderLockWait(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	blocker, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer blocker.Rollback()
	var blockerPID int
	if err := blocker.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&blockerPID); err != nil {
		t.Fatal(err)
	}
	var number string
	if err := blocker.QueryRowContext(ctx, `SELECT number FROM restaurant_orders WHERE number=$1 FOR UPDATE`, receipt.Order.Number).Scan(&number); err != nil {
		t.Fatal(err)
	}
	var created time.Time
	p.adapter = &restaurantPaymentFakeAdapter{create: func(_ context.Context, _ restaurantPaymentConfig, r restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		created = r.CreatedAt
		return restaurantPaymentRemote{ID: "cs_test_synthetic", URL: "https://checkout.stripe.com/c/pay/synthetic"}, nil
	}}
	done := make(chan error, 1)
	go func() {
		_, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
		done <- err
	}()
	// Observe the actual lock wait rather than sleeping and assuming Start has
	// begun its transaction. Bind the observation to this blocker, since another
	// fixture's schema could have the same query text in the shared test database.
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		err := p.db.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE datname=current_database() AND query=$1 AND wait_event_type='Lock' AND $2=ANY(pg_blocking_pids(a.pid)))`, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, blockerPID).Scan(&waiting)
		if err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("Start did not reach the controlled order lock")
		case err := <-done:
			t.Fatalf("Start unexpectedly bypassed the order lock: %v", err)
		case <-ticker.C:
		}
	}
	var releaseMarker time.Time
	if err := p.db.QueryRowContext(ctx, `SELECT clock_timestamp()`).Scan(&releaseMarker); err != nil {
		t.Fatal(err)
	}
	if err := blocker.Commit(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil || created.Before(releaseMarker) || created.IsZero() {
			t.Fatalf("created_at used transaction-start time before the lock release: %v", err)
		}
	case <-ctx.Done():
		t.Fatal("Start did not finish after releasing the order lock")
	}
}
