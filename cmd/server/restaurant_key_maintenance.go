package main

// These operations are never called by ordinary startup. Operators must stop
// the application and explicitly select owned offline maintenance. Supplying
// its code does not authorize executing it against a real database or keyring.
import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
)

func restaurantKeyCheckpoint(fault func(string) error, stage string) error {
	if fault != nil && fault(stage) != nil {
		return errRestaurantKeyState
	}
	return nil
}
func restaurantCryptoLock(ctx context.Context, tx *sql.Tx, schema string, tables ...string) error {
	for _, table := range tables {
		if _, err := tx.ExecContext(ctx, `LOCK TABLE `+restaurantCryptoTable(schema, table)+` IN ACCESS EXCLUSIVE MODE NOWAIT`); err != nil {
			return errRestaurantKeyState
		}
	}
	return nil
}
func restaurantReadLegacyKeys(ctx context.Context, tx *sql.Tx, schema string) (*restaurantStoredKeys, error) {
	keys := &restaurantStoredKeys{}
	for i, table := range []string{"restaurant_order_secret", "restaurant_payment_secret"} {
		if restaurantCheckCryptoTable(ctx, tx, schema, table) != nil {
			keys.clear()
			return nil, errRestaurantKeyState
		}
		rows, err := tx.QueryContext(ctx, `SELECT id,secret FROM `+restaurantCryptoTable(schema, table))
		if err != nil {
			keys.clear()
			return nil, errRestaurantKeyState
		}
		var id int
		var key []byte
		valid := rows.Next() && rows.Scan(&id, &key) == nil && !rows.Next() && rows.Err() == nil && id == 1 && len(key) == restaurantDEKSize
		_ = rows.Close()
		if !valid {
			clear(key)
			keys.clear()
			return nil, errRestaurantKeyState
		}
		if i == 0 {
			keys.orders = key
		} else {
			keys.payments = key
		}
	}
	return keys, nil
}

// Authenticate every dependent value using the unchanged application codecs.
// No payload bytes are rewritten. Receipt hashes and config row identities are
// checked too; successful AEAD alone must not hide an unusable legacy value.
func restaurantValidateCryptoPayloads(ctx context.Context, tx *sql.Tx, schema string, keys *restaurantStoredKeys, allowEmpty bool) error {
	present := 0
	for _, table := range []string{"restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts"} {
		exists, err := restaurantCryptoTableExists(ctx, tx, schema, table)
		if err != nil {
			return err
		}
		if exists {
			present++
		}
	}
	if allowEmpty && present == 0 {
		return nil
	}
	if present != 3 {
		return errRestaurantKeyState
	}
	if restaurantCryptoLock(ctx, tx, schema, "restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts") != nil {
		return errRestaurantKeyState
	}
	for _, table := range []string{"restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts"} {
		if restaurantCheckCryptoTable(ctx, tx, schema, table) != nil {
			return errRestaurantKeyState
		}
	}
	ciphers, err := keys.ciphers()
	if err != nil {
		return err
	}
	orders := &restaurantOrders{seal: ciphers.orders}
	rows, err := tx.QueryContext(ctx, `SELECT number,sealed_secrets,token_hash,code_hash FROM `+restaurantCryptoTable(schema, "restaurant_orders"))
	if err != nil {
		return errRestaurantKeyState
	}
	for rows.Next() {
		var number string
		var sealed, tokenHash, codeHash []byte
		if rows.Scan(&number, &sealed, &tokenHash, &codeHash) != nil {
			_ = rows.Close()
			return errRestaurantKeyState
		}
		receipt, err := orders.receipt(restaurantOrderStored{order: restaurantOrder{Number: number}, sealedSecrets: sealed})
		if err != nil || receipt.TrackingToken == "" || receipt.AccessCode == "" {
			_ = rows.Close()
			return errRestaurantKeyState
		}
		actualToken := sha256.Sum256([]byte(receipt.TrackingToken))
		actualCode := restaurantCodeHash(number, receipt.AccessCode)
		if subtle.ConstantTimeCompare(actualToken[:], tokenHash) != 1 || subtle.ConstantTimeCompare(actualCode[:], codeHash) != 1 {
			_ = rows.Close()
			return errRestaurantKeyState
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return errRestaurantKeyState
	}
	payments := &restaurantPayments{seal: ciphers.payments}
	rows, err = tx.QueryContext(ctx, `SELECT provider,sealed FROM `+restaurantCryptoTable(schema, "restaurant_payment_configs"))
	if err != nil {
		return errRestaurantKeyState
	}
	for rows.Next() {
		var provider string
		var sealed []byte
		if rows.Scan(&provider, &sealed) != nil {
			_ = rows.Close()
			return errRestaurantKeyState
		}
		cfg, err := payments.decrypt("config:"+provider, sealed)
		if err != nil || cfg.ID != provider {
			_ = rows.Close()
			return errRestaurantKeyState
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return errRestaurantKeyState
	}
	rows, err = tx.QueryContext(ctx, `SELECT id,provider,mode,sealed_config FROM `+restaurantCryptoTable(schema, "restaurant_payment_attempts"))
	if err != nil {
		return errRestaurantKeyState
	}
	for rows.Next() {
		var id, provider, mode string
		var sealed []byte
		if rows.Scan(&id, &provider, &mode, &sealed) != nil {
			_ = rows.Close()
			return errRestaurantKeyState
		}
		cfg, err := payments.decrypt("attempt:"+id, sealed)
		if err != nil || cfg.ID != provider || cfg.Mode != mode {
			_ = rows.Close()
			return errRestaurantKeyState
		}
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil {
		return errRestaurantKeyState
	}
	return nil
}
func restaurantWrapStoredKeys(ring *restaurantKeyring, keys *restaurantStoredKeys) ([]byte, []byte, error) {
	orderEnvelope, err := ring.wrap(restaurantOrderKeyPurpose, restaurantOrderDataKeyID, keys.orders)
	if err != nil {
		return nil, nil, errRestaurantKeyState
	}
	paymentEnvelope, err := ring.wrap(restaurantPaymentKeyPurpose, restaurantPaymentDataKeyID, keys.payments)
	if err != nil {
		return nil, nil, errRestaurantKeyState
	}
	for _, entry := range []struct {
		purpose, id   string
		envelope, key []byte
	}{{restaurantOrderKeyPurpose, restaurantOrderDataKeyID, orderEnvelope, keys.orders}, {restaurantPaymentKeyPurpose, restaurantPaymentDataKeyID, paymentEnvelope, keys.payments}} {
		plain, err := ring.unwrap(entry.purpose, entry.id, entry.envelope)
		equal := subtle.ConstantTimeCompare(plain, entry.key) == 1
		clear(plain)
		if err != nil || !equal {
			return nil, nil, errRestaurantKeyState
		}
	}
	return orderEnvelope, paymentEnvelope, nil
}

// An error after COMMIT can mean the operation succeeded. Never replay writes
// automatically: retained keyrings plus verify/migrate rerun establish state.
func restaurantCommitKeyMaintenance(tx *sql.Tx, fault func(string) error) error {
	if restaurantKeyCheckpoint(fault, "before_commit") != nil {
		return errRestaurantKeyState
	}
	if tx.Commit() != nil {
		return errRestaurantKeyCommit
	}
	if restaurantKeyCheckpoint(fault, "after_commit") != nil {
		return errRestaurantKeyCommit
	}
	return nil
}
func restaurantMaintainKeys(ctx context.Context, owner *instanceOwnership, database, schema string, ring *restaurantKeyring, command string, fault func(string) error) error {
	if ring == nil || (command != "init" && command != "migrate" && command != "rotate" && command != "verify") {
		return errRestaurantKeyState
	}
	tx, err := restaurantCryptoTx(ctx, owner, database, schema, false)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	exists, err := restaurantCryptoTableExists(ctx, tx, schema, restaurantKeyStateTable)
	if err != nil {
		return err
	}
	if exists {
		if restaurantCryptoLock(ctx, tx, schema, restaurantKeyStateTable, "restaurant_order_secret", "restaurant_payment_secret") != nil {
			return errRestaurantKeyState
		}
		keys, err := restaurantReadExternalKeys(ctx, tx, database, schema, ring)
		if err != nil {
			return err
		}
		defer keys.clear()
		if restaurantValidateCryptoPayloads(ctx, tx, schema, keys, true) != nil {
			return errRestaurantKeyState
		}
		if command != "rotate" || keys.wrappingKeyID == ring.activeKeyID {
			return restaurantCommitKeyMaintenance(tx, fault)
		}
		orderEnvelope, paymentEnvelope, err := restaurantWrapStoredKeys(ring, keys)
		if err != nil {
			return err
		}
		if restaurantKeyCheckpoint(fault, "before_state") != nil {
			return errRestaurantKeyState
		}
		result, err := tx.ExecContext(ctx, `UPDATE `+restaurantCryptoTable(schema, restaurantKeyStateTable)+` SET order_envelope=$1,payment_envelope=$2 WHERE id=1`, orderEnvelope, paymentEnvelope)
		if err != nil {
			return errRestaurantKeyState
		}
		count, err := result.RowsAffected()
		if err != nil || count != 1 {
			return errRestaurantKeyState
		}
		if restaurantKeyCheckpoint(fault, "after_state") != nil {
			return errRestaurantKeyState
		}
		verified, err := restaurantReadExternalKeys(ctx, tx, database, schema, ring)
		if err != nil {
			return err
		}
		defer verified.clear()
		if !bytes.Equal(keys.orders, verified.orders) || !bytes.Equal(keys.payments, verified.payments) || verified.wrappingKeyID != ring.activeKeyID {
			return errRestaurantKeyState
		}
		return restaurantCommitKeyMaintenance(tx, fault)
	}
	if command == "rotate" || command == "verify" {
		return errRestaurantKeyState
	}
	var keys *restaurantStoredKeys
	if command == "init" {
		var count int
		if tx.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.relnamespace=n.oid)+(SELECT count(*) FROM pg_catalog.pg_depend d WHERE d.refclassid='pg_catalog.pg_namespace'::regclass AND d.refobjid=n.oid) FROM pg_catalog.pg_namespace n WHERE n.nspname=$1`, schema).Scan(&count) != nil || count != 0 {
			return errRestaurantKeyState
		}
		// Explicit, empty-database initialization is the ONLY new payload-key path
		// in external mode. No KEK is created; it must already exist outside the DB.
		keys = &restaurantStoredKeys{orders: make([]byte, restaurantDEKSize), payments: make([]byte, restaurantDEKSize)}
		defer keys.clear()
		if _, err = rand.Read(keys.orders); err != nil {
			return errRestaurantKeyState
		}
		if _, err = rand.Read(keys.payments); err != nil {
			return errRestaurantKeyState
		}
	} else {
		if restaurantCryptoLock(ctx, tx, schema, "restaurant_order_secret", "restaurant_payment_secret", "restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts") != nil {
			return errRestaurantKeyState
		}
		// A surviving fence with missing metadata is contradictory state. Do not
		// restore legacy behavior or reinterpret it as a fresh migration.
		var fenced bool
		if tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_constraint x JOIN pg_catalog.pg_class c ON c.oid=x.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname IN ('restaurant_order_secret','restaurant_payment_secret') AND x.conname=$2)`, schema, restaurantKeyFence).Scan(&fenced) != nil || fenced {
			return errRestaurantKeyState
		}
		keys, err = restaurantReadLegacyKeys(ctx, tx, schema)
		if err != nil {
			return err
		}
		defer keys.clear()
		if restaurantValidateCryptoPayloads(ctx, tx, schema, keys, false) != nil {
			return errRestaurantKeyState
		}
	}
	orderEnvelope, paymentEnvelope, err := restaurantWrapStoredKeys(ring, keys)
	if err != nil {
		return err
	}
	if restaurantKeyCheckpoint(fault, "before_state") != nil {
		return errRestaurantKeyState
	}
	if _, err = tx.ExecContext(ctx, `CREATE TABLE `+restaurantCryptoTable(schema, restaurantKeyStateTable)+` (id integer PRIMARY KEY CHECK(id=1),version integer NOT NULL CHECK(version=1),store_id text NOT NULL,database_name text NOT NULL,schema_name text NOT NULL,order_envelope bytea NOT NULL CHECK(octet_length(order_envelope)<=4096),payment_envelope bytea NOT NULL CHECK(octet_length(payment_envelope)<=4096))`); err != nil {
		return errRestaurantKeyState
	}
	if restaurantKeyCheckpoint(fault, "before_state_insert") != nil {
		return errRestaurantKeyState
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO `+restaurantCryptoTable(schema, restaurantKeyStateTable)+` (id,version,store_id,database_name,schema_name,order_envelope,payment_envelope) VALUES(1,1,$1,$2,$3,$4,$5)`, ring.storeID, database, schema, orderEnvelope, paymentEnvelope); err != nil {
		return errRestaurantKeyState
	}
	if restaurantKeyCheckpoint(fault, "after_state") != nil {
		return errRestaurantKeyState
	}
	for i, table := range []string{"restaurant_order_secret", "restaurant_payment_secret"} {
		purpose := []string{"order", "payment"}[i]
		if command == "init" {
			if restaurantKeyCheckpoint(fault, "before_"+purpose+"_table") != nil {
				return errRestaurantKeyState
			}
			if _, err = tx.ExecContext(ctx, `CREATE TABLE `+restaurantCryptoTable(schema, table)+` (id integer PRIMARY KEY CHECK(id=1),secret bytea NOT NULL CHECK(octet_length(secret)=32))`); err != nil {
				return errRestaurantKeyState
			}
		} else {
			if restaurantKeyCheckpoint(fault, "before_"+purpose+"_delete") != nil {
				return errRestaurantKeyState
			}
			result, err := tx.ExecContext(ctx, `DELETE FROM `+restaurantCryptoTable(schema, table))
			if err != nil {
				return errRestaurantKeyState
			}
			count, err := result.RowsAffected()
			if err != nil || count != 1 {
				return errRestaurantKeyState
			}
		}
	}
	if restaurantKeyCheckpoint(fault, "after_delete") != nil {
		return errRestaurantKeyState
	}
	for i, table := range []string{"restaurant_order_secret", "restaurant_payment_secret"} {
		if restaurantKeyCheckpoint(fault, "before_"+[]string{"order", "payment"}[i]+"_fence") != nil {
			return errRestaurantKeyState
		}
		if _, err = tx.ExecContext(ctx, `ALTER TABLE `+restaurantCryptoTable(schema, table)+` ADD CONSTRAINT `+quoteIdent(restaurantKeyFence)+` CHECK(false)`); err != nil {
			return errRestaurantKeyState
		}
	}
	if restaurantKeyCheckpoint(fault, "after_fence") != nil {
		return errRestaurantKeyState
	}
	verified, err := restaurantReadExternalKeys(ctx, tx, database, schema, ring)
	if err != nil {
		return err
	}
	defer verified.clear()
	if !bytes.Equal(keys.orders, verified.orders) || !bytes.Equal(keys.payments, verified.payments) {
		return errRestaurantKeyState
	}
	return restaurantCommitKeyMaintenance(tx, fault)
}
