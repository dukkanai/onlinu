#!/usr/bin/env bash
# Local audit only: fixed disposable DB/container/origin, never production env.
set -euo pipefail
task_root=/home/chatbot/wa/AstraCalls
task_app=astracalls-iteration-audit-app
if [[ "$PWD" != "$task_root" ]]; then
  echo 'Run from the AstraCalls development workspace.' >&2
  exit 1
fi
if [[ "$(docker inspect --format '{{index .Config.Labels "astracalls.purpose"}}' astracalls-completion-test-postgres)" != completion-isolated-test ]]; then
  echo 'Refusing an unverified test database.' >&2
  exit 1
fi
case "${1:-build}" in
  build)
    mkdir -p bin
    docker run --rm --network host \
      --mount type=bind,source="$task_root",target=/src \
      --mount type=volume,source=astracalls-build-gomod,target=/go/pkg/mod \
      --mount type=volume,source=astracalls-build-gocache,target=/root/.cache/go-build \
      golang:1.26.9 go build -buildvcs=false -o /src/bin/iteration-audit-server ./cmd/server
    ;;
  start)
    docker run -d --name "$task_app" --pull never \
      --label astracalls.purpose=iteration-isolated-audit --network host \
      --mount type=bind,source="$task_root",target=/src,readonly \
      --tmpfs /audit-data:rw,nosuid,nodev,size=128m \
      -e 'WACALLS_PG_URL=postgres://astracalls_test:completion-test-only@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable' \
      -e WACALLS_PG_NAMESPACE=iterationaudit \
      -e WACALLS_API_KEY=restaurant-browser-test-key \
      -e WACALLS_RECORDING_DIR=/audit-data \
      -e RESTAURANT_GEOGRAPHY_DATA_DIR=/src/data/saudi-geography \
      -w /src golang:1.26.9 /src/bin/iteration-audit-server -addr 127.0.0.1:18083 -static /src/client/dist
    ;;
  restart|stop)
    if [[ "$(docker inspect --format '{{index .Config.Labels "astracalls.purpose"}}' "$task_app")" != iteration-isolated-audit ]]; then
      echo 'Refusing a non-audit application.' >&2
      exit 1
    fi
    docker "${1}" --time 5 "$task_app"
    ;;
  *) echo 'Use build, start, restart or stop.' >&2; exit 1 ;;
esac
