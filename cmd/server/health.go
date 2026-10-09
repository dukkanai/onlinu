package main

import (
	"context"
	"net/http"
	"time"
)

// handleHealth reports HTTP and database readiness without exposing configuration
// or requiring the application API key, so containers can probe it locally.
func (s *server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	if s == nil || s.db == nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	if s.ownership != nil && !s.ownership.healthy.Load() {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		http.Error(w, "unavailable", http.StatusServiceUnavailable)
		return
	}
	_, _ = w.Write([]byte("ok\n"))
}
