package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"math"
	"net/http"
	"strings"
	"time"
)

// Reopening is a separate, administrator-only correction, never a backwards
// kitchen transition. The immutable request identity survives browser/network
// retries and restarts; the existing order number and financial snapshots stay.
type restaurantReopenInput struct {
	RequestID string `json:"requestId"`
	Version   int64  `json:"version"`
	Reason    string `json:"reason"`
}

func (s *server) registerRestaurantReopenRoutes(admin *http.ServeMux) {
	admin.HandleFunc("POST /api/restaurant/orders/{number}/reopen", func(w http.ResponseWriter, r *http.Request) {
		var input restaurantReopenInput
		if !decodeRestaurantBody(w, r, &input) {
			return
		}
		order, err := s.orders.Reopen(r.Context(), r.PathValue("number"), input)
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, order)
	})
}

func (s *restaurantOrders) Reopen(ctx context.Context, number string, input restaurantReopenInput) (restaurantOrder, error) {
	input.Reason = strings.TrimSpace(input.Reason)
	if err := restaurantValidateSupportRequest(input.Reason, input.RequestID, input.Version); err != nil {
		return restaurantOrder{}, err
	}
	// Include the original version in the durable identity: a reused UUID must
	// not accidentally reopen a later cancellation of this same order.
	payload, err := json.Marshal(input)
	if err != nil {
		return restaurantOrder{}, err
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	// Catalog -> order -> lexical stock locks matches Create/ChangeTable and
	// stock setup. Price changes never reprice an already-confirmed snapshot.
	catalog, err := loadRestaurantCatalog(ctx, tx, true)
	if err != nil {
		return restaurantOrder{}, err
	}
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOrder{}, restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	order := stored.order
	if repeated, repeatErr := restaurantSupportRepeated(ctx, tx, order.Number, input.RequestID, "reopen", string(payload)); repeatErr != nil {
		return restaurantOrder{}, repeatErr
	} else if repeated {
		return order, nil
	}
	if order.Version != input.Version || order.Version == math.MaxInt64 {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if order.Status != "cancelled" || order.Cancellation != nil && order.Cancellation.Status == "requested" {
		return restaurantOrder{}, restaurantFail(409, "reopen_unavailable")
	}
	if restaurantOrderWasPrepared(order) || order.DeliveryStatus != "" && order.DeliveryStatus != "assigned" && order.DeliveryStatus != "unassigned" {
		return restaurantOrder{}, restaurantFail(409, "reopen_prepared")
	}
	// Legacy imported records may lack preparationStartedAt. Historical
	// kitchen events or a wasted reservation still prove preparation happened.
	var prepared bool
	if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM restaurant_order_events WHERE order_number=$1 AND
	 (document->>'to' IN ('preparing','ready','out_for_delivery','completed') OR document->>'from' IN ('preparing','ready','out_for_delivery','completed')))
	 OR EXISTS(SELECT 1 FROM restaurant_stock_reservations WHERE order_number=$1 AND state='wasted')`, order.Number).Scan(&prepared); err != nil {
		return restaurantOrder{}, err
	}
	if prepared {
		return restaurantOrder{}, restaurantFail(409, "reopen_prepared")
	}
	var reopenCount int
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_order_events WHERE order_number=$1 AND kind='reopened'`, order.Number).Scan(&reopenCount); err != nil {
		return restaurantOrder{}, err
	}
	if reopenCount >= 20 || len(order.DeliveryEvents) >= 200 {
		return restaurantOrder{}, restaurantFail(409, "reopen_limit")
	}
	if err = restaurantReopenPaymentSafe(ctx, tx, order); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantReopenCatalogAvailable(catalog, order); err != nil {
		return restaurantOrder{}, err
	}
	if order.Mode == "delivery" {
		// Coverage can change while an order is cancelled. Validate today's
		// destination, but retain its original address and financial snapshot.
		input, addressErr := restaurantCanonicalDeliveryInput(ctx, tx, restaurantOrderInput{Mode: "delivery", Address: restaurantNormalizeLegacyAddress(order.Address)}, true)
		if addressErr != nil {
			return restaurantOrder{}, addressErr
		}
		if err = restaurantValidateDelivery(catalog.Settings, input.Address); err != nil {
			return restaurantOrder{}, err
		}
		if _, err = restaurantDeliveryFee(catalog.Settings, input.Address); err != nil {
			return restaurantOrder{}, err
		}
	}
	now := time.Now().UTC()
	order.UpdatedAt = now
	if err = restaurantReopenStock(ctx, tx, &order); err != nil {
		return restaurantOrder{}, err
	}
	if order.Cancellation != nil {
		order.CancellationHistory = append(order.CancellationHistory, *order.Cancellation)
		order.Cancellation = nil
	}
	// Do not silently hand the reopened order back to a courier. Preserve its
	// assignment history, revoke old access, and require an explicit assignment.
	if order.CourierID != "" || order.DeliveryStatus != "" {
		order.DeliveryEvents = append(order.DeliveryEvents, restaurantDeliveryEvent{Status: "unassigned", Actor: "admin", At: now})
		order.CourierID, order.CourierName, order.DeliveryStatus = "", "", ""
	}
	order.Status = "new"
	order.Version++
	if err = restaurantRememberSupportRequest(ctx, tx, order.Number, input.RequestID, "reopen", string(payload)); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "reopened", map[string]any{"from": "cancelled", "to": "new", "reason": input.Reason, "actor": "admin", "requestId": input.RequestID, "originalVersion": input.Version}); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return order, nil
}

func restaurantReopenPaymentSafe(ctx context.Context, tx *sql.Tx, order restaurantOrder) error {
	// Even a failed provider attempt can later report success. This correction
	// deliberately supports only an uncharged order with no payment/refund
	// activity; it never mutates a payment attempt or withdraws a refund intent.
	if order.Payment.PaidAt != nil || order.Payment.Status != "unpaid" && !(order.Payment.Method == "" && order.Payment.Status == "") {
		return restaurantFail(409, "reopen_payment")
	}
	if order.Payment.Method != "" && (order.Payment.AmountMinor != order.TotalMinor || order.Payment.AmountMinor < 0 || order.Payment.Method != "card" && !restaurantCashMethod(order.Mode, order.Payment.Method)) {
		return restaurantFail(409, "reopen_payment")
	}
	if order.Payment.Method != "card" && order.Payment.Provider != "" {
		return restaurantFail(409, "reopen_payment")
	}
	var refund, attemptsTable bool
	if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM restaurant_refunds WHERE order_number=$1),to_regclass('restaurant_payment_attempts') IS NOT NULL`, order.Number).Scan(&refund, &attemptsTable); err != nil {
		return err
	}
	if refund {
		return restaurantFail(409, "reopen_payment")
	}
	if attemptsTable {
		var attempted bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM restaurant_payment_attempts WHERE order_number=$1)`, order.Number).Scan(&attempted); err != nil {
			return err
		}
		if attempted {
			return restaurantFail(409, "reopen_payment")
		}
	}
	return nil
}

func restaurantReopenCatalogAvailable(catalog restaurantCatalog, order restaurantOrder) error {
	if !catalog.Settings.AcceptingOrders {
		return restaurantFail(409, "store_closed")
	}
	if order.Mode != "delivery" && order.Mode != "pickup" && order.Mode != "table" || order.Mode == "delivery" && !catalog.Settings.DeliveryEnabled || order.Mode == "pickup" && !catalog.Settings.PickupEnabled || order.Mode == "table" && !catalog.Settings.TableEnabled {
		return restaurantFail(409, "mode_unavailable")
	}
	if order.Mode == "table" {
		found := false
		for _, table := range catalog.Tables {
			if table.ID == order.TableID && table.Active {
				found = true
				break
			}
		}
		if !found {
			return restaurantFail(409, "table_not_found")
		}
	}
	items := make(map[string]restaurantItem, len(catalog.Items))
	for _, item := range catalog.Items {
		items[item.ID] = item
	}
	for _, line := range order.Items {
		item, found := items[line.ItemID]
		if !found || !item.Available {
			return restaurantFail(409, "item_unavailable")
		}
		for _, chosen := range line.Options {
			found = false
			for _, option := range item.Options {
				if option.ID == chosen.ID && option.Available {
					found = true
					break
				}
			}
			if !found {
				return restaurantFail(409, "invalid_option")
			}
		}
	}
	return nil
}

func restaurantReopenStock(ctx context.Context, tx *sql.Tx, order *restaurantOrder) error {
	ids, quantities := restaurantStockQuantities(order.Items)
	expires := order.UpdatedAt.Add(restaurantStockHoldDuration)
	order.StockExpiresAt = nil
	for _, id := range ids {
		if err := restaurantLockStockItem(ctx, tx, id); err != nil {
			return err
		}
		var state string
		var oldQuantity int64
		err := tx.QueryRowContext(ctx, `SELECT state,quantity FROM restaurant_stock_reservations WHERE order_number=$1 AND item_id=$2 FOR UPDATE`, order.Number, id).Scan(&state, &oldQuantity)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if state != "" && (state != "released" || oldQuantity != quantities[id]) {
			return restaurantFail(409, "reopen_stock")
		}
		var tracked bool
		var available int64
		err = tx.QueryRowContext(ctx, `SELECT tracked,available FROM restaurant_stock WHERE item_id=$1 FOR UPDATE`, id).Scan(&tracked, &available)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		if !tracked {
			if state != "" {
				return restaurantFail(409, "reopen_stock")
			}
			continue
		}
		if available < quantities[id] {
			return restaurantFail(409, "item_unavailable")
		}
		if _, err = tx.ExecContext(ctx, `UPDATE restaurant_stock SET available=available-$2,version=version+1,updated_at=$3 WHERE item_id=$1`, id, quantities[id], order.UpdatedAt); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stock_reservations(order_number,item_id,quantity,state,expires_at,updated_at) VALUES($1,$2,$3,'held',$4,$5)
		 ON CONFLICT(order_number,item_id) DO UPDATE SET state='held',expires_at=EXCLUDED.expires_at,updated_at=EXCLUDED.updated_at`, order.Number, id, quantities[id], expires, order.UpdatedAt); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stock_events(item_id,order_number,kind,quantity) VALUES($1,$2,'reopened_reserved',$3)`, id, order.Number, -quantities[id]); err != nil {
			return err
		}
		order.StockExpiresAt = &expires
	}
	return nil
}
