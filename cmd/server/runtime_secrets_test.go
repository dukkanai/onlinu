package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"flag"
	"io"
	"log/slog"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestRuntimeSecretFilesAreBoundedPrivateAndDoNotChangeEnvironment(t *testing.T) {
	root := t.TempDir()
	key := filepath.Join(root, "api")
	pg := filepath.Join(root, "db")
	if err := os.WriteFile(key, []byte("synthetic-api-only\r\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pg, []byte("postgres://synthetic:fixture@localhost/postgres\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"WACALLS_API_KEY_FILE": key, "WACALLS_PG_URL_FILE": pg, "OPENAI_API_KEY": "synthetic-env-only"}
	get := func(name string) string { return env[name] }
	before := os.Getenv("WACALLS_API_KEY")
	values, err := readRuntimeSecretFiles(get)
	if err != nil || values["WACALLS_API_KEY"] != "synthetic-api-only" {
		t.Fatal("file read", err)
	}
	if os.Getenv("WACALLS_API_KEY") != before {
		t.Fatal("exported file secret to process environment")
	}
	if runtimeSecretFrom(values, get, "OPENAI_API_KEY") != "synthetic-env-only" {
		t.Fatal("legacy environment no longer supported")
	}
	if runtimeSecretFrom(values, get, "WACALLS_API_KEY") != "synthetic-api-only" {
		t.Fatal("file secret unavailable")
	}
	env["WACALLS_API_KEY"] = "conflicting-secret"
	if got, err := readRuntimeSecretFiles(get); err == nil || got != nil || strings.Contains(err.Error(), key) || strings.Contains(err.Error(), "conflicting-secret") {
		t.Fatal("ambiguous source not rejected privately", err)
	}
}
func TestRuntimeSecretFilesRejectUnsafeFilesWithoutDisclosingPaths(t *testing.T) {
	for name, content := range map[string][]byte{"empty": {}, "blank": []byte(" \r\n"), "multiline": []byte("synthetic\nsecond"), "nul": []byte("synthetic\x00"), "invalid-utf8": {0xff}, "oversized": []byte(strings.Repeat("a", runtimeSecretFileLimit+1))} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "private-path-marker")
			if err := os.WriteFile(path, content, 0600); err != nil {
				t.Fatal(err)
			}
			values, err := readRuntimeSecretFiles(func(key string) string {
				if key == "WACALLS_API_KEY_FILE" {
					return path
				}
				return ""
			})
			if err == nil || values != nil || strings.Contains(err.Error(), "private-path-marker") || strings.Contains(err.Error(), "synthetic") {
				t.Fatal("unsafe file or secret in error", err)
			}
		})
	}
	for _, kind := range []string{"missing", "directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			path := filepath.Join(root, "private-path-marker")
			switch kind {
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				target := filepath.Join(root, "target")
				if err := os.WriteFile(target, []byte("synthetic"), 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Skip("symlink creation unavailable")
				}
			}
			_, err := readRuntimeSecretFiles(func(key string) string {
				if key == "WACALLS_API_KEY_FILE" {
					return path
				}
				return ""
			})
			if err == nil || strings.Contains(err.Error(), path) {
				t.Fatal("unsafe path accepted or disclosed", err)
			}
		})
	}
}
func TestRuntimeSecretFilesPreserveSpacesAndValidateAllBeforeUse(t *testing.T) {
	path := filepath.Join(t.TempDir(), "value")
	if err := os.WriteFile(path, []byte(" synthetic spaces \n"), 0600); err != nil {
		t.Fatal(err)
	}
	env := map[string]string{"WACALLS_API_KEY_FILE": path}
	get := func(key string) string { return env[key] }
	values, err := readRuntimeSecretFiles(get)
	if err != nil || values["WACALLS_API_KEY"] != " synthetic spaces " {
		t.Fatal("silently changed credential", err)
	}
	env["WACALLS_PG_URL_FILE"] = path + "-missing"
	values, err = readRuntimeSecretFiles(get)
	if err == nil || values != nil {
		t.Fatal("partial secret configuration escaped failure")
	}
}
func TestDBProviderMalformedURLDoesNotExposeCredential(t *testing.T) {
	_, err := newDBProvider(context.Background(), "postgres://user:SYNTHETIC_PRIVATE%zz@localhost/postgres", "test", nil, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err == nil || strings.Contains(err.Error(), "SYNTHETIC_PRIVATE") || strings.Contains(err.Error(), "postgres://") {
		t.Fatal("database parse error leaked DSN", err)
	}
}

func cleanRuntimeSecretEnvironment() []string {
	var env []string
	for _, entry := range os.Environ() {
		keep := !strings.HasPrefix(entry, "WACALLS_")
		for _, name := range runtimeSecretNames {
			if strings.HasPrefix(entry, name+"=") || strings.HasPrefix(entry, name+"_FILE=") {
				keep = false
			}
		}
		if keep && !strings.HasPrefix(entry, "ONLINU_SECRET_TEST_HELPER=") {
			env = append(env, entry)
		}
	}
	return env
}
func TestRuntimeSecretFilesActualMainHelpDoesNotRevealDSN(t *testing.T) {
	if os.Getenv("ONLINU_SECRET_TEST_HELPER") == "help" {
		flag.CommandLine = flag.NewFlagSet("wacalls", flag.ExitOnError)
		os.Args = []string{"wacalls", "-h"}
		if os.Getenv("ONLINU_SECRET_EXPLICIT_EMPTY") == "1" {
			os.Args = []string{"wacalls", "-pg-url="}
		}
		main()
		return
	}
	path := filepath.Join(t.TempDir(), "private-secret-path-marker")
	value := "postgres://user:SYNTHETIC_DSN_PRIVATE@localhost/postgres"
	if err := os.WriteFile(path, []byte(value+"\n"), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"file", "legacy-env", "ambiguous", "explicit-empty"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRuntimeSecretFilesActualMainHelpDoesNotRevealDSN$")
			cmd.Env = append(cleanRuntimeSecretEnvironment(), "ONLINU_SECRET_TEST_HELPER=help")
			if mode != "legacy-env" {
				cmd.Env = append(cmd.Env, "WACALLS_PG_URL_FILE="+path)
			}
			if mode == "legacy-env" || mode == "ambiguous" {
				cmd.Env = append(cmd.Env, "WACALLS_PG_URL="+value)
			}
			if mode == "explicit-empty" {
				cmd.Env = append(cmd.Env, "ONLINU_SECRET_EXPLICIT_EMPTY=1")
			}
			output, err := cmd.CombinedOutput()
			failureExpected := mode == "ambiguous" || mode == "explicit-empty"
			if failureExpected && err == nil || !failureExpected && err != nil {
				t.Fatal("unexpected startup/help result", err)
			}
			if strings.Contains(string(output), "SYNTHETIC_DSN_PRIVATE") || strings.Contains(string(output), "private-secret-path-marker") {
				t.Fatal("startup/help revealed private configuration")
			}
			if mode == "explicit-empty" && !strings.Contains(string(output), "WACALLS_PG_URL") {
				t.Fatal("explicit empty flag did not override the configured DSN")
			}
			if !failureExpected && !strings.Contains(string(output), "-pg-url") {
				t.Fatal("did not execute actual main help")
			}
		})
	}
}
func TestRuntimeSecretFilesFeedAuthConsumersWithoutExport(t *testing.T) {
	if os.Getenv("ONLINU_SECRET_TEST_HELPER") == "consumers" {
		values, err := readRuntimeSecretFiles(os.Getenv)
		if err != nil {
			t.Fatal(err)
		}
		loadedRuntimeFileSecrets.Store(&runtimeFileSecrets{values: values})
		if os.Getenv("WACALLS_API_KEY") != "" || os.Getenv("OPENAI_API_KEY") != "" {
			t.Fatal("exported file values")
		}
		if !translationEnabled() {
			t.Fatal("translation guard ignored file configuration")
		}
		req := httptest.NewRequest("GET", "/api/archive", nil)
		req.Header.Set("X-API-Key", "synthetic-file-master")
		if !archiveMasterAuthorized(req) {
			t.Fatal("archive ignored file master key")
		}
		req.Header.Set("X-API-Key", "wrong")
		if archiveMasterAuthorized(req) {
			t.Fatal("wrong master accepted")
		}
		digest := sha256.Sum256([]byte("restaurant-cookie-namespace\x00synthetic-file-master"))
		if restaurantSessionCookieName() != restaurantCookieName+"_"+hex.EncodeToString(digest[:8]) {
			t.Fatal("cookie isolation ignored file master")
		}
		t.Setenv("WACALLS_PLATFORM_ISSUER", "https://platform.example")
		t.Setenv("WACALLS_PLATFORM_TENANT_ID", "synthetic-file-tenant")
		t.Setenv("WACALLS_PLATFORM_PUBLIC_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
		_, startupErr := newServer(context.Background(), "", "synthetic", "", 1, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if startupErr == nil || errors.Is(startupErr, errPlatformAdminAuthenticationRequired) || !strings.Contains(startupErr.Error(), "WACALLS_PG_URL") {
			t.Fatal("SaaS startup ignored the file-backed master key")
		}
		return
	}
	root := t.TempDir()
	master := filepath.Join(root, "master")
	ai := filepath.Join(root, "ai")
	for path, value := range map[string]string{master: "synthetic-file-master", ai: "synthetic-no-provider-access"} {
		if err := os.WriteFile(path, []byte(value), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestRuntimeSecretFilesFeedAuthConsumersWithoutExport$")
	cmd.Env = append(cleanRuntimeSecretEnvironment(), "ONLINU_SECRET_TEST_HELPER=consumers", "WACALLS_API_KEY_FILE="+master, "OPENAI_API_KEY_FILE="+ai)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("isolated runtime consumer checks failed: %v\n%s", err, output)
	}
}

func TestPlatformRuntimeRequiresOriginalAdministratorAuthentication(t *testing.T) {
	t.Setenv("WACALLS_PLATFORM_ISSUER", "https://platform.example")
	t.Setenv("WACALLS_PLATFORM_TENANT_ID", "synthetic-tenant")
	t.Setenv("WACALLS_PLATFORM_PUBLIC_KEY", base64.StdEncoding.EncodeToString(make([]byte, 32)))
	t.Setenv("WACALLS_API_KEY", "")
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	_, err := newServer(context.Background(), "", "synthetic", "", 1, log)
	if !errors.Is(err, errPlatformAdminAuthenticationRequired) {
		t.Fatal("SaaS startup did not fail before database initialization")
	}
	t.Setenv("WACALLS_API_KEY", "synthetic-master-only")
	_, err = newServer(context.Background(), "", "synthetic", "", 1, log)
	if err == nil || errors.Is(err, errPlatformAdminAuthenticationRequired) || !strings.Contains(err.Error(), "WACALLS_PG_URL") {
		t.Fatal("configured authentication did not pass the startup guard")
	}
	for _, name := range []string{"WACALLS_PLATFORM_ISSUER", "WACALLS_PLATFORM_TENANT_ID", "WACALLS_PLATFORM_PUBLIC_KEY", "WACALLS_API_KEY"} {
		t.Setenv(name, "")
	}
	_, err = newServer(context.Background(), "", "synthetic", "", 1, log)
	if err == nil || errors.Is(err, errPlatformAdminAuthenticationRequired) || !strings.Contains(err.Error(), "WACALLS_PG_URL") {
		t.Fatal("changed legacy non-platform startup contract")
	}
}
