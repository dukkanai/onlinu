package main

import (
	"context"
	"crypto/cipher"
	"database/sql"
	"errors"
	"log/slog"
	"os"
)

type server struct {
	ownership      *instanceOwnership
	db             *sql.DB
	restaurant     *restaurantStore
	orders         *restaurantOrders
	customers      *restaurantAccounts
	payments       *restaurantPayments
	couriers       *restaurantCouriers
	log            *slog.Logger
	staticDir      string
	platformAuth   *platformRequestAuth
	trustedProxies restaurantProxyPolicy
}

var errPlatformAdminAuthenticationRequired = errors.New("platform restaurant runtime requires administrator authentication")

// newServer opens the restaurant database and initializes commerce services.
func newServer(ctx context.Context, pgURL, pgNamespace, staticDir string, log *slog.Logger) (*server, error) {
	trustedProxies, err := restaurantTrustedProxiesFromEnv(os.LookupEnv)
	if err != nil {
		return nil, err
	}
	ring, err := restaurantCryptoRingFromEnv(os.Getenv)
	if err != nil {
		return nil, err
	}
	platformAuth, err := platformAuthFromEnv()
	if err != nil {
		return nil, err
	}
	// Signed commerce routes do not replace authentication on the original
	// administrator API. A configured SaaS restaurant must not start it open.
	if platformAuth != nil && runtimeSecret("WACALLS_API_KEY") == "" {
		return nil, errPlatformAdminAuthenticationRequired
	}

	if pgNamespace == "" {
		pgNamespace = "wacalls"
	}
	database := pgNamespace + "_main"
	var mainDB *sql.DB
	if ring != nil {
		// External mode never creates a database or repairs missing key state.
		mainDB, err = openExistingRestaurantDatabase(ctx, pgURL, pgNamespace)
	} else {
		var provider *dbProvider
		provider, err = newDBProvider(ctx, pgURL, pgNamespace, log)
		if err == nil {
			defer provider.close()
			mainDB, err = provider.openMainDB(ctx)
		}
	}
	if err != nil {
		return nil, err
	}
	ownership, err := acquireInstanceOwnership(ctx, mainDB, database)
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
	var orderCiphers, paymentCiphers []cipher.AEAD
	if ring != nil {
		ciphers, err := restaurantLoadExternalKeys(ctx, ownership, database, "public", ring)
		if err != nil {
			return nil, err
		}
		if ciphers == nil || ciphers.orders == nil || ciphers.payments == nil {
			return nil, errRestaurantDataCipher
		}
		orderCiphers = []cipher.AEAD{ciphers.orders}
		paymentCiphers = []cipher.AEAD{ciphers.payments}
	} else if err := restaurantRefuseExternalDatabase(ctx, ownership, database, "public"); err != nil {
		// Refuse a downgrade before even unrelated schema initializers run.
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
	orders, err := newRestaurantOrders(ctx, restaurant, orderCiphers...)
	if err != nil {
		return nil, err
	}
	payments, err := newRestaurantPayments(ctx, mainDB, orders, os.Getenv("WACALLS_PUBLIC_BASE_URL"), paymentCiphers...)
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
	return &server{ownership: ownership, db: mainDB, restaurant: restaurant, orders: orders, customers: customers, payments: payments, couriers: couriers, log: log, staticDir: staticDir, platformAuth: platformAuth, trustedProxies: trustedProxies}, nil
}
