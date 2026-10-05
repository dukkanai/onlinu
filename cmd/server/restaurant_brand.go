package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"math"
	"strconv"
)

// Only published appearance is embedded in the public catalog. Drafts and the
// previous appearance are private, independently versioned admin resources.
type restaurantBrand struct {
	Template           string `json:"template"`
	StorefrontTemplate string `json:"storefrontTemplate"`
	PrimaryColor       string `json:"primaryColor"`
	PrimaryTextColor   string `json:"primaryTextColor"`
	SecondaryColor     string `json:"secondaryColor"`
	SecondaryTextColor string `json:"secondaryTextColor"`
	HeadingColor       string `json:"headingColor"`
	BodyColor          string `json:"bodyColor"`
	PageColor          string `json:"pageColor"`
	CardColor          string `json:"cardColor"`
	CartColor          string `json:"cartColor"`
	BorderColor        string `json:"borderColor"`
	LogoURL            string `json:"logoUrl"`
	CoverURL           string `json:"coverUrl"`
	IntroImageURL      string `json:"introImageUrl"`
	IntroTitle         string `json:"introTitle"`
	IntroText          string `json:"introText"`
	HideHero           bool   `json:"hideHero"`
	Radius             string `json:"radius"`
	Shadow             string `json:"shadow"`
	Font               string `json:"font"`
	HeadingFont        string `json:"headingFont"`
	BodyFont           string `json:"bodyFont"`
	ButtonFont         string `json:"buttonFont"`
	ImageFit           string `json:"imageFit"`
	TextSize           string `json:"textSize"`
	Layout             string `json:"layout"`
}

type restaurantBrandState struct {
	Version        int64            `json:"version"`
	CatalogVersion int64            `json:"catalogVersion"`
	Live           restaurantBrand  `json:"live"`
	Draft          *restaurantBrand `json:"draft"`
	HasPrevious    bool             `json:"hasPrevious"`
}

func restaurantBrandLuminance(color string) float64 {
	var result float64
	for i, weight := range []float64{0.2126, 0.7152, 0.0722} {
		n, _ := strconv.ParseUint(color[1+i*2:3+i*2], 16, 8)
		v := float64(n) / 255
		if v <= 0.04045 {
			v /= 12.92
		} else {
			v = math.Pow((v+0.055)/1.055, 2.4)
		}
		result += v * weight
	}
	return result
}

func restaurantBrandContrast(a, b string) float64 {
	x, y := restaurantBrandLuminance(a), restaurantBrandLuminance(b)
	return (math.Max(x, y) + 0.05) / (math.Min(x, y) + 0.05)
}

func restaurantBrandText(background string) string {
	if restaurantBrandContrast(background, "#ffffff") >= 4.5 {
		return "#ffffff"
	}
	return "#000000"
}

// New presentation choices are independent of the existing color preset and
// grid/list setting. Old live brands, saved drafts and previous versions lack
// these fields. Empty role fonts mean "inherit Font" and must stay empty in
// drafts, published data and responses, so changing Font still takes effect.
// The renderer resolves inheritance. Unknown values still fail validation.
func normalizeRestaurantBrandDefaults(b restaurantBrand) restaurantBrand {
	if b.StorefrontTemplate == "" {
		b.StorefrontTemplate = "classic"
	}
	return b
}

func restaurantBrandFontValid(font string) bool {
	switch font {
	case "system", "serif", "cairo", "amiri", "tajawal":
		return true
	default:
		return false
	}
}

func restaurantEffectiveBrand(s restaurantSettings) restaurantBrand {
	if s.Brand != nil {
		return normalizeRestaurantBrandDefaults(*s.Brand)
	}
	primary, secondary, page := s.PrimaryColor, s.AccentColor, s.BackgroundColor
	if !restaurantColorPattern.MatchString(primary) {
		primary = restaurantDefaultPrimaryColor
	}
	if !restaurantColorPattern.MatchString(secondary) {
		secondary = restaurantDefaultAccentColor
	}
	if !restaurantColorPattern.MatchString(page) {
		page = restaurantDefaultBackgroundColor
	}
	body := "#1f332e"
	if restaurantBrandContrast(body, page) < 4.5 {
		body = restaurantBrandText(page)
	}
	// Keep all surfaces readable for legacy dark themes as well.
	card := "#fffefa"
	if restaurantBrandContrast(body, card) < 4.5 {
		card = page
	}
	return normalizeRestaurantBrandDefaults(restaurantBrand{Template: "classic", PrimaryColor: primary, PrimaryTextColor: restaurantBrandText(primary),
		SecondaryColor: secondary, SecondaryTextColor: restaurantBrandText(secondary), HeadingColor: body, BodyColor: body,
		PageColor: page, CardColor: card, CartColor: card, BorderColor: "#a1a99d", LogoURL: s.LogoURL, CoverURL: s.CoverURL,
		Radius: "soft", Shadow: "soft", Font: "system", ImageFit: "cover", TextSize: "normal", Layout: "grid"})
}

func validateRestaurantBrand(b restaurantBrand) error {
	b = normalizeRestaurantBrandDefaults(b)
	for _, color := range []string{b.PrimaryColor, b.PrimaryTextColor, b.SecondaryColor, b.SecondaryTextColor, b.HeadingColor, b.BodyColor, b.PageColor, b.CardColor, b.CartColor, b.BorderColor} {
		if !restaurantColorPattern.MatchString(color) {
			return restaurantFail(400, "brand_invalid")
		}
	}
	if !restaurantSafeImageURL(b.LogoURL) || !restaurantSafeImageURL(b.CoverURL) || !restaurantSafeImageURL(b.IntroImageURL) ||
		!restaurantValidText(b.IntroTitle, 0, 160) || !restaurantValidText(b.IntroText, 0, 2000) {
		return restaurantFail(400, "brand_invalid")
	}
	if (b.Template != "classic" && b.Template != "warm" && b.Template != "modern") || (b.Radius != "square" && b.Radius != "soft" && b.Radius != "round") ||
		(b.Shadow != "none" && b.Shadow != "soft") || (b.Font != "system" && b.Font != "serif") || (b.ImageFit != "cover" && b.ImageFit != "contain") {
		return restaurantFail(400, "brand_invalid")
	}
	if (b.TextSize != "normal" && b.TextSize != "large") || (b.Layout != "grid" && b.Layout != "list") {
		return restaurantFail(400, "brand_invalid")
	}
	switch b.StorefrontTemplate {
	case "classic", "bistro", "editorial", "compact", "showcase":
	default:
		return restaurantFail(400, "brand_invalid")
	}
	for _, font := range []string{b.HeadingFont, b.BodyFont, b.ButtonFont} {
		if font != "" && !restaurantBrandFontValid(font) {
			return restaurantFail(400, "brand_invalid")
		}
	}
	for _, pair := range [][2]string{{b.PrimaryColor, b.PrimaryTextColor}, {b.SecondaryColor, b.SecondaryTextColor},
		{b.PageColor, b.BodyColor}, {b.CardColor, b.BodyColor}, {b.CartColor, b.BodyColor}, {b.PageColor, b.HeadingColor}, {b.CardColor, b.HeadingColor}, {b.CartColor, b.HeadingColor}} {
		if restaurantBrandContrast(pair[0], pair[1]) < 4.5 {
			return restaurantFail(400, "brand_contrast")
		}
	}
	return nil
}

func initRestaurantBrand(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_brand_state (
		id INTEGER PRIMARY KEY CHECK (id=1), version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),
		draft JSONB, previous JSONB, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
	); INSERT INTO restaurant_brand_state(id) VALUES(1) ON CONFLICT(id) DO NOTHING;
CREATE TABLE IF NOT EXISTS platform_staff_brand_audit(version BIGINT PRIMARY KEY,catalog_version BIGINT NOT NULL,actor_id TEXT NOT NULL,scope TEXT NOT NULL,kind TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now())`)
	return err
}

func readRestaurantBrandState(ctx context.Context, q restaurantCatalogQueryer, catalog restaurantCatalog, lock bool) (restaurantBrandState, *restaurantBrand, error) {
	state := restaurantBrandState{Live: restaurantEffectiveBrand(catalog.Settings), CatalogVersion: catalog.Version}
	query := `SELECT version,draft,previous FROM restaurant_brand_state WHERE id=1`
	if lock {
		query += ` FOR UPDATE`
	}
	var draft, previous []byte
	if err := q.QueryRowContext(ctx, query).Scan(&state.Version, &draft, &previous); err != nil {
		return state, nil, err
	}
	if len(draft) > 0 {
		if err := json.Unmarshal(draft, &state.Draft); err != nil {
			return state, nil, err
		}
		if state.Draft != nil {
			*state.Draft = normalizeRestaurantBrandDefaults(*state.Draft)
		}
	}
	var prior *restaurantBrand
	if len(previous) > 0 {
		if err := json.Unmarshal(previous, &prior); err != nil {
			return state, nil, err
		}
		if prior != nil {
			*prior = normalizeRestaurantBrandDefaults(*prior)
		}
	}
	state.HasPrevious = prior != nil
	return state, prior, nil
}

func (s *restaurantStore) BrandState(ctx context.Context) (restaurantBrandState, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		return restaurantBrandState{}, err
	}
	defer tx.Rollback()
	catalog, err := loadRestaurantCatalog(ctx, tx, false)
	if err != nil {
		return restaurantBrandState{}, err
	}
	state, _, err := readRestaurantBrandState(ctx, tx, catalog, false)
	if err != nil {
		return state, err
	}
	return state, tx.Commit()
}

func (s *restaurantStore) SaveBrandDraft(ctx context.Context, version int64, brand restaurantBrand) (restaurantBrandState, error) {
	brand = normalizeRestaurantBrandDefaults(brand)
	if err := validateRestaurantBrand(brand); err != nil {
		return restaurantBrandState{}, err
	}
	if version < 1 || version == math.MaxInt64 {
		return restaurantBrandState{}, restaurantFail(409, "brand_changed")
	}
	data, err := json.Marshal(brand)
	if err != nil {
		return restaurantBrandState{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantBrandState{}, err
	}
	defer tx.Rollback()
	// Match publication's catalog-first lock order. Legacy callers retain the
	// existing appearance-version contract; staff patches add a reviewed catalog.
	var catalogVersion int64
	if err = tx.QueryRowContext(ctx, `SELECT version FROM restaurant_catalog WHERE id=1 FOR UPDATE`).Scan(&catalogVersion); err != nil {
		return restaurantBrandState{}, err
	}
	if expected, ok := ctx.Value(platformStaffBrandCatalogKey{}).(int64); ok && expected != catalogVersion {
		return restaurantBrandState{}, restaurantFail(409, "brand_changed")
	}
	result, err := tx.ExecContext(ctx, `UPDATE restaurant_brand_state SET draft=$1,version=version+1,updated_at=now() WHERE id=1 AND version=$2`, data, version)
	if err != nil {
		return restaurantBrandState{}, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return restaurantBrandState{}, err
	}
	if n != 1 {
		return restaurantBrandState{}, restaurantFail(409, "brand_changed")
	}
	catalog, err := loadRestaurantCatalog(ctx, tx, false)
	if err != nil {
		return restaurantBrandState{}, err
	}
	state, _, err := readRestaurantBrandState(ctx, tx, catalog, false)
	if err != nil {
		return state, err
	}
	if err = writePlatformStaffBrandAudit(ctx, tx, state, "draft_saved"); err != nil {
		return state, err
	}
	return state, tx.Commit()
}

func (s *restaurantStore) PublishBrand(ctx context.Context, version int64, revert bool) (restaurantBrandState, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantBrandState{}, err
	}
	defer tx.Rollback()
	// All appearance publication locks catalog before state, matching catalog
	// mutations. Only appearance changes; current menu/tax/order policy survives.
	var raw []byte
	var catalogVersion int64
	if err = tx.QueryRowContext(ctx, `SELECT version,document FROM restaurant_catalog WHERE id=1 FOR UPDATE`).Scan(&catalogVersion, &raw); err != nil {
		return restaurantBrandState{}, err
	}
	var catalog restaurantCatalog
	if err = json.Unmarshal(raw, &catalog); err != nil {
		return restaurantBrandState{}, err
	}
	if err = normalizeRestaurantCatalogDefaults(&catalog, raw); err != nil {
		return restaurantBrandState{}, err
	}
	catalog.Version = catalogVersion
	if expected, ok := ctx.Value(platformStaffBrandCatalogKey{}).(int64); ok && expected != catalogVersion {
		return restaurantBrandState{}, restaurantFail(409, "brand_changed")
	}
	state, previous, err := readRestaurantBrandState(ctx, tx, catalog, true)
	if err != nil {
		return state, err
	}
	if version != state.Version || version == math.MaxInt64 || catalogVersion == math.MaxInt64 {
		return state, restaurantFail(409, "brand_changed")
	}
	next := state.Draft
	if revert {
		next = previous
	}
	if next == nil {
		return state, restaurantFail(400, "brand_no_draft")
	}
	if err = validateRestaurantBrand(*next); err != nil {
		return state, err
	}
	prior, err := json.Marshal(state.Live)
	if err != nil {
		return state, err
	}
	catalog.Settings.Brand = next
	catalog.Version++
	data, err := json.Marshal(catalog)
	if err != nil {
		return state, err
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_catalog SET document=$1,version=$2,updated_at=now() WHERE id=1`, data, catalog.Version); err != nil {
		return state, err
	}
	// Revert does not erase a saved in-progress draft; publishing consumes it.
	query := `UPDATE restaurant_brand_state SET previous=$1,version=version+1,updated_at=now() WHERE id=1`
	if !revert {
		query = `UPDATE restaurant_brand_state SET previous=$1,draft=NULL,version=version+1,updated_at=now() WHERE id=1`
	}
	if _, err = tx.ExecContext(ctx, query, prior); err != nil {
		return state, err
	}
	state, _, err = readRestaurantBrandState(ctx, tx, catalog, false)
	if err != nil {
		return state, err
	}
	kind := "published"
	if revert {
		kind = "reverted"
	}
	if err = writePlatformStaffBrandAudit(ctx, tx, state, kind); err != nil {
		return state, err
	}
	if err = tx.Commit(); err != nil {
		return state, err
	}
	return state, nil
}
