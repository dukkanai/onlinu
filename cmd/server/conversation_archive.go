package main

// The archive is intentionally opt-in. Migration never imports or erases old
// conversations. Retention operates only on explicitly archived episodes, after
// an operator closes them. A legal hold remains effective until explicitly
// released; its date is a review deadline, not permission to destroy evidence.
import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

type archivePolicy struct {
	Version          int64  `json:"version"`
	Enabled          bool   `json:"enabled"`
	RetentionEnabled bool   `json:"retentionEnabled"`
	OriginalHours    int    `json:"originalHours"`
	SummaryDays      int    `json:"summaryDays"`
	NoticeAccepted   bool   `json:"noticeAccepted"`
	AIEnabled        bool   `json:"aiEnabled"`
	AIModel          string `json:"aiModel"`
}

type archiveConversation struct {
	ID              string     `json:"id"`
	SessionID       string     `json:"sessionId"`
	ChatJID         string     `json:"chat"`
	CreatedAt       time.Time  `json:"createdAt"`
	UpdatedAt       time.Time  `json:"updatedAt"`
	ClosedAt        *time.Time `json:"closedAt"`
	OrderNumber     string     `json:"orderNumber"`
	Version         int64      `json:"version"`
	Summary         string     `json:"summary"`
	SummarySource   string     `json:"summarySource"`
	HoldReason      string     `json:"holdReason"`
	HoldUntil       *time.Time `json:"holdUntil"`
	OriginalsPurged bool       `json:"originalsPurged"`
}

type archiveMedia struct {
	ID                 string    `json:"id"`
	MessageID          string    `json:"messageId"`
	Kind               string    `json:"kind"`
	MIME               string    `json:"mime"`
	Status             string    `json:"status"`
	Seconds            int       `json:"seconds"`
	Bytes              int64     `json:"bytes"`
	CreatedAt          time.Time `json:"createdAt"`
	ContentDescription string    `json:"contentDescription"`
}

type archiveAudit struct {
	Action    string          `json:"action"`
	CreatedAt time.Time       `json:"createdAt"`
	Actor     string          `json:"actor"`
	Detail    json.RawMessage `json:"detail"`
}

func initConversationArchive(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
CREATE TABLE IF NOT EXISTS conversation_archive_policy (
 id integer PRIMARY KEY CHECK(id=1), version bigint NOT NULL DEFAULT 1,
 enabled boolean NOT NULL DEFAULT false, retention_enabled boolean NOT NULL DEFAULT false,
 original_hours integer NOT NULL DEFAULT 24, summary_days integer NOT NULL DEFAULT 90,
 notice_accepted boolean NOT NULL DEFAULT false, ai_enabled boolean NOT NULL DEFAULT false,
 ai_model text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now());
INSERT INTO conversation_archive_policy(id) VALUES(1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS conversation_archive (
 id text PRIMARY KEY, session_id text NOT NULL, chat_jid text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
 closed_at timestamptz, order_number text NOT NULL DEFAULT '', version bigint NOT NULL DEFAULT 1,
 summary text NOT NULL DEFAULT '', summary_source text NOT NULL DEFAULT '',
 hold_reason text NOT NULL DEFAULT '', hold_until timestamptz, originals_purged boolean NOT NULL DEFAULT false);
CREATE UNIQUE INDEX IF NOT EXISTS conversation_archive_active ON conversation_archive(session_id,chat_jid) WHERE closed_at IS NULL;
ALTER TABLE conversation_archive ADD COLUMN IF NOT EXISTS ai_lease_until timestamptz;
ALTER TABLE conversation_archive ADD COLUMN IF NOT EXISTS ai_lease_token text NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS archive_id text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS received_ns bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS messages_archive_id ON messages(archive_id);
CREATE TABLE IF NOT EXISTS conversation_archive_media (
 id text PRIMARY KEY, conversation_id text NOT NULL REFERENCES conversation_archive(id) ON DELETE CASCADE,
 message_id text NOT NULL, kind text NOT NULL, mime text NOT NULL DEFAULT 'audio/ogg',
 status text NOT NULL DEFAULT 'pending', seconds integer NOT NULL DEFAULT 0,
 data bytea, raw jsonb, local_file text NOT NULL DEFAULT '', content_description text NOT NULL DEFAULT '',
 attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(conversation_id,message_id,kind));
CREATE INDEX IF NOT EXISTS conversation_archive_media_due ON conversation_archive_media(status,next_at);
CREATE TABLE IF NOT EXISTS conversation_archive_audit (
 id bigserial PRIMARY KEY, conversation_id text NOT NULL DEFAULT '', action text NOT NULL,
 actor text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE conversation_archive_audit ADD COLUMN IF NOT EXISTS detail jsonb NOT NULL DEFAULT '{}';
CREATE TABLE IF NOT EXISTS conversation_archive_tombstones (fingerprint text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS session_webhook_outbox (
 id text PRIMARY KEY, session_id text NOT NULL, target text NOT NULL, event text NOT NULL,
 payload jsonb NOT NULL, attempts integer NOT NULL DEFAULT 0, next_at timestamptz NOT NULL DEFAULT now(),
 lease_until timestamptz, lease_token text NOT NULL DEFAULT '', dead boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE session_webhook_outbox ADD COLUMN IF NOT EXISTS chat_key text NOT NULL DEFAULT '';
ALTER TABLE chatwoot_outbox ADD COLUMN IF NOT EXISTS lease_until bigint NOT NULL DEFAULT 0;
ALTER TABLE chatwoot_outbox ADD COLUMN IF NOT EXISTS lease_token text NOT NULL DEFAULT '';
ALTER TABLE chatwoot_outbox ADD COLUMN IF NOT EXISTS delivered boolean NOT NULL DEFAULT false;
`)
	return err
}

func (s *sessionStore) archivePolicy(ctx context.Context) (archivePolicy, error) {
	var p archivePolicy
	err := s.db.QueryRowContext(ctx, `SELECT version,enabled,retention_enabled,original_hours,summary_days,notice_accepted,ai_enabled,ai_model FROM conversation_archive_policy WHERE id=1`).Scan(&p.Version, &p.Enabled, &p.RetentionEnabled, &p.OriginalHours, &p.SummaryDays, &p.NoticeAccepted, &p.AIEnabled, &p.AIModel)
	return p, err
}

func validateArchivePolicy(p archivePolicy) error {
	if p.Version < 1 || p.OriginalHours < 1 || p.OriginalHours > 24*90 || p.SummaryDays < 1 || p.SummaryDays > 3650 || p.SummaryDays*24 < p.OriginalHours || len(p.AIModel) > 100 || strings.ContainsAny(p.AIModel, "\r\n\t ") {
		return restaurantFail(400, "archive_invalid_policy")
	}
	if (p.Enabled || p.RetentionEnabled || p.AIEnabled) && !p.NoticeAccepted {
		return restaurantFail(400, "archive_notice_required")
	}
	if p.AIEnabled && p.AIModel == "" {
		return restaurantFail(400, "archive_model_required")
	}
	return nil
}

func (s *sessionStore) saveArchivePolicy(ctx context.Context, p archivePolicy, actor string) (archivePolicy, error) {
	p.AIModel = strings.TrimSpace(p.AIModel)
	if err := validateArchivePolicy(p); err != nil {
		return p, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return p, err
	}
	defer tx.Rollback()
	res, err := tx.ExecContext(ctx, `UPDATE conversation_archive_policy SET version=version+1,enabled=$1,retention_enabled=$2,original_hours=$3,summary_days=$4,notice_accepted=$5,ai_enabled=$6,ai_model=$7,updated_at=now() WHERE id=1 AND version=$8`, p.Enabled, p.RetentionEnabled, p.OriginalHours, p.SummaryDays, p.NoticeAccepted, p.AIEnabled, p.AIModel, p.Version)
	if err != nil {
		return p, err
	}
	n, _ := res.RowsAffected()
	if n != 1 {
		return p, restaurantFail(409, "version_conflict")
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO conversation_archive_audit(action,actor) VALUES('policy_updated',$1)`, actor); err != nil {
		return p, err
	}
	if err = tx.Commit(); err != nil {
		return p, err
	}
	p.Version++
	return p, nil
}

const archiveConversationColumns = `id,session_id,chat_jid,created_at,updated_at,closed_at,order_number,version,summary,summary_source,hold_reason,hold_until,originals_purged`

type archiveScanner interface{ Scan(...any) error }

func scanArchiveConversation(row archiveScanner) (archiveConversation, error) {
	var c archiveConversation
	err := row.Scan(&c.ID, &c.SessionID, &c.ChatJID, &c.CreatedAt, &c.UpdatedAt, &c.ClosedAt, &c.OrderNumber, &c.Version, &c.Summary, &c.SummarySource, &c.HoldReason, &c.HoldUntil, &c.OriginalsPurged)
	return c, err
}

func archiveEnsureConversation(ctx context.Context, tx *sql.Tx, sessionID, chat string) (string, error) {
	// Serialize episode creation, close, and incoming traffic for this chat.
	if _, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1,902713))`, sessionID+"\x1f"+chat); err != nil {
		return "", err
	}
	var id string
	err := tx.QueryRowContext(ctx, `SELECT id FROM conversation_archive WHERE session_id=$1 AND chat_jid=$2 AND closed_at IS NULL FOR UPDATE`, sessionID, chat).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		id = uuid.NewString()
		_, err = tx.ExecContext(ctx, `INSERT INTO conversation_archive(id,session_id,chat_jid) VALUES($1,$2,$3)`, id, sessionID, chat)
	}
	if err == nil {
		_, err = tx.ExecContext(ctx, `UPDATE conversation_archive SET updated_at=now(),version=version+1 WHERE id=$1`, id)
	}
	return id, err
}

func archiveFingerprint(sessionID, chat, id string) string {
	sum := sha256.Sum256([]byte(sessionID + "\x00" + chat + "\x00" + id))
	return hex.EncodeToString(sum[:])
}

func (s *sessionStore) listArchive(ctx context.Context) ([]archiveConversation, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+archiveConversationColumns+` FROM conversation_archive ORDER BY updated_at DESC LIMIT 200`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []archiveConversation{}
	for rows.Next() {
		v, err := scanArchiveConversation(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func (s *sessionStore) getArchive(ctx context.Context, id string) (archiveConversation, error) {
	c, err := scanArchiveConversation(s.db.QueryRowContext(ctx, `SELECT `+archiveConversationColumns+` FROM conversation_archive WHERE id=$1`, id))
	if errors.Is(err, sql.ErrNoRows) {
		err = restaurantFail(404, "not_found")
	}
	return c, err
}

type archiveChange struct {
	Version     int64      `json:"version"`
	Action      string     `json:"action"`
	Summary     string     `json:"summary"`
	OrderNumber string     `json:"orderNumber"`
	Verified    bool       `json:"verified"`
	Reason      string     `json:"reason"`
	Until       *time.Time `json:"until"`
}

func (s *sessionStore) changeArchive(ctx context.Context, id string, in archiveChange, actor string) (archiveConversation, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return archiveConversation{}, err
	}
	defer tx.Rollback()
	// Order first, conversation second: the same order used by complaint-aware
	// retention. A verified link cannot race complaint creation and deletion.
	if in.Action == "link_order" {
		var number string
		if err = tx.QueryRowContext(ctx, `SELECT number FROM restaurant_orders WHERE number=$1 FOR SHARE`, in.OrderNumber).Scan(&number); errors.Is(err, sql.ErrNoRows) {
			return archiveConversation{}, restaurantFail(404, "order_not_found")
		} else if err != nil {
			return archiveConversation{}, err
		}
	}
	c, err := scanArchiveConversation(tx.QueryRowContext(ctx, `SELECT `+archiveConversationColumns+` FROM conversation_archive WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, sql.ErrNoRows) {
		return c, restaurantFail(404, "not_found")
	}
	if err != nil {
		return c, err
	}
	if c.Version != in.Version {
		return c, restaurantFail(409, "version_conflict")
	}
	switch in.Action {
	case "close":
		if c.ClosedAt == nil {
			now := time.Now().UTC()
			c.ClosedAt = &now
		}
		if c.Summary == "" {
			var count, media int
			err = tx.QueryRowContext(ctx, `SELECT count(*) FROM messages WHERE archive_id=$1`, id).Scan(&count)
			if err != nil {
				return c, err
			}
			err = tx.QueryRowContext(ctx, `SELECT count(*) FROM conversation_archive_media WHERE conversation_id=$1`, id).Scan(&media)
			if err != nil {
				return c, err
			}
			c.Summary = fmt.Sprintf("Messages: %d. Audio records: %d. Content has not been summarized or transcribed.", count, media)
			c.SummarySource = "metadata_only"
		}
	case "summary":
		in.Summary = strings.TrimSpace(in.Summary)
		if in.Summary == "" || len(in.Summary) > 16000 {
			return c, restaurantFail(400, "invalid_request")
		}
		c.Summary = in.Summary
		c.SummarySource = "manual"
	case "link_order":
		if !in.Verified || in.OrderNumber == "" || len(in.OrderNumber) > 80 {
			return c, restaurantFail(400, "archive_verification_required")
		}
		var exists bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM restaurant_orders WHERE number=$1)`, in.OrderNumber).Scan(&exists); err != nil {
			return c, err
		}
		if !exists {
			return c, restaurantFail(404, "order_not_found")
		}
		c.OrderNumber = in.OrderNumber
	case "hold":
		in.Reason = strings.TrimSpace(in.Reason)
		if in.Reason == "" || len(in.Reason) > 1000 || in.Until == nil || !in.Until.After(time.Now()) || in.Until.After(time.Now().AddDate(10, 0, 0)) {
			return c, restaurantFail(400, "archive_hold_invalid")
		}
		if c.OriginalsPurged {
			return c, restaurantFail(409, "archive_originals_expired")
		}
		c.HoldReason = in.Reason
		c.HoldUntil = in.Until
	case "release_hold":
		if !in.Verified || strings.TrimSpace(in.Reason) == "" || len(in.Reason) > 1000 {
			return c, restaurantFail(400, "archive_verification_required")
		}
		c.HoldReason = ""
		c.HoldUntil = nil
	default:
		return c, restaurantFail(400, "invalid_request")
	}
	_, err = tx.ExecContext(ctx, `UPDATE conversation_archive SET closed_at=$2,summary=$3,summary_source=$4,order_number=$5,hold_reason=$6,hold_until=$7,version=version+1,updated_at=now() WHERE id=$1`, id, c.ClosedAt, c.Summary, c.SummarySource, c.OrderNumber, c.HoldReason, c.HoldUntil)
	if err != nil {
		return c, err
	}
	detail := map[string]any{}
	if in.Action == "hold" || in.Action == "release_hold" {
		detail = map[string]any{"reason": in.Reason, "until": in.Until, "verified": in.Verified}
	}
	if in.Action == "link_order" {
		detail = map[string]any{"orderNumber": in.OrderNumber, "verified": in.Verified}
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO conversation_archive_audit(conversation_id,action,actor,detail) VALUES($1,$2,$3,$4)`, id, in.Action, actor, archiveJSON(detail)); err != nil {
		return c, err
	}
	if err = tx.Commit(); err != nil {
		return c, err
	}
	return s.getArchive(ctx, id)
}

// holdArchiveForOrder is safe to call after a complaint is committed. Root's
// complaint workflow can call it; future manual links also need review.
func (s *sessionStore) holdArchiveForOrder(ctx context.Context, number, reason string) error {
	if strings.TrimSpace(reason) == "" {
		return restaurantFail(400, "archive_hold_invalid")
	}
	_, err := s.db.ExecContext(ctx, `UPDATE conversation_archive SET hold_reason=$2,hold_until=now()+interval '30 days',version=version+1 WHERE order_number=$1 AND originals_purged=false`, number, "Open complaint: "+reason)
	return err
}

func (s *sessionStore) archiveAudit(ctx context.Context, id, action, actor string) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO conversation_archive_audit(conversation_id,action,actor) VALUES($1,$2,$3)`, id, action, actor)
	return err
}

func archiveJSON(v any) []byte { data, _ := json.Marshal(v); return data }
