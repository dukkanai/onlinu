package main

import (
	"encoding/json"
	"errors"
	"net/http"
	"net/netip"
	"strings"
)

const restaurantTrustedProxySetting = "WACALLS_TRUSTED_PROXY_CIDRS"

var errRestaurantTrustedProxyConfiguration = errors.New("invalid WACALLS_TRUSTED_PROXY_CIDRS configuration")

// restaurantProxyPolicy is parsed once, before starting the server, and is
// immutable after construction. Its zero value trusts no forwarded headers,
// including those from loopback, RFC1918 and IPv6 unique-local peers.
type restaurantProxyPolicy struct {
	trusted []netip.Prefix
}

// The optional setting is a JSON array of at most 32 concrete CIDRs. Unset and
// [] trust no proxies; an explicitly empty or malformed setting stops startup.
// Only configure verified, controlled proxy peers. Private addresses, including
// Docker host gateways shared with other host processes, are not proof of a
// proxy's identity. Network recreation can change a previously observed peer.
func restaurantTrustedProxiesFromEnv(lookup func(string) (string, bool)) (restaurantProxyPolicy, error) {
	if lookup == nil {
		return restaurantProxyPolicy{}, errRestaurantTrustedProxyConfiguration
	}
	raw, present := lookup(restaurantTrustedProxySetting)
	if !present {
		return restaurantProxyPolicy{}, nil
	}
	var cidrs []string
	if len(raw) > 4096 || json.Unmarshal([]byte(raw), &cidrs) != nil || cidrs == nil || len(cidrs) > 32 {
		return restaurantProxyPolicy{}, errRestaurantTrustedProxyConfiguration
	}
	policy := restaurantProxyPolicy{trusted: make([]netip.Prefix, 0, len(cidrs))}
	for _, cidr := range cidrs {
		prefix, err := netip.ParsePrefix(cidr)
		// Reject host bits rather than silently broadening a mistyped network.
		if err != nil || prefix.Bits() == 0 || prefix != prefix.Masked() {
			return restaurantProxyPolicy{}, errRestaurantTrustedProxyConfiguration
		}
		if prefix.Addr().Is4In6() {
			// Socket addresses and header addresses are unmapped below. Apply
			// the same representation to configuration, without allowing /0.
			if prefix.Bits() <= 96 {
				return restaurantProxyPolicy{}, errRestaurantTrustedProxyConfiguration
			}
			prefix = netip.PrefixFrom(prefix.Addr().Unmap(), prefix.Bits()-96)
		}
		policy.trusted = append(policy.trusted, prefix)
	}
	return policy, nil
}

func (p restaurantProxyPolicy) trusts(peer netip.Addr) bool {
	for _, prefix := range p.trusted {
		if prefix.Contains(peer) {
			return true
		}
	}
	return false
}

// restaurantClientIP returns a rate-limit key, never an authentication identity.
// This service uses a single-hop contract: a trusted direct proxy must overwrite
// X-Forwarded-For or append the client it actually observed. Only that final
// address is used, even if it happens to be another configured proxy. Do not
// enable this setting until every ingress and the proxy's behavior are verified.
func (s *server) restaurantClientIP(r *http.Request) (string, error) {
	remote, err := netip.ParseAddrPort(r.RemoteAddr)
	if err != nil || remote.Addr().Zone() != "" {
		return "", restaurantFail(http.StatusBadRequest, "invalid_request")
	}
	peer := remote.Addr().Unmap()
	if !s.trustedProxies.trusts(peer) {
		return peer.String(), nil
	}
	values := r.Header.Values("X-Forwarded-For")
	if len(values) == 0 {
		return peer.String(), nil
	}
	// Reject ambiguous/repeated fields and malformed trusted input before
	// accounting, so they cannot select a different fallback rate-limit bucket.
	if len(values) != 1 || len(values[0]) > 2048 || strings.Count(values[0], ",") >= 16 {
		return "", restaurantFail(http.StatusBadRequest, "invalid_request")
	}
	forwarded := values[0]
	last := strings.TrimSpace(forwarded[strings.LastIndexByte(forwarded, ',')+1:])
	client, err := netip.ParseAddr(last)
	if err != nil || client.Zone() != "" {
		return "", restaurantFail(http.StatusBadRequest, "invalid_request")
	}
	return client.Unmap().String(), nil
}
