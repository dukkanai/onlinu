package main

import (
	"context"
	"encoding/json"
	"time"
)

// Durable enqueue-first delivery with exclusive renewable-by-reclaim leases,
// per-chat FIFO, bounded retries and dead letters. A crash after a remote POST
// succeeds but before local acknowledgement can replay it. source_id enables
// receiver-side deduplication; this is not an exactly-once promise.
// Pending jobs contain message text and media metadata (not audio bytes).
// Delivered rows retain only dedupe IDs; their payloads are erased.

const (
	cwRetryBase   = 60 * time.Second // 1ª reentrega ~60s depois; dobra a cada tentativa
	cwRetryMax    = 30 * time.Minute // teto do backoff
	cwMaxAttempts = 18               // após isso vira "dead-letter" (fica logado, para de tentar)
	cwWorkerTick  = 2 * time.Second  // durable enqueue replaces network-first delivery
	cwBatchSize   = 50               // pendências processadas por varredura
)

func nowMillis() int64 { return time.Now().UnixMilli() }

// outboxBackoff devolve o atraso da próxima tentativa: 60s, 120s, 240s... até o
// teto de 30min.
func outboxBackoff(attempts int) time.Duration {
	d := cwRetryBase
	for i := 1; i < attempts; i++ {
		d *= 2
		if d >= cwRetryMax {
			return cwRetryMax
		}
	}
	return d
}

type outboxRow struct {
	ID         int64
	SessionID  string
	Payload    []byte
	Attempts   int
	LeaseToken string
}

// Idempotent insertion does not revive delivered or dead-letter jobs. A
// duplicate event must not reset a retry budget or overwrite an active lease.
func (s *sessionStore) enqueueOutbox(ctx context.Context, sessionID, sourceID string, payload []byte, nextAt, createdAt int64) error {
	_, err := s.db.ExecContext(ctx, `
		INSERT INTO chatwoot_outbox (session_id, source_id, payload, attempts, next_at, created_at, dead)
		VALUES ($1, $2, $3, 0, $4, $5, false)
		ON CONFLICT (session_id, source_id) DO NOTHING`,
		sessionID, sourceID, payload, nextAt, createdAt)
	return err
}

// dueOutbox devolve as pendências vencidas (não mortas) prontas para reentrega.
func (s *sessionStore) dueOutbox(ctx context.Context, now int64, limit int) ([]outboxRow, error) {
	// Claim only one row per chat and preserve enqueue order across retry delays.
	// A generous lease covers the existing bounded HTTP calls and media download.
	rows, err := s.db.QueryContext(ctx, `WITH candidates AS (
		SELECT q.id FROM chatwoot_outbox q
		WHERE q.dead=false AND q.delivered=false AND q.next_at <= $1 AND q.lease_until<$1
		AND NOT EXISTS(SELECT 1 FROM chatwoot_outbox p WHERE p.session_id=q.session_id AND p.payload->>'chatId'=q.payload->>'chatId' AND p.id<q.id AND p.dead=false AND p.delivered=false)
		ORDER BY q.id FOR UPDATE SKIP LOCKED LIMIT $2)
		UPDATE chatwoot_outbox q SET lease_token=$3,lease_until=$4 FROM candidates c WHERE q.id=c.id
		RETURNING q.id,q.session_id,q.payload,q.attempts,q.lease_token`, now, limit, newSessionID(), now+int64((10*time.Minute)/time.Millisecond))
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []outboxRow{}
	for rows.Next() {
		var r outboxRow
		if err := rows.Scan(&r.ID, &r.SessionID, &r.Payload, &r.Attempts, &r.LeaseToken); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// rescheduleOutbox atualiza a pendência para uma nova tentativa futura.
func (s *sessionStore) rescheduleOutbox(ctx context.Context, id int64, attempts int, nextAt int64, lastErr string, token string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE chatwoot_outbox SET attempts = $1, next_at = $2, last_error = $3,lease_until=0,lease_token='' WHERE id = $4 AND lease_token=$5`,
		attempts, nextAt, lastErr, id, token)
	return err
}

// killOutbox marca a pendência como dead-letter (esgotou as tentativas).
func (s *sessionStore) killOutbox(ctx context.Context, id int64, lastErr string, token string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE chatwoot_outbox SET dead = true, last_error = $1,lease_until=0,lease_token='' WHERE id = $2 AND lease_token=$3`, lastErr, id, token)
	return err
}

func (s *sessionStore) deleteOutbox(ctx context.Context, id int64, token string) error {
	// Keep only a dedupe tombstone, never delivered conversation content.
	_, err := s.db.ExecContext(ctx, `UPDATE chatwoot_outbox SET delivered=true,payload='{}',last_error=NULL,lease_until=0,lease_token='' WHERE id = $1 AND lease_token=$2`, id, token)
	return err
}

// deleteOutboxForSession limpa as pendências órfãs quando a sessão é removida (a
// fila vive no banco principal, então não some junto com o banco da sessão).
func (s *sessionStore) deleteOutboxForSession(ctx context.Context, sessionID string) error {
	_, err := s.db.ExecContext(ctx, `DELETE FROM chatwoot_outbox WHERE session_id = $1`, sessionID)
	return err
}

// runChatwootOutbox roda o worker de reentrega até o contexto encerrar.
func (m *SessionManager) runChatwootOutbox(ctx context.Context) {
	t := time.NewTicker(cwWorkerTick)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			m.drainChatwootOutbox(ctx)
		}
	}
}

func (m *SessionManager) drainChatwootOutbox(ctx context.Context) {
	if m.store == nil {
		return
	}
	for batch := 0; batch < cwBatchSize && ctx.Err() == nil; batch++ {
		rows, err := m.store.dueOutbox(ctx, nowMillis(), 1)
		if err != nil {
			m.log.Error("chatwoot outbox: consultar pendências falhou", "err", err)
			return
		}
		if len(rows) == 0 {
			return
		}
		for _, row := range rows {
			m.processOutboxRow(ctx, row)
		}
	}
}

func (m *SessionManager) processOutboxRow(ctx context.Context, row outboxRow) {
	sess, ok := m.Get(row.SessionID)
	if !ok {
		// sessão não está viva agora (reiniciando/reconectando): tenta de novo mais
		// tarde sem gastar tentativa, para não estourar o dead-letter à toa.
		_ = m.store.rescheduleOutbox(ctx, row.ID, row.Attempts,
			nowMillis()+cwRetryBase.Milliseconds(), "sessão offline", row.LeaseToken)
		return
	}
	cfg := sess.getChatwoot()
	if !cfg.valid() {
		_ = m.store.rescheduleOutbox(ctx, row.ID, row.Attempts,
			nowMillis()+cwRetryMax.Milliseconds(), "chatwoot não configurado", row.LeaseToken)
		return
	}
	var j cwJob
	if err := json.Unmarshal(row.Payload, &j); err != nil {
		m.log.Error("chatwoot outbox: payload inválido, descartando", "id", row.ID, "err", err)
		_ = m.store.killOutbox(ctx, row.ID, "invalid payload", row.LeaseToken)
		return
	}
	if err := sess.execChatwootJob(cfg, j); err != nil {
		attempts := row.Attempts + 1
		if attempts >= cwMaxAttempts {
			m.log.Error("chatwoot outbox: dead-letter após esgotar tentativas",
				"id", row.ID, "source", j.SourceID, "attempts", attempts, "err", err)
			_ = m.store.killOutbox(ctx, row.ID, "delivery failed", row.LeaseToken)
			return
		}
		delay := outboxBackoff(attempts)
		m.log.Warn("chatwoot outbox: reentrega falhou, reagendando",
			"id", row.ID, "source", j.SourceID, "attempt", attempts, "delay", delay.String(), "err", err)
		_ = m.store.rescheduleOutbox(ctx, row.ID, attempts,
			nowMillis()+delay.Milliseconds(), "delivery failed", row.LeaseToken)
		return
	}
	_ = m.store.deleteOutbox(ctx, row.ID, row.LeaseToken)
	m.log.Info("chatwoot outbox: reentrega concluída", "id", row.ID, "source", j.SourceID)
}

// enqueueChatwoot persists before the worker attempts any delivery.
func (s *Session) enqueueChatwoot(j cwJob) {
	if s.mgr == nil || s.mgr.store == nil {
		return
	}
	payload, err := json.Marshal(j)
	if err != nil {
		s.log.Error("chatwoot: serializar job da fila falhou", "err", err)
		return
	}
	now := nowMillis()
	if err := s.mgr.store.enqueueOutbox(s.mgr.appCtx, s.id, j.SourceID, payload,
		now, now); err != nil {
		s.log.Error("chatwoot: enfileirar reentrega falhou", "err", err)
	}
}
