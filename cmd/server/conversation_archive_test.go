package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func archiveFixture(t *testing.T) (*sessionStore, *sql.DB) {
	t.Helper()
	_, _, db := restaurantOrdersFixtureDB(t)
	store, err := newSessionStore(context.Background(), db)
	if err != nil {
		t.Fatal(err)
	}
	return store, db
}
func archiveEnable(t *testing.T, s *sessionStore) archivePolicy {
	t.Helper()
	p, err := s.archivePolicy(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	p.Enabled = true
	p.NoticeAccepted = true
	p, err = s.saveArchivePolicy(context.Background(), p, "test-admin")
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func archiveMessageFixture(id string) storedMessage {
	return storedMessage{ChatJID: "966500000000@s.whatsapp.net", SenderJID: "966500000000@s.whatsapp.net", MsgID: id, Timestamp: time.Now().Add(time.Second).UnixMilli(), Type: "text", Body: "Where is my order?", Raw: json.RawMessage(`{"conversation":"Where is my order?"}`)}
}
func archiveOne(t *testing.T, s *sessionStore) archiveConversation {
	t.Helper()
	list, err := s.listArchive(context.Background())
	if err != nil || len(list) != 1 {
		t.Fatalf("archive list: %v count=%d", err, len(list))
	}
	return list[0]
}

func TestConversationArchivePolicySafeDefaults(t *testing.T) {
	s, db := archiveFixture(t)
	ctx := context.Background()
	p, err := s.archivePolicy(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if p.Enabled || p.RetentionEnabled || p.AIEnabled || p.OriginalHours != 24 || p.SummaryDays != 90 {
		t.Fatal("unsafe policy defaults")
	}
	if err = s.saveMessage(ctx, "session", archiveMessageFixture("legacy")); err != nil {
		t.Fatal(err)
	}
	list, err := s.listArchive(ctx)
	if err != nil || len(list) != 0 {
		t.Fatal("migration captured existing history")
	}
	p.Enabled = true
	if _, err = s.saveArchivePolicy(ctx, p, "admin"); err == nil {
		t.Fatal("enabled without notice")
	}
	p = archiveEnable(t, s)
	stale := p
	p.OriginalHours = 48
	p, err = s.saveArchivePolicy(ctx, p, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.saveArchivePolicy(ctx, stale, "admin"); err == nil {
		t.Fatal("stale policy replaced newer save")
	}
	if err = s.purgeArchive(ctx, time.Now().AddDate(2, 0, 0)); err != nil {
		t.Fatal(err)
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM messages`).Scan(&count); err != nil || count != 1 {
		t.Fatal("disabled retention deleted legacy history")
	}
}

func TestConversationArchiveConcurrentMessagesAndEpisodes(t *testing.T) {
	s, db := archiveFixture(t)
	archiveEnable(t, s)
	ctx := context.Background()
	m := archiveMessageFixture("same")
	var wg sync.WaitGroup
	errs := make(chan error, 20)
	for n := 0; n < 20; n++ {
		wg.Add(1)
		go func() { defer wg.Done(); errs <- s.saveMessage(ctx, "session", m) }()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
	c := archiveOne(t, s)
	var count int
	if err := db.QueryRow(`SELECT count(*) FROM messages`).Scan(&count); err != nil || count != 1 {
		t.Fatal("duplicate message")
	}
	c, err := s.changeArchive(ctx, c.ID, archiveChange{Version: c.Version, Action: "close"}, "admin")
	if err != nil || c.ClosedAt == nil || c.SummarySource != "metadata_only" {
		t.Fatalf("close failed: %v", err)
	}
	if err = s.saveMessage(ctx, "session", archiveMessageFixture("next")); err != nil {
		t.Fatal(err)
	}
	list, err := s.listArchive(ctx)
	if err != nil || len(list) != 2 {
		t.Fatal("new message reopened old retention episode")
	}
}

func TestConversationArchiveRetentionHoldTombstoneAndAudio(t *testing.T) {
	s, db := archiveFixture(t)
	ctx := context.Background()
	p := archiveEnable(t, s)
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
	m := archiveMessageFixture("recorded")
	if err := s.saveMessage(ctx, "session", m); err != nil {
		t.Fatal(err)
	}
	c := archiveOne(t, s)
	path := filepath.Join(recordingDir(), "test-call.mp3")
	if err := os.WriteFile(path, []byte("private recording bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.archiveCallRecording(ctx, "session", m.ChatJID, "call1", path, 4); err != nil {
		t.Fatal(err)
	}
	c = archiveOne(t, s)
	var err error
	c, err = s.changeArchive(ctx, c.ID, archiveChange{Version: c.Version, Action: "close"}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	p.RetentionEnabled = true
	if _, err = s.saveArchivePolicy(ctx, p, "admin"); err != nil {
		t.Fatal(err)
	}
	until := time.Now().Add(time.Hour)
	c, err = s.changeArchive(ctx, c.ID, archiveChange{Version: c.Version, Action: "hold", Reason: "unresolved complaint", Until: &until}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE conversation_archive SET closed_at=now()-interval '3 days',hold_until=now()-interval '1 day' WHERE id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	if err = s.purgeArchive(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(path); err != nil {
		t.Fatal("expired review deadline deleted held recording")
	}
	c, err = s.changeArchive(ctx, c.ID, archiveChange{Version: c.Version, Action: "release_hold", Verified: true, Reason: "complaint resolved"}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if err = s.purgeArchive(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	c, err = s.getArchive(ctx, c.ID)
	if err != nil || !c.OriginalsPurged || c.Summary == "" {
		t.Fatal("original/summary retention not separate")
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("local call recording survived expiry")
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM messages`).Scan(&count); err != nil || count != 0 {
		t.Fatal("raw message survived expiry")
	}
	if err = db.QueryRow(`SELECT count(*) FROM conversation_archive_media WHERE data IS NOT NULL OR raw IS NOT NULL`).Scan(&count); err != nil || count != 0 {
		t.Fatal("audio bytes survived expiry")
	}
	if err = s.saveMessage(ctx, "session", m); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRow(`SELECT count(*) FROM messages`).Scan(&count); err != nil || count != 0 {
		t.Fatal("late duplicate resurrected deleted originals")
	}
}

func TestConversationArchiveComplaintBlocksBothRetentionPasses(t *testing.T) {
	s, db := archiveFixture(t)
	ctx := context.Background()
	p := archiveEnable(t, s)
	p.RetentionEnabled = true
	if _, err := s.saveArchivePolicy(ctx, p, "admin"); err != nil {
		t.Fatal(err)
	}
	if err := s.saveMessage(ctx, "session", archiveMessageFixture("complaint")); err != nil {
		t.Fatal(err)
	}
	c := archiveOne(t, s)
	_, err := db.Exec(`INSERT INTO restaurant_orders(number,status,version,document,token_hash,code_hash,sealed_secrets,request_hash,idempotency_hash,created_at,updated_at) VALUES('R-COMPLAINT','completed',1,'{"complaints":[{"status":"open"}]}',$1,$1,$1,$1,$1,now(),now())`, make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.changeArchive(ctx, c.ID, archiveChange{Version: c.Version, Action: "link_order", OrderNumber: "R-COMPLAINT", Verified: true}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	c, err = s.changeArchive(ctx, c.ID, archiveChange{Version: c.Version, Action: "close"}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.Exec(`UPDATE conversation_archive SET closed_at=now()-interval '100 days' WHERE id=$1`, c.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.purgeArchive(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	c, err = s.getArchive(ctx, c.ID)
	if err != nil || c.OriginalsPurged {
		t.Fatal("open complaint source deleted")
	}
	_, err = db.Exec(`UPDATE restaurant_orders SET document='{"complaints":[{"status":"resolved"}]}' WHERE number='R-COMPLAINT'`)
	if err != nil {
		t.Fatal(err)
	}
	if err = s.purgeArchive(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	c, err = s.getArchive(ctx, c.ID)
	if err != nil || !c.OriginalsPurged {
		t.Fatal("resolved complaint originals not purged")
	}
	if err = s.purgeArchive(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if _, err = s.getArchive(ctx, c.ID); err == nil {
		t.Fatal("summary deadline ignored")
	}
}

func TestConversationArchiveMasterHeaderAndAudioAudit(t *testing.T) {
	s, _ := archiveFixture(t)
	archiveEnable(t, s)
	t.Setenv("WACALLS_API_KEY", "archive-test-master")
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
	ctx := context.Background()
	path := filepath.Join(recordingDir(), "private.mp3")
	if err := os.WriteFile(path, []byte("private bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := s.archiveCallRecording(ctx, "session", "peer", "call", path, 4); err != nil {
		t.Fatal(err)
	}
	c := archiveOne(t, s)
	var media string
	if err := s.db.QueryRow(`SELECT id FROM conversation_archive_media`).Scan(&media); err != nil {
		t.Fatal(err)
	}
	srv := &server{sessions: &SessionManager{store: s}}
	mux := http.NewServeMux()
	srv.registerConversationArchiveRoutes(mux)
	mux.HandleFunc("GET /recordings/{id}", srv.handleRecording)
	url := "/api/restaurant/archive/conversations/" + c.ID + "/media/" + media
	for _, test := range []struct {
		url, key string
		want     int
	}{{url, "", 401}, {url + "?apiKey=archive-test-master", "", 401}, {url, "widget-only", 401}, {"/recordings/private.mp3", "", 401}, {url, "archive-test-master", 200}, {"/recordings/private.mp3", "archive-test-master", 200}} {
		r := httptest.NewRequest("GET", test.url, nil)
		if test.key != "" {
			r.Header.Set("X-API-Key", test.key)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != test.want {
			t.Fatalf("auth status %d want %d", w.Code, test.want)
		}
		if w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal("audio cached")
		}
	}
	var count int
	if err := s.db.QueryRow(`SELECT count(*) FROM conversation_archive_audit WHERE action='audio_download'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("download unaudited")
	}
}

func TestConversationArchiveAISummaryStatelessAndUntrustedInput(t *testing.T) {
	calls := 0
	client := &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.URL.String() != "https://api.openai.com/v1/responses" || r.Header.Get("Authorization") != "Bearer test-not-real" {
			t.Fatal("wrong provider boundary")
		}
		var body map[string]any
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		if body["store"] != false || body["model"] != "configured-model" || body["input"] != "untrusted text" || !strings.Contains(body["instructions"].(string), "NOT been transcribed") {
			t.Fatal("summary safety contract")
		}
		return restaurantPaymentTestResponse(`{"status":"completed","output":[{"type":"reasoning","content":[{"type":"output_text","text":"must not extract"}]},{"type":"message","content":[{"type":"output_text","text":"مسودة"}]}]}`), nil
	})}
	text, err := requestArchiveSummary(context.Background(), client, "test-not-real", "configured-model", "untrusted text")
	if err != nil || text != "مسودة" || calls != 1 {
		t.Fatal("summary parser failed")
	}
	if _, err = requestArchiveSummary(context.Background(), client, "", "configured-model", "text"); err == nil || calls != 1 {
		t.Fatal("missing key dispatched")
	}
}

func TestConversationArchiveAILeaseManualEditWins(t *testing.T) {
	s, db := archiveFixture(t)
	ctx := context.Background()
	p := archiveEnable(t, s)
	p.AIEnabled = true
	p.AIModel = "configured-model"
	p.RetentionEnabled = true
	if _, err := s.saveArchivePolicy(ctx, p, "admin"); err != nil {
		t.Fatal(err)
	}
	if err := s.saveMessage(ctx, "session", archiveMessageFixture("ai")); err != nil {
		t.Fatal(err)
	}
	c := archiveOne(t, s)
	c, err := s.changeArchive(ctx, c.ID, archiveChange{Version: c.Version, Action: "close"}, "admin")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec(`UPDATE conversation_archive SET closed_at=now()-interval '3 days' WHERE id=$1`, c.ID); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "test-not-real")
	t.Setenv("WACALLS_API_KEY", "archive-test-master")
	old := archiveAIClient
	t.Cleanup(func() { archiveAIClient = old })
	entered := make(chan struct{})
	release := make(chan struct{})
	archiveAIClient = &http.Client{Transport: restaurantPaymentTestTransport(func(r *http.Request) (*http.Response, error) {
		close(entered)
		<-release
		return restaurantPaymentTestResponse(`{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"stale AI result"}]}]}`), nil
	})}
	srv := &server{sessions: &SessionManager{store: s}}
	mux := http.NewServeMux()
	srv.registerConversationArchiveRoutes(mux)
	body := string(archiveJSON(map[string]any{"version": c.Version, "consent": true}))
	request := httptest.NewRequest("POST", "/api/restaurant/archive/conversations/"+c.ID+"/summarize", strings.NewReader(body))
	request.Header.Set("X-API-Key", "archive-test-master")
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	done := make(chan struct{})
	go func() { mux.ServeHTTP(response, request); close(done) }()
	<-entered
	if err = s.purgeArchive(ctx, time.Now()); err != nil {
		t.Fatal(err)
	}
	if saved, err := s.getArchive(ctx, c.ID); err != nil || saved.OriginalsPurged {
		t.Fatal("in-flight AI source purged")
	}
	editCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	if _, err = s.changeArchive(editCtx, c.ID, archiveChange{Version: c.Version, Action: "summary", Summary: "human reviewed"}, "admin"); err != nil {
		t.Fatalf("network call held DB lock: %v", err)
	}
	close(release)
	<-done
	if response.Code != 409 {
		t.Fatalf("stale AI result status %d", response.Code)
	}
	saved, err := s.getArchive(ctx, c.ID)
	if err != nil || saved.Summary != "human reviewed" {
		t.Fatal("AI overwrote manual summary")
	}
}

func TestConversationArchiveChatwootLeaseAndFIFO(t *testing.T) {
	s, _ := archiveFixture(t)
	ctx := context.Background()
	now := nowMillis()
	for _, id := range []string{"first", "second"} {
		if err := s.enqueueOutbox(ctx, "session", id, archiveJSON(cwJob{ChatID: "peer", SourceID: id, Text: "private"}), now, now); err != nil {
			t.Fatal(err)
		}
	}
	var wg sync.WaitGroup
	var claims atomic.Int32
	found := make(chan outboxRow, 8)
	for n := 0; n < 8; n++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows, err := s.dueOutbox(ctx, now+1, 50)
			if err != nil {
				t.Error(err)
				return
			}
			claims.Add(int32(len(rows)))
			for _, row := range rows {
				found <- row
			}
		}()
	}
	wg.Wait()
	close(found)
	if claims.Load() != 1 {
		t.Fatalf("duplicate/out-of-order claims %d", claims.Load())
	}
	var first outboxRow
	for row := range found {
		first = row
	}
	if err := s.deleteOutbox(ctx, first.ID, "wrong-lease"); err != nil {
		t.Fatal(err)
	}
	rows, err := s.dueOutbox(ctx, now+2, 50)
	if err != nil || len(rows) != 0 {
		t.Fatal("stale worker changed lease")
	}
	if err = s.deleteOutbox(ctx, first.ID, first.LeaseToken); err != nil {
		t.Fatal(err)
	}
	rows, err = s.dueOutbox(ctx, now+3, 50)
	if err != nil || len(rows) != 1 {
		t.Fatal("FIFO successor not released")
	}
	if err = s.enqueueOutbox(ctx, "session", "first", archiveJSON(cwJob{ChatID: "peer", SourceID: "first", Text: "replayed"}), now, now); err != nil {
		t.Fatal(err)
	}
	var delivered bool
	var payload string
	if err = s.db.QueryRow(`SELECT delivered,payload::text FROM chatwoot_outbox WHERE source_id='first'`).Scan(&delivered, &payload); err != nil || !delivered || payload != "{}" {
		t.Fatal("delivered tombstone revived or leaked body")
	}
}

func TestConversationArchivePrivateSpoolReplay(t *testing.T) {
	s, db := archiveFixture(t)
	archiveEnable(t, s)
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
	m := archiveMessageFixture("spooled")
	if err := spoolArchiveMessage("session", m); err != nil {
		t.Fatal(err)
	}
	path := archiveSpoolPath("session", m)
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("spool is not private")
	}
	manager := &SessionManager{store: s, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	manager.replayArchiveSpool(context.Background())
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("committed spool remains")
	}
	var count int
	if err = db.QueryRow(`SELECT count(*) FROM messages WHERE msg_id='spooled'`).Scan(&count); err != nil || count != 1 {
		t.Fatal("spool not persisted")
	}
}

func TestConversationArchiveSpoolGenerationsNeverDeleteOrOverwriteNewerEdit(t *testing.T) {
	s, db := archiveFixture(t)
	archiveEnable(t, s)
	t.Setenv("WACALLS_RECORDING_DIR", t.TempDir())
	ctx := context.Background()
	old := archiveMessageFixture("edited")
	old.ReceivedAt = time.Now().UnixNano()
	newer := old
	newer.ReceivedAt++
	newer.Body = "corrected message"
	newer.Raw = json.RawMessage(`{"conversation":"corrected message"}`)
	if err := spoolArchiveMessage("session", old); err != nil {
		t.Fatal(err)
	}
	if err := spoolArchiveMessage("session", newer); err != nil {
		t.Fatal(err)
	}
	if archiveSpoolPath("session", old) == archiveSpoolPath("session", newer) {
		t.Fatal("edits share spool filename")
	}
	if err := s.saveMessage(ctx, "session", old); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(archiveSpoolPath("session", old)); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(archiveSpoolPath("session", newer)); err != nil {
		t.Fatal("old successful worker erased newer generation")
	}
	if err := s.saveMessage(ctx, "session", newer); err != nil {
		t.Fatal(err)
	}
	if err := spoolArchiveMessage("session", old); err != nil {
		t.Fatal(err)
	}
	m := &SessionManager{store: s, log: slog.New(slog.NewTextHandler(io.Discard, nil))}
	m.replayArchiveSpool(ctx)
	var body string
	if err := db.QueryRow(`SELECT body FROM messages WHERE msg_id='edited'`).Scan(&body); err != nil || body != "corrected message" {
		t.Fatal("old spool replay replaced newer edit")
	}
}
