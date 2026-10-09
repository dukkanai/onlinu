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
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

// Keep only enough trailing bytes to match two static diagnostic markers.
// Historical errors can include attempted synthetic key bytes, so never retain
// full output or print it. Success requires proof the actual CHECK fence ran.
type restaurantHistoricalFenceLog struct {
	mu                         sync.Mutex
	tail                       string
	constraint, checkViolation bool
}

func (w *restaurantHistoricalFenceLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	written := len(p)
	const keep = 64
	for len(p) > 0 {
		n := len(p)
		if n > keep {
			n = keep
		}
		chunk := w.tail + string(p[:n])
		w.constraint = w.constraint || strings.Contains(chunk, restaurantKeyFence)
		w.checkViolation = w.checkViolation || strings.Contains(chunk, "SQLSTATE 23514")
		if len(chunk) > keep {
			chunk = chunk[len(chunk)-keep:]
		}
		w.tail = chunk
		p = p[n:]
	}
	return written, nil
}

func TestRestaurantCryptoHistoricalFenceLogMarkers(t *testing.T) {
	for _, size := range []int{1, 7, 64, 4096} {
		w := &restaurantHistoricalFenceLog{}
		raw := strings.Repeat("synthetic-private-value", 100) + "violates check constraint " + restaurantKeyFence + " (SQLSTATE 23514)"
		for len(raw) > 0 {
			n := size
			if n > len(raw) {
				n = len(raw)
			}
			if written, err := w.Write([]byte(raw[:n])); err != nil || written != n {
				t.Fatal("matcher write failed")
			}
			raw = raw[n:]
		}
		if !w.constraint || !w.checkViolation || len(w.tail) > 64 {
			t.Fatal("fence markers were not detected with bounded storage")
		}
	}
	for _, raw := range []string{"startup failed", restaurantKeyFence, "SQLSTATE 23514"} {
		w := &restaurantHistoricalFenceLog{}
		_, _ = w.Write([]byte(raw))
		if w.constraint && w.checkViolation {
			t.Fatal("unrelated startup error accepted as a fence")
		}
	}
}

// Opt-in subprocess coverage for the actual main path. It creates only fresh,
// random databases in the guarded loopback test cluster. All keys are synthetic;
// no configured provider, production database or deployment keyring is used.
func TestRestaurantCryptoActualMainRuntime(t *testing.T) {
	if os.Getenv("ONLINU_CRYPTO_RUNTIME_HELPER") == "1" {
		flag.CommandLine = flag.NewFlagSet("wacalls", flag.ExitOnError)
		os.Args = []string{"wacalls", "-addr", os.Getenv("ONLINU_CRYPTO_HTTP_ADDR"), "-pg-namespace", os.Getenv("ONLINU_CRYPTO_NAMESPACE"), "-static="}
		if command := os.Getenv("ONLINU_CRYPTO_COMMAND"); command != "" {
			os.Args = append(os.Args, "-crypto-command", command)
		}
		main()
		return
	}
	if os.Getenv("TEST_RUNTIME_MAIN") != "1" {
		t.Skip("set TEST_RUNTIME_MAIN=1 for isolated external-key actual-main startup")
	}
	restaurantMaintenanceRequireTestURL(t)
	raw := os.Getenv("TEST_RESTAURANT_PG_URL")
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Path != "/astracalls_restaurant_test" || parsed.RawQuery != "sslmode=disable" || parsed.Fragment != "" || parsed.User == nil || parsed.User.Username() == "" || !(parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1") {
		t.Fatal("crypto runtime smoke requires the dedicated loopback restaurant test database")
	}
	admin, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal("cannot open fixture maintenance connection")
	}
	t.Cleanup(func() { _ = admin.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	var actualDB string
	err = admin.QueryRowContext(ctx, `SELECT current_database()`).Scan(&actualDB)
	cancel()
	if err != nil || actualDB != "astracalls_restaurant_test" {
		t.Fatal("refusing crypto runtime fixture outside guarded test database")
	}

	newFixture := func(t *testing.T) (string, *sql.DB) {
		t.Helper()
		var unique [16]byte
		if _, err := rand.Read(unique[:]); err != nil {
			t.Fatal(err)
		}
		namespace := "onlinu_crypto_test_" + hex.EncodeToString(unique[:])
		database := namespace + "_main"
		checkCtx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		var exists bool
		if err := admin.QueryRowContext(checkCtx, `SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)`, database).Scan(&exists); err != nil || exists {
			t.Fatal("crypto runtime fixture must not already exist")
		}
		if _, err := admin.ExecContext(checkCtx, `CREATE DATABASE `+quoteIdent(database)); err != nil {
			t.Fatal("cannot create fresh crypto runtime fixture database")
		}
		t.Cleanup(func() {
			if database != "onlinu_crypto_test_"+hex.EncodeToString(unique[:])+"_main" {
				t.Error("unsafe crypto runtime cleanup refused")
				return
			}
			cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cleanupCancel()
			// No FORCE and no names supplied by the environment or user. Only
			// the database proven absent and created by this fixture is removed.
			for {
				if _, err := admin.ExecContext(cleanupCtx, `DROP DATABASE `+quoteIdent(database)); err == nil {
					return
				}
				if cleanupCtx.Err() != nil {
					t.Error("could not remove owned crypto runtime fixture")
					return
				}
				time.Sleep(100 * time.Millisecond)
			}
		})
		db, err := openExistingRestaurantDatabase(checkCtx, raw, namespace)
		if err != nil {
			t.Fatal("cannot open owned crypto runtime fixture")
		}
		t.Cleanup(func() { _ = db.Close() })
		return namespace, db
	}

	root := t.TempDir()
	keyring := restaurantTestKeyringJSON(t, "synthetic-store", "k1", map[string][]byte{"k1": bytes.Repeat([]byte{0x65}, 32)})
	wrongKeyring := restaurantTestKeyringJSON(t, "synthetic-store", "k1", map[string][]byte{"k1": bytes.Repeat([]byte{0x66}, 32)})
	keyFile, wrongKeyFile, pgFile := filepath.Join(root, "private-keyring"), filepath.Join(root, "private-wrong-keyring"), filepath.Join(root, "private-database")
	for path, value := range map[string][]byte{keyFile: keyring, wrongKeyFile: wrongKeyring, pgFile: []byte(raw)} {
		if err := os.WriteFile(path, value, 0600); err != nil {
			t.Fatal("cannot prepare private synthetic runtime fixture")
		}
	}
	master := "synthetic-crypto-runtime-master"
	environment := func(namespace, address, command, keyPath, store string, external bool) []string {
		var clean []string
		for _, value := range cleanRuntimeSecretEnvironment() {
			// Do not inherit connection overrides, another subprocess helper,
			// or an optional import path into this synthetic test runtime.
			if !strings.HasPrefix(value, "PG") && !strings.HasPrefix(value, "ONLINU_CRYPTO_") && !strings.HasPrefix(value, "RESTAURANT_GEOGRAPHY_DATA_DIR=") {
				clean = append(clean, value)
			}
		}
		clean = append(clean, "ONLINU_CRYPTO_RUNTIME_HELPER=1", "ONLINU_CRYPTO_NAMESPACE="+namespace, "ONLINU_CRYPTO_HTTP_ADDR="+address, "ONLINU_CRYPTO_COMMAND="+command,
			"WACALLS_PG_URL_FILE="+pgFile, "WACALLS_API_KEY="+master, "WACALLS_MEDIA_DIR="+filepath.Join(root, "media"), "RESTAURANT_GEOGRAPHY_DATA_DIR=", "WACALLS_PUBLIC_BASE_URL=https://synthetic.invalid")
		if external {
			clean = append(clean, restaurantCryptoModeSetting+"="+restaurantCryptoExternalMode, restaurantCryptoStoreSetting+"="+store)
			if keyPath != "" {
				clean = append(clean, restaurantKeyringSetting+"_FILE="+keyPath)
			}
		}
		return clean
	}
	privateLogs := func(t *testing.T, output []byte) {
		t.Helper()
		for _, private := range []string{raw, master, keyFile, wrongKeyFile, pgFile, string(keyring), string(wrongKeyring), base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x65}, 32)), base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x66}, 32))} {
			if strings.Contains(string(output), private) {
				t.Fatal("actual-main output exposed private fixture material")
			}
		}
	}
	address := func(t *testing.T) string {
		t.Helper()
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal("cannot allocate loopback runtime address")
		}
		value := listener.Addr().String()
		_ = listener.Close()
		return value
	}
	runCommand := func(t *testing.T, namespace, command, keyPath, store string, external, success bool) {
		t.Helper()
		life, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		cmd := exec.CommandContext(life, os.Args[0], "-test.run=^TestRestaurantCryptoActualMainRuntime$")
		cmd.Env = environment(namespace, address(t), command, keyPath, store, external)
		output, err := cmd.CombinedOutput()
		privateLogs(t, output)
		if life.Err() != nil || (err == nil) != success || strings.Contains(string(output), "HTTP server listening") {
			t.Fatal("actual-main offline/failed-start result was not isolated as expected")
		}
		if success && !strings.Contains(string(output), "restaurant crypto maintenance completed") {
			t.Fatal("maintenance did not return through the offline main path")
		}
	}
	snapshot := func(t *testing.T, db *sql.DB) string {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var value string
		if err := db.QueryRowContext(ctx, `SELECT COALESCE(string_agg(c.oid::text || ':' || c.relname, ',' ORDER BY c.oid), '') FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'`).Scan(&value); err != nil {
			t.Fatal("cannot snapshot fixture schema")
		}
		return value
	}

	t.Run("explicit init and cold start", func(t *testing.T) {
		namespace, db := newFixture(t)
		before := snapshot(t, db)
		if before != "" {
			t.Fatal("explicit-init fixture was not empty")
		}
		runCommand(t, namespace, "", "", "synthetic-store", true, false)
		runCommand(t, namespace, "", keyFile, "wrong-store", true, false)
		runCommand(t, namespace, "", keyFile, "synthetic-store", true, false)
		if snapshot(t, db) != before {
			t.Fatal("failed external startup wrote schema before verified keys")
		}
		runCommand(t, namespace, "init", keyFile, "synthetic-store", true, true)
		initialized := snapshot(t, db)
		runCommand(t, namespace, "", wrongKeyFile, "synthetic-store", true, false)
		runCommand(t, namespace, "", "", "synthetic-store", false, false)
		if snapshot(t, db) != initialized {
			t.Fatal("wrong-key or legacy downgrade initialized application schemas")
		}
		listen := address(t)
		logPath := filepath.Join(t.TempDir(), "runtime.log")
		logFile, err := os.Create(logPath)
		if err != nil {
			t.Fatal(err)
		}
		life, stop := context.WithTimeout(context.Background(), 40*time.Second)
		cmd := exec.CommandContext(life, os.Args[0], "-test.run=^TestRestaurantCryptoActualMainRuntime$")
		cmd.Env = environment(namespace, listen, "", keyFile, "synthetic-store", true)
		cmd.Stdout, cmd.Stderr = logFile, logFile
		if err := cmd.Start(); err != nil {
			stop()
			_ = logFile.Close()
			t.Fatal("cannot start external runtime fixture")
		}
		done := make(chan struct{})
		go func() { _ = cmd.Wait(); close(done) }()
		t.Cleanup(func() {
			_ = cmd.Process.Signal(syscall.SIGTERM)
			select {
			case <-done:
			case <-time.After(10 * time.Second):
				stop()
				<-done
			}
			stop()
			_ = logFile.Close()
			output, _ := os.ReadFile(logPath)
			privateLogs(t, output)
		})
		client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}}
		t.Cleanup(client.CloseIdleConnections)
		healthy := false
		for deadline := time.Now().Add(25 * time.Second); time.Now().Before(deadline); {
			select {
			case <-done:
				t.Fatal("external runtime exited before readiness")
			default:
			}
			response, err := client.Get("http://" + listen + "/healthz")
			if err == nil {
				body, _ := io.ReadAll(io.LimitReader(response.Body, 128))
				_ = response.Body.Close()
				if response.StatusCode == 200 && string(body) == "ok\n" {
					healthy = true
					break
				}
			}
			time.Sleep(100 * time.Millisecond)
		}
		if !healthy {
			t.Fatal("initialized external runtime did not serve health endpoint")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		var orderKeys, paymentKeys, states int
		if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM restaurant_order_secret),(SELECT count(*) FROM restaurant_payment_secret),(SELECT count(*) FROM restaurant_key_state)`).Scan(&orderKeys, &paymentKeys, &states); err != nil || orderKeys != 0 || paymentKeys != 0 || states != 1 {
			t.Fatal("external cold start regenerated legacy data keys")
		}
	})

	t.Run("migrated legacy refuses before schema initialization", func(t *testing.T) {
		namespace, db := newFixture(t)
		ctx, stop := context.WithTimeout(context.Background(), 20*time.Second)
		defer stop()
		// Deliberately omit newRestaurantStore. The legacy encryption fixtures
		// are valid, but catalog/opening/brand tables are absent, so an early
		// application constructor would be visible in the schema snapshot.
		orders, err := newRestaurantOrders(ctx, &restaurantStore{db: db})
		if err != nil {
			t.Fatal("cannot prepare legacy order fixture")
		}
		payments, err := newRestaurantPayments(ctx, db, orders, "https://synthetic.invalid")
		if err != nil {
			t.Fatal("cannot prepare legacy payment fixture")
		}
		// Insert synthetic payloads through the actual legacy codecs. Payment
		// configuration is disabled and the attempt terminal, so even a broken
		// downgrade fence cannot cause a provider request in this fixture.
		const number, attemptID = "SYNTHETIC-1", "synthetic-attempt"
		secrets := restaurantOrderSecrets{TrackingToken: "synthetic-tracking-token", AccessCode: "SYNTHETIC1"}
		sealedOrder, err := orders.sealOrderSecrets(number, secrets)
		if err != nil {
			t.Fatal("cannot seal synthetic receipt")
		}
		tokenHash := sha256.Sum256([]byte(secrets.TrackingToken))
		codeHash := restaurantCodeHash(number, secrets.AccessCode)
		requestHash := sha256.Sum256([]byte("synthetic-request"))
		idempotencyHash := sha256.Sum256([]byte("synthetic-idempotency"))
		document, err := json.Marshal(restaurantOrder{Number: number, Version: 1, Status: "completed", Mode: "pickup", Currency: "SAR", Demo: true})
		if err != nil {
			t.Fatal("cannot encode synthetic order")
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO restaurant_orders(number,status,version,document,token_hash,code_hash,sealed_secrets,request_hash,idempotency_hash,created_at,updated_at) VALUES($1,'completed',1,$2,$3,$4,$5,$6,$7,now(),now())`, number, document, tokenHash[:], codeHash[:], sealedOrder, requestHash[:], idempotencyHash[:]); err != nil {
			t.Fatal("cannot insert synthetic order")
		}
		config := restaurantPaymentConfig{ID: "stripe", Mode: "test", Enabled: false, Values: map[string]string{}, Secrets: map[string]string{"secretKey": "sk_test_synthetic_downgrade_only"}}
		sealedConfig, err := payments.encrypt("config:stripe", config)
		if err != nil {
			t.Fatal("cannot seal synthetic payment configuration")
		}
		sealedAttempt, err := payments.encrypt("attempt:"+attemptID, config)
		if err != nil {
			t.Fatal("cannot seal synthetic payment attempt")
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO restaurant_payment_configs(provider,sealed) VALUES('stripe',$1)`, sealedConfig); err != nil {
			t.Fatal("cannot insert synthetic payment configuration")
		}
		if _, err := db.ExecContext(ctx, `INSERT INTO restaurant_payment_attempts(id,order_number,provider,mode,status,sealed_config) VALUES($1,$2,'stripe','test','failed',$3)`, attemptID, number, sealedAttempt); err != nil {
			t.Fatal("cannot insert synthetic terminal payment attempt")
		}
		unchangedPayloadsAndNoKeys := func(t *testing.T) {
			t.Helper()
			ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
			defer stop()
			var orderKeys, paymentKeys int
			if err := db.QueryRowContext(ctx, `SELECT (SELECT count(*) FROM restaurant_order_secret),(SELECT count(*) FROM restaurant_payment_secret)`).Scan(&orderKeys, &paymentKeys); err != nil || orderKeys != 0 || paymentKeys != 0 {
				t.Fatal("migration/downgrade created plaintext data key rows")
			}
			var gotOrder, gotConfig, gotAttempt []byte
			if err := db.QueryRowContext(ctx, `SELECT (SELECT sealed_secrets FROM restaurant_orders WHERE number=$1),(SELECT sealed FROM restaurant_payment_configs WHERE provider='stripe'),(SELECT sealed_config FROM restaurant_payment_attempts WHERE id=$2)`, number, attemptID).Scan(&gotOrder, &gotConfig, &gotAttempt); err != nil || !bytes.Equal(gotOrder, sealedOrder) || !bytes.Equal(gotConfig, sealedConfig) || !bytes.Equal(gotAttempt, sealedAttempt) {
				t.Fatal("migration/downgrade changed encrypted payload bytes")
			}
		}
		runCommand(t, namespace, "migrate", keyFile, "synthetic-store", true, true)
		before := snapshot(t, db)
		runCommand(t, namespace, "", "", "synthetic-store", false, false)
		if snapshot(t, db) != before {
			t.Fatal("legacy startup wrote application schemas after migration")
		}
		runCommand(t, namespace, "verify", keyFile, "synthetic-store", true, true)
		unchangedPayloadsAndNoKeys(t)
		t.Run("historical binary downgrade refuses", func(t *testing.T) {
			binary := os.Getenv("ONLINU_LEGACY_CRYPTO_BINARY")
			if binary == "" {
				t.Skip("set ONLINU_LEGACY_CRYPTO_BINARY to the pinned 3147a44 test fixture binary")
			}
			info, err := os.Stat(binary)
			if err != nil || !filepath.IsAbs(binary) || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
				t.Fatal("historical binary fixture is not an absolute executable file")
			}
			listen := address(t)
			life, stop := context.WithTimeout(context.Background(), 20*time.Second)
			defer stop()
			cmd := exec.CommandContext(life, binary, "-addr", listen, "-pg-namespace", namespace, "-static=")
			cmd.Env = environment(namespace, listen, "", "", "", false)
			// Privately match only the named CHECK failure without retaining logs.
			fenceLog := &restaurantHistoricalFenceLog{}
			cmd.Stdout, cmd.Stderr = fenceLog, fenceLog
			if err := cmd.Start(); err != nil {
				t.Fatal("cannot start pinned historical runtime fixture")
			}
			done := make(chan error, 1)
			go func() { done <- cmd.Wait() }()
			client := &http.Client{Timeout: 100 * time.Millisecond, Transport: &http.Transport{Proxy: nil}}
			defer client.CloseIdleConnections()
			served := false
			checkHTTP := func() {
				response, err := client.Get("http://" + listen + "/healthz")
				if err == nil {
					served = true
					_ = response.Body.Close()
				}
			}
			ticker := time.NewTicker(20 * time.Millisecond)
			defer ticker.Stop()
			var waitErr error
		wait:
			for {
				select {
				case waitErr = <-done:
					break wait
				case <-ticker.C:
					checkHTTP()
				}
			}
			checkHTTP()
			var exited *exec.ExitError
			if life.Err() != nil || !errors.As(waitErr, &exited) || exited.ExitCode() <= 0 || served || !fenceLog.constraint || !fenceLog.checkViolation {
				t.Fatal("historical binary did not refuse migrated storage before serving HTTP")
			}
			// An older binary may create unrelated schema objects before its
			// unconditional legacy key INSERT reaches the durable CHECK fence.
			// Its inability to restore plaintext keys or alter ciphertext is
			// the downgrade guarantee; no schema-no-op claim is made here.
			unchangedPayloadsAndNoKeys(t)
			runCommand(t, namespace, "verify", keyFile, "synthetic-store", true, true)
		})
	})
}
