package main

import (
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func restaurantTestEnvelope(t *testing.T, raw []byte) restaurantKeyEnvelope {
	t.Helper()
	var envelope restaurantKeyEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	return envelope
}

func restaurantTestEnvelopeJSON(t *testing.T, envelope restaurantKeyEnvelope) []byte {
	t.Helper()
	raw, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func restaurantTestPayloadSeal(t *testing.T, key []byte) cipher.AEAD {
	t.Helper()
	block, err := aes.NewCipher(key)
	if err != nil {
		t.Fatal(err)
	}
	seal, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	return seal
}

func TestRestaurantKeyEnvelopeWrapRoundTripAndFreshNonce(t *testing.T) {
	master := bytes.Repeat([]byte{0x41}, 32)
	ring := restaurantTestKeyring(t, "store-a", "master-1", map[string][]byte{"master-1": master})
	dek := bytes.Repeat([]byte{0x63}, 32)
	before := bytes.Clone(dek)
	seen := make(map[string]bool)
	for _, purpose := range []string{restaurantOrderKeyPurpose, restaurantPaymentKeyPurpose} {
		for i := 0; i < 64; i++ {
			raw, err := ring.wrap(purpose, "data-1", dek)
			if err != nil {
				t.Fatal(err)
			}
			envelope := restaurantTestEnvelope(t, raw)
			if envelope.Version != 1 || envelope.StoreID != "store-a" || envelope.Purpose != purpose || envelope.DataKeyID != "data-1" || envelope.WrappingKeyID != "master-1" || seen[envelope.Nonce] {
				t.Fatal("envelope identity or nonce freshness failed")
			}
			seen[envelope.Nonce] = true
			if len(raw) > restaurantKeyEnvelopeLimit || bytes.Contains(raw, []byte(base64.StdEncoding.EncodeToString(dek))) || bytes.Contains(raw, []byte(base64.StdEncoding.EncodeToString(master))) {
				t.Fatal("envelope contains raw key material or exceeds bound")
			}
			got, err := ring.unwrap(purpose, "data-1", raw)
			if err != nil || !bytes.Equal(got, before) || !bytes.Equal(dek, before) {
				t.Fatal("DEK bytes changed", err)
			}
			// The returned key is independent memory, not a ring-owned key buffer.
			clear(got)
			again, err := ring.unwrap(purpose, "data-1", raw)
			if err != nil || !bytes.Equal(again, before) {
				t.Fatal("returned buffer aliases retained key state")
			}
			clear(again)
		}
	}
}

func TestRestaurantKeyEnvelopeAuthenticatesEveryContextField(t *testing.T) {
	key := bytes.Repeat([]byte{0x41}, 32)
	keys := map[string][]byte{"master-1": key, "same-material-alias": key}
	ring := restaurantTestKeyring(t, "store-a", "master-1", keys)
	otherStore := restaurantTestKeyring(t, "store-b", "master-1", keys)
	raw, err := ring.wrap(restaurantOrderKeyPurpose, "data-1", bytes.Repeat([]byte{0x62}, 32))
	if err != nil {
		t.Fatal(err)
	}
	base := restaurantTestEnvelope(t, raw)
	if string(base.aad()) != `["onlinu-restaurant-dek-envelope","1","store-a","order-secrets","data-1","master-1"]` {
		t.Fatal("version-1 authenticated context format changed")
	}
	for _, tc := range []struct {
		name        string
		ring        *restaurantKeyring
		purpose, id string
		change      func(*restaurantKeyEnvelope)
	}{
		{"store", otherStore, restaurantOrderKeyPurpose, "data-1", func(e *restaurantKeyEnvelope) { e.StoreID = "store-b" }},
		{"purpose", ring, restaurantPaymentKeyPurpose, "data-1", func(e *restaurantKeyEnvelope) { e.Purpose = restaurantPaymentKeyPurpose }},
		{"data-key-id", ring, restaurantOrderKeyPurpose, "data-2", func(e *restaurantKeyEnvelope) { e.DataKeyID = "data-2" }},
		{"wrapping-key-id", ring, restaurantOrderKeyPurpose, "data-1", func(e *restaurantKeyEnvelope) { e.WrappingKeyID = "same-material-alias" }},
		{"version", ring, restaurantOrderKeyPurpose, "data-1", func(e *restaurantKeyEnvelope) { e.Version = 2 }},
		{"nonce", ring, restaurantOrderKeyPurpose, "data-1", func(e *restaurantKeyEnvelope) {
			nonce, _ := base64.StdEncoding.DecodeString(e.Nonce)
			nonce[0] ^= 1
			e.Nonce = base64.StdEncoding.EncodeToString(nonce)
		}},
		{"ciphertext", ring, restaurantOrderKeyPurpose, "data-1", func(e *restaurantKeyEnvelope) {
			sealed, _ := base64.StdEncoding.DecodeString(e.Ciphertext)
			sealed[0] ^= 1
			e.Ciphertext = base64.StdEncoding.EncodeToString(sealed)
		}},
		{"tag", ring, restaurantOrderKeyPurpose, "data-1", func(e *restaurantKeyEnvelope) {
			sealed, _ := base64.StdEncoding.DecodeString(e.Ciphertext)
			sealed[len(sealed)-1] ^= 1
			e.Ciphertext = base64.StdEncoding.EncodeToString(sealed)
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			envelope := base
			tc.change(&envelope)
			if got, err := tc.ring.unwrap(tc.purpose, tc.id, restaurantTestEnvelopeJSON(t, envelope)); got != nil || err != errRestaurantKeyEnvelope {
				t.Fatal("tampered envelope was not rejected privately")
			}
		})
	}
	for _, tc := range []struct {
		ring        *restaurantKeyring
		purpose, id string
	}{
		{ring, restaurantPaymentKeyPurpose, "data-1"}, {ring, restaurantOrderKeyPurpose, "data-2"},
		{otherStore, restaurantOrderKeyPurpose, "data-1"},
		{restaurantTestKeyring(t, "store-a", "master-1", map[string][]byte{"master-1": bytes.Repeat([]byte{0x43}, 32)}), restaurantOrderKeyPurpose, "data-1"},
	} {
		if got, err := tc.ring.unwrap(tc.purpose, tc.id, raw); got != nil || err != errRestaurantKeyEnvelope {
			t.Fatal("wrong expected context or key accepted")
		}
	}
}

func TestRestaurantKeyEnvelopeStrictParsingAndInvalidArguments(t *testing.T) {
	ring := restaurantTestKeyring(t, "store-a", "master-1", map[string][]byte{"master-1": make([]byte, 32)})
	raw, err := ring.wrap(restaurantPaymentKeyPurpose, "data-1", make([]byte, 32))
	if err != nil {
		t.Fatal(err)
	}
	base := restaurantTestEnvelope(t, raw)
	for name, value := range map[string]string{
		"empty": "", "null": "null", "array": "[]", "truncated": string(raw[:len(raw)-1]),
		"trailing": string(raw) + " {}", "invalid-utf8": string(raw) + string([]byte{0xff}),
		"duplicate":         strings.Replace(string(raw), `"version":1`, `"version":1,"version":1`, 1),
		"escaped-duplicate": strings.Replace(string(raw), `"version":1`, `"version":1,"vers\u0069on":1`, 1),
		"unknown":           strings.Replace(string(raw), `"version":1`, `"version":1,"PRIVATE_MARKER":1`, 1),
		"case":              strings.Replace(string(raw), `"version":1`, `"Version":1`, 1),
		"missing":           strings.Replace(string(raw), `"version":1,`, "", 1),
		"oversized":         string(raw) + strings.Repeat(" ", restaurantKeyEnvelopeLimit),
	} {
		t.Run(name, func(t *testing.T) {
			if got, err := ring.unwrap(restaurantPaymentKeyPurpose, "data-1", []byte(value)); got != nil || err != errRestaurantKeyEnvelope {
				t.Fatal("malformed envelope accepted")
			}
		})
	}
	for _, change := range []func(*restaurantKeyEnvelope){
		func(e *restaurantKeyEnvelope) { e.Nonce = "" },
		func(e *restaurantKeyEnvelope) { e.Nonce = base64.StdEncoding.EncodeToString(make([]byte, 11)) },
		func(e *restaurantKeyEnvelope) { e.Nonce += "\n" },
		func(e *restaurantKeyEnvelope) { e.Ciphertext = "" },
		func(e *restaurantKeyEnvelope) { e.Ciphertext = base64.StdEncoding.EncodeToString(make([]byte, 47)) },
		func(e *restaurantKeyEnvelope) { e.Ciphertext += "\n" },
		func(e *restaurantKeyEnvelope) { e.WrappingKeyID = "missing" },
		func(e *restaurantKeyEnvelope) { e.WrappingKeyID = " invalid" },
	} {
		envelope := base
		change(&envelope)
		if got, err := ring.unwrap(restaurantPaymentKeyPurpose, "data-1", restaurantTestEnvelopeJSON(t, envelope)); got != nil || err != errRestaurantKeyEnvelope {
			t.Fatal("invalid encoded envelope value accepted")
		}
	}
	for _, tc := range []struct {
		purpose, id string
		key         []byte
	}{
		{"", "data-1", make([]byte, 32)}, {"other", "data-1", make([]byte, 32)},
		{restaurantOrderKeyPurpose, "", make([]byte, 32)}, {restaurantOrderKeyPurpose, "bad id", make([]byte, 32)},
		{restaurantOrderKeyPurpose, "data-1", nil}, {restaurantOrderKeyPurpose, "data-1", make([]byte, 31)},
		{restaurantOrderKeyPurpose, "data-1", make([]byte, 33)},
	} {
		if got, err := ring.wrap(tc.purpose, tc.id, tc.key); got != nil || err != errRestaurantKeyEnvelope {
			t.Fatal("invalid wrap input accepted")
		}
	}
	var absent *restaurantKeyring
	if got, err := absent.wrap(restaurantOrderKeyPurpose, "data-1", make([]byte, 32)); got != nil || err != errRestaurantKeyEnvelope {
		t.Fatal("nil ring accepted for wrap")
	}
	if got, err := absent.unwrap(restaurantOrderKeyPurpose, "data-1", raw); got != nil || err != errRestaurantKeyEnvelope {
		t.Fatal("nil ring accepted for unwrap")
	}
}

func TestRestaurantKeyEnvelopeRotationPreservesHistoricalReadability(t *testing.T) {
	oldKey, newKey := bytes.Repeat([]byte{0x41}, 32), bytes.Repeat([]byte{0x42}, 32)
	old := restaurantTestKeyring(t, "store-a", "old", map[string][]byte{"old": oldKey})
	transition := restaurantTestKeyring(t, "store-a", "new", map[string][]byte{"old": oldKey, "new": newKey})
	retired := restaurantTestKeyring(t, "store-a", "new", map[string][]byte{"new": newKey})
	dek := bytes.Repeat([]byte{0x64}, 32)
	for _, purpose := range []string{restaurantOrderKeyPurpose, restaurantPaymentKeyPurpose} {
		oldEnvelope, err := old.wrap(purpose, "data-1", dek)
		if err != nil {
			t.Fatal(err)
		}
		opened, err := transition.unwrap(purpose, "data-1", oldEnvelope)
		if err != nil || !bytes.Equal(opened, dek) {
			t.Fatal("transition lost historical envelope", err)
		}
		newEnvelope, err := transition.wrap(purpose, "data-1", opened)
		if err != nil || restaurantTestEnvelope(t, newEnvelope).WrappingKeyID != "new" {
			t.Fatal("new active key not used", err)
		}
		clear(opened)
		opened, err = retired.unwrap(purpose, "data-1", newEnvelope)
		if err != nil || !bytes.Equal(opened, dek) {
			t.Fatal("rewrap changed original DEK", err)
		}
		clear(opened)
		if got, err := old.unwrap(purpose, "data-1", newEnvelope); got != nil || err != errRestaurantKeyEnvelope {
			t.Fatal("old-only ring opened new envelope")
		}
		if got, err := retired.unwrap(purpose, "data-1", oldEnvelope); got != nil || err != errRestaurantKeyEnvelope {
			t.Fatal("removed historical key did not fail closed")
		}
		// A retained old key can explicitly rewrap for an envelope-aware rollback.
		rollback, err := old.wrap(purpose, "data-1", dek)
		if err != nil {
			t.Fatal(err)
		}
		if got, err := transition.unwrap(purpose, "data-1", rollback); err != nil || !bytes.Equal(got, dek) {
			t.Fatal("explicit rewrap rollback failed")
		}
	}
}

func TestRestaurantKeyEnvelopePreservesExistingPayloadFormats(t *testing.T) {
	ring := restaurantTestKeyring(t, "store-a", "master-1", map[string][]byte{"master-1": bytes.Repeat([]byte{0x41}, 32)})
	orderDEK, paymentDEK := bytes.Repeat([]byte{0x51}, 32), bytes.Repeat([]byte{0x52}, 32)
	orders := &restaurantOrders{seal: restaurantTestPayloadSeal(t, orderDEK)}
	secrets := restaurantOrderSecrets{TrackingToken: "synthetic-tracking-only", AccessCode: "synthetic-code-only"}
	sealedOrder, err := orders.sealOrderSecrets("SYNTHETIC-1", secrets)
	if err != nil {
		t.Fatal(err)
	}
	payments := &restaurantPayments{seal: restaurantTestPayloadSeal(t, paymentDEK)}
	cfg := restaurantPaymentConfig{ID: "stripe", Mode: "test", Values: map[string]string{"synthetic": "unchanged"}, Secrets: map[string]string{"secretKey": "synthetic-provider-only"}}
	sealedConfig, err := payments.encrypt("config:stripe", cfg)
	if err != nil {
		t.Fatal(err)
	}
	sealedAttempt, err := payments.encrypt("attempt:synthetic-1", cfg)
	if err != nil {
		t.Fatal(err)
	}
	before := [][]byte{bytes.Clone(sealedOrder), bytes.Clone(sealedConfig), bytes.Clone(sealedAttempt)}
	for _, tc := range []struct {
		purpose string
		key     []byte
		set     func(cipher.AEAD)
	}{
		{restaurantOrderKeyPurpose, orderDEK, func(seal cipher.AEAD) { orders.seal = seal }},
		{restaurantPaymentKeyPurpose, paymentDEK, func(seal cipher.AEAD) { payments.seal = seal }},
	} {
		wrapped, err := ring.wrap(tc.purpose, "legacy-v1", tc.key)
		if err != nil {
			t.Fatal(err)
		}
		opened, err := ring.unwrap(tc.purpose, "legacy-v1", wrapped)
		if err != nil || !bytes.Equal(opened, tc.key) {
			t.Fatal("existing DEK changed", err)
		}
		tc.set(restaurantTestPayloadSeal(t, opened))
		clear(opened)
	}
	receipt, err := orders.receipt(restaurantOrderStored{order: restaurantOrder{Number: "SYNTHETIC-1"}, sealedSecrets: sealedOrder})
	if err != nil || receipt.TrackingToken != secrets.TrackingToken || receipt.AccessCode != secrets.AccessCode {
		t.Fatal("original receipt format changed", err)
	}
	for _, tc := range []struct {
		id  string
		raw []byte
	}{{"config:stripe", sealedConfig}, {"attempt:synthetic-1", sealedAttempt}} {
		got, err := payments.decrypt(tc.id, tc.raw)
		if err != nil || !reflect.DeepEqual(got, cfg) {
			t.Fatal("original payment format changed", err)
		}
	}
	if !bytes.Equal(sealedOrder, before[0]) || !bytes.Equal(sealedConfig, before[1]) || !bytes.Equal(sealedAttempt, before[2]) {
		t.Fatal("payload ciphertext was rewritten")
	}
}

func TestRestaurantKeyEnvelopeConcurrentUse(t *testing.T) {
	ring := restaurantTestKeyring(t, "store-a", "master-1", map[string][]byte{"master-1": bytes.Repeat([]byte{0x41}, 32)})
	var workers sync.WaitGroup
	failures := make(chan error, 32)
	for i := 0; i < 32; i++ {
		workers.Add(1)
		go func(i int) {
			defer workers.Done()
			dek, id := bytes.Repeat([]byte{byte(i)}, 32), fmt.Sprintf("data-%d", i)
			for j := 0; j < 16; j++ {
				raw, err := ring.wrap(restaurantPaymentKeyPurpose, id, dek)
				if err != nil {
					failures <- err
					return
				}
				got, err := ring.unwrap(restaurantPaymentKeyPurpose, id, raw)
				if err != nil || !bytes.Equal(got, dek) {
					failures <- errors.New("concurrent envelope mismatch")
					return
				}
				clear(got)
			}
		}(i)
	}
	workers.Wait()
	close(failures)
	for err := range failures {
		t.Error(err)
	}
}

func TestRestaurantKeyEnvelopeFrozenLegacyPayloads(t *testing.T) {
	// Frozen synthetic ciphertext generated using the unchanged e47ff94 receipt
	// and payment methods. Unlike a round trip generated during this test, these
	// bytes catch incompatible edits to the existing payload/AAD formats. This
	// is not a fixture extracted from any real restaurant or provider account.
	const orderFixture = "htjiXVtfDPWCoj2V0K3+PBFFlK/3RhxLEMQvmqP+H3eWYyB3+TETpmQvaqv2VYnTRiug4EXddd1RIxwlGWt1235p7yXhqLEOeZNwrhAapAs2ICYKszIxBftFHB6Cnxopy0uV9yUYdALqhQ=="
	const configFixture = "mzsIvY23YqblXaGYKCe/fgkPiNNJV+iVEA4qYoKJ0Cb77TPvjRP+mYFMXv5VFr2xLlUKHSrcspuqnFf8Upp89xjBBDQMR64eqo5Q3hJuj7HwYufMixt8Ojv3TbvPKH7O5XVKKeAOEjkuDF+cFwd8RMO3b66nSZ+QpjtkeOclJJmxOWfSuxFo6dGRFVseEUmAeyJBOLRfVDCqzjiFm9Y="
	const attemptFixture = "gUgb4JRyNutLKHqJHmMG0iMMKANyJ1qzdPtmBHHAhHirKGQxpWsZavZQ0pMvHGleyNb5hLx8UQjpLrNumrd8Ntoire9J7SMe+97StIqtlmuVd5fn1FSZBXSoeBj1BRBftyd928ozNxkzPBkDVev/iJh6YZ32tLtmypM9Iq/3JftPyf6md0Oi5JfpatzUf3lSfr1475Z0gS7o0sTidCc="
	decode := func(encoded string) []byte {
		raw, err := base64.StdEncoding.Strict().DecodeString(encoded)
		if err != nil {
			t.Fatal("invalid frozen synthetic fixture", err)
		}
		return raw
	}
	ring := restaurantTestKeyring(t, "store-a", "master-1", map[string][]byte{"master-1": bytes.Repeat([]byte{0x41}, 32)})
	recoverSeal := func(purpose string, keyByte byte) cipher.AEAD {
		wrapped, err := ring.wrap(purpose, "legacy-v1", bytes.Repeat([]byte{keyByte}, 32))
		if err != nil {
			t.Fatal(err)
		}
		opened, err := ring.unwrap(purpose, "legacy-v1", wrapped)
		if err != nil {
			t.Fatal(err)
		}
		seal := restaurantTestPayloadSeal(t, opened)
		clear(opened)
		return seal
	}
	orders := &restaurantOrders{seal: recoverSeal(restaurantOrderKeyPurpose, 0x51)}
	receipt, err := orders.receipt(restaurantOrderStored{order: restaurantOrder{Number: "SYNTHETIC-1"}, sealedSecrets: decode(orderFixture)})
	if err != nil || receipt.TrackingToken != "synthetic-tracking-only" || receipt.AccessCode != "synthetic-code-only" {
		t.Fatal("frozen receipt is no longer readable", err)
	}
	payments := &restaurantPayments{seal: recoverSeal(restaurantPaymentKeyPurpose, 0x52)}
	want := restaurantPaymentConfig{ID: "stripe", Mode: "test", Values: map[string]string{"synthetic": "unchanged"}, Secrets: map[string]string{"secretKey": "synthetic-provider-only"}}
	for _, tc := range []struct{ id, encoded string }{{"config:stripe", configFixture}, {"attempt:synthetic-1", attemptFixture}} {
		got, err := payments.decrypt(tc.id, decode(tc.encoded))
		if err != nil || !reflect.DeepEqual(got, want) {
			t.Fatal("frozen payment payload is no longer readable", err)
		}
	}
}
