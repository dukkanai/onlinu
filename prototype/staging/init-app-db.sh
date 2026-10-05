#!/usr/bin/env bash
# Sourced once by the official PostgreSQL entrypoint for a new staging volume.
# No tracing: app credentials are read from a mounted secret and never echoed.
set -euo pipefail

case "${APP_DB:-}:${APP_ROLE:-}" in
  staging_platform:staging_platform_app|\
  staging_restaurant_a:staging_restaurant_a_app|\
  staging_restaurant_b:staging_restaurant_b_app|\
  staging_identity:staging_identity_app) ;;
  *) printf '%s\n' 'Refusing unrecognized staging database/role pair.' >&2; exit 1 ;;
esac
case "${APP_PASSWORD_FILE:-}" in
  /run/secrets/platform_app_password|/run/secrets/tenant_a_app_password|\
  /run/secrets/tenant_b_app_password|/run/secrets/identity_app_password) ;;
  *) printf '%s\n' 'Refusing unexpected application secret path.' >&2; exit 1 ;;
esac

APP_PASSWORD="$(< "$APP_PASSWORD_FILE")"
if [[ ! "$APP_PASSWORD" =~ ^[A-Za-z0-9_-]{43,}$ ]]; then
  printf '%s\n' 'Invalid generated application secret.' >&2
  exit 1
fi
export APP_PASSWORD

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  --set=app_db="$APP_DB" --set=app_role="$APP_ROLE" <<'SQL'
\getenv app_password APP_PASSWORD
CREATE ROLE :"app_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'app_password';
CREATE DATABASE :"app_db" OWNER :"app_role";
REVOKE ALL ON DATABASE :"app_db" FROM PUBLIC;
GRANT CONNECT, TEMPORARY ON DATABASE :"app_db" TO :"app_role";
REVOKE CONNECT ON DATABASE postgres FROM PUBLIC;
REVOKE CONNECT ON DATABASE template1 FROM PUBLIC;
SQL
unset APP_PASSWORD

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$APP_DB" \
  --set=app_role="$APP_ROLE" <<'SQL'
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO :"app_role";
SQL
