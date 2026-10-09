#!/usr/bin/env bash
# Generate local configuration without displaying or overwriting credentials.
set +x
set -euo pipefail
umask 077
task_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
task_target="${1:-$task_root/.env}"
if [[ -e "$task_target" || -L "$task_target" ]]; then
  printf 'Configuration already exists; unchanged: %s\n' "$task_target"
  exit 0
fi
command -v openssl >/dev/null || { printf 'openssl is required.\n' >&2; exit 1; }
task_api_key="$(openssl rand -hex 32)"
task_db_password="$(openssl rand -hex 32)"
# noclobber also protects against another process creating the file meanwhile.
set -o noclobber
sed \
  -e "s/^WACALLS_API_KEY=.*/WACALLS_API_KEY=$task_api_key/" \
  -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$task_db_password/" \
  "$task_root/.env.example" > "$task_target"
printf 'Created private configuration (mode 600): %s\n' "$task_target"
printf 'Configure HTTPS and the restaurant before accepting orders.\n'
