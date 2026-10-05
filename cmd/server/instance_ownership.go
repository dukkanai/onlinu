package main

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"database/sql/driver"
	"encoding/binary"
	"errors"
	"sync"
	"sync/atomic"
	"time"
)

var errInstanceAlreadyRunning = errors.New("another application already owns this database namespace; use a separate namespace for an independent restaurant")

// A dedicated PostgreSQL session, not a process-local mutex, owns the instance.
// This intentionally enforces single-active operation for WhatsApp sessions;
// it is not an active-active cluster/failover implementation.
type instanceOwnership struct {
	conn      *sql.Conn
	key       int64
	pid       int
	healthy   atomic.Bool
	closeOnce sync.Once
}

func acquireInstanceOwnership(ctx context.Context, db *sql.DB, namespace string) (*instanceOwnership, error) {
	conn, err := db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	digest := sha256.Sum256([]byte("astracalls-instance-owner-v1\x00" + namespace))
	owner := &instanceOwnership{conn: conn, key: int64(binary.BigEndian.Uint64(digest[:8]))}
	var acquired bool
	err = conn.QueryRowContext(ctx, `SELECT pg_try_advisory_lock($1), pg_backend_pid()`, owner.key).Scan(&acquired, &owner.pid)
	if err != nil || !acquired {
		// Discard the dedicated connection, including any ambiguous acquisition.
		owner.Close()
		if err != nil {
			return nil, err
		}
		return nil, errInstanceAlreadyRunning
	}
	owner.healthy.Store(true)
	return owner, nil
}

func (o *instanceOwnership) check(ctx context.Context) error {
	if o == nil || !o.healthy.Load() {
		return errors.New("instance ownership unavailable")
	}
	var pid int
	if err := o.conn.QueryRowContext(ctx, `SELECT pg_backend_pid()`).Scan(&pid); err != nil || pid != o.pid {
		o.healthy.Store(false)
		return errors.New("instance ownership connection lost")
	}
	return nil
}

func (o *instanceOwnership) Monitor(ctx context.Context, lost func()) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			checkCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
			err := o.check(checkCtx)
			cancel()
			if err != nil {
				if ctx.Err() == nil {
					lost()
				}
				return
			}
		}
	}
}

func (o *instanceOwnership) Close() {
	if o == nil {
		return
	}
	o.closeOnce.Do(func() {
		o.healthy.Store(false)
		// A session advisory lock must never be returned to a reusable pool.
		// ErrBadConn tells database/sql to dispose of the physical connection.
		_ = o.conn.Raw(func(any) error { return driver.ErrBadConn })
		_ = o.conn.Close()
	})
}
