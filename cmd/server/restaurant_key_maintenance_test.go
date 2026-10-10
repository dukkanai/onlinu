package main

import (
	"bytes"
	"context"
	"crypto/cipher"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Opt-in integration coverage: restaurantIntegrationDB refuses all databases
// except astracalls_restaurant_test and isolates every case in a random schema.
// All receipts, payment credentials, DEKs and KEKs are synthetic. No test starts
// a worker or calls a payment provider, and no application DB/key configuration
// is read. The only connection input is the guarded TEST_RESTAURANT_PG_URL.
const restaurantMaintenanceTestStore = "synthetic-maintenance-store"

// Maintenance has a narrower connection contract than the shared historical
// integration suite. Check before calling any helper that could open a DB.
// Query-string overrides, Unix sockets, service files and inherited PG settings
// must not redirect these destructive synthetic migration fixtures.
func restaurantMaintenanceValidateTestURL(raw string, environment []string) error {
	u, err := url.Parse(raw)
	if err != nil || u == nil || (u.Scheme != "postgres" && u.Scheme != "postgresql") ||
		(u.Hostname() != "127.0.0.1" && u.Hostname() != "::1") ||
		u.Path != "/astracalls_restaurant_test" || u.RawPath != "" ||
		u.RawQuery != "sslmode=disable" || strings.Contains(raw, "#") ||
		u.Opaque != "" || u.User == nil || u.User.Username() == "" {
		return errors.New("key-maintenance tests require an explicit loopback disposable database URL without overrides")
	}
	if password, explicit := u.User.Password(); !explicit || password == "" {
		return errors.New("key-maintenance tests require an explicit synthetic URL password without passfile fallback")
	}
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if found && strings.HasPrefix(name, "PG") && value != "" {
			return errors.New("key-maintenance tests refuse inherited PG connection overrides")
		}
	}
	return nil
}

func restaurantMaintenanceRequireTestURL(t *testing.T) {
	t.Helper()
	raw := os.Getenv("TEST_RESTAURANT_PG_URL")
	if raw == "" {
		t.Skip("set guarded loopback TEST_RESTAURANT_PG_URL for synthetic key-maintenance integration tests")
	}
	if err := restaurantMaintenanceValidateTestURL(raw, os.Environ()); err != nil {
		t.Fatal(err)
	}
}

func restaurantMaintenanceIntegrationDB(t *testing.T) *sql.DB {
	t.Helper()
	restaurantMaintenanceRequireTestURL(t)
	return restaurantIntegrationDB(t)
}

func TestRestaurantKeyMaintenanceDisposableURLGuard(t *testing.T) {
	valid := "postgres://synthetic:synthetic@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable"
	for _, raw := range []string{valid, "postgresql://synthetic:synthetic@[::1]:15433/astracalls_restaurant_test?sslmode=disable"} {
		if err := restaurantMaintenanceValidateTestURL(raw, []string{"UNRELATED=okay", "PGHOST="}); err != nil {
			t.Fatal("explicit disposable loopback URL rejected", err)
		}
	}
	for name, raw := range map[string]string{
		"empty":            "",
		"invalid":          "://",
		"wrong-scheme":     strings.Replace(valid, "postgres:", "https:", 1),
		"remote-host":      strings.Replace(valid, "127.0.0.1", "example.invalid", 1),
		"localhost":        strings.Replace(valid, "127.0.0.1", "localhost", 1),
		"unix-socket":      "postgres://synthetic@/astracalls_restaurant_test?sslmode=disable",
		"wrong-database":   strings.Replace(valid, "astracalls_restaurant_test", "real_database", 1),
		"missing-query":    strings.Split(valid, "?")[0],
		"ssl-changed":      strings.Replace(valid, "sslmode=disable", "sslmode=require", 1),
		"query-host":       valid + "&host=example.invalid",
		"query-service":    valid + "&service=some_service",
		"query-database":   valid + "&dbname=real_database",
		"query-user":       valid + "&user=other",
		"query-password":   valid + "&password=other",
		"query-options":    valid + "&options=some_option",
		"query-duplicates": valid + "&sslmode=disable",
		"query-fragment":   valid + "#fragment",
		"empty-fragment":   valid + "#",
		"no-user":          "postgres://127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable",
		"empty-user":       "postgres://:synthetic@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable",
		"no-password":      "postgres://synthetic@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable",
		"empty-password":   "postgres://synthetic:@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable",
		"encoded-path":     strings.Replace(valid, "astracalls_restaurant_test", "astracalls%5Frestaurant_test", 1),
	} {
		t.Run(name, func(t *testing.T) {
			if err := restaurantMaintenanceValidateTestURL(raw, nil); err == nil {
				t.Fatal("unsafe integration URL accepted")
			}
		})
	}
	for _, name := range []string{"PGHOST", "PGPORT", "PGUSER", "PGPASSWORD", "PGDATABASE", "PGSERVICE", "PGSERVICEFILE", "PGPASSFILE", "PGOPTIONS", "PGSSLMODE", "PGSSLROOTCERT", "PGTARGETSESSIONATTRS", "PGUNRECOGNIZED"} {
		t.Run(name, func(t *testing.T) {
			if err := restaurantMaintenanceValidateTestURL(valid, []string{name + "=synthetic-override"}); err == nil {
				t.Fatal("inherited PG override accepted")
			}
		})
	}
}

type restaurantMaintenanceFixture struct {
	ctx                    context.Context
	db                     *sql.DB
	owner                  *instanceOwnership
	database, schema       string
	orders                 *restaurantOrders
	payments               *restaurantPayments
	input                  restaurantOrderInput
	receipt                restaurantReceipt
	idempotency, attemptID string
	config                 restaurantPaymentConfig
	orderKey, paymentKey   []byte
}

func restaurantMaintenanceOwner(t *testing.T, db *sql.DB) (context.Context, *instanceOwnership, string, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	t.Cleanup(cancel)
	var database, schema string
	if err := db.QueryRowContext(ctx, `SELECT current_database(),current_schema()`).Scan(&database, &schema); err != nil {
		t.Fatal(err)
	}
	if database != "astracalls_restaurant_test" || !strings.HasPrefix(schema, "restaurant_it_") {
		t.Fatal("refusing key-maintenance test outside disposable isolated schema")
	}
	owner, err := acquireInstanceOwnership(ctx, db, "synthetic-key-maintenance-"+schema)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(owner.Close)
	return ctx, owner, database, schema
}

func restaurantMaintenanceRing(t *testing.T, active string, ids ...string) *restaurantKeyring {
	t.Helper()
	keys := make(map[string][]byte, len(ids))
	for _, id := range ids {
		var b byte
		switch id {
		case "old":
			b = 0x4a
		case "new":
			b = 0x6c
		default:
			t.Fatal("unexpected synthetic wrapping-key identifier")
		}
		keys[id] = bytes.Repeat([]byte{b}, 32)
	}
	return restaurantTestKeyring(t, restaurantMaintenanceTestStore, active, keys)
}

func restaurantMaintenanceLegacyFixture(t *testing.T) *restaurantMaintenanceFixture {
	t.Helper()
	restaurantMaintenanceRequireTestURL(t)
	// Constructors read these non-secret policy settings; isolate them from any
	// ambient application settings as well as from other tests.
	t.Setenv("WACALLS_PAYMENT_SETTLEMENT_WATCH_DAYS", "30")
	t.Setenv("WACALLS_PAYMENT_SETTLEMENT_CHECK_MINUTES", "60")
	orders, _, db := restaurantOrdersFixtureDB(t)
	ctx, owner, database, schema := restaurantMaintenanceOwner(t, db)
	// Full runtime initialization installs the real order/location cleanup
	// trigger. Payload tables are read-only during migration and must remain
	// compatible with this existing production schema shape.
	if _, err := newRestaurantCouriers(ctx, db, orders); err != nil {
		t.Fatal(err)
	}
	var cleanupTriggers int
	if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname='restaurant_orders' AND t.tgname='restaurant_location_order_cleanup' AND NOT t.tgisinternal`).Scan(&cleanupTriggers); err != nil || cleanupTriggers != 1 {
		t.Fatal("full runtime cleanup trigger missing from migration fixture", err)
	}
	p, err := newRestaurantPayments(ctx, db, orders, "https://synthetic.invalid")
	if err != nil {
		t.Fatal(err)
	}
	p.adapter = &restaurantPaymentFakeAdapter{
		create: func(context.Context, restaurantPaymentConfig, restaurantPaymentRequest) (restaurantPaymentRemote, error) {
			t.Error("key maintenance attempted a provider create")
			return restaurantPaymentRemote{}, errors.New("provider access forbidden in key test")
		},
		fetch: func(context.Context, restaurantPaymentConfig, string, string) (restaurantPaymentRemote, error) {
			t.Error("key maintenance attempted a provider fetch")
			return restaurantPaymentRemote{}, errors.New("provider access forbidden in key test")
		},
	}
	_, err = p.Configure(ctx, "stripe", restaurantStripeTestConfigInput())
	if err != nil {
		t.Fatal(err)
	}
	f := &restaurantMaintenanceFixture{ctx: ctx, db: db, owner: owner, database: database, schema: schema, orders: orders, payments: p, input: restaurantOrderFixtureInput("pickup"), idempotency: uuid.NewString(), attemptID: uuid.NewString()}
	f.receipt, err = orders.Create(ctx, f.input, "", f.idempotency)
	if err != nil {
		t.Fatal(err)
	}
	f.config, err = p.config(ctx, "stripe")
	if err != nil {
		t.Fatal(err)
	}
	sealed, err := p.encrypt("attempt:"+f.attemptID, f.config)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.ExecContext(ctx, `INSERT INTO restaurant_payment_attempts(id,order_number,provider,mode,status,sealed_config) VALUES($1,$2,'stripe','test','pending',$3)`, f.attemptID, f.receipt.Order.Number, sealed); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRowContext(ctx, `SELECT secret FROM restaurant_order_secret WHERE id=1`).Scan(&f.orderKey); err != nil {
		t.Fatal(err)
	}
	if err = db.QueryRowContext(ctx, `SELECT secret FROM restaurant_payment_secret WHERE id=1`).Scan(&f.paymentKey); err != nil {
		t.Fatal(err)
	}
	return f
}

// The snapshot includes ciphertext, row versions, legacy key rows, metadata,
// relation names/kinds and constraints. Comparing without printing its contents
// detects partial writes and unnecessary rewrapping without leaking even test
// key material into failure logs.
func restaurantMaintenanceSnapshot(t *testing.T, ctx context.Context, db *sql.DB) map[string]string {
	t.Helper()
	out := make(map[string]string)
	for name, query := range map[string]string{
		"relations":      `SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname,c.relkind) ORDER BY c.relname)::text,'[]') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()`,
		"constraints":    `SELECT COALESCE(jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid),k.convalidated) ORDER BY c.relname,k.conname)::text,'[]') FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema()`,
		"schema-objects": `SELECT COALESCE(jsonb_agg(jsonb_build_array(d.classid::text,d.objid::text,d.objsubid) ORDER BY d.classid,d.objid,d.objsubid)::text,'[]') FROM pg_depend d JOIN pg_namespace n ON d.refclassid='pg_namespace'::regclass AND d.refobjid=n.oid WHERE n.nspname=current_schema()`,
	} {
		var value string
		if err := db.QueryRowContext(ctx, query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		out[name] = value
	}
	for _, table := range []string{"restaurant_order_secret", "restaurant_payment_secret", "restaurant_key_state", "restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts"} {
		var exists bool
		if err := db.QueryRowContext(ctx, `SELECT to_regclass(quote_ident(current_schema())||'.'||quote_ident($1)) IS NOT NULL`, table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			out[table] = "absent"
			continue
		}
		query := `SELECT COALESCE(jsonb_agg(jsonb_build_array(to_jsonb(t),t.xmin::text) ORDER BY to_jsonb(t)::text)::text,'[]') FROM "` + table + `" t`
		var value string
		if err := db.QueryRowContext(ctx, query).Scan(&value); err != nil {
			t.Fatal(err)
		}
		out[table] = value
	}
	return out
}

func restaurantMaintenanceUnchanged(t *testing.T, ctx context.Context, db *sql.DB, before map[string]string) {
	t.Helper()
	if !reflect.DeepEqual(before, restaurantMaintenanceSnapshot(t, ctx, db)) {
		t.Fatal("operation changed database rows, schema, constraints or ciphertext")
	}
}

func restaurantMaintenanceEnvelopes(t *testing.T, ctx context.Context, db *sql.DB) ([]byte, []byte) {
	t.Helper()
	var order, payment []byte
	if err := db.QueryRowContext(ctx, `SELECT order_envelope,payment_envelope FROM restaurant_key_state WHERE id=1`).Scan(&order, &payment); err != nil {
		t.Fatal(err)
	}
	return order, payment
}

func restaurantMaintenanceCheckPayloads(t *testing.T, f *restaurantMaintenanceFixture, ciphers *restaurantDataCiphers) {
	t.Helper()
	if ciphers == nil || ciphers.orders == nil || ciphers.payments == nil {
		t.Fatal("external mode did not load both ciphers")
	}
	// Exercise real durable receipt/config/attempt read paths with loaded DEKs.
	orders := *f.orders
	orders.seal = ciphers.orders
	again, err := orders.Create(f.ctx, f.input, "", f.idempotency)
	want := f.receipt
	restaurantNormalizeLegacyOrder(&want.Order)
	if err != nil || !reflect.DeepEqual(again, want) {
		t.Fatal("external DEK did not preserve the existing durable receipt", err)
	}
	payments := *f.payments
	payments.seal = ciphers.payments
	cfg, err := payments.config(f.ctx, "stripe")
	if err != nil || !reflect.DeepEqual(cfg, f.config) {
		t.Fatal("external DEK did not preserve payment configuration", err)
	}
	attempt, err := payments.readAttempt(f.db.QueryRowContext(f.ctx, restaurantPaymentAttemptSelect+` WHERE id=$1`, f.attemptID))
	if err != nil || !reflect.DeepEqual(attempt.Config, f.config) {
		t.Fatal("external DEK did not preserve attempt configuration", err)
	}
}

func restaurantMaintenanceCheckFence(t *testing.T, ctx context.Context, db *sql.DB) {
	t.Helper()
	for _, table := range []string{"restaurant_order_secret", "restaurant_payment_secret"} {
		var rows, fences int
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM "`+table+`"`).Scan(&rows); err != nil || rows != 0 {
			t.Fatal("external state retained or regenerated a legacy key", err)
		}
		if err := db.QueryRowContext(ctx, `SELECT count(*) FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=current_schema() AND c.relname=$1 AND k.conname='restaurant_external_key_fence' AND k.contype='c' AND k.convalidated AND pg_get_constraintdef(k.oid)='CHECK (false)'`, table).Scan(&fences); err != nil || fences != 1 {
			t.Fatal("legacy singleton does not have a validated false constraint", err)
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO "`+table+`"(id,secret) VALUES(1,$1) ON CONFLICT(id) DO NOTHING`, bytes.Repeat([]byte{0x11}, 32)); err == nil {
			t.Fatal("old-style key insertion bypassed the legacy-writer fence")
		}
	}
}

func TestRestaurantKeyMigrationPreservesPayloadsAndFencesLegacy(t *testing.T) {
	f := restaurantMaintenanceLegacyFixture(t)
	ring := restaurantMaintenanceRing(t, "old", "old")
	before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	if err := restaurantRefuseExternalDatabase(f.ctx, f.owner, f.database, f.schema); err != nil {
		t.Fatal("legacy database was refused before migration", err)
	}
	if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, "migrate", nil); err != nil {
		t.Fatal(err)
	}
	after := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	for _, table := range []string{"restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts"} {
		if before[table] != after[table] {
			t.Fatal("migration rewrote an existing payload row")
		}
	}
	orderEnvelope, paymentEnvelope := restaurantMaintenanceEnvelopes(t, f.ctx, f.db)
	for _, tc := range []struct {
		purpose, id   string
		envelope, key []byte
	}{{restaurantOrderKeyPurpose, "order-dek-v1", orderEnvelope, f.orderKey}, {restaurantPaymentKeyPurpose, "payment-dek-v1", paymentEnvelope, f.paymentKey}} {
		key, err := ring.unwrap(tc.purpose, tc.id, tc.envelope)
		if err != nil || !bytes.Equal(key, tc.key) {
			t.Fatal("migration replaced a legacy payload key", err)
		}
	}
	restaurantMaintenanceCheckFence(t, f.ctx, f.db)
	if err := restaurantRefuseExternalDatabase(f.ctx, f.owner, f.database, f.schema); err == nil {
		t.Fatal("legacy runtime accepted external-key metadata")
	}
	if _, err := newRestaurantOrders(f.ctx, f.orders.store); err == nil {
		t.Fatal("legacy orders constructor accepted migrated database")
	}
	if _, err := newRestaurantPayments(f.ctx, f.db, f.orders, "https://synthetic.invalid"); err == nil {
		t.Fatal("legacy payments constructor accepted migrated database")
	}
	restaurantMaintenanceCheckFence(t, f.ctx, f.db)
	ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, ring)
	if err != nil {
		t.Fatal(err)
	}
	externalOrders, err := newRestaurantOrders(f.ctx, f.orders.store, ciphers.orders)
	if err != nil {
		t.Fatal("external orders constructor failed", err)
	}
	externalPayments, err := newRestaurantPayments(f.ctx, f.db, externalOrders, "https://synthetic.invalid", ciphers.payments)
	if err != nil {
		t.Fatal("external payments constructor failed", err)
	}
	externalPayments.adapter = f.payments.adapter
	f.orders, f.payments = externalOrders, externalPayments
	restaurantMaintenanceCheckPayloads(t, f, ciphers)
	restaurantMaintenanceCheckFence(t, f.ctx, f.db)
	stable := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	for _, command := range []string{"migrate", "verify", "migrate", "verify"} {
		if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, command, nil); err != nil {
			t.Fatal("idempotent maintenance failed", command, err)
		}
		restaurantMaintenanceUnchanged(t, f.ctx, f.db, stable)
	}
}

func TestRestaurantKeyMigrationRejectsCorruptPayloadsAtomically(t *testing.T) {
	for _, kind := range []string{"receipt-tag", "config-tag", "attempt-tag", "receipt-short", "config-short", "attempt-short", "receipt-json", "receipt-hash", "config-provider", "attempt-provider", "attempt-mode"} {
		t.Run(kind, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			var statement string
			var replacement []byte
			sealPlain := func(seal cipher.AEAD, plain, aad []byte) []byte {
				nonce := bytes.Repeat([]byte{0x33}, seal.NonceSize())
				return seal.Seal(nonce, nonce, plain, aad)
			}
			switch kind {
			case "receipt-tag", "receipt-short":
				statement = `UPDATE restaurant_orders SET sealed_secrets=$1`
				if err := f.db.QueryRowContext(f.ctx, `SELECT sealed_secrets FROM restaurant_orders`).Scan(&replacement); err != nil {
					t.Fatal(err)
				}
			case "config-tag", "config-short":
				statement = `UPDATE restaurant_payment_configs SET sealed=$1`
				if err := f.db.QueryRowContext(f.ctx, `SELECT sealed FROM restaurant_payment_configs`).Scan(&replacement); err != nil {
					t.Fatal(err)
				}
			case "attempt-tag", "attempt-short":
				statement = `UPDATE restaurant_payment_attempts SET sealed_config=$1`
				if err := f.db.QueryRowContext(f.ctx, `SELECT sealed_config FROM restaurant_payment_attempts`).Scan(&replacement); err != nil {
					t.Fatal(err)
				}
			case "receipt-json":
				statement = `UPDATE restaurant_orders SET sealed_secrets=$1`
				replacement = sealPlain(f.orders.seal, []byte(`{"trackingToken":`), []byte(f.receipt.Order.Number))
			case "receipt-hash":
				statement = `UPDATE restaurant_orders SET token_hash=$1`
				replacement = bytes.Repeat([]byte{0x22}, 32)
			case "config-provider", "attempt-provider", "attempt-mode":
				cfg := f.config
				cfg.ID = "moyasar"
				id := "config:stripe"
				statement = `UPDATE restaurant_payment_configs SET sealed=$1`
				if strings.HasPrefix(kind, "attempt-") {
					id = "attempt:" + f.attemptID
					statement = `UPDATE restaurant_payment_attempts SET sealed_config=$1`
				}
				if kind == "attempt-mode" {
					cfg.ID, cfg.Mode = "stripe", "live"
				}
				var err error
				replacement, err = f.payments.encrypt(id, cfg)
				if err != nil {
					t.Fatal(err)
				}
			}
			if strings.HasSuffix(kind, "-tag") {
				replacement[len(replacement)-1] ^= 0x80
			}
			if strings.HasSuffix(kind, "-short") {
				replacement = []byte{0x01}
			}
			if _, err := f.db.ExecContext(f.ctx, statement, replacement); err != nil {
				t.Fatal(err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, restaurantMaintenanceRing(t, "old", "old"), "migrate", nil); err == nil {
				t.Fatal("migration accepted corrupt or identity-mismatched ciphertext")
			}
			restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
		})
	}
}

func TestRestaurantKeyMigrationMissingLegacyKeyNeverGenerates(t *testing.T) {
	for _, table := range []string{"restaurant_order_secret", "restaurant_payment_secret"} {
		t.Run(table, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			if _, err := f.db.ExecContext(f.ctx, `DELETE FROM "`+table+`"`); err != nil {
				t.Fatal(err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			ring := restaurantMaintenanceRing(t, "old", "old")
			for _, command := range []string{"migrate", "rotate", "verify", "init"} {
				if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, command, nil); err == nil {
					t.Fatal("maintenance generated a replacement for a missing legacy key", command)
				}
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			}
			if ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, ring); err == nil || ciphers != nil {
				t.Fatal("external runtime fell back to an incomplete legacy key set")
			}
			restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
		})
	}
}

func TestRestaurantKeyMigrationFaultRollbackAndUnknownCommit(t *testing.T) {
	for _, stage := range []string{"before_state", "before_state_insert", "after_state", "before_order_delete", "before_payment_delete", "after_delete", "before_order_fence", "before_payment_fence", "after_fence", "before_commit", "after_commit"} {
		t.Run(stage, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			ring := restaurantMaintenanceRing(t, "old", "old")
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			hit := false
			err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, "migrate", func(at string) error {
				if at == stage {
					hit = true
					return errors.New("synthetic migration interruption")
				}
				return nil
			})
			if !hit || err == nil {
				t.Fatal("requested migration fault was not reported")
			}
			if stage != "after_commit" {
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
				if err := restaurantRefuseExternalDatabase(f.ctx, f.owner, f.database, f.schema); err != nil {
					t.Fatal("rollback stranded legacy runtime", err)
				}
			} else {
				restaurantMaintenanceCheckFence(t, f.ctx, f.db)
				before = restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			}
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, "migrate", nil); err != nil {
				t.Fatal("interrupted migration could not recover", err)
			}
			if stage == "after_commit" {
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			}
			ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, ring)
			if err != nil {
				t.Fatal(err)
			}
			restaurantMaintenanceCheckPayloads(t, f, ciphers)
		})
	}
}

func TestRestaurantKeyRotationPreservesDEKsAndPayloads(t *testing.T) {
	f := restaurantMaintenanceLegacyFixture(t)
	old := restaurantMaintenanceRing(t, "old", "old")
	both := restaurantMaintenanceRing(t, "new", "old", "new")
	if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, old, "migrate", nil); err != nil {
		t.Fatal(err)
	}
	before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	oldOrder, oldPayment := restaurantMaintenanceEnvelopes(t, f.ctx, f.db)
	if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, both, "rotate", nil); err != nil {
		t.Fatal(err)
	}
	newOrder, newPayment := restaurantMaintenanceEnvelopes(t, f.ctx, f.db)
	if bytes.Equal(oldOrder, newOrder) || bytes.Equal(oldPayment, newPayment) {
		t.Fatal("rotation did not rewrap both data keys")
	}
	after := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	for _, table := range []string{"restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts", "restaurant_order_secret", "restaurant_payment_secret"} {
		if before[table] != after[table] {
			t.Fatal("rotation changed payloads or legacy keys")
		}
	}
	newOnly := restaurantMaintenanceRing(t, "new", "new")
	for _, tc := range []struct {
		purpose, id   string
		envelope, key []byte
	}{{restaurantOrderKeyPurpose, "order-dek-v1", newOrder, f.orderKey}, {restaurantPaymentKeyPurpose, "payment-dek-v1", newPayment, f.paymentKey}} {
		var envelope restaurantKeyEnvelope
		if json.Unmarshal(tc.envelope, &envelope) != nil || envelope.WrappingKeyID != "new" {
			t.Fatal("rotation did not use active new KEK")
		}
		key, err := newOnly.unwrap(tc.purpose, tc.id, tc.envelope)
		if err != nil || !bytes.Equal(key, tc.key) {
			t.Fatal("rotation changed an existing data key", err)
		}
	}
	if ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, old); err == nil || ciphers != nil {
		t.Fatal("retired old-only keyring opened rotated metadata")
	}
	ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, newOnly)
	if err != nil {
		t.Fatal(err)
	}
	restaurantMaintenanceCheckPayloads(t, f, ciphers)
	// Retain both KEKs to support an explicit reverse rotation during rollback.
	rollback := restaurantMaintenanceRing(t, "old", "old", "new")
	if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, rollback, "rotate", nil); err != nil {
		t.Fatal("retained-key rollback failed", err)
	}
	ciphers, err = restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, old)
	if err != nil {
		t.Fatal(err)
	}
	restaurantMaintenanceCheckPayloads(t, f, ciphers)
	restaurantMaintenanceCheckFence(t, f.ctx, f.db)
}

func TestRestaurantKeyRotationFaultRollbackAndUnknownCommit(t *testing.T) {
	for _, stage := range []string{"before_state", "after_state", "before_commit", "after_commit"} {
		t.Run(stage, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			old := restaurantMaintenanceRing(t, "old", "old")
			both := restaurantMaintenanceRing(t, "new", "old", "new")
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, old, "migrate", nil); err != nil {
				t.Fatal(err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			hit := false
			err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, both, "rotate", func(at string) error {
				if at == stage {
					hit = true
					return errors.New("synthetic rotation interruption")
				}
				return nil
			})
			if !hit || err == nil {
				t.Fatal("requested rotation fault was not reported")
			}
			if stage != "after_commit" {
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
				if _, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, old); err != nil {
					t.Fatal("failed rotation invalidated old KEK", err)
				}
			} else {
				before = restaurantMaintenanceSnapshot(t, f.ctx, f.db)
				if _, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, restaurantMaintenanceRing(t, "new", "new")); err != nil {
					t.Fatal("committed rotation did not survive ambiguous result", err)
				}
			}
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, both, "rotate", nil); err != nil {
				t.Fatal("rotation retry failed", err)
			}
			if stage == "after_commit" {
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			}
			ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, both)
			if err != nil {
				t.Fatal(err)
			}
			restaurantMaintenanceCheckPayloads(t, f, ciphers)
		})
	}
}

func TestRestaurantKeyExternalUnknownAndIncorrectKEKsFailClosed(t *testing.T) {
	f := restaurantMaintenanceLegacyFixture(t)
	old := restaurantMaintenanceRing(t, "old", "old")
	if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, old, "migrate", nil); err != nil {
		t.Fatal(err)
	}
	before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	wrong := restaurantTestKeyring(t, restaurantMaintenanceTestStore, "old", map[string][]byte{"old": bytes.Repeat([]byte{0x7f}, 32)})
	otherStore := restaurantTestKeyring(t, "another-synthetic-store", "old", map[string][]byte{"old": bytes.Repeat([]byte{0x4a}, 32)})
	for name, ring := range map[string]*restaurantKeyring{"missing": nil, "unknown-id": restaurantMaintenanceRing(t, "new", "new"), "wrong-key": wrong, "wrong-store": otherStore} {
		t.Run(name, func(t *testing.T) {
			if ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, ring); err == nil || ciphers != nil {
				t.Fatal("runtime accepted unavailable external key")
			}
			for _, command := range []string{"migrate", "rotate", "verify", "init"} {
				if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, command, nil); err == nil {
					t.Fatal("maintenance accepted unavailable external key", command)
				}
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			}
		})
	}
}

func TestRestaurantKeyExternalMalformedStateNeverFallsBack(t *testing.T) {
	mutations := map[string]string{
		"missing-row":     `DELETE FROM restaurant_key_state`,
		"unknown-version": `ALTER TABLE restaurant_key_state DROP CONSTRAINT restaurant_key_state_version_check; UPDATE restaurant_key_state SET version=2`,
		"wrong-store":     `UPDATE restaurant_key_state SET store_id='other-synthetic-store'`,
		"wrong-database":  `UPDATE restaurant_key_state SET database_name='other_synthetic_database'`,
		"wrong-schema":    `UPDATE restaurant_key_state SET schema_name='other_synthetic_schema'`,
		"order-empty":     `UPDATE restaurant_key_state SET order_envelope=''`,
		"payment-empty":   `UPDATE restaurant_key_state SET payment_envelope=''`,
		"order-corrupt":   `UPDATE restaurant_key_state SET order_envelope='{"version":1}'`,
		"payment-corrupt": `UPDATE restaurant_key_state SET payment_envelope='{"version":1}'`,
	}
	for name, statement := range mutations {
		t.Run(name, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			ring := restaurantMaintenanceRing(t, "old", "old")
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, "migrate", nil); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.ExecContext(f.ctx, statement); err != nil {
				t.Fatal("could not construct corrupt synthetic state", err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			if ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, ring); err == nil || ciphers != nil {
				t.Fatal("runtime accepted malformed external metadata")
			}
			if err := restaurantRefuseExternalDatabase(f.ctx, f.owner, f.database, f.schema); err == nil {
				t.Fatal("legacy runtime ignored malformed external metadata")
			}
			for _, command := range []string{"migrate", "rotate", "verify", "init"} {
				if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, command, nil); err == nil {
					t.Fatal("maintenance repaired malformed metadata implicitly", command)
				}
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			}
			restaurantMaintenanceCheckFence(t, f.ctx, f.db)
		})
	}
}

func TestRestaurantKeyExternalPartialMetadataRefused(t *testing.T) {
	db := restaurantMaintenanceIntegrationDB(t)
	ctx, owner, database, schema := restaurantMaintenanceOwner(t, db)
	if _, err := db.ExecContext(ctx, `CREATE TABLE restaurant_key_state(id integer)`); err != nil {
		t.Fatal(err)
	}
	before := restaurantMaintenanceSnapshot(t, ctx, db)
	ring := restaurantMaintenanceRing(t, "old", "old")
	if err := restaurantRefuseExternalDatabase(ctx, owner, database, schema); err == nil {
		t.Fatal("legacy runtime accepted partial metadata table")
	}
	if ciphers, err := restaurantLoadExternalKeys(ctx, owner, database, schema, ring); err == nil || ciphers != nil {
		t.Fatal("external runtime accepted partial metadata table")
	}
	for _, command := range []string{"init", "migrate", "rotate", "verify"} {
		if err := restaurantMaintainKeys(ctx, owner, database, schema, ring, command, nil); err == nil {
			t.Fatal("maintenance accepted partial metadata table", command)
		}
		restaurantMaintenanceUnchanged(t, ctx, db, before)
	}
}

func TestRestaurantKeyMaintenanceFreshInitOnly(t *testing.T) {
	db := restaurantMaintenanceIntegrationDB(t)
	ctx, owner, database, schema := restaurantMaintenanceOwner(t, db)
	ring := restaurantMaintenanceRing(t, "old", "old")
	empty := restaurantMaintenanceSnapshot(t, ctx, db)
	for _, command := range []string{"migrate", "rotate", "verify", "unknown"} {
		if err := restaurantMaintainKeys(ctx, owner, database, schema, ring, command, nil); err == nil {
			t.Fatal("maintenance accepted uninitialized schema", command)
		}
		restaurantMaintenanceUnchanged(t, ctx, db, empty)
	}
	if ciphers, err := restaurantLoadExternalKeys(ctx, owner, database, schema, ring); err == nil || ciphers != nil {
		t.Fatal("external runtime initialized missing metadata")
	}
	if err := restaurantMaintainKeys(ctx, owner, database, schema, ring, "init", nil); err != nil {
		t.Fatal(err)
	}
	restaurantMaintenanceCheckFence(t, ctx, db)
	ciphers, err := restaurantLoadExternalKeys(ctx, owner, database, schema, ring)
	if err != nil || ciphers == nil || ciphers.orders == nil || ciphers.payments == nil {
		t.Fatal("initialized ciphers unavailable", err)
	}
	order, payment := restaurantMaintenanceEnvelopes(t, ctx, db)
	orderKey, err := ring.unwrap(restaurantOrderKeyPurpose, "order-dek-v1", order)
	if err != nil {
		t.Fatal(err)
	}
	paymentKey, err := ring.unwrap(restaurantPaymentKeyPurpose, "payment-dek-v1", payment)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(orderKey, paymentKey) {
		t.Fatal("init reused the same DEK across purposes")
	}
	stable := restaurantMaintenanceSnapshot(t, ctx, db)
	if err := restaurantMaintainKeys(ctx, owner, database, schema, ring, "init", nil); err != nil {
		t.Fatal("init rerun did not verify existing state", err)
	}
	restaurantMaintenanceUnchanged(t, ctx, db, stable)
	if err := restaurantMaintainKeys(ctx, owner, database, schema, ring, "verify", nil); err != nil {
		t.Fatal(err)
	}
	restaurantMaintenanceUnchanged(t, ctx, db, stable)
}

func TestRestaurantKeyMaintenanceInitRefusesNonemptySchema(t *testing.T) {
	for name, statement := range map[string]string{
		"empty-table":      `CREATE TABLE existing_synthetic(id integer)`,
		"data-table":       `CREATE TABLE existing_synthetic(id integer); INSERT INTO existing_synthetic VALUES(1)`,
		"sequence":         `CREATE SEQUENCE existing_synthetic`,
		"view":             `CREATE VIEW existing_synthetic AS SELECT 1 AS id`,
		"function":         `CREATE FUNCTION existing_synthetic() RETURNS integer LANGUAGE sql AS $$ SELECT 1 $$`,
		"domain":           `CREATE DOMAIN existing_synthetic AS text`,
		"enum":             `CREATE TYPE existing_synthetic AS ENUM ('only')`,
		"legacy-key-table": `CREATE TABLE restaurant_order_secret(id integer PRIMARY KEY CHECK(id=1),secret bytea NOT NULL CHECK(octet_length(secret)=32))`,
	} {
		t.Run(name, func(t *testing.T) {
			db := restaurantMaintenanceIntegrationDB(t)
			ctx, owner, database, schema := restaurantMaintenanceOwner(t, db)
			if _, err := db.ExecContext(ctx, statement); err != nil {
				t.Fatal(err)
			}
			before := restaurantMaintenanceSnapshot(t, ctx, db)
			if err := restaurantMaintainKeys(ctx, owner, database, schema, restaurantMaintenanceRing(t, "old", "old"), "init", nil); err == nil {
				t.Fatal("init accepted nonempty schema")
			}
			restaurantMaintenanceUnchanged(t, ctx, db, before)
		})
	}
}

func TestRestaurantKeyMaintenanceIdentityAndOwnershipRequired(t *testing.T) {
	f := restaurantMaintenanceLegacyFixture(t)
	ring := restaurantMaintenanceRing(t, "old", "old")
	before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	for _, tc := range []struct{ database, schema string }{{"wrong_synthetic_database", f.schema}, {f.database, f.schema + "_wrong"}, {"", f.schema}, {f.database, ""}} {
		for _, command := range []string{"init", "migrate", "rotate", "verify"} {
			if err := restaurantMaintainKeys(f.ctx, f.owner, tc.database, tc.schema, ring, command, nil); err == nil {
				t.Fatal("maintenance accepted mismatched database identity")
			}
		}
		if ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, tc.database, tc.schema, ring); err == nil || ciphers != nil {
			t.Fatal("external runtime accepted mismatched database identity")
		}
		restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
	}
	contender, err := acquireInstanceOwnership(f.ctx, f.db, "synthetic-key-maintenance-"+f.schema)
	if contender != nil {
		contender.Close()
	}
	if !errors.Is(err, errInstanceAlreadyRunning) {
		t.Fatal("second process could acquire key-maintenance ownership", err)
	}
	f.owner.Close()
	for _, owner := range []*instanceOwnership{nil, f.owner} {
		for _, command := range []string{"init", "migrate", "rotate", "verify"} {
			if err := restaurantMaintainKeys(f.ctx, owner, f.database, f.schema, ring, command, nil); err == nil {
				t.Fatal("maintenance proceeded without live ownership")
			}
		}
		if ciphers, err := restaurantLoadExternalKeys(f.ctx, owner, f.database, f.schema, ring); err == nil || ciphers != nil {
			t.Fatal("external runtime accepted missing ownership")
		}
		restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
	}
}

func TestRestaurantKeyMaintenanceInitFaultRollbackAndUnknownCommit(t *testing.T) {
	for _, stage := range []string{"before_state", "before_state_insert", "after_state", "before_order_table", "before_payment_table", "after_delete", "before_order_fence", "before_payment_fence", "after_fence", "before_commit", "after_commit"} {
		t.Run(stage, func(t *testing.T) {
			db := restaurantMaintenanceIntegrationDB(t)
			ctx, owner, database, schema := restaurantMaintenanceOwner(t, db)
			ring := restaurantMaintenanceRing(t, "old", "old")
			before := restaurantMaintenanceSnapshot(t, ctx, db)
			hit := false
			err := restaurantMaintainKeys(ctx, owner, database, schema, ring, "init", func(at string) error {
				if at == stage {
					hit = true
					return errors.New("synthetic initialization interruption")
				}
				return nil
			})
			if !hit || err == nil {
				t.Fatal("requested init fault was not reported")
			}
			if stage != "after_commit" {
				restaurantMaintenanceUnchanged(t, ctx, db, before)
			} else {
				if !errors.Is(err, errRestaurantKeyCommit) {
					t.Fatal("ambiguous commit did not report the specific recovery error")
				}
				restaurantMaintenanceCheckFence(t, ctx, db)
				before = restaurantMaintenanceSnapshot(t, ctx, db)
			}
			if err := restaurantMaintainKeys(ctx, owner, database, schema, ring, "init", nil); err != nil {
				t.Fatal("interrupted init could not recover", err)
			}
			if stage == "after_commit" {
				restaurantMaintenanceUnchanged(t, ctx, db, before)
			}
			if ciphers, err := restaurantLoadExternalKeys(ctx, owner, database, schema, ring); err != nil || ciphers == nil {
				t.Fatal("initialized ciphers unavailable after recovery", err)
			}
			restaurantMaintenanceCheckFence(t, ctx, db)
		})
	}
}

func TestRestaurantKeyMigrationRejectsUnreviewedSchema(t *testing.T) {
	for name, statement := range map[string]string{
		"unknown-order-column": `ALTER TABLE restaurant_orders ADD COLUMN unexpected_synthetic text`,
		"unknown-key-column":   `ALTER TABLE restaurant_order_secret ADD COLUMN unexpected_synthetic text`,
		// CASCADE drops only dependent fixture constraints, including the empty
		// synthetic receipt inbox FK, so this still models a missing payload table.
		"missing-attempt-table": `DROP TABLE restaurant_payment_attempts CASCADE`,
		"missing-config-column": `ALTER TABLE restaurant_payment_configs DROP COLUMN sealed`,
		"nullable-key":          `ALTER TABLE restaurant_order_secret ALTER COLUMN secret DROP NOT NULL`,
		"row-security":          `ALTER TABLE restaurant_orders ENABLE ROW LEVEL SECURITY`,
		"unlogged-key":          `ALTER TABLE restaurant_order_secret SET UNLOGGED`,
		"trigger":               `CREATE FUNCTION synthetic_key_trigger() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER synthetic_key_trigger BEFORE INSERT ON restaurant_order_secret FOR EACH ROW EXECUTE FUNCTION synthetic_key_trigger()`,
	} {
		t.Run(name, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			if _, err := f.db.ExecContext(f.ctx, statement); err != nil {
				t.Fatal("could not construct unreviewed synthetic schema", err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, restaurantMaintenanceRing(t, "old", "old"), "migrate", nil); err == nil {
				t.Fatal("migration accepted unreviewed schema")
			}
			restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
		})
	}
}

func TestRestaurantKeyExternalContradictoryFencesAndMetadata(t *testing.T) {
	for name, statement := range map[string]string{
		"missing-order-fence":     `ALTER TABLE restaurant_order_secret DROP CONSTRAINT restaurant_external_key_fence`,
		"missing-payment-fence":   `ALTER TABLE restaurant_payment_secret DROP CONSTRAINT restaurant_external_key_fence`,
		"false-name-only-fence":   `ALTER TABLE restaurant_order_secret DROP CONSTRAINT restaurant_external_key_fence; ALTER TABLE restaurant_order_secret ADD CONSTRAINT restaurant_external_key_fence CHECK(true)`,
		"unvalidated-fence":       `ALTER TABLE restaurant_payment_secret DROP CONSTRAINT restaurant_external_key_fence; ALTER TABLE restaurant_payment_secret ADD CONSTRAINT restaurant_external_key_fence CHECK(false) NOT VALID`,
		"regenerated-legacy-key":  `ALTER TABLE restaurant_order_secret DROP CONSTRAINT restaurant_external_key_fence; INSERT INTO restaurant_order_secret(id,secret) VALUES(1,decode(repeat('11',32),'hex'))`,
		"missing-metadata-table":  `DROP TABLE restaurant_key_state`,
		"cross-purpose-envelopes": `UPDATE restaurant_key_state SET order_envelope=payment_envelope,payment_envelope=order_envelope`,
		"unknown-metadata-column": `ALTER TABLE restaurant_key_state ADD COLUMN unexpected_synthetic text`,
	} {
		t.Run(name, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			ring := restaurantMaintenanceRing(t, "old", "old")
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, "migrate", nil); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.ExecContext(f.ctx, statement); err != nil {
				t.Fatal("could not construct contradictory synthetic state", err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			if err := restaurantRefuseExternalDatabase(f.ctx, f.owner, f.database, f.schema); err == nil {
				t.Fatal("legacy runtime accepted contradictory external state")
			}
			if ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, ring); err == nil || ciphers != nil {
				t.Fatal("external runtime accepted contradictory state")
			}
			for _, command := range []string{"init", "migrate", "rotate", "verify"} {
				if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, command, nil); err == nil {
					t.Fatal("maintenance implicitly repaired contradictory state", command)
				}
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			}
		})
	}
}

func TestRestaurantKeyExternalRejectsSplitWrappingGeneration(t *testing.T) {
	f := restaurantMaintenanceLegacyFixture(t)
	old := restaurantMaintenanceRing(t, "old", "old")
	both := restaurantMaintenanceRing(t, "new", "old", "new")
	if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, old, "migrate", nil); err != nil {
		t.Fatal(err)
	}
	payment, err := both.wrap(restaurantPaymentKeyPurpose, "payment-dek-v1", f.paymentKey)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.db.ExecContext(f.ctx, `UPDATE restaurant_key_state SET payment_envelope=$1`, payment); err != nil {
		t.Fatal(err)
	}
	before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
	if ciphers, err := restaurantLoadExternalKeys(f.ctx, f.owner, f.database, f.schema, both); err == nil || ciphers != nil {
		t.Fatal("runtime accepted different wrapping-key generations")
	}
	for _, command := range []string{"init", "migrate", "rotate", "verify"} {
		if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, both, command, nil); err == nil {
			t.Fatal("maintenance accepted different wrapping-key generations", command)
		}
		restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
	}
}

func TestRestaurantKeyMigrationRejectsForeignKeySideEffects(t *testing.T) {
	for _, table := range []string{"restaurant_order_secret", "restaurant_payment_secret"} {
		for _, direction := range []string{"incoming-cascade", "outgoing"} {
			t.Run(table+"/"+direction, func(t *testing.T) {
				f := restaurantMaintenanceLegacyFixture(t)
				statement := `CREATE TABLE synthetic_key_dependency(id integer PRIMARY KEY, key_id integer REFERENCES "` + table + `"(id) ON DELETE CASCADE); INSERT INTO synthetic_key_dependency(id,key_id) VALUES(1,1)`
				if direction == "outgoing" {
					statement = `CREATE TABLE synthetic_key_dependency(id integer PRIMARY KEY, key_id integer); INSERT INTO synthetic_key_dependency VALUES(1,1); ALTER TABLE "` + table + `" ADD CONSTRAINT synthetic_outgoing_fk FOREIGN KEY(id) REFERENCES synthetic_key_dependency(id)`
				}
				if _, err := f.db.ExecContext(f.ctx, statement); err != nil {
					t.Fatal("could not construct synthetic key dependency", err)
				}
				before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
				if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, restaurantMaintenanceRing(t, "old", "old"), "migrate", nil); err == nil {
					t.Fatal("migration accepted unreviewed foreign-key side effects")
				}
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
				var count int
				if err := f.db.QueryRowContext(f.ctx, `SELECT count(*) FROM synthetic_key_dependency WHERE id=1 AND key_id=1`).Scan(&count); err != nil || count != 1 {
					t.Fatal("migration deleted or changed a dependent business row", err)
				}
			})
		}
	}
}

func TestRestaurantKeyMaintenanceRejectsCorruptedMigratedPayloads(t *testing.T) {
	for name, statement := range map[string]string{
		"receipt": `UPDATE restaurant_orders SET sealed_secrets=substring(sealed_secrets FROM 1 FOR 1)`,
		"config":  `UPDATE restaurant_payment_configs SET sealed=substring(sealed FROM 1 FOR 1)`,
		"attempt": `UPDATE restaurant_payment_attempts SET sealed_config=substring(sealed_config FROM 1 FOR 1)`,
	} {
		t.Run(name, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			old := restaurantMaintenanceRing(t, "old", "old")
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, old, "migrate", nil); err != nil {
				t.Fatal(err)
			}
			if _, err := f.db.ExecContext(f.ctx, statement); err != nil {
				t.Fatal(err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			both := restaurantMaintenanceRing(t, "new", "old", "new")
			for _, command := range []string{"init", "migrate", "rotate", "verify"} {
				if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, both, command, nil); err == nil {
					t.Fatal("maintenance accepted a corrupt migrated payload", command)
				}
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			}
			restaurantMaintenanceCheckFence(t, f.ctx, f.db)
		})
	}
}

func TestRestaurantKeyMaintenanceRefusesNoncooperatingTableWriter(t *testing.T) {
	for _, tc := range []struct{ command, table string }{
		{"migrate", "restaurant_order_secret"},
		{"migrate", "restaurant_payment_secret"},
		{"migrate", "restaurant_orders"},
		{"migrate", "restaurant_payment_configs"},
		{"migrate", "restaurant_payment_attempts"},
		{"rotate", "restaurant_key_state"},
		{"rotate", "restaurant_order_secret"},
		{"rotate", "restaurant_payment_attempts"},
	} {
		t.Run(tc.command+"/"+tc.table, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			ring := restaurantMaintenanceRing(t, "old", "old")
			if tc.command == "rotate" {
				if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, ring, "migrate", nil); err != nil {
					t.Fatal(err)
				}
				ring = restaurantMaintenanceRing(t, "new", "old", "new")
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			// The maintenance owner holds a dedicated connection; BeginTx on the
			// pool necessarily uses a different session for this synthetic writer.
			writer, err := f.db.BeginTx(f.ctx, nil)
			if err != nil {
				t.Fatal(err)
			}
			defer writer.Rollback()
			if _, err = writer.ExecContext(f.ctx, `LOCK TABLE "`+tc.table+`" IN ROW EXCLUSIVE MODE`); err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithTimeout(f.ctx, 3*time.Second)
			defer cancel()
			err = restaurantMaintainKeys(ctx, f.owner, f.database, f.schema, ring, tc.command, nil)
			if err == nil {
				t.Fatal("maintenance ignored a noncooperating table writer")
			}
			if ctx.Err() != nil {
				t.Fatal("maintenance waited for conflicting writer instead of refusing immediately")
			}
			if err := writer.Rollback(); err != nil {
				t.Fatal(err)
			}
			restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
		})
	}
}

func TestRestaurantKeyRotationRejectsMetadataForeignKeySideEffects(t *testing.T) {
	for _, direction := range []string{"incoming-update-cascade", "outgoing"} {
		t.Run(direction, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			old := restaurantMaintenanceRing(t, "old", "old")
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, old, "migrate", nil); err != nil {
				t.Fatal(err)
			}
			statement := `ALTER TABLE restaurant_key_state ADD CONSTRAINT synthetic_envelope_unique UNIQUE(order_envelope);
			CREATE TABLE synthetic_key_dependency(id integer PRIMARY KEY, envelope bytea NOT NULL REFERENCES restaurant_key_state(order_envelope) ON UPDATE CASCADE);
			INSERT INTO synthetic_key_dependency SELECT 1,order_envelope FROM restaurant_key_state`
			if direction == "outgoing" {
				statement = `CREATE TABLE synthetic_key_dependency(id integer PRIMARY KEY, envelope bytea NOT NULL);
				INSERT INTO synthetic_key_dependency SELECT 1,order_envelope FROM restaurant_key_state;
				ALTER TABLE restaurant_key_state ADD CONSTRAINT synthetic_metadata_fk FOREIGN KEY(id) REFERENCES synthetic_key_dependency(id)`
			}
			if _, err := f.db.ExecContext(f.ctx, statement); err != nil {
				t.Fatal("could not construct synthetic metadata dependency", err)
			}
			var dependencyBefore []byte
			if err := f.db.QueryRowContext(f.ctx, `SELECT envelope FROM synthetic_key_dependency WHERE id=1`).Scan(&dependencyBefore); err != nil {
				t.Fatal(err)
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			both := restaurantMaintenanceRing(t, "new", "old", "new")
			if err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, both, "rotate", nil); err == nil {
				t.Fatal("rotation accepted metadata foreign-key side effects")
			}
			restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
			var dependencyAfter []byte
			if err := f.db.QueryRowContext(f.ctx, `SELECT envelope FROM synthetic_key_dependency WHERE id=1`).Scan(&dependencyAfter); err != nil || !bytes.Equal(dependencyBefore, dependencyAfter) {
				t.Fatal("rotation changed or removed dependent business data", err)
			}
		})
	}
}
