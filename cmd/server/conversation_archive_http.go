package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"errors"
	"net/http"
	"time"
)

func archiveActor(r *http.Request) string {
	sum := sha256.Sum256([]byte(r.Header.Get("X-API-Key")))
	return "admin:" + hex.EncodeToString(sum[:6])
}
func archiveMasterAuthorized(r *http.Request) bool {
	want := runtimeSecret("WACALLS_API_KEY")
	got := r.Header.Get("X-API-Key")
	return want != "" && got != "" && subtle.ConstantTimeCompare([]byte(want), []byte(got)) == 1
}

func (s *server) registerConversationArchiveRoutes(admin *http.ServeMux) {
	guard := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Cache-Control", "no-store")
			w.Header().Set("Referrer-Policy", "no-referrer")
			w.Header().Set("X-Content-Type-Options", "nosniff")
			if !archiveMasterAuthorized(r) {
				writeRestaurantError(w, restaurantFail(401, "unauthorized"))
				return
			}
			if s.sessions == nil || s.sessions.store == nil {
				writeRestaurantError(w, restaurantFail(503, "server_error"))
				return
			}
			h(w, r)
		}
	}
	admin.HandleFunc("GET /api/restaurant/archive/policy", guard(func(w http.ResponseWriter, r *http.Request) {
		p, err := s.sessions.store.archivePolicy(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, p)
	}))
	admin.HandleFunc("PUT /api/restaurant/archive/policy", guard(func(w http.ResponseWriter, r *http.Request) {
		var p archivePolicy
		if !decodeRestaurantBody(w, r, &p) {
			return
		}
		p, err := s.sessions.store.saveArchivePolicy(r.Context(), p, archiveActor(r))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, p)
	}))
	admin.HandleFunc("GET /api/restaurant/archive/conversations", guard(func(w http.ResponseWriter, r *http.Request) {
		items, err := s.sessions.store.listArchive(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		if err = s.sessions.store.archiveAudit(r.Context(), "", "list", archiveActor(r)); err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"conversations": items})
	}))
	admin.HandleFunc("GET /api/restaurant/archive/conversations/{id}", guard(s.handleArchiveDetail))
	admin.HandleFunc("PATCH /api/restaurant/archive/conversations/{id}", guard(func(w http.ResponseWriter, r *http.Request) {
		var in archiveChange
		if !decodeRestaurantBody(w, r, &in) {
			return
		}
		v, err := s.sessions.store.changeArchive(r.Context(), r.PathValue("id"), in, archiveActor(r))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, v)
	}))
	admin.HandleFunc("GET /api/restaurant/archive/conversations/{id}/media/{mediaID}", guard(s.handleArchiveMedia))
	admin.HandleFunc("POST /api/restaurant/archive/conversations/{id}/summarize", guard(s.handleArchiveSummary))
}

func (s *server) handleArchiveDetail(w http.ResponseWriter, r *http.Request) {
	store := s.sessions.store
	id := r.PathValue("id")
	c, err := store.getArchive(r.Context(), id)
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	if err = store.archiveAudit(r.Context(), id, "view", archiveActor(r)); err != nil {
		writeRestaurantError(w, err)
		return
	}
	rows, err := store.db.QueryContext(r.Context(), `SELECT chat_jid,sender_jid,msg_id,from_me,ts,type,COALESCE(body,''),NULL FROM messages WHERE archive_id=$1 ORDER BY ts DESC,msg_id DESC LIMIT 500`, id)
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	messages, err := scanMessages(rows)
	rows.Close()
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	rows, err = store.db.QueryContext(r.Context(), `SELECT id,message_id,kind,mime,status,seconds,COALESCE(octet_length(data),0),created_at,content_description FROM conversation_archive_media WHERE conversation_id=$1 ORDER BY created_at DESC LIMIT 500`, id)
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	media := []archiveMedia{}
	for rows.Next() {
		var a archiveMedia
		if err = rows.Scan(&a.ID, &a.MessageID, &a.Kind, &a.MIME, &a.Status, &a.Seconds, &a.Bytes, &a.CreatedAt, &a.ContentDescription); err != nil {
			break
		}
		media = append(media, a)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	rows, err = store.db.QueryContext(r.Context(), `SELECT action,created_at,actor,detail FROM conversation_archive_audit WHERE conversation_id=$1 ORDER BY id DESC LIMIT 100`, id)
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	audit := []archiveAudit{}
	for rows.Next() {
		var a archiveAudit
		if err = rows.Scan(&a.Action, &a.CreatedAt, &a.Actor, &a.Detail); err != nil {
			break
		}
		audit = append(audit, a)
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	writeJSON(w, 200, map[string]any{"conversation": c, "messages": messages, "media": media, "audit": audit, "messageLimit": 500})
}

func (s *server) handleArchiveMedia(w http.ResponseWriter, r *http.Request) {
	var data []byte
	var mime string
	var created time.Time
	err := s.sessions.store.db.QueryRowContext(r.Context(), `SELECT m.data,m.mime,m.created_at FROM conversation_archive_media m JOIN conversation_archive c ON c.id=m.conversation_id WHERE m.id=$1 AND m.conversation_id=$2 AND m.status='ready' AND c.originals_purged=false`, r.PathValue("mediaID"), r.PathValue("id")).Scan(&data, &mime, &created)
	if errors.Is(err, sql.ErrNoRows) {
		writeRestaurantError(w, restaurantFail(404, "not_found"))
		return
	}
	if err != nil {
		writeRestaurantError(w, err)
		return
	}
	if err = s.sessions.store.archiveAudit(r.Context(), r.PathValue("id"), "audio_download", archiveActor(r)); err != nil {
		writeRestaurantError(w, err)
		return
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", `attachment; filename="conversation-audio"`)
	http.ServeContent(w, r, "conversation-audio", created, bytes.NewReader(data))
}
