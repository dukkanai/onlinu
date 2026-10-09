package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestRestaurantPaymentSettlementPolicyBounds(t *testing.T) {
	for _, tc := range []struct {
		days, minutes string
		valid         bool
	}{
		{"30", "60", true}, {"1", "15", true}, {"365", "1440", true},
		{"0", "60", false}, {"366", "60", false}, {"30", "14", false}, {"30", "1441", false},
		{"forever", "60", false}, {"30", "", false}, {"-1", "60", false},
	} {
		t.Run(tc.days+"-"+tc.minutes, func(t *testing.T) {
			t.Setenv("WACALLS_PAYMENT_SETTLEMENT_WATCH_DAYS", tc.days)
			t.Setenv("WACALLS_PAYMENT_SETTLEMENT_CHECK_MINUTES", tc.minutes)
			_, err := restaurantPaymentSettlementPolicyFromEnv()
			if (err == nil) != tc.valid {
				t.Fatalf("valid=%v, err=%v", tc.valid, err)
			}
		})
	}
}

func TestRestaurantPaymentsIntegrationSlowPaymentDoesNotStarveRefundLookup(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	r, err := p.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 1000, Reason: "Synthetic existing dashboard refund", Version: receipt.Order.Version})
	if err != nil {
		t.Fatal(err)
	}
	// Model an existing uncertain remote refund; this cycle must only read it.
	if err = p.applyRefund(ctx, r.Number, r.ID, restaurantRefundRemote{ID: "re_existing_synthetic", Status: "review"}, false); err != nil {
		t.Fatal(err)
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '2 hours' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	paymentReads, refundReads := 0, 0
	fake.fetch = func(ctx context.Context, _ restaurantPaymentConfig, _, _ string) (restaurantPaymentRemote, error) {
		paymentReads++
		<-ctx.Done() // Consume the payment queue's entire time allowance.
		return restaurantPaymentRemote{}, ctx.Err()
	}
	fake.createRefund = func(context.Context, restaurantPaymentConfig, restaurantPaymentAttempt, restaurantOrder, restaurantRefund, int64) (restaurantRefundRemote, error) {
		t.Fatal("read-only recovery attempted to dispatch another refund")
		return restaurantRefundRemote{}, nil
	}
	fake.fetchRefund = func(ctx context.Context, _ restaurantPaymentConfig, _ restaurantPaymentAttempt, _ restaurantOrder, r restaurantRefund) (restaurantRefundRemote, error) {
		if ctx.Err() != nil {
			t.Fatalf("refund lookup inherited exhausted payment budget: %v", ctx.Err())
		}
		refundReads++
		return restaurantRefundRemote{ID: r.ProviderReference, Status: "succeeded"}, nil
	}
	p.runReconciliationCycle(ctx, 200*time.Millisecond)
	if paymentReads != 1 || refundReads != 1 {
		t.Fatalf("payment exhaustion starved refund work: payment reads=%d refund reads=%d", paymentReads, refundReads)
	}
	summary, err := p.Refunds(ctx, receipt.Order.Number)
	if err != nil || summary.RefundedMinor != 1000 || len(summary.Refunds) != 1 || summary.Refunds[0].Status != "succeeded" {
		t.Fatalf("refund reconciliation did not finish: %+v %v", summary, err)
	}
}

func TestRestaurantPaymentsIntegrationSettlementCadenceWindowAndHooks(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	calls := 0
	originalFetch := fake.fetch
	fake.fetch = func(ctx context.Context, cfg restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls++
		return originalFetch(ctx, cfg, id, ref)
	}
	var originalAnchor time.Time
	if err := p.db.QueryRowContext(ctx, `SELECT settlement_watch_started_at FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&originalAnchor); err != nil {
		t.Fatal(err)
	}
	setAge := func(age string) {
		t.Helper()
		if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-$2::interval WHERE order_number=$1`, receipt.Order.Number, age); err != nil {
			t.Fatal(err)
		}
	}
	setAge("30 minutes")
	if err := p.Reconcile(ctx); err != nil || calls != 0 {
		t.Fatalf("cadence bypassed: %d %v", calls, err)
	}
	setAge("61 minutes")
	if err := p.Reconcile(ctx); err != nil || calls != 1 {
		t.Fatalf("due read missed: %d %v", calls, err)
	}
	if err := p.Reconcile(ctx); err != nil || calls != 1 {
		t.Fatalf("repeated polling bypassed cadence: %d %v", calls, err)
	}
	var anchor time.Time
	if err := p.db.QueryRowContext(ctx, `SELECT settlement_watch_started_at FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&anchor); err != nil || !anchor.Equal(originalAnchor) {
		t.Fatalf("refresh moved anchor: %v %v", anchor, err)
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET settlement_watch_started_at=now()-interval '31 days',updated_at=now(),checked_at=now()-interval '2 hours' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	if err := p.Reconcile(ctx); err != nil || calls != 1 {
		t.Fatalf("expired window restarted by updated_at: %d %v", calls, err)
	}
	if _, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, ""); err != nil || calls != 2 {
		t.Fatalf("explicit old refresh blocked: %d %v", calls, err)
	}
	if err := p.Reconcile(ctx); err != nil || calls != 2 {
		t.Fatalf("explicit refresh restarted expired window: %d %v", calls, err)
	}
	setAge("31 seconds")
	view, err := p.Status(ctx, receipt.Order.Number, receipt.TrackingToken, "")
	if err != nil {
		t.Fatal(err)
	}
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls++
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: "refunded", AmountMinor: receipt.Order.TotalMinor, Currency: "SAR"}, nil
	}
	if err := p.Hook(ctx, "stripe", view.AttemptID); err != nil || calls != 3 {
		t.Fatalf("old refund hook blocked: %d %v", calls, err)
	}
	order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "refunded" {
		t.Fatalf("old refund unrecognized: %+v %v", order.Payment, err)
	}
}

func TestRestaurantPaymentsIntegrationSettlementFailedReadRetriedWithoutStateChange(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	calls := 0
	fake.fetch = func(context.Context, restaurantPaymentConfig, string, string) (restaurantPaymentRemote, error) {
		calls++
		return restaurantPaymentRemote{}, errors.New("synthetic unavailable")
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '2 hours' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	if err := p.Reconcile(ctx); err != nil || calls != 1 {
		t.Fatalf("read not attempted: %d %v", calls, err)
	}
	var dirty, captured bool
	var status string
	if err := p.db.QueryRowContext(ctx, `SELECT needs_refresh,capture_verified,status FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&dirty, &captured, &status); err != nil || !dirty || !captured || status != "paid" {
		t.Fatalf("failed read lost factual state/retry: %s %v %v %v", status, dirty, captured, err)
	}
	if err := p.Reconcile(ctx); err != nil || calls != 1 {
		t.Fatalf("failed read bypassed cooldown: %d %v", calls, err)
	}
	// Durable incomplete work survives even after the routine watch expires.
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '31 seconds',settlement_watch_started_at=now()-interval '31 days' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls++
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: "refunded", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
	}
	if err := p.Reconcile(ctx); err != nil || calls != 2 {
		t.Fatalf("failed read not retried: %d %v", calls, err)
	}
	if err := p.db.QueryRowContext(ctx, `SELECT needs_refresh,status FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&dirty, &status); err != nil || dirty || status != "refunded" {
		t.Fatalf("retry did not settle: %s %v %v", status, dirty, err)
	}
}

func TestRestaurantPaymentsIntegrationSettlementPartialThenFullRefundRemainsWatched(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '2 hours',created_at=now()-interval '10 days',settlement_watch_started_at=now()-interval '10 days' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	status, reads := "review", 0
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		reads++
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: status, Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
	}
	if err := p.Reconcile(ctx); err != nil || reads != 1 {
		t.Fatalf("partial refund read failed: %d %v", reads, err)
	}
	order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "review" {
		t.Fatalf("unknown partial refund not reviewed: %+v %v", order.Payment, err)
	}
	var anchor time.Time
	if err := p.db.QueryRowContext(ctx, `SELECT settlement_watch_started_at FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&anchor); err != nil {
		t.Fatal(err)
	}
	if err := p.Reconcile(ctx); err != nil || reads != 1 {
		t.Fatalf("captured review bypassed slow cadence: %d %v", reads, err)
	}
	// The next day's complete provider-confirmed refund must still be fetched,
	// even though this captured review is older than the uncertainty queue limit.
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '2 hours',created_at=created_at-interval '1 day',settlement_watch_started_at=settlement_watch_started_at-interval '1 day' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	summary, err := p.ReconciliationSummary(ctx)
	if err != nil || summary.DueSettlements != 1 {
		t.Fatalf("captured review disappeared from due visibility: %+v %v", summary, err)
	}
	status = "refunded"
	if err := p.Reconcile(ctx); err != nil || reads != 2 {
		t.Fatalf("full refund after partial missed: %d %v", reads, err)
	}
	order, err = p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || order.Payment.Status != "refunded" {
		t.Fatalf("full refund not confirmed: %+v %v", order.Payment, err)
	}
	var finalAnchor time.Time
	if err := p.db.QueryRowContext(ctx, `SELECT settlement_watch_started_at FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&finalAnchor); err != nil || !finalAnchor.Equal(anchor.Add(-24*time.Hour)) {
		t.Fatalf("refund transition extended watch: %v %v", finalAnchor, err)
	}
}

func TestRestaurantPaymentsIntegrationSettlementLegacyAnchorAndRestart(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET settlement_watch_started_at=NULL,created_at=now()-interval '40 days',updated_at=now(),checked_at=now()-interval '2 hours' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	// Repeat initialization; the additive migration must not manufacture a new
	// first-capture date or reopen the watch on a legacy verified payment.
	for n := 0; n < 2; n++ {
		restarted, err := newRestaurantPayments(ctx, p.db, p.orders, p.baseURL)
		if err != nil {
			t.Fatal(err)
		}
		p = restarted
	}
	calls := 0
	originalFetch := fake.fetch
	fake.fetch = func(ctx context.Context, cfg restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		calls++
		return originalFetch(ctx, cfg, id, ref)
	}
	p.adapter = fake
	if err := p.Reconcile(ctx); err != nil || calls != 0 {
		t.Fatalf("legacy watch restarted: %d %v", calls, err)
	}
	if _, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, ""); err != nil || calls != 1 {
		t.Fatalf("legacy refresh failed: %d %v", calls, err)
	}
	var created, anchor time.Time
	if err := p.db.QueryRowContext(ctx, `SELECT created_at,settlement_watch_started_at FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&created, &anchor); err != nil || !created.Equal(anchor) {
		t.Fatalf("legacy capture date guessed: %v %v %v", created, anchor, err)
	}
}

func TestRestaurantPaymentsIntegrationSettlementCanceledApplyRetainsRetry(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '2 hours' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE order_number=$1`, receipt.Order.Number))
	if err != nil {
		t.Fatal(err)
	}
	fake.fetch = func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
		cancel() // Lookup succeeded, but its local transaction can no longer commit.
		return restaurantPaymentRemote{ID: id, Reference: ref, Status: "refunded", Currency: "SAR", AmountMinor: receipt.Order.TotalMinor}, nil
	}
	if _, err := p.refreshAttemptAfter(ctx, a, time.Hour); err == nil {
		t.Fatal("canceled apply unexpectedly succeeded")
	}
	var dirty bool
	var status string
	if err := p.db.QueryRowContext(context.Background(), `SELECT needs_refresh,status FROM restaurant_payment_attempts WHERE id=$1`, a.ID).Scan(&dirty, &status); err != nil || !dirty || status != "paid" {
		t.Fatalf("canceled apply lost retry/factual state: %v %s %v", dirty, status, err)
	}
}

func TestRestaurantPaymentsIntegrationSettlementBatchFairnessAndCooldown(t *testing.T) {
	p, _, _ := restaurantRefundFixture(t)
	ctx := context.Background()
	paidIDs := map[string]bool{}
	paidCalls, urgentCalls := 0, 0
	p.adapter = &restaurantPaymentFakeAdapter{
		create: func(_ context.Context, _ restaurantPaymentConfig, req restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			return restaurantPaymentRemote{ID: "cs_" + req.AttemptID, URL: "https://checkout.stripe.com/c/pay/mock"}, nil
		},
		fetch: func(_ context.Context, _ restaurantPaymentConfig, id, ref string) (restaurantPaymentRemote, error) {
			status := "pending"
			if paidIDs[ref] {
				paidCalls++
				status = "paid"
			} else {
				urgentCalls++
			}
			return restaurantPaymentRemote{ID: id, Reference: ref, Status: status, Currency: "SAR", AmountMinor: 3000}, nil
		},
	}
	for n := 0; n < 18; n++ {
		receipt, err := p.orders.Create(ctx, restaurantOrderFixtureInput("pickup"), "", uuid.NewString())
		if err != nil {
			t.Fatal(err)
		}
		view, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "stripe")
		if err != nil {
			t.Fatal(err)
		}
		if n < 5 {
			paidIDs[view.AttemptID] = true
			if _, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, ""); err != nil {
				t.Fatal(err)
			}
			if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '2 hours' WHERE id=$1`, view.AttemptID); err != nil {
				t.Fatal(err)
			}
		}
	}
	paidCalls, urgentCalls = 0, 0
	if err := p.Reconcile(ctx); err != nil || urgentCalls != 8 || paidCalls != 2 {
		t.Fatalf("first batch not bounded/fair: urgent=%d paid=%d err=%v", urgentCalls, paidCalls, err)
	}
	if err := p.Reconcile(ctx); err != nil || urgentCalls != 13 || paidCalls != 4 {
		t.Fatalf("cooling work starved queue: urgent=%d paid=%d err=%v", urgentCalls, paidCalls, err)
	}
	if err := p.Reconcile(ctx); err != nil || urgentCalls != 13 || paidCalls != 5 {
		t.Fatalf("paid backlog not drained fairly: urgent=%d paid=%d err=%v", urgentCalls, paidCalls, err)
	}
}

func TestRestaurantPaymentsIntegrationSettlementAdminSummary(t *testing.T) {
	p, receipt, _ := restaurantRefundFixture(t)
	ctx := context.Background()
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET checked_at=now()-interval '3 hours' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	summary, err := p.ReconciliationSummary(ctx)
	if err != nil || summary.DueSettlements != 1 || summary.OverdueSettlements != 1 || summary.OutsideAutomaticWindow != 0 || summary.WatchDays != 30 || summary.CheckMinutes != 60 {
		t.Fatalf("bad due visibility: %+v %v", summary, err)
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET settlement_watch_started_at=now()-interval '31 days' WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	s := &server{payments: p}
	pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
	s.registerRestaurantPaymentHandlers(pub, admin, hooks)
	w := httptest.NewRecorder()
	admin.ServeHTTP(w, httptest.NewRequest("GET", "/api/restaurant/payments", nil))
	var body struct {
		Reconciliation restaurantPaymentReconciliationSummary `json:"reconciliation"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil || body.Reconciliation.OutsideAutomaticWindow != 1 || body.Reconciliation.DueSettlements != 0 {
		t.Fatalf("manual-refresh visibility missing: %d %s", w.Code, w.Body.String())
	}
	if strings.Contains(w.Body.String(), receipt.Order.Number) || strings.Contains(w.Body.String(), "sk_test_unit_only") {
		t.Fatal("summary exposed an order identifier or secret")
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET needs_refresh=true WHERE order_number=$1`, receipt.Order.Number); err != nil {
		t.Fatal(err)
	}
	summary, err = p.ReconciliationSummary(ctx)
	if err != nil || summary.PendingRefreshes != 1 || summary.OutsideAutomaticWindow != 0 {
		t.Fatalf("durable refresh visibility missing: %+v %v", summary, err)
	}
}
