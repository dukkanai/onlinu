package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestNegotiateTranslation(t *testing.T) {
	var requests int
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		switch r.URL.Path {
		case "/realtime/translations/client_secrets":
			if r.Method != "POST" || r.Header.Get("Authorization") != "Bearer server-secret" || r.Header.Get("OpenAI-Safety-Identifier") != "hashed-operator" {
				t.Error("missing authentication or safety identifier")
			}
			var payload struct {
				Session struct {
					Model string `json:"model"`
					Audio struct {
						Output struct {
							Language string `json:"language"`
						} `json:"output"`
					} `json:"audio"`
				} `json:"session"`
			}
			if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || payload.Session.Model != translationModel || payload.Session.Audio.Output.Language != "ar" {
				t.Error("wrong translation model or target language")
			}
			writeJSON(w, 200, map[string]string{"value": "ephemeral-secret"})
		case "/realtime/translations/calls":
			body, _ := io.ReadAll(r.Body)
			if r.Header.Get("Authorization") != "Bearer ephemeral-secret" || r.Header.Get("Content-Type") != "application/sdp" || string(body) != "v=0\r\noffer" {
				t.Error("SDP must use the ephemeral credential and original offer")
			}
			w.WriteHeader(201)
			_, _ = io.WriteString(w, "v=0\r\nanswer")
		default:
			t.Errorf("unexpected endpoint: %s", r.URL.Path)
		}
	}))
	defer provider.Close()
	answer, err := negotiateTranslation(context.Background(), provider.Client(), provider.URL, "server-secret", "hashed-operator", "ar", "v=0\r\noffer")
	if err != nil || answer != "v=0\r\nanswer" || requests != 2 {
		t.Fatalf("answer=%q requests=%d err=%v", answer, requests, err)
	}
}

func TestTranslationProviderFailuresDoNotLeakSecrets(t *testing.T) {
	for _, code := range []int{401, 429, 500} {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.WriteHeader(code)
			_, _ = io.WriteString(w, "secret-credential provider-internal-details")
		}))
		_, err := negotiateTranslation(context.Background(), provider.Client(), provider.URL, "secret-credential", "hash", "en", "v=0")
		provider.Close()
		if err == nil || strings.Contains(err.Error(), "secret-credential") || strings.Contains(err.Error(), "provider-internal") {
			t.Fatalf("provider error leaked or went unnoticed: %v", err)
		}
	}
}

func TestTranslationRejectsMalformedProviderResponse(t *testing.T) {
	for _, response := range []string{`{}`, `{"value":""}`, `not-json`} {
		provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = io.WriteString(w, response) }))
		_, err := negotiateTranslation(context.Background(), provider.Client(), provider.URL, "key", "hash", "en", "v=0")
		provider.Close()
		if err == nil {
			t.Fatalf("accepted malformed credential response %q", response)
		}
	}
}

func translationTestServer() *server {
	owner := "operator"
	broker := NewBroker()
	broker.calls["call"] = &CallRecord{SessionID: "session", CallID: "call", Owner: &owner, Status: StatusConnected}
	reg := newCallRegistry()
	reg.add("call", &activeCall{})
	return &server{
		broker: broker, log: slog.Default(),
		sessions: &SessionManager{sessions: map[string]*Session{"session": {id: "session", reg: reg}}},
	}
}

func TestTranslationAccessAndInput(t *testing.T) {
	t.Setenv("WACALLS_API_KEY", "app-key")
	t.Setenv("OPENAI_API_KEY", "provider-key")
	s := translationTestServer()
	for _, tc := range []struct {
		name, key, owner, body string
		status                 int
	}{
		{"unauthenticated", "", "operator", `{}`, 401},
		{"wrong operator", "app-key", "other", `{}`, 403},
		{"missing operator", "app-key", "", `{}`, 403},
		{"bad JSON", "app-key", "operator", `{`, 400},
		{"invalid SDP", "app-key", "operator", `{"direction":"outgoing","language":"en","sdp_offer":"invalid"}`, 400},
		{"invalid language", "app-key", "operator", `{"direction":"outgoing","language":"../../","sdp_offer":"v=0"}`, 400},
		{"invalid direction", "app-key", "operator", `{"direction":"other","language":"en","sdp_offer":"v=0"}`, 400},
		{"incoming must be Arabic", "app-key", "operator", `{"direction":"incoming","language":"fr","sdp_offer":"v=0"}`, 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("POST", "/api/sessions/session/calls/call/translation", strings.NewReader(tc.body))
			r.Header.Set("X-API-Key", tc.key)
			r.Header.Set("X-Client-Id", tc.owner)
			w := httptest.NewRecorder()
			s.routes().ServeHTTP(w, r)
			if w.Code != tc.status {
				t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
			}
		})
	}
	t.Setenv("OPENAI_API_KEY", "")
	r := httptest.NewRequest("POST", "/api/sessions/session/calls/call/translation", strings.NewReader(`{}`))
	r.Header.Set("X-API-Key", "app-key")
	w := httptest.NewRecorder()
	s.routes().ServeHTTP(w, r)
	if w.Code != 503 {
		t.Fatalf("missing key: %d", w.Code)
	}
	t.Setenv("OPENAI_API_KEY", "provider-key")
	t.Setenv("WACALLS_API_KEY", "")
	if translationEnabled() {
		t.Fatal("paid endpoint must be disabled without app authentication")
	}
}

func TestTranslationOwnershipAndConcurrentLimit(t *testing.T) {
	s := translationTestServer()
	if s.broker.ownsTranslationCall("other-session", "call", "operator") {
		t.Fatal("cross-session access")
	}
	s.broker.calls["call"].Status = StatusEnded
	if s.broker.ownsTranslationCall("session", "call", "operator") {
		t.Fatal("ended call access")
	}
	ac := &activeCall{}
	var accepted atomic.Int32
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ac.reserveTranslation("operator", "outgoing") {
				accepted.Add(1)
			}
		}()
	}
	wg.Wait()
	if accepted.Load() != 2 {
		t.Fatalf("unbounded creation: %d", accepted.Load())
	}
	if !ac.reserveTranslation("operator", "incoming") {
		t.Fatal("second direction blocked")
	}
}
