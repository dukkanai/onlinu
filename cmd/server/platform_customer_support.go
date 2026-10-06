package main

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"io"
	"net/http"

	"github.com/google/uuid"
)

// Customer-owned support is deliberately separate from staff authority and the
// contact-free MCP status projection. Do not add receipt capabilities here.
type platformCustomerSupportDetail struct {
	platformOrderView
	Cancellation        *restaurantCancellation  `json:"cancellation"`
	Complaints          []restaurantComplaint    `json:"complaints"`
	CancellationHistory []restaurantCancellation `json:"cancellationHistory"`
	HistoryLimit        int                      `json:"historyLimit"`
	HistoryTruncated    bool                     `json:"historyTruncated"`
	Demo                bool                     `json:"demo"`
}

func customerSupportDetail(order restaurantOrder) platformCustomerSupportDetail {
	history := order.CancellationHistory
	truncated := len(history) > 20
	if truncated {
		history = history[len(history)-20:]
	}
	return platformCustomerSupportDetail{publicPlatformOrder(order), order.Cancellation, append([]restaurantComplaint{}, order.Complaints...), append([]restaurantCancellation{}, history...), 20, truncated, order.Demo}
}

type platformCustomerSupportInput struct {
	Version  int64  `json:"version"`
	Reviewed bool   `json:"reviewed"`
	Reason   string `json:"reason"`
}
type platformCustomerSupportRecovery struct {
	Order     platformCustomerSupportDetail `json:"order"`
	RequestID string                        `json:"requestId"`
	Kind      string                        `json:"kind"`
	Recorded  bool                          `json:"recorded"`
}

func validPlatformSupportKey(key string) bool {
	id, err := uuid.Parse(key)
	return err == nil && id.String() == key && id.Version() == 4 && id.Variant() == uuid.RFC4122
}

// Read the original durable request ledger and current order in one snapshot.
// A later request/reopen must not make a committed earlier request look missing.
// "Recorded" does not claim the old request is still the current cancellation.
func (s *restaurantOrders) PlatformCustomerSupportRecovery(ctx context.Context, number, owner, kind, key string) (platformCustomerSupportRecovery, error) {
	out := platformCustomerSupportRecovery{RequestID: key, Kind: kind}
	if !validPlatformSupportKey(key) || (kind != "cancellation" && kind != "complaint") {
		return out, restaurantFail(400, "invalid_request")
	}
	tx, err := s.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return out, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, number))
	if errors.Is(err, sql.ErrNoRows) || err == nil && !restaurantCanAccess(stored, "", "", owner) {
		return out, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return out, err
	}
	var recordedKind string
	err = tx.QueryRowContext(ctx, `SELECT kind FROM restaurant_order_support_requests WHERE order_number=$1 AND request_id=$2`, number, key).Scan(&recordedKind)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	if err == nil && recordedKind != kind {
		return out, restaurantFail(409, "conflict")
	}
	out.Recorded = err == nil
	out.Order = customerSupportDetail(stored.order)
	if err = tx.Commit(); err != nil {
		return out, err
	}
	return out, nil
}
func (s *server) registerPlatformCustomerSupportRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/customer-support/{number}", wrap("customer:support:read", func(w http.ResponseWriter, r *http.Request, _ []byte, owner string) {
		order, err := s.orders.Track(r.Context(), r.PathValue("number"), "", "", owner)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, customerSupportDetail(order))
	}))
	mux.HandleFunc("GET /platform-api/customer-support/{number}/{kind}/{key}", wrap("customer:support:read", func(w http.ResponseWriter, r *http.Request, _ []byte, owner string) {
		out, err := s.orders.PlatformCustomerSupportRecovery(r.Context(), r.PathValue("number"), owner, r.PathValue("kind"), r.PathValue("key"))
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, out)
	}))
	for _, kind := range []string{"cancellation", "complaint"} {
		mux.HandleFunc("POST /platform-api/customer-support/{number}/"+kind, wrap("customer:support:write", func(w http.ResponseWriter, r *http.Request, body []byte, owner string) {
			r.Body = io.NopCloser(bytes.NewReader(body))
			var input platformCustomerSupportInput
			if !decodeRestaurantBody(w, r, &input) {
				return
			}
			key := r.Header.Get("Idempotency-Key")
			if !input.Reviewed || input.Version < 1 || input.Version > 9007199254740990 || !validPlatformSupportKey(key) {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			var order restaurantOrder
			var err error
			if kind == "cancellation" {
				order, err = s.orders.RequestCancellation(r.Context(), r.PathValue("number"), "", "", owner, input.Reason, key, input.Version)
			} else {
				order, err = s.orders.ReportComplaint(r.Context(), r.PathValue("number"), "", "", owner, input.Reason, key, input.Version)
			}
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, platformCustomerSupportRecovery{Order: customerSupportDetail(order), RequestID: key, Kind: kind, Recorded: true})
		}))
	}
}
