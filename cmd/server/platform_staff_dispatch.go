package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
)

type platformStaffCourier struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Active       bool   `json:"active"`
	Availability string `json:"availability"`
}

// Roster and assignment require dispatch authority. A courier's delivery-read
// permission alone cannot enumerate the other drivers or assign arbitrary work.
func (s *server) registerPlatformStaffDispatchRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/couriers", wrap("staff:delivery:assign", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		couriers, err := s.couriers.List(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		rows := make([]platformStaffCourier, 0, len(couriers))
		for _, c := range couriers {
			rows = append(rows, platformStaffCourier{c.ID, c.Name, c.Active, c.Availability})
		}
		writeJSON(w, 200, map[string]any{"couriers": rows, "limit": 500})
	}))
	mux.HandleFunc("POST /platform-api/staff/orders/{number}/courier", wrap("staff:delivery:assign", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		var input struct {
			CourierID *string `json:"courierId"`
			Version   *int64  `json:"version"`
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		if input.CourierID == nil || input.Version == nil {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:delivery:assign"})
		order, err := s.couriers.Assign(ctx, r.PathValue("number"), *input.CourierID, *input.Version)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, staffOrderSummary(order))
	}))
}
