#!/usr/bin/env python3
"""Test a ready offline installer using only disposable, isolated instances.

Usage: python3 scripts/installer-smoke.py [path/to/astracalls-installer.run]
Requires Python's standard library, Bash, a local Docker daemon, Docker Compose,
the existing astracalls-main deployment, and preloaded private release images.
No existing deployment is stopped, recreated, or used for test data.
"""

import argparse
import base64
import hashlib
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request


PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_RELEASE = json.loads((PROJECT_DIR / "deploy/release.json").read_text())
DEFAULT_BUNDLE = PROJECT_DIR.parent / ("artifacts/astracalls-installer-" + DEFAULT_RELEASE["version"] + "-linux-amd64.run")
DEFAULT_IMAGE = DEFAULT_RELEASE["images"]["app"]["tag"]
PRIVATE_POSTGRES = DEFAULT_RELEASE["images"]["postgres"]["tag"]
MAIN_PROJECT = "astracalls-main"
FILTERED_PREFIXES = ("WACALLS_", "POSTGRES_", "ASTRACALLS_", "COMPOSE_", "OPENAI_")
ENV = {key: value for key, value in os.environ.items() if not key.startswith(FILTERED_PREFIXES)}
AMBIENT = {**ENV, "OPENAI_API_KEY": "smoke-ambient-openai-must-be-ignored",
           "WACALLS_API_KEY": "smoke-ambient-api-must-be-ignored",
           "WACALLS_META_ENCRYPTION_KEY": "smoke-ambient-meta-must-be-ignored"}
HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class TestFailure(Exception):
    """A safe diagnostic that never includes credentials or command output."""


def require(condition, message):
    if not condition:
        raise TestFailure(message)


def step(message):
    print(message, flush=True)


def run(arguments, *, check=True, environment=None, timeout=240):
    try:
        result = subprocess.run([str(arg) for arg in arguments], env=environment or ENV,
                                cwd=PROJECT_DIR, capture_output=True, text=True,
                                timeout=timeout, check=False)
    except subprocess.TimeoutExpired as exc:
        raise TestFailure("A test command timed out; output withheld to protect credentials.") from exc
    except OSError as exc:
        raise TestFailure("Cannot execute a required test command.") from exc
    if check and result.returncode:
        raise TestFailure("A test command failed; output withheld to protect credentials.")
    return result


def docker_json(*arguments):
    try:
        return json.loads(run(["docker", *arguments]).stdout)
    except ValueError as exc:
        raise TestFailure("Docker returned invalid JSON.") from exc


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def resource_names(project, kind):
    arguments = {"container": ["ps", "-aq"], "volume": ["volume", "ls", "-q"],
                 "network": ["network", "ls", "-q"]}[kind]
    return run(["docker", *arguments, "--filter",
                "label=com.docker.compose.project=" + project]).stdout.split()


def container_details(project):
    ids = resource_names(project, "container")
    return docker_json("inspect", *ids) if ids else []


def lifecycle(project):
    return {item["Id"]: {"started": item["State"]["StartedAt"],
                         "running": item["State"]["Running"],
                         "status": item["State"]["Status"],
                         "restarts": item["RestartCount"]}
            for item in container_details(project)}


def settings(directory):
    result = {}
    for line in (directory / ".env").read_text().splitlines():
        if line and not line.startswith("#"):
            key, separator, value = line.partition("=")
            require(separator and key not in result, "Installation .env has an unsupported format.")
            result[key] = value
    return result


def port_available(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def reserved_ports():
    ids = run(["docker", "ps", "-aq"]).stdout.split()
    result = set()
    for item in docker_json("inspect", *ids) if ids else []:
        for bindings in (item.get("HostConfig", {}).get("PortBindings") or {}).values():
            for binding in bindings or []:
                value = binding.get("HostPort", "")
                if value.isdigit():
                    result.add(int(value))
                elif "-" in value:
                    first, last = value.split("-", 1)
                    if first.isdigit() and last.isdigit():
                        result.update(range(int(first), int(last) + 1))
    return result


def request(port, path, key=None):
    headers = {"X-API-Key": key} if key is not None else {}
    req = urllib.request.Request("http://127.0.0.1:" + str(port) + path, headers=headers)
    try:
        with HTTP.open(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as response:
        return response.code, response.read()
    except (OSError, urllib.error.URLError) as exc:
        raise TestFailure("A local test HTTP request failed.") from exc


def verify_http(configuration, other_key):
    port = int(configuration["WACALLS_HTTP_PORT"])
    key = configuration["WACALLS_API_KEY"]
    require(request(port, "/healthz")[0] == 200, "Database-backed health check failed.")
    require(request(port, "/")[0] == 200, "Frontend failed to return HTTP 200.")
    require(request(port, "/api/restaurant/catalog")[0] == 401, "Anonymous API access was not rejected.")
    require(request(port, "/api/restaurant/catalog", other_key)[0] == 401, "Another instance's API key was accepted.")
    require(request(port, "/api/restaurant/catalog", AMBIENT["WACALLS_API_KEY"])[0] == 401,
            "Ambient API key was accepted.")
    code, body = request(port, "/api/restaurant/catalog", key)
    require(code == 200, "Installed API key did not authorize API access.")
    require(isinstance(json.loads(body).get("items"),list), "Catalog missing.")


def restaurant_state(configuration):
    """Read only disposable instances; never enumerate production customer data."""
    if configuration["ASTRACALLS_VERSION"] != "0.4.0":
        return None
    port = int(configuration["WACALLS_HTTP_PORT"])
    key = configuration["WACALLS_API_KEY"]
    code, body = request(port, "/storefront-api/catalog")
    require(code == 200, "Public restaurant catalog was unavailable.")
    public = json.loads(body)
    require(public.get("settings", {}).get("demo") is True and bool(public.get("items")),
            "A fresh installation did not provide its labelled demo menu.")
    require(not public.get("tables"), "Public catalog exposed the table-code list.")
    require(not public["settings"].get("phone") and not public["settings"].get("address"),
            "Demo restaurant unexpectedly contained real contact details.")
    require(request(port, "/api/restaurant/catalog")[0] == 401,
            "Restaurant administration did not require the master key.")
    code, body = request(port, "/api/restaurant/catalog", key)
    require(code == 200, "Restaurant administrator catalog was unavailable.")
    catalog = json.loads(body)
    codes = {table.get("code") for table in catalog.get("tables", [])}
    require(bool(codes) and None not in codes and "" not in codes
            and len(codes) == len(catalog["tables"]), "Fresh table codes were missing or duplicated.")
    for table_code in codes:
        require(request(port, "/storefront-api/tables/" + table_code)[0] == 200,
                "An installed demo table could not be opened.")
    code, body = request(port, "/api/restaurant/orders", key)
    require(code == 200 and json.loads(body).get("orders") == [],
            "A fresh installation unexpectedly contained customer orders.")
    code, body = request(port, "/storefront-api/account")
    require(code == 200 and json.loads(body).get("customer") is None,
            "A fresh installation unexpectedly inherited a customer session.")
    for route in ("/admin", "/order", "/track", "/account"):
        require(request(port, route)[0] == 200, "A restaurant frontend route did not load.")
    return {"codes": codes, "version": catalog["version"]}


class SmokeTest:
    def __init__(self, bundle, app_image):
        self.bundle = bundle
        self.app_image = app_image
        self.token = secrets.token_hex(6)
        self.root = None
        self.root_identity = None
        self.instances = []
        self.holder_id = None
        self.unlabeled_volume = None
        self.main_before = None
        self.main_env_hashes = None
        self.shared_postgres_id = None
        self.stage = "preflight"

    def announce(self, message):
        self.stage = message
        step(message)

    def compose(self, instance, *arguments, check=True):
        return run(["docker", "compose", "--project-directory", instance["directory"],
                    "--env-file", instance["directory"] / ".env", "-p", instance["project"],
                    "-f", instance["directory"] / "compose.yml", *arguments], check=check)

    def verify_main(self):
        if self.main_before is not None:
            require(lifecycle(MAIN_PROJECT) == self.main_before,
                    "Existing main deployment container IDs/start times/restart counts changed.")
            require({path: digest(path) for path in self.main_env_hashes} == self.main_env_hashes,
                    "Existing main deployment .env changed.")
        if self.shared_postgres_id is not None:
            require(docker_json("image", "inspect", "postgres:16-bookworm")[0]["Id"] == self.shared_postgres_id,
                    "The shared postgres:16-bookworm image tag changed.")

    def query(self, instance, sql):
        return self.compose(instance, "exec", "-T", "postgres", "psql", "--no-psqlrc",
                            "--username", "astracalls", "--dbname", "wacalls_main",
                            "--tuples-only", "--no-align", "--set", "ON_ERROR_STOP=1",
                            "--command", sql).stdout.strip()

    def shell(self, instance, code):
        return self.compose(instance, "exec", "-T", "astracalls", "sh", "-eu", "-c", code)

    def install(self, instance, *extra, check=True):
        return run(["bash", self.bundle, "--name", instance["name"], "--dir", instance["directory"],
                    *extra], environment=AMBIENT, check=check, timeout=600)

    def manage(self, instance, command):
        return run(["bash", instance["directory"] / "manage.sh", command], environment=AMBIENT)

    def new_instance(self, suffix):
        name = "smoke-" + self.token + "-" + suffix
        instance = {"name": name, "project": "astracalls-" + name,
                    "directory": self.root / name}
        for kind in ("container", "network", "volume"):
            require(not resource_names(instance["project"], kind), "Generated test project already exists.")
        # Register before installation so partial, owned deployments are cleaned.
        self.instances.append(instance)
        return instance

    def verify_data(self, first, second):
        require(self.query(first, "SELECT value FROM installer_smoke_marker;") == "persisted",
                "Database test marker did not persist.")
        require(self.query(second, "SELECT to_regclass('public.installer_smoke_marker') IS NULL;") == "t",
                "Database data leaked to the second instance.")
        self.shell(first, 'test "$(id -u)" -ne 0; '
                          'test "$(cat "$WACALLS_MEDIA_DIR/.installer-smoke-marker")" = persisted; '
                          'test -w "$WACALLS_MEDIA_DIR/.installer-smoke-marker"')
        self.shell(second, 'test "$(id -u)" -ne 0; '
                           'test ! -e "$WACALLS_MEDIA_DIR/.installer-smoke-marker"; '
                           'test "$(cat "$WACALLS_MEDIA_DIR/.installer-smoke-writable")" = writable')

    def execute(self):
        require(self.bundle.is_file(), "Ready installer bundle was not found.")
        require(shutil.which("docker") and shutil.which("bash"), "Docker and Bash are required.")
        context = ENV.get("DOCKER_CONTEXT")
        endpoint = None if context else ENV.get("DOCKER_HOST")
        if not endpoint:
            arguments = ["context", "inspect"] + ([context] if context else [])
            endpoint = docker_json(*arguments)[0]["Endpoints"]["docker"]["Host"]
        require(endpoint.startswith("unix:///"), "Smoke test requires a local Docker Unix socket.")
        run(["docker", "compose", "version"])
        run(["docker", "image", "inspect", self.app_image])
        main = container_details(MAIN_PROJECT)
        require(len(main) == 2 and all(item["State"]["Running"] for item in main),
                "The two existing astracalls-main containers must already be running.")
        env_paths = {Path(item["Config"]["Labels"]["com.docker.compose.project.working_dir"]) / ".env"
                     for item in main}
        require(all(path.is_file() for path in env_paths), "Main deployment .env was not found.")
        self.main_env_hashes = {path: digest(path) for path in env_paths}
        self.main_before = lifecycle(MAIN_PROJECT)
        self.shared_postgres_id = docker_json("image", "inspect", "postgres:16-bookworm")[0]["Id"]
        expect_archive_load = run(["docker", "image", "inspect", PRIVATE_POSTGRES], check=False).returncode != 0
        ports_before = reserved_ports()
        require(8080 in ports_before, "Expected occupied HTTP port 8080 is not reserved by Docker.")
        self.root = Path(tempfile.mkdtemp(prefix="astracalls-installer-smoke-")).resolve()
        stat = self.root.stat()
        self.root_identity = (stat.st_dev, stat.st_ino, stat.st_uid)

        self.announce("Reserving an otherwise-free HTTP port with a stopped disposable container.")
        holder_port = next((port for port in range(8081, 9000)
                            if port not in ports_before and port_available(port)), None)
        require(holder_port is not None, "No HTTP port is available for the stopped-container test.")
        holder_name = "astracalls-installer-holder-" + self.token
        self.holder_id = run(["docker", "create", "--name", holder_name,
                              "--label", "io.astracalls.installer-smoke=" + self.token,
                              "--publish", "127.0.0.1:" + str(holder_port) + ":8080",
                              "--entrypoint", "true", self.app_image]).stdout.strip()
        holder = docker_json("inspect", self.holder_id)[0]
        require(not holder["State"]["Running"], "Busy-port holder unexpectedly started.")
        require(port_available(holder_port), "Stopped holder's port unexpectedly has an active listener.")
        self.verify_main()

        self.announce("Installing two new instances while hostile ambient API settings are present.")
        first = self.new_instance("a")
        second = self.new_instance("b")
        first_result = self.install(first)
        if expect_archive_load:
            require("Loading the release's private Docker images" in first_result.stdout,
                    "Missing private Postgres image did not trigger archive loading.")
            run(["docker", "image", "inspect", PRIVATE_POSTGRES])
            step("PASS: first installation loaded the supplied offline image archive.")
        self.verify_main()
        self.install(second)
        self.verify_main()
        first_settings, second_settings = settings(first["directory"]), settings(second["directory"])
        for instance, configuration in ((first, first_settings), (second, second_settings)):
            require(not (instance["directory"] / ".env").stat().st_mode & 0o077,
                    "Installed .env is accessible by another user.")
            require("OPENAI_API_KEY" not in configuration, "Removed provider setting retained.")
            require(configuration["WACALLS_API_KEY"] != AMBIENT["WACALLS_API_KEY"],
                    "Ambient API key contaminated installation.")
            require(configuration["WACALLS_HTTP_BIND"] == "127.0.0.1",
                    "Installer did not retain localhost default bindings.")
            require(int(configuration["WACALLS_HTTP_PORT"]) > holder_port,
                    "Installer did not skip the stopped container's reserved HTTP port.")
            require(configuration["ASTRACALLS_IMAGE"] == self.app_image,
                    "Installer selected an unexpected application image.")
        require(first_settings["WACALLS_API_KEY"] != second_settings["WACALLS_API_KEY"],
                "Instances reused an API key.")
        require(first_settings["POSTGRES_PASSWORD"] != second_settings["POSTGRES_PASSWORD"],
                "Instances reused a database password.")
        all_ports = [int(config[key]) for config in (first_settings, second_settings)
                     for key in ("WACALLS_HTTP_PORT",)]
        require(len(set(all_ports)) == 2 and not set(all_ports) & ports_before
                and holder_port not in all_ports, "Installed instances do not have separate free ports.")
        first_volumes = set(resource_names(first["project"], "volume"))
        second_volumes = set(resource_names(second["project"], "volume"))
        require(len(first_volumes) == 2 and len(second_volumes) == 2 and not first_volumes & second_volumes,
                "Database and recording volumes are not independent.")
        verify_http(first_settings, second_settings["WACALLS_API_KEY"])
        verify_http(second_settings, first_settings["WACALLS_API_KEY"])
        restaurant_before = [restaurant_state(configuration) for configuration in (first_settings, second_settings)]
        if restaurant_before[0] is not None:
            require(restaurant_before[1] is not None
                    and not restaurant_before[0]["codes"] & restaurant_before[1]["codes"],
                    "Independent restaurants reused table QR codes.")
            require(request(int(first_settings["WACALLS_HTTP_PORT"]), "/api/restaurant/orders", second_settings["WACALLS_API_KEY"])[0] == 401,
                    "Another restaurant's key accessed private orders.")
            require(request(int(second_settings["WACALLS_HTTP_PORT"]), "/api/restaurant/orders", first_settings["WACALLS_API_KEY"])[0] == 401,
                    "Another restaurant's key accessed private orders.")
            step("PASS: public demo catalogs, unique table QR codes, empty order/customer state and restaurant key isolation.")
        self.query(first, "CREATE TABLE installer_smoke_marker (value text PRIMARY KEY); "
                          "INSERT INTO installer_smoke_marker VALUES ('persisted');")
        self.shell(first, 'test "$(id -u)" -ne 0; test "$WACALLS_MEDIA_DIR" = /data/recordings; '
                          'printf "%s\\n" persisted > "$WACALLS_MEDIA_DIR/.installer-smoke-marker"')
        self.shell(second, 'test "$(id -u)" -ne 0; test "$WACALLS_MEDIA_DIR" = /data/recordings; '
                           'printf "%s\\n" writable > "$WACALLS_MEDIA_DIR/.installer-smoke-writable"')
        self.verify_data(first, second)
        self.verify_main()
        step("PASS: automatic port selection, authentication, independent credentials/databases/recordings, non-root writes.")

        self.announce("Rerunning both installer commands and checking exact configuration/lifecycle preservation.")
        before = {instance["project"]: (digest(instance["directory"] / ".env"), lifecycle(instance["project"]))
                  for instance in (first, second)}
        for instance in (first, second):
            self.install(instance)
            after = (digest(instance["directory"] / ".env"), lifecycle(instance["project"]))
            require(after == before[instance["project"]], "Rerun changed credentials or recreated/restarted containers.")
            self.verify_main()
        self.verify_data(first, second)
        require([restaurant_state(configuration) for configuration in (first_settings, second_settings)] == restaurant_before,
                "Rerunning installation changed restaurant catalog versions or table QR codes.")
        step("PASS: rerunning either installation preserves .env, containers, database data, and recordings.")

        self.announce("Checking refusal to reuse the main project name or occupied HTTP port 8080.")
        refused_main = {"name": "main", "directory": self.root / "refuse-main"}
        require(self.install(refused_main, check=False).returncode != 0,
                "Installer accepted the existing main project name with a new directory.")
        require(not refused_main["directory"].exists(), "Refused main installation created a directory.")
        self.verify_main()
        refused_port = self.new_instance("port")
        require(self.install(refused_port, "--http-port", "8080", check=False).returncode != 0,
                "Installer accepted occupied HTTP port 8080.")
        require(not refused_port["directory"].exists(), "Refused port installation created a directory.")
        for kind in ("container", "network", "volume"):
            require(not resource_names(refused_port["project"], kind), "Refused install created Docker resources.")
        self.verify_main()
        step("PASS: existing project and occupied-port requests were refused without touching the main deployment.")

        self.announce("Checking refusal to reuse an unlabeled volume with the exact proposed instance volume name.")
        refused_volume = self.new_instance("volume")
        volume_name = refused_volume["project"] + "_translation-postgres"
        require(run(["docker", "volume", "inspect", volume_name], check=False).returncode != 0,
                "Proposed test volume name already exists.")
        run(["docker", "volume", "create", "--name", volume_name])
        self.unlabeled_volume = docker_json("volume", "inspect", volume_name)[0]
        require(not self.unlabeled_volume.get("Labels"), "Collision test volume unexpectedly has labels.")
        require(self.install(refused_volume, check=False).returncode != 0,
                "Installer accepted an unrelated unlabeled volume with the requested instance name.")
        require(not refused_volume["directory"].exists(), "Volume collision refusal created an installation directory.")
        require(docker_json("volume", "inspect", volume_name)[0] == self.unlabeled_volume,
                "Volume collision refusal modified the existing volume.")
        for kind in ("container", "network", "volume"):
            require(not resource_names(refused_volume["project"], kind), "Refused volume collision created project resources.")
        self.verify_main()
        step("PASS: unlabeled volume collision refused; original volume and shared Postgres image preserved.")

        self.announce("Checking manage.sh status, stop, and start with preserved data and isolated ambient settings.")
        original_ids = set(lifecycle(first["project"]))
        env_hash = digest(first["directory"] / ".env")
        self.manage(first, "status")
        self.manage(first, "stop")
        stopped = lifecycle(first["project"])
        require(set(stopped) == original_ids and all(not state["running"] for state in stopped.values()),
                "manage.sh stop did not preserve the stopped containers.")
        verify_http(second_settings, first_settings["WACALLS_API_KEY"])
        self.verify_main()
        self.manage(first, "start")
        self.manage(first, "status")
        require(set(lifecycle(first["project"])) == original_ids, "manage.sh start replaced the stopped containers.")
        require(digest(first["directory"] / ".env") == env_hash, "Management commands changed .env.")
        self.verify_data(first, second)
        verify_http(first_settings, second_settings["WACALLS_API_KEY"])
        verify_http(second_settings, first_settings["WACALLS_API_KEY"])
        self.verify_main()
        step("PASS: management commands preserve credentials/data and leave other deployments running.")

    def cleanup(self):
        failed = False
        for instance in reversed(self.instances):
            directory = instance["directory"]
            try:
                resources = any(resource_names(instance["project"], kind)
                                for kind in ("container", "network", "volume"))
                if not resources:
                    continue
                require(directory.parent == self.root and not directory.is_symlink(),
                        "Cleanup directory no longer belongs to this test.")
                marker_path = directory / ".installation.json"
                require(marker_path.is_file() and not marker_path.is_symlink(),
                        "Cannot validate ownership of a partial test installation.")
                marker = json.loads(marker_path.read_text())
                require(marker["project"] == instance["project"] and marker["directory"] == str(directory),
                        "Cleanup installation marker mismatch.")
                for filename in ("compose.yml", ".env"):
                    path = directory / filename
                    require(path.is_file() and not path.is_symlink(), "Cleanup configuration is not a regular file.")
                require(digest(directory / "compose.yml") == marker["files"]["compose.yml"],
                        "Cleanup Compose configuration changed.")
                config = json.loads(self.compose(instance, "config", "--format", "json").stdout)
                require(config["name"] == instance["project"], "Cleanup Compose project mismatch.")
                for group in ("volumes", "networks"):
                    require(all(not value.get("external") and value["name"].startswith(instance["project"] + "_")
                                for value in config.get(group, {}).values()),
                            "Cleanup configuration references shared resources.")
                self.compose(instance, "down", "--volumes", "--timeout", "15")
                require(all(not resource_names(instance["project"], kind)
                            for kind in ("container", "network", "volume")), "Test project cleanup was incomplete.")
            except Exception:
                step("Cleanup needs attention for test project " + instance["project"] + ".")
                failed = True
        if self.holder_id:
            try:
                holder = docker_json("inspect", self.holder_id)[0]
                require(holder["Config"]["Labels"].get("io.astracalls.installer-smoke") == self.token,
                        "Busy holder ownership changed.")
                require(not holder["State"]["Running"], "Busy holder unexpectedly running; refusing removal.")
                run(["docker", "rm", self.holder_id])
            except Exception:
                step("Cleanup needs attention for stopped test holder " + self.holder_id + ".")
                failed = True
        if self.unlabeled_volume:
            try:
                volume_name = self.unlabeled_volume["Name"]
                require(docker_json("volume", "inspect", volume_name)[0] == self.unlabeled_volume,
                        "Collision test volume identity changed.")
                run(["docker", "volume", "rm", volume_name])
            except Exception:
                step("Cleanup needs attention for collision test volume " + self.unlabeled_volume["Name"] + ".")
                failed = True
        try:
            self.verify_main()
        except Exception:
            step("FAIL: existing main deployment changed during the smoke test.")
            failed = True
        if self.root and not failed:
            try:
                stat = self.root.stat()
                require(not self.root.is_symlink()
                        and (stat.st_dev, stat.st_ino, stat.st_uid) == self.root_identity
                        and self.root.name.startswith("astracalls-installer-smoke-"),
                        "Temporary directory ownership changed.")
                shutil.rmtree(self.root)
            except Exception:
                failed = True
        if failed and self.root:
            step("Owned test configuration retained at " + str(self.root) + "; no shared data was deleted.")
        return not failed


def interrupted(_signal, _frame):
    raise KeyboardInterrupt


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("bundle", nargs="?", type=Path, default=DEFAULT_BUNDLE)
    parser.add_argument("--app-image", default=DEFAULT_IMAGE)
    args = parser.parse_args()
    signal.signal(signal.SIGTERM, interrupted)
    os.umask(0o077)
    test = SmokeTest(args.bundle.resolve(), args.app_image)
    success = False
    try:
        test.execute()
        success = True
    except KeyboardInterrupt:
        step("Interrupted; cleaning only test-owned projects and the stopped port holder.")
    except TestFailure as exc:
        step("FAIL during " + test.stage + ": " + str(exc))
    except Exception:
        step("FAIL during " + test.stage + "; details withheld to protect credentials.")
    finally:
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGINT, signal.SIG_IGN)
        success = test.cleanup() and success
    if success:
        step("PASS: all installer checks complete; test resources removed; main IDs/start times/restarts/.env unchanged.")
    return 0 if success else 1


if __name__ == "__main__":
    sys.exit(main())
