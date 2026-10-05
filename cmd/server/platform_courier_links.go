package main

import (
	"context"
	"database/sql"
	"errors"
	"github.com/jackc/pgx/v5/pgconn"
	"regexp"
)

var platformCourierIDPattern = regexp.MustCompile(`^[a-f0-9]{32}$`)
var platformPrincipalRefPattern = regexp.MustCompile(`^platform:[a-f0-9]{64}$`)

type platformCourierBindingKey struct{}
type platformCourierBinding struct {
	OwnerRef string
	Version  int64
	CashOnly bool
}
type platformCourierLink struct {
	platformStaffCourier
	Version      int64   `json:"version"`
	OwnerRef     *string `json:"ownerRef"`
	ActiveOrders int64   `json:"activeOrders"`
}
type platformCourierLinkInput struct {
	ExpectedVersion *int64  `json:"expectedVersion"`
	OwnerRef        *string `json:"ownerRef"` // Empty string is an explicit unlink; missing/null is invalid.
}

func initPlatformCourierSchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS platform_courier_links (
 courier_id TEXT PRIMARY KEY REFERENCES restaurant_couriers(id),owner_ref TEXT UNIQUE CHECK(owner_ref IS NULL OR owner_ref ~ '^platform:[a-f0-9]{64}$'),
 version BIGINT NOT NULL CHECK(version>0 AND version<=9007199254740991),updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
 CREATE TABLE IF NOT EXISTS platform_courier_audit (
 id BIGSERIAL PRIMARY KEY,courier_id TEXT NOT NULL REFERENCES restaurant_couriers(id),version BIGINT NOT NULL,
 actor_id TEXT NOT NULL,scope TEXT NOT NULL,action TEXT NOT NULL,from_owner TEXT,to_owner TEXT,detail JSONB NOT NULL DEFAULT '{}',created_at TIMESTAMPTZ NOT NULL DEFAULT now());`)
	return err
}

const platformActiveCourierOrders = `SELECT count(*) FROM restaurant_orders WHERE document->>'courierId'=$1 AND document->>'mode'='delivery' AND status NOT IN ('completed','cancelled') AND COALESCE(document->>'deliveryStatus','')<>'delivered'`

func (s *restaurantCouriers) PlatformLinks(ctx context.Context) ([]platformCourierLink, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT c.id,c.name,c.active,c.availability,COALESCE(l.version,0),l.owner_ref,
 (SELECT count(*) FROM restaurant_orders o WHERE o.document->>'courierId'=c.id AND o.document->>'mode'='delivery' AND o.status NOT IN ('completed','cancelled') AND COALESCE(o.document->>'deliveryStatus','')<>'delivered')
 FROM restaurant_couriers c LEFT JOIN platform_courier_links l ON l.courier_id=c.id ORDER BY c.active DESC,c.name,c.id LIMIT 500`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []platformCourierLink{}
	for rows.Next() {
		var item platformCourierLink
		var ref sql.NullString
		if err = rows.Scan(&item.ID, &item.Name, &item.Active, &item.Availability, &item.Version, &ref, &item.ActiveOrders); err != nil {
			return nil, err
		}
		if ref.Valid {
			v := ref.String
			item.OwnerRef = &v
		}
		result = append(result, item)
	}
	return result, rows.Err()
}
func (s *restaurantCouriers) SetPlatformLink(ctx context.Context, courierID string, input platformCourierLinkInput) (platformCourierLink, error) {
	if !platformCourierIDPattern.MatchString(courierID) || input.ExpectedVersion == nil || *input.ExpectedVersion < 0 || *input.ExpectedVersion >= 9007199254740991 || input.OwnerRef == nil || *input.OwnerRef != "" && !platformPrincipalRefPattern.MatchString(*input.OwnerRef) {
		return platformCourierLink{}, restaurantFail(400, "invalid_request")
	}
	actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor)
	if !ok || actor.Scope != "staff:couriers:link" {
		return platformCourierLink{}, restaurantFail(403, "forbidden")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return platformCourierLink{}, err
	}
	defer tx.Rollback()
	var result platformCourierLink
	err = tx.QueryRowContext(ctx, `SELECT id,name,active,availability FROM restaurant_couriers WHERE id=$1 FOR UPDATE`, courierID).Scan(&result.ID, &result.Name, &result.Active, &result.Availability)
	if errors.Is(err, sql.ErrNoRows) {
		return result, restaurantFail(404, "not_found")
	}
	if err != nil {
		return result, err
	}
	var previous sql.NullString
	var version int64
	err = tx.QueryRowContext(ctx, `SELECT owner_ref,version FROM platform_courier_links WHERE courier_id=$1 FOR UPDATE`, courierID).Scan(&previous, &version)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return result, err
	}
	if version != *input.ExpectedVersion {
		return result, restaurantFail(409, "conflict")
	}
	if err = tx.QueryRowContext(ctx, platformActiveCourierOrders, courierID).Scan(&result.ActiveOrders); err != nil {
		return result, err
	}
	target := *input.OwnerRef
	if target != "" && (!result.Active || result.ActiveOrders > 0 && (!previous.Valid || previous.String != target)) {
		return result, restaurantFail(409, "conflict")
	}
	var stored any
	if target != "" {
		stored = target
		result.OwnerRef = &target
	}
	result.Version = version + 1
	_, err = tx.ExecContext(ctx, `INSERT INTO platform_courier_links(courier_id,owner_ref,version) VALUES($1,$2,$3) ON CONFLICT(courier_id) DO UPDATE SET owner_ref=EXCLUDED.owner_ref,version=EXCLUDED.version,updated_at=now()`, courierID, stored, result.Version)
	if err != nil {
		var pgerr *pgconn.PgError
		if errors.As(err, &pgerr) && pgerr.Code == "23505" {
			return result, restaurantFail(409, "conflict")
		}
		return result, err
	}
	var before any
	if previous.Valid {
		before = previous.String
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO platform_courier_audit(courier_id,version,actor_id,scope,action,from_owner,to_owner) VALUES($1,$2,$3,$4,'link_changed',$5,$6)`, courierID, result.Version, actor.ID, actor.Scope, before, stored)
	if err != nil {
		return result, err
	}
	if err = tx.Commit(); err != nil {
		return result, err
	}
	return result, nil
}
func (s *restaurantCouriers) BoundPlatformCourier(ctx context.Context, ownerRef string) (platformCourierLink, bool, error) {
	var result platformCourierLink
	err := s.db.QueryRowContext(ctx, `SELECT c.id,c.name,c.active,c.availability,l.version FROM restaurant_couriers c JOIN platform_courier_links l ON l.courier_id=c.id WHERE l.owner_ref=$1 AND c.active`, ownerRef).Scan(&result.ID, &result.Name, &result.Active, &result.Availability, &result.Version)
	if errors.Is(err, sql.ErrNoRows) {
		return result, false, nil
	}
	if err != nil {
		return result, false, err
	}
	result.OwnerRef = &ownerRef
	return result, true, nil
}
func verifyPlatformCourierBinding(ctx context.Context, tx *sql.Tx, courierID string) error {
	binding, ok := ctx.Value(platformCourierBindingKey{}).(platformCourierBinding)
	if !ok {
		return nil
	}
	var ref sql.NullString
	var version int64
	err := tx.QueryRowContext(ctx, `SELECT owner_ref,version FROM platform_courier_links WHERE courier_id=$1 FOR SHARE`, courierID).Scan(&ref, &version)
	if errors.Is(err, sql.ErrNoRows) || err == nil && (!ref.Valid || ref.String != binding.OwnerRef || version != binding.Version) {
		return restaurantFail(403, "forbidden")
	}
	return err
}

func (s *restaurantCouriers) setPlatformAvailability(ctx context.Context, id, value string) (restaurantCourier, error) {
	if value != "available" && value != "busy" && value != "offline" {
		return restaurantCourier{}, restaurantFail(400, "invalid_request")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantCourier{}, err
	}
	defer tx.Rollback()
	courier, err := scanRestaurantCourier(tx.QueryRowContext(ctx, `SELECT `+restaurantCourierColumns+` FROM restaurant_couriers WHERE id=$1 FOR UPDATE`, id))
	if errors.Is(err, sql.ErrNoRows) || err == nil && !courier.Active {
		return restaurantCourier{}, restaurantFail(403, "forbidden")
	}
	if err != nil {
		return restaurantCourier{}, err
	}
	if err = verifyPlatformCourierBinding(ctx, tx, id); err != nil {
		return restaurantCourier{}, err
	}
	previous := courier.Availability
	courier, err = scanRestaurantCourier(tx.QueryRowContext(ctx, `UPDATE restaurant_couriers SET availability=$2,updated_at=now() WHERE id=$1 RETURNING `+restaurantCourierColumns, id, value))
	if err != nil {
		return restaurantCourier{}, err
	}
	binding := ctx.Value(platformCourierBindingKey{}).(platformCourierBinding)
	_, err = tx.ExecContext(ctx, `INSERT INTO platform_courier_audit(courier_id,version,actor_id,scope,action,from_owner,to_owner,detail) VALUES($1,$2,$3,'courier:availability:update','availability_changed',$3,$3,jsonb_build_object('from',$4::text,'to',$5::text))`, id, binding.Version, binding.OwnerRef, previous, value)
	if err != nil {
		return restaurantCourier{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantCourier{}, err
	}
	return courier, nil
}
