package main

import (
	"context"
	"database/sql"
)

// nil means unconfigured, not free. An explicit zero is valid free delivery.
// These rules live in the versioned catalog, so catalog/order locking also
// protects coverage and fees. Historical order fees remain immutable snapshots.
type restaurantDeliveryZone struct {
	DistrictID string `json:"districtId"`
	Enabled    bool   `json:"enabled"`
	FeeMinor   *int64 `json:"feeMinor"`
}

func restaurantValidateDeliveryZoneSettings(settings restaurantSettings) error {
	if settings.DeliveryPricingMode != "" && settings.DeliveryPricingMode != "flat" && settings.DeliveryPricingMode != "district" {
		return restaurantFail(400, "invalid_delivery_zones")
	}
	if len(settings.DeliveryZones) > 10000 {
		return restaurantFail(400, "invalid_delivery_zones")
	}
	seen := map[string]bool{}
	for _, zone := range settings.DeliveryZones {
		if !restaurantIDPattern.MatchString(zone.DistrictID) || seen[zone.DistrictID] || zone.FeeMinor != nil && (*zone.FeeMinor < 0 || *zone.FeeMinor > restaurantMaxMinor) || zone.Enabled && zone.FeeMinor == nil {
			return restaurantFail(400, "invalid_delivery_zones")
		}
		seen[zone.DistrictID] = true
	}
	return nil
}

// Caller holds the catalog lock first. Geography edits/imports never acquire a
// catalog lock, which preserves lock order and avoids deadlocks with orders.
func restaurantValidateDeliveryZones(ctx context.Context, q restaurantCatalogQueryer, settings restaurantSettings) error {
	if err := restaurantValidateDeliveryZoneSettings(settings); err != nil {
		return err
	}
	if len(settings.DeliveryZones) == 0 {
		return nil
	}
	if _, err := restaurantGeographyVersion(ctx, q, true); err != nil {
		return err
	}
	for _, zone := range settings.DeliveryZones {
		var exists bool
		// Retired zones can be disabled without discarding their configured fee.
		// Enabling delivery requires the entire hierarchy to remain active.
		err := q.QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM restaurant_geography_entities d
			JOIN restaurant_geography_entities c ON c.id=d.parent_id AND c.kind='city'
			JOIN restaurant_geography_entities r ON r.id=c.parent_id AND r.kind='region'
			WHERE d.id=$1 AND d.kind='district' AND (NOT $2 OR (d.active AND c.active AND r.active)))`, zone.DistrictID, zone.Enabled).Scan(&exists)
		if err != nil {
			return err
		}
		if !exists {
			return restaurantFail(400, "invalid_delivery_zones")
		}
	}
	return nil
}

func restaurantDeliveryFee(settings restaurantSettings, address restaurantAddress) (int64, error) {
	if settings.DeliveryPricingMode == "" || settings.DeliveryPricingMode == "flat" {
		return settings.DeliveryFeeMinor, nil
	}
	if settings.DeliveryPricingMode != "district" {
		return 0, restaurantFail(409, "delivery_unavailable")
	}
	if address.DistrictID == "" || address.CityID == "" || address.RegionID == "" {
		return 0, restaurantFail(400, "district_required")
	}
	for _, zone := range settings.DeliveryZones {
		if zone.DistrictID != address.DistrictID {
			continue
		}
		if !zone.Enabled || zone.FeeMinor == nil {
			return 0, restaurantFail(409, "outside_delivery_area")
		}
		if *zone.FeeMinor < 0 || *zone.FeeMinor > restaurantMaxMinor {
			return 0, restaurantFail(409, "delivery_unavailable")
		}
		return *zone.FeeMinor, nil
	}
	return 0, restaurantFail(409, "outside_delivery_area")
}

// Run AFTER idempotent retry lookup and hashing the original normalized input.
// Never hash these resolved labels: a later local name correction must not
// invalidate an otherwise identical retry. lock=true only inside order tx.
func restaurantCanonicalDeliveryInput(ctx context.Context, q restaurantCatalogQueryer, input restaurantOrderInput, lock bool) (restaurantOrderInput, error) {
	if input.Mode != "delivery" {
		return input, nil
	}
	a := &input.Address
	if a.RegionID == "" && a.CityID == "" && a.DistrictID == "" {
		return input, nil
	}
	if !restaurantIDPattern.MatchString(a.RegionID) || !restaurantIDPattern.MatchString(a.CityID) || !restaurantIDPattern.MatchString(a.DistrictID) {
		return input, restaurantFail(400, "invalid_district")
	}
	if _, err := restaurantGeographyVersion(ctx, q, lock); err != nil {
		return input, err
	}
	var city, district string
	err := q.QueryRowContext(ctx, `SELECT COALESCE(c.local_name_ar,c.name_ar),COALESCE(d.local_name_ar,d.name_ar)
		FROM restaurant_geography_entities d JOIN restaurant_geography_entities c ON c.id=d.parent_id
		JOIN restaurant_geography_entities r ON r.id=c.parent_id
		WHERE d.id=$1 AND c.id=$2 AND r.id=$3 AND d.kind='district' AND c.kind='city' AND r.kind='region'
		AND d.active=TRUE AND c.active=TRUE AND r.active=TRUE`, a.DistrictID, a.CityID, a.RegionID).Scan(&city, &district)
	if err == sql.ErrNoRows {
		return input, restaurantFail(400, "invalid_district")
	}
	if err != nil {
		return input, err
	}
	a.City, a.District, a.Area = city, district, district
	return input, nil
}
