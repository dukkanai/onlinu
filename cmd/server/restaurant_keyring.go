package main

// Loaded by the explicit external-v1 mode before any database connection.
// Existing deployment defaults remain legacy until separately approved activation.
import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"os"
	"unicode/utf8"
)

const (
	restaurantKeyringSetting = "WACALLS_CRYPTO_KEYRING"
	restaurantKeyringLimit   = 64 * 1024
	restaurantKeyringMaxKeys = 16
	restaurantDEKSize        = 32
)

var errRestaurantKeyring = errors.New("invalid restaurant keyring configuration")

// Immutable after construction. Only the wrapping ciphers are retained; no
// method exports their keys or changes the active key. A new ring represents a
// controlled reload. Do not log either the input configuration or decrypted DEKs.
type restaurantKeyring struct {
	storeID, activeKeyID string
	keys                 map[string]cipher.AEAD
}

func (*restaurantKeyring) String() string   { return "restaurant keyring [redacted]" }
func (*restaurantKeyring) GoString() string { return "restaurant keyring [redacted]" }

// readRestaurantKeyring follows runtime_secrets.go's explicit-file, no-fallback,
// bounded-read, single-line and private-error contract. It never exports to
// os.Environ, creates files, generates keys or mutates shared configuration.
func readRestaurantKeyring(getenv func(string) string, expectedStoreID string) (*restaurantKeyring, error) {
	if getenv == nil {
		return nil, errRestaurantKeyring
	}
	value, path := getenv(restaurantKeyringSetting), getenv(restaurantKeyringSetting+"_FILE")
	if path == "" {
		if len(value) > restaurantKeyringLimit {
			return nil, errRestaurantKeyring
		}
		return parseRestaurantKeyring([]byte(value), expectedStoreID)
	}
	if value != "" {
		return nil, errRestaurantKeyring
	}
	before, err := os.Lstat(path)
	if err != nil || !before.Mode().IsRegular() || before.Size() > restaurantKeyringLimit {
		return nil, errRestaurantKeyring
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, errRestaurantKeyring
	}
	info, statErr := file.Stat()
	if statErr != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) {
		_ = file.Close()
		return nil, errRestaurantKeyring
	}
	raw, readErr := io.ReadAll(io.LimitReader(file, restaurantKeyringLimit+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil {
		return nil, errRestaurantKeyring
	}
	return parseRestaurantKeyring(raw, expectedStoreID)
}

func parseRestaurantKeyring(raw []byte, expectedStoreID string) (*restaurantKeyring, error) {
	if !restaurantKeyIdentifier(expectedStoreID, 80) || len(raw) > restaurantKeyringLimit {
		return nil, errRestaurantKeyring
	}
	raw = bytes.TrimRight(raw, "\r\n")
	if bytes.ContainsAny(raw, "\x00\r\n") {
		return nil, errRestaurantKeyring
	}
	fields, ok := restaurantKeyObject(raw, "version", "storeId", "activeKeyId", "keys")
	if !ok {
		return nil, errRestaurantKeyring
	}
	var version int
	var storeID, activeID string
	var entries []json.RawMessage
	if json.Unmarshal(fields["version"], &version) != nil || version != 1 ||
		json.Unmarshal(fields["storeId"], &storeID) != nil || storeID != expectedStoreID ||
		json.Unmarshal(fields["activeKeyId"], &activeID) != nil || !restaurantKeyIdentifier(activeID, 64) ||
		json.Unmarshal(fields["keys"], &entries) != nil || len(entries) < 1 || len(entries) > restaurantKeyringMaxKeys {
		return nil, errRestaurantKeyring
	}
	ring := &restaurantKeyring{storeID: storeID, activeKeyID: activeID, keys: make(map[string]cipher.AEAD, len(entries))}
	for _, entry := range entries {
		fields, ok := restaurantKeyObject(entry, "id", "key")
		var id, encoded string
		if !ok || json.Unmarshal(fields["id"], &id) != nil || !restaurantKeyIdentifier(id, 64) ||
			json.Unmarshal(fields["key"], &encoded) != nil || ring.keys[id] != nil {
			return nil, errRestaurantKeyring
		}
		key, ok := restaurantKeyBase64(encoded, restaurantDEKSize)
		if !ok {
			return nil, errRestaurantKeyring
		}
		block, err := aes.NewCipher(key)
		clear(key)
		if err != nil {
			return nil, errRestaurantKeyring
		}
		seal, err := cipher.NewGCM(block)
		if err != nil {
			return nil, errRestaurantKeyring
		}
		ring.keys[id] = seal
	}
	if ring.keys[activeID] == nil {
		return nil, errRestaurantKeyring
	}
	return ring, nil
}

// Exact field names, required fields, duplicate rejection (including escaped
// spellings), one complete object, and valid UTF-8. Decoding directly to a struct
// would otherwise accept duplicate and case-insensitive field names.
func restaurantKeyObject(raw []byte, names ...string) (map[string]json.RawMessage, bool) {
	if !utf8.Valid(raw) {
		return nil, false
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	start, err := decoder.Token()
	if err != nil || start != json.Delim('{') {
		return nil, false
	}
	allowed := make(map[string]bool, len(names))
	for _, name := range names {
		allowed[name] = true
	}
	fields := make(map[string]json.RawMessage, len(names))
	for decoder.More() {
		token, err := decoder.Token()
		name, isString := token.(string)
		if err != nil || !isString || !allowed[name] || fields[name] != nil {
			return nil, false
		}
		var value json.RawMessage
		if decoder.Decode(&value) != nil {
			return nil, false
		}
		fields[name] = value
	}
	end, err := decoder.Token()
	if err != nil || end != json.Delim('}') || len(fields) != len(names) {
		return nil, false
	}
	if _, err := decoder.Token(); err != io.EOF {
		return nil, false
	}
	return fields, true
}

func restaurantKeyIdentifier(value string, limit int) bool {
	if len(value) < 1 || len(value) > limit {
		return false
	}
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || i > 0 && (c == '-' || c == '_') {
			continue
		}
		return false
	}
	return true
}

func restaurantKeyBase64(encoded string, size int) ([]byte, bool) {
	if len(encoded) != base64.StdEncoding.EncodedLen(size) {
		return nil, false
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || len(decoded) != size || base64.StdEncoding.EncodeToString(decoded) != encoded {
		return nil, false
	}
	return decoded, true
}
