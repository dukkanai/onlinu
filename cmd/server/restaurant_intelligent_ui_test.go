package main

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// Produces synthetic public menu/quote evidence from the actual Go -> Node MCP
// path. This does not establish that ChatGPT renders Intelligent UI or that a
// generated control can invoke a plugin; those require an actual client check.
func TestRestaurantIntelligentUIReadOnlyExperiment(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" {
		t.Skip("set TEST_CORE_ADAPTER=1 for real-core MCP experiment")
	}
	s, h := restaurantHTTPFixture(t)
	// A read-only demo must not need the fixture's synthetic payment provider.
	s.orders.PaymentAvailable = nil
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	current, err := s.restaurant.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog := restaurantOrderFixtureCatalog()
	catalog.Version = current.Version
	catalog.Settings.Name = "مطعم تجربة الواجهة الذكية — بيانات وهمية"
	catalog.Settings.Description = "تجربة عرض فقط، لا بيع أو دفع أو حجز مخزون"
	catalog.Settings.TaxEnabled = true
	catalog.Settings.TaxRateBps = 1500
	catalog.Settings.TaxNumber = "SYNTHETIC-TEST-NOT-A-TAX-ID"
	catalog.Settings.DeliveryEnabled = false
	catalog.Settings.TableEnabled = false
	catalog.Categories = []restaurantCategory{{ID: "meals", Name: "وجبات تجريبية"}}
	options := []restaurantOption{{ID: "extra-rice", Name: "أرز إضافي", PriceMinor: 500, Available: true}}
	catalog.Items = []restaurantItem{
		{ID: "chicken", CategoryID: "meals", Name: "وجبة دجاج", Description: "صنف تجريبي بلا ادعاءات غذائية", PriceMinor: 3200, Available: true, Options: options},
		{ID: "beef", CategoryID: "meals", Name: "وجبة لحم", Description: "صنف تجريبي بلا ادعاءات غذائية", PriceMinor: 3800, Available: true, Options: options},
		{ID: "vegetable", CategoryID: "meals", Name: "وجبة خضار", Description: "صنف تجريبي بلا ادعاءات غذائية", PriceMinor: 2600, Available: true, Options: options},
		{ID: "unavailable", CategoryID: "meals", Name: "صنف غير متاح", PriceMinor: 2000, Available: false},
	}
	catalog.Tables = []restaurantTable{}
	if _, err = s.restaurant.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(h)
	defer srv.Close()
	raw, _ := json.Marshal(map[string]string{"baseUrl": srv.URL})
	command := exec.CommandContext(ctx, "node", "integration/intelligent-ui-menu-check.mjs")
	command.Dir = filepath.Join("..", "..", "prototype", "platform")
	command.Env = append(os.Environ(), "INTELLIGENT_UI_CORE_FIXTURE="+string(raw))
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("real-core experiment: %v\n%s", err, output)
	}
	// Every operation is a read-only preview. No customer/order/payment is created.
	for _, table := range []string{"restaurant_orders", "restaurant_customers"} {
		var n int
		if err = s.restaurant.db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil || n != 0 {
			t.Fatalf("unexpected %s mutation %d %v", table, n, err)
		}
	}
	t.Log("Verified real Go/PostgreSQL menu and four MCP quotes, rejected unavailable item, zero orders/customers; actual Intelligent UI client rendering remains a separate check.")
}
