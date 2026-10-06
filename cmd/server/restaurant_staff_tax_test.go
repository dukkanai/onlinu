package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"github.com/google/uuid"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestRestaurantStaffTaxPreservesGrossPricesHistoryAndAudit(t *testing.T) {
	orders, store, db := restaurantOrdersFixtureDB(t)
	ctx := context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"platform:synthetic-tax", "staff:tax:update"})
	before, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	input := restaurantOrderFixtureInput("delivery")
	input.ExpectedTotalMinor = 3500
	receipt, err := orders.Create(ctx, input, "", uuid.NewString())
	if err != nil {
		t.Fatal(err)
	}
	view, err := store.StaffTax(ctx)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(view)
	for _, private := range []string{`"tables"`, `"phone"`, `"paymentMethods"`, `"brand"`, before.Tables[0].Code} {
		if strings.Contains(string(raw), private) {
			t.Fatal("unrelated field", private)
		}
	}
	enabled, rate, number := true, int64(1500), "SYNTHETIC-NOT-A-TAX-ID"
	patch := restaurantTaxPatch{ExpectedVersion: view.Version, Reviewed: true, Enabled: &enabled, RateBps: &rate, TaxNumber: &number}
	missing := patch
	missing.Reviewed = false
	_, err = store.PatchTax(ctx, missing)
	restaurantOrdersRequireError(t, err, "invalid_request")
	missing = patch
	missing.Enabled = nil
	_, err = store.PatchTax(ctx, missing)
	restaurantOrdersRequireError(t, err, "invalid_request")
	saved, err := store.PatchTax(ctx, patch)
	if err != nil || !saved.Enabled || saved.RateBps != rate || saved.TaxNumber != number || !saved.PricesIncludeTax {
		t.Fatal(saved, err)
	}
	after, err := store.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	expected := before
	expected.Version = saved.Version
	expected.Settings.TaxEnabled = enabled
	expected.Settings.TaxRateBps = rate
	expected.Settings.TaxNumber = number
	if !reflect.DeepEqual(after, expected) {
		t.Fatal("tax patch changed unrelated catalogue or gross prices")
	}
	historical, err := orders.Track(ctx, receipt.Order.Number, receipt.TrackingToken, "", "")
	if err != nil || !reflect.DeepEqual(historical.Tax, receipt.Order.Tax) || historical.TotalMinor != receipt.Order.TotalMinor {
		t.Fatal("rewrote historical financial snapshot", err)
	}
	quote, err := orders.Quote(ctx, input)
	if err != nil || !quote.Tax.Enabled || quote.TotalMinor != receipt.Order.TotalMinor || quote.Tax.NetMinor+quote.Tax.TaxMinor != quote.TotalMinor {
		t.Fatal("original inclusive tax quote", quote, err)
	}
	var actor, scope, kind string
	if err = db.QueryRow("SELECT actor_id,actor_scope,kind FROM restaurant_catalog_audit WHERE version=$1", saved.Version).Scan(&actor, &scope, &kind); err != nil || actor != "platform:synthetic-tax" || scope != "staff:tax:update" || kind != "tax_update" {
		t.Fatal("missing tax actor audit", err)
	}
	_, err = store.PatchTax(ctx, patch)
	restaurantOrdersRequireError(t, err, "catalog_changed")
	patch.ExpectedVersion = saved.Version
	invalidRate := int64(10001)
	patch.RateBps = &invalidRate
	_, err = store.PatchTax(ctx, patch)
	restaurantOrdersRequireError(t, err, "invalid_request")
	patch.RateBps = &rate
	blank := ""
	patch.TaxNumber = &blank
	_, err = store.PatchTax(ctx, patch)
	restaurantOrdersRequireError(t, err, "invalid_request")
	patch.TaxNumber = &number
	if _, err = db.Exec(`CREATE FUNCTION reject_tax_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure';END $$; CREATE TRIGGER reject_tax_audit BEFORE INSERT ON restaurant_catalog_audit FOR EACH ROW EXECUTE FUNCTION reject_tax_audit()`); err != nil {
		t.Fatal(err)
	}
	enabled = false
	if _, err = store.PatchTax(ctx, patch); err == nil {
		t.Fatal("ignored audit failure")
	}
	unchanged, err := store.GetCatalog(ctx, false)
	if err != nil || !reflect.DeepEqual(unchanged, after) {
		t.Fatal("tax audit failure did not roll back", err)
	}
}

func TestPlatformStaffTaxActualNodeSignedReview(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" {
		t.Skip("requires Node fixture")
	}
	s, h := restaurantHTTPFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	actor := uuid.NewString()
	for _, scope := range []string{"orders:read", "staff:settings:read", "staff:tax:update"} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, platformTestRequest(t, private, actor, "GET", "/platform-api/staff/tax", "", scope, nil, nil))
		if w.Code != 401 {
			t.Fatalf("wrong tax scope %s accepted: %d", scope, w.Code)
		}
	}
	for _, input := range []any{map[string]any{"expectedVersion": 1, "enabled": true, "rateBps": 1500, "taxNumber": "SYNTHETIC"}, map[string]any{"expectedVersion": 1, "reviewed": true, "rateBps": 1500, "taxNumber": "SYNTHETIC"}} {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, platformTestRequest(t, private, actor, "POST", "/platform-api/staff/tax", "", "staff:tax:update", input, nil))
		if w.Code != 400 {
			t.Fatalf("missing reviewed tuple accepted: %d", w.Code)
		}
	}
	service := httptest.NewServer(h)
	defer service.Close()
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	fixture, _ := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))})
	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "node", "integration/tax-control-check.mjs")
	command.Dir = filepath.Join("..", "..", "prototype", "platform")
	command.Env = append(os.Environ(), "CORE_TAX_FIXTURE="+string(fixture))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("actual tax adapter: %v\n%s", err, output)
	}
	t.Log(string(output))
}
