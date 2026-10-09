package main

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// Only Ping is exercised; the connector keeps readiness tests independent of an
// external PostgreSQL process while still going through database/sql.
type healthTestConnector struct{ ping func(context.Context) error }

func (c healthTestConnector) Connect(context.Context) (driver.Conn, error) {
	return healthTestConn{ping: c.ping}, nil
}
func (healthTestConnector) Driver() driver.Driver { return healthTestDriver{} }

type healthTestDriver struct{}

func (healthTestDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("use connector")
}

type healthTestConn struct{ ping func(context.Context) error }

func (c healthTestConn) Ping(ctx context.Context) error { return c.ping(ctx) }
func (healthTestConn) Close() error                     { return nil }
func (healthTestConn) Prepare(string) (driver.Stmt, error) {
	return nil, errors.New("not supported")
}
func (healthTestConn) Begin() (driver.Tx, error) { return nil, errors.New("not supported") }

func TestHealthMissingDependencies(t *testing.T) {
	for name, srv := range map[string]*server{
		"server":   nil,
		"database": {},
	} {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			srv.handleHealth(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			if w.Code != http.StatusServiceUnavailable || w.Body.String() != "unavailable\n" {
				t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
			}
		})
	}
}

func TestHealthDatabaseReadiness(t *testing.T) {
	for _, tc := range []struct {
		name string
		err  error
		code int
		body string
	}{
		{name: "ready", code: http.StatusOK, body: "ok\n"},
		{name: "database failure", err: errors.New("postgres://user:private-password@database"), code: http.StatusServiceUnavailable, body: "unavailable\n"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pinged := false
			db := sql.OpenDB(healthTestConnector{ping: func(ctx context.Context) error {
				pinged = true
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 2*time.Second {
					t.Error("database health probe needs a timeout of at most two seconds")
				}
				return tc.err
			}})
			t.Cleanup(func() { _ = db.Close() })
			srv := &server{db: db}
			w := httptest.NewRecorder()
			srv.handleHealth(w, httptest.NewRequest(http.MethodGet, "/healthz", nil))
			if !pinged || w.Code != tc.code || w.Body.String() != tc.body {
				t.Fatalf("pinged=%v status=%d body=%q", pinged, w.Code, w.Body.String())
			}
			if w.Header().Get("Content-Type") != "text/plain; charset=utf-8" || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("unexpected response headers: %v", w.Header())
			}
		})
	}
}

func TestHealthRespectsRequestCancellation(t *testing.T) {
	db := sql.OpenDB(healthTestConnector{ping: func(ctx context.Context) error {
		<-ctx.Done()
		return ctx.Err()
	}})
	t.Cleanup(func() { _ = db.Close() })
	srv := &server{db: db}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	w := httptest.NewRecorder()
	srv.handleHealth(w, httptest.NewRequest(http.MethodGet, "/healthz", nil).WithContext(ctx))
	if w.Code != http.StatusServiceUnavailable || w.Body.String() != "unavailable\n" {
		t.Fatalf("status=%d body=%q", w.Code, w.Body.String())
	}
}
