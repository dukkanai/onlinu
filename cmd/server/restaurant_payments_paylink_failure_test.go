package main

import (
	"context"
	"errors"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
)

func paylinkFailureFixture(t *testing.T) (*restaurantPayments, restaurantReceipt) {
	t.Helper()
	p, _ := restaurantPaymentFixture(t)
	ctx := context.Background()
	if _, err := p.Configure(ctx, "paylink", restaurantPaymentConfigInput{Enabled: true, Mode: "test", Secrets: paylinkTestConfig().Secrets}); err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("pickup")
	input.PaymentProvider = "paylink"
	receipt, err := p.orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	return p, receipt
}

func paylinkFailureResponse(failure string) (*http.Response, error) {
	switch failure {
	case "timeout":
		return nil, context.DeadlineExceeded
	case "unauthorized":
		response := restaurantPaymentTestResponse(`{"error":"synthetic-private-provider-detail"}`)
		response.StatusCode = http.StatusUnauthorized
		return response, nil
	case "malformed-json":
		return restaurantPaymentTestResponse(`{"success":`), nil
	case "invalid-token":
		return restaurantPaymentTestResponse(`{"id_token":"synthetic invalid token"}`), nil
	default:
		return restaurantPaymentTestResponse(`{}`), nil
	}
}

func TestRestaurantPaymentsIntegrationPaylinkCreationFailureBoundary(t *testing.T) {
	for _, stage := range []string{"auth", "invoice"} {
		for _, failure := range []string{"timeout", "unauthorized", "malformed-json", "invalid-token", "missing-fields"} {
			t.Run(stage+"-"+failure, func(t *testing.T) {
				p, receipt := paylinkFailureFixture(t)
				ctx := context.Background()
				auth, invoices := 0, 0
				p.adapter = &restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
					if r.URL.Host != "restpilot.paylink.sa" || r.Method != http.MethodPost {
						t.Fatal("unexpected provider request")
					}
					switch r.URL.Path {
					case "/api/auth":
						auth++
						if stage == "auth" {
							return paylinkFailureResponse(failure)
						}
						return restaurantPaymentTestResponse(`{"id_token":"synthetic-token"}`), nil
					case "/api/addInvoice":
						invoices++
						return paylinkFailureResponse(failure)
					default:
						t.Fatal("unexpected retry or fetch")
						return nil, errors.New("unexpected request")
					}
				})}}
				want, wantInvoices := "failed", 0
				if stage == "invoice" {
					want, wantInvoices = "review", 1
				}
				var attemptID string
				for range 3 {
					view, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
					if err != nil || view.Status != want || view.URL != "" || view.Widget != nil || view.Provider != "paylink" || view.Mode != "test" {
						t.Fatalf("wrong creation result: %+v %v", view, err)
					}
					if attemptID != "" && view.AttemptID != attemptID {
						t.Fatal("a new payment attempt was created")
					}
					attemptID = view.AttemptID
					refreshed, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
					if err != nil || refreshed.Status != want || refreshed.AttemptID != attemptID {
						t.Fatalf("refresh changed the failed/uncertain creation: %+v %v", refreshed, err)
					}
				}
				order, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
				if err != nil || order.Payment.Status != want || order.Payment.PaidAt != nil || auth != 1 || invoices != wantInvoices {
					t.Fatalf("wrong persisted status or request count: %+v %v auth=%d invoices=%d", order.Payment, err, auth, invoices)
				}
				var count int
				var remoteID string
				var captured bool
				if err := p.db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&count); err != nil || count != 1 {
					t.Fatalf("durable attempt not retained: %d %v", count, err)
				}
				if err := p.db.QueryRowContext(ctx, `SELECT remote_id,capture_verified FROM restaurant_payment_attempts WHERE id=$1`, attemptID).Scan(&remoteID, &captured); err != nil || remoteID != "" || captured {
					t.Fatalf("failure acquired invoice/capture evidence: %q %v %v", remoteID, captured, err)
				}
			})
		}
	}
}

func TestRestaurantPaymentsIntegrationPaylinkHistoricalReviewUnchanged(t *testing.T) {
	p, receipt := paylinkFailureFixture(t)
	ctx := context.Background()
	p.adapter = &restaurantPaymentFakeAdapter{create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		// The legacy generic error deliberately supplies no pre-invoice proof.
		return restaurantPaymentRemote{}, restaurantPaymentProviderError()
	}}
	old, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
	if err != nil || old.Status != "review" {
		t.Fatalf("legacy fixture: %+v %v", old, err)
	}
	if _, err := p.db.ExecContext(ctx, `UPDATE restaurant_payment_attempts SET created_at=now()-interval '3 days',updated_at=now()-interval '3 days' WHERE id=$1`, old.AttemptID); err != nil {
		t.Fatal(err)
	}
	var oldUpdated time.Time
	if err := p.db.QueryRowContext(ctx, `SELECT updated_at FROM restaurant_payment_attempts WHERE id=$1`, old.AttemptID).Scan(&oldUpdated); err != nil {
		t.Fatal(err)
	}
	p.adapter = &restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(*http.Request) (*http.Response, error) {
		t.Fatal("historical review made a provider request")
		return nil, errors.New("unexpected request")
	})}}
	for range 3 {
		started, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
		if err != nil || started != old {
			t.Fatalf("historical review replaced: %+v %v", started, err)
		}
		refreshed, err := p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
		if err != nil || refreshed != old {
			t.Fatalf("historical review reclassified: %+v %v", refreshed, err)
		}
	}
	var updated time.Time
	var remoteID string
	if err := p.db.QueryRowContext(ctx, `SELECT updated_at,remote_id FROM restaurant_payment_attempts WHERE id=$1`, old.AttemptID).Scan(&updated, &remoteID); err != nil || updated != oldUpdated || remoteID != "" {
		t.Fatalf("historical payment evidence changed: %v %q %v", updated, remoteID, err)
	}
}

func TestRestaurantPaymentsIntegrationPaylinkFetchAuthFailurePreservesState(t *testing.T) {
	for _, status := range []string{"pending", "paid", "refunded"} {
		for _, failure := range []string{"timeout", "unauthorized", "invalid-token"} {
			t.Run(status+"-"+failure, func(t *testing.T) {
				p, receipt := paylinkFailureFixture(t)
				ctx := context.Background()
				p.adapter = &restaurantPaymentFakeAdapter{create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
					return restaurantPaymentRemote{ID: paylinkTestID, URL: "https://paymentpilot.paylink.sa/pay/info/" + paylinkTestID}, nil
				}}
				view, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
				if err != nil {
					t.Fatal(err)
				}
				a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1`, view.AttemptID))
				if err != nil {
					t.Fatal(err)
				}
				if _, err = p.apply(ctx, a, restaurantPaymentRemote{ID: paylinkTestID, Status: status, Currency: receipt.Order.Currency, AmountMinor: receipt.Order.TotalMinor, Reference: a.ID}, true); err != nil {
					t.Fatal(err)
				}
				calls := 0
				p.adapter = &restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
					calls++
					if r.URL.Path != "/api/auth" {
						t.Fatal("failed auth continued to invoice lookup")
					}
					return paylinkFailureResponse(failure)
				})}}
				view, err = p.Refresh(ctx, receipt.Order.Number, receipt.TrackingToken, "")
				if err == nil || view.Status != status || calls != 1 {
					t.Fatalf("fetch auth changed payment: %+v %v calls=%d", view, err, calls)
				}
				stored, err := p.Status(ctx, receipt.Order.Number, receipt.TrackingToken, "")
				if err != nil || stored.Status != status {
					t.Fatalf("fetch auth reclassified persisted attempt: %+v %v", stored, err)
				}
				var needsRefresh bool
				if err := p.db.QueryRowContext(ctx, `SELECT needs_refresh FROM restaurant_payment_attempts WHERE id=$1`, a.ID).Scan(&needsRefresh); err != nil || !needsRefresh {
					t.Fatalf("failed lookup lost reconciliation intent: %v %v", needsRefresh, err)
				}
			})
		}
	}
}

func TestRestaurantPaymentsIntegrationPaylinkPreInvoiceFailureReturnsGuardedState(t *testing.T) {
	for _, status := range []string{"review", "paid", "refunded"} {
		t.Run(status, func(t *testing.T) {
			p, receipt := paylinkFailureFixture(t)
			ctx := context.Background()
			p.adapter = &restaurantPaymentFakeAdapter{create: func(ctx context.Context, cfg restaurantPaymentConfig, req restaurantPaymentRequest) (restaurantPaymentRemote, error) {
				// Interleave a committed state change after Start inserts creating
				// and before its pre-invoice error is applied. No provider is called.
				a, err := p.readAttempt(p.db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1`, req.AttemptID))
				if err != nil {
					t.Fatal(err)
				}
				if status == "review" {
					_, err = p.apply(ctx, a, restaurantPaymentRemote{Status: "review"}, false)
				} else {
					_, err = p.apply(ctx, a, restaurantPaymentRemote{ID: paylinkTestID, Status: "pending"}, false)
					if err == nil {
						_, err = p.apply(ctx, a, restaurantPaymentRemote{ID: paylinkTestID, Status: status, Currency: receipt.Order.Currency, AmountMinor: receipt.Order.TotalMinor, Reference: a.ID}, true)
					}
				}
				if err != nil {
					t.Fatal(err)
				}
				g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(*http.Request) (*http.Response, error) {
					return paylinkFailureResponse("timeout")
				})}}
				return g.Create(ctx, cfg, req)
			}}
			view, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
			if err != nil || view.Status != status {
				t.Fatalf("Start did not return guarded state: %+v %v", view, err)
			}
			stored, err := p.Status(ctx, receipt.Order.Number, receipt.TrackingToken, "")
			if err != nil || stored.Status != status {
				t.Fatalf("concurrent state overwritten: %+v %v", stored, err)
			}
		})
	}
}

func TestRestaurantPaymentsIntegrationPaylinkFailureTypeCannotReclassifyOtherProvider(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	p.adapter = &restaurantPaymentFakeAdapter{create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
		return restaurantPaymentRemote{}, &restaurantPaylinkNotSubmittedError{cause: restaurantPaymentProviderError()}
	}}
	view, err := p.Start(context.Background(), receipt.Order.Number, receipt.TrackingToken, "", "stripe")
	if err != nil || view.Status != "review" {
		t.Fatalf("Paylink proof escaped its provider scope: %+v %v", view, err)
	}
}

func TestRestaurantPaymentsIntegrationPaylinkPreInvoiceValidationAndCancellation(t *testing.T) {
	for _, failure := range []string{"validation", "canceled-auth"} {
		t.Run(failure, func(t *testing.T) {
			p, receipt := paylinkFailureFixture(t)
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			g := restaurantPaymentGateways{client: &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
				calls++
				if failure != "canceled-auth" || r.URL.Path != "/api/auth" {
					t.Fatal("pre-invoice validation/cancellation reached invoice creation")
				}
				cancel()
				return nil, context.Canceled
			})}}
			p.adapter = &restaurantPaymentFakeAdapter{create: func(ctx context.Context, cfg restaurantPaymentConfig, req restaurantPaymentRequest) (restaurantPaymentRemote, error) {
				if failure == "validation" {
					req.ReturnURL = "http://restaurant.test/invalid"
				}
				return g.Create(ctx, cfg, req)
			}}
			view, err := p.Start(ctx, receipt.Order.Number, receipt.TrackingToken, "", "paylink")
			wantCalls := 0
			if failure == "canceled-auth" {
				wantCalls = 1
			}
			if err != nil || view.Status != "failed" || calls != wantCalls {
				t.Fatalf("pre-invoice failure was not persisted: %+v %v calls=%d", view, err, calls)
			}
			stored, err := p.Status(context.Background(), receipt.Order.Number, receipt.TrackingToken, "")
			if err != nil || stored.Status != "failed" {
				t.Fatalf("failed state lost after request cancellation: %+v %v", stored, err)
			}
		})
	}
}
