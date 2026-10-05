package main

import "net/http"

// Root mounts this mux behind the same-origin/rate-limit public guard. Every
// read additionally proves receipt-token or customer-account ownership.
func (s *server) registerRestaurantLocationPublicRoutes(pub *http.ServeMux) {
	pub.HandleFunc("GET /storefront-api/orders/{number}/location", func(w http.ResponseWriter, r *http.Request) {
		if s.couriers == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		customer, _, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		result, err := s.couriers.Location(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), customer.ID, false)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, result)
	})
}
