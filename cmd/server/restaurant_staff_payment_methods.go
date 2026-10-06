package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
)

// Configured checkout methods, not provider credentials or a promise of live
// availability. The original quote/payment checks remain authoritative.
type restaurantStaffPaymentMethods struct {
	Version  int64                        `json:"version"`
	Currency string                       `json:"currency"`
	Demo     bool                         `json:"demo"`
	Modes    []restaurantStaffPaymentMode `json:"modes"`
}
type restaurantStaffPaymentMode struct {
	Mode    string   `json:"mode"`
	Enabled bool     `json:"enabled"`
	Methods []string `json:"methods"`
}
type restaurantPaymentMethodsPatch struct {
	ExpectedVersion int64    `json:"expectedVersion"`
	Mode            string   `json:"mode"`
	Methods         []string `json:"methods"`
}

func (p restaurantPaymentMethodsPatch) validate() error {
	if p.ExpectedVersion < 1 || p.Mode != "delivery" && p.Mode != "pickup" && p.Mode != "table" || p.Methods == nil || len(p.Methods) > 3 {
		return restaurantFail(400, "invalid_request")
	}
	seen := map[string]bool{}
	for _, method := range p.Methods {
		if seen[method] || method != "card" && !restaurantCashMethod(p.Mode, method) {
			return restaurantFail(400, "invalid_request")
		}
		seen[method] = true
	}
	return nil
}
func staffPaymentMethodsView(c restaurantCatalog) restaurantStaffPaymentMethods {
	settings := c.Settings
	view := restaurantStaffPaymentMethods{Version: c.Version, Currency: settings.Currency, Demo: settings.Demo, Modes: []restaurantStaffPaymentMode{}}
	for _, mode := range []string{"delivery", "pickup", "table"} {
		enabled := mode == "delivery" && settings.DeliveryEnabled || mode == "pickup" && settings.PickupEnabled || mode == "table" && settings.TableEnabled
		view.Modes = append(view.Modes, restaurantStaffPaymentMode{Mode: mode, Enabled: enabled, Methods: restaurantPaymentMethodsForMode(settings, mode)})
	}
	return view
}
func (s *restaurantStore) StaffPaymentMethods(ctx context.Context) (restaurantStaffPaymentMethods, error) {
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffPaymentMethods{}, err
	}
	return staffPaymentMethodsView(c), nil
}
func (s *restaurantStore) PatchPaymentMethods(ctx context.Context, p restaurantPaymentMethodsPatch) (restaurantStaffPaymentMethods, error) {
	if err := p.validate(); err != nil {
		return restaurantStaffPaymentMethods{}, err
	}
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffPaymentMethods{}, err
	}
	if c.Version != p.ExpectedVersion {
		return restaurantStaffPaymentMethods{}, restaurantFail(409, "catalog_changed")
	}
	if !restaurantValidPaymentMethods(c.Settings) {
		return restaurantStaffPaymentMethods{}, restaurantFail(400, "invalid_request")
	}
	c.Settings.PaymentMethods[p.Mode] = append([]string{}, p.Methods...)
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{Kind: "payment_methods_update", ID: p.Mode})
	saved, err := s.SaveCatalog(ctx, c)
	if err != nil {
		return restaurantStaffPaymentMethods{}, err
	}
	return staffPaymentMethodsView(saved), nil
}
func (s *server) registerPlatformStaffPaymentMethodsRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/payment-methods", wrap("staff:settings:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		view, err := s.orders.store.StaffPaymentMethods(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, view)
	}))
	mux.HandleFunc("POST /platform-api/staff/payment-methods", wrap("staff:settings:update", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		var input restaurantPaymentMethodsPatch
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:settings:update"})
		view, err := s.orders.store.PatchPaymentMethods(ctx, input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, view)
	}))
}
