package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Internal, short-lived signed request envelope. Not a browser/API master key.
// Each signature binds the actor, restaurant, scope, method, exact request URI,
// body and idempotency key. No caller-provided role or customer ID is trusted.
type platformRequestClaims struct {
	Issuer         string `json:"issuer"`
	Audience       string `json:"audience"`
	Subject        string `json:"subject"`
	Scope          string `json:"scope"`
	Method         string `json:"method"`
	Path           string `json:"path"`
	BodySHA256     string `json:"bodySha256"`
	IdempotencyKey string `json:"idempotencyKey"`
	IssuedAt       int64  `json:"issuedAt"`
	ExpiresAt      int64  `json:"expiresAt"`
}

type platformRequestAuth struct {
	issuer, tenantID string
	publicKey        ed25519.PublicKey
	now              func() time.Time
}

func platformAuthFromEnv() (*platformRequestAuth, error) {
	issuer, tenant, encoded := os.Getenv("WACALLS_PLATFORM_ISSUER"), os.Getenv("WACALLS_PLATFORM_TENANT_ID"), os.Getenv("WACALLS_PLATFORM_PUBLIC_KEY")
	if issuer == "" && tenant == "" && encoded == "" {
		return nil, nil
	}
	u, err := url.Parse(issuer)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "" || !restaurantIDPattern.MatchString(tenant) {
		return nil, errors.New("invalid platform request authentication configuration")
	}
	key, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(key) != ed25519.PublicKeySize {
		return nil, errors.New("invalid platform request public key")
	}
	return &platformRequestAuth{issuer: issuer, tenantID: tenant, publicKey: ed25519.PublicKey(key), now: time.Now}, nil
}

func (a *platformRequestAuth) verify(r *http.Request, body []byte, scope string) (string, error) {
	denied := restaurantFail(401, "platform_unauthorized")
	if a == nil {
		return "", restaurantFail(404, "not_found")
	}
	value := r.Header.Get("Authorization")
	if len(value) > 4096 || !strings.HasPrefix(value, "Platform ") {
		return "", denied
	}
	parts := strings.Split(strings.TrimPrefix(value, "Platform "), ".")
	if len(parts) != 2 {
		return "", denied
	}
	payload, err := base64.RawURLEncoding.Strict().DecodeString(parts[0])
	if err != nil {
		return "", denied
	}
	signature, err := base64.RawURLEncoding.Strict().DecodeString(parts[1])
	if err != nil || !ed25519.Verify(a.publicKey, payload, signature) {
		return "", denied
	}
	var claims platformRequestClaims
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&claims) != nil || decoder.Decode(new(any)) != io.EOF {
		return "", denied
	}
	actor, err := uuid.Parse(claims.Subject)
	if err != nil || actor.String() != claims.Subject {
		return "", denied
	}
	now := a.now().Unix()
	digest := sha256.Sum256(body)
	if claims.Issuer != a.issuer || claims.Audience != a.tenantID || claims.Scope != scope ||
		claims.Method != r.Method || claims.Path != r.URL.RequestURI() || claims.BodySHA256 != hex.EncodeToString(digest[:]) ||
		claims.IdempotencyKey != r.Header.Get("Idempotency-Key") || claims.ExpiresAt <= now ||
		claims.IssuedAt > now+15 || claims.IssuedAt < now-75 || claims.ExpiresAt <= claims.IssuedAt || claims.ExpiresAt-claims.IssuedAt > 60 {
		return "", denied
	}
	// A different namespace from local account UUIDs; no email/phone linking.
	owner := sha256.Sum256([]byte(a.issuer + "\x00" + a.tenantID + "\x00" + claims.Subject))
	return "platform:" + hex.EncodeToString(owner[:]), nil
}

type platformOrderView struct {
	Number        string    `json:"number"`
	Version       int64     `json:"version"`
	Status        string    `json:"status"`
	PaymentStatus string    `json:"paymentStatus"`
	TotalMinor    int64     `json:"totalMinor"`
	Currency      string    `json:"currency"`
	Mode          string    `json:"mode"`
	UpdatedAt     time.Time `json:"updatedAt"`
}

func publicPlatformOrder(order restaurantOrder) platformOrderView {
	return platformOrderView{order.Number, order.Version, order.Status, order.Payment.Status, order.TotalMinor, order.Currency, order.Mode, order.UpdatedAt}
}

func (s *server) registerPlatformOrderRoutes(mux *http.ServeMux) {
	limiter := &restaurantRateLimiter{entries: make(map[string]restaurantRateEntry)}
	slots := make(chan struct{}, 64)
	wrap := func(scope string, next func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
			defer cancel()
			r = r.WithContext(ctx)
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if s.platformAuth == nil {
				writeRestaurantError(w, restaurantFail(404, "not_found"))
				return
			}
			if r.Header.Get("Origin") != "" || r.Header.Get("Cookie") != "" {
				writeRestaurantError(w, restaurantFail(401, "platform_unauthorized"))
				return
			}
			_ = http.NewResponseController(w).SetReadDeadline(time.Now().Add(10 * time.Second))
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 128*1024))
			if err != nil {
				writeRestaurantError(w, restaurantFail(413, "body_too_large"))
				return
			}
			owner, err := s.platformAuth.verify(r, body, scope)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			limit := 240
			if scope == "orders:write" {
				limit = 30
			}
			if !limiter.allow(owner+":"+scope, limit) {
				writeRestaurantError(w, restaurantFail(429, "rate_limited"))
				return
			}
			select {
			case slots <- struct{}{}:
				defer func() { <-slots }()
			default:
				writeRestaurantError(w, restaurantFail(503, "server_busy"))
				return
			}
			if s.orders == nil {
				writeRestaurantError(w, restaurantFail(503, "server_error"))
				return
			}
			next(w, r, body, owner)
		}
	}
	mux.HandleFunc("POST /platform-api/orders", wrap("orders:write", func(w http.ResponseWriter, r *http.Request, body []byte, owner string) {
		r.Body = io.NopCloser(bytes.NewReader(body))
		var input restaurantOrderInput
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		receipt, err := s.orders.Create(r.Context(), input, owner, r.Header.Get("Idempotency-Key"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		// Do not transmit contact/address, receipt capabilities or payment secrets
		// to the central platform or model. Browser checkout is a separate flow.
		writeJSON(w, 200, publicPlatformOrder(receipt.Order))
	}))
	mux.HandleFunc("GET /platform-api/orders/by-idempotency/{key}", wrap("orders:read", func(w http.ResponseWriter, r *http.Request, _ []byte, owner string) {
		parsed, err := uuid.Parse(r.PathValue("key"))
		if err != nil || parsed.Version() != 4 || parsed.String() != r.PathValue("key") {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		digest := sha256.Sum256([]byte("restaurant-submission-v1\x00" + parsed.String()))
		stored, err := restaurantReadStored(s.orders.store.db.QueryRowContext(r.Context(), restaurantOrderSelect+` WHERE idempotency_hash=$1 AND customer_id=$2`, digest[:], owner))
		if errors.Is(err, sql.ErrNoRows) {
			writeRestaurantError(w, restaurantFail(404, "invalid_order_access"))
			return
		}
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, publicPlatformOrder(stored.order))
	}))
	mux.HandleFunc("GET /platform-api/orders/{number}", wrap("orders:read", func(w http.ResponseWriter, r *http.Request, _ []byte, owner string) {
		order, err := s.orders.Track(r.Context(), r.PathValue("number"), "", "", owner)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, publicPlatformOrder(order))
	}))
}
