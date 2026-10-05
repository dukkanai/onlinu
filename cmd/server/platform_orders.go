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
	"strconv"
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
	return platformPrincipalRef(a.issuer, a.tenantID, claims.Subject), nil
}
func platformPrincipalRef(issuer, tenant, subject string) string {
	owner := sha256.Sum256([]byte(issuer + "\x00" + tenant + "\x00" + subject))
	return "platform:" + hex.EncodeToString(owner[:])
}

type platformOrderView struct {
	Number          string    `json:"number"`
	Version         int64     `json:"version"`
	Status          string    `json:"status"`
	PaymentStatus   string    `json:"paymentStatus"`
	TotalMinor      int64     `json:"totalMinor"`
	Currency        string    `json:"currency"`
	Mode            string    `json:"mode"`
	PaymentMethod   string    `json:"paymentMethod,omitempty"`
	PaymentProvider string    `json:"paymentProvider,omitempty"`
	UpdatedAt       time.Time `json:"updatedAt"`
}

func publicPlatformOrder(order restaurantOrder) platformOrderView {
	return platformOrderView{Number: order.Number, Version: order.Version, Status: order.Status,
		PaymentStatus: order.Payment.Status, TotalMinor: order.TotalMinor, Currency: order.Currency,
		Mode: order.Mode, PaymentMethod: order.Payment.Method, PaymentProvider: order.Payment.Provider, UpdatedAt: order.UpdatedAt}
}

// Separate owned receipt summary: no contact details or access tokens.
type platformOrderDetails struct {
	platformOrderView
	Items            []restaurantOrderLine `json:"items"`
	Tax              restaurantTaxSummary  `json:"tax"`
	SubtotalMinor    int64                 `json:"subtotalMinor"`
	DeliveryFeeMinor int64                 `json:"deliveryFeeMinor"`
	TableName        string                `json:"tableName,omitempty"`
	Demo             bool                  `json:"demo"`
	CreatedAt        time.Time             `json:"createdAt"`
}

func publicPlatformOrderDetails(order restaurantOrder) platformOrderDetails {
	return platformOrderDetails{platformOrderView: publicPlatformOrder(order), Items: order.Items, Tax: order.Tax,
		SubtotalMinor: order.SubtotalMinor, DeliveryFeeMinor: order.DeliveryFeeMinor, TableName: order.TableName, Demo: order.Demo, CreatedAt: order.CreatedAt}
}

func (s *server) registerPlatformOrderRoutes(mux *http.ServeMux) {
	limiter := &restaurantRateLimiter{entries: make(map[string]restaurantRateEntry)}
	slots := make(chan struct{}, 64)
	uploadSlots := make(chan struct{}, 2)
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
			maxBody := int64(128 * 1024)
			if scope == "staff:media:write" {
				// Bound large unauthenticated reads before allocating buffers.
				select {
				case uploadSlots <- struct{}{}:
					defer func() { <-uploadSlots }()
				default:
					writeRestaurantError(w, restaurantFail(429, "rate_limited"))
					return
				}
				maxBody = restaurantImageLimit
			}
			body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxBody))
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
			if scope == "orders:write" || scope == "staff:media:write" {
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
	s.registerPlatformStaffOrderRoutes(mux, wrap)
	s.registerPlatformChannelRoutes(mux, wrap)
	mux.HandleFunc("POST /platform-api/orders", wrap("orders:write", func(w http.ResponseWriter, r *http.Request, body []byte, owner string) {
		r.Body = io.NopCloser(bytes.NewReader(body))
		var input restaurantOrderInput
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		ctx := context.WithValue(r.Context(), restaurantOrderChannelKey{}, "chatgpt")
		receipt, err := s.orders.Create(ctx, input, owner, r.Header.Get("Idempotency-Key"))
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
	mux.HandleFunc("GET /platform-api/order-details/{number}", wrap("orders:read", func(w http.ResponseWriter, r *http.Request, _ []byte, owner string) {
		order, err := s.orders.Track(r.Context(), r.PathValue("number"), "", "", owner)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, publicPlatformOrderDetails(order))
	}))
	for _, method := range []string{"GET", "POST"} {
		scope := "payments:read"
		if method == "POST" {
			scope = "payments:write"
		}
		mux.HandleFunc(method+" /platform-api/payments/{number}", wrap(scope, func(w http.ResponseWriter, r *http.Request, body []byte, owner string) {
			if s.payments == nil {
				writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
				return
			}
			var view restaurantPaymentView
			var err error
			if r.Method == "GET" {
				view, err = s.payments.Status(r.Context(), r.PathValue("number"), "", owner)
			} else {
				r.Body = io.NopCloser(bytes.NewReader(body))
				var input struct {
					Provider string `json:"provider"`
				}
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				view, err = s.payments.Start(r.Context(), r.PathValue("number"), "", owner, input.Provider)
			}
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, view)
		}))
	}
	mux.HandleFunc("POST /platform-api/payments/{number}/refresh", wrap("payments:read", func(w http.ResponseWriter, r *http.Request, body []byte, owner string) {
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		r.Body = io.NopCloser(bytes.NewReader(body))
		var input struct{}
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		view, err := s.payments.Refresh(r.Context(), r.PathValue("number"), "", owner)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, view)
	}))
	mux.HandleFunc("GET /platform-api/order-events", wrap("events:read", func(w http.ResponseWriter, r *http.Request, _ []byte, owner string) {
		query := r.URL.Query()
		if len(query) > 2 || len(query["after"]) > 1 || len(query["limit"]) > 1 {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		for key := range query {
			if key != "after" && key != "limit" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
		}
		after, limit := int64(0), 100
		var err error
		if query.Has("after") {
			after, err = strconv.ParseInt(query.Get("after"), 10, 64)
			if err != nil {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
		}
		if query.Has("limit") {
			limit, err = strconv.Atoi(query.Get("limit"))
			if err != nil {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
		}
		events, err := s.orders.platformEvents(r.Context(), owner, after, limit)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"events": events})
	}))
}
