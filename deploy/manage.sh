#!/usr/bin/env bash
set -euo pipefail

if ! command -v python3 >/dev/null 2>&1; then
  printf '%s\n' 'AstraCalls requires python3 to read its installation settings safely.' >&2
  exit 1
fi

exec python3 - "${BASH_SOURCE[0]}" "$@" <<'PY'
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys


def fail(message):
    print("AstraCalls: " + message, file=sys.stderr)
    raise SystemExit(1)


def read_json(path, description):
    try:
        if path.is_symlink() or not path.is_file():
            fail(description + " must be a regular file in this installation.")
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, ValueError):
        fail("Cannot read a valid " + description + ".")


args = sys.argv[2:]
command = args[0] if args else "status"
extra = args[1:]
if command in ("help", "--help", "-h"):
    print("Usage: ./manage.sh [status|start|stop|restart|logs [--follow]|config-path]")
    print("status is the default. stop preserves databases and recordings.")
    print("restart recreates only the application using the installed image.")
    raise SystemExit(0)

commands = {
    "status": ["ps", "--all"],
    "start": ["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120"],
    "stop": ["stop"],
    "restart": ["up", "-d", "--force-recreate", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120", "astracalls"],
    "logs": ["logs", "--tail", "100"],
    "config-path": [],
}
if command not in commands or (extra and not (command == "logs" and extra == ["--follow"])):
    fail("Unsupported command or arguments; run ./manage.sh --help.")

directory = Path(sys.argv[1]).resolve().parent
marker = read_json(directory / ".installation.json", "installation marker")
if not isinstance(marker, dict) or type(marker.get("schema")) is not int or marker["schema"] != 1:
    fail("Unsupported installation marker schema.")
if marker.get("directory") != str(directory):
    fail("Installation directory does not match its marker; use the installer to create a new instance.")
project = marker.get("project")
if not isinstance(project, str) or not re.fullmatch(r"astracalls-[a-z0-9][a-z0-9_-]*", project):
    fail("Invalid installation project name.")
if not isinstance(marker.get("version"), str) or not marker["version"]:
    fail("Missing installation version.")

env_file = directory / ".env"
if command == "config-path":
    print(env_file)
    raise SystemExit(0)

compose_file = directory / "compose.yml"
file_hashes = marker.get("files")
expected_hash = file_hashes.get("compose.yml") if isinstance(file_hashes, dict) else None
if not isinstance(expected_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_hash):
    fail("Missing or invalid Compose checksum in the installation marker.")
try:
    if compose_file.is_symlink() or not compose_file.is_file():
        fail("compose.yml must be a regular file in this installation.")
    actual_hash = hashlib.sha256(compose_file.read_bytes()).hexdigest()
except OSError:
    fail("Cannot read the installed compose.yml.")
if actual_hash != expected_hash:
    fail("compose.yml has changed; refusing Docker actions. Restore the installed file before continuing.")
if env_file.is_symlink() or not env_file.is_file():
    fail(".env must be a regular file in this installation.")

# Explicit --env-file plus a clean process environment makes the private .env
# authoritative, even when this script is called from another Compose project.
environment = {
    key: value for key, value in os.environ.items()
    if not key.startswith(("WACALLS_", "POSTGRES_", "ASTRACALLS_", "COMPOSE_", "OPENAI_"))
}
docker = shutil.which("docker", path=environment.get("PATH"))
if docker is None:
    fail("Docker was not found in PATH.")

# Docker's context override takes precedence over DOCKER_HOST. Otherwise an
# explicit host overrides the saved current context. Never manage a remote daemon.
context_name = environment.get("DOCKER_CONTEXT")
endpoint = environment.get("DOCKER_HOST") if not context_name else None
if not endpoint:
    inspect = [docker, "context", "inspect"]
    if context_name:
        inspect.append(context_name)
    try:
        result = subprocess.run(inspect, env=environment, cwd=directory, text=True,
                                capture_output=True, timeout=15, check=False)
        if result.returncode != 0:
            fail("Cannot inspect the selected Docker context.")
        contexts = json.loads(result.stdout)
        endpoint = contexts[0]["Endpoints"]["docker"]["Host"]
    except (OSError, ValueError, KeyError, IndexError, TypeError, subprocess.TimeoutExpired):
        fail("Cannot determine the selected Docker endpoint.")
if not isinstance(endpoint, str) or not endpoint.startswith("unix:///") or len(endpoint) <= len("unix:///"):
    fail("Only a local Docker Unix socket is supported; select a local context before continuing.")

docker_args = [docker, "compose", "--project-directory", str(directory),
               "--env-file", str(env_file), "-p", project, "-f", str(compose_file)]
docker_args.extend(commands[command])
docker_args.extend(extra)
try:
    os.chdir(directory)
    os.execvpe(docker, docker_args, environment)
except OSError:
    fail("Cannot execute Docker Compose.")
PY
