package main

import "net/http"

func (s *server) registerRestaurantBrandRoutes(admin *http.ServeMux) {
	admin.HandleFunc("GET /api/restaurant/brand", func(w http.ResponseWriter, r *http.Request) {
		state, err := s.restaurant.BrandState(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	admin.HandleFunc("PUT /api/restaurant/brand/draft", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Version int64           `json:"version"`
			Brand   restaurantBrand `json:"brand"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		state, err := s.restaurant.SaveBrandDraft(r.Context(), in.Version, in.Brand)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, state)
	})
	for _, action := range []string{"publish", "revert"} {
		admin.HandleFunc("POST /api/restaurant/brand/"+action, func(w http.ResponseWriter, r *http.Request) {
			var in struct {
				Version int64 `json:"version"`
			}
			if !decodeRestaurantBody(w, r, &in) {
				return
			}
			state, err := s.restaurant.PublishBrand(r.Context(), in.Version, action == "revert")
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, state)
		})
	}
}
