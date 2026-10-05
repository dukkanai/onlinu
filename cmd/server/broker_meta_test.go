package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestMetaWidgetBroadcastIsolation(t *testing.T) {
	b := NewBroker()
	admin := b.subscribeForAuth("operator", 0, false)
	widget := b.subscribeForAuth("operator", 0, true)
	defer b.unsubscribe(admin)
	defer b.unsubscribe(widget)

	b.emitSessionList([]SessionInfo{
		{ID: "qr_session", Provider: "qr", Name: "QR business"},
		{ID: "meta_session", Provider: "meta", Name: "private-business-name"},
	})
	b.upsertCall(CallRecord{SessionID: "qr_session", CallID: "qr-call", Peer: "qr-peer"})
	b.upsertCall(CallRecord{SessionID: "meta_session", CallID: "wacid-private", Peer: "private-customer-number"})
	b.emitIncoming("meta_session", "wacid-private", "private-customer-number", "", "", false)
	b.emitIncomingClaimed("meta_session", "wacid-private", "operator")
	b.broadcastForSession("meta_session", map[string]any{"type": "future-event", "secret": "private-unmarked-scoped"})
	b.broadcastForSessionTargeted("meta_session", "operator", map[string]any{"type": "future-event", "secret": "private-unmarked-targeted"})
	b.broadcast(map[string]any{"type": "future-event", "nested": []any{map[string]any{"session_id": "meta_session", "secret": "private-nested"}}})
	b.endCall("wacid-private", "private-end-reason")
	// QR events still reach the widget, including targeted and unknown events.
	b.emitIncoming("qr_session", "qr-call", "qr-peer", "", "", false)
	b.broadcastForSessionTargeted("qr_session", "operator", map[string]any{"type": "qr-targeted"})
	b.broadcast(map[string]any{"type": "qr-future", "sessionId": "qr_session", "body": "meta_customer is ordinary message text"})

	widgetEvents := drain(widget)
	data, _ := json.Marshal(widgetEvents)
	for _, forbidden := range []string{"meta_session", "wacid-private", "private-"} {
		if strings.Contains(string(data), forbidden) {
			t.Fatalf("widget leaked official metadata: %s", data)
		}
	}
	for _, eventType := range []string{"session-list", "call-list", "call-status", "incoming", "qr-targeted", "qr-future"} {
		if !hasType(widgetEvents, eventType) {
			t.Errorf("widget lost QR event %s", eventType)
		}
	}
	adminData, _ := json.Marshal(drain(admin))
	for _, expected := range []string{"meta_session", "private-business-name", "private-customer-number", "private-unmarked-scoped", "private-unmarked-targeted", "private-nested", "private-end-reason"} {
		if !strings.Contains(string(adminData), expected) {
			t.Errorf("master lost official event %s", expected)
		}
	}
}

func TestMetaWidgetUnknownPayloadsFailClosed(t *testing.T) {
	for _, body := range []string{
		`{"type":"future","nested":{"sessionId":"meta_hidden"}}`,
		`{"type":"future","nested":[{"provider":"meta","phone":"hidden"}]}`,
		`{"type":"future","nested":{"id":"meta_hidden"}}`,
		`{"type":"future","nested":{"callId":"wacid.hidden","peer":"private"}}`,
		`{"type":"future","bySession":{"meta_hidden":{"phone":"hidden"}}}`,
		`{"type":"session-list","sessions":[],"extra":{"session_id":"meta_hidden"}}`,
		`{"type":"call-list","calls":{"meta_hidden":{}}}`,
		`null`, `[]`, `{`,
	} {
		if got := widgetSSEPayload([]byte(body)); got != nil {
			t.Errorf("unexpected widget payload %s", got)
		}
	}
	for _, body := range []string{
		`{"type":"session-list","sessions":[{"id":"meta_hidden","name":"private"}]}`,
		`{"type":"call-list","calls":[{"sessionId":"meta_hidden","peer":"private"}]}`,
	} {
		got := widgetSSEPayload([]byte(body))
		if got == nil || strings.Contains(string(got), "private") || !strings.Contains(string(got), "[]") {
			t.Errorf("all-official aggregate must retain an empty list: %s", got)
		}
	}
}

// Cancel the stream after its initial session snapshot and queued call list.
// The recorder is used synchronously; no racing reads or arbitrary sleeps.
type metaSSERecorder struct {
	*httptest.ResponseRecorder
	cancel  context.CancelFunc
	flushes int
}

func (w *metaSSERecorder) Flush() {
	w.ResponseRecorder.Flush()
	w.flushes++
	if w.flushes == 2 {
		w.cancel()
	}
}

func TestMetaSSEUsesAuthenticatedRoleForSnapshots(t *testing.T) {
	for _, tc := range []struct {
		name, header, query, widgetKey string
		wantMeta                       bool
	}{
		{"widget-no-account", "widget-key", "", "widget-key", false},
		{"widget-account-zero", "widget-key", "?accountId=0", "widget-key", false},
		{"widget-forged-account", "widget-key", "?accountId=42", "widget-key", false},
		{"widget-query-key", "", "?apiKey=widget-key", "widget-key", false},
		{"master", "master-key", "", "widget-key", true},
		{"master-header-wins", "master-key", "?apiKey=widget-key&accountId=42", "widget-key", true},
		{"identical-keys-master-wins", "master-key", "", "master-key", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			b := NewBroker()
			b.SnapshotFn = func() []any {
				return []any{map[string]any{"type": "session-list", "sessions": []SessionInfo{
					{ID: "qr_session", Name: "qr-business"},
					{ID: "meta_session", Provider: "meta", Name: "private-business"},
				}}}
			}
			b.calls["qr-call"] = &CallRecord{SessionID: "qr_session", CallID: "qr-call", Peer: "qr-peer"}
			b.calls["meta-call"] = &CallRecord{SessionID: "meta_session", CallID: "meta-call", Peer: "private-customer"}
			s := &server{broker: b}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			r := httptest.NewRequest(http.MethodGet, "/api/events"+tc.query, nil).WithContext(ctx)
			r.Header.Set("X-API-Key", tc.header)
			w := &metaSSERecorder{ResponseRecorder: httptest.NewRecorder(), cancel: cancel}
			withAuth(http.HandlerFunc(s.handleEvents), "master-key", tc.widgetKey).ServeHTTP(w, r)
			body := w.Body.String()
			if w.Code != http.StatusOK || w.flushes != 2 {
				t.Fatalf("SSE did not return initial snapshot/list: status=%d flushes=%d", w.Code, w.flushes)
			}
			for _, marker := range []string{"private-business", "private-customer", "meta_session"} {
				if strings.Contains(body, marker) != tc.wantMeta {
					t.Errorf("incorrect official event visibility for %q: %s", marker, body)
				}
			}
			if !strings.Contains(body, "qr-business") || !strings.Contains(body, "qr-peer") {
				t.Errorf("QR SSE behavior changed: %s", body)
			}
		})
	}
}
