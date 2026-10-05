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

// Opt-in cross-language check: the standard Go suite must not require Node.
// Run after npm ci in prototype/platform, using the disposable restaurant DB.
func TestRestaurantCoreAdapterHTTPParity(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" {
		t.Skip("set TEST_CORE_ADAPTER=1 after installing platform Node dependencies")
	}
	var urls []string
	var servers []*server
	for i := 0; i < 2; i++ {
		s, handler := restaurantHTTPFixture(t)
		current, err := s.restaurant.GetCatalog(context.Background(), false)
		if err != nil {
			t.Fatal(err)
		}
		catalog := restaurantOrderFixtureCatalog()
		catalog.Version = current.Version
		catalog.Items[0].PriceMinor += int64(i * 500)
		catalog.Settings.TaxEnabled, catalog.Settings.TaxRateBps = true, 1500
		catalog.Settings.TaxNumber = "SYNTHETIC-TEST-NOT-A-TAX-ID"
		for j := range catalog.Tables {
			catalog.Tables[j].Code = ""
		}
		if _, err = s.restaurant.SaveCatalog(context.Background(), catalog); err != nil {
			t.Fatal(err)
		}
		httpServer := httptest.NewServer(handler)
		t.Cleanup(httpServer.Close)
		urls = append(urls, httpServer.URL)
		servers = append(servers, s)
	}
	// The adapter is not a second pricing implementation. It must exactly match
	// the original Go quote for options, taxes, payment choices and amounts.
	for _, template := range []string{"classic", "bistro", "editorial", "compact", "showcase"} {
		for _, mode := range []string{"pickup", "delivery", "table"} {
			t.Run(template+"/"+mode, func(t *testing.T) {
				var expected []restaurantQuote
				var requests []map[string]any
				var previews []restaurantPreviewInput
				for _, s := range servers {
					_, err := s.restaurant.db.Exec(`UPDATE restaurant_catalog SET document=jsonb_set(document::jsonb, '{settings,brand}', jsonb_build_object('storefrontTemplate', $1::text)) WHERE id=1`, template)
					if err != nil {
						t.Fatal(err)
					}
					input := restaurantOrderFixtureInput(mode)
					catalog, err := s.restaurant.GetCatalog(context.Background(), false)
					if err != nil {
						t.Fatal(err)
					}
					input.TableCode = catalog.Tables[0].Code
					quote, err := s.orders.Quote(context.Background(), input)
					if err != nil {
						t.Fatal(err)
					}
					expected = append(expected, quote)
					request := map[string]any{"mode": input.Mode, "customerName": input.CustomerName, "phone": input.Phone,
						"paymentMethod": input.PaymentMethod, "paymentProvider": input.PaymentProvider, "items": input.Items}
					preview := restaurantPreviewInput{Mode: mode, Items: input.Items}
					if mode == "delivery" {
						request["address"] = map[string]any{"country": "SA", "nationalAddress": "ABCD1234"}
						preview.Address.Country = "SA"
					}
					if mode == "table" {
						request["tableCode"] = input.TableCode
						preview.TableCode = input.TableCode
					}
					requests = append(requests, request)
					previews = append(previews, preview)
				}
				fixture, err := json.Marshal(map[string]any{"urls": urls, "inputs": requests, "previews": previews, "expected": expected, "template": template})
				if err != nil {
					t.Fatal(err)
				}
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
				defer cancel()
				command := exec.CommandContext(ctx, "node", "integration/core-adapter-check.mjs")
				command.Dir = filepath.Join("..", "..", "prototype", "platform")
				command.Env = append(os.Environ(), "CORE_ADAPTER_FIXTURE="+string(fixture))
				output, err := command.CombinedOutput()
				if err != nil {
					t.Fatalf("core adapter parity: %v\n%s", err, output)
				}
				t.Log(string(output))
			})
		}
	}
}
