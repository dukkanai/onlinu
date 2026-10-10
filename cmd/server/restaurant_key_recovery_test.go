//go:build linux

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// This opt-in drill owns both clusters from initdb through process shutdown.
// It accepts a PostgreSQL binary directory, never an existing cluster, URL,
// archive, keyring or application configuration. All material is generated.
const restaurantRecoveryGate = "TEST_EXTERNAL_KEY_RECOVERY"
const restaurantRecoveryHelper = "ONLINU_RECOVERY_MAIN_HELPER"
const restaurantRecoveryArchiveLimit = 32 << 20

type restaurantRecoveryDenyHTTP struct{}

func (restaurantRecoveryDenyHTTP) RoundTrip(*http.Request) (*http.Response, error) {
	// No URL, headers or credentials are included in the diagnostic.
	_, _ = io.WriteString(os.Stderr, "synthetic-recovery-outbound-request-refused\n")
	return nil, errors.New("external HTTP is forbidden in synthetic recovery")
}

func restaurantRecoveryBytes(t *testing.T, size int) []byte {
	t.Helper()
	value := make([]byte, size)
	if _, err := rand.Read(value); err != nil {
		t.Fatal("cannot generate synthetic recovery material")
	}
	return value
}

func restaurantRecoveryFile(t *testing.T, root, name string, value []byte) string {
	t.Helper()
	path := filepath.Join(root, name)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal("cannot exclusively create private recovery fixture file")
	}
	_, writeErr := file.Write(value)
	syncErr, closeErr := file.Sync(), file.Close()
	if writeErr != nil || syncErr != nil || closeErr != nil {
		t.Fatal("cannot persist private recovery fixture file")
	}
	return path
}

func restaurantRecoveryEnvironment(root, bin string) []string {
	// No ambient PG*, WACALLS_*, proxies, provider secrets, optional import
	// directories, LD_PRELOAD or other subprocess helper flags are inherited.
	return []string{"PATH=" + bin + ":/usr/bin:/bin", "HOME=" + root, "LANG=C", "LC_ALL=C", "TZ=UTC"}
}

func restaurantRecoveryGroupGone(command *exec.Cmd) bool {
	return command.Process == nil || errors.Is(syscall.Kill(-command.Process.Pid, 0), syscall.ESRCH)
}

func restaurantRecoveryTerminateGroup(command *exec.Cmd) bool {
	if restaurantRecoveryGroupGone(command) {
		return true
	}
	_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
	for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
		if restaurantRecoveryGroupGone(command) {
			return true
		}
		time.Sleep(20 * time.Millisecond)
	}
	return false
}

func restaurantRecoveryCommand(t *testing.T, executable string, env []string, input []byte, limit int, safeToRemove *bool, args ...string) []byte {
	t.Helper()
	if safeToRemove != nil {
		*safeToRemove = false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, executable, args...)
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	// initdb may fork a bootstrap server. Cancel the group created for this
	// command, not a PID discovered from a file or an existing server.
	command.Cancel = func() error { return syscall.Kill(-command.Process.Pid, syscall.SIGKILL) }
	command.WaitDelay = 3 * time.Second
	command.Env = env
	if input != nil {
		command.Stdin = bytes.NewReader(input)
	}
	out, diagnostic := &restaurantRecoveryOutput{limit: limit}, &restaurantRecoveryOutput{limit: 256 << 10}
	command.Stdout, command.Stderr = out, diagnostic
	err := command.Run()
	value, overflow := out.snapshot()
	_, diagnosticOverflow := diagnostic.snapshot()
	if err != nil || ctx.Err() != nil || overflow || diagnosticOverflow || !restaurantRecoveryGroupGone(command) {
		// A failed initdb can leave a bootstrap child behind. Terminate only
		// this command's group, and leave its directory retained on any error.
		_ = restaurantRecoveryTerminateGroup(command)
		t.Fatal("owned synthetic PostgreSQL command failed; private output withheld")
	}
	if safeToRemove != nil {
		*safeToRemove = true
	}
	return value
}

func restaurantRecoveryAddress(t *testing.T) (string, int) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal("loopback socket unavailable; recovery drill cannot run in this environment")
	}
	port := listener.Addr().(*net.TCPAddr).Port
	_ = listener.Close()
	return net.JoinHostPort("127.0.0.1", strconv.Itoa(port)), port
}

type restaurantRecoveryCluster struct {
	root, data, bin, password, identity, started string
	port                                         int
	admin                                        *sql.DB
}

func (c *restaurantRecoveryCluster) dsn(database string) string {
	return (&url.URL{Scheme: "postgres", User: url.UserPassword("onlinu_fixture", c.password), Host: net.JoinHostPort("127.0.0.1", strconv.Itoa(c.port)), Path: "/" + database, RawQuery: "sslmode=disable"}).String()
}

func restaurantRecoveryStartCluster(t *testing.T, bin, share string) *restaurantRecoveryCluster {
	t.Helper()
	root, err := os.MkdirTemp("", "onlinu-key-recovery-")
	if err != nil {
		t.Fatal("cannot create private recovery directory")
	}
	started, stopped, initialized := false, false, true
	t.Cleanup(func() {
		// Never remove a running cluster's files if bounded shutdown failed.
		if initialized && (!started || stopped) {
			if err := os.RemoveAll(root); err != nil {
				t.Error("cannot remove this test's stopped recovery directory")
			}
		}
	})
	_, port := restaurantRecoveryAddress(t)
	c := &restaurantRecoveryCluster{root: root, data: filepath.Join(root, "data"), bin: bin, port: port, password: hex.EncodeToString(restaurantRecoveryBytes(t, 24))}
	pwfile := restaurantRecoveryFile(t, root, "password", []byte(c.password+"\n"))
	if _, err := os.Lstat(c.data); !os.IsNotExist(err) {
		t.Fatal("recovery cluster directory must not already exist")
	}
	env := restaurantRecoveryEnvironment(root, bin)
	restaurantRecoveryCommand(t, filepath.Join(bin, "initdb"), env, nil, 256<<10, &initialized, "-D", c.data, "-L", share, "-U", "onlinu_fixture", "--pwfile="+pwfile, "--auth-local=reject", "--auth-host=scram-sha-256", "--encoding=UTF8", "--locale=C")
	command := exec.Command(filepath.Join(bin, "postgres"), "-D", c.data, "-h", "127.0.0.1", "-p", strconv.Itoa(port), "-k", "", "-c", "dynamic_shared_memory_type=mmap", "-c", "max_connections=30", "-c", "timezone=UTC", "-c", "log_timezone=UTC")
	command.Env = env
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	command.WaitDelay = 3 * time.Second
	output := &restaurantRecoveryOutput{limit: 1 << 20}
	command.Stdout, command.Stderr = output, output
	if err := command.Start(); err != nil {
		t.Fatal("cannot start this test's PostgreSQL process")
	}
	started = true
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	// Registered after directory cleanup: process shutdown runs before removal.
	t.Cleanup(func() {
		if c.admin != nil {
			_ = c.admin.Close()
		}
		_ = command.Process.Signal(syscall.SIGINT)
		select {
		case err := <-done:
			stopped = err == nil && restaurantRecoveryGroupGone(command)
			if !stopped {
				stopped = restaurantRecoveryTerminateGroup(command)
				t.Error("owned recovery PostgreSQL process did not stop cleanly")
			}
		case <-time.After(10 * time.Second):
			// This process group was created above, never discovered or adopted.
			_ = syscall.Kill(-command.Process.Pid, syscall.SIGKILL)
			select {
			case <-done:
				stopped = restaurantRecoveryTerminateGroup(command)
			case <-time.After(5 * time.Second):
				t.Error("owned recovery process could not be reaped; its private directory is retained")
			}
			t.Error("owned recovery PostgreSQL process required forced cleanup")
		}
		if _, overflow := output.snapshot(); overflow {
			t.Error("owned recovery PostgreSQL diagnostics exceeded their bound")
		}
	})
	c.admin, err = sql.Open("pgx", c.dsn("postgres"))
	if err != nil {
		t.Fatal("cannot open owned recovery cluster")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	for c.admin.PingContext(ctx) != nil {
		if ctx.Err() != nil {
			t.Fatal("owned recovery PostgreSQL did not become ready")
		}
		time.Sleep(50 * time.Millisecond)
	}
	var actual, database, address string
	var actualPort int
	if err := c.admin.QueryRowContext(ctx, `SELECT current_setting('data_directory'),current_database(),host(inet_server_addr()),inet_server_port(),system_identifier::text,pg_postmaster_start_time()::text FROM pg_control_system()`).Scan(&actual, &database, &address, &actualPort, &c.identity, &c.started); err != nil || database != "postgres" || !restaurantRecoveryOwnedIdentity(c.data, actual, c.port, actualPort, address) {
		t.Fatal("PostgreSQL connection is not bound to the newly owned recovery cluster")
	}
	return c
}

func (c *restaurantRecoveryCluster) createDatabase(t *testing.T, name string) *sql.DB {
	t.Helper()
	if !regexp.MustCompile(`^recovery_[a-f0-9]{24}_(main|neighbor)$`).MatchString(name) {
		t.Fatal("unexpected generated recovery database name")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	var exists bool
	if err := c.admin.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, name).Scan(&exists); err != nil || exists {
		t.Fatal("recovery target is not absent; no overwrite or retry is allowed")
	}
	if _, err := c.admin.ExecContext(ctx, `CREATE DATABASE `+quoteIdent(name)); err != nil {
		t.Fatal("cannot create absent owned recovery database")
	}
	db, err := sql.Open("pgx", c.dsn(name))
	if err != nil {
		t.Fatal("cannot open newly created recovery database")
	}
	t.Cleanup(func() { _ = db.Close() })
	var database, schema string
	if err := db.QueryRowContext(ctx, `SELECT current_database(),current_schema()`).Scan(&database, &schema); err != nil || database != name || schema != "public" {
		t.Fatal("recovery database/schema identity differs")
	}
	return db
}

func restaurantRecoveryExec(t *testing.T, db *sql.DB, query string, args ...any) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if _, err := db.ExecContext(ctx, query, args...); err != nil {
		t.Fatal("synthetic recovery fixture statement failed; private details withheld")
	}
}

// Stable across clusters: physical OIDs and xmin are intentionally excluded.
// Every public table/sequence is included, not just the encrypted payloads.
func restaurantRecoveryFingerprint(t *testing.T, db *sql.DB) map[string]string {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		t.Fatal("cannot begin recovery fingerprint")
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `SET LOCAL timezone='UTC'`); err != nil {
		t.Fatal("cannot normalize recovery fingerprint timezone")
	}
	rows, err := tx.QueryContext(ctx, `SELECT c.relname,c.relkind::text FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','S') ORDER BY c.relname`)
	if err != nil {
		t.Fatal("cannot enumerate recovery relations")
	}
	var names, kinds []string
	for rows.Next() {
		var name, kind string
		if rows.Scan(&name, &kind) != nil || !regexp.MustCompile(`^[a-z][a-z0-9_]{0,62}$`).MatchString(name) || len(names) >= 300 {
			_ = rows.Close()
			t.Fatal("unexpected recovery relation inventory")
		}
		names, kinds = append(names, name), append(kinds, kind)
	}
	err = rows.Err()
	_ = rows.Close()
	if err != nil || len(names) == 0 {
		t.Fatal("empty or unreadable recovery relation inventory")
	}
	out := make(map[string]string, len(names))
	for i, name := range names {
		var value string
		query := `SELECT md5(COALESCE(jsonb_agg(row_data ORDER BY row_data::text)::text,'[]'))||':'||count(*)::text FROM (SELECT to_jsonb(t) AS row_data FROM public.` + quoteIdent(name) + ` t) logical_rows`
		if kinds[i] == "S" {
			query = `SELECT last_value::text||':'||is_called::text FROM public.` + quoteIdent(name)
		}
		if err := tx.QueryRowContext(ctx, query).Scan(&value); err != nil {
			t.Fatal("cannot calculate complete recovery fingerprint")
		}
		out[kinds[i]+":"+name] = value
	}
	if err := tx.Commit(); err != nil {
		t.Fatal("cannot finish recovery fingerprint")
	}
	return out
}

type restaurantRecoveryRuntime struct {
	root, namespace, store, master string
	mediaRoot                      string
	private                        []string
}

func (r *restaurantRecoveryRuntime) run(t *testing.T, c *restaurantRecoveryCluster, keyFile, maintenance string, serve, success bool) {
	t.Helper()
	address, _ := restaurantRecoveryAddress(t)
	dsn := c.dsn("postgres")
	dsnFile := restaurantRecoveryFile(t, t.TempDir(), "database", []byte(dsn))
	mediaRoot := r.mediaRoot
	if mediaRoot == "" {
		mediaRoot = filepath.Join(r.root, "media")
	}
	env := append(restaurantRecoveryEnvironment(r.root, c.bin), restaurantRecoveryHelper+"=1", "ONLINU_RECOVERY_NAMESPACE="+r.namespace, "ONLINU_RECOVERY_HTTP="+address, "ONLINU_RECOVERY_COMMAND="+maintenance,
		"WACALLS_PG_URL_FILE="+dsnFile, "WACALLS_API_KEY="+r.master, "WACALLS_MEDIA_DIR="+mediaRoot, "WACALLS_PUBLIC_BASE_URL=https://synthetic.invalid", "RESTAURANT_GEOGRAPHY_DATA_DIR=",
		restaurantCryptoModeSetting+"="+restaurantCryptoExternalMode, restaurantCryptoStoreSetting+"="+r.store, restaurantKeyringSetting+"_FILE="+keyFile)
	life, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	command := exec.CommandContext(life, os.Args[0], "-test.run=^TestRestaurantKeyRecoveryActualMainRuntime$")
	command.WaitDelay = 3 * time.Second
	command.Env = env
	output := &restaurantRecoveryOutput{limit: 256 << 10}
	command.Stdout, command.Stderr = output, output
	if err := command.Start(); err != nil {
		t.Fatal("cannot start isolated recovery main helper")
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	client := &http.Client{Timeout: 100 * time.Millisecond, Transport: &http.Transport{Proxy: nil}}
	defer client.CloseIdleConnections()
	served, ready := false, false
	var waitErr error
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	waiting := true
	for waiting {
		select {
		case waitErr = <-done:
			waiting = false
		case <-ticker.C:
			response, err := client.Get("http://" + address + "/healthz")
			if err == nil {
				served = true
				body, _ := io.ReadAll(io.LimitReader(response.Body, 128))
				_ = response.Body.Close()
				ready = response.StatusCode == http.StatusOK && string(body) == "ok\n"
				if serve && ready {
					_ = command.Process.Signal(syscall.SIGTERM)
					select {
					case waitErr = <-done:
					case <-time.After(10 * time.Second):
						cancel()
						select {
						case <-done:
						case <-time.After(5 * time.Second):
						}
						t.Fatal("isolated recovery main did not stop within its cleanup bound")
					}
					waiting = false
				}
			}
		}
	}
	logs, overflow := output.snapshot()
	for _, value := range append(append([]string{}, r.private...), dsn, c.password, dsnFile, keyFile, r.master) {
		if value != "" && bytes.Contains(logs, []byte(value)) {
			t.Fatal("actual-main logs disclosed private synthetic recovery material")
		}
	}
	if overflow || life.Err() != nil || bytes.Contains(logs, []byte("synthetic-recovery-outbound-request-refused")) || (waitErr == nil) != success {
		t.Fatal("unexpected isolated recovery main result; private output withheld")
	}
	if !success {
		var exited *exec.ExitError
		if !errors.As(waitErr, &exited) || !restaurantRecoveryExpectedRejection(logs, exited.ExitCode(), maintenance != "") {
			t.Fatal("recovery negative did not fail through the expected crypto rejection")
		}
	}
	if serve {
		if !ready {
			t.Fatal("restored external-v1 runtime did not become healthy")
		}
	} else if served || bytes.Contains(logs, []byte("HTTP server listening")) {
		t.Fatal("failed startup or offline recovery command served HTTP")
	}
	if maintenance != "" && success && !bytes.Contains(logs, []byte("restaurant crypto maintenance completed")) {
		t.Fatal("recovery command did not finish through offline main")
	}
}

type restaurantRecoveryPayload struct {
	receipt restaurantReceipt
	config  restaurantPaymentConfig
	attempt string
}

func restaurantRecoveryCiphers(t *testing.T, db *sql.DB, database string, ring *restaurantKeyring) *restaurantDataCiphers {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	owner, err := acquireInstanceOwnership(ctx, db, database)
	if err != nil {
		t.Fatal("cannot own synthetic recovery key state")
	}
	defer owner.Close()
	ciphers, err := restaurantLoadExternalKeys(ctx, owner, database, "public", ring)
	if err != nil {
		t.Fatal("cannot load verified synthetic recovery keys")
	}
	return ciphers
}

func restaurantRecoverySeed(t *testing.T, db *sql.DB, ciphers *restaurantDataCiphers) restaurantRecoveryPayload {
	t.Helper()
	orders := &restaurantOrders{store: &restaurantStore{db: db}, seal: ciphers.orders}
	payments := &restaurantPayments{db: db, orders: orders, seal: ciphers.payments}
	number := "SYNTHETIC-" + hex.EncodeToString(restaurantRecoveryBytes(t, 6))
	attempt := hex.EncodeToString(restaurantRecoveryBytes(t, 16))
	secret := restaurantOrderSecrets{TrackingToken: hex.EncodeToString(restaurantRecoveryBytes(t, 24)), AccessCode: hex.EncodeToString(restaurantRecoveryBytes(t, 8))}
	sealed, err := orders.sealOrderSecrets(number, secret)
	if err != nil {
		t.Fatal("cannot seal synthetic recovery receipt")
	}
	order := restaurantOrder{Number: number, Version: 1, Status: "completed", Mode: "pickup", Currency: "SAR", Demo: true}
	document, err := json.Marshal(order)
	if err != nil {
		t.Fatal("cannot encode synthetic recovery order")
	}
	tokenHash, codeHash := sha256.Sum256([]byte(secret.TrackingToken)), restaurantCodeHash(number, secret.AccessCode)
	requestHash, idempotencyHash := restaurantRecoveryBytes(t, 32), restaurantRecoveryBytes(t, 32)
	restaurantRecoveryExec(t, db, `INSERT INTO restaurant_orders(number,status,version,document,token_hash,code_hash,sealed_secrets,request_hash,idempotency_hash,created_at,updated_at) VALUES($1,'completed',1,$2,$3,$4,$5,$6,$7,now(),now())`, number, document, tokenHash[:], codeHash[:], sealed, requestHash, idempotencyHash)
	config := restaurantPaymentConfig{ID: "stripe", Mode: "test", Enabled: false, Values: map[string]string{}, Secrets: map[string]string{"secretKey": "synthetic-" + hex.EncodeToString(restaurantRecoveryBytes(t, 24))}}
	sealedConfig, err := payments.encrypt("config:stripe", config)
	if err != nil {
		t.Fatal("cannot seal disabled synthetic recovery configuration")
	}
	sealedAttempt, err := payments.encrypt("attempt:"+attempt, config)
	if err != nil {
		t.Fatal("cannot seal terminal synthetic recovery attempt")
	}
	restaurantRecoveryExec(t, db, `INSERT INTO restaurant_payment_configs(provider,sealed) VALUES('stripe',$1)`, sealedConfig)
	restaurantRecoveryExec(t, db, `INSERT INTO restaurant_payment_attempts(id,order_number,provider,mode,status,sealed_config) VALUES($1,$2,'stripe','test','failed',$3)`, attempt, number, sealedAttempt)
	// Non-crypto business data and a non-default application sequence prevent
	// a payload-only check from masquerading as complete database recovery.
	restaurantRecoveryExec(t, db, `INSERT INTO restaurant_catalog_audit(version,actor_id,actor_scope,kind,target_id) VALUES(47,'synthetic','fixture','recovery','catalog'); SELECT setval('restaurant_order_number_seq',41,true)`)
	restaurantNormalizeLegacyOrder(&order)
	return restaurantRecoveryPayload{receipt: restaurantReceipt{Order: order, TrackingToken: secret.TrackingToken, AccessCode: secret.AccessCode}, config: config, attempt: attempt}
}

func restaurantRecoveryCheckPayload(t *testing.T, db *sql.DB, ciphers *restaurantDataCiphers, want restaurantRecoveryPayload) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	orders := &restaurantOrders{store: &restaurantStore{db: db}, seal: ciphers.orders}
	payments := &restaurantPayments{db: db, orders: orders, seal: ciphers.payments}
	stored, err := restaurantReadStored(db.QueryRowContext(ctx, restaurantOrderSelect+` WHERE number=$1`, want.receipt.Order.Number))
	if err != nil {
		t.Fatal("cannot read restored synthetic receipt")
	}
	receipt, err := orders.receipt(stored)
	if err != nil || !reflect.DeepEqual(receipt, want.receipt) {
		t.Fatal("restored receipt differs from generated source payload")
	}
	config, err := payments.config(ctx, "stripe")
	if err != nil || !reflect.DeepEqual(config, want.config) {
		t.Fatal("restored disabled payment configuration differs")
	}
	attempt, err := payments.readAttempt(db.QueryRowContext(ctx, restaurantPaymentAttemptSelect+` WHERE id=$1`, want.attempt))
	if err != nil || !reflect.DeepEqual(attempt.Config, want.config) || attempt.Status != "failed" {
		t.Fatal("restored terminal payment attempt differs")
	}
	restaurantMaintenanceCheckFence(t, ctx, db)
}

// Shared by the key and media drills; never accepts a database URL or existing cluster.
func restaurantRecoveryPostgres(t *testing.T) (string, string) {
	t.Helper()
	if os.Getenv(restaurantRecoveryGate) == "" {
		t.Skip("set TEST_EXTERNAL_KEY_RECOVERY=1 and TEST_EXTERNAL_KEY_RECOVERY_PG_BIN for two newly owned synthetic clusters")
	}
	if os.Getenv(restaurantRecoveryGate) != "1" || os.Geteuid() == 0 {
		t.Fatal("synthetic recovery requires explicit opt-in and a non-root Linux process")
	}
	for _, entry := range os.Environ() {
		name, value, _ := strings.Cut(entry, "=")
		if strings.HasPrefix(name, "PG") && value != "" {
			t.Fatal("synthetic recovery refuses inherited PG connection settings")
		}
	}
	bin := os.Getenv("TEST_EXTERNAL_KEY_RECOVERY_PG_BIN")
	if !filepath.IsAbs(bin) || filepath.Clean(bin) != bin {
		t.Fatal("an explicit absolute PostgreSQL binary directory is required")
	}
	for _, name := range []string{"postgres", "initdb", "pg_dump", "pg_restore"} {
		info, err := os.Lstat(filepath.Join(bin, name))
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
			t.Fatal("required official PostgreSQL binary is unavailable")
		}
	}
	version := restaurantRecoveryCommand(t, filepath.Join(bin, "postgres"), restaurantRecoveryEnvironment(t.TempDir(), bin), nil, 1024, nil, "--version")
	match := regexp.MustCompile(`^postgres \(PostgreSQL\) (16|17)\.`).FindSubmatch(version)
	if len(match) != 2 {
		t.Fatal("this fixture requires the reviewed PostgreSQL 16 or 17 binary layout")
	}
	share := filepath.Clean(filepath.Join(bin, "../../../../share/postgresql", string(match[1])))
	if info, err := os.Stat(filepath.Join(share, "postgres.bki")); err != nil || !info.Mode().IsRegular() {
		t.Fatal("PostgreSQL initialization data is unavailable")
	}
	return bin, share
}

func TestRestaurantKeyRecoveryActualMainRuntime(t *testing.T) {
	if os.Getenv(restaurantRecoveryHelper) == "1" {
		http.DefaultTransport = restaurantRecoveryDenyHTTP{}
		flag.CommandLine = flag.NewFlagSet("wacalls", flag.ExitOnError)
		os.Args = []string{"wacalls", "-addr", os.Getenv("ONLINU_RECOVERY_HTTP"), "-pg-namespace", os.Getenv("ONLINU_RECOVERY_NAMESPACE"), "-static="}
		if command := os.Getenv("ONLINU_RECOVERY_COMMAND"); command != "" {
			os.Args = append(os.Args, "-crypto-command", command)
		}
		main()
		return
	}
	bin, share := restaurantRecoveryPostgres(t)
	for _, generation := range []string{"historical", "current"} {
		t.Run(generation, func(t *testing.T) {
			source, target := restaurantRecoveryStartCluster(t, bin, share), restaurantRecoveryStartCluster(t, bin, share)
			if source.identity == target.identity || source.port == target.port || source.data == target.data {
				t.Fatal("recovery requires two independently owned clusters")
			}
			namespace := "recovery_" + hex.EncodeToString(restaurantRecoveryBytes(t, 12))
			database := namespace + "_main"
			sourceDB := source.createDatabase(t, database)
			sourceNeighbor, targetNeighbor := source.createDatabase(t, namespace+"_neighbor"), target.createDatabase(t, namespace+"_neighbor")
			for _, db := range []*sql.DB{sourceNeighbor, targetNeighbor} {
				restaurantRecoveryExec(t, db, `CREATE TABLE recovery_neighbor(id integer PRIMARY KEY, marker text NOT NULL); INSERT INTO recovery_neighbor VALUES(1,'synthetic-neighbor')`)
			}
			neighbors := []map[string]string{restaurantRecoveryFingerprint(t, sourceNeighbor), restaurantRecoveryFingerprint(t, targetNeighbor)}
			root := t.TempDir()
			r := &restaurantRecoveryRuntime{root: root, namespace: namespace, store: "synthetic-" + hex.EncodeToString(restaurantRecoveryBytes(t, 12)), master: hex.EncodeToString(restaurantRecoveryBytes(t, 24))}
			old, current, wrong := restaurantRecoveryBytes(t, 32), restaurantRecoveryBytes(t, 32), restaurantRecoveryBytes(t, 32)
			ringFiles := make(map[string]string)
			rings := make(map[string]*restaurantKeyring)
			for name, spec := range map[string]struct {
				active string
				keys   map[string][]byte
			}{"old": {"old", map[string][]byte{"old": old}}, "new": {"new", map[string][]byte{"new": current}}, "retained": {"new", map[string][]byte{"old": old, "new": current}}, "wrong-old": {"new", map[string][]byte{"old": wrong, "new": current}}, "wrong-new": {"new", map[string][]byte{"old": old, "new": wrong}}} {
				raw := restaurantTestKeyringJSON(t, r.store, spec.active, spec.keys)
				ringFiles[name] = restaurantRecoveryFile(t, root, name, raw)
				rings[name] = restaurantTestKeyring(t, r.store, spec.active, spec.keys)
				r.private = append(r.private, string(raw))
			}
			for _, key := range [][]byte{old, current, wrong} {
				r.private = append(r.private, base64.StdEncoding.EncodeToString(key))
			}
			r.run(t, source, ringFiles["old"], "init", false, true)
			r.run(t, source, ringFiles["old"], "", true, true)
			payload := restaurantRecoverySeed(t, sourceDB, restaurantRecoveryCiphers(t, sourceDB, database, rings["old"]))
			r.private = append(r.private, payload.receipt.TrackingToken, payload.receipt.AccessCode, payload.config.Secrets["secretKey"])
			good, missing, bad := "retained", "new", "wrong-old"
			if generation == "current" {
				before := restaurantRecoveryFingerprint(t, sourceDB)
				r.run(t, source, ringFiles["retained"], "rotate", false, true)
				after := restaurantRecoveryFingerprint(t, sourceDB)
				if before["r:restaurant_key_state"] == after["r:restaurant_key_state"] {
					t.Fatal("synthetic rotation did not change external envelopes")
				}
				delete(before, "r:restaurant_key_state")
				delete(after, "r:restaurant_key_state")
				if !reflect.DeepEqual(before, after) {
					t.Fatal("synthetic rotation changed business payloads")
				}
				good, missing, bad = "new", "old", "wrong-new"
			}
			r.run(t, source, ringFiles[good], "verify", false, true)
			before := restaurantRecoveryFingerprint(t, sourceDB)
			pgEnv := append(restaurantRecoveryEnvironment(source.root, bin), "PGPASSWORD="+source.password)
			archive := restaurantRecoveryCommand(t, filepath.Join(bin, "pg_dump"), pgEnv, nil, restaurantRecoveryArchiveLimit, nil, "-h", "127.0.0.1", "-p", strconv.Itoa(source.port), "-U", "onlinu_fixture", "-d", database, "--format=custom", "--no-owner", "--no-acl")
			if !bytes.HasPrefix(archive, []byte("PGDMP")) || len(archive) <= 5 {
				t.Fatal("unexpected synthetic archive format")
			}
			archiveHash := sha256.Sum256(archive)
			archivePath := restaurantRecoveryFile(t, root, "main.dump", archive)
			readback, err := os.ReadFile(archivePath)
			if err != nil || sha256.Sum256(readback) != archiveHash {
				t.Fatal("private synthetic archive readback differs")
			}
			targetDB := target.createDatabase(t, database)
			pgEnv = append(restaurantRecoveryEnvironment(target.root, bin), "PGPASSWORD="+target.password)
			restaurantRecoveryCommand(t, filepath.Join(bin, "pg_restore"), pgEnv, readback, 256<<10, nil, "-h", "127.0.0.1", "-p", strconv.Itoa(target.port), "-U", "onlinu_fixture", "-d", database, "--exit-on-error", "--no-owner", "--no-acl")
			if !reflect.DeepEqual(before, restaurantRecoveryFingerprint(t, targetDB)) {
				t.Fatal("restored public tables or sequences differ from the source")
			}
			// A target-only rename makes an incorrectly reached schema initializer
			// observable even though the rest of the restored schema is complete.
			restaurantRecoveryExec(t, targetDB, `ALTER TABLE restaurant_catalog RENAME TO recovery_startup_sentinel`)
			ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
			defer cancel()
			unchanged := restaurantMaintenanceSnapshot(t, ctx, targetDB)
			negativeBefore := restaurantRecoveryFingerprint(t, targetDB)
			for _, key := range []string{missing, bad} {
				r.run(t, target, ringFiles[key], "verify", false, false)
				r.run(t, target, ringFiles[key], "", false, false)
				restaurantMaintenanceUnchanged(t, ctx, targetDB, unchanged)
				if !reflect.DeepEqual(negativeBefore, restaurantRecoveryFingerprint(t, targetDB)) {
					t.Fatal("failed recovery changed business tables or sequences")
				}
			}
			restaurantRecoveryExec(t, targetDB, `ALTER TABLE recovery_startup_sentinel RENAME TO restaurant_catalog`)
			r.run(t, target, ringFiles[good], "verify", false, true)
			r.run(t, target, ringFiles[good], "", true, true)
			restaurantRecoveryCheckPayload(t, targetDB, restaurantRecoveryCiphers(t, targetDB, database, rings[good]), payload)
			if !reflect.DeepEqual(before, restaurantRecoveryFingerprint(t, targetDB)) || !reflect.DeepEqual(before, restaurantRecoveryFingerprint(t, sourceDB)) {
				t.Fatal("recovery startup changed restored data, wrapping generation or source")
			}
			for i, db := range []*sql.DB{sourceNeighbor, targetNeighbor} {
				if !reflect.DeepEqual(neighbors[i], restaurantRecoveryFingerprint(t, db)) {
					t.Fatal("synthetic neighbor changed during recovery")
				}
			}
			for _, c := range []*restaurantRecoveryCluster{source, target} {
				var identity, started string
				if err := c.admin.QueryRowContext(ctx, `SELECT system_identifier::text,pg_postmaster_start_time()::text FROM pg_control_system()`).Scan(&identity, &started); err != nil || identity != c.identity || started != c.started {
					t.Fatal("recovery cluster identity or neighbor uptime changed")
				}
			}
			logical, err := json.Marshal(before)
			if err != nil {
				t.Fatal("cannot encode bounded recovery evidence")
			}
			t.Logf("Synthetic %s recovery passed: archiveBytes=%d archiveSHA256=%x relations=%d logicalSHA256=%x; exact identity, payloads, fences, refusal-before-schema/HTTP, unchanged source and neighbors verified", generation, len(archive), archiveHash, len(before), sha256.Sum256(logical))
		})
	}
}
