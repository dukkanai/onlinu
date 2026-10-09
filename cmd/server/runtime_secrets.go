package main

import (
	"fmt"
	"io"
	"os"
	"strings"
	"sync/atomic"
	"unicode/utf8"
)

const runtimeSecretFileLimit = 64 * 1024

var runtimeSecretNames = []string{"WACALLS_API_KEY", "WACALLS_PG_URL"}

type runtimeFileSecrets struct{ values map[string]string }

var loadedRuntimeFileSecrets atomic.Pointer[runtimeFileSecrets]

// Only explicit operator-owned startup configuration can name these files.
// Validate every source before making any value available. Never include file
// paths, content, or wrapped filesystem errors in a configuration error.
func readRuntimeSecretFiles(getenv func(string) string) (map[string]string, error) {
	values := make(map[string]string)
	for _, name := range runtimeSecretNames {
		path := getenv(name + "_FILE")
		if path == "" {
			continue
		}
		invalid := func() (map[string]string, error) {
			return nil, fmt.Errorf("invalid %s secret-file configuration", name)
		}
		if getenv(name) != "" {
			return invalid()
		}
		before, err := os.Lstat(path)
		if err != nil || !before.Mode().IsRegular() || before.Size() > runtimeSecretFileLimit {
			return invalid()
		}
		file, err := os.Open(path)
		if err != nil {
			return invalid()
		}
		info, statErr := file.Stat()
		if statErr != nil || !info.Mode().IsRegular() || !os.SameFile(before, info) {
			_ = file.Close()
			return invalid()
		}
		raw, readErr := io.ReadAll(io.LimitReader(file, runtimeSecretFileLimit+1))
		closeErr := file.Close()
		if readErr != nil || closeErr != nil || len(raw) > runtimeSecretFileLimit || !utf8.Valid(raw) {
			return invalid()
		}
		value := strings.TrimRight(string(raw), "\r\n")
		if strings.TrimSpace(value) == "" || strings.ContainsAny(value, "\x00\r\n") {
			return invalid()
		}
		values[name] = value
	}
	return values, nil
}
func runtimeSecretFrom(values map[string]string, getenv func(string) string, name string) string {
	if value, ok := values[name]; ok {
		return value
	}
	return getenv(name)
}
func runtimeSecret(name string) string {
	if loaded := loadedRuntimeFileSecrets.Load(); loaded != nil {
		return runtimeSecretFrom(loaded.values, os.Getenv, name)
	}
	return os.Getenv(name)
}
