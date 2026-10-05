package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func staffBrandFixture(t *testing.T) (*restaurantStore, restaurantBrandState) {
	t.Helper()
	s, err := newRestaurantStore(context.Background(), restaurantIntegrationDB(t))
	if err != nil {
		t.Fatal(err)
	}
	state, err := s.BrandState(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	return s, state
}
func staffBrandActor(action string) context.Context {
	return context.WithValue(context.Background(), platformStaffActorKey{}, platformStaffActor{"synthetic-designer", "staff:brand:" + action})
}
func TestPlatformStaffBrandPrivatePartialDraftPublicationAndRestore(t *testing.T) {
	s, initial := staffBrandFixture(t)
	ctx := context.Background()
	old, err := s.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	layout, font, title := "editorial", "amiri", "Synthetic private draft"
	input := restaurantStaffBrandPatch{restaurantStaffBrandReview: restaurantStaffBrandReview{initial.Version, initial.CatalogVersion, true}, StorefrontTemplate: &layout, HeadingFont: &font, IntroTitle: &title}
	draft, err := s.PatchStaffBrandDraft(staffBrandActor("draft"), input)
	if err != nil || draft.Draft == nil || draft.Live != initial.Live || draft.Draft.PrimaryColor != initial.Live.PrimaryColor || draft.Draft.LogoURL != initial.Live.LogoURL {
		t.Fatal("private partial draft", draft, err)
	}
	if draft.Draft.StorefrontTemplate != "editorial" || draft.Draft.HeadingFont != "amiri" {
		t.Fatal("draft omitted selected fields")
	}
	live, err := s.GetCatalog(ctx, false)
	if err != nil || !reflect.DeepEqual(live, old) {
		t.Fatal("draft leaked into live catalogue", err)
	}
	_, err = s.PatchStaffBrandDraft(staffBrandActor("draft"), input)
	restaurantTestErrorCode(t, err, "brand_changed")
	published, err := s.PublishBrand(context.WithValue(staffBrandActor("publish"), platformStaffBrandCatalogKey{}, draft.CatalogVersion), draft.Version, false)
	if err != nil || published.Live != *draft.Draft || published.Draft != nil || !published.HasPrevious {
		t.Fatal("publication", published, err)
	}
	restored, err := s.PublishBrand(context.WithValue(staffBrandActor("revert"), platformStaffBrandCatalogKey{}, published.CatalogVersion), published.Version, true)
	if err != nil || restored.Live != initial.Live {
		t.Fatal("restore", restored, err)
	}
	after, err := s.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	after.Version = old.Version
	after.Settings.Brand = old.Settings.Brand
	if !reflect.DeepEqual(after, old) {
		t.Fatal("appearance altered unrelated catalogue/payment/tax/table fields")
	}
	var count int
	if err = s.db.QueryRowContext(ctx, `SELECT count(*) FROM platform_staff_brand_audit WHERE actor_id='synthetic-designer'`).Scan(&count); err != nil || count != 3 {
		t.Fatal("actor audit", count, err)
	}
}
func TestPlatformStaffBrandReviewBindsCatalogAndRequiresExplicitChanges(t *testing.T) {
	s, initial := staffBrandFixture(t)
	ctx := context.Background()
	value := "compact"
	input := restaurantStaffBrandPatch{restaurantStaffBrandReview: restaurantStaffBrandReview{initial.Version, initial.CatalogVersion, false}, StorefrontTemplate: &value}
	_, err := s.PatchStaffBrandDraft(staffBrandActor("draft"), input)
	restaurantTestErrorCode(t, err, "invalid_request")
	input.Reviewed = true
	input.StorefrontTemplate = nil
	_, err = s.PatchStaffBrandDraft(staffBrandActor("draft"), input)
	restaurantTestErrorCode(t, err, "invalid_request")
	input.StorefrontTemplate = &value
	catalog, err := s.GetCatalog(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	catalog.Settings.Name = "New public name"
	if _, err = s.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal(err)
	}
	_, err = s.PatchStaffBrandDraft(staffBrandActor("draft"), input)
	restaurantTestErrorCode(t, err, "brand_changed")
	// Even an intervening catalog write after the initial read is checked under lock.
	_, err = s.SaveBrandDraft(context.WithValue(staffBrandActor("draft"), platformStaffBrandCatalogKey{}, initial.CatalogVersion), initial.Version, initial.Live)
	restaurantTestErrorCode(t, err, "brand_changed")
}
func TestPlatformStaffBrandAuditFailureRollsBackDraftAndPublication(t *testing.T) {
	for _, action := range []string{"draft", "publish"} {
		t.Run(action, func(t *testing.T) {
			s, initial := staffBrandFixture(t)
			ctx := context.Background()
			brand := initial.Live
			brand.IntroTitle = "Synthetic draft"
			if action == "publish" {
				var err error
				initial, err = s.SaveBrandDraft(ctx, initial.Version, brand)
				if err != nil {
					t.Fatal(err)
				}
			}
			_, err := s.db.ExecContext(ctx, `CREATE FUNCTION reject_staff_brand_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END $$;CREATE TRIGGER reject_staff_brand_audit BEFORE INSERT ON platform_staff_brand_audit FOR EACH ROW EXECUTE FUNCTION reject_staff_brand_audit()`)
			if err != nil {
				t.Fatal(err)
			}
			if action == "draft" {
				_, err = s.SaveBrandDraft(staffBrandActor(action), initial.Version, brand)
			} else {
				_, err = s.PublishBrand(staffBrandActor(action), initial.Version, false)
			}
			if err == nil {
				t.Fatal("audit failure ignored")
			}
			after, err := s.BrandState(ctx)
			if err != nil || !reflect.DeepEqual(after, initial) {
				t.Fatal("appearance committed despite audit failure", after, err)
			}
		})
	}
}

func TestPlatformStaffBrandActualNodeSignedReview(t *testing.T) {
	if os.Getenv("TEST_CORE_ADAPTER") != "1" {
		t.Skip("requires Node fixture")
	}
	s, h := restaurantHTTPFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	s.platformAuth = &platformRequestAuth{issuer: "https://platform.example", tenantID: "restaurant-a", publicKey: public, now: time.Now}
	service := httptest.NewServer(h)
	defer service.Close()
	der, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := json.Marshal(map[string]any{"baseUrl": service.URL, "privateKey": string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))})
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "node", "integration/brand-control-check.mjs")
	cmd.Dir = filepath.Join("..", "..", "prototype", "platform")
	cmd.Env = append(os.Environ(), "CORE_BRAND_FIXTURE="+string(fixture))
	output, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("brand adapter: %v\n%s", err, output)
	}
	t.Log(string(output))
}
