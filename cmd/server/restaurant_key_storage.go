package main

// External-mode key state. All database identifiers originate in trusted
// deployment configuration, never in the envelope or stored metadata.
import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"database/sql"
	"encoding/json"
	"errors"
)

const (
	restaurantOrderDataKeyID   = "order-dek-v1"
	restaurantPaymentDataKeyID = "payment-dek-v1"
	restaurantKeyStateTable    = "restaurant_key_state"
	restaurantKeyFence         = "restaurant_external_key_fence"
)

var errRestaurantKeyState = errors.New("restaurant encryption state unavailable; owned offline maintenance required")
var errRestaurantKeyCommit = errors.New("restaurant encryption maintenance outcome uncertain; verify with retained keyring before retrying")

type restaurantDataCiphers struct{ orders, payments cipher.AEAD }

type restaurantStoredKeys struct {
	orders, payments []byte
	wrappingKeyID    string
}

func (k *restaurantStoredKeys) clear() {
	if k != nil {
		clear(k.orders)
		clear(k.payments)
	}
}
func restaurantDataCipher(key []byte) (cipher.AEAD, error) {
	if len(key) != restaurantDEKSize {
		return nil, errRestaurantKeyState
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errRestaurantKeyState
	}
	seal, err := cipher.NewGCM(block)
	if err != nil {
		return nil, errRestaurantKeyState
	}
	return seal, nil
}
func (k *restaurantStoredKeys) ciphers() (*restaurantDataCiphers, error) {
	orders, err := restaurantDataCipher(k.orders)
	if err != nil {
		return nil, err
	}
	payments, err := restaurantDataCipher(k.payments)
	if err != nil {
		return nil, err
	}
	return &restaurantDataCiphers{orders: orders, payments: payments}, nil
}
func restaurantCryptoSQLName(name string) bool {
	if len(name) == 0 || len(name) > 63 {
		return false
	}
	for i := range name {
		c := name[i]
		if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_') {
			return false
		}
	}
	return true
}
func restaurantCryptoTable(schema, table string) string {
	return quoteIdent(schema) + "." + quoteIdent(table)
}

// The existing ownership session also executes the transaction. Losing it
// releases the lock AND aborts maintenance; a second pooled session cannot
// commit after ownership has silently disappeared.
func restaurantCryptoTx(ctx context.Context, owner *instanceOwnership, database, schema string, readOnly bool) (*sql.Tx, error) {
	if !restaurantCryptoSQLName(database) || !restaurantCryptoSQLName(schema) || owner == nil || owner.check(ctx) != nil {
		return nil, errRestaurantKeyState
	}
	tx, err := owner.conn.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelSerializable, ReadOnly: readOnly})
	if err != nil {
		return nil, errRestaurantKeyState
	}
	var actualDB, actualSchema, searchPath string
	err = tx.QueryRowContext(ctx, `SELECT current_database(), current_schema(), array_to_string(current_schemas(false), ',')`).Scan(&actualDB, &actualSchema, &searchPath)
	if err != nil || actualDB != database || actualSchema != schema || searchPath != schema {
		_ = tx.Rollback()
		return nil, errRestaurantKeyState
	}
	return tx, nil
}

// Any marker, including partial or corrupt state, fences this newer binary's
// legacy startup before ordinary schema setup. Old binaries meet CHECK(false)
// when their unconditional legacy key INSERT runs and therefore cannot serve.
func restaurantRefuseExternalDatabase(ctx context.Context, owner *instanceOwnership, database, _ string) error {
	// Preserve pre-existing legacy namespace/search-path compatibility. The
	// downgrade marker is checked across the whole selected database, so a
	// changed search_path cannot hide a migrated schema and regenerate keys.
	if owner == nil || owner.check(ctx) != nil {
		return errRestaurantKeyState
	}
	tx, err := owner.conn.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return errRestaurantKeyState
	}
	defer tx.Rollback()
	var actualDB string
	if tx.QueryRowContext(ctx, `SELECT current_database()`).Scan(&actualDB) != nil || actualDB != database {
		return errRestaurantKeyState
	}
	var present bool
	err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class WHERE relname=$1) OR EXISTS(SELECT 1 FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class c ON c.oid=x.conrelid WHERE x.conname=$2 AND c.relname IN ('restaurant_order_secret','restaurant_payment_secret'))`, restaurantKeyStateTable, restaurantKeyFence).Scan(&present)
	if err != nil || present {
		return errRestaurantKeyState
	}
	if tx.Commit() != nil {
		return errRestaurantKeyState
	}
	return nil
}

// Column signatures deliberately pin this maintenance format to the reviewed
// schema. Unknown columns/types, shadow views, partitioning/inheritance, rules,
// RLS and key-control-table user triggers require a new reviewed migration.
// Payload DML triggers are preserved: maintenance only SELECTs those tables.
type restaurantCryptoColumn struct {
	name, kind string
	notNull    bool
}

var restaurantCryptoSchemas = map[string][]restaurantCryptoColumn{
	"restaurant_order_secret":     {{"id", "int4", true}, {"secret", "bytea", true}},
	"restaurant_payment_secret":   {{"id", "int4", true}, {"secret", "bytea", true}},
	"restaurant_key_state":        {{"id", "int4", true}, {"version", "int4", true}, {"store_id", "text", true}, {"database_name", "text", true}, {"schema_name", "text", true}, {"order_envelope", "bytea", true}, {"payment_envelope", "bytea", true}},
	"restaurant_orders":           {{"number", "text", true}, {"customer_id", "text", true}, {"status", "text", true}, {"version", "int8", true}, {"document", "jsonb", true}, {"token_hash", "bytea", true}, {"code_hash", "bytea", true}, {"sealed_secrets", "bytea", true}, {"request_hash", "bytea", true}, {"idempotency_hash", "bytea", true}, {"created_at", "timestamptz", true}, {"updated_at", "timestamptz", true}},
	"restaurant_payment_configs":  {{"provider", "text", true}, {"sealed", "bytea", true}, {"updated_at", "timestamptz", true}},
	"restaurant_payment_attempts": {{"id", "text", true}, {"order_number", "text", true}, {"provider", "text", true}, {"mode", "text", true}, {"status", "text", true}, {"remote_id", "text", true}, {"url", "text", true}, {"widget", "jsonb", false}, {"sealed_config", "bytea", true}, {"created_at", "timestamptz", true}, {"updated_at", "timestamptz", true}, {"checked_at", "timestamptz", false}, {"needs_refresh", "bool", true}, {"refresh_version", "int8", true}, {"capture_verified", "bool", true}, {"captured_minor", "int8", true}, {"settlement_watch_started_at", "timestamptz", false}},
}

func restaurantCryptoTableExists(ctx context.Context, tx *sql.Tx, schema, table string) (bool, error) {
	var present bool
	err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2)`, schema, table).Scan(&present)
	if err != nil {
		return false, errRestaurantKeyState
	}
	return present, nil
}
func restaurantCheckCryptoTable(ctx context.Context, tx *sql.Tx, schema, table string) error {
	expected, ok := restaurantCryptoSchemas[table]
	if !ok {
		return errRestaurantKeyState
	}
	var safe bool
	err := tx.QueryRowContext(ctx, `SELECT c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity AND NOT c.relforcerowsecurity AND NOT c.relispartition AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) AND (c.relname NOT IN ('restaurant_order_secret','restaurant_payment_secret','restaurant_key_state') OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.tgrelid=c.oid AND NOT t.tgisinternal)) AND NOT EXISTS(SELECT 1 FROM pg_catalog.pg_rewrite r WHERE r.ev_class=c.oid) AND (c.relname NOT IN ('restaurant_order_secret','restaurant_payment_secret','restaurant_key_state') OR NOT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint f WHERE f.contype='f' AND (f.conrelid=c.oid OR f.confrelid=c.oid))) FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2`, schema, table).Scan(&safe)
	if err != nil || !safe {
		return errRestaurantKeyState
	}
	rows, err := tx.QueryContext(ctx, `SELECT a.attname,CASE WHEN tn.nspname='pg_catalog' THEN t.typname ELSE 'unsupported' END,a.attnotnull FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace JOIN pg_catalog.pg_type t ON t.oid=a.atttypid JOIN pg_catalog.pg_namespace tn ON tn.oid=t.typnamespace WHERE n.nspname=$1 AND c.relname=$2 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`, schema, table)
	if err != nil {
		return errRestaurantKeyState
	}
	defer rows.Close()
	i := 0
	for rows.Next() {
		var got restaurantCryptoColumn
		if rows.Scan(&got.name, &got.kind, &got.notNull) != nil || i >= len(expected) || got != expected[i] {
			return errRestaurantKeyState
		}
		i++
	}
	if rows.Err() != nil || i != len(expected) {
		return errRestaurantKeyState
	}
	return nil
}
func restaurantCheckKeyFences(ctx context.Context, tx *sql.Tx, schema string) error {
	for _, table := range []string{"restaurant_order_secret", "restaurant_payment_secret"} {
		if restaurantCheckCryptoTable(ctx, tx, schema, table) != nil {
			return errRestaurantKeyState
		}
		var valid bool
		var count int
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class c ON c.oid=x.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname=$2 AND x.conname=$3 AND x.contype='c' AND x.convalidated AND pg_catalog.pg_get_expr(x.conbin,x.conrelid)='false')`, schema, table, restaurantKeyFence).Scan(&valid)
		if err != nil || !valid {
			return errRestaurantKeyState
		}
		if tx.QueryRowContext(ctx, `SELECT count(*) FROM `+restaurantCryptoTable(schema, table)).Scan(&count) != nil || count != 0 {
			return errRestaurantKeyState
		}
	}
	return nil
}
func restaurantReadExternalKeys(ctx context.Context, tx *sql.Tx, database, schema string, ring *restaurantKeyring) (*restaurantStoredKeys, error) {
	if ring == nil || restaurantCheckCryptoTable(ctx, tx, schema, restaurantKeyStateTable) != nil || restaurantCheckKeyFences(ctx, tx, schema) != nil {
		return nil, errRestaurantKeyState
	}
	rows, err := tx.QueryContext(ctx, `SELECT id,version,store_id,database_name,schema_name,order_envelope,payment_envelope FROM `+restaurantCryptoTable(schema, restaurantKeyStateTable))
	if err != nil {
		return nil, errRestaurantKeyState
	}
	defer rows.Close()
	var id, version int
	var store, dbName, schemaName string
	var orderEnvelope, paymentEnvelope []byte
	if !rows.Next() || rows.Scan(&id, &version, &store, &dbName, &schemaName, &orderEnvelope, &paymentEnvelope) != nil || rows.Next() || rows.Err() != nil || id != 1 || version != 1 || store != ring.storeID || dbName != database || schemaName != schema {
		return nil, errRestaurantKeyState
	}
	keys := &restaurantStoredKeys{}
	keys.orders, err = ring.unwrap(restaurantOrderKeyPurpose, restaurantOrderDataKeyID, orderEnvelope)
	if err == nil {
		keys.payments, err = ring.unwrap(restaurantPaymentKeyPurpose, restaurantPaymentDataKeyID, paymentEnvelope)
	}
	if err != nil {
		keys.clear()
		return nil, errRestaurantKeyState
	}
	// Both envelopes always move atomically under one wrapping-key generation.
	var orderMetadata, paymentMetadata restaurantKeyEnvelope
	_ = json.Unmarshal(orderEnvelope, &orderMetadata)
	_ = json.Unmarshal(paymentEnvelope, &paymentMetadata)
	if orderMetadata.WrappingKeyID != paymentMetadata.WrappingKeyID {
		keys.clear()
		return nil, errRestaurantKeyState
	}
	keys.wrappingKeyID = orderMetadata.WrappingKeyID
	return keys, nil
}
func restaurantLoadExternalKeys(ctx context.Context, owner *instanceOwnership, database, schema string, ring *restaurantKeyring) (*restaurantDataCiphers, error) {
	if ring == nil {
		return nil, errRestaurantKeyState
	}
	tx, err := restaurantCryptoTx(ctx, owner, database, schema, true)
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	keys, err := restaurantReadExternalKeys(ctx, tx, database, schema, ring)
	if err != nil {
		return nil, err
	}
	defer keys.clear()
	ciphers, err := keys.ciphers()
	if err != nil {
		return nil, err
	}
	if tx.Commit() != nil {
		return nil, errRestaurantKeyState
	}
	return ciphers, nil
}
