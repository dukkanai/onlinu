package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"strings"
	"time"
)

func (s *server) metaAvailable(w http.ResponseWriter) bool {
	if s.meta == nil || s.metaCalls == nil || os.Getenv("WACALLS_API_KEY") == "" {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Official accounts require API authentication and server configuration."})
		return false
	}
	return true
}

func writeMetaError(w http.ResponseWriter, err error) {
	var callErr *metaCallError
	if errors.As(err, &callErr) {
		writeJSON(w, callErr.Status, map[string]string{"error": callErr.Message})
		return
	}
	status, message := safeMetaConfigError(err)
	writeJSON(w, status, map[string]string{"error": message})
}

func (s *server) writeMetaConfig(w http.ResponseWriter, sid string) {
	config, err := s.meta.Public(sid, strings.TrimRight(os.Getenv("WACALLS_PUBLIC_BASE_URL"), "/"))
	if err != nil {
		writeMetaError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, config)
}

// This dispatch runs INSIDE API authentication. A Meta session is never sent to
// WhatsMeow; unsupported endpoints fail closed, even if called outside the UI.
func (s *server) routeMeta(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Match the exact namespace guarded by withAuth; never normalize an
		// unauthenticated //api/... path into an authenticated API operation.
		if !strings.HasPrefix(r.URL.Path, "/api/sessions/") {
			next.ServeHTTP(w, r)
			return
		}
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) < 3 || parts[0] != "api" || parts[1] != "sessions" || !strings.HasPrefix(parts[2], "meta_") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		if !s.metaAvailable(w) {
			return
		}
		sid := parts[2]
		path := strings.Join(parts[3:], "/")
		if (path == "meta" && r.Method == http.MethodPut) || (path == "" && r.Method == http.MethodDelete) || (path == "meta/verify" && r.Method == http.MethodPost) {
			s.metaConfigMu.Lock()
			defer s.metaConfigMu.Unlock()
		} else {
			s.metaConfigMu.RLock()
			defer s.metaConfigMu.RUnlock()
		}
		if _, ok := s.meta.Account(sid); !ok {
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such official account"})
			return
		}
		r.SetPathValue("sid", sid)
		ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
		defer cancel()
		r = r.WithContext(ctx)
		switch {
		case path == "" && r.Method == http.MethodDelete:
			if s.metaCalls.HasSessionCalls(sid) {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "End active calls before removing this account."})
				return
			}
			if err := s.meta.Delete(ctx, sid); err != nil {
				writeMetaError(w, err)
				return
			}
			s.broker.emitSessionList(s.sessions.infos())
			w.WriteHeader(http.StatusNoContent)
		case path == "meta" && r.Method == http.MethodGet:
			s.writeMetaConfig(w, sid)
		case path == "meta" && r.Method == http.MethodPut:
			if s.metaCalls.HasSessionCalls(sid) {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "End active calls before changing account credentials."})
				return
			}
			var cfg metaConfig
			if !decodeMetaBody(w, r, &cfg) {
				return
			}
			if err := s.meta.Update(ctx, sid, cfg); err != nil {
				writeMetaError(w, err)
				return
			}
			s.broker.emitSessionList(s.sessions.infos())
			s.writeMetaConfig(w, sid)
		case path == "meta/verify" && r.Method == http.MethodPost:
			if err := s.meta.Verify(ctx, sid); err != nil {
				s.broker.emitSessionList(s.sessions.infos())
				writeMetaError(w, err)
				return
			}
			s.broker.emitSessionList(s.sessions.infos())
			s.writeMetaConfig(w, sid)
		case path == "meta/permissions" && (r.Method == http.MethodGet || r.Method == http.MethodPost):
			account, _ := s.meta.Account(sid)
			phone := r.URL.Query().Get("phone")
			if r.Method == http.MethodPost {
				var body struct {
					Phone string `json:"phone"`
				}
				if !decodeMetaBody(w, r, &body) {
					return
				}
				phone = body.Phone
			}
			if !account.Verified || !account.CallingEnabled || account.SIPEnabled {
				writeJSON(w, http.StatusConflict, map[string]string{"error": "Verify an eligible Graph calling account first."})
				return
			}
			if r.Method == http.MethodGet {
				permission, err := s.meta.graph.Permissions(ctx, account.Config, phone)
				if err != nil {
					writeMetaError(w, err)
					return
				}
				writeJSON(w, http.StatusOK, permission)
			} else {
				// Sending a permission message is never a side effect of dialing.
				if err := s.meta.graph.RequestPermission(ctx, account.Config, phone); err != nil {
					writeMetaError(w, err)
					return
				}
				writeJSON(w, http.StatusOK, map[string]string{"status": "requested"})
			}
		case path == "calls" && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"active": s.metaCalls.Count(sid), "maxCallsPerSession": s.sessions.maxCalls})
		case path == "calls" && r.Method == http.MethodPost:
			var body struct {
				Phone      string `json:"phone"`
				Video      bool   `json:"video"`
				Record     bool   `json:"record"`
				DurationMS int    `json:"duration_ms"`
			}
			if !decodeMetaBody(w, r, &body) {
				return
			}
			if body.Video || body.Record || body.DurationMS != 0 {
				writeJSON(w, http.StatusUnprocessableEntity, map[string]string{"error": "Official calling currently supports live WebRTC audio only; video, recording and duration limits are unavailable."})
				return
			}
			id, err := s.metaCalls.Start(ctx, sid, clientID(r), body.Phone)
			if err != nil {
				writeMetaError(w, err)
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"call": map[string]string{"callId": id}})
		case path == "history" && r.Method == http.MethodGet:
			writeJSON(w, http.StatusOK, map[string]any{"rows": s.broker.historyRows(sid, 50)})
		case len(parts) >= 5 && parts[3] == "calls" && parts[4] != "fake":
			id := parts[4]
			r.SetPathValue("id", id)
			action := strings.Join(parts[5:], "/")
			var err error
			switch {
			case action == "" && r.Method == http.MethodDelete:
				err = s.metaCalls.End(ctx, sid, id, clientID(r))
				if err == nil {
					w.WriteHeader(http.StatusNoContent)
					return
				}
			case action == "accept" && r.Method == http.MethodPost:
				err = s.metaCalls.Accept(ctx, sid, id, clientID(r))
				if err == nil {
					writeJSON(w, http.StatusOK, map[string]any{"call": map[string]string{"callId": id}})
					return
				}
			case action == "reject" && r.Method == http.MethodPost:
				err = s.metaCalls.Reject(ctx, sid, id, clientID(r))
				if err == nil {
					writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
					return
				}
			case action == "webrtc" && r.Method == http.MethodPost:
				var body struct {
					SDP string `json:"sdp_offer"`
				}
				if !decodeMetaBody(w, r, &body) {
					return
				}
				var answer string
				answer, err = s.metaCalls.WebRTC(ctx, sid, id, clientID(r), body.SDP)
				if err == nil {
					writeJSON(w, http.StatusOK, map[string]string{"sdp_answer": answer})
					return
				}
			case action == "translation" && r.Method == http.MethodPost:
				s.handleTranslation(w, r)
				return
			default:
				metaUnsupported(w)
				return
			}
			writeMetaError(w, err)
		default:
			metaUnsupported(w)
		}
	})
}

func metaUnsupported(w http.ResponseWriter) {
	writeJSON(w, http.StatusNotImplemented, map[string]string{"error": "This operation is unavailable for the official provider. Use its Meta settings and WebRTC voice calling controls."})
}

func decodeMetaBody(w http.ResponseWriter, r *http.Request, dst any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(dst); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid request body"})
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "expected a single JSON object"})
		return false
	}
	return true
}

func (s *server) handleMetaWebhookVerify(w http.ResponseWriter, r *http.Request) {
	s.metaConfigMu.RLock()
	defer s.metaConfigMu.RUnlock()
	w.Header().Set("Cache-Control", "no-store")
	if s.meta == nil {
		http.NotFound(w, r)
		return
	}
	q := r.URL.Query()
	if q.Get("hub.mode") != "subscribe" || q.Get("hub.challenge") == "" || len(q.Get("hub.challenge")) > 512 {
		http.Error(w, "invalid verification request", http.StatusBadRequest)
		return
	}
	if err := s.meta.MarkWebhookVerifiedToken(r.Context(), r.PathValue("sid"), q.Get("hub.verify_token")); err != nil {
		http.Error(w, "verification failed", http.StatusForbidden)
		return
	}
	s.broker.emitSessionList(s.sessions.infos())
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, q.Get("hub.challenge"))
}

func validMetaSignature(secret, signature string, body []byte) bool {
	if secret == "" || !strings.HasPrefix(signature, "sha256=") {
		return false
	}
	got, err := hex.DecodeString(strings.TrimPrefix(signature, "sha256="))
	if err != nil || len(got) != sha256.Size {
		return false
	}
	hash := hmac.New(sha256.New, []byte(secret))
	_, _ = hash.Write(body)
	return hmac.Equal(got, hash.Sum(nil))
}

// Extract only events for this WABA AND phone number, across every batched entry.
// Message/permission-reply events are acknowledged, never mistaken for calls.
func parseMetaWebhook(body []byte, cfg metaConfig) ([]metaCallEvent, error) {
	var envelope struct {
		Object string `json:"object"`
		Entry  []struct {
			ID      string `json:"id"`
			Changes []struct {
				Field string `json:"field"`
				Value struct {
					Metadata struct {
						PhoneNumberID string `json:"phone_number_id"`
					} `json:"metadata"`
					Calls    []metaCallEvent                                `json:"calls"`
					Statuses []struct{ ID, Type, Status, Timestamp string } `json:"statuses"`
				} `json:"value"`
			} `json:"changes"`
		} `json:"entry"`
	}
	if err := json.Unmarshal(body, &envelope); err != nil {
		return nil, err
	}
	var events []metaCallEvent
	if envelope.Object != "whatsapp_business_account" {
		return events, nil
	}
	for _, entry := range envelope.Entry {
		if entry.ID != cfg.WABAID {
			continue
		}
		for _, change := range entry.Changes {
			if change.Field != "calls" || change.Value.Metadata.PhoneNumberID != cfg.PhoneNumberID {
				continue
			}
			events = append(events, change.Value.Calls...)
			for _, status := range change.Value.Statuses {
				if status.Type == "call" {
					events = append(events, metaCallEvent{ID: status.ID, Event: "status", Status: status.Status, Timestamp: status.Timestamp})
				}
			}
		}
	}
	return events, nil
}

func (s *server) handleMetaWebhook(w http.ResponseWriter, r *http.Request) {
	s.metaConfigMu.RLock()
	defer s.metaConfigMu.RUnlock()
	w.Header().Set("Cache-Control", "no-store")
	if s.meta == nil || s.metaCalls == nil {
		http.NotFound(w, r)
		return
	}
	sid := r.PathValue("sid")
	account, ok := s.meta.Account(sid)
	if !ok {
		http.NotFound(w, r)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	body, err := io.ReadAll(r.Body)
	if err != nil {
		http.Error(w, "invalid webhook body", http.StatusBadRequest)
		return
	}
	if !validMetaSignature(account.Config.AppSecret, r.Header.Get("X-Hub-Signature-256"), body) {
		http.Error(w, "invalid webhook signature", http.StatusUnauthorized)
		return
	}
	events, err := parseMetaWebhook(body, account.Config)
	if err != nil {
		http.Error(w, "invalid webhook JSON", http.StatusBadRequest)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
	defer cancel()
	for _, event := range events {
		if err := s.metaCalls.HandleEvent(ctx, sid, event); err != nil {
			// Retry on transient database/processing failure. No body, token or SDP
			// is logged or returned; the runtime handles duplicate delivery.
			http.Error(w, "webhook processing unavailable", http.StatusServiceUnavailable)
			return
		}
	}
	w.WriteHeader(http.StatusOK)
	_, _ = io.WriteString(w, "EVENT_RECEIVED")
}
