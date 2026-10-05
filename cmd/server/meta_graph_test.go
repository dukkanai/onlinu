package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func metaTestConfig() metaConfig {
	return metaConfig{PhoneNumberID: "123456", WABAID: "654321", APIVersion: "v24.0", AccessToken: "test-access-token", AppSecret: "test-app-secret", VerifyToken: "test-verify-token"}
}

func TestMetaGraphCallContracts(t *testing.T) {
	for _, action := range []string{"connect", "pre_accept", "accept", "reject", "terminate"} {
		t.Run(action, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.Method != http.MethodPost || r.URL.Path != "/v24.0/123456/calls" {
					t.Errorf("unexpected route %s %s", r.Method, r.URL.Path)
				}
				if r.Header.Get("Authorization") != "Bearer test-access-token" {
					t.Error("authorization header missing")
				}
				if strings.Contains(r.URL.String(), "test-access-token") {
					t.Error("token in URL")
				}
				var payload map[string]any
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Fatal(err)
				}
				if payload["messaging_product"] != "whatsapp" || payload["action"] != action {
					t.Errorf("unexpected payload %#v", payload)
				}
				if action == "connect" {
					if payload["to"] != "15550001234" || payload["call_id"] != nil {
						t.Error("invalid connect target")
					}
				} else if payload["call_id"] != "wacid.test" {
					t.Error("call ID missing")
				}
				if action == "reject" || action == "terminate" {
					if payload["session"] != nil {
						t.Error("unexpected SDP on end")
					}
				} else {
					session, ok := payload["session"].(map[string]any)
					if !ok {
						t.Fatal("session missing")
					}
					want := "answer"
					if action == "connect" {
						want = "offer"
					}
					if session["sdp_type"] != want || session["sdp"] != "v=0\r\n" {
						t.Error("incorrect SDP schema")
					}
				}
				w.Header().Set("Content-Type", "application/json")
				if action == "connect" {
					fmt.Fprint(w, `{"calls":[{"id":"wacid.test"}]}`)
				} else {
					fmt.Fprint(w, `{"success":true}`)
				}
			}))
			defer server.Close()
			graph := &metaGraphClient{baseURL: server.URL, httpClient: server.Client()}
			input := metaCallRequest{Action: action, CallID: "wacid.test"}
			if action == "connect" {
				input.CallID = ""
				input.To = "15550001234"
				input.Session = &metaSDP{Type: "offer", SDP: "v=0\r\n"}
			}
			if action == "accept" || action == "pre_accept" {
				input.Session = &metaSDP{Type: "answer", SDP: "v=0\r\n"}
			}
			id, err := graph.Call(context.Background(), metaTestConfig(), input)
			if err != nil || id != "wacid.test" {
				t.Fatalf("id=%q err=%v", id, err)
			}
		})
	}
}

func TestMetaPermissionsRequiresExplicitStartAction(t *testing.T) {
	tests := []struct {
		name, body string
		allowed    bool
	}{
		{"status-alone", `{"permission":{"status":"permanent","expiration_time":123}}`, false},
		{"explicit-denial", `{"permission":{"status":"permanent"},"actions":[{"action_name":"start_call","can_perform_action":false}]}`, false},
		{"explicit-allow", `{"permission":{"status":"temporary","expiration_time":123},"actions":[{"action_name":"start_call","can_perform_action":true}]}`, true},
		{"different-action", `{"actions":[{"action_name":"request_permission","can_perform_action":true}]}`, false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path != "/v24.0/123456/call_permissions" || r.URL.Query().Get("user_wa_id") != "15550001234" {
					t.Error("wrong permissions endpoint")
				}
				fmt.Fprint(w, tt.body)
			}))
			defer server.Close()
			result, err := (&metaGraphClient{baseURL: server.URL}).Permissions(context.Background(), metaTestConfig(), "15550001234")
			if err != nil || result.CanCall != tt.allowed {
				t.Fatalf("result=%+v error=%v", result, err)
			}
		})
	}
}

func TestMetaRequestPermissionContract(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != "/v24.0/123456/messages" {
			t.Error("wrong permission request endpoint")
		}
		var body struct {
			Product     string `json:"messaging_product"`
			To          string `json:"to"`
			Type        string `json:"type"`
			Interactive struct {
				Type   string `json:"type"`
				Action struct {
					Name string `json:"name"`
				} `json:"action"`
			} `json:"interactive"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			t.Fatal("invalid request")
		}
		if body.Product != "whatsapp" || body.To != "15550001234" || body.Type != "interactive" || body.Interactive.Type != "call_permission_request" || body.Interactive.Action.Name != "call_permission_request" {
			t.Errorf("unexpected permission request %+v", body)
		}
		fmt.Fprint(w, `{"messages":[{"id":"wamid.test"}]}`)
	}))
	defer server.Close()
	if err := (&metaGraphClient{baseURL: server.URL}).RequestPermission(context.Background(), metaTestConfig(), "15550001234"); err != nil {
		t.Fatal(err)
	}
}

func TestMetaVerifyOwnershipAndCallingSettings(t *testing.T) {
	for _, sip := range []string{"DISABLED", "enabled"} {
		t.Run(sip, func(t *testing.T) {
			pages := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				switch r.URL.Path {
				case "/v24.0/123456":
					fmt.Fprint(w, `{"id":"123456"}`)
				case "/v24.0/654321/phone_numbers":
					pages++
					if pages == 1 {
						fmt.Fprint(w, `{"data":[{"id":"999"}],"paging":{"cursors":{"after":"opaque-cursor"},"next":"https://untrusted.invalid/?access_token=unsafe"}}`)
					} else {
						if r.URL.Query().Get("after") != "opaque-cursor" {
							t.Error("cursor not carried")
						}
						fmt.Fprint(w, `{"data":[{"id":"123456"}]}`)
					}
				case "/v24.0/123456/settings":
					fmt.Fprintf(w, `{"calling":{"status":"enabled","sip":{"status":%q}}}`, sip)
				default:
					t.Errorf("unexpected request %s", r.URL.Path)
					http.NotFound(w, r)
				}
			}))
			defer server.Close()
			calling, sipEnabled, err := (&metaGraphClient{baseURL: server.URL}).Verify(context.Background(), metaTestConfig())
			if err != nil || !calling || sipEnabled != (sip == "enabled") || pages != 2 {
				t.Fatalf("calling=%v sip=%v pages=%d err=%v", calling, sipEnabled, pages, err)
			}
		})
	}
}

func TestMetaGraphErrorNeverIncludesSensitiveBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, `{"error":{"code":131030,"message":"test-access-token private-user-number SDP-secret"}}`)
	}))
	defer server.Close()
	_, err := (&metaGraphClient{baseURL: server.URL}).Permissions(context.Background(), metaTestConfig(), "15550001234")
	var graphErr *metaGraphError
	if !errors.As(err, &graphErr) || graphErr.Code != 131030 || graphErr.StatusCode != 400 {
		t.Fatalf("unexpected error %v", err)
	}
	for _, secret := range []string{"test-access-token", "private-user-number", "SDP-secret"} {
		if strings.Contains(err.Error(), secret) {
			t.Error("error leaked sensitive response")
		}
	}
}

func TestMetaGraphRejectsRedirectAndInvalidIDs(t *testing.T) {
	redirected := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected = true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { http.Redirect(w, r, target.URL, http.StatusFound) }))
	defer server.Close()
	graph := &metaGraphClient{baseURL: server.URL}
	if _, err := graph.Permissions(context.Background(), metaTestConfig(), "15550001234"); err == nil || redirected {
		t.Fatal("redirect followed")
	}
	if _, err := graph.Permissions(context.Background(), metaTestConfig(), "../../bad"); err == nil {
		t.Fatal("invalid phone accepted")
	} else if status, _ := safeMetaConfigError(err); status != http.StatusBadRequest {
		t.Fatalf("invalid phone returned status %d", status)
	}
}

func TestMetaGraphRequiresPositiveActionAcknowledgement(t *testing.T) {
	for _, body := range []string{`{}`, `{"success":false}`, `{"messages":[]}`} {
		t.Run(body, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, body) }))
			defer server.Close()
			graph := &metaGraphClient{baseURL: server.URL}
			if _, err := graph.Call(context.Background(), metaTestConfig(), metaCallRequest{Action: "terminate", CallID: "wacid.test"}); err == nil {
				t.Fatal("call action accepted without positive confirmation")
			}
			if err := graph.RequestPermission(context.Background(), metaTestConfig(), "15550001234"); err == nil {
				t.Fatal("permission request accepted without message ID")
			}
		})
	}
}
