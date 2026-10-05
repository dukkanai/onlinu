package main

import (
	"context"
	"log/slog"
	"os"
	"sync"

	waLog "go.mau.fi/whatsmeow/util/log"
)

type server struct {
	ownership  *instanceOwnership
	broker     *Broker
	sessions   *SessionManager
	meta       *metaManager
	metaCalls  *metaCallService
	restaurant *restaurantStore
	orders     *restaurantOrders
	customers  *restaurantAccounts
	payments   *restaurantPayments
	couriers   *restaurantCouriers
	// Serialize official account replacement/removal against call setup and
	// signed webhook processing. QR and established audio are unaffected.
	metaConfigMu sync.RWMutex
	log          *slog.Logger
	staticDir    string
	platformAuth *platformRequestAuth
}

// newServer monta o provedor de banco (Postgres, 1 banco por sessão no estilo
// WAHA), abre o banco principal e inicializa o gerenciador de sessões.
func newServer(ctx context.Context, pgURL, pgNamespace, staticDir string, maxCalls int, log *slog.Logger) (*server, error) {
	platformAuth, err := platformAuthFromEnv()
	if err != nil {
		return nil, err
	}
	waLogger := waLog.Noop
	if log.Enabled(ctx, slog.LevelDebug) {
		waLogger = waLog.Stdout("WA", "DEBUG", true)
	}

	provider, err := newDBProvider(ctx, pgURL, pgNamespace, waLogger, log)
	if err != nil {
		return nil, err
	}

	mainDB, err := provider.openMainDB(ctx)
	if err != nil {
		return nil, err
	}
	ownership, err := acquireInstanceOwnership(ctx, mainDB, provider.mainDBName())
	if err != nil {
		_ = mainDB.Close()
		return nil, err
	}
	initialized := false
	defer func() {
		if !initialized {
			ownership.Close()
			_ = mainDB.Close()
		}
	}()
	store, err := newSessionStore(ctx, mainDB)
	if err != nil {
		return nil, err
	}

	broker := NewBroker()
	mgr := newSessionManager(ctx, provider, broker, store, waLogger, log, maxCalls)
	meta, err := newMetaManager(ctx, mainDB)
	if err != nil {
		return nil, err
	}
	metaCalls, err := newMetaCallService(ctx, meta, broker, maxCalls, log)
	if err != nil {
		return nil, err
	}
	restaurant, err := newRestaurantStore(ctx, mainDB)
	if err != nil {
		return nil, err
	}
	customers, err := newRestaurantAccounts(ctx, mainDB)
	if err != nil {
		return nil, err
	}
	orders, err := newRestaurantOrders(ctx, restaurant)
	if err != nil {
		return nil, err
	}
	payments, err := newRestaurantPayments(ctx, mainDB, orders, os.Getenv("WACALLS_PUBLIC_BASE_URL"))
	if err != nil {
		return nil, err
	}
	orders.PaymentAvailable = payments.Available
	couriers, err := newRestaurantCouriers(ctx, mainDB, orders)
	if err != nil {
		return nil, err
	}
	mgr.meta = meta
	broker.SnapshotFn = mgr.snapshotEvents
	broker.AccountForSession = mgr.accountIDForSession
	go payments.Run(ctx)

	initialized = true
	return &server{ownership: ownership, broker: broker, sessions: mgr, meta: meta, metaCalls: metaCalls, restaurant: restaurant, orders: orders, customers: customers, payments: payments, couriers: couriers, log: log, staticDir: staticDir, platformAuth: platformAuth}, nil
}
