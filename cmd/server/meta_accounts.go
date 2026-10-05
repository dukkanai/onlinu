package main

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"
)

type metaConfig struct {
	PhoneNumberID string `json:"phoneNumberId"`
	WABAID        string `json:"wabaId"`
	APIVersion    string `json:"apiVersion"`
	AccessToken   string `json:"accessToken"`
	AppSecret     string `json:"appSecret"`
	VerifyToken   string `json:"verifyToken"`
}

type metaAccount struct {
	ID, Name                                              string
	Config                                                metaConfig
	Verified, WebhookVerified, CallingEnabled, SIPEnabled bool
	LastChecked                                           time.Time
}

func (a metaAccount) ready() bool {
	return a.Verified && a.WebhookVerified && a.CallingEnabled && !a.SIPEnabled
}

// Config errors are safe for HTTP responses. Storage errors intentionally stay
// unwrapped so routing can report a generic 500 without database details.
type metaConfigError struct {
	Status  int
	Message string
}

func (e *metaConfigError) Error() string { return e.Message }
func metaInvalid(message string) error   { return &metaConfigError{Status: 400, Message: message} }
func metaMissing() error                 { return &metaConfigError{Status: 404, Message: "Meta connection not found"} }

type metaManager struct {
	db       *sql.DB
	graph    *metaGraphClient
	mu       sync.RWMutex
	accounts map[string]metaAccount
	order    []string
	locked   map[string]bool
	aead     cipher.AEAD
}

type metaPublicConfig struct {
	PhoneNumberID        string     `json:"phoneNumberId"`
	WABAID               string     `json:"wabaId"`
	APIVersion           string     `json:"apiVersion"`
	WebhookURL           string     `json:"webhookUrl"`
	HasAccessToken       bool       `json:"hasAccessToken"`
	HasAppSecret         bool       `json:"hasAppSecret"`
	HasVerifyToken       bool       `json:"hasVerifyToken"`
	CredentialsAvailable bool       `json:"credentialsAvailable"`
	Verified             bool       `json:"verified"`
	WebhookVerified      bool       `json:"webhookVerified"`
	CallingEnabled       bool       `json:"callingEnabled"`
	SIPEnabled           bool       `json:"sipEnabled"`
	LastChecked          *time.Time `json:"lastChecked"`
}

func newMetaCipher(encodedKey string) (cipher.AEAD, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(encodedKey))
	if err != nil || len(key) != 32 {
		return nil, errors.New("WACALLS_META_ENCRYPTION_KEY must be a base64-encoded 32-byte key")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errors.New("invalid Meta encryption key")
	}
	return cipher.NewGCM(block)
}

func newMetaManager(ctx context.Context, db *sql.DB) (*metaManager, error) {
	m := &metaManager{db: db, graph: &metaGraphClient{}, accounts: map[string]metaAccount{}, locked: map[string]bool{}}
	// A missing/unusable key disables only this provider, not existing QR
	// connections. Never regenerate a key over an existing encrypted database.
	m.aead, _ = newMetaCipher(os.Getenv("WACALLS_META_ENCRYPTION_KEY"))
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS meta_accounts (
		id TEXT PRIMARY KEY,
		name TEXT NOT NULL,
		phone_number_id TEXT NOT NULL UNIQUE,
		waba_id TEXT NOT NULL,
		api_version TEXT NOT NULL,
		credentials BYTEA NOT NULL,
		verified BOOLEAN NOT NULL DEFAULT false,
		webhook_verified BOOLEAN NOT NULL DEFAULT false,
		calling_enabled BOOLEAN NOT NULL DEFAULT false,
		sip_enabled BOOLEAN NOT NULL DEFAULT false,
		last_checked TIMESTAMPTZ,
		created_at TIMESTAMPTZ NOT NULL DEFAULT now()
	)`)
	if err != nil {
		return nil, err
	}
	rows, err := db.QueryContext(ctx, `SELECT id,name,phone_number_id,waba_id,api_version,credentials,verified,webhook_verified,calling_enabled,sip_enabled,last_checked FROM meta_accounts ORDER BY created_at,id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var a metaAccount
		var blob []byte
		var checked sql.NullTime
		if err = rows.Scan(&a.ID, &a.Name, &a.Config.PhoneNumberID, &a.Config.WABAID, &a.Config.APIVersion, &blob, &a.Verified, &a.WebhookVerified, &a.CallingEnabled, &a.SIPEnabled, &checked); err != nil {
			return nil, err
		}
		if checked.Valid {
			a.LastChecked = checked.Time
		}
		if err = m.openCredentials(a.ID, blob, &a.Config); err != nil {
			m.locked[a.ID] = true
			a.Verified = false
			a.WebhookVerified = false
		}
		m.accounts[a.ID] = a
		m.order = append(m.order, a.ID)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	return m, nil
}

type metaCredentials struct {
	AccessToken string `json:"accessToken"`
	AppSecret   string `json:"appSecret"`
	VerifyToken string `json:"verifyToken"`
}

func (m *metaManager) sealCredentials(id string, cfg metaConfig) ([]byte, error) {
	if m.aead == nil {
		return nil, &metaConfigError{Status: 503, Message: "Meta credential encryption is unavailable; configure WACALLS_META_ENCRYPTION_KEY"}
	}
	plain, err := json.Marshal(metaCredentials{cfg.AccessToken, cfg.AppSecret, cfg.VerifyToken})
	if err != nil {
		return nil, errors.New("could not encode Meta credentials")
	}
	nonce := make([]byte, m.aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return nil, errors.New("could not encrypt Meta credentials")
	}
	return m.aead.Seal(nonce, nonce, plain, []byte("astracalls-meta-v1:"+id)), nil
}

func (m *metaManager) openCredentials(id string, blob []byte, cfg *metaConfig) error {
	if m.aead == nil || len(blob) < m.aead.NonceSize() {
		return errors.New("Meta credentials unavailable")
	}
	plain, err := m.aead.Open(nil, blob[:m.aead.NonceSize()], blob[m.aead.NonceSize():], []byte("astracalls-meta-v1:"+id))
	if err != nil {
		return errors.New("Meta credentials unavailable")
	}
	var credentials metaCredentials
	if json.Unmarshal(plain, &credentials) != nil {
		return errors.New("Meta credentials unavailable")
	}
	cfg.AccessToken, cfg.AppSecret, cfg.VerifyToken = credentials.AccessToken, credentials.AppSecret, credentials.VerifyToken
	return nil
}

func normalizeMetaConfig(cfg metaConfig) (metaConfig, error) {
	cfg.PhoneNumberID = strings.TrimSpace(cfg.PhoneNumberID)
	cfg.WABAID = strings.TrimSpace(cfg.WABAID)
	cfg.APIVersion = strings.TrimSpace(cfg.APIVersion)
	if cfg.APIVersion == "" {
		cfg.APIVersion = metaDefaultAPIVersion
	}
	if !metaDigits.MatchString(cfg.PhoneNumberID) || !metaDigits.MatchString(cfg.WABAID) {
		return cfg, metaInvalid("phoneNumberId and wabaId must contain only digits")
	}
	if !metaVersion.MatchString(cfg.APIVersion) {
		return cfg, metaInvalid("apiVersion must have the form v24.0")
	}
	for _, secret := range []string{cfg.AccessToken, cfg.AppSecret, cfg.VerifyToken} {
		if len(secret) == 0 || len(secret) > 8192 || strings.ContainsAny(secret, "\r\n\x00") {
			return cfg, metaInvalid("all Meta credentials are required and must be valid single-line values")
		}
	}
	return cfg, nil
}

func (m *metaManager) Account(id string) (metaAccount, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.accounts[id]
	return a, ok
}

func (m *metaManager) Infos() []SessionInfo {
	m.mu.RLock()
	defer m.mu.RUnlock()
	out := make([]SessionInfo, 0, len(m.order))
	for _, id := range m.order {
		a, ok := m.accounts[id]
		if !ok {
			continue
		}
		state := "configured"
		if a.ready() {
			state = "open"
		}
		if m.locked[id] {
			state = "error"
		}
		out = append(out, SessionInfo{ID: a.ID, Name: a.Name, JID: a.Config.PhoneNumberID, State: state, Paired: a.ready() && !m.locked[id], Provider: "meta", Capabilities: &SessionCapabilities{Audio: true}})
	}
	return out
}

func (m *metaManager) Create(ctx context.Context, name string, cfg metaConfig) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" {
		name = "WhatsApp Business"
	}
	if len(name) > 200 {
		return "", metaInvalid("connection name is too long")
	}
	cfg, err := normalizeMetaConfig(cfg)
	if err != nil {
		return "", err
	}
	id := "meta_" + newSessionID()
	blob, err := m.sealCredentials(id, cfg)
	if err != nil {
		return "", err
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, a := range m.accounts {
		if a.Config.PhoneNumberID == cfg.PhoneNumberID {
			return "", &metaConfigError{Status: 409, Message: "this Meta phone number already has a connection"}
		}
	}
	_, err = m.db.ExecContext(ctx, `INSERT INTO meta_accounts(id,name,phone_number_id,waba_id,api_version,credentials) VALUES($1,$2,$3,$4,$5,$6)`, id, name, cfg.PhoneNumberID, cfg.WABAID, cfg.APIVersion, blob)
	if err != nil {
		return "", err
	}
	m.accounts[id] = metaAccount{ID: id, Name: name, Config: cfg}
	m.order = append(m.order, id)
	return id, nil
}

func (m *metaManager) Update(ctx context.Context, id string, cfg metaConfig) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return metaMissing()
	}
	if m.locked[id] {
		return &metaConfigError{Status: 503, Message: "restore the Meta encryption key before editing this connection"}
	}
	if cfg.AccessToken == "" {
		cfg.AccessToken = a.Config.AccessToken
	}
	if cfg.AppSecret == "" {
		cfg.AppSecret = a.Config.AppSecret
	}
	if cfg.VerifyToken == "" {
		cfg.VerifyToken = a.Config.VerifyToken
	}
	cfg, err := normalizeMetaConfig(cfg)
	if err != nil {
		return err
	}
	for otherID, other := range m.accounts {
		if otherID != id && other.Config.PhoneNumberID == cfg.PhoneNumberID {
			return &metaConfigError{Status: 409, Message: "this Meta phone number already has a connection"}
		}
	}
	blob, err := m.sealCredentials(id, cfg)
	if err != nil {
		return err
	}
	if cfg != a.Config {
		a.Verified = false
		a.CallingEnabled = false
		a.SIPEnabled = false
		a.LastChecked = time.Time{}
		if cfg.PhoneNumberID != a.Config.PhoneNumberID || cfg.WABAID != a.Config.WABAID || cfg.AppSecret != a.Config.AppSecret || cfg.VerifyToken != a.Config.VerifyToken {
			a.WebhookVerified = false
		}
	}
	a.Config = cfg
	_, err = m.db.ExecContext(ctx, `UPDATE meta_accounts SET phone_number_id=$2,waba_id=$3,api_version=$4,credentials=$5,verified=$6,webhook_verified=$7,calling_enabled=$8,sip_enabled=$9,last_checked=$10 WHERE id=$1`, id, cfg.PhoneNumberID, cfg.WABAID, cfg.APIVersion, blob, a.Verified, a.WebhookVerified, a.CallingEnabled, a.SIPEnabled, metaCheckedTime(a.LastChecked))
	if err != nil {
		return err
	}
	m.accounts[id] = a
	return nil
}

func metaCheckedTime(t time.Time) any {
	if t.IsZero() {
		return nil
	}
	return t
}

func (m *metaManager) Delete(ctx context.Context, id string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if _, ok := m.accounts[id]; !ok {
		return metaMissing()
	}
	if _, err := m.db.ExecContext(ctx, `DELETE FROM meta_accounts WHERE id=$1`, id); err != nil {
		return err
	}
	delete(m.accounts, id)
	delete(m.locked, id)
	for i, v := range m.order {
		if v == id {
			m.order = append(m.order[:i], m.order[i+1:]...)
			break
		}
	}
	return nil
}

func (m *metaManager) Verify(ctx context.Context, id string) error {
	a, ok := m.Account(id)
	if !ok {
		return metaMissing()
	}
	if a.Config.AccessToken == "" {
		return &metaConfigError{Status: 503, Message: "Meta credentials are unavailable; restore the encryption key"}
	}
	calling, sip, verifyErr := m.graph.Verify(ctx, a.Config)
	m.mu.Lock()
	defer m.mu.Unlock()
	current, ok := m.accounts[id]
	if !ok {
		return metaMissing()
	}
	if current.Config != a.Config {
		return &metaConfigError{Status: 409, Message: "Meta configuration changed; verify it again"}
	}
	current.Verified = verifyErr == nil
	current.CallingEnabled = calling
	current.SIPEnabled = sip
	current.LastChecked = time.Now().UTC()
	if _, err := m.db.ExecContext(ctx, `UPDATE meta_accounts SET verified=$2,calling_enabled=$3,sip_enabled=$4,last_checked=$5 WHERE id=$1`, id, current.Verified, calling, sip, current.LastChecked); err != nil {
		return err
	}
	m.accounts[id] = current
	return verifyErr
}

func (m *metaManager) MarkWebhookVerified(ctx context.Context, id string) error {
	return m.markWebhookVerified(ctx, id, "", false)
}
func (m *metaManager) MarkWebhookVerifiedToken(ctx context.Context, id, token string) error {
	return m.markWebhookVerified(ctx, id, token, true)
}
func (m *metaManager) markWebhookVerified(ctx context.Context, id, token string, checkToken bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	a, ok := m.accounts[id]
	if !ok {
		return metaMissing()
	}
	if m.locked[id] || a.Config.VerifyToken == "" {
		return &metaConfigError{Status: 503, Message: "Meta credentials are unavailable"}
	}
	if checkToken && subtle.ConstantTimeCompare([]byte(token), []byte(a.Config.VerifyToken)) != 1 {
		return &metaConfigError{Status: 403, Message: "invalid webhook verification token"}
	}
	if _, err := m.db.ExecContext(ctx, `UPDATE meta_accounts SET webhook_verified=true WHERE id=$1`, id); err != nil {
		return err
	}
	a.WebhookVerified = true
	m.accounts[id] = a
	return nil
}

func (m *metaManager) Public(id, baseURL string) (any, error) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	a, ok := m.accounts[id]
	if !ok {
		return nil, metaMissing()
	}
	public := metaPublicConfig{
		PhoneNumberID: a.Config.PhoneNumberID, WABAID: a.Config.WABAID, APIVersion: a.Config.APIVersion,
		WebhookURL:     strings.TrimRight(baseURL, "/") + "/webhooks/whatsapp/" + a.ID,
		HasAccessToken: a.Config.AccessToken != "" || m.locked[id], HasAppSecret: a.Config.AppSecret != "" || m.locked[id], HasVerifyToken: a.Config.VerifyToken != "" || m.locked[id], CredentialsAvailable: !m.locked[id],
		Verified: a.Verified && !m.locked[id], WebhookVerified: a.WebhookVerified && !m.locked[id], CallingEnabled: a.CallingEnabled, SIPEnabled: a.SIPEnabled,
	}
	if !a.LastChecked.IsZero() {
		checked := a.LastChecked
		public.LastChecked = &checked
	}
	return public, nil
}

func safeMetaConfigError(err error) (int, string) {
	var configErr *metaConfigError
	if errors.As(err, &configErr) {
		return configErr.Status, configErr.Message
	}
	var graphErr *metaGraphError
	if errors.As(err, &graphErr) {
		return 502, graphErr.Error()
	}
	return 500, fmt.Sprint("Meta operation failed")
}
