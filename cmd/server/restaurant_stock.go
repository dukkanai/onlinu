package main

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"time"
)

// Available is the sellable quantity, excluding reservations and already sold
// portions. Adjusting it is a physical recount, not a reset of active holds.
type restaurantStockItem struct {
	ItemID    string    `json:"itemId"`
	Tracked   bool      `json:"tracked"`
	Available int64     `json:"available"`
	Held      int64     `json:"held"`
	Version   int64     `json:"version"`
	UpdatedAt time.Time `json:"updatedAt"`
}

type restaurantStockInput struct {
	Tracked   bool  `json:"tracked"`
	Available int64 `json:"available"`
	Version   int64 `json:"version"`
}

const restaurantStockHoldDuration = 20 * time.Minute

func restaurantInitStockSchema(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_stock (
	 item_id text PRIMARY KEY, tracked boolean NOT NULL, available bigint NOT NULL CHECK(available>=0),
	 version bigint NOT NULL CHECK(version>0), updated_at timestamptz NOT NULL);
	 CREATE TABLE IF NOT EXISTS restaurant_stock_reservations (
	 order_number text NOT NULL REFERENCES restaurant_orders(number), item_id text NOT NULL REFERENCES restaurant_stock(item_id),
	 quantity bigint NOT NULL CHECK(quantity>0), state text NOT NULL CHECK(state IN ('held','committed','released','wasted')),
	 expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, PRIMARY KEY(order_number,item_id));
	 CREATE INDEX IF NOT EXISTS restaurant_stock_expiry_idx ON restaurant_stock_reservations(expires_at) WHERE state='held';
	 CREATE TABLE IF NOT EXISTS restaurant_stock_events (
	 id bigserial PRIMARY KEY, item_id text NOT NULL, order_number text NOT NULL DEFAULT '', kind text NOT NULL,
	 quantity bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now());`)
	return err
}

func (s *restaurantOrders) ListStock(ctx context.Context) ([]restaurantStockItem, error) {
	catalog, err := loadRestaurantCatalog(ctx, s.store.db, false)
	if err != nil {
		return nil, err
	}
	rows, err := s.store.db.QueryContext(ctx, `SELECT s.item_id,s.tracked,s.available,s.version,s.updated_at,
	 COALESCE((SELECT sum(r.quantity) FROM restaurant_stock_reservations r WHERE r.item_id=s.item_id AND r.state='held'),0)
	 FROM restaurant_stock s`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[string]restaurantStockItem{}
	for rows.Next() {
		var item restaurantStockItem
		if err = rows.Scan(&item.ItemID, &item.Tracked, &item.Available, &item.Version, &item.UpdatedAt, &item.Held); err != nil {
			return nil, err
		}
		byID[item.ItemID] = item
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	items := make([]restaurantStockItem, 0, len(catalog.Items))
	for _, product := range catalog.Items {
		item, exists := byID[product.ID]
		if !exists {
			item.ItemID = product.ID
		}
		items = append(items, item)
	}
	return items, nil
}

func (s *restaurantOrders) SaveStock(ctx context.Context, itemID string, input restaurantStockInput) (restaurantStockItem, error) {
	if input.Version < 0 || input.Available < 0 || input.Available > 1000000 || (!input.Tracked && input.Available != 0) {
		return restaurantStockItem{}, restaurantFail(400, "invalid_request")
	}
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantStockItem{}, err
	}
	defer tx.Rollback()
	// Catalog -> item is also the creation order. A deleted product cannot
	// acquire a new counter halfway through a catalog save.
	catalog, err := loadRestaurantCatalog(ctx, tx, true)
	if err != nil {
		return restaurantStockItem{}, err
	}
	found := false
	for _, item := range catalog.Items {
		if item.ID == itemID {
			found = true
			break
		}
	}
	if !found {
		return restaurantStockItem{}, restaurantFail(404, "item_unavailable")
	}
	if err = restaurantLockStockItem(ctx, tx, itemID); err != nil {
		return restaurantStockItem{}, err
	}
	var previous restaurantStockItem
	err = tx.QueryRowContext(ctx, `SELECT tracked,available,version FROM restaurant_stock WHERE item_id=$1 FOR UPDATE`, itemID).Scan(&previous.Tracked, &previous.Available, &previous.Version)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return restaurantStockItem{}, err
	}
	if input.Version != previous.Version {
		return restaurantStockItem{}, restaurantFail(409, "conflict")
	}
	// Switching accounting mode with unsettled portions would lose their
	// provenance. First finish/release those orders, then change the mode.
	var active int64
	if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM restaurant_stock_reservations r JOIN restaurant_orders o ON o.number=r.order_number WHERE r.item_id=$1 AND r.state IN ('held','committed') AND o.status NOT IN ('completed','cancelled')`, itemID).Scan(&active); err != nil {
		return restaurantStockItem{}, err
	}
	if previous.Version > 0 && previous.Tracked != input.Tracked && active > 0 {
		return restaurantStockItem{}, restaurantFail(409, "conflict")
	}
	now := time.Now().UTC()
	item := restaurantStockItem{ItemID: itemID, Tracked: input.Tracked, Available: input.Available, Version: previous.Version + 1, UpdatedAt: now}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stock(item_id,tracked,available,version,updated_at) VALUES($1,$2,$3,$4,$5)
	 ON CONFLICT(item_id) DO UPDATE SET tracked=EXCLUDED.tracked,available=EXCLUDED.available,version=EXCLUDED.version,updated_at=EXCLUDED.updated_at`, itemID, item.Tracked, item.Available, item.Version, now)
	if err != nil {
		return restaurantStockItem{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stock_events(item_id,kind,quantity) VALUES($1,'recount',$2)`, itemID, item.Available-previous.Available); err != nil {
		return restaurantStockItem{}, err
	}
	if err = tx.QueryRowContext(ctx, `SELECT COALESCE(sum(quantity),0) FROM restaurant_stock_reservations WHERE item_id=$1 AND state='held'`, itemID).Scan(&item.Held); err != nil {
		return restaurantStockItem{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantStockItem{}, err
	}
	return item, nil
}

func restaurantStockQuantities(lines []restaurantOrderLine) ([]string, map[string]int64) {
	quantities := map[string]int64{}
	for _, line := range lines {
		quantities[line.ItemID] += int64(line.Quantity)
	}
	ids := make([]string, 0, len(quantities))
	for id := range quantities {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, quantities
}

// SELECT FOR UPDATE cannot lock a row that does not exist yet. This narrow
// transaction lock makes first-time stock setup and an untracked checkout
// serialize too. The schema component isolates independent restaurant tests
// and deployments sharing one PostgreSQL database.
func restaurantLockStockItem(ctx context.Context, tx *sql.Tx, itemID string) error {
	_, err := tx.ExecContext(ctx, `SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':restaurant-stock:' || $1,0))`, itemID)
	return err
}

func restaurantCheckStock(ctx context.Context, db restaurantCatalogQueryer, lines []restaurantOrderLine) error {
	ids, quantities := restaurantStockQuantities(lines)
	for _, id := range ids {
		var tracked bool
		var available int64
		err := db.QueryRowContext(ctx, `SELECT tracked,available FROM restaurant_stock WHERE item_id=$1`, id).Scan(&tracked, &available)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if tracked && available < quantities[id] {
			return restaurantFail(409, "item_unavailable")
		}
	}
	return nil
}

func restaurantReserveStock(ctx context.Context, tx *sql.Tx, order *restaurantOrder) error {
	ids, quantities := restaurantStockQuantities(order.Items)
	expires := order.CreatedAt.Add(restaurantStockHoldDuration)
	for _, id := range ids {
		if err := restaurantLockStockItem(ctx, tx, id); err != nil {
			return err
		}
		var tracked bool
		var available int64
		err := tx.QueryRowContext(ctx, `SELECT tracked,available FROM restaurant_stock WHERE item_id=$1 FOR UPDATE`, id).Scan(&tracked, &available)
		if errors.Is(err, sql.ErrNoRows) {
			continue
		}
		if err != nil {
			return err
		}
		if !tracked {
			continue
		}
		if available < quantities[id] {
			return restaurantFail(409, "item_unavailable")
		}
		if _, err = tx.ExecContext(ctx, `UPDATE restaurant_stock SET available=available-$2,version=version+1,updated_at=$3 WHERE item_id=$1`, id, quantities[id], order.CreatedAt); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stock_reservations(order_number,item_id,quantity,state,expires_at,updated_at) VALUES($1,$2,$3,'held',$4,$5)`, order.Number, id, quantities[id], expires, order.CreatedAt); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stock_events(item_id,order_number,kind,quantity) VALUES($1,$2,'reserved',$3)`, id, order.Number, -quantities[id]); err != nil {
			return err
		}
		order.StockExpiresAt = &expires
	}
	return nil
}

func restaurantOrderWasPrepared(order restaurantOrder) bool {
	if order.PreparationStartedAt != nil {
		return true
	}
	switch order.Status {
	case "preparing", "ready", "out_for_delivery", "completed":
		return true
	}
	return false
}

// All callers hold the order row first. Reservation/product locks are always
// acquired in lexical product order so payment, cancellation and expiry share
// one lock hierarchy. No provider or other network call occurs in this txn.
func restaurantReconcileOrderStock(ctx context.Context, tx *sql.Tx, order restaurantOrder) error {
	target := ""
	if order.Status == "cancelled" {
		target = "released"
		if restaurantOrderWasPrepared(order) {
			target = "wasted"
		}
	} else if order.Status != "new" || order.Payment.Status == "paid" {
		target = "committed"
	}
	if target == "" {
		return nil
	}
	return restaurantTransitionOrderStock(ctx, tx, order, target)
}

func restaurantTransitionOrderStock(ctx context.Context, tx *sql.Tx, order restaurantOrder, target string) error {
	rows, err := tx.QueryContext(ctx, `SELECT item_id,quantity,state FROM restaurant_stock_reservations WHERE order_number=$1 ORDER BY item_id FOR UPDATE`, order.Number)
	if err != nil {
		return err
	}
	type reservation struct {
		id       string
		quantity int64
		state    string
	}
	var reservations []reservation
	for rows.Next() {
		var r reservation
		if err = rows.Scan(&r.id, &r.quantity, &r.state); err != nil {
			rows.Close()
			return err
		}
		reservations = append(reservations, r)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, r := range reservations {
		if r.state == "released" || r.state == "wasted" || r.state == target {
			continue
		}
		// A committed portion that actually reached preparation never becomes
		// available again merely because a payment/refund changed state.
		if target == "released" {
			if _, err = tx.ExecContext(ctx, `UPDATE restaurant_stock SET available=available+$2,version=version+1,updated_at=$3 WHERE item_id=$1`, r.id, r.quantity, order.UpdatedAt); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, `UPDATE restaurant_stock_reservations SET state=$3,updated_at=$4 WHERE order_number=$1 AND item_id=$2`, order.Number, r.id, target, order.UpdatedAt); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_stock_events(item_id,order_number,kind,quantity) VALUES($1,$2,$3,$4)`, r.id, order.Number, target, r.quantity); err != nil {
			return err
		}
	}
	return nil
}

func restaurantApplyStockAvailability(ctx context.Context, db *sql.DB, catalog *restaurantCatalog) error {
	var exists bool
	if err := db.QueryRowContext(ctx, `SELECT to_regclass('restaurant_stock') IS NOT NULL`).Scan(&exists); err != nil {
		return err
	}
	if !exists {
		return nil
	}
	rows, err := db.QueryContext(ctx, `SELECT item_id FROM restaurant_stock WHERE tracked AND available=0`)
	if err != nil {
		return err
	}
	defer rows.Close()
	empty := map[string]bool{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return err
		}
		empty[id] = true
	}
	if err = rows.Err(); err != nil {
		return err
	}
	for i := range catalog.Items {
		if empty[catalog.Items[i].ID] {
			catalog.Items[i].Available = false
		}
	}
	return nil
}

// Expiry only cancels unpaid NEW orders with no payment attempt at all. A
// timeout/failed browser response is not proof that the bank did not charge.
// Pending, review, accepted or remotely-created payments keep their stock
// until explicit reconciliation/cancellation; late success cannot oversell.
func (s *restaurantOrders) ExpireStockReservations(ctx context.Context, limit int) (int, error) {
	if limit < 1 || limit > 100 {
		limit = 100
	}
	var attemptsTable bool
	if err := s.store.db.QueryRowContext(ctx, `SELECT to_regclass('restaurant_payment_attempts') IS NOT NULL`).Scan(&attemptsTable); err != nil {
		return 0, err
	}
	query := `SELECT DISTINCT r.order_number FROM restaurant_stock_reservations r JOIN restaurant_orders o ON o.number=r.order_number WHERE r.state='held' AND r.expires_at<=now() AND o.status='new' AND o.document->'payment'->>'status'='unpaid'`
	// Excluding uncertain attempts from the candidate page prevents a page of
	// old unresolved attempts starving newer, genuinely unstarted checkouts.
	if attemptsTable {
		query += ` AND NOT EXISTS(SELECT 1 FROM restaurant_payment_attempts p WHERE p.order_number=o.number)`
	}
	query += ` ORDER BY r.order_number LIMIT $1`
	rows, err := s.store.db.QueryContext(ctx, query, limit)
	if err != nil {
		return 0, err
	}
	var numbers []string
	for rows.Next() {
		var n string
		if err = rows.Scan(&n); err != nil {
			rows.Close()
			return 0, err
		}
		numbers = append(numbers, n)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return 0, err
	}
	rows.Close()
	count := 0
	for _, number := range numbers {
		ok, err := s.expireStockOrder(ctx, number)
		if err != nil {
			return count, err
		}
		if ok {
			count++
		}
	}
	return count, nil
}

func (s *restaurantOrders) expireStockOrder(ctx context.Context, number string) (bool, error) {
	tx, err := s.store.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	stored, err := restaurantReadStored(tx.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1 FOR UPDATE`, number))
	if err != nil {
		return false, err
	}
	o := stored.order
	if o.Status != "new" || o.Payment.Status != "unpaid" || restaurantOrderWasPrepared(o) || o.StockExpiresAt == nil || o.StockExpiresAt.After(time.Now()) {
		return false, nil
	}
	var attemptsTable bool
	if err = tx.QueryRowContext(ctx, `SELECT to_regclass('restaurant_payment_attempts') IS NOT NULL`).Scan(&attemptsTable); err != nil {
		return false, err
	}
	if attemptsTable {
		var attempted bool
		if err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM restaurant_payment_attempts WHERE order_number=$1)`, number).Scan(&attempted); err != nil {
			return false, err
		}
		if attempted {
			return false, nil
		}
	}
	o.Status = "cancelled"
	o.Version++
	o.UpdatedAt = time.Now().UTC()
	if err = restaurantUpdateOrder(ctx, tx, o); err != nil {
		return false, err
	}
	if err = restaurantWriteOrderEvent(ctx, tx, o, "stock_expired", map[string]string{"reason": "checkout_not_completed"}); err != nil {
		return false, err
	}
	if err = tx.Commit(); err != nil {
		return false, err
	}
	return true, nil
}
