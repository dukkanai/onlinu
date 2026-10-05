package main

import (
	"bytes"
	"context"
	"database/sql"
	"io"
	"net/http"
)

type platformStaffBrandCatalogKey struct{}

func writePlatformStaffBrandAudit(ctx context.Context, tx *sql.Tx, state restaurantBrandState, kind string) error {
	actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor)
	if !ok {
		return nil
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO platform_staff_brand_audit(version,catalog_version,actor_id,scope,kind) VALUES($1,$2,$3,$4,$5)`, state.Version, state.CatalogVersion, actor.ID, actor.Scope, kind)
	return err
}

type restaurantStaffBrandReview struct {
	Version        int64 `json:"version"`
	CatalogVersion int64 `json:"catalogVersion"`
	Reviewed       bool  `json:"reviewed"`
}
type restaurantStaffBrandPatch struct {
	restaurantStaffBrandReview
	StorefrontTemplate *string `json:"storefrontTemplate"`
	Font               *string `json:"font"`
	HeadingFont        *string `json:"headingFont"`
	BodyFont           *string `json:"bodyFont"`
	ButtonFont         *string `json:"buttonFont"`
	Layout             *string `json:"layout"`
	TextSize           *string `json:"textSize"`
	Radius             *string `json:"radius"`
	Shadow             *string `json:"shadow"`
	ImageFit           *string `json:"imageFit"`
	HideHero           *bool   `json:"hideHero"`
	IntroTitle         *string `json:"introTitle"`
	IntroText          *string `json:"introText"`
}

func (r restaurantStaffBrandReview) valid() bool {
	return r.Reviewed && r.Version > 0 && r.Version < 9007199254740991 && r.CatalogVersion > 0 && r.CatalogVersion < 9007199254740991
}
func (s *restaurantStore) PatchStaffBrandDraft(ctx context.Context, input restaurantStaffBrandPatch) (restaurantBrandState, error) {
	if !input.valid() {
		return restaurantBrandState{}, restaurantFail(400, "invalid_request")
	}
	state, err := s.BrandState(ctx)
	if err != nil {
		return state, err
	}
	if state.Version != input.Version || state.CatalogVersion != input.CatalogVersion {
		return state, restaurantFail(409, "brand_changed")
	}
	brand := state.Live
	if state.Draft != nil {
		brand = *state.Draft
	}
	changes := 0
	for _, pair := range [][2]*string{{input.StorefrontTemplate, &brand.StorefrontTemplate}, {input.Font, &brand.Font}, {input.HeadingFont, &brand.HeadingFont}, {input.BodyFont, &brand.BodyFont}, {input.ButtonFont, &brand.ButtonFont}, {input.Layout, &brand.Layout}, {input.TextSize, &brand.TextSize}, {input.Radius, &brand.Radius}, {input.Shadow, &brand.Shadow}, {input.ImageFit, &brand.ImageFit}, {input.IntroTitle, &brand.IntroTitle}, {input.IntroText, &brand.IntroText}} {
		if pair[0] != nil {
			*pair[1] = *pair[0]
			changes++
		}
	}
	if input.HideHero != nil {
		brand.HideHero = *input.HideHero
		changes++
	}
	if changes == 0 {
		return state, restaurantFail(400, "invalid_request")
	}
	return s.SaveBrandDraft(context.WithValue(ctx, platformStaffBrandCatalogKey{}, input.CatalogVersion), input.Version, brand)
}
func (s *server) registerPlatformStaffBrandRoutes(mux *http.ServeMux, wrap func(string, func(http.ResponseWriter, *http.Request, []byte, string)) http.HandlerFunc) {
	mux.HandleFunc("GET /platform-api/staff/brand", wrap("staff:settings:read", func(w http.ResponseWriter, r *http.Request, _ []byte, _ string) {
		if r.URL.RawQuery != "" {
			writeRestaurantError(w, restaurantFail(400, "invalid_request"))
			return
		}
		value, err := s.orders.store.BrandState(r.Context())
		if err != nil {
			writeRestaurantError(w, err)
			return
		}
		writeJSON(w, 200, value)
	}))
	for _, action := range []string{"draft", "publish", "revert"} {
		mux.HandleFunc("POST /platform-api/staff/brand/"+action, wrap("staff:brand:"+action, func(w http.ResponseWriter, r *http.Request, body []byte, actor string) {
			if r.URL.RawQuery != "" {
				writeRestaurantError(w, restaurantFail(400, "invalid_request"))
				return
			}
			r.Body = io.NopCloser(bytes.NewReader(body))
			ctx := context.WithValue(r.Context(), platformStaffActorKey{}, platformStaffActor{actor, "staff:brand:" + action})
			var value restaurantBrandState
			var err error
			if action == "draft" {
				var input restaurantStaffBrandPatch
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				value, err = s.orders.store.PatchStaffBrandDraft(ctx, input)
			} else {
				var input restaurantStaffBrandReview
				if !decodeRestaurantBody(w, r, &input) {
					return
				}
				if !input.valid() {
					writeRestaurantError(w, restaurantFail(400, "invalid_request"))
					return
				}
				value, err = s.orders.store.PublishBrand(context.WithValue(ctx, platformStaffBrandCatalogKey{}, input.CatalogVersion), input.Version, action == "revert")
			}
			if err != nil {
				writeRestaurantError(w, err)
				return
			}
			writeJSON(w, 200, value)
		}))
	}
}
