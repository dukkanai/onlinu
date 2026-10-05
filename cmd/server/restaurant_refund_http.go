package main

import (
	"database/sql"
	"errors"
	"net/http"
)

// Root mounts these muxes behind the existing administrative credential and
// same-origin/body/rate-limit guards. Read access never authorizes a refund.
func (s *server) registerRestaurantRefundRoutes(pub, admin *http.ServeMux) {
	available := func(w http.ResponseWriter) bool {
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return false
		}
		return true
	}
	respond := func(w http.ResponseWriter, value any, err error) {
		if errors.Is(err, sql.ErrNoRows) {
			err = restaurantFail(404, "invalid_order_access")
		}
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}
	admin.HandleFunc("GET /api/restaurant/orders/{number}/refunds", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		v, e := s.payments.Refunds(r.Context(), r.PathValue("number"))
		respond(w, v, e)
	})
	admin.HandleFunc("POST /api/restaurant/orders/{number}/refunds", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		var in restaurantRefundInput
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, e := s.payments.RequestRefund(r.Context(), r.PathValue("number"), in)
		respond(w, v, e)
	})
	admin.HandleFunc("POST /api/restaurant/orders/{number}/refunds/{id}/manual", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		var in restaurantRefundResolution
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, e := s.payments.ResolveRefundManual(r.Context(), r.PathValue("number"), r.PathValue("id"), in)
		respond(w, v, e)
	})
	admin.HandleFunc("POST /api/restaurant/orders/{number}/refunds/{id}/verify-reference", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		var in restaurantRefundResolution
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, e := s.payments.ConfirmRefundReference(r.Context(), r.PathValue("number"), r.PathValue("id"), in)
		respond(w, v, e)
	})
	admin.HandleFunc("POST /api/restaurant/orders/{number}/refunds/{id}/execute", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		var in struct {
			Version int64 `json:"version"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, e := s.payments.AuthorizeRefund(r.Context(), r.PathValue("number"), r.PathValue("id"), in.Version)
		respond(w, v, e)
	})
	admin.HandleFunc("POST /api/restaurant/orders/{number}/refunds/{id}/refresh", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		var in struct{}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, e := s.payments.RefreshRefund(r.Context(), r.PathValue("number"), r.PathValue("id"))
		respond(w, v, e)
	})
	pub.HandleFunc("GET /storefront-api/orders/{number}/refunds", func(w http.ResponseWriter, r *http.Request) {
		if !available(w) {
			return
		}
		customer, _, err := s.restaurantCustomer(r)
		if err != nil {
			respond(w, nil, err)
			return
		}
		if _, err = s.orders.Track(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), "", customer.ID); err != nil {
			respond(w, nil, err)
			return
		}
		v, err := s.payments.Refunds(r.Context(), r.PathValue("number"))
		if err != nil {
			respond(w, nil, err)
			return
		}
		// No operator notes, provider credentials/responses, internal request
		// keys, authorization state or manually entered transfer references.
		list := []map[string]any{}
		for _, item := range v.Refunds {
			list = append(list, map[string]any{"id": item.ID, "status": item.Status, "provider": item.Provider, "currency": item.Currency, "amountMinor": item.AmountMinor, "taxMinor": item.TaxMinor, "confirmation": item.Confirmation, "createdAt": item.CreatedAt, "updatedAt": item.UpdatedAt})
		}
		writeJSON(w, 200, map[string]any{"refunds": list, "capturedMinor": v.CapturedMinor, "reservedMinor": v.ReservedMinor, "refundedMinor": v.RefundedMinor, "availableMinor": v.AvailableMinor, "capability": v.Capability})
	})
}
