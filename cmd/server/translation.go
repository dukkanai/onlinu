package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"time"
)

const translationModel = "gpt-realtime-translate"

var translationLanguage = regexp.MustCompile(`^[a-z]{2,3}(-[A-Z]{2})?$`)

func translationEnabled() bool {
	// This endpoint creates billable sessions: never expose it without API auth.
	return os.Getenv("OPENAI_API_KEY") != "" && os.Getenv("WACALLS_API_KEY") != ""
}

// ownsTranslationCall uses the existing operator identity AND API authentication.
func (b *Broker) ownsTranslationCall(sid, id, owner string) bool {
	b.mu.RLock()
	defer b.mu.RUnlock()
	c := b.calls[id]
	return owner != "" && c != nil && c.SessionID == sid && c.Status != StatusEnded && c.Owner != nil && *c.Owner == owner
}

// reserveTranslation bounds paid session creation, including concurrent requests.
// Each operator has at most two setup attempts per direction, including retries.
func (ac *activeCall) reserveTranslation(owner, direction string) bool {
	ac.translationMu.Lock()
	defer ac.translationMu.Unlock()
	if ac.translationAttempts == nil {
		ac.translationAttempts = make(map[string]int)
	}
	key := owner + ":" + direction
	if ac.translationAttempts[key] >= 2 || len(ac.translationAttempts) >= 32 {
		return false
	}
	ac.translationAttempts[key]++
	return true
}

func (s *server) handleTranslation(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	if !translationEnabled() {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "Translation requires OPENAI_API_KEY and WACALLS_API_KEY on the server."})
		return
	}
	sid, id, owner := r.PathValue("sid"), r.PathValue("id"), clientID(r)
	if !s.broker.ownsTranslationCall(sid, id, owner) {
		writeJSON(w, http.StatusForbidden, map[string]string{"error": "Translation is only available to the current call owner."})
		return
	}
	var ac *activeCall
	var ok bool
	if s.metaCalls != nil && strings.HasPrefix(sid, "meta_") {
		ac, ok = s.metaCalls.TranslationCall(sid, id)
	} else {
		sess := s.sessionByID(w, sid)
		if sess == nil {
			return
		}
		ac, ok = sess.reg.get(id)
	}
	if !ok {
		writeJSON(w, http.StatusNotFound, map[string]string{"error": "no such call"})
		return
	}
	var body struct {
		SDP       string `json:"sdp_offer"`
		Language  string `json:"language"`
		Direction string `json:"direction"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil || !strings.HasPrefix(body.SDP, "v=0") || !translationLanguage.MatchString(body.Language) || (body.Direction != "outgoing" && body.Direction != "incoming") {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Valid sdp_offer, language and direction are required."})
		return
	}
	if body.Direction == "incoming" && body.Language != "ar" {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Incoming translation must target Arabic (ar)."})
		return
	}
	if !ac.reserveTranslation(owner, body.Direction) {
		writeJSON(w, http.StatusTooManyRequests, map[string]string{"error": "Translation setup limit reached for this call."})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 25*time.Second)
	defer cancel()
	sum := sha256.Sum256([]byte(sid + ":" + owner))
	answer, err := negotiateTranslation(ctx, http.DefaultClient, "https://api.openai.com/v1", os.Getenv("OPENAI_API_KEY"), hex.EncodeToString(sum[:]), body.Language, body.SDP)
	if err != nil {
		// Do not return provider bodies, credentials, SDP, or transcripts in errors.
		s.log.Warn("translation setup failed", "call", id, "direction", body.Direction, "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]string{"error": "OpenAI translation could not connect. Check model access, quota and the selected language."})
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"sdp_answer": answer})
}

// Both the long-lived API key and ephemeral credentials stay on the server.
// Only SDP crosses our API; the two audio tracks use separate WebRTC sessions.
func negotiateTranslation(ctx context.Context, client *http.Client, baseURL, key, safetyID, language, sdp string) (string, error) {
	payload, _ := json.Marshal(map[string]any{
		"session": map[string]any{
			"model": translationModel,
			"audio": map[string]any{"output": map[string]string{"language": language}},
		},
	})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/realtime/translations/client_secrets", bytes.NewReader(payload))
	if err != nil {
		return "", fmt.Errorf("translation request configuration")
	}
	req.Header.Set("Authorization", "Bearer "+key)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("OpenAI-Safety-Identifier", safetyID)
	res, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("translation credential connection failed")
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("translation credentials: HTTP %d", res.StatusCode)
	}
	var secret struct {
		Value string `json:"value"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&secret); err != nil || secret.Value == "" {
		return "", fmt.Errorf("invalid translation credentials response")
	}
	req, err = http.NewRequestWithContext(ctx, http.MethodPost, baseURL+"/realtime/translations/calls", strings.NewReader(sdp))
	if err != nil {
		return "", fmt.Errorf("translation SDP configuration")
	}
	req.Header.Set("Authorization", "Bearer "+secret.Value)
	req.Header.Set("Content-Type", "application/sdp")
	res, err = client.Do(req)
	if err != nil {
		return "", fmt.Errorf("translation SDP connection failed")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return "", fmt.Errorf("translation SDP: HTTP %d", res.StatusCode)
	}
	answer, err := io.ReadAll(io.LimitReader(res.Body, (64<<10)+1))
	if err != nil || len(answer) > 64<<10 || !bytes.HasPrefix(answer, []byte("v=0")) {
		return "", fmt.Errorf("invalid translation SDP response")
	}
	return string(answer), nil
}
