package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
)

func (s *server) registerPlatformStaffDeliveryRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/delivery", wrap("staff:settings:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		view, err := s.orders.store.StaffDelivery(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, view)
	}))
	for _, action := range []string{"pricing", "zone"} {
		mux.HandleFunc("POST /platform-api/staff/delivery/"+action, wrap("staff:settings:update", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
			if r.URL.RawQuery != "" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:settings:update"})
			var view restaurantStaffDelivery
			var err error
			if action == "pricing" {
				var input restaurantDeliveryPricingPatch
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				view, err = s.orders.store.PatchDeliveryPricing(ctx, input)
			} else {
				var input restaurantDeliveryZonePatch
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				view, err = s.orders.store.PatchDeliveryZone(ctx, input)
			}
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, view)
		}))
	}
	for _, kind := range []string{"regions", "cities", "districts"} {
		path := "GET /platform-api/staff/geography/" + kind
		if kind != "regions" {
			path += "/{parent}"
		}
		mux.HandleFunc(path, wrap("staff:settings:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
			if r.URL.RawQuery != "" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			region, city := "", ""
			if kind == "cities" {
				region = r.PathValue("parent")
			}
			if kind == "districts" {
				city = r.PathValue("parent")
			}
			view, err := s.orders.store.GetGeography(r.Context(), kind, region, city, false)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, view)
		}))
	}
}
