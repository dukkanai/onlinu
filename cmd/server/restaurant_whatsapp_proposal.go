package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"sort"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

// Private adapter boundary, deliberately not reachable from HTTP, WhatsApp
// callbacks or workers yet. Transport adapters must authenticate and resolve
// the tenant/connection generation/peer before constructing this scope.
// A cart proposal is not customer consent, an order, payment or delivery proof.
type restaurantWhatsappScope struct {
	RestaurantID string
	Channel      string
	ConnectionID string
	Generation   string
	PeerID       string
}

type restaurantWhatsappSource struct {
	MessageID string
	SentAt    time.Time
	FromMe    bool
	Group     bool
	History   bool
	Forwarded bool
	Edited    bool
}

type restaurantWhatsappProposal struct {
	scope       restaurantWhatsappScope
	source      restaurantWhatsappSource
	items       []restaurantOrderLineInput
	eventKey    string
	payloadHash string
	expiresAt   time.Time
}

func restaurantWhatsappOpaque(value string) bool {
	if !utf8.ValidString(value) || value == "" || len(value) > 256 || strings.TrimSpace(value) != value {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) || unicode.IsSpace(r) {
			return false
		}
	}
	return true
}

func restaurantWhatsappValidScope(scope restaurantWhatsappScope) bool {
	if scope.Channel != "whatsapp_qr" && scope.Channel != "whatsapp_cloud" {
		return false
	}
	for _, value := range []string{scope.RestaurantID, scope.ConnectionID, scope.Generation, scope.PeerID} {
		if !restaurantWhatsappOpaque(value) {
			return false
		}
	}
	return true
}

func restaurantWhatsappDigest(value any) string {
	encoded, _ := json.Marshal(value) // Only bounded strings, integers and slices below.
	digest := sha256.Sum256(encoded)
	return hex.EncodeToString(digest[:])
}

// Receives already resolved internal item/option IDs, never provider prices,
// natural-language instructions or blindly copied external product IDs.
// now is a trusted server clock, not a message/browser field.
func newRestaurantWhatsappProposal(scope restaurantWhatsappScope, source restaurantWhatsappSource, items []restaurantOrderLineInput, now time.Time) (*restaurantWhatsappProposal, error) {
	if !restaurantWhatsappValidScope(scope) || !restaurantWhatsappOpaque(source.MessageID) || now.IsZero() || source.SentAt.IsZero() ||
		source.FromMe || source.Group || source.History || source.Forwarded || source.Edited {
		return nil, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	sent := source.SentAt.UTC()
	if sent.After(now.Add(30*time.Second)) || !now.Before(sent.Add(15*time.Minute)) {
		return nil, restaurantFail(409, "whatsapp_message_expired")
	}
	if len(items) < 1 || len(items) > 50 {
		return nil, restaurantFail(400, "invalid_whatsapp_cart")
	}
	canonical := make([]restaurantOrderLineInput, 0, len(items))
	total := 0
	seen := map[string]bool{}
	for _, item := range items {
		if !restaurantWhatsappOpaque(item.ItemID) || item.Quantity < 1 || item.Quantity > 99 || len(item.OptionIDs) > 30 {
			return nil, restaurantFail(400, "invalid_whatsapp_cart")
		}
		total += item.Quantity
		if total > 500 {
			return nil, restaurantFail(400, "invalid_whatsapp_cart")
		}
		options := append([]string{}, item.OptionIDs...)
		sort.Strings(options)
		for i, option := range options {
			if !restaurantWhatsappOpaque(option) || (i > 0 && option == options[i-1]) {
				return nil, restaurantFail(400, "invalid_whatsapp_cart")
			}
		}
		key := restaurantWhatsappDigest([]any{item.ItemID, options})
		// Reject ambiguous duplicate lines rather than silently adding quantities.
		if seen[key] {
			return nil, restaurantFail(400, "invalid_whatsapp_cart")
		}
		seen[key] = true
		canonical = append(canonical, restaurantOrderLineInput{ItemID: item.ItemID, Quantity: item.Quantity, OptionIDs: options})
	}
	sort.Slice(canonical, func(i, j int) bool {
		return restaurantWhatsappDigest([]any{canonical[i].ItemID, canonical[i].OptionIDs}) < restaurantWhatsappDigest([]any{canonical[j].ItemID, canonical[j].OptionIDs})
	})
	source.SentAt = sent
	return &restaurantWhatsappProposal{
		scope: scope, source: source, items: canonical,
		eventKey:    restaurantWhatsappDigest([]any{"whatsapp-proposal-v1", scope, source.MessageID}),
		payloadHash: restaurantWhatsappDigest([]any{sent.Format(time.RFC3339Nano), canonical}),
		expiresAt:   sent.Add(15 * time.Minute),
	}, nil
}

// Stable event keys separate account generations, restaurants, channels and
// peers. Matching keys alone never authorize a replay: payload hashes must also
// match in the future durable inbox. No inbox/storage claim is made here.
func (p *restaurantWhatsappProposal) previewInput(scope restaurantWhatsappScope, mode string, address restaurantPreviewAddress, now time.Time) (restaurantPreviewInput, error) {
	if p == nil || !restaurantWhatsappValidScope(scope) || p.scope != scope {
		return restaurantPreviewInput{}, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	if now.IsZero() || !now.Before(p.expiresAt) || p.source.SentAt.After(now.Add(30*time.Second)) {
		return restaurantPreviewInput{}, restaurantFail(409, "whatsapp_message_expired")
	}
	if mode != "pickup" && mode != "delivery" {
		return restaurantPreviewInput{}, restaurantFail(400, "invalid_whatsapp_mode")
	}
	// Copies prevent a caller mutating a proposal through a returned preview.
	items := make([]restaurantOrderLineInput, len(p.items))
	for i, item := range p.items {
		items[i] = item
		items[i].OptionIDs = append([]string{}, item.OptionIDs...)
	}
	return restaurantPreviewInput{Mode: mode, Items: items, Address: address}, nil
}

// Read-only, original-core pricing/stock/coverage/opening checks. There is no
// create, send, mark-read, payment, reservation or channel-enable operation.
// Future adapters must recheck current entitlements and owner/channel authority;
// possession of this internal value is not an authorization capability.
func (s *restaurantOrders) PreviewWhatsappProposal(ctx context.Context, proposal *restaurantWhatsappProposal, scope restaurantWhatsappScope, mode string, address restaurantPreviewAddress, now time.Time) (restaurantQuote, error) {
	input, err := proposal.previewInput(scope, mode, address, now)
	if err != nil {
		return restaurantQuote{}, err
	}
	return s.Preview(ctx, input)
}
