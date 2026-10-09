package main

import (
	"bytes"
	"context"
	"crypto/cipher"
	"database/sql"
	"database/sql/driver"
	"errors"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func restaurantRuntimeTestEnvironment(t *testing.T, values map[string]string) {
	t.Helper()
	for _, name := range []string{
		restaurantCryptoModeSetting, restaurantCryptoModeSetting + "_FILE",
		restaurantCryptoStoreSetting, restaurantCryptoStoreSetting + "_FILE",
		restaurantKeyringSetting, restaurantKeyringSetting + "_FILE",
		"WACALLS_PLATFORM_TENANT_ID", "WACALLS_PLATFORM_ISSUER", "WACALLS_PLATFORM_PUBLIC_KEY",
	} {
		t.Setenv(name, values[name])
	}
}

func TestRestaurantCryptoRuntimeModeIsExplicit(t *testing.T) {
	raw := string(restaurantTestKeyringJSON(t, "store-a", "k1", map[string][]byte{"k1": bytes.Repeat([]byte{0x53}, 32)}))
	valid := map[string]string{restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting: raw}
	get := func(values map[string]string) func(string) string {
		return func(name string) string { return values[name] }
	}
	for name, values := range map[string]map[string]string{
		"absent": {},
		"unrelated platform setting remains legacy": {"WACALLS_PLATFORM_TENANT_ID": "store-a"},
	} {
		t.Run(name, func(t *testing.T) {
			if ring, err := restaurantCryptoRingFromEnv(get(values)); err != nil || ring != nil {
				t.Fatal("unconfigured legacy runtime changed", err)
			}
		})
	}
	path := filepath.Join(t.TempDir(), "synthetic-keyring")
	if err := os.WriteFile(path, []byte(raw), 0600); err != nil {
		t.Fatal(err)
	}
	for name, values := range map[string]map[string]string{
		"inline":                   valid,
		"file":                     {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting + "_FILE": path},
		"matching platform tenant": {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting: raw, "WACALLS_PLATFORM_TENANT_ID": "store-a"},
	} {
		t.Run(name, func(t *testing.T) {
			ring, err := restaurantCryptoRingFromEnv(get(values))
			if err != nil || ring == nil || ring.storeID != "store-a" {
				t.Fatal("valid explicit external configuration rejected", err)
			}
		})
	}
	if ring, err := restaurantCryptoRingFromEnv(nil); ring != nil || err != errRestaurantCryptoConfiguration {
		t.Fatal("nil configuration reader accepted")
	}
}

func TestRestaurantCryptoBadStartupFailsBeforeDatabase(t *testing.T) {
	raw := string(restaurantTestKeyringJSON(t, "store-a", "k1", map[string][]byte{"k1": bytes.Repeat([]byte{0x53}, 32)}))
	// A malformed DSN is a sentinel: if either database opener ran first it
	// would return its own error, rather than the configuration error below.
	const forbiddenDatabase = "postgres://user:PRIVATE_DATABASE_MARKER%zz@localhost/postgres"
	for name, values := range map[string]map[string]string{
		"key without mode":       {restaurantKeyringSetting: raw},
		"file without mode":      {restaurantKeyringSetting + "_FILE": "PRIVATE_PATH_MARKER"},
		"store without mode":     {restaurantCryptoStoreSetting: "store-a"},
		"unknown mode":           {restaurantCryptoModeSetting: "legacy"},
		"unknown mode with keys": {restaurantCryptoModeSetting: "external-v2", restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting: raw},
		"padded mode":            {restaurantCryptoModeSetting: " external-v1"},
		"missing store":          {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantKeyringSetting: raw},
		"invalid store":          {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store.a", restaurantKeyringSetting: raw},
		"wrong ring store":       {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-b", restaurantKeyringSetting: raw},
		"wrong platform tenant":  {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting: raw, "WACALLS_PLATFORM_TENANT_ID": "store-b"},
		"missing keys":           {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a"},
		"malformed keys":         {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting: "PRIVATE_KEY_MARKER"},
		"missing key file":       {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting + "_FILE": filepath.Join(t.TempDir(), "PRIVATE_PATH_MARKER")},
		"ambiguous key source":   {restaurantCryptoModeSetting: restaurantCryptoExternalMode, restaurantCryptoStoreSetting: "store-a", restaurantKeyringSetting: raw, restaurantKeyringSetting + "_FILE": "PRIVATE_PATH_MARKER"},
		"unsupported store file": {restaurantCryptoStoreSetting + "_FILE": "PRIVATE_PATH_MARKER"},
		"unsupported mode file":  {restaurantCryptoModeSetting + "_FILE": "PRIVATE_PATH_MARKER"},
	} {
		t.Run(name, func(t *testing.T) {
			restaurantRuntimeTestEnvironment(t, values)
			wantRing, wantErr := restaurantCryptoRingFromEnv(os.Getenv)
			if wantRing != nil || wantErr == nil {
				t.Fatal("bad configuration was accepted")
			}
			var logged bytes.Buffer
			srv, err := newServer(context.Background(), forbiddenDatabase, "synthetic", "", slog.New(slog.NewTextHandler(&logged, nil)))
			if srv != nil || err != wantErr || logged.Len() != 0 {
				t.Fatal("startup contacted database or did not stop at private crypto validation")
			}
			for _, command := range []string{"init", "migrate", "rotate", "verify"} {
				if err := restaurantRunKeyMaintenance(context.Background(), forbiddenDatabase, "synthetic", command); err != wantErr {
					t.Fatal("maintenance did not validate crypto before opening database")
				}
			}
			for _, marker := range []string{"PRIVATE_", raw} {
				if strings.Contains(err.Error(), marker) {
					t.Fatal("configuration failure disclosed private material")
				}
			}
		})
	}
}

func TestRestaurantCryptoMaintenanceRequiresExternalModeAndKnownCommand(t *testing.T) {
	restaurantRuntimeTestEnvironment(t, nil)
	for _, command := range []string{"", "init", "migrate", "rotate", "verify", "repair", "PRIVATE_COMMAND_MARKER"} {
		if err := restaurantRunKeyMaintenance(context.Background(), "", "synthetic", command); err != errRestaurantCryptoConfiguration {
			t.Fatal("maintenance accepted legacy mode or invalid command")
		}
	}
}

func TestRestaurantExistingDatabaseConfigurationPinsIdentity(t *testing.T) {
	t.Setenv("PGOPTIONS", "")
	t.Setenv("PGSERVICE", "")
	for _, namespace := range []string{"", "wacalls", "store_123", "_private", "UpperCase", strings.Repeat("x", 58)} {
		config, err := restaurantExistingDatabaseConfig("postgres://user:synthetic@localhost/postgres?sslmode=disable", namespace)
		if namespace == "" {
			namespace = "wacalls"
		}
		if err != nil || config == nil || config.Database != namespace+"_main" || config.RuntimeParams["search_path"] != "public" {
			t.Fatal("database identity or public schema not pinned", err)
		}
	}
	if _, err := restaurantExistingDatabaseConfig("postgresql://localhost/postgres?search_path=public", "test"); err != nil {
		t.Fatal("explicit public schema rejected")
	}
	for _, namespace := range []string{"9store", "store-a", "a.b", "a/b", "a b", "a\x00b", "مطبخ", strings.Repeat("x", 59)} {
		if config, err := restaurantExistingDatabaseConfig("postgres://localhost/postgres", namespace); config != nil || err != errRestaurantCryptoDatabase {
			t.Fatal("unsafe or truncated database namespace accepted")
		}
	}
	for _, url := range []string{
		"", "not-a-url", "host=localhost dbname=postgres", "https://localhost/postgres",
		"postgres://user:PRIVATE_DSN_MARKER%zz@localhost/postgres",
		"postgres://localhost/postgres?search_path=other", "postgres://localhost/postgres?search_path=",
		"postgres://localhost/postgres?SEARCH_PATH=public", "postgres://localhost/postgres?search_path=public&search_path=other",
		"postgres://localhost/postgres?options=-csearch_path%3Dother", "postgres://localhost/postgres?options=",
		"postgres://localhost/postgres?OPTIONS=-csearch_path%3Dother", "postgres://localhost/postgres?dbname=other",
		"postgres://localhost/postgres?database=other", "postgres://localhost/postgres?bad=%zz", "postgres://localhost/postgres#fragment",
	} {
		if config, err := restaurantExistingDatabaseConfig(url, "test"); config != nil || err != errRestaurantCryptoDatabase {
			t.Fatal("unsafe database configuration accepted or error not sanitized")
		}
	}
	t.Setenv("PGOPTIONS", "-c search_path=PRIVATE_SCHEMA_MARKER")
	if config, err := restaurantExistingDatabaseConfig("postgres://localhost/postgres", "test"); config != nil || err != errRestaurantCryptoDatabase {
		t.Fatal("inherited options can override pinned search path")
	}
}

// An isolated in-memory SQL driver records schema calls and refuses every
// query/key-table operation. No PostgreSQL instance or network is involved.
type restaurantRuntimeSchemaDriver struct{}
type restaurantRuntimeSchemaConnector struct{ conn *restaurantRuntimeSchemaConn }
type restaurantRuntimeSchemaConn struct{ statements []string }

func (restaurantRuntimeSchemaDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("unused")
}
func (c restaurantRuntimeSchemaConnector) Connect(context.Context) (driver.Conn, error) {
	return c.conn, nil
}
func (restaurantRuntimeSchemaConnector) Driver() driver.Driver {
	return restaurantRuntimeSchemaDriver{}
}
func (*restaurantRuntimeSchemaConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("unexpected prepare")
}
func (*restaurantRuntimeSchemaConn) Close() error { return nil }
func (*restaurantRuntimeSchemaConn) Begin() (driver.Tx, error) {
	return nil, errors.New("unexpected transaction")
}
func (c *restaurantRuntimeSchemaConn) ExecContext(_ context.Context, query string, _ []driver.NamedValue) (driver.Result, error) {
	c.statements = append(c.statements, query)
	if strings.Contains(query, "restaurant_order_secret") || strings.Contains(query, "restaurant_payment_secret") {
		return nil, errors.New("external constructor accessed legacy key storage")
	}
	return driver.RowsAffected(0), nil
}
func (*restaurantRuntimeSchemaConn) QueryContext(context.Context, string, []driver.NamedValue) (driver.Rows, error) {
	return nil, errors.New("external constructor queried database key material")
}

type restaurantRuntimeUnusedAEAD struct{}

func (*restaurantRuntimeUnusedAEAD) NonceSize() int { panic("constructor used supplied cipher") }
func (*restaurantRuntimeUnusedAEAD) Overhead() int  { panic("constructor used supplied cipher") }
func (*restaurantRuntimeUnusedAEAD) Seal([]byte, []byte, []byte, []byte) []byte {
	panic("constructor used supplied cipher")
}
func (*restaurantRuntimeUnusedAEAD) Open([]byte, []byte, []byte, []byte) ([]byte, error) {
	panic("constructor used supplied cipher")
}

func TestRestaurantExternalConstructorsNeverAccessLegacyKeys(t *testing.T) {
	t.Setenv("WACALLS_PAYMENT_SETTLEMENT_WATCH_DAYS", "30")
	t.Setenv("WACALLS_PAYMENT_SETTLEMENT_CHECK_MINUTES", "60")
	conn := &restaurantRuntimeSchemaConn{}
	db := sql.OpenDB(restaurantRuntimeSchemaConnector{conn: conn})
	defer db.Close()
	seal := &restaurantRuntimeUnusedAEAD{}
	orders, err := newRestaurantOrders(context.Background(), &restaurantStore{db: db}, seal)
	if err != nil || orders == nil || orders.seal != seal {
		t.Fatal("external order constructor did not preserve injected cipher", err)
	}
	payments, err := newRestaurantPayments(context.Background(), db, orders, "https://synthetic.test", seal)
	if err != nil || payments == nil || payments.seal != seal {
		t.Fatal("external payment constructor did not preserve injected cipher", err)
	}
	if len(conn.statements) == 0 {
		t.Fatal("test did not exercise schema initialization")
	}
}

func TestRestaurantConstructorsRejectInvalidCipherBeforeDatabase(t *testing.T) {
	seal := &restaurantRuntimeUnusedAEAD{}
	var typedNil *restaurantRuntimeUnusedAEAD
	for _, supplied := range [][]cipher.AEAD{{nil}, {typedNil}, {seal, seal}, {nil, seal}} {
		if orders, err := newRestaurantOrders(context.Background(), nil, supplied...); orders != nil || err != errRestaurantDataCipher {
			t.Fatal("invalid order cipher did not fail before accessing nil database")
		}
		if payments, err := newRestaurantPayments(context.Background(), nil, nil, "", supplied...); payments != nil || err != errRestaurantDataCipher {
			t.Fatal("invalid payment cipher did not fail before accessing nil database")
		}
	}
	if seal, external, err := restaurantCipherOverride(nil); seal != nil || external || err != nil {
		t.Fatal("legacy constructor form rejected")
	}
}
