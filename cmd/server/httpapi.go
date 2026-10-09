package main

import (
	"encoding/json"
	"net/http"
	"os"
	"strings"
)

func (s *server) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", s.handleHealth)
	s.registerRestaurantRoutes(mux)
	s.registerPlatformOrderRoutes(mux)
	if s.staticDir != "" {
		if _, err := os.Stat(s.staticDir); err == nil {
			mux.Handle("/", restaurantStatic(s.staticDir))
		}
	}
	var h http.Handler = mux
	if key := runtimeSecret("WACALLS_API_KEY"); key != "" {
		h = withAuth(h, key, "")
	}
	return withCORS(h)
}
func withAuth(h http.Handler, key, unusedWidgetKey string) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/api/") && r.Header.Get("X-API-Key") != key {
			writeJSON(w, 401, map[string]string{"error": "unauthorized"})
			return
		}
		h.ServeHTTP(w, r)
	})
}
func withCORS(h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Customer cookies and restaurant administration are same-origin only.
		if strings.HasPrefix(r.URL.Path, "/storefront-api/") || strings.HasPrefix(r.URL.Path, "/api/restaurant/") || strings.HasPrefix(r.URL.Path, "/courier-api/") || strings.HasPrefix(r.URL.Path, "/payment-hooks/") || strings.HasPrefix(r.URL.Path, "/recordings/") {
			h.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Client-Id, X-API-Key")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		h.ServeHTTP(w, r)
	})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}
