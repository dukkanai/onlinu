package main

import (
	"net/http"
	"strings"
	"time"
)

func restaurantCourierCookieName() string {
	return "restaurant_courier_" + strings.TrimPrefix(restaurantSessionCookieName(), "restaurant_customer_")
}

func restaurantCourierToken(r *http.Request) string {
	cookie, err := r.Cookie(restaurantCourierCookieName())
	if err != nil {
		return ""
	}
	return cookie.Value
}

func setRestaurantCourierCookie(w http.ResponseWriter, r *http.Request, token string) {
	maxAge := int(restaurantCustomerSessionLifetime / time.Second)
	expires := time.Now().Add(restaurantCustomerSessionLifetime)
	if token == "" {
		maxAge = -1
		expires = time.Unix(1, 0)
	}
	http.SetCookie(w, &http.Cookie{Name: restaurantCourierCookieName(), Value: token, Path: "/courier-api", HttpOnly: true, Secure: restaurantSecureCookie(r), SameSite: http.SameSiteLaxMode, MaxAge: maxAge, Expires: expires})
}

// Root supplies the existing bounded same-origin/rate-limited guards. The
// administrator guard additionally requires the master header, not a widget
// key or query-string credential. No public courier handler reads that key.
func (s *server) registerRestaurantCourierRoutes(mux *http.ServeMux, adminGuard, courierGuard func(http.Handler) http.Handler) {
	add := func(pattern string, admin bool, handler http.HandlerFunc) {
		ready := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if s.couriers == nil {
				writeRestaurantError(w, restaurantFail(503, "server_error"))
				return
			}
			handler(w, r)
		})
		if admin {
			mux.Handle(pattern, adminGuard(ready))
		} else {
			mux.Handle(pattern, courierGuard(ready))
		}
	}
	requireCourier := func(w http.ResponseWriter, r *http.Request) (restaurantCourier, bool) {
		courier, ok, err := s.couriers.Authenticate(r.Context(), restaurantCourierToken(r))
		if err != nil {
			writeRestaurantError(w, err)
			return restaurantCourier{}, false
		}
		if !ok {
			writeRestaurantError(w, restaurantFail(401, "unauthorized"))
			return restaurantCourier{}, false
		}
		return courier, true
	}
	add("GET /api/restaurant/couriers", true, func(w http.ResponseWriter, r *http.Request) {
		couriers, err := s.couriers.List(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"couriers": couriers})
	})
	add("POST /api/restaurant/couriers", true, func(w http.ResponseWriter, r *http.Request) {
		var input restaurantCourierCreateInput
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		courier, err := s.couriers.Create(r.Context(), input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 201, map[string]any{"courier": courier})
	})
	add("PATCH /api/restaurant/couriers/{id}", true, func(w http.ResponseWriter, r *http.Request) {
		var input restaurantCourierAdminUpdate
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		courier, err := s.couriers.Update(r.Context(), r.PathValue("id"), input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"courier": courier})
	})
	add("POST /api/restaurant/orders/{number}/courier", true, func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			CourierID string `json:"courierId"`
			Version   int64  `json:"version"`
		}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		order, err := s.couriers.Assign(r.Context(), r.PathValue("number"), input.CourierID, input.Version)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, order)
	})
	add("GET /courier-api/account", false, func(w http.ResponseWriter, r *http.Request) {
		courier, ok, err := s.couriers.Authenticate(r.Context(), restaurantCourierToken(r))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if !ok {
			writeJSON(w, 200, map[string]any{"courier": nil})
			return
		}
		writeJSON(w, 200, map[string]any{"courier": courier})
	})
	add("POST /courier-api/login", false, func(w http.ResponseWriter, r *http.Request) {
		var input struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		courier, token, err := s.couriers.Login(r.Context(), input.Username, input.Password)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		setRestaurantCourierCookie(w, r, token)
		writeJSON(w, 200, map[string]any{"courier": courier})
	})
	add("POST /courier-api/logout", false, func(w http.ResponseWriter, r *http.Request) {
		var input struct{}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		if err := s.couriers.Logout(r.Context(), restaurantCourierToken(r)); err != nil {
			writeRestaurantError(w, err)
			return
		}
		setRestaurantCourierCookie(w, r, "")
		w.WriteHeader(http.StatusNoContent)
	})
	add("PATCH /courier-api/account", false, func(w http.ResponseWriter, r *http.Request) {
		courier, ok := requireCourier(w, r)
		if !ok {
			return
		}
		var input struct {
			Availability string `json:"availability"`
		}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		courier, err := s.couriers.SetAvailability(r.Context(), courier.ID, input.Availability)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"courier": courier})
	})
	add("GET /courier-api/orders", false, func(w http.ResponseWriter, r *http.Request) {
		courier, ok := requireCourier(w, r)
		if !ok {
			return
		}
		orders, err := s.couriers.ListOrders(r.Context(), courier.ID)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"orders": orders})
	})
	add("GET /api/restaurant/orders/{number}/location", true, func(w http.ResponseWriter, r *http.Request) {
		result, err := s.couriers.Location(r.Context(), r.PathValue("number"), "", "", true)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, result)
	})
	add("POST /courier-api/orders/{number}/location", false, func(w http.ResponseWriter, r *http.Request) {
		courier, ok := requireCourier(w, r)
		if !ok {
			return
		}
		var input restaurantLocationInput
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		result, err := s.couriers.PublishLocation(r.Context(), courier.ID, r.PathValue("number"), input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, result)
	})
	add("DELETE /courier-api/orders/{number}/location", false, func(w http.ResponseWriter, r *http.Request) {
		courier, ok := requireCourier(w, r)
		if !ok {
			return
		}
		var input struct {
			Version int64 `json:"version"`
		}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		if input.Version < 1 {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		if err := s.couriers.StopLocation(r.Context(), courier.ID, r.PathValue("number")); err != nil {
			writeRestaurantError(w, err)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	add("PATCH /courier-api/orders/{number}", false, func(w http.ResponseWriter, r *http.Request) {
		courier, ok := requireCourier(w, r)
		if !ok {
			return
		}
		var input struct {
			Status      string `json:"status"`
			Version     int64  `json:"version"`
			CollectCash bool   `json:"collectCash"`
		}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		order, err := s.couriers.UpdateOrder(r.Context(), courier.ID, r.PathValue("number"), input.Status, input.Version, input.CollectCash)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, order)
	})
}
