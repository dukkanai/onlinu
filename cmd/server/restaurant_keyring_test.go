package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// All key material here is synthetic and exists only in test memory or owned
// temporary files. No real keyring, database, provider or process environment is
// read. Fixtures are deliberately deterministic, never deployment examples.
func restaurantTestKeyringJSON(t *testing.T, store, active string, keys map[string][]byte) []byte {
	t.Helper()
	entries := make([]map[string]string, 0, len(keys))
	for id, key := range keys {
		entries = append(entries, map[string]string{"id": id, "key": base64.StdEncoding.EncodeToString(key)})
	}
	raw, err := json.Marshal(map[string]any{"version": 1, "storeId": store, "activeKeyId": active, "keys": entries})
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func restaurantTestKeyring(t *testing.T, store, active string, keys map[string][]byte) *restaurantKeyring {
	t.Helper()
	ring, err := parseRestaurantKeyring(restaurantTestKeyringJSON(t, store, active, keys), store)
	if err != nil {
		t.Fatal(err)
	}
	return ring
}

func TestRestaurantKeyringStrictValidation(t *testing.T) {
	encoded := base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{0x31}, 32))
	valid := fmt.Sprintf(`{"version":1,"storeId":"store-a","activeKeyId":"k1","keys":[{"id":"k1","key":"%s"}]}`, encoded)
	if ring, err := parseRestaurantKeyring([]byte(valid+"\r\n"), "store-a"); err != nil || ring == nil {
		t.Fatal("valid keyring rejected", err)
	}
	for name, raw := range map[string]string{
		"empty": "", "null": "null", "array": "[]", "blank": "  ",
		"version":             strings.Replace(valid, `"version":1`, `"version":2`, 1),
		"float-version":       strings.Replace(valid, `"version":1`, `"version":1.0`, 1),
		"null-version":        strings.Replace(valid, `"version":1`, `"version":null`, 1),
		"unknown":             strings.Replace(valid, `"version":1`, `"extra":"PRIVATE_MARKER","version":1`, 1),
		"duplicate":           strings.Replace(valid, `"version":1`, `"version":1,"version":1`, 1),
		"escaped-duplicate":   strings.Replace(valid, `"version":1`, `"version":1,"vers\u0069on":1`, 1),
		"case-field":          strings.Replace(valid, `"version"`, `"Version"`, 1),
		"missing-field":       strings.Replace(valid, `"version":1,`, "", 1),
		"store":               strings.Replace(valid, "store-a", "store-b", 1),
		"empty-store":         strings.Replace(valid, "store-a", "", 1),
		"missing-active":      strings.Replace(valid, `"activeKeyId":"k1"`, `"activeKeyId":"k2"`, 1),
		"blank-id":            strings.ReplaceAll(valid, "k1", " k1"),
		"long-id":             strings.ReplaceAll(valid, "k1", strings.Repeat("x", 65)),
		"unicode-id":          strings.ReplaceAll(valid, "k1", "مفتاح"),
		"control-id":          strings.ReplaceAll(valid, "k1", `k\u0000`),
		"duplicate-key-field": strings.Replace(valid, `"id":"k1"`, `"id":"k1","id":"k1"`, 1),
		"unknown-key-field":   strings.Replace(valid, `"id":"k1"`, `"id":"k1","algorithm":"aes"`, 1),
		"case-key-field":      strings.Replace(valid, `"key":`, `"Key":`, 1),
		"short-key":           strings.Replace(valid, encoded, base64.StdEncoding.EncodeToString(make([]byte, 31)), 1),
		"long-key":            strings.Replace(valid, encoded, base64.StdEncoding.EncodeToString(make([]byte, 33)), 1),
		"unencoded-key":       strings.Replace(valid, encoded, "PRIVATE_MARKER", 1),
		"unpadded-key":        strings.Replace(valid, encoded, strings.TrimRight(encoded, "="), 1),
		"noncanonical-bits":   strings.Replace(valid, encoded, encoded[:42]+"F=", 1),
		"base64-newline":      strings.Replace(valid, encoded, encoded[:20]+`\n`+encoded[20:], 1),
		"null-key":            strings.Replace(valid, `"`+encoded+`"`, "null", 1),
		"trailing-value":      valid + " {}", "trailing-junk": valid + " PRIVATE_MARKER",
		"invalid-utf8": valid + string([]byte{0xff}), "nul": valid + "\x00",
		"multiline":        strings.Replace(valid, `,"storeId"`, ",\n\"storeId\"", 1),
		"oversized":        valid + strings.Repeat(" ", restaurantKeyringLimit),
		"duplicate-key-id": strings.Replace(valid, "]}", fmt.Sprintf(`,{"id":"k1","key":"%s"}]}`, encoded), 1),
		"null-keys":        strings.Replace(valid, fmt.Sprintf(`[{"id":"k1","key":"%s"}]`, encoded), "null", 1),
		"empty-keys":       strings.Replace(valid, fmt.Sprintf(`[{"id":"k1","key":"%s"}]`, encoded), "[]", 1),
	} {
		t.Run(name, func(t *testing.T) {
			ring, err := parseRestaurantKeyring([]byte(raw), "store-a")
			if ring != nil || err != errRestaurantKeyring {
				t.Fatal("malformed keyring was not rejected privately")
			}
		})
	}
	for _, store := range []string{"", "store-b", "-store", "store.a", strings.Repeat("a", 81)} {
		if ring, err := parseRestaurantKeyring([]byte(valid), store); ring != nil || err != errRestaurantKeyring {
			t.Fatal("invalid expected identity accepted")
		}
	}
	keys := make(map[string][]byte)
	for i := 0; i < restaurantKeyringMaxKeys; i++ {
		keys[fmt.Sprintf("key-%d", i)] = bytes.Repeat([]byte{byte(i)}, 32)
	}
	if _, err := parseRestaurantKeyring(restaurantTestKeyringJSON(t, "store-a", "key-0", keys), "store-a"); err != nil {
		t.Fatal("maximum-size ring rejected")
	}
	keys["one-too-many"] = make([]byte, 32)
	if ring, err := parseRestaurantKeyring(restaurantTestKeyringJSON(t, "store-a", "key-0", keys), "store-a"); ring != nil || err != errRestaurantKeyring {
		t.Fatal("unbounded ring accepted")
	}
}

func TestRestaurantKeyringSourceSelectionAndRedaction(t *testing.T) {
	raw := restaurantTestKeyringJSON(t, "store-a", "k1", map[string][]byte{"k1": bytes.Repeat([]byte{0x41}, 32)})
	path := filepath.Join(t.TempDir(), "PRIVATE_PATH_MARKER")
	if err := os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	for _, env := range []map[string]string{
		{restaurantKeyringSetting: string(raw)},
		{restaurantKeyringSetting + "_FILE": path},
	} {
		ring, err := readRestaurantKeyring(func(name string) string { return env[name] }, "store-a")
		if err != nil || ring == nil {
			t.Fatal("valid source rejected", err)
		}
		for _, rendered := range []string{fmt.Sprintf("%v", ring), fmt.Sprintf("%+v", ring), fmt.Sprintf("%#v", ring)} {
			if rendered != "restaurant keyring [redacted]" {
				t.Fatal("keyring formatting is not redacted")
			}
		}
	}
	for _, env := range []map[string]string{
		{}, {restaurantKeyringSetting: "PRIVATE_VALUE_MARKER"},
		{restaurantKeyringSetting: string(raw), restaurantKeyringSetting + "_FILE": path},
		{restaurantKeyringSetting: string(raw), restaurantKeyringSetting + "_FILE": path + "-missing"},
		{restaurantKeyringSetting + "_FILE": path + "-missing"},
		{restaurantKeyringSetting: strings.Repeat("x", restaurantKeyringLimit+1)},
	} {
		ring, err := readRestaurantKeyring(func(name string) string { return env[name] }, "store-a")
		if ring != nil || err != errRestaurantKeyring {
			t.Fatal("bad source or fallback was accepted")
		}
	}
	if ring, err := readRestaurantKeyring(nil, "store-a"); ring != nil || err != errRestaurantKeyring {
		t.Fatal("nil source reader accepted")
	}
}

func TestRestaurantKeyringRejectsUnsafeFiles(t *testing.T) {
	for _, kind := range []string{"empty", "malformed", "oversized", "directory", "symlink", "missing", "unreadable", "invalid-utf8"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "PRIVATE_PATH_MARKER")
			var err error
			switch kind {
			case "empty":
				err = os.WriteFile(path, nil, 0600)
			case "malformed":
				err = os.WriteFile(path, []byte("PRIVATE_VALUE_MARKER"), 0600)
			case "oversized":
				err = os.WriteFile(path, bytes.Repeat([]byte{'x'}, restaurantKeyringLimit+1), 0600)
			case "unreadable":
				err = os.WriteFile(path, []byte("synthetic-unreadable"), 0000)
			case "invalid-utf8":
				err = os.WriteFile(path, []byte{0xff}, 0600)
			case "directory":
				err = os.Mkdir(path, 0700)
			case "symlink":
				target := filepath.Join(filepath.Dir(path), "target")
				err = os.WriteFile(target, restaurantTestKeyringJSON(t, "store-a", "k1", map[string][]byte{"k1": make([]byte, 32)}), 0600)
				if err == nil {
					err = os.Symlink(target, path)
				}
			}
			if err != nil {
				t.Fatal(err)
			}
			ring, err := readRestaurantKeyring(func(name string) string {
				if name == restaurantKeyringSetting+"_FILE" {
					return path
				}
				return ""
			}, "store-a")
			if ring != nil || err != errRestaurantKeyring {
				t.Fatal("unsafe keyring file accepted or error not private")
			}
		})
	}
}
