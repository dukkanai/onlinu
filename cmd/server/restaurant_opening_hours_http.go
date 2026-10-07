package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
)

func (s *server) registerPlatformOpeningRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/opening-schedule", wrap("staff:settings:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		result, err := s.orders.store.OpeningSchedule(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}))
	mux.HandleFunc("POST /platform-api/staff/opening-schedule", wrap("staff:settings:update", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		var patch restaurantOpeningPatch
		r.Body = io.NopCloser(bytes.NewReader(body))
		if !decodeRestaurantBody(w, r, &patch) {
			return
		}
		ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:settings:update"})
		result, err := s.orders.store.PatchOpeningSchedule(ctx, patch)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	}))
}
