package main

import (
	"context"
	"database/sql"
	"errors"
	"log/slog"
	"os"
)

type server struct {
	ownership    *instanceOwnership
	db           *sql.DB
	restaurant   *restaurantStore
	orders       *restaurantOrders
	customers    *restaurantAccounts
	payments     *restaurantPayments
	couriers     *restaurantCouriers
	log          *slog.Logger
	staticDir    string
	platformAuth *platformRequestAuth
}

var errPlatformAdminAuthenticationRequired = errors.New("platform restaurant runtime requires administrator authentication")

// newServer opens the restaurant database and initializes commerce services.
func newServer(ctx context.Context, pgURL, pgNamespace, staticDir string, log *slog.Logger) (*server, error) {
	platformAuth, err := platformAuthFromEnv()
	if err != nil {
		return nil, err
	}
	// Signed commerce routes do not replace authentication on the original
	// administrator API. A configured SaaS restaurant must not start it open.
	if platformAuth != nil && runtimeSecret("WACALLS_API_KEY") == "" {
		return nil, errPlatformAdminAuthenticationRequired
	}

	provider, err := newDBProvider(ctx, pgURL, pgNamespace, log)
	if err != nil {
		return nil, err
	}

	defer provider.close()
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
	go payments.Run(ctx)

	initialized = true
	return &server{ownership: ownership, db: mainDB, restaurant: restaurant, orders: orders, customers: customers, payments: payments, couriers: couriers, log: log, staticDir: staticDir, platformAuth: platformAuth}, nil
}
