package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func restaurantProxyTestPolicy(t *testing.T, cidrs ...string) restaurantProxyPolicy {
	t.Helper()
	if cidrs == nil {
		cidrs = []string{}
	}
	raw, err := json.Marshal(cidrs)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := restaurantTrustedProxiesFromEnv(func(name string) (string, bool) {
		if name != restaurantTrustedProxySetting {
			t.Fatalf("unexpected configuration read: %s", name)
		}
		return string(raw), true
	})
	if err != nil {
		t.Fatal(err)
	}
	return policy
}

func TestRestaurantProxyConfiguration(t *testing.T) {
	for name, raw := range map[string]string{
		"empty list":      "[]",
		"IPv4 and IPv6":   `["127.0.0.1/32","::1/128","10.0.0.0/24","fd01::/64"]`,
		"mapped IPv4":     `["::ffff:172.21.0.1/128","::ffff:10.0.0.0/120"]`,
		"JSON whitespace": " \n [\"127.0.0.1/32\"] \n ",
		"maximum entries": "[" + strings.TrimSuffix(strings.Repeat(`"127.0.0.1/32",`, 32), ",") + "]",
		"maximum bytes":   "[]" + strings.Repeat(" ", 4094),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := restaurantTrustedProxiesFromEnv(func(string) (string, bool) { return raw, true }); err != nil {
				t.Fatal(err)
			}
		})
	}
	for name, raw := range map[string]string{
		"present empty": "", "blank": " ", "not JSON": "private-config-marker",
		"null": "null", "boolean": "true", "object": "{}", "string": `"127.0.0.1/32"`,
		"bad JSON": `["127.0.0.1/32",]`, "trailing JSON": "[] []", "nonstring entry": "[12]", "null entry": "[null]",
		"empty entry": `[""]`, "missing prefix": `["127.0.0.1"]`, "hostname": `["localhost/32"]`,
		"zone ID": `["fe80::%eth0/64"]`, "address whitespace": `[" 127.0.0.1/32"]`,
		"IPv4 prefix too long": `["127.0.0.1/33"]`, "IPv6 prefix too long": `["::1/129"]`,
		"negative prefix": `["127.0.0.1/-1"]`, "invalid octet": `["256.0.0.1/32"]`,
		"IPv4 trust all": `["0.0.0.0/0"]`, "IPv6 trust all": `["::/0"]`,
		"mapped trust all": `["::ffff:0.0.0.0/96"]`, "mapped oversized network": `["::ffff:0.0.0.0/80"]`,
		"IPv4 host bits": `["10.0.0.1/24"]`, "IPv6 host bits": `["fd01::1/64"]`,
		"mapped host bits": `["::ffff:10.0.0.1/120"]`, "valid then invalid": `["127.0.0.1/32","private-config-marker"]`,
		"too many entries": "[" + strings.TrimSuffix(strings.Repeat(`"127.0.0.1/32",`, 33), ",") + "]",
		"oversized":        "[]" + strings.Repeat(" ", 4095),
	} {
		t.Run(name, func(t *testing.T) {
			policy, err := restaurantTrustedProxiesFromEnv(func(string) (string, bool) { return raw, true })
			if !errors.Is(err, errRestaurantTrustedProxyConfiguration) || len(policy.trusted) != 0 || strings.Contains(err.Error(), "private-config-marker") {
				t.Fatal("invalid configuration was accepted, partially trusted, or disclosed", err)
			}
		})
	}
	policy, err := restaurantTrustedProxiesFromEnv(func(string) (string, bool) { return "", false })
	if err != nil || len(policy.trusted) != 0 {
		t.Fatal("unset configuration trusts a proxy", err)
	}
	if _, err := restaurantTrustedProxiesFromEnv(nil); !errors.Is(err, errRestaurantTrustedProxyConfiguration) {
		t.Fatal("nil configuration reader was accepted")
	}
}

func TestRestaurantProxyInvalidStartupStopsBeforeDatabase(t *testing.T) {
	t.Setenv(restaurantTrustedProxySetting, `["127.0.0.1/32","private-config-marker"]`)
	var logged bytes.Buffer
	s, err := newServer(context.Background(), "postgres://private-database-marker%zz", "synthetic", "", slog.New(slog.NewTextHandler(&logged, nil)))
	if s != nil || !errors.Is(err, errRestaurantTrustedProxyConfiguration) || logged.Len() != 0 {
		t.Fatal("startup did not stop before database and service initialization", err)
	}
}

func TestRestaurantProxyActualMainRejectsMalformedConfiguration(t *testing.T) {
	if os.Getenv("ONLINU_PROXY_TEST_HELPER") == "1" {
		flag.CommandLine = flag.NewFlagSet("wacalls", flag.ExitOnError)
		os.Args = []string{"wacalls", "-addr=127.0.0.1:0", "-pg-url=postgres://private-database-marker%zz", "-static="}
		main()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRestaurantProxyActualMainRejectsMalformedConfiguration$")
	cmd.Env = append(cleanRuntimeSecretEnvironment(), "ONLINU_PROXY_TEST_HELPER=1", restaurantTrustedProxySetting+`=["private-config-marker"]`)
	output, err := cmd.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) || exit.ExitCode() != 1 || !bytes.Contains(output, []byte(errRestaurantTrustedProxyConfiguration.Error())) {
		t.Fatalf("actual main did not reject invalid proxy configuration: %v\n%s", err, output)
	}
	for _, forbidden := range []string{"private-config-marker", "private-database-marker", "HTTP server listening"} {
		if bytes.Contains(output, []byte(forbidden)) {
			t.Fatalf("startup leaked input or opened HTTP: %s", output)
		}
	}
}

func TestRestaurantProxyUnconfiguredPeersIgnoreAllForwardedHeaders(t *testing.T) {
	s := &server{}
	for remote, want := range map[string]string{
		"127.0.0.1:123": "127.0.0.1", "127.0.0.2:123": "127.0.0.2",
		"10.0.0.1:123": "10.0.0.1", "172.21.0.1:123": "172.21.0.1", "192.168.1.1:123": "192.168.1.1",
		"[::1]:123": "::1", "[FD01:0000:0000:0000:0000:0000:0000:0001]:123": "fd01::1",
		"[::ffff:172.21.0.1]:123": "172.21.0.1", "198.51.100.3:123": "198.51.100.3",
		"[2001:0DB8:0000::1]:123": "2001:db8::1",
	} {
		t.Run(remote, func(t *testing.T) {
			for _, values := range [][]string{nil, {"203.0.113.1"}, {"invalid"}, {""}, {"203.0.113.1", "203.0.113.2"}, {strings.Repeat("a", 2049)}} {
				r := httptest.NewRequest(http.MethodGet, "/", nil)
				r.RemoteAddr = remote
				r.Header["X-Forwarded-For"] = values
				r.Header.Set("Forwarded", "for=203.0.113.3")
				r.Header.Set("X-Real-IP", "203.0.113.4")
				got, err := s.restaurantClientIP(r)
				if got != want || err != nil {
					t.Fatalf("untrusted peer/header changed client key: %q %v, want %q", got, err, want)
				}
			}
		})
	}
}

func TestRestaurantProxyAllowlistAndRightmostContract(t *testing.T) {
	s := &server{trustedProxies: restaurantProxyTestPolicy(t, "172.21.0.1/32", "127.0.0.1/32", "::1/128", "fd01::1/128", "10.0.1.0/24")}
	for _, tc := range []struct{ name, remote, forwarded, want string }{
		{"explicit peer", "172.21.0.1:123", "198.51.100.8", "198.51.100.8"},
		{"mapped socket", "[::ffff:172.21.0.1]:123", "203.0.113.99, 198.51.100.8", "198.51.100.8"},
		{"mapped client", "172.21.0.1:123", "::ffff:c633:6408", "198.51.100.8"},
		{"ignore invalid left values", "127.0.0.1:123", "unknown, forged:42, 198.51.100.8", "198.51.100.8"},
		{"IPv6 proxy and client", "[fd01::1]:123", " 2001:0DB8:0000:0000::1 \t", "2001:db8::1"},
		{"IPv6 loopback explicit", "[::1]:123", "203.0.113.8", "203.0.113.8"},
		{"adjacent IPv4 untrusted", "172.21.0.2:123", "198.51.100.8", "172.21.0.2"},
		{"adjacent IPv6 untrusted", "[fd01::2]:123", "198.51.100.8", "fd01::2"},
		{"adjacent loopback untrusted", "127.0.0.2:123", "198.51.100.8", "127.0.0.2"},
		{"adjacent subnet untrusted", "10.0.2.1:123", "198.51.100.8", "10.0.2.1"},
		{"explicit subnet", "10.0.1.42:123", "198.51.100.8", "198.51.100.8"},
		{"never walk through trusted rightmost", "172.21.0.1:123", "198.51.100.8, 10.0.1.42", "10.0.1.42"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = tc.remote
			r.Header.Set("X-Forwarded-For", tc.forwarded)
			if got, err := s.restaurantClientIP(r); err != nil || got != tc.want {
				t.Fatalf("got %q %v, want %q", got, err, tc.want)
			}
		})
	}
	for _, cidr := range []string{"172.21.0.1/32", "::ffff:172.21.0.1/128"} {
		s := &server{trustedProxies: restaurantProxyTestPolicy(t, cidr)}
		for _, remote := range []string{"172.21.0.1:123", "[::ffff:172.21.0.1]:123"} {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = remote
			r.Header.Set("X-Forwarded-For", "198.51.100.8")
			if got, err := s.restaurantClientIP(r); err != nil || got != "198.51.100.8" {
				t.Fatalf("mapped configuration/address mismatch: %s %s %q %v", cidr, remote, got, err)
			}
		}
	}
}

func TestRestaurantProxyMalformedTrustedHeadersFailClosed(t *testing.T) {
	s := &server{trustedProxies: restaurantProxyTestPolicy(t, "127.0.0.1/32")}
	for _, values := range [][]string{
		{""}, {" \t"}, {"unknown"}, {"198.51.100.1:123"}, {"[::1]"}, {"fe80::1%eth0"},
		{"198.51.100.1,"}, {"198.51.100.1, "}, {"198.51.100.1,unknown"},
		{"203.0.113.1", "198.51.100.1"}, {"", "198.51.100.1"},
		{strings.Repeat("a", 2049)}, {strings.Repeat("127.0.0.1,", 16) + "198.51.100.1"},
	} {
		r := httptest.NewRequest(http.MethodGet, "/", nil)
		r.RemoteAddr = "127.0.0.1:123"
		r.Header["X-Forwarded-For"] = values
		got, err := s.restaurantClientIP(r)
		var re *restaurantError
		if got != "" || !errors.As(err, &re) || re.Status != http.StatusBadRequest || re.Code != "invalid_request" {
			t.Fatalf("malformed trusted header did not fail closed: %q %v", got, err)
		}
	}
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "127.0.0.1:123"
	r.Header.Set("Forwarded", "for=203.0.113.1")
	r.Header.Set("X-Real-IP", "203.0.113.2")
	if got, err := s.restaurantClientIP(r); err != nil || got != "127.0.0.1" {
		t.Fatal("missing XFF changed peer key", got, err)
	}
	for _, remote := range []string{"", "127.0.0.1", "localhost:123", "[fe80::1%eth0]:123", "198.51.100.1:not-a-port"} {
		r.RemoteAddr = remote
		if got, err := s.restaurantClientIP(r); err == nil || got != "" {
			t.Fatalf("invalid socket address accepted: %q %q %v", remote, got, err)
		}
	}
}

func TestRestaurantProxySpoofingAndAliasesDoNotChangeRateBucket(t *testing.T) {
	for _, trusted := range []bool{false, true} {
		s := &server{}
		if trusted {
			s.trustedProxies = restaurantProxyTestPolicy(t, "127.0.0.1/32")
		}
		limiter := restaurantRateLimiter{entries: make(map[string]restaurantRateEntry)}
		for i, forwarded := range []string{"198.51.100.8", "::ffff:198.51.100.8", "203.0.113.99, ::ffff:c633:6408", "garbage, 198.51.100.8"} {
			r := httptest.NewRequest(http.MethodGet, "/", nil)
			r.RemoteAddr = "127.0.0.1:123"
			if i%2 == 1 {
				r.RemoteAddr = "[::ffff:127.0.0.1]:456"
			}
			r.Header.Set("X-Forwarded-For", forwarded)
			key, err := s.restaurantClientIP(r)
			if err != nil || limiter.allow(key, 1) != (i == 0) || len(limiter.entries) != 1 {
				t.Fatalf("trusted=%t spoof/alias selected a new bucket: %q %v", trusted, key, err)
			}
		}
	}
}

func TestRestaurantProxyExactBoundsAndPolicyLifetime(t *testing.T) {
	t.Setenv(restaurantTrustedProxySetting, `["::ffff:10.0.1.0/120"]`)
	policy, err := restaurantTrustedProxiesFromEnv(os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	s := &server{trustedProxies: policy}
	// The runtime's policy must not change in the middle of request handling.
	t.Setenv(restaurantTrustedProxySetting, "[]")
	r := httptest.NewRequest(http.MethodGet, "/", nil)
	r.RemoteAddr = "[::ffff:10.0.1.42]:123"
	for _, header := range []string{
		strings.Repeat("unknown,", 15) + "198.51.100.8",
		strings.Repeat("x", 2048-len(", 198.51.100.8")) + ", 198.51.100.8",
	} {
		r.Header.Set("X-Forwarded-For", header)
		if got, err := s.restaurantClientIP(r); err != nil || got != "198.51.100.8" {
			t.Fatalf("exact boundary or immutable mapped subnet policy failed: %q %v", got, err)
		}
	}
	r.Header.Set("X-Forwarded-For", strings.Repeat("x", 2049-len(", 198.51.100.8"))+", 198.51.100.8")
	if got, err := s.restaurantClientIP(r); err == nil || got != "" {
		t.Fatal("oversized prefix was accepted because its rightmost address was valid")
	}
	r.Header.Set("X-Forwarded-For", "198.51.100.8")
	r.RemoteAddr = "10.0.2.42:123"
	if got, err := s.restaurantClientIP(r); err != nil || got != "10.0.2.42" {
		t.Fatal("mapped subnet trusted an adjacent network", got, err)
	}
	newPolicy, err := restaurantTrustedProxiesFromEnv(os.LookupEnv)
	if err != nil {
		t.Fatal(err)
	}
	r.RemoteAddr = "10.0.1.42:123"
	if got, err := (&server{trustedProxies: newPolicy}).restaurantClientIP(r); err != nil || got != "10.0.1.42" {
		t.Fatal("a newly constructed policy ignored the changed setting", got, err)
	}
}

// Exercise the actual public and provider HTTP guards without a database or
// external provider. The account read returns an anonymous result; mutation
// routes reject their missing Content-Type before calling a service. The
// unknown hook route returns 404 after the actual payment transport guard.
func TestRestaurantProxyHTTPRateLimitBoundaries(t *testing.T) {
	for _, route := range []struct {
		name, method, path string
		limit, allowedCode int
	}{
		{"storefront read", http.MethodGet, "/storefront-api/account", 240, http.StatusOK},
		{"storefront access", http.MethodPost, "/storefront-api/account/login", 10, http.StatusUnsupportedMediaType},
		{"storefront write", http.MethodPost, "/storefront-api/quote", 90, http.StatusUnsupportedMediaType},
		{"storefront order", http.MethodPost, "/storefront-api/orders", 20, http.StatusUnsupportedMediaType},
		{"payment hooks", http.MethodPost, "/payment-hooks/proxy-test", 120, http.StatusNotFound},
	} {
		for _, trusted := range []bool{false, true} {
			t.Run(fmt.Sprintf("%s/trusted=%t", route.name, trusted), func(t *testing.T) {
				s := &server{restaurant: &restaurantStore{}, orders: &restaurantOrders{}, customers: &restaurantAccounts{}, payments: &restaurantPayments{}}
				if trusted {
					s.trustedProxies = restaurantProxyTestPolicy(t, "127.0.0.1/32", "::1/128")
				}
				ts := httptest.NewServer(s.routes())
				defer ts.Close()
				client := ts.Client()
				client.Timeout = 5 * time.Second
				request := func(values []string, want int) {
					t.Helper()
					r, err := http.NewRequest(route.method, ts.URL+route.path, nil)
					if err != nil {
						t.Fatal(err)
					}
					r.Header["X-Forwarded-For"] = values
					r.Header.Set("Forwarded", "for=203.0.113.98")
					r.Header.Set("X-Real-IP", "203.0.113.99")
					response, err := client.Do(r)
					if err != nil {
						t.Fatal(err)
					}
					_, _ = io.Copy(io.Discard, response.Body)
					_ = response.Body.Close()
					if response.StatusCode != want {
						t.Fatalf("status=%d want=%d, header=%v", response.StatusCode, want, values)
					}
					if want == http.StatusTooManyRequests && response.Header.Get("Retry-After") != "60" {
						t.Fatal("missing rate-limit Retry-After")
					}
				}
				if trusted {
					// Invalid trusted inputs must not consume a client or fallback
					// peer bucket, or mint distinct keys from malformed strings.
					for i := 0; i <= route.limit; i++ {
						request([]string{fmt.Sprintf("invalid-%d", i)}, http.StatusBadRequest)
					}
					request([]string{"203.0.113.1", "198.51.100.8"}, http.StatusBadRequest)
					request([]string{""}, http.StatusBadRequest)
				}
				for i := 0; i < route.limit; i++ {
					forwarded := fmt.Sprintf("203.0.113.%d", i+1)
					if trusted {
						forwarded += ", 198.51.100.8"
					}
					request([]string{forwarded}, route.allowedCode)
				}
				request([]string{"forged-left, ::ffff:c633:6408"}, http.StatusTooManyRequests)
				if trusted {
					request([]string{"198.51.100.9"}, route.allowedCode)
					request(nil, route.allowedCode)
				} else {
					request([]string{"198.51.100.9"}, http.StatusTooManyRequests)
					request([]string{"198.51.100.9", "203.0.113.1"}, http.StatusTooManyRequests)
					request([]string{"invalid"}, http.StatusTooManyRequests)
					request(nil, http.StatusTooManyRequests)
				}
			})
		}
	}
}
