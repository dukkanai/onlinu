package main

import (
	"testing"

	"go.mau.fi/whatsmeow"
	"go.mau.fi/whatsmeow/store"
	"go.mau.fi/whatsmeow/types/events"
)

func TestSessionTransportFailureClearsOpenState(t *testing.T) {
	eventsToTest := []struct {
		name  string
		event any
	}{
		{"disconnected", &events.Disconnected{}},
		{"stream replaced", &events.StreamReplaced{}},
		{"temporary ban", &events.TemporaryBan{}},
		{"client outdated", &events.ClientOutdated{}},
		{"connection failure", &events.ConnectFailure{}},
		{"stream error", &events.StreamError{}},
	}
	for _, tc := range eventsToTest {
		t.Run(tc.name, func(t *testing.T) {
			for _, paired := range []bool{false, true} {
				mgr := &SessionManager{broker: NewBroker(), sessions: map[string]*Session{}}
				s := &Session{id: "fixture", mgr: mgr, client: &whatsmeow.Client{Store: &store.Device{}},
					auth: AuthSnapshot{State: "open", Paired: paired, QR: "obsolete", Code: "obsolete"}, downAlerted: true}
				mgr.register(s)
				s.handleEvent(tc.event)
				s.mu.Lock()
				got := s.auth
				s.mu.Unlock()
				if got.State != "error" || got.Paired != paired || got.QR != "" || got.Code != "" || len(got.Passkey) != 0 {
					t.Fatalf("transport failure left stale authentication state: %+v", got)
				}
				if got := s.info(); got.State != "error" || got.Paired != paired {
					t.Fatalf("stale list: %+v", got)
				}
			}
		})
	}
}

func TestSessionDisconnectDoesNotUndoLoggedOutState(t *testing.T) {
	mgr := &SessionManager{broker: NewBroker(), sessions: map[string]*Session{}}
	s := &Session{id: "fixture", mgr: mgr, client: &whatsmeow.Client{Store: &store.Device{}}, auth: AuthSnapshot{State: "logged_out"}, downAlerted: true}
	mgr.register(s)
	s.handleEvent(&events.Disconnected{})
	if got := s.info(); got.State != "logged_out" || got.Paired {
		t.Fatalf("logout was overwritten: %+v", got)
	}
}
