package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/encoding/protojson"
)

// storeMessageEvent persiste uma mensagem recebida (evento do whatsmeow) no
// histórico. Persist before downstream delivery; no fire-and-forget goroutine.
func (s *Session) storeMessageEvent(evt *events.Message) {
	if s.mgr.store == nil {
		return
	}
	m := storedMessage{
		ChatJID:   evt.Info.Chat.String(),
		SenderJID: evt.Info.Sender.String(),
		MsgID:     evt.Info.ID,
		FromMe:    evt.Info.IsFromMe,
		Timestamp: evt.Info.Timestamp.UnixMilli(),
		Type:      messageType(evt.Message),
		Body:      messageText(evt.Message),
	}
	if raw, err := protojson.Marshal(evt.Message); err == nil {
		m.Raw = json.RawMessage(raw)
	}
	s.persistMessageReliably(m)
}

// recordOutgoing persiste uma mensagem que ESTE cliente enviou. Só grava
// conteúdo de fato (texto/mídia/etc.); ações como reação, edição e revogação
// caem em type "unknown" e são ignoradas para não poluir o histórico.
func (s *Session) recordOutgoing(chat types.JID, msgID string, ts int64, msg *waE2E.Message) {
	// registra como "enviada por nós pela API" — o espelhamento no Chatwoot usa a
	// origem para decidir se reflete (toggle mirror_api) ou ignora
	s.markSelfSent(msgID, selfSentAPI)
	if s.mgr.store == nil {
		return
	}
	typ := messageType(msg)
	if typ == "unknown" {
		return
	}
	sender := chat
	if id := s.client.Store.ID; id != nil {
		sender = id.ToNonAD()
	}
	m := storedMessage{
		ChatJID:   chat.String(),
		SenderJID: sender.String(),
		MsgID:     msgID,
		FromMe:    true,
		Timestamp: ts,
		Type:      typ,
		Body:      messageText(msg),
	}
	if raw, err := protojson.Marshal(msg); err == nil {
		m.Raw = json.RawMessage(raw)
	}
	s.persistMessageReliably(m)
}

// Bounded synchronous retries expose DB failure instead of silently ignoring
// it. A private fsynced spool is replayed after restart if Postgres is offline.
func (s *Session) persistMessageReliably(m storedMessage) {
	ctx := s.mgr.appCtx
	if m.ReceivedAt == 0 {
		m.ReceivedAt = time.Now().UnixNano()
	}
	// Commit a private local fallback before attempting PostgreSQL. When either
	// storage succeeds, a process restart cannot silently discard the message.
	spoolErr := spoolArchiveMessage(s.id, m)
	for attempt := 0; attempt < 3; attempt++ {
		callCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
		err := s.mgr.store.saveMessage(callCtx, s.id, m)
		cancel()
		if err == nil {
			if spoolErr == nil {
				_ = os.Remove(archiveSpoolPath(s.id, m))
			}
			return
		}
		if ctx.Err() != nil {
			break
		}
	}
	if spoolErr != nil {
		s.log.Error("message persistence and durable spool failed; operator action required", "message_id", m.MsgID, "err", spoolErr)
	} else {
		s.log.Warn("message queued on private durable spool while database unavailable", "message_id", m.MsgID)
	}
}

// storedMessage é uma linha da tabela messages.
type storedMessage struct {
	ChatJID    string          `json:"chat"`
	SenderJID  string          `json:"sender"`
	MsgID      string          `json:"id"`
	FromMe     bool            `json:"fromMe"`
	Timestamp  int64           `json:"timestamp"`
	Type       string          `json:"type"`
	Body       string          `json:"body"`
	Raw        json.RawMessage `json:"raw,omitempty"`
	ReceivedAt int64           `json:"-"`
}

// MarshalJSON acrescenta aliases no estilo WAHA (from/chatId) sem remover os
// campos originais (id/body/timestamp/fromMe já coincidem com a WAHA).
func (m storedMessage) MarshalJSON() ([]byte, error) {
	type alias storedMessage
	return json.Marshal(struct {
		alias
		From   string `json:"from"`
		ChatID string `json:"chatId"`
	}{alias(m), waChatIDStr(m.SenderJID), waChatIDStr(m.ChatJID)})
}

// chatOverview resume uma conversa (última mensagem + contagem).
type chatOverview struct {
	ChatJID    string `json:"chat"`
	LastBody   string `json:"lastMessage"`
	LastType   string `json:"lastType"`
	LastTS     int64  `json:"timestamp"`
	Count      int    `json:"count"`
	LastFromMe bool   `json:"lastFromMe"`
}

// MarshalJSON acrescenta o alias id (chatId estilo WAHA).
func (o chatOverview) MarshalJSON() ([]byte, error) {
	type alias chatOverview
	return json.Marshal(struct {
		alias
		ID string `json:"id"`
	}{alias(o), waChatIDStr(o.ChatJID)})
}

// saveMessage persiste (ou atualiza) uma mensagem. Idempotente por (session, chat, msg_id).
func (s *sessionStore) saveMessage(ctx context.Context, sessionID string, m storedMessage) error {
	if m.ReceivedAt == 0 {
		m.ReceivedAt = time.Now().UnixNano()
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,902713))`, sessionID+"\x1f"+m.ChatJID); err != nil {
		return err
	}
	var expired bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM conversation_archive_tombstones WHERE fingerprint=$1)`, archiveFingerprint(sessionID, m.ChatJID, m.MsgID)).Scan(&expired); err != nil {
		return err
	}
	if expired {
		return tx.Commit()
	}
	var capture bool
	if err = tx.QueryRowContext(ctx, `SELECT enabled AND notice_accepted AND to_timestamp($1::double precision/1000)>=updated_at-interval '1 minute' FROM conversation_archive_policy WHERE id=1`, m.Timestamp).Scan(&capture); err != nil {
		return err
	}
	var archiveID any
	if capture {
		var old sql.NullString
		err = tx.QueryRowContext(ctx, `SELECT archive_id FROM messages WHERE session_id=$1 AND chat_jid=$2 AND msg_id=$3`, sessionID, m.ChatJID, m.MsgID).Scan(&old)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if old.Valid {
			var purged bool
			if err = tx.QueryRowContext(ctx, `SELECT originals_purged FROM conversation_archive WHERE id=$1 FOR UPDATE`, old.String).Scan(&purged); err != nil {
				return err
			}
			if purged {
				return tx.Commit()
			}
			archiveID = old.String
		} else {
			id, ensureErr := archiveEnsureConversation(ctx, tx, sessionID, m.ChatJID)
			if ensureErr != nil {
				return ensureErr
			}
			archiveID = id
		}
	}
	var raw any
	if len(m.Raw) > 0 {
		raw = []byte(m.Raw)
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO messages (session_id, chat_jid, sender_jid, msg_id, from_me, ts, type, body, raw, archive_id,received_ns)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,$11)
		ON CONFLICT (session_id, chat_jid, msg_id) DO UPDATE
			SET body = EXCLUDED.body, type = EXCLUDED.type, raw = EXCLUDED.raw,ts=EXCLUDED.ts,received_ns=EXCLUDED.received_ns,
			archive_id=COALESCE(messages.archive_id,EXCLUDED.archive_id)
			WHERE EXCLUDED.ts>messages.ts OR (EXCLUDED.ts=messages.ts AND EXCLUDED.received_ns>=messages.received_ns)`,
		sessionID, m.ChatJID, m.SenderJID, m.MsgID, m.FromMe, m.Timestamp, m.Type, m.Body, raw, archiveID, m.ReceivedAt)
	if err != nil {
		return err
	}
	if archiveID != nil {
		if _, err = tx.ExecContext(ctx, `UPDATE conversation_archive SET version=version+1,updated_at=now() WHERE id=$1`, archiveID); err != nil {
			return err
		}
	}
	if archiveID != nil && m.Type == "audio" && len(m.Raw) > 0 {
		_, err = tx.ExecContext(ctx, `INSERT INTO conversation_archive_media(id,conversation_id,message_id,kind,raw,content_description) VALUES($1,$2,$3,'voice',$4,'whatsapp_voice_original') ON CONFLICT(conversation_id,message_id,kind) DO NOTHING`, newSessionID(), archiveID, m.MsgID, raw)
		if err != nil {
			return err
		}
	}
	return tx.Commit()
}

// findMessage acha uma mensagem pelo ID (usada p/ reconstruir a enquete e votar).
func (s *sessionStore) findMessage(ctx context.Context, sessionID, msgID string) (chatJID, senderJID string, fromMe bool, raw json.RawMessage, err error) {
	var body []byte
	err = s.db.QueryRowContext(ctx,
		`SELECT chat_jid, sender_jid, from_me, raw FROM messages WHERE session_id = $1 AND msg_id = $2 LIMIT 1`,
		sessionID, msgID).Scan(&chatJID, &senderJID, &fromMe, &body)
	if err == nil && len(body) > 0 {
		raw = json.RawMessage(body)
	}
	return
}

// listMessages devolve as mensagens de um chat, mais recentes primeiro.
func (s *sessionStore) listMessages(ctx context.Context, sessionID, chatJID string, limit, offset int, withRaw bool) ([]storedMessage, error) {
	rawCol := "NULL"
	if withRaw {
		rawCol = "raw"
	}
	rows, err := s.db.QueryContext(ctx, `
		SELECT chat_jid, sender_jid, msg_id, from_me, ts, type, COALESCE(body, ''), `+rawCol+`
		FROM messages WHERE session_id = $1 AND chat_jid = $2
		ORDER BY ts DESC LIMIT $3 OFFSET $4`, sessionID, chatJID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMessages(rows)
}

func scanMessages(rows *sql.Rows) ([]storedMessage, error) {
	out := []storedMessage{}
	for rows.Next() {
		var m storedMessage
		var raw []byte
		if err := rows.Scan(&m.ChatJID, &m.SenderJID, &m.MsgID, &m.FromMe, &m.Timestamp, &m.Type, &m.Body, &raw); err != nil {
			return nil, err
		}
		if len(raw) > 0 {
			m.Raw = json.RawMessage(raw)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// listChats devolve uma visão geral das conversas (uma linha por chat_jid),
// ordenadas pela última mensagem.
func (s *sessionStore) listChats(ctx context.Context, sessionID string, limit, offset int) ([]chatOverview, error) {
	rows, err := s.db.QueryContext(ctx, `
		SELECT m.chat_jid, m.body, m.type, m.ts, m.from_me, c.cnt
		FROM messages m
		JOIN (
			SELECT chat_jid, MAX(ts) AS max_ts, COUNT(*) AS cnt
			FROM messages WHERE session_id = $1 GROUP BY chat_jid
		) c ON c.chat_jid = m.chat_jid AND c.max_ts = m.ts
		WHERE m.session_id = $1
		ORDER BY m.ts DESC LIMIT $2 OFFSET $3`, sessionID, limit, offset)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []chatOverview{}
	for rows.Next() {
		var o chatOverview
		var body sql.NullString
		if err := rows.Scan(&o.ChatJID, &body, &o.LastType, &o.LastTS, &o.LastFromMe, &o.Count); err != nil {
			return nil, err
		}
		o.LastBody = body.String
		out = append(out, o)
	}
	return out, rows.Err()
}
