package main

import (
	"context"
	"errors"
	"flag"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

// envStr lê uma string de uma variável de ambiente (com valor padrão).
func envStr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func main() {
	fileSecrets, secretErr := readRuntimeSecretFiles(os.Getenv)
	if secretErr != nil {
		slog.Error("invalid runtime secret configuration", "err", secretErr)
		os.Exit(1)
	}
	// Keep file-backed values in memory, not in the environment inherited by children.
	loadedRuntimeFileSecrets.Store(&runtimeFileSecrets{values: fileSecrets})
	addr := flag.String("addr", ":8080", "HTTP listen address")
	// Preserve the existing <namespace>_main restaurant database convention.
	pgURL := flag.String("pg-url", "", "Postgres maintenance URL (defaults to configured runtime secret)")
	pgNS := flag.String("pg-namespace", envStr("WACALLS_PG_NAMESPACE", "wacalls"), "namespace for the restaurant database")
	staticDir := flag.String("static", "client/dist", "static client directory (optional)")
	cryptoCommand := flag.String("crypto-command", "", "offline restaurant key maintenance: init, migrate, rotate, or verify")
	debug := flag.Bool("debug", false, "verbose logging")
	flag.Parse()
	pgURLExplicit := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "pg-url" {
			pgURLExplicit = true
		}
	})
	if !pgURLExplicit {
		*pgURL = runtimeSecret("WACALLS_PG_URL")
	}

	level := slog.LevelInfo
	if *debug {
		level = slog.LevelDebug
	}
	log := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: level}))
	slog.SetDefault(log)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if *cryptoCommand != "" {
		if err := restaurantRunKeyMaintenance(ctx, *pgURL, *pgNS, *cryptoCommand); err != nil {
			log.Error("restaurant crypto maintenance failed", "err", err)
			os.Exit(1)
		}
		log.Info("restaurant crypto maintenance completed")
		return
	}

	srv, err := newServer(ctx, *pgURL, *pgNS, *staticDir, log)
	if err != nil {
		log.Error("startup failed", "err", err)
		os.Exit(1)
	}
	defer srv.ownership.Close()
	defer srv.db.Close()
	go srv.ownership.Monitor(ctx, func() {
		log.Error("database ownership lost; stopping this restaurant instance")
		stop()
	})

	go srv.runRestaurantStockExpiry(ctx)
	go srv.couriers.RunLocationCleanup(ctx)

	httpSrv := &http.Server{Addr: *addr, Handler: srv.routes(), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 120 * time.Second}
	go func() {
		log.Info("HTTP server listening", "addr", *addr)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("http server error", "err", err)
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
}
