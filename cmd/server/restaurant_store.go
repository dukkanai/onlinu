package main

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"math"
	"net/url"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Catalog and orders deliberately do not share WhatsApp account tables. One
// restaurant is configured per deployment; customer-visible prices are always
// read from this versioned, server-authoritative document.
type restaurantStore struct{ db *sql.DB }

const restaurantMaxMinor int64 = 100_000_000

const (
	restaurantDefaultPrimaryColor    = "#214e40"
	restaurantDefaultAccentColor     = "#d6a85f"
	restaurantDefaultBackgroundColor = "#f8f7f2"
)

var (
	restaurantIDPattern         = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)
	restaurantTableCodePattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{32,64}$`)
	restaurantLocalImagePattern = regexp.MustCompile(`^/restaurant-media/[A-Za-z0-9_-]{1,100}\.(?:png|jpg|jpeg)$`)
	restaurantColorPattern      = regexp.MustCompile(`^#[A-Fa-f0-9]{6}$`)
)

type restaurantCatalogQueryer interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

func newRestaurantStore(ctx context.Context, db *sql.DB) (*restaurantStore, error) {
	if err := initRestaurantBrand(ctx, db); err != nil {
		return nil, err
	}
	if err := initRestaurantGeography(ctx, db); err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_catalog (
		id INTEGER PRIMARY KEY CHECK (id = 1),
		version BIGINT NOT NULL CHECK (version > 0),
		document JSONB NOT NULL,
		updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
	);
	CREATE TABLE IF NOT EXISTS restaurant_catalog_audit (
		version BIGINT PRIMARY KEY,actor_id TEXT NOT NULL,actor_scope TEXT NOT NULL,
		kind TEXT NOT NULL,target_id TEXT NOT NULL,created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`); err != nil {
		return nil, err
	}
	// ON CONFLICT ensures that restarts and concurrent constructors never replace
	// restaurant-entered content. Demo data is inserted only on a fresh database.
	seed, err := newRestaurantDemoCatalog()
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(seed)
	if err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx, `INSERT INTO restaurant_catalog (id, version, document)
		VALUES (1, $1, $2) ON CONFLICT (id) DO NOTHING`, seed.Version, data); err != nil {
		return nil, err
	}
	return &restaurantStore{db: db}, nil
}

// lock is used only inside an order transaction. FOR SHARE allows concurrent
// orders, while preventing an admin save from changing prices or table codes
// between validation and order insertion. SaveCatalog locks the same row first.
func loadRestaurantCatalog(ctx context.Context, q restaurantCatalogQueryer, lock bool) (restaurantCatalog, error) {
	query := `SELECT version, document FROM restaurant_catalog WHERE id = 1`
	if lock {
		query += ` FOR SHARE`
	}
	var version int64
	var data []byte
	if err := q.QueryRowContext(ctx, query).Scan(&version, &data); err != nil {
		return restaurantCatalog{}, err
	}
	var catalog restaurantCatalog
	if err := json.Unmarshal(data, &catalog); err != nil {
		return restaurantCatalog{}, err
	}
	if err := normalizeRestaurantCatalogDefaults(&catalog, data); err != nil {
		return restaurantCatalog{}, err
	}
	catalog.Version = version
	return catalog, nil
}

func restaurantDefaultPaymentMethods() map[string][]string {
	return map[string][]string{
		"table":    {"cash_before", "cash_after", "card"},
		"delivery": {"cash_on_delivery", "card"},
		"pickup":   {"card"},
	}
}

// Defaults are applied to absent legacy fields, not to explicit zero/false
// values. The restaurant interface supports Arabic and English; an obsolete
// interface default resolves to Arabic without relabeling merchant content.
// Loading never enables tax, invents a registration number or writes over the
// saved catalog. A subsequent optimistic admin save persists defaults.
func normalizeRestaurantCatalogDefaults(catalog *restaurantCatalog, data []byte) error {
	var stored struct {
		Settings map[string]json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal(data, &stored); err != nil {
		return err
	}
	s := &catalog.Settings
	if !restaurantSupportedLocale(s.DefaultLanguage) {
		s.DefaultLanguage = "ar"
	}
	if _, present := stored.Settings["country"]; !present {
		s.Country = "SA"
	}
	if _, present := stored.Settings["primaryColor"]; !present {
		s.PrimaryColor = restaurantDefaultPrimaryColor
	}
	if _, present := stored.Settings["accentColor"]; !present {
		s.AccentColor = restaurantDefaultAccentColor
	}
	if _, present := stored.Settings["backgroundColor"]; !present {
		s.BackgroundColor = restaurantDefaultBackgroundColor
	}
	if _, present := stored.Settings["taxRateBps"]; !present && s.Country == "SA" {
		s.TaxRateBps = 1500
	}
	if _, present := stored.Settings["paymentMethods"]; !present {
		s.PaymentMethods = restaurantDefaultPaymentMethods()
	}
	return nil
}

func (s *restaurantStore) GetCatalog(ctx context.Context, public bool) (restaurantCatalog, error) {
	catalog, err := loadRestaurantCatalog(ctx, s.db, false)
	if err != nil {
		return restaurantCatalog{}, err
	}
	if public {
		if err := restaurantApplyStockAvailability(ctx, s.db, &catalog); err != nil {
			return restaurantCatalog{}, err
		}
		catalog = publicRestaurantCatalog(catalog)
	}
	return catalog, nil
}

func publicRestaurantCatalog(catalog restaurantCatalog) restaurantCatalog {
	// The public endpoint never publishes an enumerable list of table QR tokens.
	catalog.Tables = nil
	items := make([]restaurantItem, 0, len(catalog.Items))
	for _, item := range catalog.Items {
		if !item.Available {
			continue
		}
		options := make([]restaurantOption, 0, len(item.Options))
		for _, option := range item.Options {
			if option.Available {
				options = append(options, option)
			}
		}
		item.Options = options
		items = append(items, item)
	}
	catalog.Items = items
	return catalog
}

func (s *restaurantStore) SaveCatalog(ctx context.Context, catalog restaurantCatalog) (restaurantCatalog, error) {
	// Old menu-language metadata may survive an unrelated edit. Its identity
	// is verified against the locked stored document below, so a new choice
	// cannot introduce one of the former interface languages.
	if err := validateRestaurantCatalogWithLegacyMenu(catalog, true); err != nil {
		return restaurantCatalog{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantCatalog{}, err
	}
	defer tx.Rollback()
	var version int64
	var oldData []byte
	if err := tx.QueryRowContext(ctx, `SELECT version, document FROM restaurant_catalog WHERE id = 1 FOR UPDATE`).Scan(&version, &oldData); err != nil {
		return restaurantCatalog{}, err
	}
	if catalog.Version != version || version == math.MaxInt64 {
		return restaurantCatalog{}, restaurantFail(409, "catalog_changed")
	}
	if err := restaurantValidateDeliveryZones(ctx, tx, catalog.Settings); err != nil {
		return restaurantCatalog{}, err
	}
	var old restaurantCatalog
	if err := json.Unmarshal(oldData, &old); err != nil {
		return restaurantCatalog{}, err
	}
	if !restaurantSupportedLocale(catalog.Settings.MenuLanguage) && catalog.Settings.MenuLanguage != old.Settings.MenuLanguage {
		return restaurantCatalog{}, restaurantFail(400, "invalid_request")
	}
	// A generic menu/settings save cannot publish or discard an appearance
	// draft. Appearance publication has its own explicit, versioned endpoint.
	catalog.Settings.Brand = old.Settings.Brand
	if err := assignRestaurantTableCodes(&catalog, old); err != nil {
		return restaurantCatalog{}, err
	}
	catalog.Version = version + 1
	// Normalize empty collections so the API consistently emits arrays, not null.
	if catalog.Categories == nil {
		catalog.Categories = []restaurantCategory{}
	}
	if catalog.Items == nil {
		catalog.Items = []restaurantItem{}
	}
	if catalog.Tables == nil {
		catalog.Tables = []restaurantTable{}
	}
	if catalog.Settings.DeliveryAreas == nil {
		catalog.Settings.DeliveryAreas = []string{}
	}
	for i := range catalog.Items {
		if catalog.Items[i].Options == nil {
			catalog.Items[i].Options = []restaurantOption{}
		}
	}
	data, err := json.Marshal(catalog)
	if err != nil {
		return restaurantCatalog{}, err
	}
	if _, err := tx.ExecContext(ctx, `UPDATE restaurant_catalog SET version=$1, document=$2, updated_at=now() WHERE id=1`, catalog.Version, data); err != nil {
		return restaurantCatalog{}, err
	}
	actorID, actorScope := "local-admin", "catalog:update"
	if actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor); ok {
		actorID, actorScope = actor.ID, actor.Scope
	}
	target := restaurantMenuTarget{Kind: "catalog_update"}
	if selected, ok := ctx.Value(restaurantMenuTargetKey{}).(restaurantMenuTarget); ok {
		target = selected
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO restaurant_catalog_audit(version,actor_id,actor_scope,kind,target_id) VALUES($1,$2,$3,$4,$5)", catalog.Version, actorID, actorScope, target.Kind, target.ID); err != nil {
		return restaurantCatalog{}, err
	}
	if err := tx.Commit(); err != nil {
		return restaurantCatalog{}, err
	}
	return catalog, nil
}

func (s *restaurantStore) TableByCode(ctx context.Context, code string) (restaurantTable, error) {
	if !restaurantTableCodePattern.MatchString(code) {
		return restaurantTable{}, restaurantFail(404, "table_not_found")
	}
	catalog, err := s.GetCatalog(ctx, false)
	if err != nil {
		return restaurantTable{}, err
	}
	if !catalog.Settings.TableEnabled {
		return restaurantTable{}, restaurantFail(404, "table_not_found")
	}
	return restaurantTableFromCatalog(catalog, code)
}

func restaurantTableFromCatalog(catalog restaurantCatalog, code string) (restaurantTable, error) {
	if !restaurantTableCodePattern.MatchString(code) {
		return restaurantTable{}, restaurantFail(404, "table_not_found")
	}
	for _, table := range catalog.Tables {
		if table.Active && table.Code == code {
			return table, nil
		}
	}
	return restaurantTable{}, restaurantFail(404, "table_not_found")
}

func assignRestaurantTableCodes(catalog *restaurantCatalog, old restaurantCatalog) error {
	existing := make(map[string]string, len(old.Tables))
	used := make(map[string]bool, len(old.Tables))
	for _, table := range old.Tables {
		existing[table.ID] = table.Code
		used[table.Code] = true
	}
	for i := range catalog.Tables {
		table := &catalog.Tables[i]
		if code, ok := existing[table.ID]; ok {
			// QR links are stable across names, availability and other edits. A
			// client cannot replace a table's secret or transplant another code.
			if table.Code != "" && table.Code != code {
				return restaurantFail(400, "invalid_request")
			}
			table.Code = code
			continue
		}
		if table.Code != "" {
			return restaurantFail(400, "invalid_request")
		}
		for {
			secret := make([]byte, 24)
			if _, err := rand.Read(secret); err != nil {
				return err
			}
			code := base64.RawURLEncoding.EncodeToString(secret)
			if !used[code] {
				table.Code = code
				used[code] = true
				break
			}
		}
	}
	return nil
}

func validateRestaurantCatalog(c restaurantCatalog) error {
	return validateRestaurantCatalogWithLegacyMenu(c, false)
}

func validateRestaurantCatalogWithLegacyMenu(c restaurantCatalog, allowLegacyMenu bool) error {
	invalid := func() error { return restaurantFail(400, "invalid_request") }
	s := c.Settings
	menuLanguageValid := restaurantSupportedLocale(s.MenuLanguage) || allowLegacyMenu && restaurantLegacyMenuLocale(s.MenuLanguage)
	if c.Version < 1 || !restaurantValidText(s.Name, 1, 120) || !restaurantValidText(s.Description, 0, 2000) ||
		!restaurantValidText(s.Address, 0, 1000) || !restaurantValidText(s.Phone, 0, 40) ||
		!restaurantValidText(s.PickupInstructions, 0, 2000) || !restaurantValidText(s.OpeningHours, 0, 1000) ||
		!restaurantValidText(s.PaymentInstructions, 0, 2000) || !restaurantSafeImageURL(s.LogoURL) ||
		!restaurantSupportedCurrency(s.Currency) ||
		!restaurantSupportedLocale(s.DefaultLanguage) || !menuLanguageValid {
		return invalid()
	}
	if !restaurantSupportedCountry(s.Country) || !restaurantColorPattern.MatchString(s.PrimaryColor) ||
		!restaurantColorPattern.MatchString(s.AccentColor) || !restaurantColorPattern.MatchString(s.BackgroundColor) ||
		!restaurantSafeImageURL(s.CoverURL) || s.TaxRateBps < 0 || s.TaxRateBps > 10000 ||
		!restaurantValidText(s.TaxNumber, 0, 80) || strings.ContainsAny(s.TaxNumber, "\r\n\t") || s.TaxEnabled && strings.TrimSpace(s.TaxNumber) == "" ||
		!restaurantValidPaymentMethods(s) {
		return invalid()
	}
	if s.AcceptingOrders && !s.DeliveryEnabled && !s.PickupEnabled && !s.TableEnabled {
		return invalid()
	}
	if s.DeliveryFeeMinor < 0 || s.DeliveryFeeMinor > restaurantMaxMinor || s.DeliveryMinimumMinor < 0 || s.DeliveryMinimumMinor > restaurantMaxMinor ||
		math.IsNaN(s.DeliveryRadiusKm) || math.IsInf(s.DeliveryRadiusKm, 0) || s.DeliveryRadiusKm < 0 || s.DeliveryRadiusKm > 500 ||
		(s.Latitude == nil) != (s.Longitude == nil) || s.DeliveryRadiusKm > 0 && s.Latitude == nil {
		return invalid()
	}
	if s.Latitude != nil && (!restaurantValidCoordinate(*s.Latitude, 90) || !restaurantValidCoordinate(*s.Longitude, 180)) {
		return invalid()
	}
	if len(s.DeliveryAreas) > 100 || len(c.Categories) > 100 || len(c.Items) > 1000 || len(c.Tables) > 500 {
		return invalid()
	}
	areas := make(map[string]bool, len(s.DeliveryAreas))
	for _, area := range s.DeliveryAreas {
		key := strings.ToLower(strings.TrimSpace(area))
		if !restaurantValidText(area, 1, 120) || areas[key] {
			return invalid()
		}
		areas[key] = true
	}
	categories := make(map[string]bool, len(c.Categories))
	for _, category := range c.Categories {
		if !restaurantIDPattern.MatchString(category.ID) || categories[category.ID] || !restaurantValidText(category.Name, 1, 120) || category.Sort < 0 || category.Sort > 10000 {
			return invalid()
		}
		categories[category.ID] = true
	}
	items := make(map[string]bool, len(c.Items))
	for _, item := range c.Items {
		if !restaurantIDPattern.MatchString(item.ID) || items[item.ID] || !categories[item.CategoryID] ||
			!restaurantValidText(item.Name, 1, 160) || !restaurantValidText(item.Description, 0, 2000) ||
			item.PriceMinor < 0 || item.PriceMinor > restaurantMaxMinor || !restaurantSafeImageURL(item.ImageURL) ||
			item.Sort < 0 || item.Sort > 10000 || len(item.Options) > 50 {
			return invalid()
		}
		items[item.ID] = true
		options := make(map[string]bool, len(item.Options))
		for _, option := range item.Options {
			if !restaurantIDPattern.MatchString(option.ID) || options[option.ID] || !restaurantValidText(option.Name, 1, 120) || option.PriceMinor < 0 || option.PriceMinor > restaurantMaxMinor {
				return invalid()
			}
			options[option.ID] = true
		}
	}
	tables := make(map[string]bool, len(c.Tables))
	codes := make(map[string]bool, len(c.Tables))
	for _, table := range c.Tables {
		if !restaurantIDPattern.MatchString(table.ID) || tables[table.ID] || !restaurantValidText(table.Name, 1, 80) ||
			table.Code != "" && (!restaurantTableCodePattern.MatchString(table.Code) || codes[table.Code]) {
			return invalid()
		}
		tables[table.ID] = true
		if table.Code != "" {
			codes[table.Code] = true
		}
	}
	return nil
}

func restaurantValidPaymentMethods(settings restaurantSettings) bool {
	if len(settings.PaymentMethods) != 3 {
		return false
	}
	for _, mode := range []string{"table", "delivery", "pickup"} {
		methods, present := settings.PaymentMethods[mode]
		if !present || methods == nil || len(methods) > 3 {
			return false
		}
		enabled := mode == "table" && settings.TableEnabled || mode == "delivery" && settings.DeliveryEnabled || mode == "pickup" && settings.PickupEnabled
		if enabled && len(methods) == 0 {
			return false
		}
		seen := make(map[string]bool, len(methods))
		for _, method := range methods {
			allowed := method == "card" || mode == "table" && (method == "cash_before" || method == "cash_after") || mode == "delivery" && method == "cash_on_delivery"
			if !allowed || seen[method] {
				return false
			}
			seen[method] = true
		}
	}
	return true
}

func restaurantSupportedLocale(locale string) bool {
	return locale == "ar" || locale == "en"
}

// These values describe existing merchant-authored content; they are never
// offered as new restaurant-interface or menu-language settings.
func restaurantLegacyMenuLocale(locale string) bool {
	switch locale {
	case "tr", "ps", "fa", "ru", "uk", "fr", "es", "sw", "ha", "ur", "hi":
		return true
	default:
		return false
	}
}

func restaurantSupportedCurrency(currency string) bool {
	switch currency {
	case "SAR", "AED", "USD", "EUR", "GBP", "TRY", "AFN", "IRR", "RUB", "UAH", "XOF", "KES", "NGN", "PKR", "INR", "JPY", "KWD", "BHD", "OMR", "QAR":
		return true
	default:
		return false
	}
}

func restaurantValidText(value string, min, max int) bool {
	if !utf8.ValidString(value) || len(value) > max*4 || utf8.RuneCountInString(value) > max || utf8.RuneCountInString(strings.TrimSpace(value)) < min {
		return false
	}
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			return false
		}
	}
	return true
}

func restaurantValidCoordinate(value, bound float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= -bound && value <= bound
}

func restaurantSafeImageURL(raw string) bool {
	if raw == "" {
		return true
	}
	if len(raw) > 2048 || strings.TrimSpace(raw) != raw || strings.ContainsAny(raw, "\\\r\n\t") {
		return false
	}
	if strings.HasPrefix(raw, "/") {
		return restaurantLocalImagePattern.MatchString(raw)
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Hostname() == "" || u.User != nil || u.Fragment != "" || u.Opaque != "" {
		return false
	}
	// These URLs are rendered as images only; the server never fetches them.
	// Explicit SVG paths are excluded alongside all data/javascript/file URLs.
	path := strings.ToLower(u.Path)
	return !strings.HasSuffix(path, ".svg") && !strings.HasSuffix(path, ".svgz")
}

func newRestaurantDemoCatalog() (restaurantCatalog, error) {
	catalog := restaurantCatalog{
		Version: 1,
		Settings: restaurantSettings{
			Name: "مطعم المائدة — نسخة تجريبية", Description: "منيو تجريبي قابل للتعديل. هذه ليست بيانات مطعم حقيقي.",
			Currency: "SAR", DefaultLanguage: "ar", MenuLanguage: "ar", Demo: true,
			Country: "SA", PrimaryColor: restaurantDefaultPrimaryColor, AccentColor: restaurantDefaultAccentColor, BackgroundColor: restaurantDefaultBackgroundColor,
			TaxRateBps: 1500, PaymentMethods: restaurantDefaultPaymentMethods(),
			AcceptingOrders: true, DeliveryEnabled: true, PickupEnabled: true, TableEnabled: true,
			DeliveryFeeMinor: 1000, DeliveryMinimumMinor: 2500, DeliveryAreas: []string{},
			PickupInstructions:  "نسخة تجريبية: تواصل مع المطعم عند الوصول بعد تفعيل بياناته.",
			PaymentInstructions: "نسخة تجريبية — لا يتم تحصيل أي دفعة عبر الموقع.",
		},
		Categories: []restaurantCategory{{ID: "mains", Name: "الأطباق الرئيسية", Sort: 0}, {ID: "sides", Name: "المقبلات", Sort: 1}, {ID: "drinks", Name: "المشروبات والحلويات", Sort: 2}},
		Items: []restaurantItem{
			{ID: "chicken-kabsa", CategoryID: "mains", Name: "كبسة دجاج", Description: "أرز بسمتي متبل مع دجاج طازج وسلطة جانبية.", PriceMinor: 3200, Available: true, Sort: 0,
				Options: []restaurantOption{{ID: "extra-sauce", Name: "صلصة إضافية", PriceMinor: 0, Available: true}, {ID: "extra-rice", Name: "أرز إضافي", PriceMinor: 600, Available: true}}},
			{ID: "mixed-grill", CategoryID: "mains", Name: "مشاوي مشكلة", Description: "تشكيلة مشاوي مع الخبز والخضار المشوية.", PriceMinor: 5400, Available: true, Sort: 1,
				Options: []restaurantOption{{ID: "no-onion", Name: "بدون بصل", PriceMinor: 0, Available: true}, {ID: "extra-bread", Name: "خبز إضافي", PriceMinor: 300, Available: true}}},
			{ID: "falafel-wrap", CategoryID: "mains", Name: "ساندويتش فلافل", Description: "فلافل مقرمشة مع الخضار والطحينة في خبز طازج.", PriceMinor: 1400, Available: true, Sort: 2,
				Options: []restaurantOption{{ID: "extra-pickles", Name: "مخلل إضافي", PriceMinor: 0, Available: true}}},
			{ID: "hummus", CategoryID: "sides", Name: "حمص بالطحينة", Description: "حمص ناعم مع الطحينة وزيت الزيتون.", PriceMinor: 1200, Available: true, Sort: 0, Options: []restaurantOption{}},
			{ID: "fattoush", CategoryID: "sides", Name: "سلطة فتوش", Description: "خضار طازجة مع السماق والخبز المقرمش.", PriceMinor: 1600, Available: true, Sort: 1, Options: []restaurantOption{}},
			{ID: "lemon-mint", CategoryID: "drinks", Name: "ليمون بالنعناع", Description: "مشروب ليمون منعش مع النعناع.", PriceMinor: 1200, Available: true, Sort: 0,
				Options: []restaurantOption{{ID: "no-sugar", Name: "بدون سكر", PriceMinor: 0, Available: true}}},
			{ID: "water", CategoryID: "drinks", Name: "مياه معدنية", Description: "عبوة مياه معدنية.", PriceMinor: 300, Available: true, Sort: 1, Options: []restaurantOption{}},
			{ID: "kunafa", CategoryID: "drinks", Name: "كنافة", Description: "قطعة كنافة دافئة مع القطر.", PriceMinor: 1800, Available: true, Sort: 2, Options: []restaurantOption{}},
		},
		Tables: []restaurantTable{{ID: "table-1", Name: "طاولة ١", Active: true}, {ID: "table-2", Name: "طاولة ٢", Active: true}, {ID: "table-3", Name: "طاولة ٣", Active: true}},
	}
	if err := assignRestaurantTableCodes(&catalog, restaurantCatalog{}); err != nil {
		return restaurantCatalog{}, err
	}
	if err := validateRestaurantCatalog(catalog); err != nil {
		return restaurantCatalog{}, errors.New("invalid built-in restaurant demonstration catalog")
	}
	return catalog, nil
}
