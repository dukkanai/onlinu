package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
)

// Service switches affect future order acceptance. They do not cancel existing
// orders, alter prices/tax/payment configuration, or rotate table capabilities.
type restaurantStaffService struct {
	Version         int64 `json:"version"`
	AcceptingOrders bool  `json:"acceptingOrders"`
	DeliveryEnabled bool  `json:"deliveryEnabled"`
	PickupEnabled   bool  `json:"pickupEnabled"`
	TableEnabled    bool  `json:"tableEnabled"`
}
type restaurantServicePatch struct {
	ExpectedVersion int64 `json:"expectedVersion"`
	AcceptingOrders *bool `json:"acceptingOrders"`
	DeliveryEnabled *bool `json:"deliveryEnabled"`
	PickupEnabled   *bool `json:"pickupEnabled"`
	TableEnabled    *bool `json:"tableEnabled"`
}

func staffServiceView(c restaurantCatalog) restaurantStaffService {
	s := c.Settings
	return restaurantStaffService{c.Version, s.AcceptingOrders, s.DeliveryEnabled, s.PickupEnabled, s.TableEnabled}
}
func (s *restaurantStore) StaffService(ctx context.Context) (restaurantStaffService, error) {
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffService{}, err
	}
	return staffServiceView(c), nil
}
func (s *restaurantStore) PatchService(ctx context.Context, p restaurantServicePatch) (restaurantStaffService, error) {
	if p.ExpectedVersion < 1 || p.AcceptingOrders == nil && p.DeliveryEnabled == nil && p.PickupEnabled == nil && p.TableEnabled == nil {
		return restaurantStaffService{}, restaurantFail(400, "invalid_request")
	}
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffService{}, err
	}
	if c.Version != p.ExpectedVersion {
		return restaurantStaffService{}, restaurantFail(409, "catalog_changed")
	}
	if p.AcceptingOrders != nil {
		c.Settings.AcceptingOrders = *p.AcceptingOrders
	}
	if p.DeliveryEnabled != nil {
		c.Settings.DeliveryEnabled = *p.DeliveryEnabled
	}
	if p.PickupEnabled != nil {
		c.Settings.PickupEnabled = *p.PickupEnabled
	}
	if p.TableEnabled != nil {
		c.Settings.TableEnabled = *p.TableEnabled
	}
	if c.Settings.AcceptingOrders && !c.Settings.DeliveryEnabled && !c.Settings.PickupEnabled && !c.Settings.TableEnabled {
		return restaurantStaffService{}, restaurantFail(400, "invalid_service_modes")
	}
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{Kind: "service_update"})
	saved, err := s.SaveCatalog(ctx, c)
	if err != nil {
		return restaurantStaffService{}, err
	}
	return staffServiceView(saved), nil
}
func (s *server) registerPlatformStaffServiceRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/service", wrap("staff:settings:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		value, err := s.orders.store.StaffService(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
	mux.HandleFunc("POST /platform-api/staff/service", wrap("staff:settings:update", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		var input restaurantServicePatch
		r.Body = io.NopCloser(bytes.NewReader(body))
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:settings:update"})
		value, err := s.orders.store.PatchService(ctx, input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
}
