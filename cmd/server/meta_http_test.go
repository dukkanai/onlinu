package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMetaSignatureExactBody(t *testing.T) {
	body := []byte(`{"entry":[]}`)
	mac := hmac.New(sha256.New, []byte("app-secret-test"))
	mac.Write(body)
	signature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	if !validMetaSignature("app-secret-test", signature, body) {
		t.Fatal("valid signature rejected")
	}
	for _, tc := range []struct {
		secret, signature string
		body              []byte
	}{
		{"", signature, body}, {"wrong", signature, body}, {"app-secret-test", "", body},
		{"app-secret-test", "sha256=bad", body}, {"app-secret-test", signature, append(body, ' ')},
	} {
		if validMetaSignature(tc.secret, tc.signature, tc.body) {
			t.Fatal("invalid signature accepted")
		}
	}
}

func TestMetaWebhookBatchesAndAccountIsolation(t *testing.T) {
	input := `{"object":"whatsapp_business_account","entry":[
	{"id":"other-account","changes":[{"field":"calls","value":{"metadata":{"phone_number_id":"123"},"calls":[{"id":"foreign"}]}}]},
	{"id":"456","changes":[
	{"field":"messages","value":{"metadata":{"phone_number_id":"123"},"calls":[{"id":"not-a-call"}]}},
	{"field":"calls","value":{"metadata":{"phone_number_id":"wrong"},"calls":[{"id":"wrong-phone"}]}},
	{"field":"calls","value":{"metadata":{"phone_number_id":"123"},"calls":[{"id":"inbound","event":"connect","direction":"USER_INITIATED","from_user_id":"bsuid-1","session":{"sdp_type":"offer","sdp":"v=0\r\n"}}]}},
	{"field":"calls","value":{"metadata":{"phone_number_id":"123"},"statuses":[{"id":"outbound","type":"call","status":"ACCEPTED","timestamp":"12345"},{"id":"not-a-call","type":"message","status":"read"}]}}
	]},
	{"id":"456","changes":[{"field":"calls","value":{"metadata":{"phone_number_id":"123"},"calls":[{"id":"inbound","event":"terminate","status":"COMPLETED"}]}}]}
	]}`
	events, err := parseMetaWebhook([]byte(input), metaConfig{PhoneNumberID: "123", WABAID: "456"})
	if err != nil || len(events) != 3 {
		t.Fatalf("events=%+v err=%v", events, err)
	}
	if events[0].ID != "inbound" || events[0].FromUserID != "bsuid-1" || events[0].Session.Type != "offer" {
		t.Fatalf("inbound lost: %+v", events[0])
	}
	if events[1].Event != "status" || events[1].Status != "ACCEPTED" || events[1].ID != "outbound" {
		t.Fatalf("status lost: %+v", events[1])
	}
	if events[2].Event != "terminate" {
		t.Fatal("second entry dropped")
	}
	if _, err = parseMetaWebhook([]byte("{"), metaConfig{}); err == nil {
		t.Fatal("malformed JSON accepted")
	}
}

func TestMetaManagementRequiresMasterKey(t *testing.T) {
	for _, path := range []string{"/api/sessions/meta_test/meta", "/api/sessions/meta_test/meta/verify", "/api/sessions/meta_test/meta/permissions", "/api/sessions/meta_test/calls"} {
		for _, key := range []string{"", "widget-key", "wrong"} {
			req := httptest.NewRequest(http.MethodPost, path, nil)
			req.Header.Set("X-API-Key", key)
			w := httptest.NewRecorder()
			withAuth(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Fatal("unauthorized handler reached") }), "master-key", "widget-key").ServeHTTP(w, req)
			if w.Code != http.StatusUnauthorized {
				t.Fatalf("path=%s code=%d", path, w.Code)
			}
		}
	}
}

func TestMetaNoncanonicalPathCannotBypassAuthentication(t *testing.T) {
	t.Setenv("WACALLS_API_KEY", "master-test-key")
	t.Setenv("WACALLS_WIDGET_KEY", "widget-test-key")
	m := &metaManager{accounts: map[string]metaAccount{"meta_test": {ID: "meta_test", Config: metaTestConfig()}}}
	s := &server{meta: m, metaCalls: &metaCallService{}, sessions: &SessionManager{}}
	for _, path := range []string{"//api/sessions/meta_test/meta", "///api/sessions/meta_test/meta", "/api//sessions/meta_test/meta", "/api/sessions/meta_test/meta"} {
		w := httptest.NewRecorder()
		s.routes().ServeHTTP(w, httptest.NewRequest(http.MethodGet, path, nil))
		if w.Code == http.StatusOK || strings.Contains(w.Body.String(), "hasAccessToken") {
			t.Fatalf("authentication bypass: path=%s status=%d", path, w.Code)
		}
	}
	w := httptest.NewRecorder()
	r := httptest.NewRequest(http.MethodGet, "/api/sessions/meta_test/meta", nil)
	r.Header.Set("X-API-Key", "master-test-key")
	s.routes().ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("authorized account route failed: %d", w.Code)
	}
}

func TestMetaErrorsNeverExposeStorageSecrets(t *testing.T) {
	w := httptest.NewRecorder()
	writeMetaError(w, errors.New("postgres://user:secret@host/db private-token"))
	if strings.Contains(w.Body.String(), "secret") || strings.Contains(w.Body.String(), "private-token") || w.Code < 500 {
		t.Fatalf("unsafe response %d %s", w.Code, w.Body.String())
	}
}

func TestMetaBodyLimitAndSingleValue(t *testing.T) {
	for _, body := range []string{`{} {}`, "{", `{"sdp":"` + strings.Repeat("x", 65<<10) + `"}`} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(http.MethodPost, "/", strings.NewReader(body))
		var got any
		if decodeMetaBody(w, r, &got) || w.Code != 400 {
			t.Fatal("invalid body accepted")
		}
	}
}
