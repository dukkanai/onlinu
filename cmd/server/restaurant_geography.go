package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

const restaurantGeographyRevision = "7e322945fa9f6d696a54ba3e9038e0e750e9692d"

type restaurantGeographySource struct {
	Name     string `json:"name"`
	Revision string `json:"revision"`
	License  string `json:"license"`
	Notice   string `json:"notice"`
}
type restaurantGeographyRegion struct {
	ID     string `json:"id"`
	NameAr string `json:"nameAr"`
	NameEn string `json:"nameEn"`
}
type restaurantGeographyCity struct {
	ID       string `json:"id"`
	RegionID string `json:"regionId"`
	NameAr   string `json:"nameAr"`
	NameEn   string `json:"nameEn"`
}
type restaurantGeographyDistrict struct {
	ID       string `json:"id"`
	RegionID string `json:"regionId"`
	CityID   string `json:"cityId"`
	NameAr   string `json:"nameAr"`
	NameEn   string `json:"nameEn"`
	Custom   bool   `json:"custom"`
}
type restaurantGeography struct {
	Version   int64                         `json:"version"`
	Source    restaurantGeographySource     `json:"source"`
	Regions   []restaurantGeographyRegion   `json:"regions"`
	Cities    []restaurantGeographyCity     `json:"cities"`
	Districts []restaurantGeographyDistrict `json:"districts"`
}
type restaurantGeographyDistrictInput struct {
	Version int64  `json:"version"`
	ID      string `json:"id,omitempty"`
	CityID  string `json:"cityId"`
	NameAr  string `json:"nameAr"`
	NameEn  string `json:"nameEn"`
}
type restaurantGeographyDistrictResult struct {
	Version  int64                       `json:"version"`
	District restaurantGeographyDistrict `json:"district"`
}

// Source data is read from separate, attributed JSON files, never embedded into
// the Go program or fetched over the network by a running server. Imports retain
// local district additions and name corrections across restarts/source refreshes.
func initRestaurantGeography(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_geography_state (
		id INTEGER PRIMARY KEY CHECK (id=1), version BIGINT NOT NULL CHECK (version>0),
		revision TEXT NOT NULL DEFAULT '', updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
		INSERT INTO restaurant_geography_state(id,version) VALUES (1,1) ON CONFLICT DO NOTHING;
		CREATE TABLE IF NOT EXISTS restaurant_geography_entities (
		id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('region','city','district')),
		parent_id TEXT NOT NULL DEFAULT '', region_id TEXT NOT NULL,
		name_ar TEXT NOT NULL, name_en TEXT NOT NULL, local_name_ar TEXT, local_name_en TEXT,
		is_local BOOLEAN NOT NULL DEFAULT FALSE, active BOOLEAN NOT NULL DEFAULT TRUE);
		CREATE INDEX IF NOT EXISTS restaurant_geography_parent ON restaurant_geography_entities(kind,parent_id);`)
	if err != nil {
		return err
	}
	dir := strings.TrimSpace(os.Getenv("RESTAURANT_GEOGRAPHY_DATA_DIR"))
	if dir == "" {
		return nil
	}
	return restaurantImportGeographyFiles(ctx, db, dir)
}

func restaurantGeographyVersion(ctx context.Context, q restaurantCatalogQueryer, lock bool) (int64, error) {
	query := `SELECT version FROM restaurant_geography_state WHERE id=1`
	if lock {
		query += ` FOR SHARE`
	}
	var version int64
	err := q.QueryRowContext(ctx, query).Scan(&version)
	return version, err
}

// Reads run in a repeatable-read snapshot so collection names, source revision
// and version cannot disagree if an administrator edits during a request.
func (s *restaurantStore) GetGeography(ctx context.Context, kind, regionID, cityID string, coverageOnly bool) (restaurantGeography, error) {
	result := restaurantGeography{Regions: []restaurantGeographyRegion{}, Cities: []restaurantGeographyCity{}, Districts: []restaurantGeographyDistrict{}}
	if kind == "" {
		kind = "regions"
	}
	if kind != "regions" && kind != "cities" && kind != "districts" || kind == "cities" && !restaurantIDPattern.MatchString(regionID) || kind == "districts" && !restaurantIDPattern.MatchString(cityID) {
		return result, restaurantFail(400, "invalid_geography")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	err = tx.QueryRowContext(ctx, `SELECT version,revision FROM restaurant_geography_state WHERE id=1`).Scan(&result.Version, &result.Source.Revision)
	if err != nil {
		return result, err
	}
	result.Source.Name = "homaily/Saudi-Arabia-Regions-Cities-and-Districts"
	result.Source.License = "GPL-2.0"
	result.Source.Notice = "Community dataset; not an official address verification service. Names and coverage may be incomplete or outdated. Local corrections are retained."
	var districtIDs []string
	filter := false
	if coverageOnly {
		catalog, loadErr := loadRestaurantCatalog(ctx, tx, false)
		if loadErr != nil {
			return result, loadErr
		}
		filter = catalog.Settings.DeliveryPricingMode == "district"
		for _, zone := range catalog.Settings.DeliveryZones {
			if zone.Enabled && zone.FeeMinor != nil && *zone.FeeMinor >= 0 && *zone.FeeMinor <= restaurantMaxMinor {
				districtIDs = append(districtIDs, zone.DistrictID)
			}
		}
		if filter && len(districtIDs) == 0 {
			return result, tx.Commit()
		}
	}
	query := `SELECT e.id,e.region_id,e.parent_id,COALESCE(e.local_name_ar,e.name_ar),COALESCE(e.local_name_en,e.name_en),(e.is_local OR e.local_name_ar IS NOT NULL) FROM restaurant_geography_entities e WHERE e.active=TRUE AND e.kind=$1
		AND (e.kind='region' OR EXISTS (SELECT 1 FROM restaurant_geography_entities r WHERE r.id=e.region_id AND r.kind='region' AND r.active=TRUE))
		AND (e.kind<>'district' OR EXISTS (SELECT 1 FROM restaurant_geography_entities c WHERE c.id=e.parent_id AND c.kind='city' AND c.active=TRUE))`
	args := []any{strings.TrimSuffix(kind, "s")}
	if kind == "cities" {
		args[0] = "city"
	}
	if kind == "cities" || kind == "districts" {
		parent := regionID
		if kind == "districts" {
			parent = cityID
		}
		args = append(args, parent)
		query += fmt.Sprintf(" AND e.parent_id=$%d", len(args))
	}
	if filter {
		encoded, _ := json.Marshal(districtIDs)
		args = append(args, string(encoded))
		match := "d.id=e.id"
		if kind == "regions" {
			match = "d.region_id=e.id"
		}
		if kind == "cities" {
			match = "d.parent_id=e.id"
		}
		query += fmt.Sprintf(" AND EXISTS (SELECT 1 FROM restaurant_geography_entities d JOIN restaurant_geography_entities c ON c.id=d.parent_id AND c.kind='city' AND c.active=TRUE WHERE d.kind='district' AND d.active=TRUE AND %s AND d.id IN (SELECT jsonb_array_elements_text($%d::jsonb)))", match, len(args))
	}
	query += ` ORDER BY COALESCE(e.local_name_ar,e.name_ar),e.id`
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return result, err
	}
	defer rows.Close()
	for rows.Next() {
		var id, region, parent, ar, en string
		var custom bool
		if err = rows.Scan(&id, &region, &parent, &ar, &en, &custom); err != nil {
			return result, err
		}
		switch kind {
		case "regions":
			result.Regions = append(result.Regions, restaurantGeographyRegion{id, ar, en})
		case "cities":
			result.Cities = append(result.Cities, restaurantGeographyCity{id, region, ar, en})
		case "districts":
			result.Districts = append(result.Districts, restaurantGeographyDistrict{id, region, parent, ar, en, custom})
		}
	}
	if err = rows.Err(); err != nil {
		return result, err
	}
	if err = rows.Close(); err != nil {
		return result, err
	}
	return result, tx.Commit()
}

func (s *restaurantStore) SaveGeographyDistrict(ctx context.Context, input restaurantGeographyDistrictInput) (restaurantGeographyDistrictResult, error) {
	result := restaurantGeographyDistrictResult{}
	input.NameAr, input.NameEn = strings.TrimSpace(input.NameAr), strings.TrimSpace(input.NameEn)
	if input.Version < 1 || !restaurantIDPattern.MatchString(input.CityID) || input.ID != "" && !restaurantIDPattern.MatchString(input.ID) || input.NameAr == "" || !restaurantOrderText(input.NameAr, 120, false) || !restaurantOrderText(input.NameEn, 120, false) {
		return result, restaurantFail(400, "invalid_geography")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return result, err
	}
	defer tx.Rollback()
	var version int64
	if err = tx.QueryRowContext(ctx, `SELECT version FROM restaurant_geography_state WHERE id=1 FOR UPDATE`).Scan(&version); err != nil {
		return result, err
	}
	if input.Version != version || version == math.MaxInt64 {
		return result, restaurantFail(409, "geography_changed")
	}
	var region string
	err = tx.QueryRowContext(ctx, `SELECT c.region_id FROM restaurant_geography_entities c JOIN restaurant_geography_entities r ON r.id=c.region_id AND r.kind='region' AND r.active=TRUE WHERE c.id=$1 AND c.kind='city' AND c.active=TRUE`, input.CityID).Scan(&region)
	if err == sql.ErrNoRows {
		return result, restaurantFail(400, "invalid_geography")
	}
	if err != nil {
		return result, err
	}
	if input.ID == "" {
		input.ID = "local-d-" + uuid.NewString()
		_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_geography_entities(id,kind,parent_id,region_id,name_ar,name_en,is_local) VALUES ($1,'district',$2,$3,$4,$5,TRUE)`, input.ID, input.CityID, region, input.NameAr, input.NameEn)
	} else {
		var parent string
		err = tx.QueryRowContext(ctx, `SELECT parent_id FROM restaurant_geography_entities WHERE id=$1 AND kind='district' AND active=TRUE`, input.ID).Scan(&parent)
		if err == sql.ErrNoRows || err == nil && parent != input.CityID {
			return result, restaurantFail(400, "invalid_geography")
		}
		if err != nil {
			return result, err
		}
		_, err = tx.ExecContext(ctx, `UPDATE restaurant_geography_entities SET local_name_ar=$1,local_name_en=$2 WHERE id=$3`, input.NameAr, input.NameEn, input.ID)
	}
	if err != nil {
		return result, err
	}
	result.Version = version + 1
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_geography_state SET version=$1,updated_at=now() WHERE id=1`, result.Version); err != nil {
		return result, err
	}
	result.District = restaurantGeographyDistrict{input.ID, region, input.CityID, input.NameAr, input.NameEn, true}
	return result, tx.Commit()
}

type restaurantGeographyRaw struct {
	RegionID   int64  `json:"region_id"`
	CityID     int64  `json:"city_id"`
	DistrictID int64  `json:"district_id"`
	NameAr     string `json:"name_ar"`
	NameEn     string `json:"name_en"`
}
type restaurantGeographyRecord struct{ ID, Kind, Parent, Region, NameAr, NameEn string }

func restaurantLoadGeographyFiles(dir string) ([]restaurantGeographyRecord, error) {
	files := []struct {
		name, hash, kind string
		count            int
	}{
		{"regions_lite.json", "66c7afbb291ac9ba140444e7796e83d8c5a1c4720d6f1e9f87a038ebdc7e3cf7", "region", 13},
		{"cities_lite.json", "faf7a041c454b9cc8ee85e761974f92563170e152e7de4d14928f7e4fe723678", "city", 4581},
		{"districts_lite.json", "87a7540013e0f57d679a4a642994502711107dfae296f6c4badb6f293b7ff679", "district", 3732},
		{"LICENSE", "a45d0bb572ed792ed34627a72621834b3ba92aab6e2cc4e04301dee7a728d753", "", 0},
		{"UPSTREAM-README.md", "ac3529488f5a03a00f48b6f618e0d8d70035cdc9c8946e3621956ad06ca50961", "", 0},
	}
	records := []restaurantGeographyRecord{}
	for _, file := range files {
		path := filepath.Join(dir, file.name)
		info, err := os.Stat(path)
		if err != nil {
			return nil, fmt.Errorf("geography source %s unavailable", file.name)
		}
		if !info.Mode().IsRegular() || info.Size() > 2_000_000 {
			return nil, fmt.Errorf("geography source %s has invalid size/type", file.name)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return nil, fmt.Errorf("geography source %s unreadable", file.name)
		}
		hash := sha256.Sum256(data)
		if hex.EncodeToString(hash[:]) != file.hash {
			return nil, fmt.Errorf("geography source %s checksum mismatch", file.name)
		}
		if file.kind == "" {
			continue
		}
		var rows []restaurantGeographyRaw
		if err = json.Unmarshal(data, &rows); err != nil || len(rows) != file.count {
			return nil, fmt.Errorf("geography source %s invalid records", file.name)
		}
		for _, row := range rows {
			region := "sa-r-" + strconv.FormatInt(row.RegionID, 10)
			record := restaurantGeographyRecord{Kind: file.kind, Region: region, NameAr: restaurantGeographySourceName(row.NameAr), NameEn: restaurantGeographySourceName(row.NameEn)}
			switch file.kind {
			case "region":
				record.ID = region
			case "city":
				record.ID = "sa-c-" + strconv.FormatInt(row.CityID, 10)
				record.Parent = region
			case "district":
				record.ID = "sa-d-" + strconv.FormatInt(row.DistrictID, 10)
				record.Parent = "sa-c-" + strconv.FormatInt(row.CityID, 10)
			}
			records = append(records, record)
		}
	}
	if err := restaurantValidateGeographyRecords(records); err != nil {
		return nil, err
	}
	return records, nil
}

// The pinned upstream file contains a duplicated CRLF-delimited English name
// for district 10502038005. Normalize source whitespace and repeated lines
// after checksum verification; keep the attributed raw files unchanged.
func restaurantGeographySourceName(name string) string {
	parts := []string{}
	seen := map[string]bool{}
	for _, line := range strings.Split(name, "\n") {
		line = strings.Join(strings.Fields(line), " ")
		if line != "" && !seen[line] {
			parts = append(parts, line)
			seen[line] = true
		}
	}
	return strings.Join(parts, " ")
}

func restaurantValidateGeographyRecords(records []restaurantGeographyRecord) error {
	seen := map[string]restaurantGeographyRecord{}
	for _, record := range records {
		if !restaurantIDPattern.MatchString(record.ID) || !restaurantIDPattern.MatchString(record.Region) || strings.TrimSpace(record.NameAr) == "" || !restaurantOrderText(record.NameAr, 120, false) || !restaurantOrderText(record.NameEn, 120, false) {
			return fmt.Errorf("invalid geography record")
		}
		if _, ok := seen[record.ID]; ok {
			return fmt.Errorf("duplicate geography ID")
		}
		seen[record.ID] = record
	}
	for _, record := range records {
		if record.Kind == "region" {
			if record.Parent != "" || record.ID != record.Region {
				return fmt.Errorf("invalid geography region")
			}
			continue
		}
		parent, ok := seen[record.Parent]
		if !ok || parent.Region != record.Region || record.Kind == "city" && parent.Kind != "region" || record.Kind == "district" && parent.Kind != "city" || record.Kind != "city" && record.Kind != "district" {
			return fmt.Errorf("invalid geography hierarchy")
		}
	}
	return nil
}

func restaurantImportGeographyFiles(ctx context.Context, db *sql.DB, dir string) error {
	records, err := restaurantLoadGeographyFiles(dir)
	if err != nil {
		return err
	}
	return restaurantImportGeographyRecords(ctx, db, records, restaurantGeographyRevision)
}

// Records missing from a future source revision become inactive, not deleted.
// Local rows and local name overlays are never overwritten by source updates.
func restaurantImportGeographyRecords(ctx context.Context, db *sql.DB, records []restaurantGeographyRecord, revision string) error {
	if err := restaurantValidateGeographyRecords(records); err != nil {
		return err
	}
	if revision == "" {
		return fmt.Errorf("geography revision required")
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var version int64
	var oldRevision string
	if err = tx.QueryRowContext(ctx, `SELECT version,revision FROM restaurant_geography_state WHERE id=1 FOR UPDATE`).Scan(&version, &oldRevision); err != nil {
		return err
	}
	if oldRevision == revision {
		return tx.Commit()
	}
	if version == math.MaxInt64 {
		return restaurantFail(409, "geography_changed")
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_geography_entities SET active=FALSE WHERE is_local=FALSE`); err != nil {
		return err
	}
	stmt, err := tx.PrepareContext(ctx, `INSERT INTO restaurant_geography_entities(id,kind,parent_id,region_id,name_ar,name_en) VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (id) DO UPDATE SET name_ar=EXCLUDED.name_ar,name_en=EXCLUDED.name_en,active=TRUE
		WHERE restaurant_geography_entities.is_local=FALSE AND restaurant_geography_entities.kind=EXCLUDED.kind
		AND restaurant_geography_entities.parent_id=EXCLUDED.parent_id AND restaurant_geography_entities.region_id=EXCLUDED.region_id`)
	if err != nil {
		return err
	}
	defer stmt.Close()
	for _, record := range records {
		result, execErr := stmt.ExecContext(ctx, record.ID, record.Kind, record.Parent, record.Region, record.NameAr, record.NameEn)
		if execErr != nil {
			return execErr
		}
		changed, execErr := result.RowsAffected()
		if execErr != nil {
			return execErr
		}
		if changed != 1 {
			return fmt.Errorf("geography update attempted to reparent an existing ID")
		}
	}
	if _, err = tx.ExecContext(ctx, `UPDATE restaurant_geography_state SET version=$1,revision=$2,updated_at=now() WHERE id=1`, version+1, revision); err != nil {
		return err
	}
	return tx.Commit()
}
