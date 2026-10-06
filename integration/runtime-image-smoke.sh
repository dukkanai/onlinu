#!/usr/bin/env bash
# Synthetic acceptance on an ephemeral GitHub runner only; not a deploy script.
set -euo pipefail
[[ "${GITHUB_ACTIONS:-}" == true && "${GITHUB_RUN_ID:-}" =~ ^[0-9]+$ && "${GITHUB_RUN_ATTEMPT:-}" =~ ^[0-9]+$ && "${GITHUB_SHA:-}" =~ ^[a-f0-9]{40}$ && "${RUNNER_TEMP:-}" == /* ]] || {
  echo 'This test requires an ephemeral GitHub Actions runner.' >&2; exit 2;
}
image="${1:?runtime image required}"
[[ "$image" == "onlinu-runtime-smoke:$GITHUB_SHA" ]] || { echo 'Unexpected test image.' >&2; exit 2; }
# Never inherit an explicitly configured remote Docker daemon.
unset DOCKER_HOST DOCKER_CONTEXT
prefix="onlinu-image-smoke-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
network="$prefix-network"
postgres="$prefix-postgres"
runtime="$prefix-runtime"
media="$prefix-media"
root="$(mktemp -d "$RUNNER_TEMP/onlinu-image-smoke.XXXXXXXX")"
owned_runtime=false
owned_postgres=false
owned_media=false
owned_network=false
cleanup() {
  # These are the exact test-owned names, never enumerated production resources.
  if [[ "$owned_runtime" == true ]]; then docker rm -f "$runtime" >/dev/null 2>&1 || true; fi
  if [[ "$owned_postgres" == true ]]; then docker rm -f "$postgres" >/dev/null 2>&1 || true; fi
  if [[ "$owned_media" == true ]]; then docker volume rm "$media" >/dev/null 2>&1 || true; fi
  if [[ "$owned_network" == true ]]; then docker network rm "$network" >/dev/null 2>&1 || true; fi
  # Only generated files in the mktemp-owned directory; no recursive deletion.
  rm -f "$root/admin-key" "$root/runtime-pg-url" "$root/pg-bootstrap" "$root/runtime-password" "$root/response"
  rmdir "$root" 2>/dev/null || true
}
trap cleanup EXIT
redacted_diagnostics() {
  local container="$1"
  [[ "$container" == "$runtime" || "$container" == "$postgres" ]] || return 1
  docker inspect --format 'Runtime status={{.State.Status}} exit={{.State.ExitCode}}' "$container" || true
  docker logs --tail 40 "$container" 2>&1 | sed -E \
    -e 's/synthetic-image-administrator/[fixture-redacted]/g' \
    -e 's/synthetic-runtime-password/[fixture-redacted]/g' \
    -e 's/synthetic-image-bootstrap/[fixture-redacted]/g' \
    -e 's#postgres(ql)?://[^[:space:]]+#[database-url-redacted]#g' || true
}
for container in "$postgres" "$runtime"; do
  if docker container inspect "$container" >/dev/null 2>&1; then
    echo 'Test resource already exists; refusing ownership assumption.' >&2; exit 2
  fi
done
if docker network inspect "$network" >/dev/null 2>&1 || docker volume inspect "$media" >/dev/null 2>&1; then
  echo 'Test resource already exists; refusing ownership assumption.' >&2; exit 2
fi
# Values below are disposable test fixtures, never supplied production keys.
printf '%s\n' 'synthetic-image-administrator' > "$root/admin-key"
printf '%s\n' 'synthetic-image-bootstrap' > "$root/pg-bootstrap"
printf '%s\n' 'synthetic-runtime-password' > "$root/runtime-password"
printf '%s\n' 'postgres://onlinu_runtime:synthetic-runtime-password@fixture-db:5432/postgres?sslmode=disable' > "$root/runtime-pg-url"
chmod 755 "$root"
chmod 444 "$root/admin-key" "$root/runtime-pg-url" "$root/pg-bootstrap" "$root/runtime-password"
docker network create --internal "$network" >/dev/null
owned_network=true
docker volume create "$media" >/dev/null
owned_media=true
docker create --name "$postgres" --network "$network" --network-alias fixture-db \
  --mount "type=bind,source=$root/pg-bootstrap,target=/run/secrets/pg-bootstrap,readonly" \
  --mount "type=bind,source=$root/runtime-password,target=/run/secrets/runtime_password,readonly" \
  --mount "type=bind,source=$PWD/deploy/tenant-bootstrap.sql,target=/docker-entrypoint-initdb.d/10-onlinu.sql,readonly" \
  --env POSTGRES_PASSWORD_FILE=/run/secrets/pg-bootstrap \
  --health-cmd 'pg_isready -h 127.0.0.1 -U postgres -d postgres' --health-interval 2s --health-timeout 2s --health-retries 30 \
  postgres:16 >/dev/null
owned_postgres=true
docker start "$postgres" >/dev/null
for attempt in $(seq 1 60); do
  if [[ "$(docker inspect --format '{{.State.Health.Status}}' "$postgres")" == healthy ]]; then break; fi
  sleep 2
done
[[ "$(docker inspect --format '{{.State.Health.Status}}' "$postgres")" == healthy ]] || { echo 'Fixture PostgreSQL did not become healthy.' >&2; redacted_diagnostics "$postgres"; exit 1; }
[[ "$(docker exec "$postgres" psql -U postgres -d postgres -Atc "SELECT rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls OR NOT rolcreatedb OR NOT rolcanlogin FROM pg_roles WHERE rolname='onlinu_runtime'")" == f ]] || { echo 'Restricted runtime role was not bootstrapped.' >&2; redacted_diagnostics "$postgres"; exit 1; }
# Inspect shipped codec linkage without making any call or provider request.
docker run --rm --network none --entrypoint /bin/sh "$image" -c \
  'test -r /usr/local/lib/libopus_mlow.so && ldd /usr/local/bin/wacalls > /tmp/linkage && ! grep "not found" /tmp/linkage'
docker create --name "$runtime" --network "$network" \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,noexec,nosuid,size=128m,mode=1777 \
  --mount "type=volume,source=$media,target=/data/recordings" \
  --mount "type=bind,source=$root/admin-key,target=/run/secrets/admin-key,readonly" \
  --mount "type=bind,source=$root/runtime-pg-url,target=/run/secrets/runtime-pg-url,readonly" \
  --env WACALLS_API_KEY_FILE=/run/secrets/admin-key \
  --env WACALLS_PG_URL_FILE=/run/secrets/runtime-pg-url \
  --env WACALLS_PLATFORM_ISSUER=https://platform.example.invalid \
  --env WACALLS_PLATFORM_TENANT_ID=runtime-image-fixture \
  --env WACALLS_PLATFORM_PUBLIC_KEY=AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8= \
  --env WACALLS_PUBLIC_BASE_URL=https://restaurant.example.invalid \
  "$image" >/dev/null
owned_runtime=true
docker start "$runtime" >/dev/null
# Probe inside the owned container: an internal-only network need not provide
# host NAT bindings. No HTTP or PostgreSQL ports are published for this smoke.
base="http://127.0.0.1:8080"
probe() { docker exec "$runtime" curl --noproxy '*' --silent --max-time 5 "$@"; }

healthy=false
for attempt in $(seq 1 60); do
  if [[ "$(docker inspect --format '{{.State.Running}}' "$runtime")" != true ]]; then
    echo 'Runtime exited before readiness.' >&2; redacted_diagnostics "$runtime"; exit 1
  fi
  if probe --fail "$base/healthz" > "$root/response" && grep -qx ok "$root/response"; then healthy=true; break; fi
  sleep 2
done
[[ "$healthy" == true ]] || { echo 'Runtime image did not become healthy.' >&2; redacted_diagnostics "$runtime"; exit 1; }
[[ "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$runtime")" == 0 ]]
[[ "$(docker inspect --format '{{.Config.User}}' "$runtime")" == '10001:10001' ]]
[[ "$(docker inspect --format '{{.HostConfig.ReadonlyRootfs}}' "$runtime")" == true ]]
[[ "$(probe --output /dev/null --write-out '%{http_code}' "$base/api/restaurant/catalog")" == 401 ]]
[[ "$(probe --output /dev/null --write-out '%{http_code}' --header 'X-API-Key: synthetic-image-administrator' "$base/api/restaurant/catalog")" == 200 ]]
[[ "$(docker exec "$postgres" psql -U postgres -d postgres -Atc "SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname='wacalls_main'")" == onlinu_runtime ]]
# Do not upload raw runtime logs: assert fixture values were not disclosed.
if docker logs "$runtime" 2>&1 | grep -Eq 'synthetic-image-administrator|synthetic-runtime-password|synthetic-image-bootstrap|postgres://'; then
  echo 'Runtime logs disclosed fixture credentials.' >&2; exit 1
fi
image_id="$(docker image inspect --format '{{.Id}}' "$image")"
python3 - "$RUNNER_TEMP/onlinu-runtime-image-report.json" "$GITHUB_SHA" "$image_id" <<'PY'
import json, sys
with open(sys.argv[1], 'w', encoding='utf-8') as output:
    json.dump({'sourceCommit': sys.argv[2], 'localImageId': sys.argv[3],
               'registryPublished': False, 'productionDeployed': False,
               'checks': ['codec-linkage', 'uid-10001', 'readonly-root', 'file-backed-secrets',
                          'health', 'no-published-runtime-ports', 'administrator-authentication', 'restricted-database-owner', 'file-backed-role-bootstrap',
                          'no-fixture-secret-in-runtime-log'],
               'notVerified': ['real-calls', 'provider-accounts', 'production-routing',
                               'multi-tenant-isolation', 'registry-digest']}, output, indent=2)
PY
