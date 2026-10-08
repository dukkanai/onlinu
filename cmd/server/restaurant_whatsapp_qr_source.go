package main

import (
	"sync"
	"time"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

// Private attachment fence, not a registered event handler. A future trusted
// lifecycle controller must resolve the persistent binding against the verified
// provider device before Attach, and freshly authorize any later database/send
// operation. Knowing a client pointer or these strings does not grant permission.
// No SDK, database or network call occurs while this fence is locked.
type restaurantWhatsappQRIngress struct {
	mu      sync.RWMutex
	tenant  string
	current *restaurantWhatsappQRSource
}
type restaurantWhatsappQRSource struct {
	ingress *restaurantWhatsappQRIngress
	client  *whatsmeow.Client
	binding restaurantWhatsappQRBinding
	own     types.JID
}

func newRestaurantWhatsappQRIngress(tenant string) (*restaurantWhatsappQRIngress, error) {
	if !restaurantWhatsappOpaque(tenant) {
		return nil, restaurantFail(400, "invalid_whatsapp_binding")
	}
	return &restaurantWhatsappQRIngress{tenant: tenant}, nil
}

// Returns a source captured by ONE provider attachment's callback. A subsequent
// attachment (including reconnecting the same client with the same persistent
// binding) invalidates this source. Do not look up the latest source from inside
// an old callback: that would relabel an old event as a new account's input.
func (g *restaurantWhatsappQRIngress) Attach(client *whatsmeow.Client, binding restaurantWhatsappQRBinding, own types.JID) (*restaurantWhatsappQRSource, error) {
	if g == nil || client == nil || binding.RestaurantID != g.tenant || !restaurantWhatsappOpaque(binding.ConnectionID) || !restaurantWhatsappOpaque(binding.Generation) {
		return nil, restaurantFail(400, "invalid_whatsapp_binding")
	}
	own = own.ToNonAD()
	if own.User == "" || (own.Server != types.DefaultUserServer && own.Server != types.HiddenUserServer) {
		return nil, restaurantFail(400, "invalid_whatsapp_binding")
	}
	source := &restaurantWhatsappQRSource{ingress: g, client: client, binding: binding, own: own}
	g.mu.Lock()
	g.current = source
	g.mu.Unlock()
	return source, nil
}

// Late closure from an old attachment must not revoke its replacement. Connected
// events never reactivate a source; a controller must verify and attach anew.
func (s *restaurantWhatsappQRSource) Invalidate() {
	if s == nil || s.ingress == nil {
		return
	}
	s.ingress.mu.Lock()
	defer s.ingress.mu.Unlock()
	if s.ingress.current == s {
		s.ingress.current = nil
	}
}
func (s *restaurantWhatsappQRSource) ObserveLifecycle(origin *whatsmeow.Client, event any) {
	if s == nil || origin != s.client {
		return
	}
	switch event.(type) {
	case *events.LoggedOut, *events.Disconnected, *events.StreamReplaced, *events.TemporaryBan, *events.ClientOutdated, *events.ConnectFailure, *events.StreamError, *events.CATRefreshError:
		s.Invalidate()
	}
}

// Only pure extraction runs under the shared lock. Returned intent remains
// untrusted customer text and carries its OLD immutable scope after invalidation;
// it must pass current binding/entitlement checks before persistence or execution.
func (s *restaurantWhatsappQRSource) Text(origin *whatsmeow.Client, event *events.Message, now time.Time) (restaurantWhatsappTextIntent, error) {
	if s == nil || s.ingress == nil {
		return restaurantWhatsappTextIntent{}, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	s.ingress.mu.RLock()
	defer s.ingress.mu.RUnlock()
	if s.ingress.current != s || origin != s.client {
		return restaurantWhatsappTextIntent{}, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	return restaurantWhatsappQRText(s.binding, event, now)
}
func (s *restaurantWhatsappQRSource) Decision(origin *whatsmeow.Client, event *events.Message, now time.Time) (restaurantWhatsappDecisionIntent, error) {
	if s == nil || s.ingress == nil {
		return restaurantWhatsappDecisionIntent{}, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	s.ingress.mu.RLock()
	defer s.ingress.mu.RUnlock()
	if s.ingress.current != s || origin != s.client {
		return restaurantWhatsappDecisionIntent{}, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	return restaurantWhatsappQRDecision(s.binding, s.own, event, now)
}
