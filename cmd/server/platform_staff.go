package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"time"
)

type platformStaffActorKey struct{}
type platformStaffActor struct{ ID, Scope string }
type platformStaffOrderView struct {
	platformOrderView
	Items     []restaurantOrderLine `json:"items"`
	Notes     string                `json:"notes"`
	TableName string                `json:"tableName,omitempty"`
	CreatedAt time.Time             `json:"createdAt"`
}

// Staff grants use a separate namespace from customer order scopes. The
// control plane resolves current membership before signing each operation.
// No restaurant master key or caller-supplied role enters this path.
func (s *server) registerPlatformStaffOrderRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/orders/{number}", wrap("staff:orders:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		var raw []byte
		err := s.orders.store.db.QueryRowContext(r.Context(), "SELECT document FROM restaurant_orders WHERE number=$1", r.PathValue("number")).Scan(&raw)
		if errors.Is(err, sql.ErrNoRows) {
			err = restaurantFail(404, "order_not_found")
		}
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		var order restaurantOrder
		if err = json.Unmarshal(raw, &order); err != nil {
			writeRestaurantError(w, err)
			return
		}
		// Fulfilment notes can contain customer-provided instructions. They stay
		// in staff scope; structured contacts, receipt capabilities and payment
		// secrets are not copied into this kitchen-facing representation.
		writeJSON(w, 200, platformStaffOrderView{publicPlatformOrder(order), order.Items, order.Notes, order.TableName, order.CreatedAt})
	}))
	mux.HandleFunc("GET /platform-api/staff/orders", wrap("staff:orders:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		orders, err := s.orders.ListAdmin(r.Context(), "", "", 100)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		result := make([]platformOrderView, 0, len(orders))
		for _, order := range orders {
			result = append(result, publicPlatformOrder(order))
		}
		writeJSON(w, 200, map[string]any{"orders": result, "limit": 100})
	}))
	for _, operation := range []struct{ path, scope string }{{"status", "staff:orders:update"}, {"cash", "staff:payments:collect"}} {
		mux.HandleFunc("POST /platform-api/staff/orders/{number}/"+operation.path, wrap(operation.scope, func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
			if r.URL.RawQuery != "" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, operation.scope})
			var order restaurantOrder
			var err error
			if operation.path == "status" {
				var input struct {
					Status  string `json:"status"`
					Version int64  `json:"version"`
				}
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				order, err = s.orders.SetStatus(ctx, r.PathValue("number"), input.Status, input.Version)
			} else {
				var input struct {
					Version int64 `json:"version"`
				}
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				order, err = s.orders.CollectCash(ctx, r.PathValue("number"), input.Version)
			}
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, publicPlatformOrder(order))
		}))
	}
}

func writePlatformStaffAudit(ctx context.Context, tx *sql.Tx, order restaurantOrder, kind string) error {
	actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor)
	if !ok {
		return nil
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO platform_staff_order_audit(actor_id,scope,order_number,version,kind,created_at)
		VALUES($1,$2,$3,$4,$5,$6)`, actor.ID, actor.Scope, order.Number, order.Version, kind, order.UpdatedAt)
	return err
}
