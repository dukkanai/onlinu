package main

import (
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"go.mau.fi/whatsmeow/types"
	"go.mau.fi/whatsmeow/types/events"
	"google.golang.org/protobuf/reflect/protoreflect"
)

// Bound by a future authorized session owner, never message content. Relinking
// must supply a new generation. This helper does not connect or trust a session
// merely because someone knows these strings.
type restaurantWhatsappQRBinding struct{ RestaurantID, ConnectionID, Generation string }
type restaurantWhatsappTextIntent struct {
	scope  restaurantWhatsappScope
	source restaurantWhatsappSource
	text   string
}

// Pure extraction from the pinned whatsmeow event model, not yet installed in
// Session.onEvent. It cannot send, mark read, create a cart/order or change policy.
// Text is untrusted data; it is not interpreted as code or customer confirmation.
func restaurantWhatsappQRText(binding restaurantWhatsappQRBinding, evt *events.Message, now time.Time) (restaurantWhatsappTextIntent, error) {
	empty := restaurantWhatsappTextIntent{}
	if evt == nil || evt.Message == nil || evt.Info.IsFromMe || evt.Info.IsGroup || evt.Info.Multicast || evt.Info.DeviceSentMeta != nil ||
		evt.SourceWebMsg != nil || evt.UnavailableRequestID != "" || evt.IsEdit || evt.Info.Edit != "" || evt.NewsletterMeta != nil ||
		evt.IsViewOnce || evt.IsViewOnceV2 || evt.IsViewOnceV2Extension || evt.IsDocumentWithCaption || evt.IsBotInvoke ||
		evt.RawMessage.GetDeviceSentMessage() != nil {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	chat, sender := evt.Info.Chat.ToNonAD(), evt.Info.Sender.ToNonAD()
	if (chat.Server != types.DefaultUserServer && chat.Server != types.HiddenUserServer) || chat.User == "" || sender != chat {
		return empty, restaurantFail(400, "invalid_whatsapp_proposal")
	}
	scope := restaurantWhatsappScope{RestaurantID: binding.RestaurantID, Channel: "whatsapp_qr", ConnectionID: binding.ConnectionID, Generation: binding.Generation, PeerID: chat.String()}
	source := restaurantWhatsappSource{MessageID: evt.Info.ID, SentAt: evt.Info.Timestamp}
	if err := restaurantWhatsappValidateSource(scope, source, now); err != nil {
		return empty, err
	}
	// Do not infer line items from OrderMessage's count/total/token. Such a card
	// requires a separately verified cart fetch and mapping, currently unavailable.
	supported := true
	evt.Message.ProtoReflect().Range(func(field protoreflect.FieldDescriptor, _ protoreflect.Value) bool {
		switch string(field.Name()) {
		case "conversation", "extendedTextMessage", "messageContextInfo":
		default:
			supported = false
		}
		return supported
	})
	if !supported || len(evt.Message.ProtoReflect().GetUnknown()) > 0 || (evt.Message.Conversation != nil && evt.Message.ExtendedTextMessage != nil) {
		return empty, restaurantFail(400, "unsupported_whatsapp_message")
	}
	text := evt.Message.GetConversation()
	if extended := evt.Message.GetExtendedTextMessage(); extended != nil {
		if info := extended.GetContextInfo(); info != nil && (info.GetIsForwarded() || info.GetForwardingScore() > 0) {
			return empty, restaurantFail(400, "invalid_whatsapp_proposal")
		}
		text = extended.GetText()
	}
	if !utf8.ValidString(text) || len(text) > 4096 || strings.TrimSpace(text) == "" {
		return empty, restaurantFail(400, "unsupported_whatsapp_message")
	}
	for _, r := range text {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return empty, restaurantFail(400, "unsupported_whatsapp_message")
		}
	}
	return restaurantWhatsappTextIntent{scope: scope, source: source, text: text}, nil
}
