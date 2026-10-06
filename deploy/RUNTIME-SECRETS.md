# File-backed restaurant runtime secrets

The Go restaurant runtime now supports explicitly configured, read-only secret
files as an alternative to its existing environment values. This prepares later
isolated deployment tooling; it does not provision a tenant, create credentials,
rotate a key, change permissions or deploy anything by itself. The current offline
installer remains compatible with its existing `.env` configuration.

## Supported names

| Existing variable | Optional file variable | Purpose |
| --- | --- | --- |
| `WACALLS_API_KEY` | `WACALLS_API_KEY_FILE` | Existing tenant administrator/API authentication and cookie namespace |
| `WACALLS_PG_URL` | `WACALLS_PG_URL_FILE` | Existing PostgreSQL maintenance connection used by the per-session database provider |
| `WACALLS_META_ENCRYPTION_KEY` | `WACALLS_META_ENCRYPTION_KEY_FILE` | Existing encryption key for persisted Meta credentials |
| `WACALLS_WIDGET_KEY` | `WACALLS_WIDGET_KEY_FILE` | Existing limited widget authentication |
| `OPENAI_API_KEY` | `OPENAI_API_KEY_FILE` | Optional existing translation/archive AI provider access |

These are names, not requests to paste credentials into chat or Git. Supply
existing credentials only through the approved private deployment handoff.
The central Node control plane has its own separately documented file settings;
its private service-signing key must not be installed in restaurant containers.

## Startup contract

- A nonempty environment value together with its `_FILE` setting is rejected.
  Missing, empty, non-regular, symlinked, oversized or invalid text files also fail
  startup. Configuration failure never falls back to unauthenticated startup.
- Files must be UTF-8 single-line values, at most 64 KiB. Terminal CR/LF is removed;
  meaningful spaces are preserved. NUL or interior CR/LF is rejected. The original
  consumer still validates its own credential/connection format.
- All declared sources are validated before any file-backed value is installed.
  Error messages name only the supported setting, not its path, contents or wrapped
  filesystem error. Reads are bounded even if a file grows after its metadata check.
- File-backed values are cached in process memory at startup. They are not copied
  into `os.Environ` or automatically placed as raw values in child-process
  environments. This is not protection against code with access to the same secret
  mount, process memory or host administrator privileges.
- Existing environment-only behavior remains supported. An explicitly supplied
  `-pg-url` still overrides the configured default, including an explicit empty
  value. CLI help no longer prints a configured database URL as a flag default.
- PostgreSQL connection setup errors do not echo the raw URL or driver parse error.
  Failed startup closes its provisional connection pool. This is a narrow startup
  diagnostic improvement, not a claim that every historical log path is audited.

Mount only the intended existing secret files, read-only and accessible to the
runtime's existing UID 10001. Any real credential, mount-permission, network or
production change remains a separate approved operation. No automatic key
replacement or file permission changes are performed. Keep the existing Meta
key: replacing it can make stored credentials unreadable. File changes take
effect only after a separately controlled restart.

## SaaS administrator authentication

When signed platform access is configured, startup also requires the original
`WACALLS_API_KEY` (or its file-backed equivalent). Signed service authentication
does not secure the separate original administrator API by itself. A missing
administrator key now fails before database initialization. Legacy non-platform
startup behavior is unchanged.

## Database isolation constraint

The original provider creates a main database and one database per WhatsApp
session. It requires `CREATEDB`. A future isolated deployment must retain that
capability within the restaurant's dedicated PostgreSQL instance while avoiding
superuser access and any access to another tenant's database/network. Merely
removing `CREATEDB` from a shared role would break original functionality.
This constraint is not proof that provisioning is implemented or accepted.

## Local evidence — 2026-10-06

Race-enabled tests cover source ambiguity, bounded reads, missing/invalid files,
symlink denial, meaningful spaces, all-or-nothing validation and private errors.
Isolated subprocesses exercise actual `main` help and explicit empty override,
and verify file-backed translation/archive guards and cookie isolation without
exporting raw values. Malformed PostgreSQL URL diagnostics are checked for leaks.

Related original authentication, Meta configuration, translation, archive,
restaurant HTTP and core/customer/tax Node/Dart integration regressions pass with
synthetic PostgreSQL. Platform tests pass (230). Commit `38c60fe` passed all jobs in
[CI37401147861](https://github.com/dukkanai/onlinu/actions/runs/37401147861).
Runtime image acceptance remains separate. No real
provider request, production credential read/rotation or deployment occurred.

## Actual-main startup smoke (next increment)

`TEST_RUNTIME_MAIN=1` enables the actual production entrypoint smoke in the Go
server tests. It requires the dedicated loopback test database URL, creates a
randomly named owned fixture database, and removes only that database after the
owned child exits. Synthetic secret files feed the real startup loader. The test
checks health, rejection of missing/wrong administrator keys, a successful
file-backed key, signed service reads, and credential-free logs. It does not open
a WhatsApp session or make provider calls.

A follow-on local test creates a random, temporary runtime role with `LOGIN`
and `CREATEDB`, explicitly without superuser, role-management, replication or
row-security bypass. The actual runtime connects with that role, creates its
owned main database and serves the same authenticated reads. The test checks
role flags and database ownership before removing only its own database and
role. The test harness alone uses the fixture administrator for setup/cleanup.
This confirms the tested startup does not require superuser; it does not prove
cross-tenant network/database isolation or WhatsApp session lifecycle coverage.
Dedicated PostgreSQL instances and production acceptance remain required.
This restricted-role extension passed local race tests and all jobs in
[CI37406247021](https://github.com/dukkanai/onlinu/actions/runs/37406247021)
for commit `2c4fb7f`.

The new guard and actual-main smoke pass local race tests. Commit `9812807`
passed all jobs in [CI37405031722](https://github.com/dukkanai/onlinu/actions/runs/37405031722),
including the enabled actual-main smoke. This is not production deployment or
acceptance of a container image, tenant isolation or external providers.
