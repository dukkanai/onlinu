package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/pion/webrtc/v4"
)

type metaMemoryCalls struct {
	mu  sync.Mutex
	ids map[string]bool
}

func (m *metaMemoryCalls) claim(_ context.Context, sid, id string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	k := metaCallKey(sid, id)
	if _, ok := m.ids[k]; ok {
		return false, nil
	}
	m.ids[k] = false
	return true, nil
}
func (m *metaMemoryCalls) terminal(_ context.Context, sid, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ids[metaCallKey(sid, id)] = true
	return nil
}
func (m *metaMemoryCalls) reap(context.Context) error { return nil }

func metaRuntimeTest(t *testing.T, handler http.HandlerFunc) *metaCallService {
	t.Helper()
	api := httptest.NewServer(handler)
	t.Cleanup(api.Close)
	account := metaAccount{ID: "meta_test", Name: "Test", Config: metaConfig{PhoneNumberID: "12345", WABAID: "98765", APIVersion: metaDefaultAPIVersion, AccessToken: "test-not-a-secret"}, Verified: true, WebhookVerified: true, CallingEnabled: true}
	ctx, cancel := context.WithCancel(context.Background())
	s := &metaCallService{ctx: ctx, cancel: cancel, accounts: &metaManager{accounts: map[string]metaAccount{account.ID: account}, graph: &metaGraphClient{baseURL: api.URL, httpClient: api.Client()}}, broker: NewBroker(), log: slog.New(slog.NewTextHandler(io.Discard, nil)), maxCalls: 2, store: &metaMemoryCalls{ids: make(map[string]bool)}, calls: make(map[string]*metaLiveCall), starting: make(map[string]int), pending: make(map[string]metaPendingEvent)}
	t.Cleanup(s.Close)
	return s
}

func metaTestRemote(t *testing.T, serverDTLS, iceLite bool) *webrtc.PeerConnection {
	t.Helper()
	settings := webrtc.SettingEngine{}
	settings.SetLite(iceLite)
	if serverDTLS {
		if err := settings.SetAnsweringDTLSRole(webrtc.DTLSRoleServer); err != nil {
			t.Fatal(err)
		}
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(settings)).NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	track, err := webrtc.NewTrackLocalStaticSample(webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2}, "audio", "remote")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pc.AddTrack(track); err != nil {
		t.Fatal(err)
	}
	return pc
}

func metaTestOffer(t *testing.T, pc *webrtc.PeerConnection) string {
	t.Helper()
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	sdp, err := metaGather(ctx, pc, offer)
	if err != nil {
		t.Fatal(err)
	}
	return sdp
}

func TestMetaCallsRequireFreshPermission(t *testing.T) {
	var permissions, connect atomic.Int32
	s := metaRuntimeTest(t, func(w http.ResponseWriter, r *http.Request) {
		if strings.HasSuffix(r.URL.Path, "/call_permissions") {
			permissions.Add(1)
			if r.URL.Query().Get("user_wa_id") != "15551234567" {
				t.Error("phone not normalized")
			}
			_, _ = io.WriteString(w, `{"permission":{"status":"permanent"},"actions":[{"action_name":"start_call","can_perform_action":false}]}`)
			return
		}
		connect.Add(1)
		w.WriteHeader(500)
	})
	if _, err := s.Start(context.Background(), "meta_test", "owner", "+1 555 123 4567"); err == nil {
		t.Fatal("permission denial accepted")
	}
	if permissions.Load() != 1 || connect.Load() != 0 || s.Count("meta_test") != 0 {
		t.Fatal("permission check or cleanup incorrect")
	}
}

func TestMetaCallsInboundPreAcceptThenMediaThenAccept(t *testing.T) {
	remote := metaTestRemote(t, false, true)
	// Deliberately delay the remote peer's aggregate state update after its
	// DTLS handshake. The business-side connection can already be established
	// while this independently scheduled observer still reports "connecting".
	remoteDTLSReady := make(chan struct{})
	remoteStateRelease := make(chan struct{})
	remoteConnected := make(chan struct{})
	var releaseRemoteStateOnce sync.Once
	var remoteConnectedOnce sync.Once
	releaseRemoteState := func() { releaseRemoteStateOnce.Do(func() { close(remoteStateRelease) }) }
	remote.GetSenders()[0].Transport().OnStateChange(func(state webrtc.DTLSTransportState) {
		if state == webrtc.DTLSTransportStateConnected {
			close(remoteDTLSReady)
			<-remoteStateRelease
		}
	})
	remote.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateConnected {
			remoteConnectedOnce.Do(func() { close(remoteConnected) })
		}
	})
	offer := metaTestOffer(t, remote)
	var accepted atomic.Bool
	var mu sync.Mutex
	var actions []string
	var initialAnswer string
	rtp := make(chan bool, 1)
	remote.OnTrack(func(track *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		if _, _, err := track.ReadRTP(); err == nil {
			select {
			case rtp <- accepted.Load():
			default:
			}
		}
	})
	var s *metaCallService
	s = metaRuntimeTest(t, func(w http.ResponseWriter, r *http.Request) {
		var body metaCallRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		mu.Lock()
		actions = append(actions, body.Action)
		mu.Unlock()
		switch body.Action {
		case "pre_accept":
			if body.Session == nil || body.Session.Type != "answer" {
				t.Error("missing pre_accept answer")
				w.WriteHeader(400)
				return
			}
			initialAnswer = body.Session.SDP
			if !strings.Contains(initialAnswer, "a=setup:active") {
				t.Error("business must be DTLS client")
			}
			if err := remote.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: initialAnswer}); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
		case "accept":
			if body.Session == nil || body.Session.SDP != initialAnswer {
				t.Error("accept did not reuse exact SDP answer")
			}
			// The production contract is local readiness before accepting. Pion
			// publishes each peer's aggregate state independently, so observing
			// the remote peer synchronously here was a scheduler-dependent test.
			call, exists := s.get("meta_test", "incoming")
			if !exists {
				t.Error("accepted call was not registered")
			} else {
				call.mu.Lock()
				localMedia := call.media
				call.mu.Unlock()
				if localMedia == nil {
					t.Error("accept preceded local media creation")
				} else {
					select {
					case <-localMedia.connected:
					default:
						t.Error("accept preceded local WebRTC connected event")
					}
					if localMedia.pc.ConnectionState() != webrtc.PeerConnectionStateConnected {
						t.Error("accept preceded local WebRTC connection")
					}
				}
			}
			select {
			case <-remoteDTLSReady:
			case <-time.After(5 * time.Second):
				t.Error("remote DTLS handshake did not finish")
			}
			releaseRemoteState()
			if remote.GetSenders()[0].Transport().ICETransport().Role() != webrtc.ICERoleControlled {
				t.Error("ICE-Lite remote must remain controlled")
			}
			accepted.Store(true)
		}
		_, _ = io.WriteString(w, `{"success":true}`)
	})
	t.Cleanup(releaseRemoteState)
	event := metaCallEvent{ID: "incoming", From: "15551234567", Event: "connect", Direction: "USER_INITIATED", Timestamp: fmt.Sprint(time.Now().Unix()), Session: &metaSDP{Type: "offer", SDP: offer}}
	if err := s.HandleEvent(context.Background(), "meta_test", event); err != nil {
		t.Fatal(err)
	}
	if err := s.HandleEvent(context.Background(), "meta_test", event); err != nil {
		t.Fatal(err)
	}
	if s.Count("meta_test") != 1 {
		t.Fatal("duplicate webhook created extra call")
	}
	if err := s.Accept(context.Background(), "meta_test", "incoming", "owner"); err != nil {
		t.Fatal(err)
	}
	if err := s.Accept(context.Background(), "meta_test", "incoming", "intruder"); err == nil {
		t.Fatal("second owner claimed call")
	}
	select {
	case afterAccept := <-rtp:
		if !afterAccept {
			t.Fatal("audio sent before accept succeeded")
		}
	case <-time.After(8 * time.Second):
		t.Fatal("no proactive RTP after accept")
	}
	select {
	case <-remoteConnected:
	case <-time.After(5 * time.Second):
		t.Fatal("remote WebRTC peer did not eventually connect")
	}
	if _, err := s.WebRTC(context.Background(), "meta_test", "incoming", "intruder", offer); err == nil {
		t.Fatal("wrong owner opened media")
	}
	if err := s.End(context.Background(), "meta_test", "incoming", "intruder"); err == nil {
		t.Fatal("wrong owner ended call")
	}
	if err := s.End(context.Background(), "meta_test", "incoming", "owner"); err != nil {
		t.Fatal(err)
	}
	if err := s.HandleEvent(context.Background(), "meta_test", event); err != nil {
		t.Fatal(err)
	}
	if s.Count("meta_test") != 0 {
		t.Fatal("completed call resurrected")
	}
	mu.Lock()
	defer mu.Unlock()
	if strings.Join(actions, ",") != "pre_accept,accept,terminate" {
		t.Fatalf("unexpected sequence: %v", actions)
	}
}

func TestMetaCallsOutboundAnswerBeforeConnectReturns(t *testing.T) {
	remote := metaTestRemote(t, true, true)
	var s *metaCallService
	s = metaRuntimeTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, `{"actions":[{"action_name":"start_call","can_perform_action":true}]}`)
			return
		}
		var body metaCallRequest
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if body.Action == "connect" {
			if body.Session == nil {
				t.Error("missing offer")
				w.WriteHeader(400)
				return
			}
			if strings.Count(body.Session.SDP, "m=audio ") != 1 || !strings.Contains(body.Session.SDP, "a=ptime:20") {
				t.Error("unexpected official audio SDP")
			}
			if err := remote.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: body.Session.SDP}); err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			answer, err := remote.CreateAnswer(nil)
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			sdp, err := metaGather(ctx, remote, answer)
			if err != nil {
				t.Error(err)
				w.WriteHeader(400)
				return
			}
			event := metaCallEvent{ID: "outgoing", Event: "connect", Direction: "BUSINESS_INITIATED", Session: &metaSDP{Type: "answer", SDP: sdp}}
			if err = s.HandleEvent(context.Background(), "meta_test", event); err != nil {
				t.Error(err)
			}
			_, _ = io.WriteString(w, `{"calls":[{"id":"outgoing"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"success":true}`)
	})
	id, err := s.Start(context.Background(), "meta_test", "owner", "15551234567")
	if err != nil {
		t.Fatal(err)
	}
	c, ok := s.get("meta_test", id)
	if !ok {
		t.Fatal("call missing")
	}
	select {
	case <-c.media.connected:
	case <-time.After(8 * time.Second):
		t.Fatal("early answer did not connect")
	}
	if c.media.pc.GetSenders()[0].Transport().ICETransport().Role() != webrtc.ICERoleControlling {
		t.Fatal("business ICE role must be controlling")
	}
	c.mu.Lock()
	answered := c.answered
	c.mu.Unlock()
	if !answered {
		t.Fatal("early answer not applied")
	}
	if err = s.End(context.Background(), "meta_test", id, "owner"); err != nil {
		t.Fatal(err)
	}
}

func TestMetaCallsTerminateBeforeConnectReturns(t *testing.T) {
	var s *metaCallService
	s = metaRuntimeTest(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_, _ = io.WriteString(w, `{"actions":[{"action_name":"start_call","can_perform_action":true}]}`)
			return
		}
		var body metaCallRequest
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Action == "connect" {
			if err := s.HandleEvent(context.Background(), "meta_test", metaCallEvent{ID: "terminated", Event: "terminate"}); err != nil {
				t.Error(err)
			}
			_, _ = io.WriteString(w, `{"calls":[{"id":"terminated"}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"success":true}`)
	})
	if _, err := s.Start(context.Background(), "meta_test", "owner", "15551234567"); err == nil {
		t.Fatal("terminated call became active")
	}
	if s.Count("meta_test") != 0 {
		t.Fatal("terminated call resurrected")
	}
}

func TestMetaCallsRequireBrowserAttachmentAfterConnect(t *testing.T) {
	now := time.Now()
	c := &metaLiveCall{state: StatusConnected, started: now.Add(-2 * time.Minute), media: &metaMedia{}}
	if !c.setupExpired(now) {
		t.Fatal("connected call without browser has no deadline")
	}
	c.media.browserConnected.Store(true)
	if c.setupExpired(now) {
		t.Fatal("established browser call expired")
	}
	c.state = StatusRinging
	if !c.setupExpired(now) {
		t.Fatal("unanswered call has no deadline")
	}
	c.ended = true
	if c.setupExpired(now) {
		t.Fatal("ended call expired twice")
	}
}
