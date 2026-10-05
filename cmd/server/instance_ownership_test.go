package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/google/uuid"
)

func TestInstanceOwnershipExcludesDuplicateAndReleases(t *testing.T) {
	db := restaurantIntegrationDB(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	namespace := "isolated-" + uuid.NewString()
	one, err := acquireInstanceOwnership(ctx, db, namespace)
	if err != nil {
		t.Fatal(err)
	}
	defer one.Close()
	if _, err := acquireInstanceOwnership(ctx, db, namespace); !errors.Is(err, errInstanceAlreadyRunning) {
		t.Fatalf("duplicate owner: %v", err)
	}
	other, err := acquireInstanceOwnership(ctx, db, namespace+"-other")
	if err != nil {
		t.Fatal("independent namespace blocked", err)
	}
	other.Close()
	if err := one.check(ctx); err != nil {
		t.Fatal(err)
	}
	one.Close()
	two, err := acquireInstanceOwnership(ctx, db, namespace)
	if err != nil {
		t.Fatal("ownership not released", err)
	}
	two.Close()
}

func TestInstanceOwnershipLossFailsClosed(t *testing.T) {
	db := restaurantIntegrationDB(t) // refuses any non-isolated database
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	one, err := acquireInstanceOwnership(ctx, db, "isolated-loss-"+uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	defer one.Close()
	// Terminate only this test's dedicated ownership connection, never a
	// session belonging to production or another test.
	var terminated bool
	if err := db.QueryRowContext(ctx, `SELECT pg_terminate_backend($1)`, one.pid).Scan(&terminated); err != nil || !terminated {
		t.Fatal("terminate owned test connection", err)
	}
	if err := one.check(ctx); err == nil || one.healthy.Load() {
		t.Fatal("lost ownership remained healthy")
	}
}
