package main

import "net/http"

// These handlers live under the same master-header / same-origin / rate-limited
// guards as the existing restaurant endpoints. An order number is never auth.
func (s *server) registerRestaurantCompletionRoutes(pub, admin *http.ServeMux) {
	admin.HandleFunc("GET /api/restaurant/stock", func(w http.ResponseWriter, r *http.Request) {
		items, err := s.orders.ListStock(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"items": items})
	})
	admin.HandleFunc("PUT /api/restaurant/stock/{itemId}", func(w http.ResponseWriter, r *http.Request) {
		var input restaurantStockInput
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		item, err := s.orders.SaveStock(r.Context(), r.PathValue("itemId"), input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, item)
	})
	requestSupport := func(complaint bool) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			var input struct {
				Reason  string `json:"reason"`
				Version int64  `json:"version"`
			}
			if !decodeRestaurantBody(w, r, &input) {
				return
			}
			customer, _, err := s.restaurantCustomer(r)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			var order restaurantOrder
			if complaint {
				order, err = s.orders.ReportComplaint(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), "", customer.ID, input.Reason, r.Header.Get("Idempotency-Key"), input.Version)
			} else {
				order, err = s.orders.RequestCancellation(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), "", customer.ID, input.Reason, r.Header.Get("Idempotency-Key"), input.Version)
			}
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, order)
		}
	}
	pub.HandleFunc("POST /storefront-api/orders/{number}/cancel", requestSupport(false))
	pub.HandleFunc("POST /storefront-api/orders/{number}/complaints", requestSupport(true))
	admin.HandleFunc("POST /api/restaurant/orders/{number}/cancel-decision", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Approve bool   `json:"approve"`
			Reason  string `json:"reason"`
			Version int64  `json:"version"`
		}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		order, err := s.orders.DecideCancellation(r.Context(), r.PathValue("number"), input.Reason, input.Approve, input.Version)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, order)
	})
	admin.HandleFunc("POST /api/restaurant/orders/{number}/complaints/{id}/resolve", func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Reason  string `json:"reason"`
			Version int64  `json:"version"`
		}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		order, err := s.orders.ResolveComplaint(r.Context(), r.PathValue("number"), r.PathValue("id"), input.Reason, input.Version)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, order)
	})
}
