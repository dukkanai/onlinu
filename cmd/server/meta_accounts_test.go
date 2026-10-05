package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"
)

func TestMetaCredentialEncryption(t *testing.T) {
	aead, err := newMetaCipher(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{7}, 32)))
	if err != nil {
		t.Fatal(err)
	}
	m := &metaManager{aead: aead}
	cfg := metaTestConfig()
	one, err := m.sealCredentials("meta_account", cfg)
	if err != nil {
		t.Fatal(err)
	}
	two, err := m.sealCredentials("meta_account", cfg)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(one, two) {
		t.Fatal("encryption reused nonce")
	}
	for _, secret := range []string{cfg.AccessToken, cfg.AppSecret, cfg.VerifyToken} {
		if bytes.Contains(one, []byte(secret)) {
			t.Fatal("ciphertext contains plaintext credential")
		}
	}
	var restored metaConfig
	if err = m.openCredentials("meta_account", one, &restored); err != nil {
		t.Fatal(err)
	}
	if restored.AccessToken != cfg.AccessToken || restored.AppSecret != cfg.AppSecret || restored.VerifyToken != cfg.VerifyToken {
		t.Fatal("credentials failed round trip")
	}
	if err = m.openCredentials("meta_different_account", one, &metaConfig{}); err == nil {
		t.Fatal("credential substitution across accounts accepted")
	}
	one[len(one)-1] ^= 1
	if err = m.openCredentials("meta_account", one, &metaConfig{}); err == nil {
		t.Fatal("tampered ciphertext accepted")
	}
	wrong, _ := newMetaCipher(base64.StdEncoding.EncodeToString(bytes.Repeat([]byte{8}, 32)))
	if err = (&metaManager{aead: wrong}).openCredentials("meta_account", two, &metaConfig{}); err == nil {
		t.Fatal("wrong encryption key accepted")
	}
}

func TestMetaConfigValidationAndMissingEncryption(t *testing.T) {
	if _, err := newMetaCipher(""); err == nil {
		t.Fatal("missing key accepted")
	}
	if _, err := newMetaCipher(base64.StdEncoding.EncodeToString(make([]byte, 16))); err == nil {
		t.Fatal("short key accepted")
	}
	if _, err := (&metaManager{}).sealCredentials("meta_account", metaTestConfig()); err == nil {
		t.Fatal("plaintext fallback accepted")
	}
	cfg := metaTestConfig()
	cfg.APIVersion = ""
	normalized, err := normalizeMetaConfig(cfg)
	if err != nil || normalized.APIVersion != "v24.0" {
		t.Fatalf("default version failed: %+v %v", normalized, err)
	}
	for _, mutate := range []func(*metaConfig){
		func(c *metaConfig) { c.PhoneNumberID = "1/../../x" },
		func(c *metaConfig) { c.WABAID = "not-an-id" },
		func(c *metaConfig) { c.APIVersion = "v24.0/other" },
		func(c *metaConfig) { c.AccessToken = "injected\r\nHeader: value" },
		func(c *metaConfig) { c.AppSecret = "" },
	} {
		bad := metaTestConfig()
		mutate(&bad)
		if _, err := normalizeMetaConfig(bad); err == nil {
			t.Fatal("invalid configuration accepted")
		}
	}
}

func TestMetaPublicAndSessionInfoNeverExposeCredentials(t *testing.T) {
	cfg := metaTestConfig()
	m := &metaManager{accounts: map[string]metaAccount{"meta_account": {ID: "meta_account", Name: "Business", Config: cfg, Verified: true, WebhookVerified: true, CallingEnabled: true}}, order: []string{"meta_account"}, locked: map[string]bool{}}
	public, err := m.Public("meta_account", "https://example.test/")
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(public)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{cfg.AccessToken, cfg.AppSecret, cfg.VerifyToken} {
		if strings.Contains(string(data), secret) {
			t.Fatal("public configuration leaked credentials")
		}
	}
	if !strings.Contains(string(data), `"webhookUrl":"https://example.test/webhooks/whatsapp/meta_account"`) {
		t.Fatalf("incorrect webhook URL: %s", data)
	}
	infos := m.Infos()
	if len(infos) != 1 || infos[0].Provider != "meta" || !infos[0].Paired || infos[0].State != "open" || !infos[0].Capabilities.Audio || infos[0].Capabilities.Video || infos[0].Capabilities.Recording || infos[0].Capabilities.Hold || infos[0].Capabilities.Transfer || infos[0].Capabilities.Messaging {
		t.Fatalf("incorrect capabilities/readiness: %+v", infos)
	}
	a := m.accounts["meta_account"]
	a.SIPEnabled = true
	m.accounts[a.ID] = a
	if m.Infos()[0].Paired {
		t.Fatal("SIP account marked ready for Graph calling")
	}
	a.SIPEnabled = false
	a.WebhookVerified = false
	m.accounts[a.ID] = a
	if m.Infos()[0].Paired {
		t.Fatal("account without verified webhook marked ready")
	}
	a.WebhookVerified = true
	m.accounts[a.ID] = a
	m.locked[a.ID] = true
	if info := m.Infos()[0]; info.Paired || info.State != "error" {
		t.Fatal("locked account marked ready")
	}
	lockedPublic, err := m.Public(a.ID, "https://example.test")
	if err != nil {
		t.Fatal(err)
	}
	locked := lockedPublic.(metaPublicConfig)
	if locked.Verified || locked.WebhookVerified || locked.CredentialsAvailable {
		t.Fatal("locked public config marked verified")
	}
	data, _ = json.Marshal(locked)
	for _, secret := range []string{cfg.AccessToken, cfg.AppSecret, cfg.VerifyToken} {
		if strings.Contains(string(data), secret) {
			t.Fatal("locked public config leaked credentials")
		}
	}
}
