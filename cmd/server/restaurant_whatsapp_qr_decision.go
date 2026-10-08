package main

import (
	"strings"
	"time"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
)

type restaurantWhatsappDecisionIntent struct {
	scope    restaurantWhatsappScope
	source   restaurantWhatsappSource
	replyTo  string
	decision string
}

// Extracts explicit, context-bound intent, never permission or an order. The
// caller must supply the current account's verified own JID (not message text),
// resolve replyTo against its accepted send journal in this exact scope, and
// recheck current authority/review state before recording the decision.
// Unsupported PN/LID aliases are rejected instead of guessed.
func restaurantWhatsappQRDecision(binding restaurantWhatsappQRBinding, own types.JID, evt *events.Message, now time.Time) (restaurantWhatsappDecisionIntent, error) {
	empty := restaurantWhatsappDecisionIntent{}
	intent, err := restaurantWhatsappQRText(binding, evt, now)
	if err != nil {
		return empty, err
	}
	own = own.ToNonAD()
	if own.User == "" || (own.Server != types.DefaultUserServer && own.Server != types.HiddenUserServer) {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	info := evt.Message.GetExtendedTextMessage().GetContextInfo()
	if info == nil || !restaurantWhatsappOpaque(info.GetStanzaID()) {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	participant, err := types.ParseJID(info.GetParticipant())
	if err != nil || participant.ToNonAD() != own {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	if info.GetRemoteJID() != "" {
		chat, err := types.ParseJID(info.GetRemoteJID())
		if err != nil || chat.ToNonAD().String() != intent.scope.PeerID {
			return empty, restaurantFail(400, "invalid_whatsapp_proposal")
		}
	}
	var decision string
	switch strings.ToLower(strings.TrimSpace(intent.text)) {
	case "confirm", "تأكيد":
		decision = "confirmed"
	case "cancel", "إلغاء":
		decision = "cancelled"
	default:
		// A generic yes, multiple commands or a quoted instruction is ambiguous.
		return empty, restaurantFail(400, "unsupported_whatsapp_message")
	}
	return restaurantWhatsappDecisionIntent{scope: intent.scope, source: intent.source, replyTo: info.GetStanzaID(), decision: decision}, nil
}
