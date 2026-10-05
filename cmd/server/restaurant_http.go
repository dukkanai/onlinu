package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

const restaurantCookieName = "restaurant_customer"

func restaurantSessionCookieName() string {
	// Cookies ignore ports. Independent installations on the same host must
	// not overwrite each other's login cookie. Every installer generates a
	// separate high-entropy master key; expose only its domain-separated hash.
	digest := sha256.Sum256([]byte("restaurant-cookie-namespace\x00" + os.Getenv("WACALLS_API_KEY")))
	return restaurantCookieName + "_" + hex.EncodeToString(digest[:8])
}

type restaurantRateEntry struct {
	count int
	until time.Time
}
type restaurantRateLimiter struct {
	mu      sync.Mutex
	entries map[string]restaurantRateEntry
}

func (l *restaurantRateLimiter) allow(key string, limit int) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.entries) >= 10000 {
		for k, v := range l.entries {
			if now.After(v.until) {
				delete(l.entries, k)
			}
		}
	}
	entry, exists := l.entries[key]
	if !exists && len(l.entries) >= 10000 {
		return false
	}
	if !exists || now.After(entry.until) {
		entry = restaurantRateEntry{until: now.Add(time.Minute)}
	}
	entry.count++
	l.entries[key] = entry
	return entry.count <= limit
}

func restaurantClientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	peer := net.ParseIP(host)
	// Caddy appends the verified client to X-Forwarded-For. Only use the last
	// entry, and only when the direct peer is our local/private proxy network.
	if peer != nil && (peer.IsLoopback() || peer.IsPrivate()) {
		parts := strings.Split(r.Header.Get("X-Forwarded-For"), ",")
		if ip := net.ParseIP(strings.TrimSpace(parts[len(parts)-1])); ip != nil {
			return ip.String()
		}
	}
	return host
}

func restaurantSameOrigin(r *http.Request) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	origin := r.Header.Get("Origin")
	if origin == "" {
		return true
	} // CLI clients do not possess browser ambient cookies.
	parsed, err := url.Parse(origin)
	if err != nil || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return false
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return false
	}
	if configured := strings.TrimRight(os.Getenv("WACALLS_PUBLIC_BASE_URL"), "/"); configured != "" {
		return origin == configured
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return parsed.Scheme == scheme && strings.EqualFold(parsed.Host, r.Host)
}

func restaurantSecureCookie(r *http.Request) bool {
	return r.TLS != nil || strings.HasPrefix(os.Getenv("WACALLS_PUBLIC_BASE_URL"), "https://")
}

func setRestaurantCookie(w http.ResponseWriter, r *http.Request, token string) {
	maxAge := 7 * 24 * 60 * 60
	expires := time.Now().Add(7 * 24 * time.Hour)
	if token == "" {
		maxAge = -1
		expires = time.Unix(1, 0)
	}
	http.SetCookie(w, &http.Cookie{Name: restaurantSessionCookieName(), Value: token, Path: "/storefront-api", HttpOnly: true, Secure: restaurantSecureCookie(r), SameSite: http.SameSiteLaxMode, MaxAge: maxAge, Expires: expires})
}

func restaurantToken(r *http.Request) string {
	c, err := r.Cookie(restaurantSessionCookieName())
	if err != nil {
		return ""
	}
	return c.Value
}

func writeRestaurantError(w http.ResponseWriter, err error) {
	var re *restaurantError
	if errors.As(err, &re) {
		writeJSON(w, re.Status, map[string]string{"error": re.Code})
		return
	}
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "server_error"})
}

func decodeRestaurantBody(w http.ResponseWriter, r *http.Request, value any) bool {
	mt, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mt != "application/json" {
		writeRestaurantError(w, restaurantFail(415, "invalid_request"))
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(value); err != nil {
		writeRestaurantError(w, restaurantFail(400, "invalid_request"))
		return false
	}
	if decoder.Decode(new(any)) != io.EOF {
		writeRestaurantError(w, restaurantFail(400, "invalid_request"))
		return false
	}
	return true
}

func (s *server) restaurantCustomer(r *http.Request) (restaurantCustomer, bool, error) {
	if token := restaurantToken(r); token != "" {
		return s.customers.Authenticate(r.Context(), token)
	}
	return restaurantCustomer{}, false, nil
}

func (s *server) registerRestaurantRoutes(mux *http.ServeMux) {
	limiter := &restaurantRateLimiter{entries: make(map[string]restaurantRateEntry)}
	publicSlots := make(chan struct{}, 64)
	summarySlots := make(chan struct{}, 2)
	guard := func(admin bool, next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// A context deadline does not stop a slow network body read. Bound
			// these short JSON/upload requests without affecting calling SSE/WS.
			controller := http.NewResponseController(w)
			_ = controller.SetReadDeadline(time.Now().Add(15 * time.Second))
			// Keep it through net/http's unread-body cleanup on early rejects.
			// net/http establishes the next request's own read deadline.
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Referrer-Policy", "no-referrer")
			if admin {
				key := os.Getenv("WACALLS_API_KEY")
				got := r.Header.Get("X-API-Key")
				expectedHash, gotHash := sha256.Sum256([]byte(key)), sha256.Sum256([]byte(got))
				if key == "" || got == "" || subtle.ConstantTimeCompare(expectedHash[:], gotHash[:]) != 1 {
					writeRestaurantError(w, restaurantFail(401, "unauthorized"))
					return
				}
			}
			if !restaurantSameOrigin(r) {
				writeRestaurantError(w, restaurantFail(403, "forbidden"))
				return
			}
			if s.restaurant == nil || s.orders == nil || s.customers == nil {
				writeRestaurantError(w, restaurantFail(503, "server_error"))
				return
			}
			if !admin {
				select {
				case publicSlots <- struct{}{}:
					defer func() { <-publicSlots }()
				default:
					w.Header().Set("Retry-After", "5")
					writeRestaurantError(w, restaurantFail(429, "rate_limited"))
					return
				}
				group, limit := "read", 240
				if r.Method != "GET" && r.Method != "HEAD" {
					group, limit = "write", 90
				}
				if strings.HasSuffix(r.URL.Path, "/login") || strings.HasSuffix(r.URL.Path, "/register") || strings.HasSuffix(r.URL.Path, "/lookup") {
					group, limit = "access", 10
				}
				if r.Method == "POST" && r.URL.Path == "/storefront-api/orders" {
					group, limit = "order", 20
				}
				if !limiter.allow(restaurantClientIP(r)+":"+group, limit) {
					w.Header().Set("Retry-After", "60")
					writeRestaurantError(w, restaurantFail(429, "rate_limited"))
					return
				}
			}
			requestTimeout := 15 * time.Second
			if admin && r.Method == http.MethodPost && strings.HasPrefix(r.URL.Path, "/api/restaurant/archive/conversations/") && strings.HasSuffix(r.URL.Path, "/summarize") {
				select {
				case summarySlots <- struct{}{}:
					defer func() { <-summarySlots }()
				default:
					w.Header().Set("Retry-After", "30")
					writeRestaurantError(w, restaurantFail(429, "rate_limited"))
					return
				}
				requestTimeout = 60 * time.Second
			}
			ctx, cancel := context.WithTimeout(r.Context(), requestTimeout)
			defer cancel()
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
	pub := http.NewServeMux()
	pub.HandleFunc("GET /storefront-api/catalog", func(w http.ResponseWriter, r *http.Request) {
		c, err := s.restaurant.GetCatalog(r.Context(), true)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, c)
	})
	pub.HandleFunc("GET /storefront-api/tables/{code}", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.restaurant.TableByCode(r.Context(), r.PathValue("code"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	pub.HandleFunc("POST /storefront-api/quote", func(w http.ResponseWriter, r *http.Request) {
		var in restaurantOrderInput
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, err := s.orders.Quote(r.Context(), in)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	pub.HandleFunc("POST /storefront-api/orders", func(w http.ResponseWriter, r *http.Request) {
		var in restaurantOrderInput
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		customer, authenticated, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		// A stale signed-in tab must not silently change an account order into a
		// guest order. Keep its cookie until the customer explicitly signs in or
		// out, so retrying an uncertain submission cannot change its ownership.
		if restaurantToken(r) != "" && !authenticated {
			writeRestaurantError(w, restaurantFail(401, "session_expired"))
			return
		}
		receipt, err := s.orders.Create(r.Context(), in, customer.ID, r.Header.Get("Idempotency-Key"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 201, receipt)
	})
	pub.HandleFunc("POST /storefront-api/orders/lookup", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Number     string `json:"number"`
			AccessCode string `json:"accessCode"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, err := s.orders.Lookup(r.Context(), in.Number, in.AccessCode)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	pub.HandleFunc("GET /storefront-api/orders/{number}", func(w http.ResponseWriter, r *http.Request) {
		c, _, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		v, err := s.orders.Track(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), "", c.ID)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	pub.HandleFunc("POST /storefront-api/orders/{number}/table", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			TableCode string `json:"tableCode"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		c, _, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		v, err := s.orders.ChangeTable(r.Context(), r.PathValue("number"), r.Header.Get("X-Order-Token"), "", c.ID, in.TableCode)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	pub.HandleFunc("GET /storefront-api/account", func(w http.ResponseWriter, r *http.Request) {
		c, ok, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if !ok {
			writeJSON(w, 200, map[string]any{"customer": nil})
			return
		}
		writeJSON(w, 200, map[string]any{"customer": c})
	})
	pub.HandleFunc("POST /storefront-api/account/register", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Username    string `json:"username"`
			Password    string `json:"password"`
			DisplayName string `json:"displayName"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		c, token, err := s.customers.Register(r.Context(), in.Username, in.Password, in.DisplayName)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if previous := restaurantToken(r); previous != "" {
			_ = s.customers.Logout(r.Context(), previous)
		}
		setRestaurantCookie(w, r, token)
		writeJSON(w, 201, map[string]any{"customer": c})
	})
	pub.HandleFunc("POST /storefront-api/account/login", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Username string `json:"username"`
			Password string `json:"password"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		c, token, err := s.customers.Login(r.Context(), in.Username, in.Password)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if previous := restaurantToken(r); previous != "" {
			_ = s.customers.Logout(r.Context(), previous)
		}
		setRestaurantCookie(w, r, token)
		writeJSON(w, 200, map[string]any{"customer": c})
	})
	pub.HandleFunc("POST /storefront-api/account/logout", func(w http.ResponseWriter, r *http.Request) {
		var body struct{}
		if !decodeRestaurantBody(w, r, &body) {
			return
		}
		if err := s.customers.Logout(r.Context(), restaurantToken(r)); err != nil {
			writeRestaurantError(w, err)
			return
		}
		setRestaurantCookie(w, r, "")
		w.WriteHeader(204)
	})
	pub.HandleFunc("PUT /storefront-api/account", func(w http.ResponseWriter, r *http.Request) {
		var in restaurantCustomerUpdate
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		c, ok, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if !ok {
			writeRestaurantError(w, restaurantFail(401, "session_expired"))
			return
		}
		v, err := s.customers.Update(r.Context(), c.ID, in)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"customer": v})
	})
	pub.HandleFunc("GET /storefront-api/account/orders", func(w http.ResponseWriter, r *http.Request) {
		c, ok, err := s.restaurantCustomer(r)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if !ok {
			writeRestaurantError(w, restaurantFail(401, "session_expired"))
			return
		}
		v, err := s.orders.ListCustomer(r.Context(), c.ID)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"orders": v})
	})
	pub.HandleFunc("/storefront-api/", func(w http.ResponseWriter, r *http.Request) {
		writeRestaurantError(w, restaurantFail(404, "not_found"))
	})
	mux.Handle("/storefront-api/", guard(false, pub))
	admin := http.NewServeMux()
	admin.HandleFunc("GET /api/restaurant/catalog", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.restaurant.GetCatalog(r.Context(), false)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	admin.HandleFunc("PUT /api/restaurant/catalog", func(w http.ResponseWriter, r *http.Request) {
		var in restaurantCatalog
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, err := s.restaurant.SaveCatalog(r.Context(), in)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	admin.HandleFunc("GET /api/restaurant/orders", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.orders.ListAdmin(r.Context(), r.URL.Query().Get("status"), r.URL.Query().Get("search"), 100)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"orders": v})
	})
	admin.HandleFunc("PATCH /api/restaurant/orders/{number}", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Status  string `json:"status"`
			Version int64  `json:"version"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, err := s.orders.SetStatus(r.Context(), r.PathValue("number"), in.Status, in.Version)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	})
	admin.HandleFunc("POST /api/restaurant/images", s.handleRestaurantImageUpload)
	admin.HandleFunc("POST /api/restaurant/orders/{number}/cash", func(w http.ResponseWriter, r *http.Request) {
		var in struct {
			Version int64 `json:"version"`
		}
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		order, err := s.orders.CollectCash(r.Context(), r.PathValue("number"), in.Version)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, order)
	})
	hooks := http.NewServeMux()
	pub.HandleFunc("GET /storefront-api/geography", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.restaurant.GetGeography(r.Context(), r.URL.Query().Get("kind"), r.URL.Query().Get("regionId"), r.URL.Query().Get("cityId"), r.URL.Query().Get("coverage") == "available")
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	})
	admin.HandleFunc("GET /api/restaurant/geography", func(w http.ResponseWriter, r *http.Request) {
		v, err := s.restaurant.GetGeography(r.Context(), r.URL.Query().Get("kind"), r.URL.Query().Get("regionId"), r.URL.Query().Get("cityId"), false)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	})
	admin.HandleFunc("PUT /api/restaurant/geography/district", func(w http.ResponseWriter, r *http.Request) {
		var in restaurantGeographyDistrictInput
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, err := s.restaurant.SaveGeographyDistrict(r.Context(), in)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, v)
	})
	s.registerRestaurantCompletionRoutes(pub, admin)
	s.registerRestaurantBrandRoutes(admin)
	s.registerRestaurantRefundRoutes(pub, admin)
	s.registerRestaurantLocationPublicRoutes(pub)
	s.registerConversationArchiveRoutes(admin)
	s.registerRestaurantPaymentHandlers(pub, admin, hooks)
	mux.Handle("/payment-hooks/", s.restaurantPaymentHookGuard(hooks))
	s.registerRestaurantCourierRoutes(mux, func(h http.Handler) http.Handler { return guard(true, h) }, func(h http.Handler) http.Handler { return guard(false, h) })
	s.registerRestaurantReopenRoutes(admin)
	admin.HandleFunc("/api/restaurant/", func(w http.ResponseWriter, r *http.Request) {
		writeRestaurantError(w, restaurantFail(404, "not_found"))
	})
	mux.Handle("/api/restaurant/", guard(true, admin))
	mux.HandleFunc("GET /restaurant-media/{name}", s.handleRestaurantImage)
}

// Provider notifications do not have a browser origin. This bounded transport
// guard intentionally does NOT authenticate payment results: provider handlers
// must verify signatures and/or requery the authoritative provider API first.
func (s *server) restaurantPaymentHookGuard(next http.Handler) http.Handler {
	limiter := &restaurantRateLimiter{entries: make(map[string]restaurantRateEntry)}
	slots := make(chan struct{}, 32)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(15 * time.Second))
		if r.Method != http.MethodPost && !(r.Method == http.MethodGet && strings.HasPrefix(r.URL.Path, "/payment-hooks/return/")) {
			writeRestaurantError(w, restaurantFail(405, "invalid_request"))
			return
		}
		if !limiter.allow(restaurantClientIP(r), 120) {
			w.Header().Set("Retry-After", "60")
			writeRestaurantError(w, restaurantFail(429, "rate_limited"))
			return
		}
		select {
		case slots <- struct{}{}:
			defer func() { <-slots }()
		default:
			writeRestaurantError(w, restaurantFail(429, "rate_limited"))
			return
		}
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "server_error"))
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// SPA fallback is explicit; unknown API/static paths remain 404 and private
// workspace files can never be served by this handler.
func restaurantStatic(directory string) http.Handler {
	files := http.FileServer(http.Dir(directory))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		w.Header().Set("X-Frame-Options", "SAMEORIGIN")
		if r.Method != "GET" && r.Method != "HEAD" {
			http.NotFound(w, r)
			return
		}
		switch r.URL.Path {
		case "/", "/order", "/track", "/account", "/admin", "/admin/calls", "/courier", "/payment-return":
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, filepath.Join(directory, "index.html"))
			return
		}
		clean := strings.TrimPrefix(r.URL.Path, "/")
		if clean == "" || strings.HasPrefix(clean, ".") || strings.Contains(clean, "/.") || strings.HasPrefix(clean, "api/") || strings.HasPrefix(clean, "storefront-api/") || strings.HasPrefix(clean, "courier-api/") || strings.HasPrefix(clean, "payment-hooks/") {
			http.NotFound(w, r)
			return
		}
		info, err := os.Stat(filepath.Join(directory, filepath.FromSlash(clean)))
		if err != nil || info.IsDir() {
			http.NotFound(w, r)
			return
		}
		files.ServeHTTP(w, r)
	})
}
