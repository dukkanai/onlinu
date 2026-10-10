//go:build linux

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/color"
	"image/jpeg"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"
)

// These helpers are a bounded synthetic acceptance oracle, not a production
// backup/restore command. They accept only directories created by this test.
// The tighter size/count limits describe this fixture, not the upload API.
const restaurantRecoveryMediaFileLimit = 64 << 10
const restaurantRecoveryMediaCountLimit = 32

type restaurantRecoveryMediaDigest struct {
	Size int
	Hash [sha256.Size]byte
}

func restaurantRecoveryMediaRead(root, name string) ([]byte, error) {
	if !restaurantImageName.MatchString(name) {
		return nil, errors.New("synthetic media name is not an upload filename")
	}
	path := filepath.Join(root, name)
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > restaurantRecoveryMediaFileLimit {
		return nil, errors.New("synthetic media is missing, nonregular or oversized")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errors.New("cannot open synthetic media")
	}
	actual, statErr := file.Stat()
	if statErr != nil || !actual.Mode().IsRegular() || !os.SameFile(before, actual) {
		_ = file.Close()
		return nil, errors.New("synthetic media identity changed")
	}
	data, readErr := io.ReadAll(io.LimitReader(file, restaurantRecoveryMediaFileLimit+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(data) > restaurantRecoveryMediaFileLimit {
		return nil, errors.New("cannot read bounded synthetic media")
	}
	digest := sha256.Sum256(data)
	if hex.EncodeToString(digest[:]) != strings.TrimSuffix(name, filepath.Ext(name)) {
		return nil, errors.New("synthetic media content differs from its upload hash")
	}
	return data, nil
}

func restaurantRecoveryMediaInventory(root string) (map[string]restaurantRecoveryMediaDigest, error) {
	info, err := os.Lstat(root)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("synthetic media root must be a directory without a symlink")
	}
	directory, err := os.Open(root)
	if err != nil {
		return nil, errors.New("cannot open synthetic media directory")
	}
	actual, statErr := directory.Stat()
	if statErr != nil || !actual.IsDir() || !os.SameFile(info, actual) {
		_ = directory.Close()
		return nil, errors.New("synthetic media directory identity changed")
	}
	entries, readErr := directory.ReadDir(restaurantRecoveryMediaCountLimit + 1)
	closeErr := directory.Close()
	if (readErr != nil && !errors.Is(readErr, io.EOF)) || closeErr != nil || len(entries) > restaurantRecoveryMediaCountLimit {
		return nil, errors.New("cannot enumerate bounded synthetic media")
	}
	out := make(map[string]restaurantRecoveryMediaDigest, len(entries))
	for _, entry := range entries {
		data, err := restaurantRecoveryMediaRead(root, entry.Name())
		if err != nil {
			return nil, err
		}
		out[entry.Name()] = restaurantRecoveryMediaDigest{Size: len(data), Hash: sha256.Sum256(data)}
	}
	return out, nil
}

func restaurantRecoveryMediaCopy(source, target string) error {
	sourceInfo, sourceErr := os.Lstat(source)
	targetInfo, targetErr := os.Lstat(target)
	if sourceErr != nil || targetErr != nil || !sourceInfo.IsDir() || !targetInfo.IsDir() ||
		sourceInfo.Mode()&os.ModeSymlink != 0 || targetInfo.Mode()&os.ModeSymlink != 0 || os.SameFile(sourceInfo, targetInfo) {
		return errors.New("synthetic media copy requires independent directories")
	}
	entries, err := os.ReadDir(target)
	if err != nil || len(entries) != 0 {
		return errors.New("synthetic media copy refuses a nonempty destination")
	}
	before, err := restaurantRecoveryMediaInventory(source)
	if err != nil || len(before) == 0 {
		return errors.New("synthetic media copy requires a valid nonempty source")
	}
	for name, digest := range before {
		data, err := restaurantRecoveryMediaRead(source, name)
		if err != nil || digest != (restaurantRecoveryMediaDigest{Size: len(data), Hash: sha256.Sum256(data)}) {
			return errors.New("synthetic media source changed during copy")
		}
		file, err := os.OpenFile(filepath.Join(target, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return errors.New("cannot exclusively create restored synthetic media")
		}
		_, writeErr := file.Write(data)
		syncErr, closeErr := file.Sync(), file.Close()
		if writeErr != nil || syncErr != nil || closeErr != nil {
			return errors.New("cannot persist restored synthetic media")
		}
	}
	after, err := restaurantRecoveryMediaInventory(target)
	if err != nil || !reflect.DeepEqual(before, after) {
		return errors.New("restored synthetic media inventory differs")
	}
	return nil
}

func restaurantRecoveryMediaReferences(catalog restaurantCatalog, state restaurantBrandState, previous *restaurantBrand) map[string]string {
	refs := map[string]string{"settings.logo": catalog.Settings.LogoURL, "settings.cover": catalog.Settings.CoverURL}
	brand := func(prefix string, b *restaurantBrand) {
		if b != nil {
			refs[prefix+".logo"], refs[prefix+".cover"], refs[prefix+".intro"] = b.LogoURL, b.CoverURL, b.IntroImageURL
		}
	}
	brand("catalog.brand", catalog.Settings.Brand)
	brand("brand.live", &state.Live)
	brand("brand.draft", state.Draft)
	brand("brand.previous", previous)
	for _, item := range catalog.Items {
		// Include unavailable items. Their media is still needed after recovery.
		refs["item."+item.ID] = item.ImageURL
	}
	return refs
}

func restaurantRecoveryMediaCheckReferences(refs map[string]string, inventory map[string]restaurantRecoveryMediaDigest) error {
	for _, value := range refs {
		if !restaurantSafeImageURL(value) {
			return errors.New("synthetic media reference is unsafe")
		}
		if value == "" || strings.HasPrefix(value, "https://") {
			// Preserve external references without fetching third-party content.
			continue
		}
		name := strings.TrimPrefix(value, "/restaurant-media/")
		if !restaurantImageName.MatchString(name) {
			return errors.New("synthetic reference is not an uploader-generated URL")
		}
		if _, present := inventory[name]; !present {
			return errors.New("synthetic media reference has no restored file")
		}
	}
	return nil
}

func restaurantRecoveryMediaUpload(t *testing.T, h http.Handler, master string, index int) string {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 5, 5))
	for y := 0; y < 5; y++ {
		for x := 0; x < 5; x++ {
			picture.Set(x, y, color.RGBA{R: uint8(20 + index*21), G: uint8(x * 40), B: uint8(y * 40), A: 255})
		}
	}
	var input bytes.Buffer
	var err error
	if index%2 == 0 {
		err = png.Encode(&input, picture)
	} else {
		err = jpeg.Encode(&input, picture, &jpeg.Options{Quality: 95})
	}
	if err != nil {
		t.Fatal("cannot encode synthetic upload")
	}
	input.WriteString("SYNTHETIC-METADATA-TRAILER")
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("image", "synthetic-image")
	if err != nil {
		t.Fatal("cannot create synthetic multipart upload")
	}
	if _, err := part.Write(input.Bytes()); err != nil || writer.Close() != nil {
		t.Fatal("cannot finish synthetic multipart upload")
	}
	request := httptest.NewRequest(http.MethodPost, "https://restaurant.example/api/restaurant/images", &body)
	request.Header.Set("X-API-Key", master)
	request.Header.Set("Origin", "https://restaurant.example")
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	h.ServeHTTP(response, request)
	var uploaded map[string]string
	if response.Code != http.StatusCreated || json.Unmarshal(response.Body.Bytes(), &uploaded) != nil || !strings.HasPrefix(uploaded["url"], "/restaurant-media/") {
		t.Fatal("synthetic authenticated image upload failed")
	}
	data, err := restaurantRecoveryMediaRead(restaurantMediaDir(), strings.TrimPrefix(uploaded["url"], "/restaurant-media/"))
	if err != nil || bytes.Contains(data, []byte("SYNTHETIC-METADATA-TRAILER")) {
		t.Fatal("synthetic upload is not normalized and content-addressed")
	}
	return uploaded["url"]
}

func restaurantRecoveryMediaState(t *testing.T, db *sql.DB) (restaurantCatalog, restaurantBrandState, *restaurantBrand) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	tx, err := db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelRepeatableRead, ReadOnly: true})
	if err != nil {
		t.Fatal("cannot open synthetic media reference snapshot")
	}
	defer tx.Rollback()
	catalog, err := loadRestaurantCatalog(ctx, tx, false)
	if err != nil {
		t.Fatal("cannot read synthetic catalog references")
	}
	state, previous, err := readRestaurantBrandState(ctx, tx, catalog, false)
	if err != nil || tx.Commit() != nil {
		t.Fatal("cannot read synthetic brand references")
	}
	return catalog, state, previous
}

func TestRestaurantKeyRecoveryMedia(t *testing.T) {
	bin, share := restaurantRecoveryPostgres(t)
	t.Setenv("RESTAURANT_GEOGRAPHY_DATA_DIR", "")
	t.Setenv("WACALLS_PUBLIC_BASE_URL", "https://restaurant.example")
	master := hex.EncodeToString(restaurantRecoveryBytes(t, 24))
	t.Setenv("WACALLS_API_KEY", master)
	source, target := restaurantRecoveryStartCluster(t, bin, share), restaurantRecoveryStartCluster(t, bin, share)
	if source.identity == target.identity || source.port == target.port || source.data == target.data {
		t.Fatal("media recovery requires independently owned PostgreSQL clusters")
	}
	namespace := "recovery_" + hex.EncodeToString(restaurantRecoveryBytes(t, 12))
	database := namespace + "_main"
	sourceDB := source.createDatabase(t, database)
	sourceRoot, targetRoot := t.TempDir(), t.TempDir()
	runtime := &restaurantRecoveryRuntime{root: t.TempDir(), namespace: namespace,
		store: "synthetic-" + hex.EncodeToString(restaurantRecoveryBytes(t, 12)), master: master, mediaRoot: sourceRoot}
	key := restaurantRecoveryBytes(t, 32)
	keys := map[string][]byte{"media-recovery": key}
	ring := restaurantTestKeyring(t, runtime.store, "media-recovery", keys)
	ringJSON := restaurantTestKeyringJSON(t, runtime.store, "media-recovery", keys)
	ringFile := restaurantRecoveryFile(t, runtime.root, "media-keyring", ringJSON)
	runtime.private = []string{string(ringJSON), base64.StdEncoding.EncodeToString(key)}
	// Initialize through actual external-v1 main, never legacy key constructors.
	runtime.run(t, source, ringFile, "init", false, true)
	runtime.run(t, source, ringFile, "", true, true)
	ciphers := restaurantRecoveryCiphers(t, sourceDB, database, ring)
	payload := restaurantRecoverySeed(t, sourceDB, ciphers)
	runtime.private = append(runtime.private, payload.receipt.TrackingToken, payload.receipt.AccessCode, payload.config.Secrets["secretKey"])
	store := &restaurantStore{db: sourceDB}
	accounts := &restaurantAccounts{db: sourceDB}
	orders := &restaurantOrders{store: store, seal: ciphers.orders}
	sourceHandler := (&server{restaurant: store, customers: accounts, orders: orders}).routes()
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	t.Setenv("WACALLS_MEDIA_DIR", sourceRoot)
	sourceMedia := restaurantMediaDir()
	urls := make([]string, 10)
	for i := range urls {
		urls[i] = restaurantRecoveryMediaUpload(t, sourceHandler, master, i)
	}
	catalog, state, _ := restaurantRecoveryMediaState(t, sourceDB)
	var err error
	catalog.Settings.LogoURL, catalog.Settings.CoverURL = urls[0], urls[1]
	catalog.Items[0].ImageURL = urls[2]
	catalog.Items[1].ImageURL, catalog.Items[1].Available = urls[3], false
	catalog.Items[2].ImageURL = "https://synthetic.invalid/external.png"
	if _, err := store.SaveCatalog(ctx, catalog); err != nil {
		t.Fatal("cannot persist synthetic menu media references")
	}
	// Two publications retain a previous-only image, plus a separate unpublished
	// appearance draft. urls[9] stays unreferenced but must still copy.
	for _, selection := range [][2]int{{0, 4}, {5, 6}} {
		catalog, state, _ = restaurantRecoveryMediaState(t, sourceDB)
		brand := restaurantEffectiveBrand(catalog.Settings)
		brand.LogoURL, brand.CoverURL, brand.IntroImageURL = urls[selection[0]], urls[1], urls[selection[1]]
		state, err = store.SaveBrandDraft(ctx, state.Version, brand)
		if err != nil {
			t.Fatal("cannot persist synthetic appearance draft")
		}
		if _, err = store.PublishBrand(ctx, state.Version, false); err != nil {
			t.Fatal("cannot publish synthetic appearance")
		}
	}
	_, state, _ = restaurantRecoveryMediaState(t, sourceDB)
	draft := state.Live
	draft.LogoURL, draft.IntroImageURL = urls[7], urls[8]
	if _, err = store.SaveBrandDraft(ctx, state.Version, draft); err != nil {
		t.Fatal("cannot retain synthetic private appearance draft")
	}
	catalog, state, previous := restaurantRecoveryMediaState(t, sourceDB)
	refs := restaurantRecoveryMediaReferences(catalog, state, previous)
	inventory, err := restaurantRecoveryMediaInventory(sourceMedia)
	if err != nil || len(inventory) != len(urls) || restaurantRecoveryMediaCheckReferences(refs, inventory) != nil {
		t.Fatal("synthetic source media and references are inconsistent")
	}
	before := restaurantRecoveryFingerprint(t, sourceDB)
	pgEnv := append(restaurantRecoveryEnvironment(source.root, bin), "PGPASSWORD="+source.password)
	archive := restaurantRecoveryCommand(t, filepath.Join(bin, "pg_dump"), pgEnv, nil, restaurantRecoveryArchiveLimit, nil,
		"-h", "127.0.0.1", "-p", strconv.Itoa(source.port), "-U", "onlinu_fixture", "-d", database, "--format=custom", "--no-owner", "--no-acl")
	if !bytes.HasPrefix(archive, []byte("PGDMP")) || len(archive) <= 5 {
		t.Fatal("unexpected synthetic media database archive format")
	}
	targetDB := target.createDatabase(t, database)
	pgEnv = append(restaurantRecoveryEnvironment(target.root, bin), "PGPASSWORD="+target.password)
	restaurantRecoveryCommand(t, filepath.Join(bin, "pg_restore"), pgEnv, archive, 256<<10, nil,
		"-h", "127.0.0.1", "-p", strconv.Itoa(target.port), "-U", "onlinu_fixture", "-d", database, "--exit-on-error", "--no-owner", "--no-acl")
	if !reflect.DeepEqual(before, restaurantRecoveryFingerprint(t, targetDB)) {
		t.Fatal("restored synthetic media database relations differ")
	}
	restoredCatalog, restoredState, restoredPrevious := restaurantRecoveryMediaState(t, targetDB)
	restoredRefs := restaurantRecoveryMediaReferences(restoredCatalog, restoredState, restoredPrevious)
	if !reflect.DeepEqual(catalog, restoredCatalog) || !reflect.DeepEqual(state, restoredState) || !reflect.DeepEqual(previous, restoredPrevious) || !reflect.DeepEqual(refs, restoredRefs) {
		t.Fatal("restored catalog, private draft or previous appearance differs")
	}
	t.Setenv("WACALLS_MEDIA_DIR", targetRoot)
	targetMedia := restaurantMediaDir()
	if err := os.Mkdir(targetMedia, 0700); err != nil {
		t.Fatal("cannot create independently owned empty media destination")
	}
	targetStore := &restaurantStore{db: targetDB}
	targetHandler := (&server{restaurant: targetStore, customers: &restaurantAccounts{db: targetDB}, orders: &restaurantOrders{store: targetStore}}).routes()
	if restaurantRecoveryMediaCheckReferences(restoredRefs, map[string]restaurantRecoveryMediaDigest{}) == nil ||
		restaurantHTTPRequest(t, targetHandler, "GET", urls[0], nil, nil, nil).Code != http.StatusNotFound {
		t.Fatal("database-only recovery incorrectly satisfied local media references")
	}
	if err := restaurantRecoveryMediaCopy(sourceMedia, targetMedia); err != nil {
		t.Fatal(err)
	}
	runtime.mediaRoot = targetRoot
	runtime.run(t, target, ringFile, "verify", false, true)
	runtime.run(t, target, ringFile, "", true, true)
	restaurantRecoveryCheckPayload(t, targetDB, restaurantRecoveryCiphers(t, targetDB, database, ring), payload)
	restoredInventory, err := restaurantRecoveryMediaInventory(targetMedia)
	if err != nil || !reflect.DeepEqual(inventory, restoredInventory) || restaurantRecoveryMediaCheckReferences(restoredRefs, restoredInventory) != nil {
		t.Fatal("copied media and restored references are inconsistent")
	}
	for _, path := range urls {
		name := strings.TrimPrefix(path, "/restaurant-media/")
		response := restaurantHTTPRequest(t, targetHandler, "GET", path, nil, nil, nil)
		wantType := "image/png"
		if strings.HasSuffix(name, ".jpg") {
			wantType = "image/jpeg"
		}
		if response.Code != http.StatusOK || response.Header().Get("Content-Type") != wantType || response.Header().Get("X-Content-Type-Options") != "nosniff" ||
			response.Header().Get("Cache-Control") != "public, max-age=31536000, immutable" || response.Header().Get("Content-Security-Policy") != "default-src 'none'; sandbox" ||
			(restaurantRecoveryMediaDigest{Size: response.Body.Len(), Hash: sha256.Sum256(response.Body.Bytes())}) != inventory[name] {
			t.Fatal("restored image response differs from normalized upload")
		}
		a, errA := os.Stat(filepath.Join(sourceMedia, name))
		b, errB := os.Stat(filepath.Join(targetMedia, name))
		if errA != nil || errB != nil || os.SameFile(a, b) {
			t.Fatal("restored media is not an independent file copy")
		}
	}
	admin := map[string]string{"X-API-Key": master}
	gotCatalog := restaurantDecodeResponse[restaurantCatalog](t, restaurantHTTPRequest(t, targetHandler, "GET", "/api/restaurant/catalog", nil, admin, nil), 200)
	gotBrand := restaurantDecodeResponse[restaurantBrandState](t, restaurantHTTPRequest(t, targetHandler, "GET", "/api/restaurant/brand", nil, admin, nil), 200)
	publicResponse := restaurantHTTPRequest(t, targetHandler, "GET", "/storefront-api/catalog", nil, nil, nil)
	gotPublic := restaurantDecodeResponse[restaurantCatalog](t, publicResponse, 200)
	if !reflect.DeepEqual(gotCatalog, catalog) || !reflect.DeepEqual(gotBrand, state) ||
		gotPublic.Version != catalog.Version || !reflect.DeepEqual(gotPublic.Settings, catalog.Settings) || !reflect.DeepEqual(gotPublic.Categories, catalog.Categories) ||
		len(gotPublic.Tables) != 0 || len(gotPublic.Items) != len(catalog.Items)-1 {
		t.Fatal("restored public/admin media references or draft isolation differ")
	}
	// The expected visible item set is fixture-defined, independent of the
	// production publicRestaurantCatalog filter. Only item index 1 was hidden.
	wantItem := 0
	for _, gotItem := range gotPublic.Items {
		if wantItem == 1 {
			wantItem++
		}
		if !reflect.DeepEqual(gotItem, catalog.Items[wantItem]) {
			t.Fatal("restored public menu item set differs from the synthetic visible set")
		}
		wantItem++
	}
	if state.Draft == nil || previous == nil || state.Draft.LogoURL != urls[7] || state.Draft.IntroImageURL != urls[8] || previous.IntroImageURL != urls[4] {
		t.Fatal("synthetic private appearance reference markers are missing")
	}
	// Untyped JSON inspection catches disclosure in new fields that a typed
	// decoder would silently discard. These references are private in the
	// catalog, while a known content-hash media URL remains publicly served.
	var rawPublic map[string]any
	if json.Unmarshal(publicResponse.Body.Bytes(), &rawPublic) != nil || len(rawPublic) != 4 {
		t.Fatal("restored public catalog has unexpected top-level fields")
	}
	for _, field := range []string{"version", "settings", "categories", "items"} {
		if _, exists := rawPublic[field]; !exists {
			t.Fatal("restored public catalog is missing a public contract field")
		}
	}
	forbidden := map[string]bool{catalog.Items[1].ID: true, urls[3]: true, urls[4]: true, urls[7]: true, urls[8]: true}
	for _, table := range catalog.Tables {
		forbidden[table.Code] = true
	}
	seen := make(map[string]bool)
	var inspect func(any)
	inspect = func(value any) {
		switch value := value.(type) {
		case map[string]any:
			for key, child := range value {
				if key == "draft" || key == "previous" {
					t.Fatal("restored public catalog exposed a private appearance field")
				}
				inspect(child)
			}
		case []any:
			for _, child := range value {
				inspect(child)
			}
		case string:
			if forbidden[value] {
				t.Fatal("restored public catalog exposed a hidden item, private appearance reference or table code")
			}
			seen[value] = true
		}
	}
	inspect(rawPublic)
	for _, value := range []string{urls[0], urls[1], urls[2], urls[5], urls[6], "https://synthetic.invalid/external.png"} {
		if !seen[value] {
			t.Fatal("restored public catalog omitted an expected live media reference")
		}
	}
	// Missing a draft-only image must fail completeness even though the public
	// catalog remains readable. Restore only this newly owned synthetic file.
	missingName := strings.TrimPrefix(urls[8], "/restaurant-media/")
	missingPath := filepath.Join(targetMedia, missingName)
	missingData, err := restaurantRecoveryMediaRead(targetMedia, missingName)
	if err != nil || os.Remove(missingPath) != nil {
		t.Fatal("cannot prepare owned missing-media negative")
	}
	incomplete, err := restaurantRecoveryMediaInventory(targetMedia)
	if err != nil || restaurantRecoveryMediaCheckReferences(restoredRefs, incomplete) == nil ||
		restaurantHTTPRequest(t, targetHandler, "GET", urls[8], nil, nil, nil).Code != http.StatusNotFound {
		t.Fatal("missing draft-only media was not detected")
	}
	restaurantRecoveryFile(t, targetMedia, missingName, missingData)
	// The runtime currently trusts upload-hash filenames. Its serving handler
	// does not re-hash files: only this acceptance oracle detects tampering.
	tampered := bytes.Clone(missingData)
	tampered[len(tampered)-1] ^= 1
	if err := os.WriteFile(missingPath, tampered, 0600); err != nil {
		t.Fatal("cannot prepare owned tampered-media negative")
	}
	if _, err := restaurantRecoveryMediaInventory(targetMedia); err == nil {
		t.Fatal("tampered media passed acceptance verification")
	}
	if err := os.WriteFile(missingPath, missingData, 0600); err != nil {
		t.Fatal("cannot restore owned synthetic negative fixture")
	}
	// A real owned file outside restaurant-images makes the traversal refusal
	// observable. Go's ServeMux redirects a raw dot segment before routing;
	// encoded separators reach the image route and must be refused there.
	marker := []byte("SYNTHETIC-OUTSIDE-MEDIA-SENTINEL")
	restaurantRecoveryFile(t, targetRoot, "outside.png", marker)
	for _, row := range []struct {
		path string
		code int
	}{
		{"/restaurant-media/../outside.png", http.StatusTemporaryRedirect},
		{"/restaurant-media/%2e%2e%2foutside.png", http.StatusNotFound},
		{"/restaurant-media/nested/outside.png", http.StatusNotFound},
		{"/restaurant-media/..%5coutside.png", http.StatusNotFound},
	} {
		response := restaurantHTTPRequest(t, targetHandler, "GET", row.path, nil, nil, nil)
		if response.Code != row.code || bytes.Contains(response.Body.Bytes(), marker) {
			t.Fatalf("synthetic traversal case %q status=%d want=%d", row.path, response.Code, row.code)
		}
		if row.code == http.StatusTemporaryRedirect {
			if response.Header().Get("Location") != "/outside.png" {
				t.Fatal("unexpected media traversal canonical redirect")
			}
			follow := restaurantHTTPRequest(t, targetHandler, "GET", "/outside.png", nil, nil, nil)
			if follow.Code != http.StatusNotFound || bytes.Contains(follow.Body.Bytes(), marker) {
				t.Fatal("canonical media traversal redirect exposed an outside file")
			}
		}
	}
	// Exercise actual validation without accepting unsafe catalog/brand writes.
	badCatalog := catalog
	badCatalog.Settings.LogoURL = "/restaurant-media/../outside.png"
	if restaurantHTTPRequest(t, targetHandler, "PUT", "/api/restaurant/catalog", badCatalog, admin, nil).Code != http.StatusBadRequest {
		t.Fatal("unsafe restored catalog reference was accepted")
	}
	badDraft := draft
	badDraft.IntroImageURL = "/restaurant-media/../outside.png"
	if restaurantHTTPRequest(t, targetHandler, "PUT", "/api/restaurant/brand/draft", map[string]any{"version": state.Version, "brand": badDraft}, admin, nil).Code != http.StatusBadRequest {
		t.Fatal("unsafe restored brand reference was accepted")
	}
	afterSource, sourceErr := restaurantRecoveryMediaInventory(sourceMedia)
	afterTarget, targetErr := restaurantRecoveryMediaInventory(targetMedia)
	if sourceErr != nil || targetErr != nil || !reflect.DeepEqual(inventory, afterSource) || !reflect.DeepEqual(inventory, afterTarget) ||
		!reflect.DeepEqual(before, restaurantRecoveryFingerprint(t, sourceDB)) || !reflect.DeepEqual(before, restaurantRecoveryFingerprint(t, targetDB)) {
		t.Fatal("media recovery or negative checks changed source, references or restored content")
	}
	t.Logf("Synthetic media recovery passed: files=%d referenceFields=%d databaseRelations=%d archiveBytes=%d archiveSHA256=%x; external-v1 cold startup, encrypted payloads/fences, independent copies, public/admin references, draft/previous media, missing/tampered detection and traversal refusal verified", len(inventory), len(refs), len(before), len(archive), sha256.Sum256(archive))
}

func TestRestaurantKeyRecoveryMediaGuards(t *testing.T) {
	good := []byte("synthetic content-addressed guard fixture")
	digest := sha256.Sum256(good)
	name := hex.EncodeToString(digest[:]) + ".png"
	freshSource := func(t *testing.T) string {
		t.Helper()
		root := t.TempDir()
		restaurantRecoveryFile(t, root, name, good)
		return root
	}
	t.Run("independent-empty-destination", func(t *testing.T) {
		source, target := freshSource(t), t.TempDir()
		if restaurantRecoveryMediaCopy(source, source) == nil || restaurantRecoveryMediaCopy(source, target) != nil || restaurantRecoveryMediaCopy(source, target) == nil {
			t.Fatal("media copy ownership/empty destination guards differ")
		}
	})
	for _, kind := range []string{"tampered", "symlink-file", "nested-directory", "oversized", "unexpected-name", "too-many-files"} {
		t.Run(kind, func(t *testing.T) {
			source, target := freshSource(t), t.TempDir()
			switch kind {
			case "tampered":
				if os.WriteFile(filepath.Join(source, name), []byte("changed"), 0600) != nil {
					t.Fatal("cannot prepare tamper fixture")
				}
			case "symlink-file":
				if os.Remove(filepath.Join(source, name)) != nil || os.Symlink(filepath.Join(freshSource(t), name), filepath.Join(source, name)) != nil {
					t.Fatal("cannot prepare symlink fixture")
				}
			case "nested-directory":
				if os.Mkdir(filepath.Join(source, "nested"), 0700) != nil {
					t.Fatal("cannot prepare directory fixture")
				}
			case "oversized":
				if os.WriteFile(filepath.Join(source, name), make([]byte, restaurantRecoveryMediaFileLimit+1), 0600) != nil {
					t.Fatal("cannot prepare size fixture")
				}
			case "unexpected-name":
				restaurantRecoveryFile(t, source, ".upload-incomplete", good)
			case "too-many-files":
				for i := 0; i < restaurantRecoveryMediaCountLimit; i++ {
					restaurantRecoveryFile(t, source, "extra-"+strconv.Itoa(i), good)
				}
			}
			if restaurantRecoveryMediaCopy(source, target) == nil {
				t.Fatal("invalid media source was accepted")
			}
			entries, err := os.ReadDir(target)
			if err != nil || len(entries) != 0 {
				t.Fatal("refused media copy changed its empty target")
			}
		})
	}
	t.Run("symlink-root", func(t *testing.T) {
		source := freshSource(t)
		link := filepath.Join(t.TempDir(), "linked")
		if os.Symlink(source, link) != nil {
			t.Fatal("cannot prepare root symlink fixture")
		}
		if restaurantRecoveryMediaCopy(link, t.TempDir()) == nil || restaurantRecoveryMediaCopy(source, link) == nil {
			t.Fatal("symlink media root was accepted")
		}
	})
	t.Run("references", func(t *testing.T) {
		inventory, err := restaurantRecoveryMediaInventory(freshSource(t))
		if err != nil {
			t.Fatal("cannot inspect reference guard fixture")
		}
		for _, value := range []string{"/restaurant-media/../outside.png", "/restaurant-media/%2e%2e%2foutside.png", "/restaurant-media/nested/outside.png", "/restaurant-media/..\\outside.png", "/restaurant-media/" + strings.Repeat("0", 64) + ".png"} {
			if restaurantRecoveryMediaCheckReferences(map[string]string{"image": value}, inventory) == nil {
				t.Fatal("unsafe or missing media reference passed acceptance")
			}
		}
		if restaurantRecoveryMediaCheckReferences(map[string]string{"image": "/restaurant-media/" + name, "external": "https://synthetic.invalid/photo.png", "empty": ""}, inventory) != nil {
			t.Fatal("valid bounded media references rejected")
		}
	})
}
