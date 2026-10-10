package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
)

type restaurantRefundFakeAdapter struct {
	restaurantPaymentFakeAdapter
	createRefund func(context.Context, restaurantPaymentConfig, restaurantPaymentAttempt, restaurantOrder, restaurantRefund, int64) (restaurantRefundRemote, error)
	fetchRefund  func(context.Context, restaurantPaymentConfig, restaurantPaymentAttempt, restaurantOrder, restaurantRefund) (restaurantRefundRemote, error)
}

func (f *restaurantRefundFakeAdapter) CreateRefund(ctx context.Context, c restaurantPaymentConfig, a restaurantPaymentAttempt, o restaurantOrder, r restaurantRefund, expected int64) (restaurantRefundRemote, error) {
	return f.createRefund(ctx, c, a, o, r, expected)
}
func (f *restaurantRefundFakeAdapter) FetchRefund(ctx context.Context, c restaurantPaymentConfig, a restaurantPaymentAttempt, o restaurantOrder, r restaurantRefund) (restaurantRefundRemote, error) {
	return f.fetchRefund(ctx, c, a, o, r)
}
func restaurantRefundFixture(t *testing.T) (*restaurantPayments, restaurantReceipt, *restaurantRefundFakeAdapter) {
	t.Helper()
	p, receipt := restaurantPaymentFixtureProvider(t, "tap")
	ctx := context.Background()
	fake := &restaurantRefundFakeAdapter{restaurantPaymentFakeAdapter: restaurantPaymentFakeAdapter{
		create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			return restaurantPaymentRemote{ID: "charge_refund_test", URL: "https://checkout.tap.company/pay/mock"}, nil
		},
		fetch: func(_ context.Context, _ restaurantPaymentConfig, id, attempt string) (restaurantPaymentRemote, error) {
			return restaurantPaymentRemote{ID: id, Reference: attempt, Status: "paid", Currency: receipt.Order.Currency, AmountMinor: receipt.Order.TotalMinor}, nil
		},
	}, createRefund: func(_ context.Context, _ restaurantPaymentConfig, _ restaurantPaymentAttempt, _ restaurantOrder, r restaurantRefund, _ int64) (restaurantRefundRemote, error) {
		return restaurantRefundRemote{ID: "re_" + r.ID, Status: "succeeded"}, nil
	}, fetchRefund: func(_ context.Context, _ restaurantPaymentConfig, _ restaurantPaymentAttempt, _ restaurantOrder, r restaurantRefund) (restaurantRefundRemote, error) {
		return restaurantRefundRemote{ID: r.ProviderReference, Status: "succeeded"}, nil
	}}
	p.adapter = fake
	if _, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "tap"); err != nil {
		t.Fatal(err)
	}
	if _, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, ""); err != nil {
		t.Fatal(err)
	}
	var err error
	receipt.Order, err = p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil {
		t.Fatal(err)
	}
	return p, receipt, fake
}
func TestRestaurantRefundIntegrationConcurrentIdempotencyAndDispatch(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	in := restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 1000, Reason: "missing item", Version: receipt.Order.Version}
	var wg sync.WaitGroup
	ids := make(chan string, 20)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, e := p.RequestRefund(ctx, receipt.Order.Number, in)
			if e != nil {
				t.Error(e)
				return
			}
			ids <- r.ID
		}()
	}
	wg.Wait()
	close(ids)
	id := ""
	for got := range ids {
		if id != "" && id != got {
			t.Fatal("duplicate ledger rows")
		}
		id = got
	}
	if id == "" {
		t.Fatal("missing refund")
	}
	if _, err := p.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: in.RequestID, AmountMinor: 999, Reason: in.Reason, Version: in.Version}); err == nil {
		t.Fatal("idempotency payload collision accepted")
	}
	var creates atomic.Int32
	fake.createRefund = func(_ context.Context, _ restaurantPaymentConfig, _ restaurantPaymentAttempt, _ restaurantOrder, r restaurantRefund, expected int64) (restaurantRefundRemote, error) {
		creates.Add(1)
		if expected != 0 {
			t.Error("bad preflight expected balance")
		}
		time.Sleep(20 * time.Millisecond)
		return restaurantRefundRemote{ID: "re_" + r.ID, Status: "succeeded"}, nil
	}
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if e := p.processRefund(ctx, id); e != nil {
				t.Error(e)
			}
		}()
	}
	wg.Wait()
	if creates.Load() != 1 {
		t.Fatalf("provider refund POST count %d", creates.Load())
	}
	summary, err := p.Refunds(ctx, receipt.Order.Number)
	if err != nil || len(summary.Refunds) != 1 || summary.RefundedMinor != 1000 || summary.ReservedMinor != 1000 || summary.AvailableMinor != 2000 || summary.Refunds[0].Confirmation != "provider" {
		t.Fatalf("wrong refund summary %+v %v", summary, err)
	}
	o, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || o.TotalMinor != receipt.Order.TotalMinor || o.Tax != receipt.Order.Tax || o.Payment.AmountMinor != receipt.Order.Payment.AmountMinor || o.Payment.Status != "paid" {
		t.Fatal("original money/tax mutated by partial refund")
	}
	fake.createRefund = func(_ context.Context, _ restaurantPaymentConfig, _ restaurantPaymentAttempt, _ restaurantOrder, r restaurantRefund, expected int64) (restaurantRefundRemote, error) {
		if expected != 1000 {
			t.Error("known partial refund not reconciled")
		}
		return restaurantRefundRemote{ID: "re_" + r.ID}, nil
	}
	r, err := p.RequestRefund(ctx, o.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 2000, Reason: "remaining cancellation", Version: o.Version})
	if err != nil {
		t.Fatal(err)
	}
	if err = p.processRefund(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	o, _ = p.orders.Track(ctx, o.Number, receipt.TrackingToken, "", "")
	if o.Payment.Status != "refunded" {
		t.Fatal("full verified refund not settled")
	}
	if _, err = p.RequestRefund(ctx, o.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 1, Reason: "over refund", Version: o.Version}); err == nil {
		t.Fatal("over-refund allowed")
	}
}
func TestRestaurantRefundIntegrationPendingNotSuccessAndAmbiguousNeverRetried(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	var creates atomic.Int32
	fake.createRefund = func(context.Context, restaurantPaymentConfig, restaurantPaymentAttempt, restaurantOrder, restaurantRefund, int64) (restaurantRefundRemote, error) {
		creates.Add(1)
		return restaurantRefundRemote{}, errors.New("ambiguous transport failure")
	}
	r, err := p.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 3000, Reason: "whole cancellation", Version: receipt.Order.Version})
	if err != nil {
		t.Fatal(err)
	}
	if err = p.processRefund(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		if err = p.ReconcileRefunds(ctx); err != nil {
			t.Fatal(err)
		}
	}
	s, err := p.Refunds(ctx, r.Number)
	if err != nil || s.Refunds[0].Status != "review" || !s.Refunds[0].Submitted || s.AvailableMinor != 0 || s.RefundedMinor != 0 || creates.Load() != 1 {
		t.Fatalf("unsafe ambiguity %+v %v", s, err)
	}
	if _, err = p.ResolveRefundManual(ctx, r.Number, r.ID, restaurantRefundResolution{Reference: "manual-reference", Reason: "must not double pay", Version: s.Refunds[0].Version}); err == nil {
		t.Fatal("unknown submitted refund allowed manual duplicate")
	}
	// Recovery attaches the EXISTING remote refund, querying only; no second POST.
	confirmed, err := p.ConfirmRefundReference(ctx, r.Number, r.ID, restaurantRefundResolution{Reference: "re_recovered", Reason: "original refund found in provider portal", Version: s.Refunds[0].Version})
	if err != nil || confirmed.Status != "succeeded" || confirmed.Confirmation != "provider" || confirmed.ProviderReference != "re_recovered" || creates.Load() != 1 {
		t.Fatalf("safe reference recovery failed %+v %v", confirmed, err)
	}
}

func TestRestaurantRefundIntegrationProvenPreflightFailureCanBeReauthorized(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	var preflights atomic.Int32
	fake.createRefund = func(context.Context, restaurantPaymentConfig, restaurantPaymentAttempt, restaurantOrder, restaurantRefund, int64) (restaurantRefundRemote, error) {
		preflights.Add(1)
		return restaurantRefundRemote{}, restaurantRefundPreflightError{errors.New("read-only provider lookup failed")}
	}
	r, err := p.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 1000, Reason: "preflight test", Version: receipt.Order.Version})
	if err != nil {
		t.Fatal(err)
	}
	if err = p.processRefund(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	s, err := p.Refunds(ctx, r.Number)
	if err != nil || s.Refunds[0].Status != "review" || s.Refunds[0].Submitted || s.Refunds[0].Authorized || s.ReservedMinor != 1000 {
		t.Fatalf("preflight ambiguity confused %+v %v", s, err)
	}
	if err = p.ReconcileRefunds(ctx); err != nil || preflights.Load() != 1 {
		t.Fatal("preflight automatically retried")
	}
	r, err = p.AuthorizeRefund(ctx, r.Number, r.ID, s.Refunds[0].Version)
	if err != nil || r.Status != "requested" || !r.Authorized {
		t.Fatalf("explicit no-dispatch retry blocked %+v %v", r, err)
	}
}
func TestRestaurantRefundIntegrationCancellationRequiresExplicitAuthorization(t *testing.T) {
	p, receipt, fake := restaurantRefundFixture(t)
	ctx := context.Background()
	var creates atomic.Int32
	old := fake.createRefund
	fake.createRefund = func(c context.Context, cfg restaurantPaymentConfig, a restaurantPaymentAttempt, o restaurantOrder, r restaurantRefund, n int64) (restaurantRefundRemote, error) {
		creates.Add(1)
		return old(c, cfg, a, o, r, n)
	}
	o, err := p.orders.SetStatus(ctx, receipt.Order.Number, "cancelled", receipt.Order.Version)
	if err != nil {
		t.Fatal(err)
	}
	s, err := p.Refunds(ctx, o.Number)
	if err != nil || len(s.Refunds) != 1 || s.Refunds[0].Authorized || s.Refunds[0].Status != "requested" {
		t.Fatalf("missing cancellation intent %+v %v", s, err)
	}
	if err = p.ReconcileRefunds(ctx); err != nil || creates.Load() != 0 {
		t.Fatal("cancellation caused unapproved financial call")
	}
	r, err := p.AuthorizeRefund(ctx, o.Number, s.Refunds[0].ID, s.Refunds[0].Version)
	if err != nil {
		t.Fatal(err)
	}
	if err = p.processRefund(ctx, r.ID); err != nil {
		t.Fatal(err)
	}
	o, _ = p.orders.Track(ctx, o.Number, receipt.TrackingToken, "", "")
	if o.Status != "cancelled" || o.Payment.Status != "refunded" || creates.Load() != 1 {
		t.Fatal("refund resurrected cancellation")
	}
}
func TestRestaurantRefundIntegrationVersionAmountAndManualAudit(t *testing.T) {
	p, receipt, _ := restaurantRefundFixture(t)
	ctx := context.Background()
	if _, err := p.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 3001, Reason: "too much", Version: receipt.Order.Version}); err == nil {
		t.Fatal("over-capture reservation")
	}
	if _, err := p.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 100, Reason: "stale request", Version: receipt.Order.Version - 1}); err == nil {
		t.Fatal("stale request accepted")
	}
	// Explicit manual-only capability keeps the immutable ledger separate from
	// provider confirmation; the test changes only its synthetic fixture.
	tx, err := p.db.BeginTx(ctx, nil)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, receipt.Order.Number))
	if err != nil {
		t.Fatal(err)
	}
	o := stored.order
	o.Payment.Provider = "geidea"
	if err = restaurantUpdateOrder(ctx, tx, o); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	r, err := p.RequestRefund(ctx, o.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 1000, Reason: "manual gateway refund", Version: o.Version})
	if err != nil || r.Status != "review" {
		t.Fatalf("manual capability not honest %+v %v", r, err)
	}
	r, err = p.ResolveRefundManual(ctx, o.Number, r.ID, restaurantRefundResolution{Reference: "merchant-portal-receipt", Reason: "operator reports completed in merchant portal", Version: r.Version})
	if err != nil || r.Status != "manual_reported" || r.Confirmation != "manual" {
		t.Fatalf("manual audit failure %+v %v", r, err)
	}
	s, err := p.Refunds(ctx, o.Number)
	if err != nil || s.RefundedMinor != 0 || s.ReservedMinor != 1000 {
		t.Fatal("manual report falsely provider confirmed")
	}
}
func TestRestaurantRefundIntegrationPublicOwnershipAndSanitization(t *testing.T) {
	p, receipt, _ := restaurantRefundFixture(t)
	ctx := context.Background()
	_, err := p.RequestRefund(ctx, receipt.Order.Number, restaurantRefundInput{RequestID: uuid.NewString(), AmountMinor: 100, Reason: "operator-private-note", Version: receipt.Order.Version})
	if err != nil {
		t.Fatal(err)
	}
	s := &server{payments: p, orders: p.orders}
	pub, admin := http.NewServeMux(), http.NewServeMux()
	s.registerRestaurantRefundRoutes(pub, admin)
	path := "/storefront-api/orders/" + receipt.Order.Number + "/refunds"
	w := httptest.NewRecorder()
	pub.ServeHTTP(w, httptest.NewRequest("GET", path, nil))
	if w.Code != 404 {
		t.Fatalf("unguarded refund ledger %d", w.Code)
	}
	w = httptest.NewRecorder()
	req := httptest.NewRequest("GET", path, nil)
	req.Header.Set("X-Order-Token", receipt.TrackingToken)
	pub.ServeHTTP(w, req)
	if w.Code != 200 || strings.Contains(w.Body.String(), "operator-private-note") || strings.Contains(w.Body.String(), "requestId") || strings.Contains(w.Body.String(), "authorized") {
		t.Fatalf("private ledger exposed %d %s", w.Code, w.Body.String())
	}
}
