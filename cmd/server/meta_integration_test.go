package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
)

// These tests are opt-in and never use the application's database URL. Even
// inside the explicitly named disposable database, each test owns a fresh
// random schema; cleanup cannot truncate existing application or test tables.
func metaIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	raw := os.Getenv("TEST_META_PG_URL")
	if raw == "" {
		t.Skip("set TEST_META_PG_URL for the disposable astracalls_meta_test database")
	}
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") || u.Path != "/astracalls_meta_test" || u.RawQuery != "" && u.Query().Get("dbname") != "" {
		t.Fatal("TEST_META_PG_URL must explicitly name /astracalls_meta_test; refusing another database")
	}
	admin, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal("could not open integration database")
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := admin.PingContext(ctx); err != nil {
		t.Fatal("integration database is unavailable")
	}
	var actualDatabase string
	if err := admin.QueryRowContext(ctx, "SELECT current_database()").Scan(&actualDatabase); err != nil || actualDatabase != "astracalls_meta_test" {
		t.Fatal("refusing integration writes outside astracalls_meta_test")
	}
	schema := "meta_it_" + metaIntegrationSecret(t)[:24]
	if _, err := admin.ExecContext(ctx, `CREATE SCHEMA "`+schema+`"`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cleanupCancel()
		if _, err := admin.ExecContext(cleanupCtx, `DROP SCHEMA "`+schema+`" CASCADE`); err != nil {
			t.Errorf("remove this test's isolated schema: %v", err)
		}
	})
	query := u.Query()
	query.Set("search_path", schema)
	u.RawQuery = query.Encode()
	db, err := sql.Open("pgx", u.String())
	if err != nil {
		t.Fatal("could not open isolated integration schema")
	}
	t.Cleanup(func() { _ = db.Close() })
	var actualSchema string
	if err := db.QueryRowContext(ctx, "SELECT current_schema()").Scan(&actualSchema); err != nil || actualSchema != schema {
		t.Fatal("isolated integration schema was not selected")
	}
	return db
}

func metaIntegrationSecret(t *testing.T) string {
	t.Helper()
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(value)
}

func metaIntegrationKey(t *testing.T) string {
	t.Helper()
	value := make([]byte, 32)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	key := base64.StdEncoding.EncodeToString(value)
	t.Setenv("WACALLS_META_ENCRYPTION_KEY", key)
	return key
}

func metaIntegrationConfig(t *testing.T, phone, waba string) metaConfig {
	t.Helper()
	return metaConfig{PhoneNumberID: phone, WABAID: waba, APIVersion: "v24.0", AccessToken: metaIntegrationSecret(t), AppSecret: metaIntegrationSecret(t), VerifyToken: metaIntegrationSecret(t)}
}

func metaIntegrationRequest(t *testing.T, handler http.Handler, method, path, key string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, path, bytes.NewReader(data))
	request.Header.Set("Content-Type", "application/json")
	if key != "" {
		request.Header.Set("X-API-Key", key)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

func metaIntegrationStatus(t *testing.T, response *httptest.ResponseRecorder, status int) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("unexpected HTTP status: got %d, want %d", response.Code, status)
	}
}

func TestMetaPostgresAccountLifecycleAndWebhook(t *testing.T) {
	db := metaIntegrationDB(t)
	key := metaIntegrationKey(t)
	apiKey := metaIntegrationSecret(t)
	t.Setenv("WACALLS_API_KEY", apiKey)
	t.Setenv("WACALLS_WIDGET_KEY", "")
	t.Setenv("WACALLS_PUBLIC_BASE_URL", "https://calling.example.test")
	ctx := context.Background()
	qrStore, err := newSessionStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if err := qrStore.insert(ctx, "unpaired_qr", "Existing QR account"); err != nil {
		t.Fatal(err)
	}
	if err := qrStore.setRecording(ctx, "unpaired_qr", true); err != nil {
		t.Fatal(err)
	}
	qrBefore, err := qrStore.list(ctx)
	if err != nil {
		t.Fatal(err)
	}
	manager, err := newMetaManager(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	cfg := metaIntegrationConfig(t, "123456", "654321")
	graph := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.Header.Get("Authorization") != "Bearer "+cfg.AccessToken {
			t.Error("unexpected Graph verification method or authentication")
			http.Error(w, "invalid test request", http.StatusBadRequest)
			return
		}
		switch r.URL.Path {
		case "/v24.0/123456":
			_, _ = io.WriteString(w, `{"id":"123456"}`)
		case "/v24.0/654321/phone_numbers":
			_, _ = io.WriteString(w, `{"data":[{"id":"123456"}]}`)
		case "/v24.0/123456/settings":
			_, _ = io.WriteString(w, `{"calling":{"status":"enabled","sip":{"status":"disabled"}}}`)
		default:
			t.Errorf("unexpected Graph path: %s", r.URL.Path)
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(graph.Close)
	manager.graph = &metaGraphClient{baseURL: graph.URL, httpClient: graph.Client()}
	broker := NewBroker()
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	calls, err := newMetaCallService(ctx, manager, broker, 2, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(calls.Close)
	s := &server{meta: manager, metaCalls: calls, broker: broker, log: log, sessions: &SessionManager{meta: manager, store: qrStore, sessions: map[string]*Session{}, maxCalls: 2}}
	handler := s.routes()
	createBody := map[string]any{"name": "Official account", "provider": "meta", "meta": cfg}
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPost, "/api/sessions", "", createBody), http.StatusUnauthorized)
	created := metaIntegrationRequest(t, handler, http.MethodPost, "/api/sessions", apiKey, createBody)
	metaIntegrationStatus(t, created, http.StatusOK)
	var result struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(created.Body.Bytes(), &result); err != nil || !strings.HasPrefix(result.ID, "meta_") {
		t.Fatal("official account was not created")
	}
	id := result.ID
	path := "/api/sessions/" + id
	if infos := manager.Infos(); len(infos) != 1 || infos[0].Paired || infos[0].State != "configured" {
		t.Fatalf("new account must require setup: %+v", infos)
	}
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPost, "/api/sessions", apiKey, createBody), http.StatusConflict)
	var ciphertext []byte
	if err := db.QueryRowContext(ctx, "SELECT credentials FROM meta_accounts WHERE id=$1", id).Scan(&ciphertext); err != nil {
		t.Fatal(err)
	}
	public := metaIntegrationRequest(t, handler, http.MethodGet, path+"/meta", apiKey, nil)
	metaIntegrationStatus(t, public, http.StatusOK)
	for _, secret := range []string{cfg.AccessToken, cfg.AppSecret, cfg.VerifyToken} {
		if bytes.Contains(ciphertext, []byte(secret)) || bytes.Contains(public.Body.Bytes(), []byte(secret)) {
			t.Fatal("database ciphertext or public settings exposed a credential")
		}
	}
	var settings metaPublicConfig
	if err := json.Unmarshal(public.Body.Bytes(), &settings); err != nil || settings.WebhookURL != "https://calling.example.test/webhooks/whatsapp/"+id || !settings.HasAccessToken || !settings.HasAppSecret || !settings.HasVerifyToken {
		t.Fatal("redacted settings or webhook URL are incorrect")
	}
	blank := cfg
	blank.AccessToken, blank.AppSecret, blank.VerifyToken = "", "", ""
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPut, path+"/meta", apiKey, blank), http.StatusOK)
	if account, _ := manager.Account(id); account.Config != cfg {
		t.Fatal("blank secret update did not preserve existing credentials")
	}
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPost, path+"/meta/verify", apiKey, map[string]any{}), http.StatusOK)
	if manager.Infos()[0].Paired {
		t.Fatal("Graph verification alone marked the account ready")
	}
	challenge := func(token string) *httptest.ResponseRecorder {
		query := url.Values{"hub.mode": {"subscribe"}, "hub.verify_token": {token}, "hub.challenge": {"challenge-value"}}
		return metaIntegrationRequest(t, handler, http.MethodGet, "/webhooks/whatsapp/"+id+"?"+query.Encode(), "", nil)
	}
	metaIntegrationStatus(t, challenge(metaIntegrationSecret(t)), http.StatusForbidden)
	verified := challenge(cfg.VerifyToken)
	metaIntegrationStatus(t, verified, http.StatusOK)
	if verified.Body.String() != "challenge-value" || !manager.Infos()[0].Paired {
		t.Fatal("webhook challenge did not complete readiness")
	}
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPost, path+"/pair", apiKey, map[string]any{}), http.StatusNotImplemented)
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPut, path+"/meta", apiKey, blank), http.StatusOK)
	if !manager.Infos()[0].Paired {
		t.Fatal("unchanged credentials unnecessarily reset readiness")
	}

	// Valid signatures do not authorize events belonging to another phone/WABA.
	change := func(phone, field, callID string) map[string]any {
		return map[string]any{"field": field, "value": map[string]any{"metadata": map[string]string{"phone_number_id": phone}, "calls": []map[string]string{{"id": callID, "event": "terminate"}}}}
	}
	body, err := json.Marshal(map[string]any{"object": "whatsapp_business_account", "entry": []map[string]any{
		{"id": "999999", "changes": []any{change(cfg.PhoneNumberID, "calls", "foreign-waba")}},
		{"id": cfg.WABAID, "changes": []any{change("999999", "calls", "foreign-phone"), change(cfg.PhoneNumberID, "messages", "message-event"), change(cfg.PhoneNumberID, "calls", "valid-first")}},
		{"id": cfg.WABAID, "changes": []any{change(cfg.PhoneNumberID, "calls", "valid-second")}},
	}})
	if err != nil {
		t.Fatal(err)
	}
	signedWebhook := func(secret string) *httptest.ResponseRecorder {
		hash := hmac.New(sha256.New, []byte(secret))
		_, _ = hash.Write(body)
		request := httptest.NewRequest(http.MethodPost, "/webhooks/whatsapp/"+id, bytes.NewReader(body))
		request.Header.Set("X-Hub-Signature-256", "sha256="+hex.EncodeToString(hash.Sum(nil)))
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	metaIntegrationStatus(t, signedWebhook(metaIntegrationSecret(t)), http.StatusUnauthorized)
	metaIntegrationStatus(t, signedWebhook(cfg.AppSecret), http.StatusOK)
	metaIntegrationStatus(t, signedWebhook(cfg.AppSecret), http.StatusOK)
	var receiptCount int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM meta_call_receipts WHERE session_id=$1", id).Scan(&receiptCount); err != nil || receiptCount != 2 {
		t.Fatalf("batched/account-filtered/idempotent receipt count: got %d, err %v", receiptCount, err)
	}
	for _, callID := range []string{"valid-first", "valid-second"} {
		var terminal bool
		if err := db.QueryRowContext(ctx, "SELECT terminal FROM meta_call_receipts WHERE session_id=$1 AND call_id=$2", id, callID).Scan(&terminal); err != nil || !terminal {
			t.Fatal("accepted terminal webhook was not persisted")
		}
	}

	restored, err := newMetaManager(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if account, ok := restored.Account(id); !ok || account.Config != cfg || !account.ready() || account.LastChecked.IsZero() {
		t.Fatal("encrypted account or readiness failed restart round trip")
	}
	rotated := blank
	rotated.VerifyToken = metaIntegrationSecret(t)
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPut, path+"/meta", apiKey, rotated), http.StatusOK)
	if account, _ := manager.Account(id); account.ready() || account.WebhookVerified || account.Verified {
		t.Fatal("credential rotation did not invalidate verification")
	}
	metaIntegrationStatus(t, challenge(cfg.VerifyToken), http.StatusForbidden)
	metaIntegrationStatus(t, challenge(rotated.VerifyToken), http.StatusOK)
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodPost, path+"/meta/verify", apiKey, map[string]any{}), http.StatusOK)
	if !manager.Infos()[0].Paired {
		t.Fatal("rotated account could not be reverified")
	}
	metaIntegrationKey(t)
	locked, err := newMetaManager(ctx, db)
	if err != nil || !locked.locked[id] || locked.Infos()[0].Paired || locked.Infos()[0].State != "error" {
		t.Fatal("wrong encryption key did not lock the account safely")
	}
	if err := locked.Update(ctx, id, blank); err == nil {
		t.Fatal("locked account accepted an update")
	}
	t.Setenv("WACALLS_META_ENCRYPTION_KEY", key)
	recovered, err := newMetaManager(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if account, ok := recovered.Account(id); !ok || !account.ready() || account.Config.VerifyToken != rotated.VerifyToken {
		t.Fatal("restoring the encryption key did not recover the saved account")
	}
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodDelete, path, apiKey, nil), http.StatusNoContent)
	metaIntegrationStatus(t, metaIntegrationRequest(t, handler, http.MethodGet, path+"/meta", apiKey, nil), http.StatusNotFound)
	if afterDelete, err := newMetaManager(ctx, db); err != nil || len(afterDelete.Infos()) != 0 {
		t.Fatal("deleted official account returned after restart")
	}
	qrRestored, err := newSessionStore(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	qrAfter, err := qrRestored.list(ctx)
	if err != nil || !reflect.DeepEqual(qrBefore, qrAfter) || len(qrAfter) != 1 || qrAfter[0].JID != "" {
		t.Fatal("official account lifecycle changed the existing unpaired QR configuration")
	}
}

func TestMetaPostgresCallReceiptRestartAndRetention(t *testing.T) {
	db := metaIntegrationDB(t)
	metaIntegrationKey(t)
	ctx := context.Background()
	manager, err := newMetaManager(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	service, err := newMetaCallService(ctx, manager, NewBroker(), 2, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Close)
	store := metaSQLCalls{db: db}
	if claimed, err := store.claim(ctx, "meta_first", "shared-call-id"); err != nil || !claimed {
		t.Fatal("first delivery was not claimed")
	}
	if claimed, err := store.claim(ctx, "meta_first", "shared-call-id"); err != nil || claimed {
		t.Fatal("duplicate delivery was claimed")
	}
	if claimed, err := store.claim(ctx, "meta_second", "shared-call-id"); err != nil || !claimed {
		t.Fatal("receipt IDs were not scoped to their account")
	}
	service.Close()
	restarted, err := newMetaCallService(ctx, manager, NewBroker(), 2, log)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.Close)
	var unfinished int
	if err := db.QueryRowContext(ctx, "SELECT count(*) FROM meta_call_receipts WHERE terminal=false").Scan(&unfinished); err != nil || unfinished != 0 {
		t.Fatal("restart did not make interrupted calls terminal")
	}
	if claimed, err := store.claim(ctx, "meta_first", "shared-call-id"); err != nil || claimed {
		t.Fatal("replayed call could be resurrected after restart")
	}
	for _, row := range []struct {
		id       string
		terminal bool
		age      time.Duration
	}{
		{"old-terminal", true, 9 * 24 * time.Hour},
		{"old-active", false, 9 * 24 * time.Hour},
		{"recent-terminal", true, time.Hour},
	} {
		if _, err := db.ExecContext(ctx, "INSERT INTO meta_call_receipts(session_id,call_id,terminal,updated_at) VALUES($1,$2,$3,$4)", "meta_retention", row.id, row.terminal, time.Now().Add(-row.age)); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.reap(ctx); err != nil {
		t.Fatal(err)
	}
	for id, want := range map[string]int{"old-terminal": 0, "old-active": 1, "recent-terminal": 1} {
		var count int
		if err := db.QueryRowContext(ctx, "SELECT count(*) FROM meta_call_receipts WHERE session_id=$1 AND call_id=$2", "meta_retention", id).Scan(&count); err != nil || count != want {
			t.Fatal(fmt.Sprintf("unexpected receipt retention for %s: count=%d", id, count))
		}
	}
}
