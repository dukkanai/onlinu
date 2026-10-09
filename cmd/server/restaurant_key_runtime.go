package main

import (
	"context"
	"crypto/cipher"
	"errors"
	"os"
	"reflect"
)

const (
	restaurantCryptoModeSetting  = "WACALLS_CRYPTO_MODE"
	restaurantCryptoStoreSetting = "WACALLS_CRYPTO_STORE_ID"
	restaurantCryptoExternalMode = "external-v1"
)

var (
	errRestaurantCryptoConfiguration = errors.New("invalid restaurant crypto configuration")
	errRestaurantCryptoMaintenance   = errors.New("restaurant crypto maintenance failed")
	errRestaurantCryptoDatabase      = errors.New("restaurant crypto database unavailable")
	errRestaurantDataCipher          = errors.New("invalid restaurant data cipher")
)

// The absence of all external crypto settings is the only legacy mode. In
// particular, a misspelled mode or an orphaned keyring cannot fall back to
// database-resident keys. Read and validate secrets before any database opener.
func restaurantCryptoRingFromEnv(getenv func(string) string) (*restaurantKeyring, error) {
	if getenv == nil {
		return nil, errRestaurantCryptoConfiguration
	}
	mode := getenv(restaurantCryptoModeSetting)
	storeID := getenv(restaurantCryptoStoreSetting)
	// File-backed store IDs and modes are not supported. Reject them rather
	// than silently choosing another identity or encryption mode.
	if getenv(restaurantCryptoModeSetting+"_FILE") != "" || getenv(restaurantCryptoStoreSetting+"_FILE") != "" {
		return nil, errRestaurantCryptoConfiguration
	}
	if mode == "" {
		if storeID != "" || getenv(restaurantKeyringSetting) != "" || getenv(restaurantKeyringSetting+"_FILE") != "" {
			return nil, errRestaurantCryptoConfiguration
		}
		return nil, nil
	}
	if mode != restaurantCryptoExternalMode || !restaurantKeyIdentifier(storeID, 80) {
		return nil, errRestaurantCryptoConfiguration
	}
	if tenant := getenv("WACALLS_PLATFORM_TENANT_ID"); tenant != "" && tenant != storeID {
		return nil, errRestaurantCryptoConfiguration
	}
	return readRestaurantKeyring(getenv, storeID)
}

// Keep the old fixture/legacy constructor form, but reject ambiguous or nil
// overrides before any schema statement or random-key generation.
func restaurantCipherOverride(supplied []cipher.AEAD) (cipher.AEAD, bool, error) {
	if len(supplied) == 0 {
		return nil, false, nil
	}
	if len(supplied) != 1 || supplied[0] == nil {
		return nil, false, errRestaurantDataCipher
	}
	value := reflect.ValueOf(supplied[0])
	switch value.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		if value.IsNil() {
			return nil, false, errRestaurantDataCipher
		}
	}
	return supplied[0], true, nil
}

// Offline maintenance has no schema initializers, HTTP handlers, payment
// workers, or CREATE DATABASE path. Only the maintenance implementation is
// permitted to change key state, under the same namespace lock as runtime.
func restaurantRunKeyMaintenance(ctx context.Context, pgURL, namespace, command string) error {
	if command != "init" && command != "migrate" && command != "rotate" && command != "verify" {
		return errRestaurantCryptoConfiguration
	}
	ring, err := restaurantCryptoRingFromEnv(os.Getenv)
	if err != nil {
		return err
	}
	if ring == nil {
		return errRestaurantCryptoConfiguration
	}
	db, err := openExistingRestaurantDatabase(ctx, pgURL, namespace)
	if err != nil {
		return errRestaurantCryptoDatabase
	}
	defer db.Close()
	if namespace == "" {
		namespace = "wacalls"
	}
	database := namespace + "_main"
	owner, err := acquireInstanceOwnership(ctx, db, database)
	if err != nil {
		if errors.Is(err, errInstanceAlreadyRunning) {
			return errInstanceAlreadyRunning
		}
		return errRestaurantCryptoMaintenance
	}
	defer owner.Close()
	if err := restaurantMaintainKeys(ctx, owner, database, "public", ring, command, nil); err != nil {
		if errors.Is(err, errRestaurantKeyCommit) {
			return errRestaurantKeyCommit
		}
		return errRestaurantCryptoMaintenance
	}
	return nil
}
