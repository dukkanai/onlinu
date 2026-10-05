package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"github.com/google/uuid"
	"io"
	"net/http"
)

func writePlatformStaffRefundAudit(ctx context.Context, tx *sql.Tx, r restaurantRefund, kind string) error {
	actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor)
	if !ok {
		return nil
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO platform_staff_refund_audit(refund_id,version,actor_id,scope,kind) VALUES($1,$2,$3,$4,$5)`, r.ID, r.Version, actor.ID, actor.Scope, kind)
	return err
}

type platformStaffRefundDetail struct {
	platformStaffRefundView
	Number            string                     `json:"number"`
	OrderVersion      int64                      `json:"orderVersion"`
	OrderTotalMinor   int64                      `json:"orderTotalMinor"`
	CapturedMinor     int64                      `json:"capturedMinor"`
	Demo              bool                       `json:"demo"`
	Reason            string                     `json:"reason"`
	ProviderReference string                     `json:"providerReference"`
	ManualReference   string                     `json:"manualReference"`
	ResolutionReason  string                     `json:"resolutionReason"`
	Capability        restaurantRefundCapability `json:"capability"`
}

func (p *restaurantPayments) PlatformRefundDetail(ctx context.Context, number, id string) (platformStaffRefundDetail, error) {
	if _, err := uuid.Parse(id); err != nil || len(id) != 36 {
		return platformStaffRefundDetail{}, restaurantFail(400, "invalid_request")
	}
	tx, err := p.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return platformStaffRefundDetail{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, number))
	if errors.Is(err, sql.ErrNoRows) {
		return platformStaffRefundDetail{}, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return platformStaffRefundDetail{}, err
	}
	r, err := restaurantReadRefund(tx.QueryRowContext(ctx, `SELECT data FROM restaurant_refunds WHERE id=$1 AND order_number=$2`, id, number))
	if errors.Is(err, sql.ErrNoRows) {
		return platformStaffRefundDetail{}, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return platformStaffRefundDetail{}, err
	}
	if r.ID != id || r.Number != number || stored.order.Number != number {
		return platformStaffRefundDetail{}, restaurantFail(500, "server_error")
	}
	captured, err := restaurantRefundCaptured(ctx, tx, stored.order)
	if err != nil {
		return platformStaffRefundDetail{}, err
	}
	return platformStaffRefundDetail{staffRefundView(r), number, stored.order.Version, stored.order.TotalMinor, captured, stored.order.Demo, r.Reason, r.ProviderReference, r.ManualReference, r.ResolutionReason, restaurantRefundCapabilities(r.Provider)}, nil
}

type platformRefundCommand struct {
	Version     *int64  `json:"version"`
	Reviewed    *bool   `json:"reviewed"`
	AmountMinor *int64  `json:"amountMinor"`
	Currency    string  `json:"currency"`
	Provider    *string `json:"provider"`
	Demo        *bool   `json:"demo"`
	Reference   string  `json:"reference,omitempty"`
	Reason      string  `json:"reason,omitempty"`
}

func (p *restaurantPayments) PlatformRefundCommand(ctx context.Context, number, id, action string, input platformRefundCommand) (platformStaffRefundDetail, error) {
	if input.Version == nil || *input.Version < 1 || *input.Version > 9007199254740990 || input.Reviewed == nil || !*input.Reviewed || input.AmountMinor == nil || *input.AmountMinor <= 0 || input.Demo == nil || input.Provider == nil || input.Currency != "SAR" {
		return platformStaffRefundDetail{}, restaurantFail(400, "invalid_request")
	}
	if action != "authorize" && action != "manual" && action != "verify" && action != "refresh" {
		return platformStaffRefundDetail{}, restaurantFail(400, "invalid_request")
	}
	if (action == "authorize" || action == "refresh") && (input.Reference != "" || input.Reason != "") {
		return platformStaffRefundDetail{}, restaurantFail(400, "invalid_request")
	}
	actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor)
	if !ok || actor.Scope != "staff:refunds:"+action {
		return platformStaffRefundDetail{}, restaurantFail(403, "forbidden")
	}
	before, err := p.PlatformRefundDetail(ctx, number, id)
	if err != nil {
		return before, err
	}
	// Money/provider/mode are immutable original-ledger facts. This comparison
	// binds the explicit reviewed tuple; state/version checks remain in the engine.
	if before.AmountMinor != *input.AmountMinor || before.Currency != input.Currency || before.Provider != *input.Provider || before.Demo != *input.Demo {
		return platformStaffRefundDetail{}, restaurantFail(409, "conflict")
	}
	switch action {
	case "authorize":
		_, err = p.AuthorizeRefund(ctx, number, id, *input.Version)
	case "manual":
		_, err = p.ResolveRefundManual(ctx, number, id, restaurantRefundResolution{Reference: input.Reference, Reason: input.Reason, Version: *input.Version})
	case "verify":
		_, err = p.ConfirmRefundReference(ctx, number, id, restaurantRefundResolution{Reference: input.Reference, Reason: input.Reason, Version: *input.Version})
	case "refresh":
		_, err = p.RefreshRefund(ctx, number, id)
	}
	if errors.Is(err, sql.ErrNoRows) {
		err = restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return platformStaffRefundDetail{}, err
	}
	return p.PlatformRefundDetail(ctx, number, id)
}
func (s *server) registerPlatformStaffRefundRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/orders/{number}/refunds/{id}", wrap("staff:refunds:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if s.payments == nil {
			writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
			return
		}
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		value, err := s.payments.PlatformRefundDetail(r.Context(), r.PathValue("number"), r.PathValue("id"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
	for _, action := range []string{"authorize", "manual", "verify", "refresh"} {
		mux.HandleFunc("POST /platform-api/staff/orders/{number}/refunds/{id}/"+action, wrap("staff:refunds:"+action, func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
			if s.payments == nil {
				writeRestaurantError(w, restaurantFail(503, "payment_unavailable"))
				return
			}
			if r.URL.RawQuery != "" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			var input platformRefundCommand
			r.Body = io.NopCloser(bytes.NewReader(body))
			if !decodeRestaurantBody(w, r, &input) {
				return
			}
			ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:refunds:" + action})
			value, err := s.payments.PlatformRefundCommand(ctx, r.PathValue("number"), r.PathValue("id"), action, input)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, value)
		}))
	}
}
