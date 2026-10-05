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

type platformStaffSupportSummary struct {
	platformOrderView
	CancellationPending bool `json:"cancellationPending"`
	OpenComplaints      int  `json:"openComplaints"`
}
type platformStaffSupportQueue struct {
	Orders  []platformStaffSupportSummary `json:"orders"`
	Limit   int                           `json:"limit"`
	HasMore bool                          `json:"hasMore"`
}
type platformStaffSupportDetail struct {
	platformStaffSupportSummary
	Cancellation        *restaurantCancellation  `json:"cancellation"`
	Complaints          []restaurantComplaint    `json:"complaints"`
	CancellationHistory []restaurantCancellation `json:"cancellationHistory"`
	HistoryLimit        int                      `json:"historyLimit"`
	HistoryTruncated    bool                     `json:"historyTruncated"`
	Demo                bool                     `json:"demo"`
}

func staffSupportSummary(order restaurantOrder) platformStaffSupportSummary {
	count := 0
	for _, c := range order.Complaints {
		if c.Status == "open" {
			count++
		}
	}
	return platformStaffSupportSummary{publicPlatformOrder(order), order.Cancellation != nil && order.Cancellation.Status == "requested", count}
}
func staffSupportDetail(order restaurantOrder) platformStaffSupportDetail {
	history := order.CancellationHistory
	truncated := len(history) > 20
	if truncated {
		history = history[len(history)-20:]
	}
	return platformStaffSupportDetail{staffSupportSummary(order), order.Cancellation, append([]restaurantComplaint{}, order.Complaints...), append([]restaurantCancellation{}, history...), 20, truncated, order.Demo}
}
func (s *restaurantOrders) PlatformSupportQueue(ctx context.Context) (platformStaffSupportQueue, error) {
	out := platformStaffSupportQueue{Orders: []platformStaffSupportSummary{}, Limit: 100}
	rows, err := s.store.db.QueryContext(ctx, restaurantOrderSelect+` WHERE document->'cancellation'->>'status'='requested' OR document @> '{"complaints":[{"status":"open"}]}'::jsonb ORDER BY created_at ASC,number ASC LIMIT 101`)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		if len(out.Orders) == 100 {
			out.HasMore = true
			break
		}
		stored, err := restaurantReadStored(rows)
		if err != nil {
			return out, err
		}
		out.Orders = append(out.Orders, staffSupportSummary(stored.order))
	}
	return out, rows.Err()
}
func (s *restaurantOrders) PlatformSupportDetail(ctx context.Context, number string) (platformStaffSupportDetail, error) {
	stored, err := restaurantReadStored(s.store.db.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, number))
	if errors.Is(err, sql.ErrNoRows) {
		err = restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return platformStaffSupportDetail{}, err
	}
	return staffSupportDetail(stored.order), nil
}

type platformStaffSupportCommand struct {
	Version  int64  `json:"version"`
	Reviewed bool   `json:"reviewed"`
	Approve  *bool  `json:"approve,omitempty"`
	Reason   string `json:"reason"`
}

func (s *restaurantOrders) PlatformSupportCommand(ctx context.Context, number, id, action string, input platformStaffSupportCommand) (platformStaffSupportDetail, error) {
	if _, err := uuid.Parse(id); err != nil || len(id) != 36 || input.Version < 1 || input.Version > 9007199254740990 || !input.Reviewed {
		return platformStaffSupportDetail{}, restaurantFail(400, "invalid_request")
	}
	actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor)
	if !ok || actor.Scope != "staff:support:"+action {
		return platformStaffSupportDetail{}, restaurantFail(403, "forbidden")
	}
	var order restaurantOrder
	var err error
	switch action {
	case "decide":
		if input.Approve == nil {
			return platformStaffSupportDetail{}, restaurantFail(400, "invalid_request")
		}
		before, e := s.PlatformSupportDetail(ctx, number)
		if e != nil {
			return before, e
		}
		if before.Cancellation == nil || before.Cancellation.ID != id {
			return platformStaffSupportDetail{}, restaurantFail(409, "conflict")
		}
		// The original engine rechecks this version under its row lock, so a new
		// customer request cannot replace the reviewed ID between read and decision.
		order, err = s.DecideCancellation(ctx, number, input.Reason, *input.Approve, input.Version)
	case "resolve":
		if input.Approve != nil {
			return platformStaffSupportDetail{}, restaurantFail(400, "invalid_request")
		}
		order, err = s.ResolveComplaint(ctx, number, id, input.Reason, input.Version)
	default:
		return platformStaffSupportDetail{}, restaurantFail(400, "invalid_request")
	}
	if err != nil {
		return platformStaffSupportDetail{}, err
	}
	return staffSupportDetail(order), nil
}
func (s *server) registerPlatformStaffSupportRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/support", wrap("staff:support:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		value, err := s.orders.PlatformSupportQueue(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
	mux.HandleFunc("GET /platform-api/staff/support/orders/{number}", wrap("staff:support:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		value, err := s.orders.PlatformSupportDetail(r.Context(), r.PathValue("number"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
	for _, action := range []string{"decide", "resolve"} {
		mux.HandleFunc("POST /platform-api/staff/support/orders/{number}/{id}/"+action, wrap("staff:support:"+action, func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
			if r.URL.RawQuery != "" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			var input platformStaffSupportCommand
			if !decodeRestaurantBody(w, r, &input) {
				return
			}
			ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:support:" + action})
			value, err := s.orders.PlatformSupportCommand(ctx, r.PathValue("number"), r.PathValue("id"), action, input)
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, value)
		}))
	}
}
