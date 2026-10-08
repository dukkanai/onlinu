# Isolated local PostgreSQL testing

Verified October 8, 2026 in the dot cloud workspace, as ordinary user `agent`.
This is a disposable test harness, not a production database or persistent runner.

## Verified binary provenance

Official Debian trixie AMD64 packages were extracted into the workspace without
running package post-install scripts, changing system services or modifying the
system package configuration. Both official SHA256 values were checked before
execution, and the server/client reported PostgreSQL17.11.

- [Server package metadata](https://packages.debian.org/trixie/amd64/postgresql-17/download)
  - `postgresql-17_17.11-0+deb13u1_amd64.deb`
  - SHA256 `d2ce1ddffafa783f9acda4c92c86fc21e8288bff3782d739294f14fa797d7886`
- [Client package metadata](https://packages.debian.org/trixie/amd64/postgresql-client-17/download)
  - `postgresql-client-17_17.11-0+deb13u1_amd64.deb`
  - SHA256 `9d8558f8dd57c8e92e218a20698383575d53742ca3f9e7c2b7fe5f246d5216ae`

Current extraction root is the sibling workspace directory
`.tools/postgresql17/root`; binaries are below `usr/lib/postgresql/17/bin` and
bootstrap data below `usr/share/postgresql/17`. These generated tools and database
files are outside Git. Recheck availability after an environment replacement.

## Isolation and lifetime

- Initialize a new, explicitly owned fixture data directory only. Never point
  this harness at an existing application or production cluster.
- Current fixture role: `onlinu_fixture`; sole restaurant test database:
  `astracalls_restaurant_test`. It has no real customer, account or payment data.
- Listen only on `127.0.0.1`, port55439. Unix sockets are disabled. No firewall,
  DNS, system user, system service or external credential was changed.
- Local host authentication is deliberately fixture-only; it must never be
  copied to a production configuration or used with sensitive data.
- In this execution environment a background postmaster from a completed shell
  command was unavailable in the next command. Keep start, test and stop inside
  the same live command session; do not assume a daemon survives between cells.
- Register a cleanup trap that stops this owned cluster before the command exits.
  Do not remove another process's lock file or adopt an unknown database.
- Use `dynamic_shared_memory_type=mmap` inside the owned fixture and an empty
  Unix socket directory. Server and log timezone are explicitly UTC.

The successful startup used `pg_ctl` with these PostgreSQL options:

```
-h 127.0.0.1 -p 55439 -k '' -c dynamic_shared_memory_type=mmap
-c max_connections=40 -c timezone=UTC -c log_timezone=UTC
```

The test connection (synthetic and local only) was:

```
TEST_RESTAURANT_PG_URL=postgres://onlinu_fixture@127.0.0.1:55439/astracalls_restaurant_test?sslmode=disable
```

Each restaurant integration test verifies that exact database name, creates its
own random schema, and drops only that owned schema. End-of-run checks found zero
remaining `restaurant_it_*` schemas; the cluster then stopped cleanly.

## Accepted local checks

On source316462a (documentation atop accepted code9e4367e):

1. `go test -race -count=1 -v ./cmd/server -run '^TestRestaurantWhatsapp'`
   -25top-level cases passed with real PostgreSQL, no skips.
2. `go test -race -count=1 -json ./cmd/server -run '^TestRestaurant'`
   -191top-level cases passed; only opt-in `TestRestaurantCoreAdapterHTTPParity`
   was skipped in this run.
3. Separate opt-in parity run with `TEST_CORE_ADAPTER=1` and installed platform
   Node dependencies:
   `go test -race -count=1 -v ./cmd/server -run '^TestRestaurantCoreAdapterHTTPParity$'`
   -Passed both original Go HTTP restaurants across five templates and three
   modes, including the Node adapter. This is HTTP/protocol parity, not browser
   screenshot or real external-account acceptance.

These are separate, precisely scoped runs. They do not replace the accepted full
hosted CI (which uses PostgreSQL16), full runtime/codec, mobile, provider-account,
network media or production deployment gates. No real WhatsApp message or payment
was involved.
