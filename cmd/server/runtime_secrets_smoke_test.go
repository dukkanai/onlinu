package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"flag"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/google/uuid"
)

// Opt-in actual-main smoke, confined to a unique database created by this test
// on the dedicated loopback test cluster. No existing database is dropped.
func TestRuntimeSecretFilesActualMainServer(t *testing.T) {
	if os.Getenv("ONLINU_RUNTIME_MAIN_HELPER") == "1" {
		flag.CommandLine = flag.NewFlagSet("wacalls", flag.ExitOnError)
		os.Args = []string{"wacalls", "-addr", os.Getenv("ONLINU_RUNTIME_HTTP_ADDR"), "-pg-namespace", os.Getenv("ONLINU_RUNTIME_NAMESPACE"), "-static=", "-max-calls-per-session=1"}
		main()
		return
	}
	if os.Getenv("TEST_RUNTIME_MAIN") != "1" {
		t.Skip("set TEST_RUNTIME_MAIN=1 for isolated actual-main startup")
	}
	raw := os.Getenv("TEST_RESTAURANT_PG_URL")
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Path != "/astracalls_restaurant_test" || parsed.RawQuery != "sslmode=disable" || parsed.Fragment != "" || parsed.User == nil || parsed.User.Username() == "" || !(parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1") {
		t.Fatal("actual-main smoke requires the dedicated loopback restaurant test database")
	}
	admin, err := sql.Open("pgx", raw)
	if err != nil {
		t.Fatal("cannot open fixture maintenance connection")
	}
	t.Cleanup(func() { _ = admin.Close() })
	var unique [16]byte
	if _, err = rand.Read(unique[:]); err != nil {
		t.Fatal(err)
	}
	namespace := "onlinu_rt_test_" + hex.EncodeToString(unique[:])
	database := namespace + "_main"
	var exists bool
	checkContext, checkCancel := context.WithTimeout(context.Background(), 10*time.Second)
	err = admin.QueryRowContext(checkContext, "SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname=$1)", database).Scan(&exists)
	checkCancel()
	if err != nil || exists {
		t.Fatal("fixture namespace must not already exist")
	}
	root := t.TempDir()
	masterFile := filepath.Join(root, "master")
	pgFile := filepath.Join(root, "pg-url")
	master := "synthetic-actual-main-master"
	for path, value := range map[string]string{masterFile: master, pgFile: raw} {
		if err = os.WriteFile(path, []byte(value+"\n"), 0600); err != nil {
			t.Fatal("cannot prepare synthetic runtime file")
		}
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	_ = listener.Close()
	logPath := filepath.Join(root, "runtime.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = logFile.Close() })
	life, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	command := exec.CommandContext(life, os.Args[0], "-test.run=^TestRuntimeSecretFilesActualMainServer$")
	command.Env = append(cleanRuntimeSecretEnvironment(), "ONLINU_RUNTIME_MAIN_HELPER=1", "ONLINU_RUNTIME_HTTP_ADDR="+address, "ONLINU_RUNTIME_NAMESPACE="+namespace,
		"WACALLS_API_KEY_FILE="+masterFile, "WACALLS_PG_URL_FILE="+pgFile, "WACALLS_RECORDING_DIR="+filepath.Join(root, "recordings"), "RESTAURANT_GEOGRAPHY_DATA_DIR=",
		"WACALLS_PLATFORM_ISSUER=https://platform.example", "WACALLS_PLATFORM_TENANT_ID=restaurant-a", "WACALLS_PLATFORM_PUBLIC_KEY="+base64.StdEncoding.EncodeToString(public), "WACALLS_PUBLIC_BASE_URL=https://restaurant.example.invalid")
	command.Stdout = logFile
	command.Stderr = logFile
	if err = command.Start(); err != nil {
		cancel()
		t.Fatal("cannot start isolated runtime")
	}
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = command.Wait(); close(done) }()
	t.Cleanup(func() {
		_ = command.Process.Signal(syscall.SIGTERM)
		select {
		case <-done:
		case <-time.After(10 * time.Second):
			cancel()
			<-done
		}
		cancel()
		logs, _ := os.ReadFile(logPath)
		if strings.Contains(string(logs), master) || strings.Contains(string(logs), raw) || strings.Contains(string(logs), masterFile) || strings.Contains(string(logs), pgFile) {
			t.Error("runtime log disclosed synthetic credential configuration")
		}
		// The name is generated above only after proving it did not exist. Never use
		// FORCE, enumerate/drop other databases, or accept a caller-provided name.
		if database != "onlinu_rt_test_"+hex.EncodeToString(unique[:])+"_main" {
			t.Error("unsafe fixture cleanup refused")
			return
		}
		ctx, stop := context.WithTimeout(context.Background(), 10*time.Second)
		defer stop()
		for {
			_, dropErr := admin.ExecContext(ctx, "DROP DATABASE IF EXISTS "+quoteIdent(database))
			if dropErr == nil {
				break
			}
			if ctx.Err() != nil {
				t.Error("could not clean the owned runtime fixture database")
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	})
	client := &http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	t.Cleanup(client.CloseIdleConnections)
	origin := "http://" + address
	deadline := time.Now().Add(25 * time.Second)
	healthy := false
	for time.Now().Before(deadline) {
		select {
		case <-done:
			t.Fatalf("isolated runtime exited before readiness: %v", waitErr)
		default:
		}
		response, e := client.Get(origin + "/healthz")
		if e == nil {
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
		t.Fatal("isolated actual-main runtime did not become healthy")
	}
	check := func(path, key string, want int) {
		t.Helper()
		req, _ := http.NewRequest("GET", origin+path, nil)
		if key != "" {
			req.Header.Set("X-API-Key", key)
		}
		res, e := client.Do(req)
		if e != nil {
			t.Fatal("local runtime request failed")
		}
		_ = res.Body.Close()
		if res.StatusCode != want {
			t.Fatalf("local runtime route status %d; want %d", res.StatusCode, want)
		}
	}
	check("/api/restaurant/catalog", "", 401)
	check("/api/restaurant/catalog", "wrong", 401)
	check("/api/restaurant/catalog", master, 200)
	check("/platform-api/staff/profile", master, 401)
	request := platformTestRequest(t, private, uuid.NewString(), "GET", "/platform-api/staff/profile", "", "staff:settings:read", nil, nil)
	request.URL.Scheme = "http"
	request.URL.Host = address
	request.Host = address
	request.RequestURI = ""
	response, err := client.Do(request)
	if err != nil {
		t.Fatal("signed actual-main request failed")
	}
	_ = response.Body.Close()
	if response.StatusCode != 200 {
		t.Fatal("signed service request rejected by actual-main runtime", response.StatusCode)
	}
	t.Log("Actual main loaded private files, created only its isolated fixture database, served authenticated administrator and signed service reads, and preserved credential-free logs.")
}
