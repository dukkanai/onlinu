package main

import "testing"

func TestRestaurantCryptoReviewedStripeColumnSignatures(t *testing.T) {
	base := append([]restaurantCryptoColumn(nil), restaurantCryptoSchemas["restaurant_payment_attempts"]...)
	full := append(append([]restaurantCryptoColumn(nil), base...), restaurantStripeCryptoAttemptColumns...)
	for _, columns := range [][]restaurantCryptoColumn{base, full} {
		if !restaurantCryptoColumnSignatureValid("restaurant_payment_attempts", columns) {
			t.Fatal("reviewed legacy or complete Stripe schema rejected")
		}
	}
	for _, count := range []int{1, 2} {
		if restaurantCryptoColumnSignatureValid("restaurant_payment_attempts", full[:len(base)+count]) {
			t.Fatal("partial Stripe migration accepted")
		}
	}
	for _, mutate := range []func([]restaurantCryptoColumn) []restaurantCryptoColumn{
		func(c []restaurantCryptoColumn) []restaurantCryptoColumn {
			c[len(base)], c[len(base)+1] = c[len(base)+1], c[len(base)]
			return c
		},
		func(c []restaurantCryptoColumn) []restaurantCryptoColumn { c[len(base)].kind = "varchar"; return c },
		func(c []restaurantCryptoColumn) []restaurantCryptoColumn { c[len(base)].notNull = false; return c },
		func(c []restaurantCryptoColumn) []restaurantCryptoColumn {
			c[len(base)].name = "unknown_synthetic"
			return c
		},
		func(c []restaurantCryptoColumn) []restaurantCryptoColumn {
			return append(c, restaurantCryptoColumn{"unknown_synthetic", "text", true})
		},
		func(c []restaurantCryptoColumn) []restaurantCryptoColumn { c[0].kind = "varchar"; return c },
	} {
		if restaurantCryptoColumnSignatureValid("restaurant_payment_attempts", mutate(append([]restaurantCryptoColumn(nil), full...))) {
			t.Fatal("unreviewed Stripe schema variant accepted")
		}
	}
	if restaurantCryptoColumnSignatureValid("unknown_table", nil) || restaurantCryptoColumnSignatureValid("restaurant_payment_configs", full) {
		t.Fatal("Stripe extension accepted for another table")
	}
}

func TestRestaurantKeyMigrationReviewedStripeSchemaVariants(t *testing.T) {
	const dropRoutingColumns = `ALTER TABLE restaurant_payment_attempts DROP COLUMN stripe_integration_identifier,DROP COLUMN stripe_intent_id,DROP COLUMN stripe_charge_id`
	for _, tc := range []struct {
		name, statement string
		valid           bool
	}{
		{"complete", "", true},
		{"legacy", dropRoutingColumns, true},
		{"partial", `ALTER TABLE restaurant_payment_attempts DROP COLUMN stripe_charge_id`, false},
		{"unknown", `ALTER TABLE restaurant_payment_attempts ADD COLUMN unknown_synthetic text`, false},
		{"wrong-type", `ALTER TABLE restaurant_payment_attempts ALTER COLUMN stripe_charge_id TYPE varchar`, false},
		{"nullable", `ALTER TABLE restaurant_payment_attempts ALTER COLUMN stripe_charge_id DROP NOT NULL`, false},
		{"missing-default", `ALTER TABLE restaurant_payment_attempts ALTER COLUMN stripe_charge_id DROP DEFAULT`, false},
		{"wrong-default", `ALTER TABLE restaurant_payment_attempts ALTER COLUMN stripe_charge_id SET DEFAULT 'unreviewed'`, false},
		{"generated", `ALTER TABLE restaurant_payment_attempts DROP COLUMN stripe_charge_id; ALTER TABLE restaurant_payment_attempts ADD COLUMN stripe_charge_id text GENERATED ALWAYS AS (''::text) STORED NOT NULL`, false},
		{"reordered", dropRoutingColumns + `;ALTER TABLE restaurant_payment_attempts ADD COLUMN stripe_intent_id text NOT NULL DEFAULT '',ADD COLUMN stripe_integration_identifier text NOT NULL DEFAULT '',ADD COLUMN stripe_charge_id text NOT NULL DEFAULT ''`, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := restaurantMaintenanceLegacyFixture(t)
			if tc.statement != "" {
				if _, err := f.db.ExecContext(f.ctx, tc.statement); err != nil {
					t.Fatal("synthetic schema setup", err)
				}
			}
			before := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			err := restaurantMaintainKeys(f.ctx, f.owner, f.database, f.schema, restaurantMaintenanceRing(t, "old", "old"), "migrate", nil)
			if (err == nil) != tc.valid {
				t.Fatalf("reviewed Stripe schema acceptance differs: valid=%v err=%v", tc.valid, err)
			}
			if !tc.valid {
				restaurantMaintenanceUnchanged(t, f.ctx, f.db, before)
				return
			}
			// This is recognition of a migration already performed by the
			// application, never permission for key maintenance to rewrite it.
			after := restaurantMaintenanceSnapshot(t, f.ctx, f.db)
			for _, table := range []string{"restaurant_orders", "restaurant_payment_configs", "restaurant_payment_attempts"} {
				if before[table] != after[table] {
					t.Fatal("maintenance rewrote payloads", table)
				}
			}
		})
	}
}
