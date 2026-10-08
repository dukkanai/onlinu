package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"time"

	"github.com/google/uuid"
)

const restaurantWhatsappDispatchScope = "transport:whatsapp:dispatch"
const restaurantWhatsappDispatchPath = "/platform-api/private/whatsapp/dispatch"

type restaurantWhatsappDispatchRequest struct {
	RestaurantID      string `json:"restaurantId"`
	ConnectionID      string `json:"connectionId"`
	Generation        string `json:"generation"`
	PeerID            string `json:"peerId"`
	DeviceFingerprint string `json:"deviceFingerprint"`
	ReviewID          string `json:"reviewId"`
}

// Ephemeral operation capability, not a credential or reusable daemon lease.
// No route constructs it. The trusted configured transport principal is distinct
// from a staff login; platform issuance/entitlement checks remain an activation
// prerequisite. Constructor inputs never link or create a provider account.
type restaurantWhatsappDispatchAuthority struct {
	bindings                    *restaurantWhatsappBindings
	scope                       restaurantWhatsappScope
	reviewID, deviceFingerprint string
	issuedAt, expiresAt         int64
	now                         func() time.Time
}

func newRestaurantWhatsappDispatchAuthority(auth *platformRequestAuth, bindings *restaurantWhatsappBindings, transportPrincipal string, r *http.Request, body []byte) (*restaurantWhatsappDispatchAuthority, error) {
	denied := restaurantFail(401, "platform_unauthorized")
	principal, err := uuid.Parse(transportPrincipal)
	if auth == nil || auth.now == nil || bindings == nil || bindings.db == nil || r == nil || r.URL == nil || r.Method != http.MethodPost || r.URL.RequestURI() != restaurantWhatsappDispatchPath ||
		err != nil || principal == uuid.Nil || principal.String() != transportPrincipal || len(body) == 0 || len(body) > 4096 {
		return nil, denied
	}
	claims, err := auth.verifyClaims(r, body, restaurantWhatsappDispatchScope)
	if err != nil {
		return nil, err
	}
	requestID, err := uuid.Parse(claims.IdempotencyKey)
	if err != nil || requestID == uuid.Nil || requestID.String() != claims.IdempotencyKey || claims.Subject != transportPrincipal || claims.Audience != bindings.tenant {
		return nil, denied
	}
	var request restaurantWhatsappDispatchRequest
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil || decoder.Decode(new(any)) != io.EOF || request.RestaurantID != bindings.tenant || !restaurantWhatsappOpaque(request.ReviewID) || len(request.DeviceFingerprint) != 64 {
		return nil, denied
	}
	fingerprint, err := hex.DecodeString(request.DeviceFingerprint)
	if err != nil || len(fingerprint) != 32 || hex.EncodeToString(fingerprint) != request.DeviceFingerprint {
		return nil, denied
	}
	scope := restaurantWhatsappScope{RestaurantID: request.RestaurantID, Channel: "whatsapp_qr", ConnectionID: request.ConnectionID, Generation: request.Generation, PeerID: request.PeerID}
	if !restaurantWhatsappValidScope(scope) {
		return nil, denied
	}
	return &restaurantWhatsappDispatchAuthority{bindings: bindings, scope: scope, reviewID: request.ReviewID, deviceFingerprint: request.DeviceFingerprint, issuedAt: claims.IssuedAt, expiresAt: claims.ExpiresAt, now: auth.now}, nil
}

// The review and peer cannot be substituted after verification: callers supply
// no alternative ID/scope. The immutable copy is safe across concurrent requests.
// Recheck expiry and binding inside BOTH preparation and original core order
// transactions. The signature's bounded revocation window is not instantaneous
// distributed revocation; local binding replacement is serialized transactionally.
func (a *restaurantWhatsappDispatchAuthority) Dispatch(ctx context.Context, reviews *restaurantWhatsappReviews) (restaurantReceipt, error) {
	if a == nil || a.now == nil || a.bindings == nil || reviews == nil || reviews.orders == nil || reviews.orders.store == nil || reviews.orders.store.db != a.bindings.db {
		return restaurantReceipt{}, restaurantFail(401, "platform_unauthorized")
	}
	local := *reviews
	local.dispatchNow = a.now
	validTime := func() bool {
		now := a.now().Unix()
		return now < a.expiresAt && a.issuedAt <= now+15 && a.issuedAt >= now-75
	}
	local.authorizeDispatch = func(ctx context.Context, tx *sql.Tx, actual restaurantWhatsappScope) bool {
		if actual != a.scope || !validTime() {
			return false
		}
		if a.bindings.RequireCurrent(ctx, tx, actual, a.deviceFingerprint) != nil {
			return false
		}
		// Acquiring the binding can wait behind replacement; expiry must not be
		// frozen at the beginning of that wait.
		return validTime()
	}
	return local.Dispatch(ctx, a.scope, a.reviewID)
}
