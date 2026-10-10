package main

import (
	"io"
	"net/http"
	"time"
)

// Root mounts pub/admin with the normal restaurant guards; hooks have separate
// bounded/rate-limited routing without browser CSRF. An opaque route is not proof
// of payment: every notification re-queries the persisted provider transaction.
func (s *server) registerRestaurantPaymentHandlers(pub, admin, hooks *http.ServeMux) {
	// Some gateways return the browser with POST, others with GET. Discard all
	// supplied result fields and convert both to a local safe GET; never settle.
	for _, method := range []string{"GET", "POST"} {
		hooks.HandleFunc(method+" /payment-hooks/return/{attempt}", func(w http.ResponseWriter, r *http.Request) {
			id := r.PathValue("attempt")
			if len(id) != 36 || !restaurantPaymentID.MatchString(id) {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			if _, err := io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 256*1024)); err != nil {
				writeRestaurantError(w, restaurantFail(413, "invalid_request"))
				return
			}
			http.Redirect(w, r, "/payment-return?attempt="+id, http.StatusSeeOther)
		})
	}
	admin.HandleFunc("GET /api/restaurant/payments", func(w http.ResponseWriter, r *http.Request) {
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		v, err := s.payments.Admin(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		reconciliation, err := s.payments.ReconciliationSummary(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"providers": v, "reconciliation": reconciliation})
	})
	admin.HandleFunc("PUT /api/restaurant/payments/{provider}", func(w http.ResponseWriter, r *http.Request) {
		var in restaurantPaymentConfigInput
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		v, err := s.payments.Configure(r.Context(), r.PathValue("provider"), in)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	pub.HandleFunc("GET /storefront-api/payments", func(w http.ResponseWriter, r *http.Request) {
		if s.payments == nil {
			writeJSON(w, 200, map[string]any{"providers": []any{}})
			return
		}
		currency := r.URL.Query().Get("currency")
		if currency == "" {
			c, err := s.restaurant.GetCatalog(r.Context(), true)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			currency = c.Settings.Currency
		}
		v, err := s.payments.Public(r.Context(), currency)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"providers": v})
	})
	for _, method := range []string{"GET", "POST"} {
		pub.HandleFunc(method+" /storefront-api/orders/{number}/payment", func(w http.ResponseWriter, r *http.Request) {
			// ServeMux also sends HEAD requests to GET patterns. Reject anything
			// except the explicit read/start methods before auth or body parsing.
			switch r.Method {
			case http.MethodGet, http.MethodPost:
			default:
				w.Header().Set("Allow", "GET, POST")
				writeRestaurantError(w, restaurantFail(http.StatusMethodNotAllowed, "method_not_allowed"))
				return
			}
			if s.payments == nil {
				writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
				return
			}
			c, _, err := s.restaurantCustomer(r)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			var v restaurantPaymentView
			switch r.Method {
			case http.MethodGet:
				v, err = s.payments.Status(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), c.ID)
			case http.MethodPost:
				var in struct {
					Provider string `json:"provider"`
				}
				if !decodeRestaurantBody(w, r, &in) {
					return
				}
				v, err = s.payments.Start(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), c.ID, in.Provider)
			}
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, v)
		})
	}
	pub.HandleFunc("POST /storefront-api/orders/{number}/payment/refresh", func(w http.ResponseWriter, r *http.Request) {
		var in struct{}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		c, _, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		v, err := s.payments.Refresh(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), c.ID)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	hooks.HandleFunc("POST /payment-hooks/{provider}/{attempt}", func(w http.ResponseWriter, r *http.Request) {
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		if _, err := io.Copy(io.Discard, http.MaxBytesReader(w, r.Body, 256*1024)); err != nil {
			writeRestaurantError(w, restaurantFail(413, "invalid_request"))
			return
		}
		if err := s.payments.Hook(r.Context(), r.PathValue("provider"), r.PathValue("attempt")); err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"received": true})
	})
	// Read exactly once and verify the raw bytes before any event routing. The
	// handler acknowledges committed local inbox work; it never calls Stripe.
	hooks.HandleFunc("POST /payment-hooks/stripe", func(w http.ResponseWriter, r *http.Request) {
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 256*1024))
		if err != nil {
			writeRestaurantError(w, restaurantFail(413, "invalid_request"))
			return
		}
		if len(r.Header.Values("Stripe-Signature")) != 1 {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		if err = s.payments.receiveStripeWebhook(r.Context(), raw, r.Header.Get("Stripe-Signature"), time.Now()); err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]bool{"received": true})
	})
}
