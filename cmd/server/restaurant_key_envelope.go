package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
)

const (
	restaurantKeyEnvelopeLimit  = 4096
	restaurantOrderKeyPurpose   = "order-secrets"
	restaurantPaymentKeyPurpose = "payment-secrets"
)

var errRestaurantKeyEnvelope = errors.New("restaurant key envelope unavailable")

type restaurantKeyEnvelope struct {
	Version       int    `json:"version"`
	StoreID       string `json:"storeId"`
	Purpose       string `json:"purpose"`
	DataKeyID     string `json:"dataKeyId"`
	WrappingKeyID string `json:"wrappingKeyId"`
	Nonce         string `json:"nonce"`
	Ciphertext    string `json:"ciphertext"`
}

// A versioned, unambiguous serialization with a separate domain. The expected
// store/purpose/DEK ID must come from trusted configuration and row identity,
// never from the envelope being opened. The KEK ID is authenticated too.
func (e restaurantKeyEnvelope) aad() []byte {
	raw, _ := json.Marshal([]string{"onlinu-restaurant-dek-envelope", "1", e.StoreID, e.Purpose, e.DataKeyID, e.WrappingKeyID})
	return raw
}

func restaurantKeyPurpose(purpose string) bool {
	return purpose == restaurantOrderKeyPurpose || purpose == restaurantPaymentKeyPurpose
}

// wrap preserves the supplied existing 32-byte DEK. It does not generate a new
// payload key or touch a database. The fresh 96-bit random GCM nonce is suitable
// for low-volume DEK wrapping, not unbounded bulk payload encryption.
func (r *restaurantKeyring) wrap(purpose, dataKeyID string, key []byte) ([]byte, error) {
	if r == nil || !restaurantKeyPurpose(purpose) || !restaurantKeyIdentifier(dataKeyID, 64) || len(key) != restaurantDEKSize {
		return nil, errRestaurantKeyEnvelope
	}
	seal := r.keys[r.activeKeyID]
	if seal == nil {
		return nil, errRestaurantKeyEnvelope
	}
	envelope := restaurantKeyEnvelope{Version: 1, StoreID: r.storeID, Purpose: purpose, DataKeyID: dataKeyID, WrappingKeyID: r.activeKeyID}
	nonce := make([]byte, seal.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return nil, errRestaurantKeyEnvelope
	}
	envelope.Nonce = base64.StdEncoding.EncodeToString(nonce)
	envelope.Ciphertext = base64.StdEncoding.EncodeToString(seal.Seal(nil, nonce, key, envelope.aad()))
	raw, err := json.Marshal(envelope)
	if err != nil {
		return nil, errRestaurantKeyEnvelope
	}
	return raw, nil
}

func (r *restaurantKeyring) unwrap(purpose, dataKeyID string, raw []byte) ([]byte, error) {
	if r == nil || !restaurantKeyPurpose(purpose) || !restaurantKeyIdentifier(dataKeyID, 64) || len(raw) > restaurantKeyEnvelopeLimit {
		return nil, errRestaurantKeyEnvelope
	}
	_, ok := restaurantKeyObject(raw, "version", "storeId", "purpose", "dataKeyId", "wrappingKeyId", "nonce", "ciphertext")
	var envelope restaurantKeyEnvelope
	if !ok || json.Unmarshal(raw, &envelope) != nil || envelope.Version != 1 ||
		envelope.StoreID != r.storeID || envelope.Purpose != purpose || envelope.DataKeyID != dataKeyID ||
		!restaurantKeyIdentifier(envelope.WrappingKeyID, 64) {
		return nil, errRestaurantKeyEnvelope
	}
	seal := r.keys[envelope.WrappingKeyID]
	if seal == nil {
		return nil, errRestaurantKeyEnvelope
	}
	nonce, nonceOK := restaurantKeyBase64(envelope.Nonce, seal.NonceSize())
	sealed, sealedOK := restaurantKeyBase64(envelope.Ciphertext, restaurantDEKSize+seal.Overhead())
	if !nonceOK || !sealedOK {
		return nil, errRestaurantKeyEnvelope
	}
	key, err := seal.Open(nil, nonce, sealed, envelope.aad())
	if err != nil || len(key) != restaurantDEKSize {
		clear(key)
		return nil, errRestaurantKeyEnvelope
	}
	return key, nil
}
