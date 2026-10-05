package main

import (
	"context"
	"database/sql"
	"errors"
	"math"
	"strings"
	"time"
)

type restaurantLocationInput struct {
	Latitude   *float64  `json:"latitude"`
	Longitude  *float64  `json:"longitude"`
	Accuracy   *float64  `json:"accuracy"`
	CapturedAt time.Time `json:"capturedAt"`
	Version    int64     `json:"version"`
}
type restaurantCourierLocation struct {
	Latitude   float64   `json:"latitude"`
	Longitude  float64   `json:"longitude"`
	Accuracy   float64   `json:"accuracy"`
	CapturedAt time.Time `json:"capturedAt"`
	ReceivedAt time.Time `json:"receivedAt"`
	ExpiresAt  time.Time `json:"expiresAt"`
	Stale      bool      `json:"stale"`
}
type restaurantLocationResult struct {
	Location *restaurantCourierLocation `json:"location"`
}

const restaurantLocationLifetime = 2 * time.Minute
const restaurantLocationStaleAfter = 45 * time.Second

func initRestaurantLocations(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `
	CREATE TABLE IF NOT EXISTS restaurant_courier_locations (
		order_number TEXT PRIMARY KEY REFERENCES restaurant_orders(number) ON DELETE CASCADE,
		courier_id TEXT NOT NULL REFERENCES restaurant_couriers(id) ON DELETE CASCADE,
		latitude DOUBLE PRECISION NOT NULL CHECK(latitude BETWEEN -90 AND 90),
		longitude DOUBLE PRECISION NOT NULL CHECK(longitude BETWEEN -180 AND 180),
		accuracy DOUBLE PRECISION NOT NULL CHECK(accuracy BETWEEN 0 AND 5000),
		captured_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL
	);
	CREATE INDEX IF NOT EXISTS restaurant_courier_locations_expiry ON restaurant_courier_locations(expires_at);
	CREATE OR REPLACE FUNCTION restaurant_location_order_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NEW.status IN ('completed','cancelled') OR NEW.document->>'courierId' IS DISTINCT FROM OLD.document->>'courierId' THEN
			DELETE FROM restaurant_courier_locations WHERE order_number=NEW.number;
		END IF;
		RETURN NEW;
	END $$;
	DROP TRIGGER IF EXISTS restaurant_location_order_cleanup ON restaurant_orders;
	CREATE TRIGGER restaurant_location_order_cleanup AFTER UPDATE OF status,document ON restaurant_orders
		FOR EACH ROW EXECUTE FUNCTION restaurant_location_order_cleanup();
	CREATE OR REPLACE FUNCTION restaurant_location_courier_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
		IF NOT NEW.active OR NEW.password_hash IS DISTINCT FROM OLD.password_hash THEN
			DELETE FROM restaurant_courier_locations WHERE courier_id=NEW.id;
		END IF;
		RETURN NEW;
	END $$;
	DROP TRIGGER IF EXISTS restaurant_location_courier_cleanup ON restaurant_couriers;
	CREATE TRIGGER restaurant_location_courier_cleanup AFTER UPDATE OF active,password_hash ON restaurant_couriers
		FOR EACH ROW EXECUTE FUNCTION restaurant_location_courier_cleanup();`)
	return err
}
func validateRestaurantLocation(input restaurantLocationInput, now time.Time) error {
	if input.Version < 1 || input.Latitude == nil || input.Longitude == nil || input.Accuracy == nil || input.CapturedAt.IsZero() || input.CapturedAt.Before(now.Add(-2*time.Minute)) || input.CapturedAt.After(now.Add(30*time.Second)) {
		return restaurantFail(400, "invalid_request")
	}
	lat, lng, accuracy := *input.Latitude, *input.Longitude, *input.Accuracy
	if math.IsNaN(lat) || math.IsInf(lat, 0) || lat < -90 || lat > 90 || math.IsNaN(lng) || math.IsInf(lng, 0) || lng < -180 || lng > 180 || math.IsNaN(accuracy) || math.IsInf(accuracy, 0) || accuracy < 0 || accuracy > 5000 {
		return restaurantFail(400, "invalid_request")
	}
	return nil
}
func restaurantActiveLocationOrder(order restaurantOrder) bool {
	return order.Mode == "delivery" && order.CourierID != "" && order.Status != "completed" && order.Status != "cancelled" && order.DeliveryStatus != "delivered"
}

func (s *restaurantCouriers) PublishLocation(ctx context.Context, courierID, number string, input restaurantLocationInput) (restaurantLocationResult, error) {
	now := time.Now().UTC().Truncate(time.Microsecond)
	input.CapturedAt = input.CapturedAt.Truncate(time.Microsecond)
	if err := validateRestaurantLocation(input, now); err != nil {
		return restaurantLocationResult{}, err
	}
	if courierID == "" || len(courierID) > 128 || len(number) > 64 {
		return restaurantLocationResult{}, restaurantFail(400, "invalid_request")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantLocationResult{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantLocationResult{}, restaurantFail(404, "order_not_found")
	}
	if err != nil {
		return restaurantLocationResult{}, err
	}
	if !restaurantActiveLocationOrder(stored.order) || stored.order.CourierID != courierID {
		return restaurantLocationResult{}, restaurantFail(404, "order_not_found")
	}
	var active bool
	if err = tx.QueryRowContext(ctx, `SELECT active FROM restaurant_couriers WHERE id=$1 FOR SHARE`, courierID).Scan(&active); err != nil {
		return restaurantLocationResult{}, err
	}
	if !active {
		return restaurantLocationResult{}, restaurantFail(401, "unauthorized")
	}
	if stored.order.Version != input.Version {
		return restaurantLocationResult{}, restaurantFail(409, "conflict")
	}
	var previous restaurantCourierLocation
	err = tx.QueryRowContext(ctx, `SELECT latitude,longitude,accuracy,captured_at,received_at,expires_at FROM restaurant_courier_locations WHERE order_number=$1`, stored.order.Number).Scan(&previous.Latitude, &previous.Longitude, &previous.Accuracy, &previous.CapturedAt, &previous.ReceivedAt, &previous.ExpiresAt)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return restaurantLocationResult{}, err
	}
	if err == nil && !input.CapturedAt.After(previous.CapturedAt) {
		if input.CapturedAt.Equal(previous.CapturedAt) && *input.Latitude == previous.Latitude && *input.Longitude == previous.Longitude && *input.Accuracy == previous.Accuracy && previous.ExpiresAt.After(now) {
			previous.Stale = now.Sub(previous.ReceivedAt) > restaurantLocationStaleAfter
			return restaurantLocationResult{Location: &previous}, nil
		}
		return restaurantLocationResult{}, restaurantFail(409, "conflict")
	}
	point := restaurantCourierLocation{Latitude: *input.Latitude, Longitude: *input.Longitude, Accuracy: *input.Accuracy, CapturedAt: input.CapturedAt.UTC(), ReceivedAt: now, ExpiresAt: now.Add(restaurantLocationLifetime)}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_courier_locations(order_number,courier_id,latitude,longitude,accuracy,captured_at,received_at,expires_at)
		VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(order_number) DO UPDATE SET courier_id=EXCLUDED.courier_id,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,accuracy=EXCLUDED.accuracy,captured_at=EXCLUDED.captured_at,received_at=EXCLUDED.received_at,expires_at=EXCLUDED.expires_at`, stored.order.Number, courierID, point.Latitude, point.Longitude, point.Accuracy, point.CapturedAt, point.ReceivedAt, point.ExpiresAt)
	if err != nil {
		return restaurantLocationResult{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantLocationResult{}, err
	}
	return restaurantLocationResult{Location: &point}, nil
}

func (s *restaurantCouriers) StopLocation(ctx context.Context, courierID, number string) error {
	if courierID == "" || len(courierID) > 128 || len(number) > 64 {
		return restaurantFail(400, "invalid_request")
	}
	// Lock and advance the shared order version as a revocation fence. A POST
	// dispatched before Stop cannot recreate a point after this transaction,
	// even if it arrives later. The UI refreshes the job before a new consent.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	if stored.order.CourierID != courierID || !restaurantActiveLocationOrder(stored.order) {
		return nil
	}
	if _, err = tx.ExecContext(ctx, `DELETE FROM restaurant_courier_locations WHERE order_number=$1 AND courier_id=$2`, stored.order.Number, courierID); err != nil {
		return err
	}
	order := stored.order
	order.Version++
	order.UpdatedAt = time.Now().UTC()
	if err = restaurantUpdateOrder(ctx, tx, order); err != nil {
		return err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, order, "courier_location_stopped", map[string]string{"actor": "courier", "courierId": courierID}); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *restaurantCouriers) Location(ctx context.Context, number, token, customerID string, admin bool) (restaurantLocationResult, error) {
	if len(number) > 64 {
		return restaurantLocationResult{}, restaurantFail(404, "invalid_order_access")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantLocationResult{}, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR SHARE`, strings.TrimSpace(number)))
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantLocationResult{}, restaurantFail(404, "invalid_order_access")
	}
	if err != nil {
		return restaurantLocationResult{}, err
	}
	if !admin && !restaurantCanAccess(stored, token, "", customerID) {
		return restaurantLocationResult{}, restaurantFail(404, "invalid_order_access")
	}
	if !restaurantActiveLocationOrder(stored.order) {
		return restaurantLocationResult{}, nil
	}
	var point restaurantCourierLocation
	err = tx.QueryRowContext(ctx, `SELECT l.latitude,l.longitude,l.accuracy,l.captured_at,l.received_at,l.expires_at
		FROM restaurant_courier_locations l JOIN restaurant_couriers c ON c.id=l.courier_id AND c.active
		WHERE l.order_number=$1 AND l.courier_id=$2 AND l.expires_at>now()`, stored.order.Number, stored.order.CourierID).Scan(&point.Latitude, &point.Longitude, &point.Accuracy, &point.CapturedAt, &point.ReceivedAt, &point.ExpiresAt)
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantLocationResult{}, nil
	}
	if err != nil {
		return restaurantLocationResult{}, err
	}
	point.Stale = time.Since(point.ReceivedAt) > restaurantLocationStaleAfter
	if err = tx.Commit(); err != nil {
		return restaurantLocationResult{}, err
	}
	return restaurantLocationResult{Location: &point}, nil
}

// Only new opt-in location rows are affected. No recordings, messages, orders
// or historical customer addresses are part of this short retention worker.
func (s *restaurantCouriers) RunLocationCleanup(ctx context.Context) {
	timer := time.NewTicker(time.Minute)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			cleanupCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
			_, _ = s.db.ExecContext(cleanupCtx, `DELETE FROM restaurant_courier_locations WHERE expires_at<now()`)
			cancel()
		}
	}
}
