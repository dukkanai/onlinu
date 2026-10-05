package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/encoding/protojson"
)

var webhookClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}

// dispatchWebhook envia um evento para a URL de webhook da sessão (se houver),
// via a durable at-least-once outbox. Receivers must deduplicate by delivery ID.
func (s *Session) dispatchWebhook(event string, data any) {
	url := s.getWebhook()
	if url == "" {
		return
	}
	id := newSessionID()
	chatKey := ""
	if fields, ok := data.(map[string]any); ok {
		if chat, ok := fields["chat"].(string); ok {
			chatKey = chat
		}
	}
	body, err := json.Marshal(map[string]any{
		"deliveryId": id,
		"session":    s.id,
		"event":      event,
		"timestamp":  time.Now().UnixMilli(),
		"data":       data,
	})
	if err != nil {
		return
	}
	if s.mgr == nil || s.mgr.store == nil {
		return
	}
	// Never log the target URL: it may include receiver credentials.
	if _, err = s.mgr.store.db.ExecContext(s.mgr.appCtx, `INSERT INTO session_webhook_outbox(id,session_id,target,event,payload,chat_key) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`, id, s.id, url, event, body, chatKey); err != nil {
		s.log.Error("webhook enqueue failed; delivery not guaranteed", "event", event, "err", err)
	}
}

func (m *SessionManager) drainSessionWebhooks(ctx context.Context) {
	for n := 0; n < 10; n++ {
		token := newSessionID()
		var id, target string
		var body []byte
		var attempts int
		err := m.store.db.QueryRowContext(ctx, `WITH candidate AS (
 SELECT q.id FROM session_webhook_outbox q WHERE NOT q.dead AND q.next_at<=now() AND (q.lease_until IS NULL OR q.lease_until<now())
 AND NOT EXISTS(SELECT 1 FROM session_webhook_outbox prior WHERE prior.session_id=q.session_id AND prior.chat_key=q.chat_key AND NOT prior.dead AND (prior.created_at,prior.id)<(q.created_at,q.id))
 ORDER BY q.created_at,q.id FOR UPDATE SKIP LOCKED LIMIT 1)
 UPDATE session_webhook_outbox q SET lease_token=$1,lease_until=now()+interval '1 minute' FROM candidate c WHERE q.id=c.id RETURNING q.id,q.target,q.payload,q.attempts`, token).Scan(&id, &target, &body, &attempts)
		if errors.Is(err, sql.ErrNoRows) {
			return
		}
		if err != nil {
			m.log.Error("webhook claim failed", "err", err)
			return
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodPost, target, bytes.NewReader(body))
		if err == nil {
			req.Header.Set("Content-Type", "application/json")
			req.Header.Set("X-Astra-Delivery-ID", id)
			req.Header.Set("Idempotency-Key", id)
			var response *http.Response
			response, err = webhookClient.Do(req)
			if err == nil {
				response.Body.Close()
				if response.StatusCode < 200 || response.StatusCode >= 300 {
					err = errors.New("webhook non-success status")
				}
			}
		}
		if err == nil {
			_, err = m.store.db.ExecContext(ctx, `DELETE FROM session_webhook_outbox WHERE id=$1 AND lease_token=$2`, id, token)
		} else {
			attempts++
			delay := outboxBackoff(attempts)
			_, err = m.store.db.ExecContext(ctx, `UPDATE session_webhook_outbox SET attempts=$3,next_at=$4,dead=$5,lease_until=NULL,lease_token='' WHERE id=$1 AND lease_token=$2`, id, token, attempts, time.Now().Add(delay), attempts >= cwMaxAttempts)
		}
		if err != nil {
			m.log.Error("webhook result persistence failed; receiver may see retry", "delivery_id", id)
		}
	}
}

// summarizeMessage extrai os campos úteis de uma mensagem recebida e inclui o
// payload bruto (protojson) para integrações que precisem de mais detalhes.
func summarizeMessage(evt *events.Message) map[string]any {
	info := evt.Info
	out := map[string]any{
		"id":        info.ID,
		"chat":      info.Chat.String(),
		"sender":    info.Sender.String(),
		"fromMe":    info.IsFromMe,
		"pushName":  info.PushName,
		"timestamp": info.Timestamp.UnixMilli(),
		"isGroup":   info.IsGroup,
		"type":      messageType(evt.Message),
		"text":      messageText(evt.Message),
	}
	if _, viewOnce := unwrapViewOnce(evt.Message); viewOnce {
		out["viewOnce"] = true
	}
	if raw, err := protojson.Marshal(evt.Message); err == nil {
		out["raw"] = json.RawMessage(raw)
	}
	return out
}

// unwrapViewOnce desembrulha mensagens de visualização única. No WhatsApp elas
// não chegam como ImageMessage/VideoMessage/AudioMessage no topo — vêm embrulhadas
// num FutureProofMessage (V2 = foto/vídeo, V2Extension = áudio/PTT, e o formato
// legado). A mídia interna baixa normalmente; o "ver uma vez" é só uma dica de
// exibição do cliente oficial, não muda a criptografia. Retorna a mensagem interna
// e true quando era view-once; caso contrário devolve a própria mensagem e false.
func unwrapViewOnce(m *waE2E.Message) (*waE2E.Message, bool) {
	switch {
	case m.GetViewOnceMessageV2().GetMessage() != nil:
		return m.GetViewOnceMessageV2().GetMessage(), true
	case m.GetViewOnceMessageV2Extension().GetMessage() != nil:
		return m.GetViewOnceMessageV2Extension().GetMessage(), true
	case m.GetViewOnceMessage().GetMessage() != nil:
		return m.GetViewOnceMessage().GetMessage(), true
	}
	return m, false
}

// unwrapDocCaption desembrulha o documentWithCaptionMessage (wrapper que o
// WhatsApp usa p/ documento COM legenda), devolvendo o documentMessage interno
// (que carrega o Caption). O whatsmeow já faz isso nos eventos ao vivo
// (evt.UnwrapRaw), mas o HistorySync entrega a mensagem crua — então garantimos
// aqui para não perder o arquivo/legenda na importação.
func unwrapDocCaption(m *waE2E.Message) *waE2E.Message {
	if inner := m.GetDocumentWithCaptionMessage().GetMessage(); inner != nil {
		return inner
	}
	return m
}

// messageContextInfo devolve o ContextInfo da mensagem (onde fica o StanzaID da
// mensagem citada, quando é uma resposta). Nil se não houver.
func messageContextInfo(m *waE2E.Message) *waE2E.ContextInfo {
	m, _ = unwrapViewOnce(m)
	m = unwrapDocCaption(m)
	switch {
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetContextInfo()
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetContextInfo()
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetContextInfo()
	case m.GetAudioMessage() != nil:
		return m.GetAudioMessage().GetContextInfo()
	case m.GetDocumentMessage() != nil:
		return m.GetDocumentMessage().GetContextInfo()
	case m.GetStickerMessage() != nil:
		return m.GetStickerMessage().GetContextInfo()
	case m.GetContactMessage() != nil:
		return m.GetContactMessage().GetContextInfo()
	case m.GetLocationMessage() != nil:
		return m.GetLocationMessage().GetContextInfo()
	}
	return nil
}

func messageText(m *waE2E.Message) string {
	m, _ = unwrapViewOnce(m)
	m = unwrapDocCaption(m)
	switch {
	case m.GetConversation() != "":
		return m.GetConversation()
	case m.GetExtendedTextMessage() != nil:
		return m.GetExtendedTextMessage().GetText()
	case m.GetImageMessage() != nil:
		return m.GetImageMessage().GetCaption()
	case m.GetVideoMessage() != nil:
		return m.GetVideoMessage().GetCaption()
	case m.GetDocumentMessage() != nil:
		// documento COM legenda: o WhatsApp manda documentWithCaptionMessage, mas o
		// whatsmeow já desembrulha p/ documentMessage (evt.UnwrapRaw), deixando a
		// legenda no Caption. Sem este caso, a legenda do PDF/arquivo se perdia.
		return m.GetDocumentMessage().GetCaption()
	case m.GetProductMessage() != nil:
		return productText(m.GetProductMessage())
	case m.GetOrderMessage() != nil:
		return orderText(m.GetOrderMessage())
	case getPoll(m) != nil:
		return pollText(getPoll(m))
	case m.GetInteractiveMessage() != nil:
		return interactiveText(m.GetInteractiveMessage())
	case m.GetEventMessage() != nil:
		return eventText(m.GetEventMessage())
	case m.GetContactMessage() != nil:
		return contactText(m.GetContactMessage())
	case m.GetContactsArrayMessage() != nil:
		return contactsArrayText(m.GetContactsArrayMessage())
	}
	return ""
}

func messageType(m *waE2E.Message) string {
	m, _ = unwrapViewOnce(m)
	m = unwrapDocCaption(m)
	switch {
	case m.GetConversation() != "" || m.GetExtendedTextMessage() != nil:
		return "text"
	case m.GetImageMessage() != nil:
		return "image"
	case m.GetAudioMessage() != nil:
		return "audio"
	case m.GetVideoMessage() != nil:
		return "video"
	case m.GetDocumentMessage() != nil:
		return "document"
	case m.GetStickerMessage() != nil:
		return "sticker"
	case m.GetLocationMessage() != nil:
		return "location"
	case m.GetContactMessage() != nil || m.GetContactsArrayMessage() != nil:
		return "contact"
	case m.GetProductMessage() != nil:
		return "product"
	case m.GetOrderMessage() != nil:
		return "order"
	case getPoll(m) != nil:
		return "poll"
	case m.GetInteractiveMessage() != nil:
		return interactiveType(m.GetInteractiveMessage())
	case m.GetEventMessage() != nil:
		return "event"
	}
	return "unknown"
}
