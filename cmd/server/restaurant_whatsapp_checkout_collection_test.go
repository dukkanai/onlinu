package main

import (
	"fmt"
	"math"
	"reflect"
	"testing"
	"time"
)

func whatsappCollectionFixture(t *testing.T) (*restaurantWhatsappCheckoutCollection, restaurantWhatsappScope, time.Time) {
	t.Helper()
	scope, source, _, now := whatsappProposalFixture()
	collection, err := newRestaurantWhatsappCheckoutCollection(scope, source, now)
	if err != nil {
		t.Fatal(err)
	}
	return collection, scope, now
}
func collectionApply(t *testing.T, s *restaurantWhatsappCheckoutCollection, p restaurantWhatsappCheckoutPatch, now time.Time) *restaurantWhatsappCheckoutCollection {
	t.Helper()
	source := restaurantWhatsappSource{MessageID: fmt.Sprintf("step-%d", s.version+1), SentAt: now.Add(time.Duration(s.version) * time.Second)}
	next, duplicate, err := s.Apply(s.scope, source, s.version, p, source.SentAt)
	if err != nil || duplicate {
		t.Fatal("collection update", duplicate, err)
	}
	return next
}
func TestRestaurantWhatsappCheckoutCollectsExplicitChoices(t *testing.T) {
	original, scope, now := whatsappCollectionFixture(t)
	initial, missing, err := original.Snapshot(scope, now)
	if err != nil || len(missing) != 4 || initial.Phone != "" || initial.Mode != "" || initial.PaymentMethod != "" {
		t.Fatal("inferred choices", missing, err)
	}
	s := collectionApply(t, original, restaurantWhatsappCheckoutPatch{Kind: "mode", Mode: "pickup"}, now)
	items := []restaurantOrderLineInput{{ItemID: "rice", Quantity: 2, OptionIDs: []string{"free"}}}
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "cart", Items: items}, now)
	items[0].Quantity = 99
	items[0].OptionIDs[0] = "changed"
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "contact", CustomerName: "  Synthetic student  ", Phone: "+٩٦٦٥٠١٢٣٤٥٦٧"}, now)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "payment", PaymentMethod: "card", PaymentProvider: "stripe"}, now)
	ready, missing, err := s.Snapshot(scope, now.Add(time.Minute))
	if err != nil || len(missing) != 0 || ready.Phone != "+966501234567" || ready.CustomerName != "Synthetic student" || ready.Items[0].Quantity != 2 || ready.Items[0].OptionIDs[0] != "free" || ready.ExpectedTotalMinor != 0 || ready.ExpectedQuoteHash != "" {
		t.Fatal("incorrect ready collection", missing, err)
	}
	ready.Items[0].Quantity = 90
	again, _, _ := s.Snapshot(scope, now.Add(time.Minute))
	if again.Items[0].Quantity != 2 {
		t.Fatal("snapshot leaked mutable state")
	}
	initial, missing, err = original.Snapshot(scope, now)
	if original.version != 0 || len(initial.Items) != 0 || len(missing) != 4 || err != nil {
		t.Fatal("old revision mutated")
	}
}
func TestRestaurantWhatsappCheckoutReplayVersionAndExpiry(t *testing.T) {
	s, scope, now := whatsappCollectionFixture(t)
	source := restaurantWhatsappSource{MessageID: "selection", SentAt: now}
	patch := restaurantWhatsappCheckoutPatch{Kind: "mode", Mode: "pickup"}
	first, _, err := s.Apply(scope, source, 0, patch, now)
	if err != nil {
		t.Fatal(err)
	}
	replay, duplicate, err := first.Apply(scope, source, 0, patch, now.Add(time.Minute))
	if err != nil || !duplicate || replay != first || !replay.expiresAt.Equal(s.expiresAt) {
		t.Fatal("retry changed state", err)
	}
	changed := patch
	changed.Mode = "delivery"
	if _, _, err = first.Apply(scope, source, 1, changed, now); err == nil {
		t.Fatal("changed duplicate accepted")
	}
	source.MessageID = "new"
	if _, _, err = first.Apply(scope, source, 0, patch, now); err == nil {
		t.Fatal("stale version accepted")
	}
	source.SentAt = now.Add(-time.Second)
	if _, _, err = first.Apply(scope, source, 1, patch, now); err == nil {
		t.Fatal("out-of-order overwrite accepted")
	}
	expired := s.expiresAt
	source.SentAt = expired
	if _, _, err = first.Apply(scope, source, 1, patch, expired); err == nil {
		t.Fatal("fresh message silently renewed expired collection")
	}
	foreign := scope
	foreign.Generation = "other"
	if _, _, err = first.Apply(foreign, source, 1, patch, now); err == nil {
		t.Fatal("foreign binding accepted")
	}
}
func TestRestaurantWhatsappCheckoutModeClearsHiddenSelections(t *testing.T) {
	s, scope, now := whatsappCollectionFixture(t)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "mode", Mode: "delivery"}, now)
	lat, lon := 24.7, 46.7
	address := &restaurantAddress{Country: "SA", NationalAddress: "ABCD1234", Latitude: &lat, Longitude: &lon}
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "address", Address: address}, now)
	lat = 0
	address.NationalAddress = "changed"
	saved, _, err := s.Snapshot(scope, now.Add(time.Minute))
	if err != nil || saved.Address.Latitude == nil || *saved.Address.Latitude != 24.7 || saved.Address.NationalAddress != "ABCD1234" {
		t.Fatal("input address alias survived", err)
	}
	*saved.Address.Latitude = 1
	saved, _, _ = s.Snapshot(scope, now.Add(time.Minute))
	if *saved.Address.Latitude != 24.7 {
		t.Fatal("output address alias survived")
	}
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "payment", PaymentMethod: "card", PaymentProvider: "stripe"}, now)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "mode", Mode: "pickup"}, now)
	saved, missing, _ := s.Snapshot(scope, now.Add(time.Minute))
	if !reflect.DeepEqual(saved.Address, restaurantAddress{}) || saved.PaymentMethod != "" || saved.PaymentProvider != "" {
		t.Fatal("hidden delivery/payment survived", missing)
	}
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "mode", Mode: "delivery"}, now)
	saved, missing, _ = s.Snapshot(scope, now.Add(time.Minute))
	if saved.Address.Country != "" {
		t.Fatal("old address resurrected")
	}
	found := false
	for _, field := range missing {
		if field == "address" {
			found = true
		}
	}
	if !found {
		t.Fatal("address not requested again")
	}
}
func TestRestaurantWhatsappCheckoutRejectsAmbiguousOrInvalidPatches(t *testing.T) {
	s, _, now := whatsappCollectionFixture(t)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "mode", Mode: "delivery"}, now)
	nan, lon := math.NaN(), 10.0
	for _, patch := range []restaurantWhatsappCheckoutPatch{
		{Kind: "mode", Mode: "pickup", Notes: "unexpected second command"},
		{Kind: "mode", Mode: "table"},
		{Kind: "contact", CustomerName: "Synthetic", Phone: "77777@lid"},
		{Kind: "contact", CustomerName: " ", Phone: "+966501234567"},
		{Kind: "address", Address: &restaurantAddress{Country: "SA", Latitude: &nan, Longitude: &lon}},
		{Kind: "address", Address: &restaurantAddress{Country: "SA", Longitude: &lon}},
		{Kind: "payment", PaymentMethod: "card"},
		{Kind: "payment", PaymentMethod: "cash_on_delivery", PaymentProvider: "stripe"},
		{Kind: "cart", Items: []restaurantOrderLineInput{{ItemID: "rice", Quantity: 0}}},
		{Kind: "notes", Notes: "invalid\x00note"},
		{Kind: "confirm"},
	} {
		source := restaurantWhatsappSource{MessageID: "invalid", SentAt: now.Add(time.Second)}
		if _, _, err := s.Apply(s.scope, source, s.version, patch, source.SentAt); err == nil {
			t.Fatal("invalid patch accepted", patch.Kind)
		}
	}
	if s.version != 1 || len(s.events) != 1 {
		t.Fatal("failed updates changed previous state")
	}
}

func TestRestaurantWhatsappCheckoutUsesOriginalPricingAndBoundsHistory(t *testing.T) {
	s, scope, now := whatsappCollectionFixture(t)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "mode", Mode: "delivery"}, now)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "cart", Items: []restaurantOrderLineInput{{ItemID: "rice", Quantity: 1, OptionIDs: []string{"extra", "free"}}}}, now)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "contact", CustomerName: "Synthetic guest", Phone: "+966501234567"}, now)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "address", Address: &restaurantAddress{Country: "SA", NationalAddress: "ABCD1234"}}, now)
	s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "payment", PaymentMethod: "cash_on_delivery"}, now)
	input, missing, err := s.Snapshot(scope, now.Add(time.Minute))
	if err != nil || len(missing) != 0 {
		t.Fatal(missing, err)
	}
	catalog := restaurantOrderFixtureCatalog()
	quote, err := restaurantPriceOrder(catalog, input)
	if err != nil || quote.TotalMinor != 2000 {
		t.Fatal("original pricing mismatch", quote.TotalMinor, err)
	}
	catalog.Items[0].PriceMinor += 100
	changed, err := restaurantPriceOrder(catalog, input)
	if err != nil || changed.TotalMinor != 2100 || input.ExpectedTotalMinor != 0 || input.ExpectedQuoteHash != "" {
		t.Fatal("collector overrode authoritative price", err)
	}
	catalog.Items[0].Options[0].Available = false
	if _, err = restaurantPriceOrder(catalog, input); err == nil {
		t.Fatal("ready collection bypassed original option availability")
	}
	expiry := s.expiresAt
	for s.version < 100 {
		s = collectionApply(t, s, restaurantWhatsappCheckoutPatch{Kind: "notes", Notes: fmt.Sprintf("explicit note %d", s.version)}, now)
	}
	if !s.expiresAt.Equal(expiry) {
		t.Fatal("updates extended collection expiry")
	}
	source := restaurantWhatsappSource{MessageID: "overflow", SentAt: now.Add(100 * time.Second)}
	if _, _, err = s.Apply(scope, source, s.version, restaurantWhatsappCheckoutPatch{Kind: "notes"}, source.SentAt); err == nil {
		t.Fatal("unbounded history accepted")
	}
}
