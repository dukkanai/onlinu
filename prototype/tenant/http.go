package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func reply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func replyError(w http.ResponseWriter, err error) {
	var f failure
	if errors.As(err, &f) {
		reply(w, f.status, map[string]string{"error": f.code})
		return
	}
	reply(w, 503, map[string]string{"error": "service_unavailable"})
}

func decode(w http.ResponseWriter, r *http.Request, body any) error {
	media, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || media != "application/json" {
		return fail(400, "invalid_json")
	}
	r.Body = http.MaxBytesReader(w, r.Body, 32<<10)
	d := json.NewDecoder(r.Body)
	d.DisallowUnknownFields()
	if err = d.Decode(body); err != nil {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return fail(413, "body_too_large")
		}
		return fail(400, "invalid_json")
	}
	if err = d.Decode(new(any)); err != io.EOF {
		var limit *http.MaxBytesError
		if errors.As(err, &limit) {
			return fail(413, "body_too_large")
		}
		return fail(400, "invalid_json")
	}
	return nil
}

func (s *service) authorize(r *http.Request, roles ...string) (actor, error) {
	a := actor{id: r.Header.Get("X-Actor-ID"), role: r.Header.Get("X-Actor-Role")}
	allowed := false
	for _, role := range roles {
		if role == a.role {
			allowed = true
		}
	}
	if !allowed {
		return actor{}, fail(403, "forbidden")
	}
	switch a.role {
	case "customer":
		if a.id != "customer-alice" && a.id != "customer-bob" {
			return actor{}, fail(403, "forbidden")
		}
	case "merchant":
		merchant := "merchant-a"
		if s.tenantID == "demo-b" {
			merchant = "merchant-b"
		}
		if a.id != merchant {
			return actor{}, fail(403, "forbidden")
		}
	case "service":
	default:
		return actor{}, fail(403, "forbidden")
	}
	return a, nil
}

func (s *service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
	if r.Method == http.MethodGet && r.URL.Path == "/health" {
		if err := s.db.PingContext(ctx); err != nil {
			replyError(w, err)
			return
		}
		reply(w, 200, map[string]string{"status": "ok", "mode": "synthetic", "tenantId": s.tenantID})
		return
	}
	provided := r.Header.Get("Authorization")
	expectedHash := sha256.Sum256([]byte("Bearer " + s.token))
	providedHash := sha256.Sum256([]byte(provided))
	if len(s.token) < 32 || subtle.ConstantTimeCompare(expectedHash[:], providedHash[:]) != 1 {
		replyError(w, fail(401, "unauthorized"))
		return
	}
	status, body, err := s.route(r, w)
	if err != nil {
		replyError(w, err)
		return
	}
	reply(w, status, body)
}

func (s *service) route(r *http.Request, w http.ResponseWriter) (int, any, error) {
	ctx := r.Context()
	switch {
	case r.Method == "GET" && r.URL.Path == "/menu":
		v, err := s.menu(ctx)
		return 200, v, err
	case r.Method == "POST" && r.URL.Path == "/quote":
		var in cartInput
		if err := decode(w, r, &in); err != nil {
			return 0, nil, err
		}
		v, err := s.quote(ctx, in.Items)
		return 200, v, err
	case r.Method == "POST" && r.URL.Path == "/orders":
		a, err := s.authorize(r, "customer")
		if err != nil {
			return 0, nil, err
		}
		var in orderInput
		if err = decode(w, r, &in); err != nil {
			return 0, nil, err
		}
		v, err := s.create(ctx, a.id, in)
		return 201, v, err
	case r.Method == "GET" && r.URL.Path == "/orders":
		if _, err := s.authorize(r, "merchant"); err != nil {
			return 0, nil, err
		}
		v, err := s.list(ctx)
		return 200, map[string]any{"orders": v}, err
	case r.Method == "GET" && r.URL.Path == "/orders/by-idempotency":
		a, err := s.authorize(r, "customer")
		if err != nil {
			return 0, nil, err
		}
		query, err := url.ParseQuery(r.URL.RawQuery)
		if err != nil || len(query) != 1 || len(query["key"]) != 1 {
			return 0, nil, fail(400, "invalid_request")
		}
		v, err := s.getByIdempotency(ctx, query.Get("key"), a)
		return 200, v, err
	case r.Method == "GET" && r.URL.Path == "/events":
		if _, err := s.authorize(r, "service"); err != nil {
			return 0, nil, err
		}
		after, limit := int64(0), 100
		query := r.URL.Query()
		var err error
		for key, values := range query {
			if key != "after" && key != "limit" || len(values) != 1 {
				return 0, nil, fail(400, "invalid_cursor")
			}
		}
		if value, ok := query["after"]; ok {
			after, err = strconv.ParseInt(value[0], 10, 64)
			if err != nil || after < 0 {
				return 0, nil, fail(400, "invalid_cursor")
			}
		}
		if value, ok := query["limit"]; ok {
			limit, err = strconv.Atoi(value[0])
			if err != nil || limit < 1 || limit > 100 {
				return 0, nil, fail(400, "invalid_cursor")
			}
		}
		v, err := s.events(ctx, after, limit)
		return 200, map[string]any{"events": v}, err
	}
	path := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")
	if len(path) < 2 || path[0] != "orders" || !identifier.MatchString(path[1]) {
		return 0, nil, fail(404, "not_found")
	}
	id := path[1]
	if len(path) == 2 && r.Method == "GET" {
		a, err := s.authorize(r, "customer", "merchant")
		if err != nil {
			return 0, nil, err
		}
		v, err := s.get(ctx, id, a)
		return 200, v, err
	}
	if len(path) == 3 && r.Method == "POST" {
		switch path[2] {
		case "simulate-payment":
			a, err := s.authorize(r, "customer")
			if err != nil {
				return 0, nil, err
			}
			if !s.synthetic {
				return 0, nil, fail(404, "not_found")
			}
			var in struct{}
			if err = decode(w, r, &in); err != nil {
				return 0, nil, err
			}
			v, err := s.mutate(ctx, id, a, "", 0, true)
			return 200, v, err
		case "status":
			a, err := s.authorize(r, "merchant")
			if err != nil {
				return 0, nil, err
			}
			var in struct {
				Status          string `json:"status"`
				ExpectedVersion int64  `json:"expectedVersion"`
			}
			if err = decode(w, r, &in); err != nil {
				return 0, nil, err
			}
			if in.ExpectedVersion < 1 || !identifier.MatchString(in.Status) {
				return 0, nil, fail(400, "invalid_request")
			}
			v, err := s.mutate(ctx, id, a, in.Status, in.ExpectedVersion, false)
			return 200, v, err
		case "confirm-test-payment":
			if _, err := s.authorize(r, "service"); err != nil {
				return 0, nil, err
			}
			var in testPaymentInput
			if err := decode(w, r, &in); err != nil {
				return 0, nil, err
			}
			v, err := s.confirmTestPayment(ctx, id, in)
			return 200, v, err
		}
	}
	return 0, nil, fail(404, "not_found")
}
