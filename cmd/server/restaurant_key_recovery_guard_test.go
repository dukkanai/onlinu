package main

import (
	"bytes"
	"errors"
	"path/filepath"
	"strconv"
	"sync"
	"testing"
)

// subprocess output must remain bounded and private, including on failure.
type restaurantRecoveryOutput struct {
	mu       sync.Mutex
	data     []byte
	limit    int
	overflow bool
}

func (w *restaurantRecoveryOutput) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(p) > w.limit-len(w.data) {
		w.overflow = true
		return 0, errors.New("synthetic recovery output exceeded its bound")
	}
	w.data = append(w.data, p...)
	return len(p), nil
}

func (w *restaurantRecoveryOutput) snapshot() ([]byte, bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return bytes.Clone(w.data), w.overflow
}

func restaurantRecoveryOwnedIdentity(expected, actual string, expectedPort, actualPort int, address string) bool {
	return filepath.IsAbs(expected) && filepath.Clean(expected) == expected && actual == expected && expectedPort > 0 && expectedPort == actualPort && address == "127.0.0.1"
}

func restaurantRecoveryExpectedRejection(logs []byte, exitCode int, maintenance bool) bool {
	message, reason := "startup failed", errRestaurantKeyState.Error()
	if maintenance {
		message, reason = "restaurant crypto maintenance failed", errRestaurantCryptoMaintenance.Error()
	}
	return exitCode == 1 && bytes.Contains(logs, []byte("msg="+strconv.Quote(message))) && bytes.Contains(logs, []byte("err="+strconv.Quote(reason)))
}

func TestRestaurantKeyRecoveryOwnedIdentityGuards(t *testing.T) {
	owned := filepath.Join(t.TempDir(), "owned", "data")
	other := filepath.Join(t.TempDir(), "other", "data")
	unclean := owned + string(filepath.Separator) + ".." + string(filepath.Separator) + "data"
	if !restaurantRecoveryOwnedIdentity(owned, owned, 15433, 15433, "127.0.0.1") {
		t.Fatal("exact owned recovery identity rejected")
	}
	for _, row := range []struct {
		expected, actual string
		port, actualPort int
		address          string
	}{{"relative", "relative", 15433, 15433, "127.0.0.1"}, {unclean, unclean, 15433, 15433, "127.0.0.1"}, {owned, other, 15433, 15433, "127.0.0.1"}, {owned, owned, 15433, 5432, "127.0.0.1"}, {owned, owned, 0, 0, "127.0.0.1"}, {owned, owned, 15433, 15433, "10.0.0.1"}} {
		if restaurantRecoveryOwnedIdentity(row.expected, row.actual, row.port, row.actualPort, row.address) {
			t.Fatal("unowned recovery identity accepted")
		}
	}
	output := &restaurantRecoveryOutput{limit: 5}
	if _, err := output.Write([]byte("PGDMP")); err != nil {
		t.Fatal("bounded archive prefix rejected")
	}
	if _, err := output.Write([]byte("overflow")); err == nil {
		t.Fatal("archive output bound not enforced")
	}
	if data, overflow := output.snapshot(); !overflow || string(data) != "PGDMP" {
		t.Fatal("overflow changed retained bounded output")
	}
	for _, maintenance := range []bool{false, true} {
		message, reason := "startup failed", errRestaurantKeyState.Error()
		if maintenance {
			message, reason = "restaurant crypto maintenance failed", errRestaurantCryptoMaintenance.Error()
		}
		valid := []byte("msg=" + strconv.Quote(message) + " err=" + strconv.Quote(reason))
		if !restaurantRecoveryExpectedRejection(valid, 1, maintenance) {
			t.Fatal("expected crypto refusal was not recognized")
		}
		for _, code := range []int{-1, 0, 2} {
			if restaurantRecoveryExpectedRejection(valid, code, maintenance) {
				t.Fatal("unrelated termination accepted as crypto refusal")
			}
		}
		for _, invalid := range []string{"panic: fixture", "msg=" + strconv.Quote(message), "err=" + strconv.Quote(reason), "msg=" + strconv.Quote(message) + ` err="restaurant crypto database unavailable"`} {
			if restaurantRecoveryExpectedRejection([]byte(invalid), 1, maintenance) {
				t.Fatal("unrelated error accepted as crypto refusal")
			}
		}
	}
}
