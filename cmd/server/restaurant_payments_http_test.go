package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
)

type restaurantPaymentBodyProbe struct {
	io.Reader
	reads int
}

func (p *restaurantPaymentBodyProbe) Read(b []byte) (int, error) {
	p.reads++
	return p.Reader.Read(b)
}

// Reject every database/provider call without opening a socket. This proves
// unsupported methods cannot create attempts even without a PostgreSQL fixture.
type restaurantPaymentBackendProbe struct{ calls int }

func (p *restaurantPaymentBackendProbe) Open(string) (driver.Conn, error) {
	p.calls++
	return nil, errors.New("unexpected payment database access")
}
func (p *restaurantPaymentBackendProbe) Connect(context.Context) (driver.Conn, error) {
	return p.Open("")
}
func (p *restaurantPaymentBackendProbe) Driver() driver.Driver { return p }
func (p *restaurantPaymentBackendProbe) Create(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
	p.calls++
	return restaurantPaymentRemote{}, errors.New("unexpected payment provider creation")
}
func (p *restaurantPaymentBackendProbe) Fetch(context.Context, restaurantPaymentConfig, string, string) (restaurantPaymentRemote, error) {
	p.calls++
	return restaurantPaymentRemote{}, errors.New("unexpected payment provider query")
}

func TestRestaurantPaymentHTTPRejectsUnsupportedMethods(t *testing.T) {
	const path = "/storefront-api/orders/synthetic-order/payment"
	// Canonical base64url for 32 synthetic zero bytes, never a real session.
	sessionToken := strings.Repeat("A", 43)
	if _, valid := restaurantCustomerTokenDigest(sessionToken); !valid {
		t.Fatal("authentication probe token must have a valid session-token shape")
	}
	for _, configured := range []bool{false, true} {
		name := "unavailable"
		s := &server{}
		backend := &restaurantPaymentBackendProbe{}
		if configured {
			name = "configured"
			db := sql.OpenDB(backend)
			t.Cleanup(func() { _ = db.Close() })
			s.customers = &restaurantAccounts{db: db}
			s.payments = &restaurantPayments{db: db, adapter: backend, orders: &restaurantOrders{store: &restaurantStore{db: db}}}
		}
		t.Run(name, func(t *testing.T) {
			pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
			s.registerRestaurantPaymentHandlers(pub, admin, hooks)
			get, _ := pub.Handler(httptest.NewRequest(http.MethodGet, path, nil))
			post, _ := pub.Handler(httptest.NewRequest(http.MethodPost, path, nil))
			for _, route := range []struct {
				name    string
				handler http.Handler
			}{{"mux", pub}, {"GET-handler", get}, {"POST-handler", post}} {
				t.Run(route.name, func(t *testing.T) {
					for _, method := range []string{http.MethodHead, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, http.MethodTrace, http.MethodConnect, "PROPFIND", "get", "post"} {
						t.Run(method, func(t *testing.T) {
							for _, body := range []string{`{"provider":"stripe"}`, "", `{"provider":`} {
								for _, session := range []string{"", sessionToken} {
									probe := &restaurantPaymentBodyProbe{Reader: strings.NewReader(body)}
									r := httptest.NewRequest(method, path, probe)
									r.Header.Set("Content-Type", "application/json")
									r.Header.Set("X-Order-Token", "synthetic-order-token")
									if session != "" {
										r.AddCookie(&http.Cookie{Name: restaurantSessionCookieName(), Value: session})
									}
									w := httptest.NewRecorder()
									route.handler.ServeHTTP(w, r)
									if w.Code != http.StatusMethodNotAllowed || probe.reads != 0 || backend.calls != 0 {
										t.Fatalf("method %s: status=%d, body reads=%d, backend calls=%d; want 405 without body reads or backend calls", method, w.Code, probe.reads, backend.calls)
									}
									if route.name != "mux" || method == http.MethodHead {
										if got := w.Header().Get("Allow"); got != "GET, POST" {
											t.Fatalf("Allow=%q, want GET, POST", got)
										}
									}
									_ = r.Body.Close()
								}
							}
						})
					}
				})
			}
			if configured {
				t.Run("authentication-probe", func(t *testing.T) {
					// Positive control: the same cookie on an allowed method must
					// reach authentication's database query, before parsing a body.
					probe := &restaurantPaymentBodyProbe{Reader: strings.NewReader(`{"provider":"stripe"}`)}
					r := httptest.NewRequest(http.MethodGet, path, probe)
					r.AddCookie(&http.Cookie{Name: restaurantSessionCookieName(), Value: sessionToken})
					w := httptest.NewRecorder()
					pub.ServeHTTP(w, r)
					if w.Code != http.StatusInternalServerError || backend.calls != 1 || probe.reads != 0 {
						t.Fatalf("authentication positive control: status=%d backend calls=%d body reads=%d", w.Code, backend.calls, probe.reads)
					}
					_ = r.Body.Close()
				})
			}
		})
	}
}

func TestRestaurantPaymentsIntegrationHTTPOnlyPostStartsPayment(t *testing.T) {
	p, receipt := restaurantPaymentFixture(t)
	ctx := context.Background()
	creates, fetches := 0, 0
	p.adapter = &restaurantPaymentFakeAdapter{
		create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			creates++
			return restaurantPaymentRemote{ID: "cs_test_method_dispatch", URL: "https://checkout.stripe.com/c/pay/cs_test_method_dispatch"}, nil
		},
		fetch: func(context.Context, restaurantPaymentConfig, string, string) (restaurantPaymentRemote, error) {
			fetches++
			return restaurantPaymentRemote{}, nil
		},
	}
	s := &server{payments: p}
	pub, admin, hooks := http.NewServeMux(), http.NewServeMux(), http.NewServeMux()
	s.registerRestaurantPaymentHandlers(pub, admin, hooks)
	path := "/storefront-api/orders/" + receipt.Order.Number + "/payment"
	request := func(method string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(`{"provider":"stripe"}`))
		r.Header.Set("Content-Type", "application/json")
		r.Header.Set("X-Order-Token", receipt.TrackingToken)
		w := httptest.NewRecorder()
		pub.ServeHTTP(w, r)
		return w
	}
	order := func(t *testing.T) restaurantOrder {
		t.Helper()
		o, err := p.orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
		if err != nil {
			t.Fatal(err)
		}
		return o
	}
	checkUnchanged := func(t *testing.T, wantOrder restaurantOrder, wantAttempts, wantCreates int) {
		t.Helper()
		var attempts int
		if err := p.db.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_payment_attempts WHERE order_number=$1`, receipt.Order.Number).Scan(&attempts); err != nil {
			t.Fatal(err)
		}
		if attempts != wantAttempts || creates != wantCreates || fetches != 0 || !reflect.DeepEqual(order(t), wantOrder) {
			t.Fatalf("unexpected payment side effects: attempts=%d creates=%d fetches=%d", attempts, creates, fetches)
		}
	}
	for _, stage := range []string{"unstarted", "started"} {
		t.Run(stage, func(t *testing.T) {
			wantAttempts := 0
			if stage == "started" {
				wantAttempts = 1
				view := restaurantDecodeResponse[restaurantPaymentView](t, request(http.MethodPost), http.StatusOK)
				if view.AttemptID == "" || view.Status != "pending" || creates != 1 {
					t.Fatalf("POST did not start exactly one payment: %+v creates=%d", view, creates)
				}
			}
			before := order(t)
			for _, method := range []string{http.MethodHead, http.MethodPut, http.MethodPatch, http.MethodDelete, http.MethodOptions, http.MethodTrace, http.MethodConnect, "PROPFIND", "get", "post"} {
				for range 2 {
					if w := request(method); w.Code != http.StatusMethodNotAllowed {
						t.Fatalf("%s accepted: status=%d body=%s", method, w.Code, w.Body.String())
					}
					checkUnchanged(t, before, wantAttempts, wantAttempts)
				}
			}
			view := restaurantDecodeResponse[restaurantPaymentView](t, request(http.MethodGet), http.StatusOK)
			if view.Status != before.Payment.Status {
				t.Fatalf("GET returned status %q, want %q", view.Status, before.Payment.Status)
			}
			checkUnchanged(t, before, wantAttempts, wantAttempts)
		})
	}
}
