package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"sort"
	"time"
	_ "time/tzdata"
)

// Intervals belong to one Saudi calendar day and use [start,end) minutes.
// Overnight hours are split at midnight; an exception replaces that whole day.
type restaurantOpeningWindow struct {
	StartMinute int `json:"startMinute"`
	EndMinute   int `json:"endMinute"`
}

func (w *restaurantOpeningWindow) UnmarshalJSON(data []byte) error {
	var input struct {
		StartMinute *int `json:"startMinute"`
		EndMinute   *int `json:"endMinute"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		return err
	}
	if input.StartMinute == nil || input.EndMinute == nil {
		return errors.New("opening interval needs both boundaries")
	}
	w.StartMinute, w.EndMinute = *input.StartMinute, *input.EndMinute
	return nil
}

type restaurantOpeningException struct {
	Date    string                    `json:"date"`
	Windows []restaurantOpeningWindow `json:"windows"`
}

type restaurantOpeningDocument struct {
	Enabled    bool                         `json:"enabled"`
	TimeZone   string                       `json:"timeZone"`
	Weekly     [][]restaurantOpeningWindow  `json:"weekly"`
	Exceptions []restaurantOpeningException `json:"exceptions"`
}

type restaurantOpeningSchedule struct {
	Version int64 `json:"version"`
	restaurantOpeningDocument
}

type restaurantOpeningPatch struct {
	ExpectedVersion int64                        `json:"expectedVersion"`
	Reviewed        bool                         `json:"reviewed"`
	Enabled         *bool                        `json:"enabled"`
	TimeZone        string                       `json:"timeZone"`
	Weekly          [][]restaurantOpeningWindow  `json:"weekly"`
	Exceptions      []restaurantOpeningException `json:"exceptions"`
}

func (s *restaurantOrders) openingTime() time.Time {
	if s.openingNow != nil {
		return s.openingNow()
	}
	return time.Now().UTC()
}

func restaurantRequireOpening(ctx context.Context, q restaurantCatalogQueryer, lock bool, at time.Time) error {
	schedule, err := loadRestaurantOpening(ctx, q, lock)
	if err != nil {
		return err
	}
	open, err := restaurantOpeningAllows(schedule.restaurantOpeningDocument, at)
	if err != nil {
		return err
	}
	if !open {
		return restaurantFail(409, "store_closed")
	}
	return nil
}

type restaurantOpeningStatus struct {
	Version         int64     `json:"version"`
	ScheduleEnabled bool      `json:"scheduleEnabled"`
	WithinHours     *bool     `json:"withinHours"`
	AcceptingOrders bool      `json:"acceptingOrders"`
	TimeZone        string    `json:"timeZone"`
	EvaluatedAt     time.Time `json:"evaluatedAt"`
}

func (s *restaurantOrders) OpeningStatus(ctx context.Context) (restaurantOpeningStatus, error) {
	tx, err := s.store.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelRepeatableRead})
	if err != nil {
		return restaurantOpeningStatus{}, err
	}
	defer tx.Rollback()
	catalog, err := loadRestaurantCatalog(ctx, tx, false)
	if err != nil {
		return restaurantOpeningStatus{}, err
	}
	schedule, err := loadRestaurantOpening(ctx, tx, false)
	if err != nil {
		return restaurantOpeningStatus{}, err
	}
	at := s.openingTime()
	open, err := restaurantOpeningAllows(schedule.restaurantOpeningDocument, at)
	if err != nil {
		return restaurantOpeningStatus{}, err
	}
	result := restaurantOpeningStatus{Version: schedule.Version, ScheduleEnabled: schedule.Enabled,
		AcceptingOrders: catalog.Settings.AcceptingOrders && open, TimeZone: schedule.TimeZone, EvaluatedAt: at.UTC()}
	if schedule.Enabled {
		result.WithinHours = &open
	}
	if err := tx.Commit(); err != nil {
		return restaurantOpeningStatus{}, err
	}
	return result, nil
}

func normalizeRestaurantOpening(input restaurantOpeningDocument) (restaurantOpeningDocument, error) {
	invalid := func() (restaurantOpeningDocument, error) {
		return restaurantOpeningDocument{}, restaurantFail(400, "invalid_request")
	}
	if input.TimeZone != "Asia/Riyadh" || len(input.Weekly) != 7 || len(input.Exceptions) > 64 {
		return invalid()
	}
	normalize := func(windows []restaurantOpeningWindow) ([]restaurantOpeningWindow, bool) {
		if len(windows) > 8 {
			return nil, false
		}
		result := append([]restaurantOpeningWindow{}, windows...)
		sort.Slice(result, func(i, j int) bool { return result[i].StartMinute < result[j].StartMinute })
		for i, window := range result {
			if window.StartMinute < 0 || window.EndMinute > 1440 || window.StartMinute >= window.EndMinute ||
				(i > 0 && result[i-1].EndMinute > window.StartMinute) {
				return nil, false
			}
		}
		return result, true
	}
	result := restaurantOpeningDocument{Enabled: input.Enabled, TimeZone: input.TimeZone,
		Weekly: make([][]restaurantOpeningWindow, 7), Exceptions: []restaurantOpeningException{}}
	for day, windows := range input.Weekly {
		var ok bool
		if result.Weekly[day], ok = normalize(windows); !ok {
			return invalid()
		}
	}
	seen := map[string]bool{}
	for _, exception := range input.Exceptions {
		date, err := time.Parse("2006-01-02", exception.Date)
		if err != nil || len(exception.Date) != 10 || date.Year() < 2000 || seen[exception.Date] {
			return invalid()
		}
		seen[exception.Date] = true
		windows, ok := normalize(exception.Windows)
		if !ok {
			return invalid()
		}
		result.Exceptions = append(result.Exceptions, restaurantOpeningException{exception.Date, windows})
	}
	sort.Slice(result.Exceptions, func(i, j int) bool { return result.Exceptions[i].Date < result.Exceptions[j].Date })
	return result, nil
}

func restaurantOpeningAllows(input restaurantOpeningDocument, at time.Time) (bool, error) {
	document, err := normalizeRestaurantOpening(input)
	if err != nil {
		return false, err
	}
	if !document.Enabled {
		return true, nil // Preserve the existing manual service switch by default.
	}
	location, err := time.LoadLocation(document.TimeZone)
	if err != nil {
		return false, err
	}
	local := at.In(location)
	windows := document.Weekly[int(local.Weekday())] // Sunday=0, Saturday=6.
	date := local.Format("2006-01-02")
	for _, exception := range document.Exceptions {
		if exception.Date == date {
			windows = exception.Windows
			break
		}
	}
	minute := local.Hour()*60 + local.Minute()
	for _, window := range windows {
		if window.StartMinute <= minute && minute < window.EndMinute {
			return true, nil
		}
	}
	return false, nil
}

func initRestaurantOpeningSchedule(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_opening_schedule (
		id INTEGER PRIMARY KEY CHECK(id=1), version BIGINT NOT NULL CHECK(version>0 AND version<=9007199254740991),
		document JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
	); CREATE TABLE IF NOT EXISTS restaurant_opening_schedule_audit (
		version BIGINT PRIMARY KEY, actor_id TEXT NOT NULL, actor_scope TEXT NOT NULL,
		enabled BOOLEAN NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`)
	if err != nil {
		return err
	}
	document, err := normalizeRestaurantOpening(restaurantOpeningDocument{
		TimeZone: "Asia/Riyadh", Weekly: make([][]restaurantOpeningWindow, 7),
	})
	if err != nil {
		return err
	}
	data, err := json.Marshal(document)
	if err != nil {
		return err
	}
	_, err = db.ExecContext(ctx, `INSERT INTO restaurant_opening_schedule(id,version,document)
		VALUES(1,1,$1) ON CONFLICT(id) DO NOTHING`, data)
	return err
}

func loadRestaurantOpening(ctx context.Context, q restaurantCatalogQueryer, lock bool) (restaurantOpeningSchedule, error) {
	query := "SELECT version,document FROM restaurant_opening_schedule WHERE id=1"
	if lock {
		query += " FOR SHARE"
	}
	var result restaurantOpeningSchedule
	var data []byte
	if err := q.QueryRowContext(ctx, query).Scan(&result.Version, &data); err != nil {
		return result, err
	}
	var stored struct {
		Enabled    *bool                        `json:"enabled"`
		TimeZone   string                       `json:"timeZone"`
		Weekly     [][]restaurantOpeningWindow  `json:"weekly"`
		Exceptions []restaurantOpeningException `json:"exceptions"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&stored); err != nil {
		return restaurantOpeningSchedule{}, err
	}
	if stored.Enabled == nil {
		return restaurantOpeningSchedule{}, errors.New("invalid stored opening schedule")
	}
	validated, err := normalizeRestaurantOpening(restaurantOpeningDocument{
		Enabled: *stored.Enabled, TimeZone: stored.TimeZone, Weekly: stored.Weekly, Exceptions: stored.Exceptions,
	})
	if err != nil {
		return restaurantOpeningSchedule{}, errors.New("invalid stored opening schedule")
	}
	result.restaurantOpeningDocument = validated
	return result, nil
}

func (s *restaurantStore) OpeningSchedule(ctx context.Context) (restaurantOpeningSchedule, error) {
	return loadRestaurantOpening(ctx, s.db, false)
}

func (s *restaurantStore) PatchOpeningSchedule(ctx context.Context, patch restaurantOpeningPatch) (restaurantOpeningSchedule, error) {
	actor, ok := ctx.Value(platformStaffActorKey{}).(platformStaffActor)
	if !ok || actor.Scope != "staff:settings:update" || actor.ID == "" || len(actor.ID) > 128 {
		return restaurantOpeningSchedule{}, restaurantFail(403, "forbidden")
	}
	if !patch.Reviewed || patch.Enabled == nil || patch.ExpectedVersion < 1 || patch.ExpectedVersion >= 9007199254740991 {
		return restaurantOpeningSchedule{}, restaurantFail(400, "invalid_request")
	}
	document, err := normalizeRestaurantOpening(restaurantOpeningDocument{
		Enabled: *patch.Enabled, TimeZone: patch.TimeZone, Weekly: patch.Weekly, Exceptions: patch.Exceptions,
	})
	if err != nil {
		return restaurantOpeningSchedule{}, err
	}
	data, err := json.Marshal(document)
	if err != nil {
		return restaurantOpeningSchedule{}, err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return restaurantOpeningSchedule{}, err
	}
	defer tx.Rollback()
	var version int64
	err = tx.QueryRowContext(ctx, `UPDATE restaurant_opening_schedule SET document=$1,version=version+1,updated_at=now()
		WHERE id=1 AND version=$2 RETURNING version`, data, patch.ExpectedVersion).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return restaurantOpeningSchedule{}, restaurantFail(409, "conflict")
	}
	if err != nil {
		return restaurantOpeningSchedule{}, err
	}
	if _, err = tx.ExecContext(ctx, `INSERT INTO restaurant_opening_schedule_audit(version,actor_id,actor_scope,enabled)
		VALUES($1,$2,$3,$4)`, version, actor.ID, actor.Scope, document.Enabled); err != nil {
		return restaurantOpeningSchedule{}, err
	}
	if err = tx.Commit(); err != nil {
		return restaurantOpeningSchedule{}, err
	}
	return restaurantOpeningSchedule{Version: version, restaurantOpeningDocument: document}, nil
}
