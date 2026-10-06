package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
)

// Configuration of the existing gross-inclusive calculation, not a tax-law
// determination or a certified invoice. Historical order snapshots are immutable.
type restaurantStaffTax struct {
	Version          int64  `json:"version"`
	Enabled          bool   `json:"enabled"`
	RateBps          int64  `json:"rateBps"`
	TaxNumber        string `json:"taxNumber"`
	Currency         string `json:"currency"`
	PricesIncludeTax bool   `json:"pricesIncludeTax"`
}
type restaurantTaxPatch struct {
	ExpectedVersion int64   `json:"expectedVersion"`
	Reviewed        bool    `json:"reviewed"`
	Enabled         *bool   `json:"enabled"`
	RateBps         *int64  `json:"rateBps"`
	TaxNumber       *string `json:"taxNumber"`
}

func staffTaxView(c restaurantCatalog) restaurantStaffTax {
	return restaurantStaffTax{c.Version, c.Settings.TaxEnabled, c.Settings.TaxRateBps, c.Settings.TaxNumber, c.Settings.Currency, true}
}
func (s *restaurantStore) StaffTax(ctx context.Context) (restaurantStaffTax, error) {
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffTax{}, err
	}
	return staffTaxView(c), nil
}
func (s *restaurantStore) PatchTax(ctx context.Context, p restaurantTaxPatch) (restaurantStaffTax, error) {
	if p.ExpectedVersion < 1 || p.ExpectedVersion > 9007199254740990 || !p.Reviewed || p.Enabled == nil || p.RateBps == nil || p.TaxNumber == nil {
		return restaurantStaffTax{}, restaurantFail(400, "invalid_request")
	}
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffTax{}, err
	}
	if c.Version != p.ExpectedVersion {
		return restaurantStaffTax{}, restaurantFail(409, "catalog_changed")
	}
	c.Settings.TaxEnabled, c.Settings.TaxRateBps, c.Settings.TaxNumber = *p.Enabled, *p.RateBps, *p.TaxNumber
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{Kind: "tax_update"})
	// SaveCatalog retains original validation, row-lock CAS and actor audit. Only
	// future quotes change; neither historical orders nor menu gross prices change.
	saved, err := s.SaveCatalog(ctx, c)
	if err != nil {
		return restaurantStaffTax{}, err
	}
	return staffTaxView(saved), nil
}
func (s *server) registerPlatformStaffTaxRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/tax", wrap("staff:tax:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		value, err := s.orders.store.StaffTax(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
	mux.HandleFunc("POST /platform-api/staff/tax", wrap("staff:tax:update", func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		var input restaurantTaxPatch
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:tax:update"})
		value, err := s.orders.store.PatchTax(ctx, input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
}
