#!/usr/bin/env bash
# Exercise a pre-built image without touching existing Compose deployments.
# Usage: ASTRACALLS_IMAGE=astracalls-translation:0.3.0 bash scripts/docker-smoke.sh
# Dependencies: Docker Compose v2, curl, jq, openssl, and Python 3.
set +x # Never expose generated credentials, even when invoked with bash -x.
set -Eeuo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
project_dir="$(cd -- "$script_dir/.." && pwd)"
compose_file="$project_dir/compose.translation.yml"
image="${ASTRACALLS_IMAGE:-astracalls-translation:0.3.0}"
current_check='dependency checks'

fail() {
    printf 'FAIL: %s\n' "$*" >&2
    exit 1
}

for dependency in docker curl jq openssl python3; do
    command -v "$dependency" >/dev/null || fail "Required command is missing: $dependency"
done
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is required.'
docker info >/dev/null 2>&1 || fail 'Docker is not available.'
docker image inspect "$image" >/dev/null 2>&1 || fail 'Build the application image before running this test.'
docker image inspect postgres:16-bookworm >/dev/null 2>&1 || fail 'Pull postgres:16-bookworm before running this test.'
[[ -f "$compose_file" ]] || fail 'compose.translation.yml was not found.'

# Select distinct localhost ports that currently accept both TCP and UDP binds.
# Sockets are released before Compose starts; a concurrent bind fails safely.
ports="$(python3 - <<'PY'
import socket

sockets = []
ports = []
try:
    while len(ports) < 4:
        tcp = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tcp.bind(("127.0.0.1", 0))
        port = tcp.getsockname()[1]
        udp = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            udp.bind(("127.0.0.1", port))
        except OSError:
            tcp.close()
            udp.close()
            continue
        sockets.extend((tcp, udp))
        ports.append(str(port))
    print(" ".join(ports))
finally:
    for sock in sockets:
        sock.close()
PY
)"
read -r http_a media_a http_b media_b <<< "$ports"

run_id="$(openssl rand -hex 8)"
project_a="astracalls-smoke-${run_id}-a"
project_b="astracalls-smoke-${run_id}-b"
key_a="$(openssl rand -hex 32)"
key_b="$(openssl rand -hex 32)"
password_a="$(openssl rand -hex 32)"
password_b="$(openssl rand -hex 32)"
created_a=false
created_b=false

compose() {
    local instance="$1"
    shift
    local project key password http_port media_port
    case "$instance" in
        a) project="$project_a"; key="$key_a"; password="$password_a"; http_port="$http_a"; media_port="$media_a" ;;
        b) project="$project_b"; key="$key_b"; password="$password_b"; http_port="$http_b"; media_port="$media_b" ;;
        *) fail 'Unknown test instance.' ;;
    esac
    # Ignore the user's .env and explicitly replace deployment credentials and
    # bindings. Credentials remain in process environments and are never logged.
    ASTRACALLS_IMAGE="$image" \
    POSTGRES_IMAGE=postgres:16-bookworm \
    POSTGRES_PASSWORD="$password" \
    WACALLS_API_KEY="$key" \
    OPENAI_API_KEY='' \
    WACALLS_META_ENCRYPTION_KEY='' \
    WACALLS_PUBLIC_BASE_URL='' \
    WACALLS_HTTP_BIND=127.0.0.1 \
    WACALLS_HTTP_PORT="$http_port" \
    WACALLS_PUBLIC_IP=127.0.0.1 \
    WACALLS_MEDIA_BIND=127.0.0.1 \
    WACALLS_UDP_PORT="$media_port" \
    WACALLS_PG_NAMESPACE=wacalls \
    WACALLS_RECORDING_DIR=/data/recordings \
        docker compose --project-directory "$project_dir" --env-file /dev/null \
        --project-name "$project" --file "$compose_file" "$@"
}

cleanup() {
    local status=$?
    trap - EXIT ERR INT TERM
    set +e
    local cleanup_failed=false
    if [[ "$created_b" == true ]]; then
        compose b down --volumes --timeout 10 >/dev/null 2>&1 || cleanup_failed=true
    fi
    if [[ "$created_a" == true ]]; then
        compose a down --volumes --timeout 10 >/dev/null 2>&1 || cleanup_failed=true
    fi
    if [[ "$cleanup_failed" == true ]]; then
        printf 'Cleanup failed for test projects %s and/or %s; inspect these exact projects.\n' "$project_a" "$project_b" >&2
        status=1
    fi
    exit "$status"
}

trap cleanup EXIT
trap 'printf "FAIL during: %s (credentials and container logs withheld).\n" "$current_check" >&2' ERR
trap 'exit 130' INT
trap 'exit 143' TERM

for project in "$project_a" "$project_b"; do
    [[ -z "$(docker ps --all --quiet --filter "label=com.docker.compose.project=$project")" ]] || fail 'Test project already has containers.'
    [[ -z "$(docker volume ls --quiet --filter "label=com.docker.compose.project=$project")" ]] || fail 'Test project already has volumes.'
    [[ -z "$(docker network ls --quiet --filter "label=com.docker.compose.project=$project")" ]] || fail 'Test project already has networks.'
done

# A future Compose edit must not redirect the smoke test to shared resources.
current_check='checking project-scoped volumes and networks'
for instance in a b; do
    compose "$instance" config --format json 2>/dev/null | jq -e '
        .name as $project |
        ((.volumes // {}) | to_entries | all(
            (.value.external // false) == false and
            (.value.name | startswith($project + "_")))) and
        ((.networks // {}) | to_entries | all(
            (.value.external // false) == false and
            (.value.name | startswith($project + "_")))) and
        (.services | to_entries | all(.value.container_name == null)) and
        (.services | to_entries | all(
            (.value.volumes // []) | all(.type == "volume")))
    ' >/dev/null || fail 'Compose must use project-scoped resources without bind mounts or fixed container names.'
done

printf 'Starting two isolated localhost test instances with translation disabled.\n'
current_check='starting instance A'
created_a=true
compose a up --detach --no-build --pull never --wait --wait-timeout 180 >/dev/null 2>&1
current_check='starting instance B'
created_b=true
compose b up --detach --no-build --pull never --wait --wait-timeout 180 >/dev/null 2>&1

status_code() {
    local url="$1" key="${2:-}"
    if [[ -n "$key" ]]; then
        printf 'X-API-Key: %s\n' "$key" | curl --silent --show-error --max-time 10 \
            --header @- --output /dev/null --write-out '%{http_code}' "$url"
    else
        curl --silent --show-error --max-time 10 --output /dev/null --write-out '%{http_code}' "$url"
    fi
}

verify_http() {
    local port="$1" key="$2" other_key="$3"
    local base="http://127.0.0.1:$port"
    [[ "$(status_code "$base/healthz")" == 200 ]] || fail 'Database-backed health check failed.'
    [[ "$(status_code "$base/")" == 200 ]] || fail 'Frontend did not return HTTP 200.'
    [[ "$(status_code "$base/api/config")" == 401 ]] || fail 'Unauthenticated API request was not rejected.'
    [[ "$(status_code "$base/api/config" "$other_key")" == 401 ]] || fail 'The other instance API key was not rejected.'
    [[ "$(status_code "$base/api/config" "$key")" == 200 ]] || fail 'Authenticated API request failed.'
    printf 'X-API-Key: %s\n' "$key" | curl --silent --show-error --fail --max-time 10 \
        --header @- "$base/api/config" | jq -e '.translationEnabled == false' >/dev/null \
        || fail 'Translation must stay disabled without an OpenAI API key.'
}

current_check='HTTP, frontend, authentication, and API key isolation'
verify_http "$http_a" "$key_a" "$key_b"
verify_http "$http_b" "$key_b" "$key_a"
printf 'PASS: frontend, health, API authentication, and API key isolation.\n'

query() {
    local instance="$1" sql="$2"
    compose "$instance" exec -T postgres psql --no-psqlrc --username astracalls \
        --dbname wacalls_main --tuples-only --no-align --set ON_ERROR_STOP=1 \
        --command "$sql" 2>/dev/null
}

current_check='database isolation'
query a "CREATE TABLE docker_smoke_marker (value text PRIMARY KEY); INSERT INTO docker_smoke_marker VALUES ('persisted');" >/dev/null
[[ "$(query a "SELECT value FROM docker_smoke_marker;")" == persisted ]] || fail 'Database marker write failed.'
[[ "$(query b "SELECT to_regclass('public.docker_smoke_marker') IS NULL;")" == t ]] || fail 'Database state leaked between instances.'

current_check='non-root recording writes and isolation'
compose a exec -T astracalls sh -eu -c '
    test "$(id -u)" -ne 0
    test "$WACALLS_RECORDING_DIR" = /data/recordings
    printf "%s\n" persisted > "$WACALLS_RECORDING_DIR/.docker-smoke-marker"
    ffmpeg -nostdin -hide_banner -loglevel error -f lavfi -i anullsrc=r=16000:cl=mono \
        -t 0.1 "$WACALLS_RECORDING_DIR/.docker-smoke.mp3"
    test -s "$WACALLS_RECORDING_DIR/.docker-smoke.mp3"
' >/dev/null 2>&1
compose b exec -T astracalls sh -eu -c '
    test "$(id -u)" -ne 0
    test "$WACALLS_RECORDING_DIR" = /data/recordings
    test ! -e "$WACALLS_RECORDING_DIR/.docker-smoke-marker"
    printf "%s\n" writable > "$WACALLS_RECORDING_DIR/.docker-smoke-writable"
' >/dev/null 2>&1
printf 'PASS: independent databases, writable recordings and MP3 encoding under a non-root user.\n'

current_check='health fails when the database is unavailable'
compose b stop postgres >/dev/null 2>&1
[[ "$(status_code "http://127.0.0.1:$http_b/healthz")" == 503 ]] || fail 'Health check did not detect unavailable PostgreSQL.'
compose b up --detach --no-build --pull never --wait --wait-timeout 180 >/dev/null 2>&1
verify_http "$http_b" "$key_b" "$key_a"
printf 'PASS: database outage detection and recovery.\n'

current_check='recreating instance A with its existing volumes'
old_app="$(compose a ps --quiet astracalls)"
old_db="$(compose a ps --quiet postgres)"
compose a up --detach --force-recreate --no-build --pull never --wait --wait-timeout 180 >/dev/null 2>&1
[[ -n "$old_app" && "$old_app" != "$(compose a ps --quiet astracalls)" ]] || fail 'Application container was not recreated.'
[[ -n "$old_db" && "$old_db" != "$(compose a ps --quiet postgres)" ]] || fail 'Postgres container was not recreated.'

current_check='database and recording persistence after container replacement'
[[ "$(query a "SELECT value FROM docker_smoke_marker;")" == persisted ]] || fail 'Database contents did not survive recreation.'
[[ "$(query b "SELECT to_regclass('public.docker_smoke_marker') IS NULL;")" == t ]] || fail 'Instance B database is no longer isolated.'
compose a exec -T astracalls sh -eu -c '
    test "$(id -u)" -ne 0
    test "$(cat "$WACALLS_RECORDING_DIR/.docker-smoke-marker")" = persisted
    printf "%s\n" writable >> "$WACALLS_RECORDING_DIR/.docker-smoke-marker"
' >/dev/null 2>&1
verify_http "$http_a" "$key_a" "$key_b"
verify_http "$http_b" "$key_b" "$key_a"
printf 'PASS: database and recording persistence after replacing both application and Postgres containers.\n'
printf 'All Docker smoke checks passed. Removing only the two test projects and their test volumes.\n'
