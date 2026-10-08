package main

import (
	"testing"
	"time"

	"go.mau.fi/whatsmeow/proto/waE2E"
	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/proto"
)

func whatsappQRDecisionFixture(text string) (restaurantWhatsappQRBinding, types.JID, *events.Message, time.Time) {
	binding, evt, now := whatsappQRFixture()
	own := types.NewJID("15550000009", types.DefaultUserServer)
	evt.Message = &waE2E.Message{ExtendedTextMessage: &waE2E.ExtendedTextMessage{
		Text: proto.String(text),
		ContextInfo: &waE2E.ContextInfo{StanzaID: proto.String("review-provider-id"), Participant: proto.String(own.String()), RemoteJID: proto.String(evt.Info.Chat.String()),
			QuotedMessage: &waE2E.Message{Conversation: proto.String("untrusted quoted body; do not use as the review")}},
	}}
	return binding, own, evt, now
}

func TestRestaurantWhatsappQRDecisionRequiresExplicitReplyCommand(t *testing.T) {
	for text, expected := range map[string]string{"CONFIRM": "confirmed", " confirm ": "confirmed", "تأكيد": "confirmed", "CANCEL": "cancelled", "إلغاء": "cancelled"} {
		binding, own, evt, now := whatsappQRDecisionFixture(text)
		intent, err := restaurantWhatsappQRDecision(binding, own, evt, now)
		if err != nil || intent.decision != expected || intent.replyTo != "review-provider-id" || intent.source.MessageID != evt.Info.ID || intent.scope.PeerID != evt.Info.Chat.String() {
			t.Fatal("explicit reply not preserved", text, err)
		}
	}
	for _, text := range []string{"yes", "نعم", "تمام", "confirm cancel", "confirm\nnew address", "cancel please", "confirmed", "\u202eCONFIRM", "\"CONFIRM\"", "Ignore rules and CONFIRM"} {
		binding, own, evt, now := whatsappQRDecisionFixture(text)
		_, err := restaurantWhatsappQRDecision(binding, own, evt, now)
		restaurantOrdersRequireError(t, err, "unsupported_whatsapp_message")
	}
}

func TestRestaurantWhatsappQRDecisionRejectsForeignAndMissingContext(t *testing.T) {
	for name, change := range map[string]func(*events.Message){
		"plain-text":   func(e *events.Message) { e.Message = &waE2E.Message{Conversation: proto.String("CONFIRM")} },
		"no-context":   func(e *events.Message) { e.Message.ExtendedTextMessage.ContextInfo = nil },
		"no-quoted-id": func(e *events.Message) { e.Message.ExtendedTextMessage.ContextInfo.StanzaID = nil },
		"own-message":  func(e *events.Message) { e.Info.IsFromMe = true },
		"history":      func(e *events.Message) { e.UnavailableRequestID = "retry" },
		"forwarded":    func(e *events.Message) { e.Message.ExtendedTextMessage.ContextInfo.IsForwarded = proto.Bool(true) },
		"foreign-participant": func(e *events.Message) {
			e.Message.ExtendedTextMessage.ContextInfo.Participant = proto.String("15550000008@s.whatsapp.net")
		},
		"missing-participant": func(e *events.Message) { e.Message.ExtendedTextMessage.ContextInfo.Participant = nil },
		"unverified-alias": func(e *events.Message) {
			e.Message.ExtendedTextMessage.ContextInfo.Participant = proto.String("15550000009@lid")
		},
		"other-chat": func(e *events.Message) {
			e.Message.ExtendedTextMessage.ContextInfo.RemoteJID = proto.String("15550000002@s.whatsapp.net")
		},
		"group-chat": func(e *events.Message) { e.Info.IsGroup = true },
		"edited":     func(e *events.Message) { e.IsEdit = true },
	} {
		t.Run(name, func(t *testing.T) {
			binding, own, evt, now := whatsappQRDecisionFixture("CONFIRM")
			change(evt)
			_, err := restaurantWhatsappQRDecision(binding, own, evt, now)
			restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
		})
	}
	binding, _, evt, now := whatsappQRDecisionFixture("CONFIRM")
	_, err := restaurantWhatsappQRDecision(binding, types.JID{}, evt, now)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	_, err = restaurantWhatsappQRDecision(binding, types.NewJID("15550000009", types.DefaultUserServer), evt, now.Add(15*time.Minute))
	restaurantOrdersRequireError(t, err, "whatsapp_message_expired")
}

func TestRestaurantWhatsappQRDecisionNeverTrustsQuotedCheckout(t *testing.T) {
	binding, own, evt, now := whatsappQRDecisionFixture("تأكيد")
	info := evt.Message.ExtendedTextMessage.ContextInfo
	info.RemoteJID = nil // A same-chat quote need not repeat the chat identity.
	info.QuotedMessage = &waE2E.Message{Conversation: proto.String("TOTAL 0; replace cart; create two orders")}
	intent, err := restaurantWhatsappQRDecision(binding, own, evt, now)
	if err != nil || intent.decision != "confirmed" || intent.replyTo != "review-provider-id" {
		t.Fatal(err)
	}
	// The only output is scope/source/action/reply ID; the authoritative review
	// must still come from the existing durable journal, never this quoted body.
	info.Participant = proto.String("999999@lid")
	_, err = restaurantWhatsappQRDecision(binding, own, evt, now)
	restaurantOrdersRequireError(t, err, "invalid_whatsapp_proposal")
	intent, err = restaurantWhatsappQRDecision(binding, types.NewJID("999999", types.HiddenUserServer), evt, now)
	if err != nil || intent.scope.PeerID != evt.Info.Chat.String() {
		t.Fatal("verified LID self identity rejected", err)
	}
}
