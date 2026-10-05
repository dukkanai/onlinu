#!/usr/bin/env bash
set -euo pipefail
task_root=/home/chatbot/wa/AstraCalls
if [[ "$PWD" != "$task_root" ]]; then
  echo 'Run from the AstraCalls development workspace.' >&2
  exit 1
fi
test_label=$(docker inspect --format '{{index .Config.Labels "astracalls.purpose"}}' astracalls-completion-test-postgres)
if [[ "$test_label" != 'completion-isolated-test' ]]; then
  echo 'Refusing to use an unverified database container.' >&2
  exit 1
fi
if [[ $# -eq 0 ]]; then set -- ./... -count=1 -timeout=10m; fi
exec docker run --rm --network host \
  --mount type=bind,source="$task_root",target=/src \
  --mount type=volume,source=astracalls-build-gomod,target=/go/pkg/mod \
  --mount type=volume,source=astracalls-build-gocache,target=/root/.cache/go-build \
  -w /src -e CGO_ENABLED=1 \
  -e 'CGO_LDFLAGS=-L/src/native -Wl,-rpath,/src/native' \
  -e LD_LIBRARY_PATH=/src/native \
  -e 'TEST_RESTAURANT_PG_URL=postgres://astracalls_test:completion-test-only@127.0.0.1:15433/astracalls_restaurant_test?sslmode=disable' \
  golang:1.26.4 go test -race -tags mlow "$@"
