package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	token, err := secretValue("TENANT_SERVICE_TOKEN")
	if err != nil {
		slog.Error("invalid tenant credential configuration")
		os.Exit(1)
	}
	databaseURL, err := secretValue("DATABASE_URL")
	if err != nil {
		slog.Error("invalid tenant database configuration")
		os.Exit(1)
	}
	service, err := openService(ctx, config{
		TenantID: os.Getenv("TENANT_ID"), Token: token,
		DatabaseURL: databaseURL, Synthetic: os.Getenv("SYNTHETIC_MODE") == "true",
	})
	if err != nil {
		slog.Error("synthetic tenant startup failed; check isolated database and configuration")
		os.Exit(1)
	}
	defer service.db.Close()
	address := os.Getenv("LISTEN_ADDR")
	if address == "" {
		address = ":8080"
	}
	server := &http.Server{Addr: address, Handler: service, ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout: 10 * time.Second, WriteTimeout: 15 * time.Second, IdleTimeout: 30 * time.Second,
		MaxHeaderBytes: 16 << 10}
	go func() {
		slog.Info("synthetic tenant listening", "tenant", service.tenantID)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Error("tenant listener failed")
			cancel()
		}
	}()
	<-ctx.Done()
	shutdown, done := context.WithTimeout(context.Background(), 10*time.Second)
	defer done()
	_ = server.Shutdown(shutdown)
}

// Mounted files keep staging credentials out of Compose environment values.
func secretValue(name string) (string, error) {
	value, path := os.Getenv(name), os.Getenv(name+"_FILE")
	if path == "" {
		return value, nil
	}
	if value != "" {
		return "", errors.New("ambiguous credential configuration")
	}
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 16384 {
		return "", errors.New("invalid credential file")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", errors.New("unreadable credential file")
	}
	return strings.TrimSpace(string(data)), nil
}

func openService(ctx context.Context, c config) (*service, error) {
	if !c.Synthetic || (c.TenantID != "demo-a" && c.TenantID != "demo-b") || len(c.Token) < 32 || c.DatabaseURL == "" {
		return nil, errors.New("invalid synthetic configuration")
	}
	db, err := sql.Open("pgx", c.DatabaseURL)
	if err != nil {
		return nil, errors.New("database unavailable")
	}
	db.SetMaxOpenConns(8)
	db.SetMaxIdleConns(2)
	db.SetConnMaxLifetime(10 * time.Minute)
	startup, done := context.WithTimeout(ctx, 20*time.Second)
	defer done()
	if err = db.PingContext(startup); err != nil {
		_ = db.Close()
		return nil, errors.New("database unavailable")
	}
	s := &service{db: db, tenantID: c.TenantID, token: c.Token, synthetic: c.Synthetic}
	if err := s.initialize(startup); err != nil {
		_ = db.Close()
		return nil, errors.New("database initialization failed")
	}
	return s, nil
}
