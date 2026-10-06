package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
)

// Delivery coverage/pricing only. Order snapshots and the remaining settings
// stay in the original catalogue; a disabled/unconfigured zone is never free.
type restaurantStaffDelivery struct {
	Version         int64                         `json:"version"`
	Currency        string                        `json:"currency"`
	Mode            string                        `json:"mode"`
	FeeMinor        int64                         `json:"feeMinor"`
	MinimumMinor    int64                         `json:"minimumMinor"`
	Enabled         bool                          `json:"enabled"`
	AcceptingOrders bool                          `json:"acceptingOrders"`
	RequireLocation bool                          `json:"requireLocation"`
	Latitude        *float64                      `json:"latitude"`
	Longitude       *float64                      `json:"longitude"`
	RadiusKm        float64                       `json:"radiusKm"`
	Zones           []restaurantStaffDeliveryZone `json:"zones"`
}
type restaurantStaffDeliveryZone struct {
	restaurantDeliveryZone
	NameAr     string `json:"nameAr"`
	NameEn     string `json:"nameEn"`
	CityName   string `json:"cityName"`
	RegionName string `json:"regionName"`
	Active     bool   `json:"active"`
}
type restaurantDeliveryPricingPatch struct {
	ExpectedVersion int64  `json:"expectedVersion"`
	Mode            string `json:"mode"`
	FeeMinor        *int64 `json:"feeMinor"`
	MinimumMinor    *int64 `json:"minimumMinor"`
}
type restaurantDeliveryZonePatch struct {
	ExpectedVersion int64                       `json:"expectedVersion"`
	Zone            restaurantDeliveryZoneInput `json:"zone"`
}

type restaurantDeliveryZoneInput struct {
	DistrictID string `json:"districtId"`
	Enabled    *bool  `json:"enabled"`
	FeeMinor   *int64 `json:"feeMinor"`
}

func (s *restaurantStore) staffDeliveryView(ctx context.Context, c restaurantCatalog) (restaurantStaffDelivery, error) {
	settings := c.Settings
	mode := settings.DeliveryPricingMode
	if mode == "" {
		mode = "flat"
	}
	zones := make([]restaurantStaffDeliveryZone, 0, len(settings.DeliveryZones))
	ids := []string{}
	for _, zone := range settings.DeliveryZones {
		zones = append(zones, restaurantStaffDeliveryZone{restaurantDeliveryZone: zone})
		ids = append(ids, zone.DistrictID)
	}
	view := restaurantStaffDelivery{
		Version: c.Version, Currency: settings.Currency, Mode: mode,
		FeeMinor: settings.DeliveryFeeMinor, MinimumMinor: settings.DeliveryMinimumMinor,
		Enabled: settings.DeliveryEnabled, AcceptingOrders: settings.AcceptingOrders,
		RequireLocation: settings.RequireDeliveryLocation, RadiusKm: settings.DeliveryRadiusKm,
		Latitude: settings.Latitude, Longitude: settings.Longitude, Zones: zones,
	}
	if len(ids) == 0 {
		return view, nil
	}
	encoded, _ := json.Marshal(ids)
	// Names are descriptive metadata, not quoted prices or authority. The original
	// SaveCatalog transaction revalidates current active geography before a write.
	rows, err := s.db.QueryContext(ctx, `SELECT d.id,COALESCE(d.local_name_ar,d.name_ar),COALESCE(d.local_name_en,d.name_en),COALESCE(c.local_name_ar,c.name_ar,''),COALESCE(r.local_name_ar,r.name_ar,''),d.active AND COALESCE(c.active,FALSE) AND COALESCE(r.active,FALSE)
 FROM restaurant_geography_entities d LEFT JOIN restaurant_geography_entities c ON c.id=d.parent_id AND c.kind='city'
 LEFT JOIN restaurant_geography_entities r ON r.id=d.region_id AND r.kind='region'
 WHERE d.kind='district' AND d.id IN (SELECT jsonb_array_elements_text($1::jsonb))`, string(encoded))
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	defer rows.Close()
	positions := map[string]int{}
	for i, zone := range zones {
		positions[zone.DistrictID] = i
	}
	for rows.Next() {
		var id, ar, en, city, region string
		var active bool
		if err = rows.Scan(&id, &ar, &en, &city, &region, &active); err != nil {
			return restaurantStaffDelivery{}, err
		}
		if i, ok := positions[id]; ok {
			view.Zones[i].NameAr = ar
			view.Zones[i].NameEn = en
			view.Zones[i].CityName = city
			view.Zones[i].RegionName = region
			view.Zones[i].Active = active
		}
	}
	if err = rows.Err(); err != nil {
		return restaurantStaffDelivery{}, err
	}
	return view, nil
}
func (s *restaurantStore) StaffDelivery(ctx context.Context) (restaurantStaffDelivery, error) {
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	return s.staffDeliveryView(ctx, c)
}
func (s *restaurantStore) PatchDeliveryPricing(ctx context.Context, p restaurantDeliveryPricingPatch) (restaurantStaffDelivery, error) {
	if p.ExpectedVersion < 1 || p.Mode != "flat" && p.Mode != "district" || p.FeeMinor == nil || p.MinimumMinor == nil || *p.FeeMinor < 0 || *p.FeeMinor > restaurantMaxMinor || *p.MinimumMinor < 0 || *p.MinimumMinor > restaurantMaxMinor {
		return restaurantStaffDelivery{}, restaurantFail(400, "invalid_request")
	}
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	if c.Version != p.ExpectedVersion {
		return restaurantStaffDelivery{}, restaurantFail(409, "catalog_changed")
	}
	c.Settings.DeliveryPricingMode = p.Mode
	c.Settings.DeliveryFeeMinor = *p.FeeMinor
	c.Settings.DeliveryMinimumMinor = *p.MinimumMinor
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{Kind: "delivery_pricing_update"})
	saved, err := s.SaveCatalog(ctx, c)
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	return s.staffDeliveryView(ctx, saved)
}
func (s *restaurantStore) PatchDeliveryZone(ctx context.Context, p restaurantDeliveryZonePatch) (restaurantStaffDelivery, error) {
	if p.ExpectedVersion < 1 || p.Zone.Enabled == nil || !restaurantIDPattern.MatchString(p.Zone.DistrictID) {
		return restaurantStaffDelivery{}, restaurantFail(400, "invalid_request")
	}
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	if c.Version != p.ExpectedVersion {
		return restaurantStaffDelivery{}, restaurantFail(409, "catalog_changed")
	}
	zone := restaurantDeliveryZone{DistrictID: p.Zone.DistrictID, Enabled: *p.Zone.Enabled, FeeMinor: p.Zone.FeeMinor}
	found := false
	for i := range c.Settings.DeliveryZones {
		if c.Settings.DeliveryZones[i].DistrictID == p.Zone.DistrictID {
			c.Settings.DeliveryZones[i] = zone
			found = true
			break
		}
	}
	if !found {
		c.Settings.DeliveryZones = append(c.Settings.DeliveryZones, zone)
	}
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{Kind: "delivery_zone_update", ID: p.Zone.DistrictID})
	saved, err := s.SaveCatalog(ctx, c)
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	return s.staffDeliveryView(ctx, saved)
}

// An omitted origin preserves both coordinates; explicit null clears both.
// The existing catalogue remains the sole authority for pricing and coverage.
type restaurantDeliveryLocationPatch struct {
	ExpectedVersion int64           `json:"expectedVersion"`
	Origin          json.RawMessage `json:"origin"`
	RadiusKm        *float64        `json:"radiusKm"`
	RequireLocation *bool           `json:"requireLocation"`
}
type restaurantDeliveryOrigin struct {
	Latitude  *float64 `json:"latitude"`
	Longitude *float64 `json:"longitude"`
}

func (p restaurantDeliveryLocationPatch) origin() (*restaurantDeliveryOrigin, error) {
	invalid := func() (*restaurantDeliveryOrigin, error) { return nil, restaurantFail(400, "invalid_request") }
	if p.ExpectedVersion < 1 || len(p.Origin) == 0 && p.RadiusKm == nil && p.RequireLocation == nil {
		return invalid()
	}
	if p.RadiusKm != nil && (math.IsNaN(*p.RadiusKm) || math.IsInf(*p.RadiusKm, 0) || *p.RadiusKm < 0 || *p.RadiusKm > 500) {
		return invalid()
	}
	if len(p.Origin) == 0 || bytes.Equal(bytes.TrimSpace(p.Origin), []byte("null")) {
		return nil, nil
	}
	var origin restaurantDeliveryOrigin
	decoder := json.NewDecoder(bytes.NewReader(p.Origin))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&origin); err != nil {
		return invalid()
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF || origin.Latitude == nil || origin.Longitude == nil || !restaurantCoordinatesValid(*origin.Latitude, *origin.Longitude) {
		return invalid()
	}
	return &origin, nil
}

func (s *restaurantStore) PatchDeliveryLocation(ctx context.Context, p restaurantDeliveryLocationPatch) (restaurantStaffDelivery, error) {
	origin, err := p.origin()
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	if c.Version != p.ExpectedVersion {
		return restaurantStaffDelivery{}, restaurantFail(409, "catalog_changed")
	}
	if len(p.Origin) != 0 {
		c.Settings.Latitude, c.Settings.Longitude = nil, nil
		if origin != nil {
			c.Settings.Latitude, c.Settings.Longitude = origin.Latitude, origin.Longitude
		}
	}
	if p.RadiusKm != nil {
		c.Settings.DeliveryRadiusKm = *p.RadiusKm
	}
	if p.RequireLocation != nil {
		c.Settings.RequireDeliveryLocation = *p.RequireLocation
	}
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{Kind: "delivery_location_update"})
	saved, err := s.SaveCatalog(ctx, c)
	if err != nil {
		return restaurantStaffDelivery{}, err
	}
	return s.staffDeliveryView(ctx, saved)
}
