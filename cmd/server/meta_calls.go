package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type metaCallEvent struct {
	ID         string   `json:"id"`
	From       string   `json:"from"`
	To         string   `json:"to"`
	FromUserID string   `json:"from_user_id"`
	ToUserID   string   `json:"to_user_id"`
	Event      string   `json:"event"`
	Direction  string   `json:"direction"`
	Timestamp  string   `json:"timestamp"`
	Status     string   `json:"status"`
	Session    *metaSDP `json:"session,omitempty"`
}

type metaCallError struct {
	Status  int
	Message string
}

func (e *metaCallError) Error() string { return e.Message }
func metaCallFailure(status int, message string) error {
	return &metaCallError{Status: status, Message: message}
}

type metaLiveCall struct {
	mu                              sync.Mutex
	opMu                            sync.Mutex
	id, sid, owner, peer, direction string
	cfg                             metaConfig
	media                           *metaMedia
	offer                           string
	state                           CallStatus
	accepting, answered, ended      bool
	started                         time.Time
	quota                           activeCall
}

func (c *metaLiveCall) setupExpired(now time.Time) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return !c.ended && now.Sub(c.started) > 90*time.Second && (c.state != StatusConnected || c.media == nil || !c.media.browserConnected.Load())
}

// Remember IDs, not SDP or raw webhook bodies. A server restart intentionally
// ends in-flight calls: Meta can retry old events for seven days, and must never
// resurrect a completed call or ring it again after a restart.
type metaCallPersistence interface {
	claim(context.Context, string, string) (bool, error)
	terminal(context.Context, string, string) error
	reap(context.Context) error
}
type metaSQLCalls struct{ db *sql.DB }

func (s metaSQLCalls) claim(ctx context.Context, sid, id string) (bool, error) {
	r, err := s.db.ExecContext(ctx, `INSERT INTO meta_call_receipts(session_id, call_id, terminal, updated_at) VALUES($1,$2,FALSE,NOW()) ON CONFLICT DO NOTHING`, sid, id)
	if err != nil {
		return false, errors.New("could not persist official call")
	}
	n, err := r.RowsAffected()
	return n == 1, err
}
func (s metaSQLCalls) terminal(ctx context.Context, sid, id string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO meta_call_receipts(session_id,call_id,terminal,updated_at) VALUES($1,$2,TRUE,NOW()) ON CONFLICT(session_id,call_id) DO UPDATE SET terminal=TRUE,updated_at=NOW()`, sid, id)
	if err != nil {
		return errors.New("could not persist official call end")
	}
	return nil
}
func (s metaSQLCalls) reap(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM meta_call_receipts WHERE terminal=TRUE AND updated_at < NOW() - INTERVAL '8 days'`)
	return err
}

type metaPendingEvent struct {
	event metaCallEvent
	at    time.Time
}
type metaCallService struct {
	ctx      context.Context
	cancel   context.CancelFunc
	accounts *metaManager
	broker   *Broker
	log      *slog.Logger
	maxCalls int
	store    metaCallPersistence
	mu       sync.Mutex
	calls    map[string]*metaLiveCall
	starting map[string]int
	pending  map[string]metaPendingEvent
	closed   bool
}

func newMetaCallService(ctx context.Context, accounts *metaManager, broker *Broker, maxCalls int, log *slog.Logger) (*metaCallService, error) {
	if accounts == nil || accounts.db == nil {
		return nil, errors.New("official call database unavailable")
	}
	_, err := accounts.db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS meta_call_receipts(session_id TEXT NOT NULL,call_id TEXT NOT NULL,terminal BOOLEAN NOT NULL DEFAULT FALSE,updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),PRIMARY KEY(session_id,call_id)); CREATE INDEX IF NOT EXISTS meta_call_receipts_updated ON meta_call_receipts(updated_at); UPDATE meta_call_receipts SET terminal=TRUE,updated_at=NOW() WHERE terminal=FALSE`)
	if err != nil {
		return nil, errors.New("could not initialize official call records")
	}
	serviceCtx, cancel := context.WithCancel(ctx)
	s := &metaCallService{ctx: serviceCtx, cancel: cancel, accounts: accounts, broker: broker, log: log, maxCalls: maxCalls, store: metaSQLCalls{accounts.db}, calls: make(map[string]*metaLiveCall), starting: make(map[string]int), pending: make(map[string]metaPendingEvent)}
	go s.maintenance()
	return s, nil
}

func metaCallKey(sid, id string) string { return sid + "\x00" + id }
func (s *metaCallService) get(sid, id string) (*metaLiveCall, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c, ok := s.calls[metaCallKey(sid, id)]
	return c, ok
}
func (s *metaCallService) countLocked(sid string) int {
	n := s.starting[sid]
	for _, c := range s.calls {
		if c.sid == sid {
			n++
		}
	}
	return n
}
func (s *metaCallService) Count(sid string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.countLocked(sid)
}
func (s *metaCallService) HasSessionCalls(sid string) bool { return s.Count(sid) > 0 }
func (s *metaCallService) TranslationCall(sid, id string) (*activeCall, bool) {
	c, ok := s.get(sid, id)
	if !ok {
		return nil, false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	return &c.quota, !c.ended
}

func (s *metaCallService) ready(sid string) (metaAccount, error) {
	a, ok := s.accounts.Account(sid)
	if !ok {
		return a, metaCallFailure(http.StatusNotFound, "official account not found")
	}
	if !a.Verified || !a.WebhookVerified || !a.CallingEnabled || a.SIPEnabled || a.Config.AccessToken == "" {
		return a, metaCallFailure(http.StatusConflict, "verify the official account, webhook, and calling settings first")
	}
	return a, nil
}

func (s *metaCallService) Start(ctx context.Context, sid, owner, phone string) (string, error) {
	if owner == "" {
		return "", metaCallFailure(http.StatusBadRequest, "client identity is required")
	}
	phone = normalizePhone(phone)
	if len(phone) < 5 || len(phone) > 20 {
		return "", metaCallFailure(http.StatusBadRequest, "international phone number is required")
	}
	a, err := s.ready(sid)
	if err != nil {
		return "", err
	}
	s.mu.Lock()
	if s.closed || (s.maxCalls > 0 && s.countLocked(sid) >= s.maxCalls) {
		s.mu.Unlock()
		return "", metaCallFailure(http.StatusConflict, "official call capacity reached")
	}
	s.starting[sid]++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); s.starting[sid]--; s.mu.Unlock() }()
	permission, err := s.accounts.graph.Permissions(ctx, a.Config, phone)
	if err != nil {
		return "", err
	}
	if !permission.CanCall {
		return "", metaCallFailure(http.StatusConflict, "the customer has not granted permission for this outgoing call")
	}
	c := &metaLiveCall{sid: sid, owner: owner, peer: phone, direction: "outgoing", cfg: a.Config, state: StatusStarting, started: time.Now()}
	m, err := newMetaMedia(s.log, func() { s.failCall(c, "media_failed") })
	if err != nil {
		return "", err
	}
	c.media = m
	offer, err := m.offer(ctx)
	if err != nil {
		m.Close()
		return "", err
	}
	id, err := s.accounts.graph.Call(ctx, a.Config, metaCallRequest{Action: "connect", To: phone, Session: &metaSDP{Type: "offer", SDP: offer}})
	if err != nil {
		m.Close()
		return "", err
	}
	if id == "" {
		m.Close()
		return "", errors.New("Meta did not return a call ID")
	}
	c.id = id
	s.mu.Lock()
	claimed, err := s.store.claim(ctx, sid, id)
	if err != nil || !claimed {
		s.mu.Unlock()
		m.Close()
		s.remoteFinish(c, "terminate")
		if err != nil {
			return "", err
		}
		return "", errors.New("official call ID was already processed")
	}
	if s.closed {
		s.mu.Unlock()
		m.Close()
		s.remoteFinish(c, "terminate")
		return "", errors.New("server is shutting down")
	}
	s.calls[metaCallKey(sid, id)] = c
	pending, hasPending := s.pending[metaCallKey(sid, id)]
	delete(s.pending, metaCallKey(sid, id))
	s.mu.Unlock()
	s.publish(c, StatusRinging)
	// Outbound DTLS/media may start once the connect answer arrives; an ACCEPTED
	// status webhook is advisory and can arrive after the call is established.
	m.enabled.Store(true)
	if hasPending {
		if err := s.HandleEvent(ctx, sid, pending.event); err != nil {
			s.failCall(c, "media_failed")
			return "", err
		}
	}
	return id, nil
}

func (s *metaCallService) Accept(ctx context.Context, sid, id, owner string) error {
	if owner == "" {
		return metaCallFailure(http.StatusBadRequest, "client identity is required")
	}
	if _, err := s.ready(sid); err != nil {
		return err
	}
	c, ok := s.get(sid, id)
	if !ok {
		return metaCallFailure(http.StatusNotFound, "official call not found")
	}
	c.mu.Lock()
	if c.ended || c.direction != "incoming" {
		c.mu.Unlock()
		return metaCallFailure(http.StatusConflict, "official call cannot be accepted")
	}
	if c.owner != "" && c.owner != owner {
		c.mu.Unlock()
		return metaCallFailure(http.StatusConflict, "call claimed by another client")
	}
	if c.accepting {
		c.mu.Unlock()
		return nil
	}
	if !s.broker.setOwner(id, owner) {
		c.mu.Unlock()
		return metaCallFailure(http.StatusConflict, "call claimed by another client")
	}
	c.owner = owner
	c.accepting = true
	c.mu.Unlock()
	s.broker.emitIncomingClaimed(sid, id, owner)
	s.publish(c, StatusStarting)
	// The UI attaches its browser WebRTC after this endpoint returns. Complete
	// the Meta handshake asynchronously under a bounded service-owned context.
	go s.accept(c)
	return nil
}

func (s *metaCallService) accept(c *metaLiveCall) {
	ctx, cancel := context.WithTimeout(s.ctx, 35*time.Second)
	defer cancel()
	c.mu.Lock()
	m, offer, ended := c.media, c.offer, c.ended
	c.mu.Unlock()
	if ended {
		return
	}
	answer, err := m.answer(ctx, offer)
	if err != nil {
		s.failCall(c, "media_failed")
		return
	}
	session := &metaSDP{Type: "answer", SDP: answer}
	if err = s.liveAction(ctx, c, metaCallRequest{Action: "pre_accept", CallID: c.id, Session: session}); err != nil {
		s.failCall(c, "pre_accept_failed")
		return
	}
	select {
	case <-ctx.Done():
		s.failCall(c, "media_timeout")
		return
	case <-m.closed:
		return
	case <-m.connected:
	}
	c.mu.Lock()
	ended = c.ended
	c.mu.Unlock()
	if ended {
		return
	}
	if err = s.liveAction(ctx, c, metaCallRequest{Action: "accept", CallID: c.id, Session: session}); err != nil {
		s.failCall(c, "accept_failed")
		return
	}
	m.enabled.Store(true)
	s.publish(c, StatusConnected)
}

func (s *metaCallService) Reject(ctx context.Context, sid, id, owner string) error {
	return s.stop(ctx, sid, id, owner, true)
}
func (s *metaCallService) End(ctx context.Context, sid, id, owner string) error {
	return s.stop(ctx, sid, id, owner, false)
}
func (s *metaCallService) stop(ctx context.Context, sid, id, owner string, reject bool) error {
	if owner == "" {
		return metaCallFailure(http.StatusBadRequest, "client identity is required")
	}
	c, ok := s.get(sid, id)
	if !ok {
		return metaCallFailure(http.StatusNotFound, "official call not found")
	}
	c.mu.Lock()
	if (c.owner != "" && c.owner != owner) || (!reject && c.owner != owner) {
		c.mu.Unlock()
		return metaCallFailure(http.StatusConflict, "call belongs to another client")
	}
	if reject && (c.direction != "incoming" || c.accepting) {
		c.mu.Unlock()
		return metaCallFailure(http.StatusConflict, "call can no longer be rejected")
	}
	if c.ended {
		c.mu.Unlock()
		return nil
	}
	c.ended = true
	c.mu.Unlock()
	action, reason := "terminate", "user_ended"
	if reject {
		action, reason = "reject", "declined"
	}
	c.opMu.Lock()
	_, err := s.accounts.graph.Call(ctx, c.cfg, metaCallRequest{Action: action, CallID: id})
	c.opMu.Unlock()
	s.cleanup(c, reason)
	return err
}

func (s *metaCallService) WebRTC(ctx context.Context, sid, id, owner, offer string) (string, error) {
	c, ok := s.get(sid, id)
	if !ok {
		return "", metaCallFailure(http.StatusNotFound, "official call not found")
	}
	c.mu.Lock()
	if c.ended || owner == "" || c.owner != owner {
		c.mu.Unlock()
		return "", metaCallFailure(http.StatusConflict, "call belongs to another client or has ended")
	}
	m := c.media
	c.mu.Unlock()
	return m.browser(ctx, offer, s.log)
}

func (s *metaCallService) HandleEvent(ctx context.Context, sid string, event metaCallEvent) error {
	if event.ID == "" || len(event.ID) > 512 {
		return errors.New("invalid official call event")
	}
	kind := strings.ToLower(event.Event)
	c, ok := s.get(sid, event.ID)
	if kind == "terminate" || (kind == "status" && strings.EqualFold(event.Status, "REJECTED")) {
		s.mu.Lock()
		c, ok = s.calls[metaCallKey(sid, event.ID)]
		if err := s.store.terminal(ctx, sid, event.ID); err != nil {
			s.mu.Unlock()
			return err
		}
		delete(s.pending, metaCallKey(sid, event.ID))
		s.mu.Unlock()
		if ok {
			s.finish(c, "remote_ended")
		}
		return nil
	}
	if kind == "status" {
		return nil
	}
	if kind != "connect" || event.Session == nil {
		return nil
	}
	if ok {
		c.mu.Lock()
		if c.ended || c.answered || c.direction != "outgoing" || event.Session.Type != "answer" {
			c.mu.Unlock()
			return nil
		}
		err := c.media.remoteAnswer(event.Session.SDP)
		if err == nil {
			c.answered = true
		}
		c.mu.Unlock()
		if err != nil {
			s.failCall(c, "media_failed")
			return nil
		}
		go func() {
			select {
			case <-c.media.connected:
				s.publish(c, StatusConnected)
			case <-c.media.closed:
			case <-s.ctx.Done():
			}
		}()
		return nil
	}
	if event.Session.Type == "answer" {
		// A connect webhook can beat the synchronous Graph response. Cache only
		// while a connect request is in flight for this same verified account.
		s.mu.Lock()
		if _, registered := s.calls[metaCallKey(sid, event.ID)]; registered {
			s.mu.Unlock()
			// Registration may have happened after the first lookup. Retry that
			// lookup instead of leaving the answer stranded in the early cache.
			return s.HandleEvent(ctx, sid, event)
		}
		if s.starting[sid] > 0 && len(s.pending) < 128 {
			s.pending[metaCallKey(sid, event.ID)] = metaPendingEvent{event: event, at: time.Now()}
		}
		s.mu.Unlock()
		return nil
	}
	if event.Session.Type != "offer" || !strings.EqualFold(event.Direction, "USER_INITIATED") {
		return nil
	}
	if !metaAudioOnlySDP(event.Session.SDP) {
		return errors.New("unsupported official call media")
	}
	if timestamp, err := strconv.ParseInt(event.Timestamp, 10, 64); err == nil && (time.Since(time.Unix(timestamp, 0)) > 2*time.Minute || timestamp > time.Now().Add(time.Minute).Unix()) {
		return s.store.terminal(ctx, sid, event.ID)
	}
	a, err := s.ready(sid)
	if err != nil {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	if _, exists := s.calls[metaCallKey(sid, event.ID)]; exists {
		return nil
	}
	claimed, err := s.store.claim(ctx, sid, event.ID)
	if err != nil || !claimed {
		return err
	}
	peer := event.From
	if peer == "" {
		peer = event.FromUserID
	}
	c = &metaLiveCall{id: event.ID, sid: sid, peer: peer, direction: "incoming", cfg: a.Config, offer: event.Session.SDP, state: StatusRinging, started: time.Now()}
	if s.maxCalls > 0 && s.countLocked(sid) >= s.maxCalls {
		go s.remoteFinish(c, "reject")
		return s.store.terminal(ctx, sid, event.ID)
	}
	m, err := newMetaMedia(s.log, func() { s.failCall(c, "media_failed") })
	if err != nil {
		_ = s.store.terminal(ctx, sid, event.ID)
		return err
	}
	c.media = m
	s.calls[metaCallKey(sid, event.ID)] = c
	s.publish(c, StatusRinging)
	s.broker.emitIncoming(sid, event.ID, peer, peer, "", false)
	return nil
}

func (s *metaCallService) publish(c *metaLiveCall, status CallStatus) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ended {
		return
	}
	c.state = status
	var owner *string
	if c.owner != "" {
		value := c.owner
		owner = &value
	}
	s.broker.upsertCall(CallRecord{SessionID: c.sid, CallID: c.id, Owner: owner, Direction: c.direction, Peer: c.peer, StartedAt: c.started.UnixMilli(), Status: status})
}

func (s *metaCallService) failCall(c *metaLiveCall, reason string) {
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return
	}
	c.ended = true
	c.mu.Unlock()
	s.cleanup(c, reason)
	s.remoteFinish(c, "terminate")
}
func (s *metaCallService) finish(c *metaLiveCall, reason string) {
	c.mu.Lock()
	if c.ended {
		c.mu.Unlock()
		return
	}
	c.ended = true
	c.mu.Unlock()
	s.cleanup(c, reason)
}
func (s *metaCallService) cleanup(c *metaLiveCall, reason string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	if err := s.store.terminal(ctx, c.sid, c.id); err != nil {
		s.log.Warn("could not persist official call completion")
	}
	cancel()
	s.mu.Lock()
	delete(s.calls, metaCallKey(c.sid, c.id))
	delete(s.pending, metaCallKey(c.sid, c.id))
	s.mu.Unlock()
	if c.media != nil {
		c.media.Close()
	}
	s.broker.endCall(c.id, reason)
}
func (s *metaCallService) remoteFinish(c *metaLiveCall, action string) {
	if c.id == "" {
		return
	}
	c.opMu.Lock()
	defer c.opMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_, _ = s.accounts.graph.Call(ctx, c.cfg, metaCallRequest{Action: action, CallID: c.id})
}
func (s *metaCallService) liveAction(ctx context.Context, c *metaLiveCall, request metaCallRequest) error {
	c.opMu.Lock()
	defer c.opMu.Unlock()
	c.mu.Lock()
	ended := c.ended
	c.mu.Unlock()
	if ended {
		return errors.New("official call has ended")
	}
	_, err := s.accounts.graph.Call(ctx, c.cfg, request)
	return err
}
func (s *metaCallService) maintenance() {
	ticker := time.NewTicker(30 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case <-ticker.C:
			s.mu.Lock()
			var timedOut []*metaLiveCall
			for _, c := range s.calls {
				if c.setupExpired(time.Now()) {
					timedOut = append(timedOut, c)
				}
			}
			for key, p := range s.pending {
				if time.Since(p.at) > 30*time.Second {
					delete(s.pending, key)
				}
			}
			s.mu.Unlock()
			for _, c := range timedOut {
				go s.failCall(c, "call_timeout")
			}
			ctx, cancel := context.WithTimeout(s.ctx, 5*time.Second)
			_ = s.store.reap(ctx)
			cancel()
		}
	}
}
func (s *metaCallService) Close() {
	s.mu.Lock()
	if s.closed {
		s.mu.Unlock()
		return
	}
	s.closed = true
	calls := make([]*metaLiveCall, 0, len(s.calls))
	for _, c := range s.calls {
		calls = append(calls, c)
	}
	s.mu.Unlock()
	s.cancel()
	var wg sync.WaitGroup
	for _, c := range calls {
		wg.Add(1)
		go func(c *metaLiveCall) { defer wg.Done(); s.failCall(c, "server_shutdown") }(c)
	}
	wg.Wait()
}
