package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

func restaurantDeliveryTransition(from, to string) bool {
	next := map[string]string{"assigned": "picked_up", "picked_up": "on_the_way", "on_the_way": "nearby", "nearby": "at_door", "at_door": "delivered"}
	return next[from] != "" && next[from] == to
}

func (s *restaurantCouriers) ListOrders(ctx context.Context, courierID string) ([]restaurantOrder, error) {
	// Select only the public order document, never receipt credentials, and
	// recheck active state in the same query that authorizes every returned row.
	rows, err := s.db.QueryContext(ctx, `SELECT o.document FROM restaurant_orders o
		JOIN restaurant_couriers c ON c.id=o.document->>'courierId'
		WHERE c.id=$1 AND c.active AND o.document->>'mode'='delivery'
		AND o.status NOT IN ('completed','cancelled') AND COALESCE(o.document->>'deliveryStatus','')<>'delivered'
		ORDER BY o.created_at ASC LIMIT 100`, courierID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	orders := []restaurantOrder{}
	for rows.Next() {
		var raw []byte
		var order restaurantOrder
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(raw, &order); err != nil {
			return nil, err
		}
		orders = append(orders, order)
	}
	return orders, rows.Err()
}

func (s *restaurantCouriers) Assign(ctx context.Context, number, courierID string, version int64) (restaurantOrder, error) {
	if len(number) > 64 || len(courierID) > 128 || version < 1 {
		return restaurantOrder{}, restaurantFail(400, "invalid_request")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	// All operations touching both entities take the order lock first. This
	// serializes reassignment with the previous courier's status/cash updates.
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOrder{}, restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	order := stored.order
	if order.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if order.Mode != "delivery" {
		return restaurantOrder{}, restaurantFail(409, "mode_unavailable")
	}
	if order.Status == "completed" || order.Status == "cancelled" || order.DeliveryStatus == "delivered" {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	var courier restaurantCourier
	if courierID != "" {
		courier, err = scanRestaurantCourier(tx.QueryRowContext(ctx, `SELECT `+restaurantCourierColumns+` FROM restaurant_couriers WHERE id=$1 FOR UPDATE`, courierID))
		if errors.Is(err, sql.ErrNoRows) || err == nil && !courier.Active {
			return restaurantOrder{}, restaurantFail(404, "not_found")
		}
		if err != nil {
			return restaurantOrder{}, err
		}
	}
	if order.CourierID == courierID {
		return order, nil
	}
	if len(order.DeliveryEvents) >= 200 {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	previousID, previousName := order.CourierID, order.CourierName
	order.CourierID, order.CourierName = courierID, courier.Name
	status := "unassigned"
	order.DeliveryStatus = ""
	if courierID != "" {
		status = "assigned"
		order.DeliveryStatus = status
	}
	order.Version++
	order.UpdatedAt = time.Now().UTC()
	order.DeliveryEvents = append(order.DeliveryEvents, restaurantDeliveryEvent{Status: status, CourierID: courierID, CourierName: courier.Name, Actor: "admin", At: order.UpdatedAt})
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "courier_assigned", map[string]string{"actor": "admin", "fromCourierId": previousID, "fromCourierName": previousName, "toCourierId": courierID, "toCourierName": courier.Name, "deliveryStatus": status}); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return order, nil
}

func (s *restaurantCouriers) UpdateOrder(ctx context.Context, courierID, number, status string, version int64, collectCash bool) (restaurantOrder, error) {
	if courierID == "" || len(courierID) > 128 || len(number) > 64 || version < 1 {
		return restaurantOrder{}, restaurantFail(400, "invalid_request")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOrder{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOrder{}, restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	order := stored.order
	// Ownership is checked before version/status, so another courier cannot
	// use mutation errors to inspect the existence or progress of other orders.
	if order.CourierID != courierID || order.Mode != "delivery" || order.Status == "completed" || order.Status == "cancelled" || order.DeliveryStatus == "delivered" {
		return restaurantOrder{}, restaurantFail(404, "order_not_found")
	}
	courier, err := scanRestaurantCourier(tx.QueryRowContext(ctx, `SELECT `+restaurantCourierColumns+` FROM restaurant_couriers WHERE id=$1 FOR UPDATE`, courierID))
	if errors.Is(err, sql.ErrNoRows) || err == nil && !courier.Active {
		return restaurantOrder{}, restaurantFail(401, "unauthorized")
	}
	if err != nil {
		return restaurantOrder{}, err
	}
	if order.Version != version {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if status != order.DeliveryStatus && !restaurantDeliveryTransition(order.DeliveryStatus, status) {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	if status == "assigned" || status == "" {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	if order.Status != "ready" && order.Status != "out_for_delivery" {
		return restaurantOrder{}, restaurantFail(409, "invalid_status")
	}
	if len(order.DeliveryEvents) >= 200 {
		return restaurantOrder{}, restaurantFail(409, "conflict")
	}
	if collectCash {
		if order.Payment.Method != "cash_on_delivery" || order.DeliveryStatus != "at_door" && status != "at_door" {
			return restaurantOrder{}, restaurantFail(403, "forbidden")
		}
		if err = restaurantMarkCashCollected(&order, "courier:"+courierID); err != nil {
			return restaurantOrder{}, err
		}
	}
	// The shared gate also rejects a refunded/unpaid card order that became
	// ineligible after it was initially prepared. Couriers never mark cards paid.
	nextOrderStatus := "out_for_delivery"
	if status == "delivered" {
		nextOrderStatus = "completed"
	}
	if err = restaurantRequirePaymentForStatus(order, nextOrderStatus); err != nil {
		return restaurantOrder{}, err
	}
	if status == order.DeliveryStatus && !collectCash {
		return order, nil
	}
	previous := order.DeliveryStatus
	order.DeliveryStatus = status
	order.Status = nextOrderStatus
	order.Version++
	order.UpdatedAt = time.Now().UTC()
	order.DeliveryEvents = append(order.DeliveryEvents, restaurantDeliveryEvent{Status: status, CourierID: courier.ID, CourierName: courier.Name, Actor: "courier:" + courier.ID, At: order.UpdatedAt})
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return restaurantOrder{}, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "delivery_changed", map[string]any{"actor": "courier:" + courier.ID, "from": previous, "to": status, "collectCash": collectCash, "paymentStatus": order.Payment.Status}); err != nil {
		return restaurantOrder{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOrder{}, err
	}
	return order, nil
}
