package main

import (
	"encoding/json"
	"math"
	"strings"
	"time"
)

// Private immutable collection reducer. It consumes already explicit customer
// choices from a future authenticated conversation controller, NOT free text or
// a model's guessed name/address/payment. It is not persisted or wired live yet.
// Durable CAS and active-review invalidation must wrap it before activation.
type restaurantWhatsappCheckoutCollection struct {
	scope         restaurantWhatsappScope
	first, latest restaurantWhatsappSource
	version       int64
	input         restaurantOrderInput
	events        map[string]string
	expiresAt     time.Time
}
type restaurantWhatsappCheckoutPatch struct {
	Kind                           string
	Mode                           string
	Items                          []restaurantOrderLineInput
	CustomerName, Phone            string
	Address                        *restaurantAddress
	PaymentMethod, PaymentProvider string
	Notes                          string
}

func newRestaurantWhatsappCheckoutCollection(scope restaurantWhatsappScope, source restaurantWhatsappSource, now time.Time) (*restaurantWhatsappCheckoutCollection, error) {
	if err := restaurantWhatsappValidateSource(scope, source, now); err != nil {
		return nil, err
	}
	return &restaurantWhatsappCheckoutCollection{scope: scope, first: source, latest: source, events: map[string]string{}, expiresAt: source.SentAt.Add(15 * time.Minute)}, nil
}

func (s *restaurantWhatsappCheckoutCollection) Apply(scope restaurantWhatsappScope, source restaurantWhatsappSource, expectedVersion int64, patch restaurantWhatsappCheckoutPatch, now time.Time) (*restaurantWhatsappCheckoutCollection, bool, error) {
	if s == nil || scope != s.scope {
		return nil, false, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	if err := restaurantWhatsappValidateSource(scope, source, now); err != nil {
		return nil, false, err
	}
	if !now.Before(s.expiresAt) {
		return nil, false, restaurantFail(409, "whatsapp_message_expired")
	}
	raw, err := json.Marshal(patch)
	if err != nil || len(raw) > 65536 {
		return nil, false, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	event := restaurantWhatsappDigest([]any{scope, source.MessageID})
	payload := restaurantWhatsappDigest([]any{source.SentAt.UTC().Format(time.RFC3339Nano), patch})
	if previous, ok := s.events[event]; ok {
		if previous != payload {
			return nil, false, restaurantFail(409, "whatsapp_message_conflict")
		}
		return s, true, nil // Never restore an old revision or refresh its expiry.
	}
	if source.SentAt.Before(s.latest.SentAt) {
		return nil, false, restaurantFail(409, "whatsapp_message_conflict")
	}
	if expectedVersion != s.version {
		return nil, false, restaurantFail(409, "conflict")
	}
	if len(s.events) >= 100 {
		return nil, false, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	encoded, err := json.Marshal(s.input)
	if err != nil {
		return nil, false, restaurantFail(400, "invalid_request")
	}
	var input restaurantOrderInput
	if json.Unmarshal(encoded, &input) != nil {
		return nil, false, restaurantFail(400, "invalid_request")
	}
	allowed := restaurantWhatsappCheckoutPatch{Kind: patch.Kind}
	switch patch.Kind {
	case "mode":
		allowed.Mode = patch.Mode
		if patch.Mode != "pickup" && patch.Mode != "delivery" {
			return nil, false, restaurantFail(400, "invalid_whatsapp_mode")
		}
		if input.Mode != patch.Mode {
			input.Address = restaurantAddress{}
			input.PaymentMethod = ""
			input.PaymentProvider = ""
		}
		input.Mode = patch.Mode
	case "cart":
		allowed.Items = patch.Items
		proposal, e := newRestaurantWhatsappProposal(scope, source, patch.Items, now)
		if e != nil {
			return nil, false, e
		}
		input.Items = proposal.items
	case "clear_cart":
		input.Items = nil
	case "contact":
		allowed.CustomerName, allowed.Phone = patch.CustomerName, patch.Phone
		name, phone := strings.TrimSpace(patch.CustomerName), restaurantNormalizePhone(strings.TrimSpace(patch.Phone))
		if name == "" || !restaurantOrderText(name, 100, false) {
			return nil, false, restaurantFail(400, "invalid_request")
		}
		if !restaurantOrderPhone(phone) {
			return nil, false, restaurantFail(400, "phone_required")
		}
		input.CustomerName, input.Phone = name, phone
	case "address":
		allowed.Address = patch.Address
		if input.Mode != "delivery" {
			return nil, false, restaurantFail(400, "invalid_whatsapp_mode")
		}
		if patch.Address == nil {
			return nil, false, restaurantFail(400, "invalid_request")
		}
		input.Address = *patch.Address
		input = restaurantNormalizeOrderInput(input)
		if !restaurantWhatsappCollectionAddress(input.Address) {
			return nil, false, restaurantFail(400, "invalid_request")
		}
	case "payment":
		allowed.PaymentMethod, allowed.PaymentProvider = patch.PaymentMethod, patch.PaymentProvider
		if input.Mode == "" || !restaurantWhatsappOpaque(patch.PaymentMethod) || (patch.PaymentMethod == "card" && !restaurantWhatsappOpaque(patch.PaymentProvider)) || (patch.PaymentMethod != "card" && patch.PaymentProvider != "") {
			return nil, false, restaurantFail(400, "invalid_request")
		}
		// The original core, not this reducer, checks currently available providers.
		input.PaymentMethod, input.PaymentProvider = patch.PaymentMethod, patch.PaymentProvider
	case "notes":
		allowed.Notes = patch.Notes
		if !restaurantOrderText(patch.Notes, 1000, true) {
			return nil, false, restaurantFail(400, "invalid_request")
		}
		input.Notes = strings.TrimSpace(patch.Notes)
	default:
		return nil, false, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	// Reject ambiguous multi-field commands rather than silently ignoring fields.
	if restaurantWhatsappDigest(allowed) != restaurantWhatsappDigest(patch) {
		return nil, false, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	input.ExpectedTotalMinor = 0
	input.ExpectedQuoteHash = ""
	input.TableCode = ""
	// Deep copy address coordinates and caller-owned slices before storing state.
	encoded, err = json.Marshal(input)
	if err != nil {
		return nil, false, restaurantFail(400, "invalid_request")
	}
	var frozen restaurantOrderInput
	if err = json.Unmarshal(encoded, &frozen); err != nil {
		return nil, false, restaurantFail(400, "invalid_request")
	}
	input = frozen
	events := make(map[string]string, len(s.events)+1)
	for key, value := range s.events {
		events[key] = value
	}
	events[event] = payload
	return &restaurantWhatsappCheckoutCollection{scope: s.scope, first: s.first, latest: source, version: s.version + 1, input: input, events: events, expiresAt: s.expiresAt}, false, nil
}

func restaurantWhatsappCollectionAddress(a restaurantAddress) bool {
	if len(a.Country) != 2 {
		return false
	}
	for _, v := range []string{a.RegionID, a.CityID, a.DistrictID, a.ID} {
		if v != "" && !restaurantWhatsappOpaque(v) {
			return false
		}
	}
	for _, v := range []string{a.Label, a.City, a.District, a.Street, a.Building, a.PostalCode, a.AdditionalNumber, a.NationalAddress, a.AddressLine, a.Area} {
		if !restaurantOrderText(v, 1000, false) {
			return false
		}
	}
	if (a.Latitude == nil) != (a.Longitude == nil) {
		return false
	}
	if a.Latitude != nil && (math.IsNaN(*a.Latitude) || math.IsInf(*a.Latitude, 0) || *a.Latitude < -90 || *a.Latitude > 90 || math.IsNaN(*a.Longitude) || math.IsInf(*a.Longitude, 0) || *a.Longitude < -180 || *a.Longitude > 180) {
		return false
	}
	return true
}

// A ready collection is NOT an accepted checkout: original-core coverage,
// catalogue, stock, opening, tax, payment and quote checks remain mandatory.
// No phone is derived from the peer JID and no payment or address is defaulted.
func (s *restaurantWhatsappCheckoutCollection) Snapshot(scope restaurantWhatsappScope, now time.Time) (restaurantOrderInput, []string, error) {
	if s == nil || scope != s.scope {
		return restaurantOrderInput{}, nil, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	if now.IsZero() || !now.Before(s.expiresAt) || s.first.SentAt.After(now.Add(30*time.Second)) {
		return restaurantOrderInput{}, nil, restaurantFail(409, "whatsapp_message_expired")
	}
	missing := []string{}
	if s.input.Mode == "" {
		missing = append(missing, "mode")
	}
	if len(s.input.Items) == 0 {
		missing = append(missing, "cart")
	}
	if s.input.CustomerName == "" || s.input.Phone == "" {
		missing = append(missing, "contact")
	}
	if s.input.Mode == "delivery" && s.input.Address.Country == "" {
		missing = append(missing, "address")
	}
	if s.input.PaymentMethod == "" {
		missing = append(missing, "payment")
	}
	raw, err := json.Marshal(s.input)
	if err != nil {
		return restaurantOrderInput{}, nil, restaurantFail(400, "invalid_request")
	}
	var input restaurantOrderInput
	if json.Unmarshal(raw, &input) != nil {
		return restaurantOrderInput{}, nil, restaurantFail(400, "invalid_request")
	}
	return input, missing, nil
}
