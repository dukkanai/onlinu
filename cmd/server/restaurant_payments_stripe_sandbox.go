package main

// Signature verification for the closed, own-account snapshot-event sandbox
// route. Verification authenticates lookup hints, never payment state.
// Official references, checked 2026-10-10:
// https://docs.stripe.com/keys/restricted-api-keys
// https://docs.stripe.com/webhooks#verify-manually

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"regexp"
	"strconv"
	"strings"
	"time"
)

var restaurantStripeSandboxKey = regexp.MustCompile(`^(rk|sk)_test_[A-Za-z0-9]{1,480}$`)
var restaurantStripeSigningSecret = regexp.MustCompile(`^whsec_[A-Za-z0-9_]{1,480}$`)
var restaurantStripeEventID = regexp.MustCompile(`^evt_[A-Za-z0-9_]{1,196}$`)

// A syntactically valid test key is not proof of ownership, account identity,
// permissions, or isolation in a dedicated sandbox. Those require later setup
// and acceptance. Prefer a restricted rk_test_ key with only required resources.
func restaurantStripeSandboxConfigValid(c restaurantPaymentConfig) error {
	if c.ID != "stripe" || c.Mode != "test" || !restaurantStripeSandboxKey.MatchString(c.Secrets["secretKey"]) {
		return restaurantFail(400, "invalid_request")
	}
	return nil
}

// Only authenticated lookup hints leave the verifier; amounts, statuses,
// customer details, and the body itself are intentionally not retained.
type restaurantStripeSandboxEvent struct {
	ID, Type, ObjectID, AttemptID, APIVersion, Object string
	ObjectTest                                        bool
}

// Verify the exact bytes received, before parsing. A fresh signature authenticates
// delivery, not payment or unique processing. The future caller must atomically
// persist the event ID and refresh work, then use the persisted Checkout Session
// for authoritative retrieval. Never settle from this return value.
func restaurantStripeVerifySandboxEvent(raw []byte, signature, secret string, now time.Time) (restaurantStripeSandboxEvent, error) {
	invalid := func() (restaurantStripeSandboxEvent, error) {
		return restaurantStripeSandboxEvent{}, restaurantFail(400, "invalid_request")
	}
	if len(raw) == 0 || len(raw) > 256*1024 || len(signature) == 0 || len(signature) > 8192 || strings.ContainsAny(signature, "\r\n") || !restaurantStripeSigningSecret.MatchString(secret) || now.IsZero() {
		return invalid()
	}
	var timestamp string
	var signatures [][]byte
	for _, part := range strings.Split(signature, ",") {
		key, value, ok := strings.Cut(strings.TrimSpace(part), "=")
		if !ok {
			return invalid()
		}
		switch key {
		case "t":
			// Reject ambiguous repeated timestamps, even when values match.
			if timestamp != "" || value == "" {
				return invalid()
			}
			timestamp = value
		case "v1":
			digest, err := hex.DecodeString(value)
			if err != nil || len(digest) != sha256.Size {
				return invalid()
			}
			signatures = append(signatures, digest)
		}
	}
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil || seconds <= 0 || strconv.FormatInt(seconds, 10) != timestamp || len(signatures) == 0 {
		return invalid()
	}
	// Bound both old and future timestamps. Comparison via time avoids integer
	// overflow in hostile Unix-second values. Production clock must be synced.
	when := time.Unix(seconds, 0)
	if when.Before(now.Add(-5*time.Minute)) || when.After(now.Add(5*time.Minute)) {
		return invalid()
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write([]byte(timestamp + "."))
	_, _ = mac.Write(raw)
	expected := mac.Sum(nil)
	matched := false
	for _, digest := range signatures {
		// Multiple v1 values occur during endpoint-secret rotation. Never accept
		// v0, including the fake v0 signatures Stripe adds to test deliveries.
		if hmac.Equal(expected, digest) {
			matched = true
		}
	}
	if !matched {
		return invalid()
	}
	var envelope struct {
		ID         string `json:"id"`
		APIVersion string `json:"api_version"`
		Object     string `json:"object"`
		Type       string `json:"type"`
		LiveMode   *bool  `json:"livemode"`
		Account    string `json:"account"`
		Context    string `json:"context"`
		Data       struct {
			Object struct {
				ID       string            `json:"id"`
				Object   string            `json:"object"`
				LiveMode *bool             `json:"livemode"`
				Metadata map[string]string `json:"metadata"`
			} `json:"object"`
		} `json:"data"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	if decoder.Decode(&envelope) != nil || decoder.Decode(new(any)) != io.EOF || !restaurantStripeEventID.MatchString(envelope.ID) || envelope.Object != "event" || envelope.LiveMode == nil || *envelope.LiveMode || envelope.Account != "" || envelope.Context != "" || envelope.Type == "" || len(envelope.Type) > 200 {
		return invalid()
	}
	return restaurantStripeSandboxEvent{ID: envelope.ID, Type: envelope.Type, ObjectID: envelope.Data.Object.ID, AttemptID: envelope.Data.Object.Metadata["restaurant_attempt"], APIVersion: envelope.APIVersion, Object: envelope.Data.Object.Object, ObjectTest: envelope.Data.Object.LiveMode != nil && !*envelope.Data.Object.LiveMode}, nil
}
