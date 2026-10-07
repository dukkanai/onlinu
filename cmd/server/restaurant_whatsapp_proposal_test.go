package main

import (
	"context"
	"reflect"
	"strings"
	"testing"
	"time"
)

func whatsappProposalFixture() (restaurantWhatsappScope, restaurantWhatsappSource, []restaurantOrderLineInput, time.Time) {
	now := time.Date(2026, 10, 7, 12, 0, 0, 0, time.UTC)
	return restaurantWhatsappScope{RestaurantID: "tenant-test", Channel: "whatsapp_qr", ConnectionID: "session-test", Generation: "link-generation-test", PeerID: "peer-test"}, restaurantWhatsappSource{MessageID: "message-test", SentAt: now.Add(-time.Minute)}, []restaurantOrderLineInput{{ItemID: "rice", Quantity: 1, OptionIDs: []string{"free", "extra"}}}, now
}

func TestRestaurantWhatsappProposalScopeAndReplayBinding(t *testing.T) {
	scope, source, items, now := whatsappProposalFixture()
	first, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newRestaurantWhatsappProposal(scope, source, []restaurantOrderLineInput{{ItemID: "rice", Quantity: 1, OptionIDs: []string{"extra", "free"}}}, now.Add(time.Minute))
	if err != nil || first.eventKey != second.eventKey || first.payloadHash != second.payloadHash || !first.expiresAt.Equal(second.expiresAt) {
		t.Fatal("retry changed identity, content or expiry", err)
	}
	items[0].Quantity = 2
	changed, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil || changed.eventKey != first.eventKey || changed.payloadHash == first.payloadHash {
		t.Fatal("conflicting replay was not distinguishable")
	}
	later := source
	later.SentAt = later.SentAt.Add(time.Second)
	changed, err = newRestaurantWhatsappProposal(scope, later, items, now)
	if err != nil || changed.eventKey != first.eventKey || changed.payloadHash == first.payloadHash {
		t.Fatal("timestamp rewrite was not distinguishable")
	}
	for _, field := range []string{"RestaurantID", "Channel", "ConnectionID", "Generation", "PeerID"} {
		t.Run(field, func(t *testing.T) {
			alternate := scope
			if field == "Channel" {
				alternate.Channel = "whatsapp_cloud"
			} else {
				reflect.ValueOf(&alternate).Elem().FieldByName(field).SetString("different")
			}
			other, err := newRestaurantWhatsappProposal(alternate, source, items, now)
			if err != nil || other.eventKey == first.eventKey {
				t.Fatal("scope key collision", err)
			}
			_, err = first.previewInput(alternate, "pickup", restaurantPreviewAddress{}, now)
			restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
		})
	}
}

func TestRestaurantWhatsappProposalRejectsUnsafeOriginsAndBounds(t *testing.T) {
	scope, source, items, now := whatsappProposalFixture()
	for _, field := range []string{"FromMe", "Group", "History", "Forwarded", "Edited"} {
		bad := source
		reflect.ValueOf(&bad).Elem().FieldByName(field).SetBool(true)
		_, err := newRestaurantWhatsappProposal(scope, bad, items, now)
		restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	}
	for _, channel := range []string{"web", "chatgpt", "", "WHATSAPP_QR"} {
		bad := scope
		bad.Channel = channel
		_, err := newRestaurantWhatsappProposal(bad, source, items, now)
		restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	}
	for _, field := range []string{"RestaurantID", "ConnectionID", "Generation", "PeerID"} {
		for _, value := range []string{"", " leading", "trailing ", "two words", "line\nbreak", strings.Repeat("x", 257), string([]byte{0xff})} {
			bad := scope
			reflect.ValueOf(&bad).Elem().FieldByName(field).SetString(value)
			_, err := newRestaurantWhatsappProposal(bad, source, items, now)
			restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
		}
	}
	for _, sent := range []time.Time{now.Add(-15 * time.Minute), now.Add(31 * time.Second)} {
		bad := source
		bad.SentAt = sent
		_, err := newRestaurantWhatsappProposal(scope, bad, items, now)
		restaurantOrdersRequireError(t, err, "whatsapp_message_expired")
	}
	bad := source
	bad.SentAt = time.Time{}
	_, err := newRestaurantWhatsappProposal(scope, bad, items, now)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	_, err = newRestaurantWhatsappProposal(scope, source, items, time.Time{})
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	for _, cart := range [][]restaurantOrderLineInput{nil, {{ItemID: "rice", Quantity: 0}}, {{ItemID: "rice", Quantity: 100}}, {{ItemID: "", Quantity: 1}}, {{ItemID: "rice", Quantity: 1, OptionIDs: []string{"extra", "extra"}}}, {{ItemID: "rice", Quantity: 1, OptionIDs: []string{""}}}, {items[0], items[0]}, make([]restaurantOrderLineInput, 51)} {
		_, err := newRestaurantWhatsappProposal(scope, source, cart, now)
		restaurantOrdersRequireError(t, err, "invalid_whatsapp_cart")
	}
	tooMany := []restaurantOrderLineInput{}
	for _, id := range []string{"a", "b", "c", "d", "e", "f"} {
		tooMany = append(tooMany, restaurantOrderLineInput{ItemID: id, Quantity: 99})
	}
	_, err = newRestaurantWhatsappProposal(scope, source, tooMany, now)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_cart")
}

func TestRestaurantWhatsappProposalCopiesAndExpiresWithoutRenewal(t *testing.T) {
	scope, source, items, now := whatsappProposalFixture()
	proposal, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	items[0].ItemID = "changed"
	items[0].OptionIDs[0] = "changed"
	input, err := proposal.previewInput(scope, "pickup", restaurantPreviewAddress{}, now)
	if err != nil || input.Items[0].ItemID != "rice" || !reflect.DeepEqual(input.Items[0].OptionIDs, []string{"extra", "free"}) {
		t.Fatal("input alias changed proposal", err)
	}
	input.Items[0].Quantity = 99
	input.Items[0].OptionIDs[0] = "changed"
	again, err := proposal.previewInput(scope, "pickup", restaurantPreviewAddress{}, now)
	if err != nil || again.Items[0].Quantity != 1 || again.Items[0].OptionIDs[0] != "extra" {
		t.Fatal("output alias changed proposal", err)
	}
	_, err = proposal.previewInput(scope, "pickup", restaurantPreviewAddress{}, proposal.expiresAt)
	restaurantOrdersRequireError(t, err, "whatsapp_message_expired")
	_, err = proposal.previewInput(scope, "table", restaurantPreviewAddress{}, now)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_mode")
	_, err = (*restaurantWhatsappProposal)(nil).previewInput(scope, "pickup", restaurantPreviewAddress{}, now)
	restaurantOrdersRequireError(t, err, "whatsapp_scope_mismatch")
}

func TestRestaurantWhatsappProposalOriginalCoreReadOnly(t *testing.T) {
	orders, _ := restaurantStockFixture(t, 4)
	scope, source, items, now := whatsappProposalFixture()
	for _, channel := range []string{"whatsapp_qr", "whatsapp_cloud"} {
		scope.Channel = channel
		proposal, err := newRestaurantWhatsappProposal(scope, source, items, now)
		if err != nil {
			t.Fatal(err)
		}
		quote, err := orders.PreviewWhatsappProposal(context.Background(), proposal, scope, "pickup", restaurantPreviewAddress{}, now)
		if err != nil || quote.TotalMinor != 1500 || quote.Items[0].Name != "Rice" {
			t.Fatal("original authoritative pricing mismatch", quote, err)
		}
		restaurantAssertStock(t, orders, 4, 0)
	}
	var count int
	if err := orders.store.db.QueryRow("SELECT count(*) FROM restaurant_orders").Scan(&count); err != nil || count != 0 {
		t.Fatal("preview created an order", count, err)
	}
	policies, err := orders.OrderChannels(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	for _, policy := range policies {
		if strings.HasPrefix(policy.Channel, "whatsapp_") && policy.NewOrdersEnabled {
			t.Fatal("preview enabled an adapter")
		}
	}
	// Missing catalogue IDs are rejected, never guessed or replaced.
	items[0].ItemID = "external-unmapped-sku"
	proposal, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	_, err = orders.PreviewWhatsappProposal(context.Background(), proposal, scope, "pickup", restaurantPreviewAddress{}, now)
	restaurantOrdersRequireError(t, err, "item_unavailable")
	restaurantAssertStock(t, orders, 4, 0)
}

func TestRestaurantWhatsappProposalCanonicalLineOrderAndClockEdges(t *testing.T) {
	scope, source, items, now := whatsappProposalFixture()
	items = append(items, restaurantOrderLineInput{ItemID: "second", Quantity: 2})
	first, err := newRestaurantWhatsappProposal(scope, source, items, now)
	if err != nil {
		t.Fatal(err)
	}
	second, err := newRestaurantWhatsappProposal(scope, source, []restaurantOrderLineInput{items[1], items[0]}, now)
	if err != nil || second.payloadHash != first.payloadHash {
		t.Fatal("line ordering changed equivalent content", err)
	}
	for _, sent := range []time.Time{now.Add(30 * time.Second), now.Add(-15*time.Minute + time.Nanosecond)} {
		edge := source
		edge.SentAt = sent
		if _, err := newRestaurantWhatsappProposal(scope, edge, items, now); err != nil {
			t.Fatal("valid edge rejected", err)
		}
	}
	for _, id := range []string{"", strings.Repeat("x", 257), "line\nbreak"} {
		bad := source
		bad.MessageID = id
		_, err := newRestaurantWhatsappProposal(scope, bad, items, now)
		restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	}
	_, err = first.previewInput(scope, "pickup", restaurantPreviewAddress{}, time.Time{})
	restaurantOrdersRequireError(t, err, "whatsapp_message_expired")
	_, err = first.previewInput(scope, "pickup", restaurantPreviewAddress{}, source.SentAt.Add(-31*time.Second))
	restaurantOrdersRequireError(t, err, "whatsapp_message_expired")
	options := []string{}
	for i := 0; i < 31; i++ {
		options = append(options, strings.Repeat("x", i+1))
	}
	_, err = newRestaurantWhatsappProposal(scope, source, []restaurantOrderLineInput{{ItemID: "rice", Quantity: 1, OptionIDs: options}}, now)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_cart")
}
