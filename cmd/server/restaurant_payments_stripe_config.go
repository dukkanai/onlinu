package main

import (
	"context"
	"net/http"
	"regexp"

	"github.com/google/uuid"
)

// Account and snapshot-event acceptance must use the same reviewed API version.
// Source wiring alone does not authorize connecting or enabling a real account.
const restaurantStripeAPIVersion = "2026-09-30.endive"

var restaurantStripeAccountID = regexp.MustCompile(`^acct_[A-Za-z0-9]{1,196}$`)

// Partial, disabled configuration may be saved, but no supplied sandbox field
// may select live mode, a foreign country, or an unreviewed API version.
func restaurantStripeSandboxFieldsValid(c restaurantPaymentConfig) error {
	invalid := func() error { return restaurantFail(400, "invalid_request") }
	if c.ID != "stripe" || c.Mode != "test" {
		return invalid()
	}
	if key := c.Secrets["secretKey"]; key != "" && restaurantStripeSandboxConfigValid(c) != nil {
		return invalid()
	}
	if secret := c.Secrets["webhookSecret"]; secret != "" && !restaurantStripeSigningSecret.MatchString(secret) {
		return invalid()
	}
	if pilot := c.Values["sandboxPilot"]; pilot != "" && pilot != "true" && pilot != "false" {
		return invalid()
	}
	if account := c.Values["accountID"]; account != "" && !restaurantStripeAccountID.MatchString(account) {
		return invalid()
	}
	if country := c.Values["country"]; country != "" && country != "US" {
		return invalid()
	}
	if version := c.Values["apiVersion"]; version != "" && version != restaurantStripeAPIVersion {
		return invalid()
	}
	if generation := c.Values["sandboxGeneration"]; generation != "" {
		id, err := uuid.Parse(generation)
		if err != nil || id == uuid.Nil || id.String() != generation {
			return invalid()
		}
	}
	return nil
}

func restaurantStripeSandboxComplete(c restaurantPaymentConfig) bool {
	return restaurantStripeSandboxFieldsValid(c) == nil && restaurantStripeSandboxConfigValid(c) == nil &&
		c.Values["sandboxPilot"] == "true" && restaurantStripeAccountID.MatchString(c.Values["accountID"]) &&
		c.Values["country"] == "US" && c.Values["apiVersion"] == restaurantStripeAPIVersion &&
		restaurantStripeSigningSecret.MatchString(c.Secrets["webhookSecret"])
}

// Enabled controls new checkouts separately. Immutable attempt snapshots remain
// eligible for authoritative reads after the current configuration is disabled.
func restaurantStripeSandboxReady(c restaurantPaymentConfig) error {
	if !restaurantStripeSandboxComplete(c) || c.Values["sandboxGeneration"] == "" {
		return restaurantFail(400, "invalid_request")
	}
	return nil
}

// A test-key prefix does not identify its account. Check the exact own-account
// identity before every checkout operation, with no Connect or context headers.
// The later secure pilot must confirm this read permission on its restricted key.
func (g *restaurantPaymentGateways) verifyStripeSandboxAccount(ctx context.Context, c restaurantPaymentConfig) error {
	if restaurantStripeSandboxReady(c) != nil {
		return restaurantPaymentProviderError()
	}
	var account struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Country string `json:"country"`
	}
	if err := g.request(ctx, http.MethodGet, "https://api.stripe.com/v1/account", "Bearer "+c.Secrets["secretKey"], "", nil, &account, map[string]string{"Stripe-Version": restaurantStripeAPIVersion}); err != nil {
		return err
	}
	if account.ID != c.Values["accountID"] || account.Object != "account" || account.Country != "US" {
		return restaurantPaymentProviderError()
	}
	return nil
}
