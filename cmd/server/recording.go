package main

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"go.mau.fi/whatsmeow/types"
)

// Completed MP3 recordings require the master key in a request header. A
// non-enumerable filename is NOT authorization. If explicitly configured,
// Chatwoot still receives a private-note attachment and session webhooks receive
// metadata. Those external copies have independent retention responsibilities.

// Historical function name: this is now an authenticated download URL, never a
// bearer capability. Integrations need a separate authorized header transport.
func recordingPublicURL(path string) string {
	base := strings.TrimRight(os.Getenv("WACALLS_PUBLIC_BASE_URL"), "/")
	if base == "" {
		return ""
	}
	return base + "/recordings/" + filepath.Base(path)
}

// onRecordingReady é chamado quando o MP3 de uma chamada fica pronto. Dispara o
// webhook da sessão e sobe o áudio no Chatwoot (se configurado).
func (s *Session) onRecordingReady(callID, peerJID, path string, seconds int) {
	if s.mgr != nil && s.mgr.store != nil {
		if err := s.mgr.store.archiveCallRecording(s.mgr.appCtx, s.id, peerJID, callID, path, seconds); err != nil {
			s.log.Error("call archive failed; original private recording preserved", "call_id", callID, "err", err)
		}
	}
	url := recordingPublicURL(path)
	s.dispatchWebhook("recording", map[string]any{
		"callId":               callID,
		"to":                   peerJID,
		"url":                  url,
		"seconds":              seconds,
		"requiresMasterHeader": true,
		"contentDescription":   "peer_original_plus_sent_audio_mix",
	})
	if cfg := s.getChatwoot(); cfg.valid() && peerJID != "" {
		s.chatwootUploadRecording(cfg, peerJID, path, seconds)
	}
}

// chatwootUploadRecording anexa o MP3 na conversa do número ligado como nota
// privada (não é reenviado ao cliente).
func (s *Session) chatwootUploadRecording(cfg ChatwootConfig, peerJID, path string, seconds int) {
	jid, err := resolveRecipient(peerJID)
	if err != nil {
		return
	}
	phone := s.realPhone(jid)
	if phone == "" {
		phone = jid.User
	}
	if phone == "" {
		return
	}
	data, err := os.ReadFile(path)
	if err != nil {
		s.log.Error("recording: ler mp3 falhou", "err", err)
		return
	}
	chatID := phone + "@" + types.DefaultUserServer
	contactID, sourceID, err := cfg.ensureContact(chatID, phone, phone, "")
	if err != nil {
		s.log.Error("recording: ensure contact falhou", "err", err)
		return
	}
	convID, err := cfg.ensureConversation(contactID, sourceID)
	if err != nil {
		s.log.Error("recording: ensure conversation falhou", "err", err)
		return
	}
	caption := "🎙️ Gravação da chamada · " + fmtDuration(seconds)
	if err := cfg.postAttachment(convID, caption, filepath.Base(path), "audio/mpeg", data, cwPrivate, "", "", 0); err != nil {
		s.log.Error("recording: upload no chatwoot falhou", "err", err)
	}
}

func fmtDuration(seconds int) string {
	return fmt.Sprintf("%d:%02d", seconds/60, seconds%60)
}

// The legacy URL remains compatible only for header-authenticated operators.
func (s *server) handleRecording(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	if !archiveMasterAuthorized(r) {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
		return
	}
	id := r.PathValue("id")
	if !safeRecordingID(id) {
		http.NotFound(w, r)
		return
	}
	full := filepath.Join(recordingDir(), filepath.Base(id))
	info, err := os.Lstat(full)
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	if s.sessions == nil || s.sessions.store == nil || s.sessions.store.archiveAudit(r.Context(), "", "legacy_audio_download", archiveActor(r)) != nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "server_error"})
		return
	}
	w.Header().Set("Content-Type", "audio/mpeg")
	http.ServeFile(w, r, full)
}

// safeRecordingID barra path traversal: só nome simples [A-Za-z0-9._-].
func safeRecordingID(id string) bool {
	if id == "" || id == "." || id == ".." || strings.Contains(id, "..") {
		return false
	}
	for _, c := range id {
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		case c == '.' || c == '_' || c == '-':
		default:
			return false
		}
	}
	return true
}

// GET /api/sessions/{sid}/recording → estado do toggle da sessão
func (s *server) handleGetRecording(w http.ResponseWriter, r *http.Request) {
	sess := s.sessionByID(w, r.PathValue("sid"))
	if sess == nil {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": sess.getRecording()})
}

// PUT /api/sessions/{sid}/recording {enabled: bool} → liga/desliga a gravação
func (s *server) handleSetRecording(w http.ResponseWriter, r *http.Request) {
	sess := s.sessionByID(w, r.PathValue("sid"))
	if sess == nil {
		return
	}
	var b struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.NewDecoder(r.Body).Decode(&b); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]string{"error": "enabled required"})
		return
	}
	sess.setRecording(b.Enabled)
	_ = sess.mgr.store.setRecording(r.Context(), sess.id, b.Enabled)
	sess.mgr.broker.emitSessionList(sess.mgr.infos())
	writeJSON(w, http.StatusOK, map[string]any{"enabled": b.Enabled})
}

// Legacy blind 48h deletion is intentionally disabled. The opt-in archive
// worker enforces closure/complaint/legal-hold-aware retention. Existing legacy
// recordings are preserved and require a deliberate migration/cleanup policy.
func startRecordingJanitor(log *slog.Logger) {
	log.Info("recording retention managed by opt-in archive policy; legacy files preserved")
}

func cleanupOldRecordings(log *slog.Logger) {
	log.Debug("legacy recording cleanup disabled; use archive retention")
}
