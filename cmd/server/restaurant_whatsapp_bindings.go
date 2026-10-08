package main

import (
	"context"
	"database/sql"
	"encoding/hex"
	"time"

	"github.com/google/uuid"
)

// Private, default-off binding journal. No startup, HTTP route or provider
// callback constructs it. The runtime tenant is fixed independently of input.
// Fingerprint is a digest of verified provider-device identity, not a phone,
// display name or proof of authentication. Resolving it is an adapter obligation.
// Generation is a separate persisted binding revision, never inferred from a
// reconnect, process restart, repeated phone or reusable provider key alone.
type restaurantWhatsappBindings struct {
	db              *sql.DB
	tenant          string
	authorizeChange func(context.Context, *sql.Tx) bool
}
type restaurantWhatsappBindingChange struct {
	RequestID         string
	ExpectedRevision  int64
	Active            bool
	ConnectionID      string
	DeviceFingerprint string
}
type restaurantWhatsappBindingRecord struct {
	Revision          int64
	Generation        string
	Active            bool
	ConnectionID      string
	DeviceFingerprint string
}

func newRestaurantWhatsappBindings(ctx context.Context, db *sql.DB, tenant string) (*restaurantWhatsappBindings, error) {
	if db == nil || !restaurantWhatsappOpaque(tenant) {
		return nil, restaurantFail(400, "invalid_whatsapp_binding")
	}
	_, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS restaurant_whatsapp_bindings (
 restaurant_id TEXT PRIMARY KEY,
 revision BIGINT NOT NULL CHECK(revision>=0), generation TEXT NOT NULL,
 active BOOLEAN NOT NULL, connection_id TEXT NOT NULL, device_fingerprint TEXT NOT NULL,
 changed_at TIMESTAMPTZ NOT NULL,
 CHECK ((active AND connection_id<>'' AND device_fingerprint ~ '^[0-9a-f]{64}$') OR
        (NOT active AND connection_id='' AND device_fingerprint='')),
 CHECK ((revision=0 AND generation='' AND NOT active) OR
        (revision>0 AND generation ~ '^[0-9a-f-]{36}$'))
 );
 CREATE TABLE IF NOT EXISTS restaurant_whatsapp_binding_changes (
 restaurant_id TEXT NOT NULL, request_id UUID NOT NULL, request_hash TEXT NOT NULL,
 revision BIGINT NOT NULL, generation TEXT NOT NULL, changed_at TIMESTAMPTZ NOT NULL,
 PRIMARY KEY(restaurant_id,request_id), UNIQUE(restaurant_id,revision)
 )`)
	if err != nil {
		return nil, err
	}
	return &restaurantWhatsappBindings{db: db, tenant: tenant}, nil
}

func (s *restaurantWhatsappBindings) Change(ctx context.Context, input restaurantWhatsappBindingChange, now time.Time) (restaurantWhatsappBindingRecord, error) {
	empty := restaurantWhatsappBindingRecord{}
	if s == nil || s.db == nil || s.authorizeChange == nil {
		return empty, restaurantFail(403, "whatsapp_binding_unauthorized")
	}
	if len(input.RequestID) != 36 || (input.Active && len(input.DeviceFingerprint) != 64) {
		return empty, restaurantFail(400, "invalid_whatsapp_binding")
	}
	id, err := uuid.Parse(input.RequestID)
	fingerprint, fpErr := hex.DecodeString(input.DeviceFingerprint)
	if err != nil || id == uuid.Nil || id.String() != input.RequestID || input.ExpectedRevision < 0 || now.IsZero() ||
		(input.Active && (!restaurantWhatsappOpaque(input.ConnectionID) || fpErr != nil || len(fingerprint) != 32 || hex.EncodeToString(fingerprint) != input.DeviceFingerprint)) ||
		(!input.Active && (input.ConnectionID != "" || input.DeviceFingerprint != "")) {
		return empty, restaurantFail(400, "invalid_whatsapp_binding")
	}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return empty, err
	}
	defer tx.Rollback()
	// Lock local policy/entitlement before the binding, as dispatch does.
	if !s.authorizeChange(ctx, tx) {
		return empty, restaurantFail(403, "whatsapp_binding_unauthorized")
	}
	// The initial inactive row is transactional; denial leaves no binding behind.
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_whatsapp_bindings(restaurant_id,revision,generation,active,connection_id,device_fingerprint,changed_at)
 VALUES($1,0,'',false,'','',$2) ON CONFLICT DO NOTHING`, s.tenant, now)
	if err != nil {
		return empty, err
	}
	var current restaurantWhatsappBindingRecord
	err = tx.QueryRowContext(ctx, `SELECT revision,generation,active,connection_id,device_fingerprint FROM restaurant_whatsapp_bindings WHERE restaurant_id=$1 FOR UPDATE`, s.tenant).
		Scan(&current.Revision, &current.Generation, &current.Active, &current.ConnectionID, &current.DeviceFingerprint)
	if err != nil {
		return empty, err
	}
	// Fresh authority after lock acquisition. The callback must use this tx, not
	// another pool connection or a remote request, and must not cache entitlement.
	if !s.authorizeChange(ctx, tx) {
		return empty, restaurantFail(403, "whatsapp_binding_unauthorized")
	}
	hash := restaurantWhatsappDigest(input)
	var previousHash, generation string
	var revision int64
	err = tx.QueryRowContext(ctx, `SELECT request_hash,revision,generation FROM restaurant_whatsapp_binding_changes WHERE restaurant_id=$1 AND request_id=$2`, s.tenant, id).
		Scan(&previousHash, &revision, &generation)
	if err == nil {
		if previousHash != hash {
			return empty, restaurantFail(409, "whatsapp_binding_request_conflict")
		}
		if current.Revision != revision || current.Generation != generation {
			return empty, restaurantFail(409, "whatsapp_binding_changed")
		}
		if current.Active != input.Active || current.ConnectionID != input.ConnectionID || current.DeviceFingerprint != input.DeviceFingerprint {
			return empty, restaurantFail(409, "whatsapp_binding_inconsistent")
		}
		return current, tx.Commit()
	}
	if err != sql.ErrNoRows {
		return empty, err
	}
	if current.Revision != input.ExpectedRevision {
		return empty, restaurantFail(409, "whatsapp_binding_changed")
	}
	next := restaurantWhatsappBindingRecord{Revision: current.Revision + 1, Generation: uuid.NewString(), Active: input.Active, ConnectionID: input.ConnectionID, DeviceFingerprint: input.DeviceFingerprint}
	_, err = tx.ExecContext(ctx, `UPDATE restaurant_whatsapp_bindings SET revision=$2,generation=$3,active=$4,connection_id=$5,device_fingerprint=$6,changed_at=$7 WHERE restaurant_id=$1`, s.tenant, next.Revision, next.Generation, next.Active, next.ConnectionID, next.DeviceFingerprint, now)
	if err != nil {
		return empty, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO restaurant_whatsapp_binding_changes(restaurant_id,request_id,request_hash,revision,generation,changed_at) VALUES($1,$2,$3,$4,$5,$6)`, s.tenant, id, hash, next.Revision, next.Generation, now)
	if err != nil {
		return empty, err
	}
	return next, tx.Commit()
}

// RequireCurrent is a LOCAL generation check inside the caller's transaction,
// not transport authentication, subscription authority or permission to send.
// Acquire channel policy before this binding lock, then review head/review/send
// locks. Account changes use the same row exclusively. No network IO under lock.
func (s *restaurantWhatsappBindings) RequireCurrent(ctx context.Context, tx *sql.Tx, scope restaurantWhatsappScope, fingerprint string) error {
	if s == nil || tx == nil || !restaurantWhatsappValidScope(scope) || scope.RestaurantID != s.tenant || scope.Channel != "whatsapp_qr" {
		return restaurantFail(403, "whatsapp_scope_mismatch")
	}
	current, err := s.Resolve(ctx, tx, scope.ConnectionID, fingerprint)
	if err != nil {
		return err
	}
	if current.Generation != scope.Generation {
		return restaurantFail(403, "whatsapp_scope_mismatch")
	}
	return nil
}

// Resolve accepts only identity already established by the transport adapter.
// It returns the persisted epoch after restart; it never silently creates or
// repairs a binding based on matching account text. It grants no send authority.
func (s *restaurantWhatsappBindings) Resolve(ctx context.Context, tx *sql.Tx, connection, fingerprint string) (restaurantWhatsappQRBinding, error) {
	empty := restaurantWhatsappQRBinding{}
	if s == nil || tx == nil || !restaurantWhatsappOpaque(connection) {
		return empty, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	var generation, savedConnection, savedFingerprint string
	var active bool
	err := tx.QueryRowContext(ctx, `SELECT active,connection_id,generation,device_fingerprint FROM restaurant_whatsapp_bindings WHERE restaurant_id=$1 FOR SHARE`, s.tenant).
		Scan(&active, &savedConnection, &generation, &savedFingerprint)
	if err == sql.ErrNoRows {
		return empty, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	if err != nil {
		return empty, err
	}
	if !active || connection != savedConnection || fingerprint != savedFingerprint || !restaurantWhatsappOpaque(generation) {
		return empty, restaurantFail(403, "whatsapp_scope_mismatch")
	}
	return restaurantWhatsappQRBinding{RestaurantID: s.tenant, ConnectionID: connection, Generation: generation}, nil
}
