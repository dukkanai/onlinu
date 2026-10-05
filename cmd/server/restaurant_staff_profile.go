package main

import "context"

// Public business text only: no payment configuration, tax identifiers, table
// capabilities, appearance drafts, channel switches or delivery-price rules.
type restaurantStaffProfile struct {
	Version            int64  `json:"version"`
	Name               string `json:"name"`
	Description        string `json:"description"`
	Address            string `json:"address"`
	Phone              string `json:"phone"`
	OpeningHours       string `json:"openingHours"`
	PickupInstructions string `json:"pickupInstructions"`
}
type restaurantProfilePatch struct {
	ExpectedVersion    int64   `json:"expectedVersion"`
	Name               *string `json:"name"`
	Description        *string `json:"description"`
	Address            *string `json:"address"`
	Phone              *string `json:"phone"`
	OpeningHours       *string `json:"openingHours"`
	PickupInstructions *string `json:"pickupInstructions"`
}

func staffProfileView(c restaurantCatalog) restaurantStaffProfile {
	s := c.Settings
	return restaurantStaffProfile{c.Version, s.Name, s.Description, s.Address, s.Phone, s.OpeningHours, s.PickupInstructions}
}
func (s *restaurantStore) StaffProfile(ctx context.Context) (restaurantStaffProfile, error) {
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffProfile{}, err
	}
	return staffProfileView(c), nil
}
func (s *restaurantStore) PatchProfile(ctx context.Context, p restaurantProfilePatch) (restaurantStaffProfile, error) {
	if p.ExpectedVersion < 1 || p.Name == nil && p.Description == nil && p.Address == nil && p.Phone == nil && p.OpeningHours == nil && p.PickupInstructions == nil {
		return restaurantStaffProfile{}, restaurantFail(400, "invalid_request")
	}
	c, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantStaffProfile{}, err
	}
	if c.Version != p.ExpectedVersion {
		return restaurantStaffProfile{}, restaurantFail(409, "catalog_changed")
	}
	if p.Name != nil {
		c.Settings.Name = *p.Name
	}
	if p.Description != nil {
		c.Settings.Description = *p.Description
	}
	if p.Address != nil {
		c.Settings.Address = *p.Address
	}
	if p.Phone != nil {
		c.Settings.Phone = *p.Phone
	}
	if p.OpeningHours != nil {
		c.Settings.OpeningHours = *p.OpeningHours
	}
	if p.PickupInstructions != nil {
		c.Settings.PickupInstructions = *p.PickupInstructions
	}
	// Reuse original validation, row-lock CAS, table capability preservation and
	// transactional audit. Never replace the full settings document from a client.
	ctx = context.WithValue(ctx, restaurantMenuTargetKey{}, restaurantMenuTarget{Kind: "profile_update"})
	saved, err := s.SaveCatalog(ctx, c)
	if err != nil {
		return restaurantStaffProfile{}, err
	}
	return staffProfileView(saved), nil
}
