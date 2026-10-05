package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"google.golang.org/protobuf/encoding/protojson"
)

const archiveVoiceMaxBytes = 25 * 1024 * 1024
const archiveCallMaxBytes = 64 * 1024 * 1024

type archiveSpool struct {
	SessionID  string        `json:"sessionId"`
	Message    storedMessage `json:"message"`
	ReceivedAt int64         `json:"receivedAt"`
}

func archiveSpoolPath(sessionID string, m storedMessage) string {
	content := sha256.Sum256(archiveJSON(m))
	// A different edit/generation never shares a path, so a successful old
	// worker cannot unlink an uncommitted newer edit. Names sort by receipt time.
	name := fmt.Sprintf("%020d-%s-%x.json", m.ReceivedAt, archiveFingerprint(sessionID, m.ChatJID, m.MsgID), content[:8])
	return filepath.Join(recordingDir(), "message-spool", name)
}
func spoolArchiveMessage(sessionID string, m storedMessage) error {
	data, err := json.Marshal(archiveSpool{SessionID: sessionID, Message: m, ReceivedAt: m.ReceivedAt})
	if err != nil {
		return err
	}
	if len(data) > 4*1024*1024 {
		return errors.New("message spool limit exceeded")
	}
	path := archiveSpoolPath(sessionID, m)
	dir := filepath.Dir(path)
	if err = os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".pending-")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err = f.Chmod(0600); err == nil {
		_, err = f.Write(data)
	}
	if err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	if err = os.Rename(name, path); err != nil {
		return err
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (m *SessionManager) replayArchiveSpool(ctx context.Context) {
	dir := filepath.Join(recordingDir(), "message-spool")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	count := 0
	for _, entry := range entries {
		if count >= 100 || ctx.Err() != nil {
			return
		}
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		info, err := entry.Info()
		if err != nil || info.Size() > 4*1024*1024 || info.Mode()&os.ModeSymlink != 0 {
			continue
		}
		count++
		path := filepath.Join(dir, entry.Name())
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		var item archiveSpool
		if json.Unmarshal(data, &item) != nil || item.SessionID == "" || item.Message.MsgID == "" {
			continue
		}
		item.Message.ReceivedAt = item.ReceivedAt
		if err = m.store.saveMessage(ctx, item.SessionID, item.Message); err != nil {
			m.log.Warn("message spool replay deferred", "err", err)
			return
		}
		if err = os.Remove(path); err != nil {
			m.log.Warn("message spool cleanup failed", "err", err)
		}
	}
}

func (m *SessionManager) runConversationArchive(ctx context.Context) {
	ticker := time.NewTicker(10 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.replayArchiveSpool(ctx)
			m.drainArchiveMedia(ctx)
			m.drainSessionWebhooks(ctx)
			if err := m.store.purgeArchive(ctx, time.Now().UTC()); err != nil {
				m.log.Error("archive retention deferred", "err", err)
			}
		}
	}
}

func (m *SessionManager) drainArchiveMedia(ctx context.Context) {
	for n := 0; n < 4; n++ {
		token := newSessionID()
		var id, sessionID, raw string
		err := m.store.db.QueryRowContext(ctx, `WITH candidate AS (
 SELECT a.id FROM conversation_archive_media a JOIN conversation_archive c ON c.id=a.conversation_id
 WHERE a.status='pending' AND a.next_at<=now() AND (a.lease_until IS NULL OR a.lease_until<now()) AND c.originals_purged=false
 ORDER BY a.created_at FOR UPDATE OF a SKIP LOCKED LIMIT 1)
 UPDATE conversation_archive_media a SET lease_token=$1,lease_until=now()+interval '2 minutes'
 FROM candidate k,conversation_archive c WHERE a.id=k.id AND c.id=a.conversation_id
 RETURNING a.id,c.session_id,a.raw::text`, token).Scan(&id, &sessionID, &raw)
		if errors.Is(err, sql.ErrNoRows) {
			return
		}
		if err != nil {
			m.log.Error("archive audio claim failed", "err", err)
			return
		}
		sess, ok := m.Get(sessionID)
		if !ok || sess.client == nil {
			_, _ = m.store.db.ExecContext(ctx, `UPDATE conversation_archive_media SET lease_until=NULL,lease_token='',next_at=now()+interval '1 minute' WHERE id=$1 AND lease_token=$2`, id, token)
			continue
		}
		var msg waE2E.Message
		if err = protojson.Unmarshal([]byte(raw), &msg); err == nil {
			inner, viewOnce := unwrapViewOnce(&msg)
			// Respect disappearing/view-once semantics; do not turn this archive into
			// a bypass for a sender's single-view audio.
			if viewOnce {
				_, _ = m.store.db.ExecContext(ctx, `UPDATE conversation_archive_media SET status='unavailable',raw=NULL,lease_until=NULL,lease_token='' WHERE id=$1 AND lease_token=$2`, id, token)
				continue
			}
			audio := inner.GetAudioMessage()
			if audio == nil || audio.GetFileLength() > archiveVoiceMaxBytes {
				err = errors.New("unsupported audio size")
			} else {
				downloadCtx, cancel := context.WithTimeout(ctx, 30*time.Second)
				data, downloadErr := sess.client.Download(downloadCtx, audio)
				cancel()
				err = downloadErr
				if err == nil && len(data) > 0 && len(data) <= archiveVoiceMaxBytes {
					mime := audio.GetMimetype()
					if !strings.HasPrefix(mime, "audio/") {
						mime = "audio/ogg"
					}
					_, err = m.store.db.ExecContext(ctx, `UPDATE conversation_archive_media SET data=$3,mime=$4,seconds=$5,status='ready',raw=NULL,lease_until=NULL,lease_token='' WHERE id=$1 AND lease_token=$2 AND status='pending'`, id, token, data, mime, audio.GetSeconds())
					if err == nil {
						continue
					}
				} else if err == nil {
					err = errors.New("empty or oversized audio")
				}
			}
		}
		_, _ = m.store.db.ExecContext(ctx, `UPDATE conversation_archive_media SET attempts=attempts+1,status=CASE WHEN attempts>=9 THEN 'unavailable' ELSE 'pending' END,lease_until=NULL,lease_token='',next_at=now()+interval '5 minutes' WHERE id=$1 AND lease_token=$2`, id, token)
		m.log.Warn("archive voice download deferred", "media_id", id)
	}
}

func (s *sessionStore) archiveCallRecording(ctx context.Context, sessionID, peer, callID, path string, seconds int) error {
	p, err := s.archivePolicy(ctx)
	if err != nil || !p.Enabled || !p.NoticeAccepted {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > archiveCallMaxBytes || info.Size() == 0 {
		return errors.New("invalid call recording file")
	}
	if filepath.Clean(filepath.Dir(path)) != filepath.Clean(recordingDir()) || !safeRecordingID(filepath.Base(path)) {
		return errors.New("invalid recording path")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	id, err := archiveEnsureConversation(ctx, tx, sessionID, peer)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO conversation_archive_media(id,conversation_id,message_id,kind,mime,status,seconds,data,local_file,content_description) VALUES($1,$2,$3,'call','audio/mpeg','ready',$4,$5,$6,'peer_original_plus_sent_audio_mix') ON CONFLICT(conversation_id,message_id,kind) DO NOTHING`, newSessionID(), id, callID, seconds, data, filepath.Base(path))
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *sessionStore) purgeArchive(ctx context.Context, now time.Time) error {
	p, err := s.archivePolicy(ctx)
	if err != nil || !p.RetentionEnabled {
		return err
	}
	candidates, err := s.db.QueryContext(ctx, `SELECT id,order_number,session_id,chat_jid FROM conversation_archive WHERE closed_at IS NOT NULL AND hold_reason='' AND ((originals_purged=false AND closed_at<$1) OR closed_at<$2) ORDER BY closed_at LIMIT 100`, now.Add(-time.Duration(p.OriginalHours)*time.Hour), now.Add(-time.Duration(p.SummaryDays)*24*time.Hour))
	if err != nil {
		return err
	}
	type candidate struct{ id, order, session, chat string }
	pending := []candidate{}
	for candidates.Next() {
		var v candidate
		if err = candidates.Scan(&v.id, &v.order, &v.session, &v.chat); err != nil {
			break
		}
		pending = append(pending, v)
	}
	if err == nil {
		err = candidates.Err()
	}
	candidates.Close()
	if err != nil {
		return err
	}
	for _, candidate := range pending {
		tx, err := s.db.BeginTx(ctx, nil)
		if err != nil {
			return err
		}
		// Complaints/cancellation mutate the order row. Lock it before the
		// archive row; a concurrent order link is rechecked below.
		disputed, err := archiveOrderDisputed(ctx, tx, candidate.order)
		if err != nil {
			tx.Rollback()
			return err
		}
		if disputed {
			tx.Rollback()
			continue
		}
		if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,902713))`, candidate.session+"\x1f"+candidate.chat); err != nil {
			tx.Rollback()
			return err
		}
		c, err := scanArchiveConversation(tx.QueryRowContext(ctx, `SELECT `+archiveConversationColumns+` FROM conversation_archive WHERE id=$1 FOR UPDATE`, candidate.id))
		if errors.Is(err, sql.ErrNoRows) {
			tx.Rollback()
			continue
		}
		if err != nil {
			tx.Rollback()
			return err
		}
		if c.OrderNumber != candidate.order || c.HoldReason != "" || c.ClosedAt == nil || !c.ClosedAt.Before(now.Add(-time.Duration(p.OriginalHours)*time.Hour)) {
			tx.Rollback()
			continue
		}
		// Unknown delivery/AI workers hold these row leases. Do not erase while
		// one is in flight, and do not let a late worker restore expired bytes.
		var active bool
		err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_archive_media WHERE conversation_id=$1 AND lease_until>now()) OR EXISTS(SELECT 1 FROM conversation_archive WHERE id=$1 AND ai_lease_until>now())`, c.ID).Scan(&active)
		if err != nil {
			tx.Rollback()
			return err
		}
		if active {
			tx.Rollback()
			continue
		}
		if c.OriginalsPurged {
			if c.ClosedAt.Before(now.Add(-time.Duration(p.SummaryDays) * 24 * time.Hour)) {
				_, err = tx.ExecContext(ctx, `UPDATE conversation_archive_audit SET detail='{}' WHERE conversation_id=$1`, c.ID)
				if err == nil {
					_, err = tx.ExecContext(ctx, `DELETE FROM conversation_archive WHERE id=$1`, c.ID)
				}
				if err == nil {
					err = tx.Commit()
				}
			} else {
				tx.Rollback()
			}
			if err != nil {
				return err
			}
			continue
		}
		rows, err := tx.QueryContext(ctx, `SELECT session_id,chat_jid,msg_id FROM messages WHERE archive_id=$1`, c.ID)
		if err != nil {
			tx.Rollback()
			return err
		}
		fingerprints := []string{}
		for rows.Next() {
			var session, chat, id string
			if err = rows.Scan(&session, &chat, &id); err != nil {
				break
			}
			fingerprints = append(fingerprints, archiveFingerprint(session, chat, id))
		}
		rowErr := rows.Err()
		rows.Close()
		if err != nil || rowErr != nil {
			tx.Rollback()
			return fmt.Errorf("archive fingerprint read failed")
		}
		for _, fingerprint := range fingerprints {
			if _, err = tx.ExecContext(ctx, `INSERT INTO conversation_archive_tombstones(fingerprint) VALUES($1) ON CONFLICT DO NOTHING`, fingerprint); err != nil {
				break
			}
		}
		if err != nil {
			tx.Rollback()
			return err
		}
		files, err := tx.QueryContext(ctx, `SELECT local_file FROM conversation_archive_media WHERE conversation_id=$1 AND local_file<>''`, c.ID)
		if err != nil {
			tx.Rollback()
			return err
		}
		paths := []string{}
		for files.Next() {
			var name string
			if err = files.Scan(&name); err != nil {
				break
			}
			paths = append(paths, name)
		}
		files.Close()
		if err != nil {
			tx.Rollback()
			return err
		}
		for _, name := range paths {
			if !safeRecordingID(name) {
				tx.Rollback()
				return errors.New("unsafe archived recording path")
			}
			if err = os.Remove(filepath.Join(recordingDir(), name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				tx.Rollback()
				return err
			}
		}
		for _, query := range []string{
			`DELETE FROM chatwoot_outbox WHERE session_id=(SELECT session_id FROM conversation_archive WHERE id=$1) AND source_id IN(SELECT msg_id FROM messages WHERE archive_id=$1)`,
			`DELETE FROM session_webhook_outbox WHERE session_id=(SELECT session_id FROM conversation_archive WHERE id=$1) AND payload#>>'{data,id}' IN(SELECT msg_id FROM messages WHERE archive_id=$1)`,
			`DELETE FROM messages WHERE archive_id=$1`,
			`UPDATE conversation_archive_media SET data=NULL,raw=NULL,local_file='',status='expired',lease_token='',lease_until=NULL WHERE conversation_id=$1`,
			`UPDATE conversation_archive SET originals_purged=true,version=version+1 WHERE id=$1`,
			`INSERT INTO conversation_archive_audit(conversation_id,action,actor) VALUES($1,'originals_expired','retention_worker')`,
		} {
			if _, err = tx.ExecContext(ctx, query, c.ID); err != nil {
				break
			}
		}
		if err != nil {
			tx.Rollback()
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func archiveOrderDisputed(ctx context.Context, tx *sql.Tx, number string) (bool, error) {
	if number == "" {
		return false, nil
	}
	var document []byte
	err := tx.QueryRowContext(ctx, `SELECT document FROM restaurant_orders WHERE number=$1 FOR SHARE`, number).Scan(&document)
	if errors.Is(err, sql.ErrNoRows) {
		return true, nil
	}
	if err != nil {
		return false, err
	}
	var order struct {
		Complaints []struct {
			Status string `json:"status"`
		} `json:"complaints"`
		Cancellation struct {
			Status string `json:"status"`
		} `json:"cancellation"`
	}
	if err = json.Unmarshal(document, &order); err != nil {
		return false, err
	}
	for _, complaint := range order.Complaints {
		if complaint.Status == "open" {
			return true, nil
		}
	}
	return order.Cancellation.Status == "requested", nil
}
