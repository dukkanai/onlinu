#!/usr/bin/env python3
"""Install a verified release without reading or exporting the working server's data."""
import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tarfile
from urllib.parse import urlsplit

PAYLOAD = Path(__file__).resolve().parent
MANAGED = ("compose.yml", "manage.sh", "release.json", "INSTALL.ar.md", "LICENSE", "LICENSE.WaCalls")
SUPPORTED_VERSIONS = frozenset(("0.4.0",))
ENV = {key: value for key, value in os.environ.items()
       if not key.startswith(("WACALLS_", "POSTGRES_", "ASTRACALLS_", "COMPOSE_", "OPENAI_"))}


class InstallError(Exception):
    pass


def run(args, *, check=True):
    result = subprocess.run(args, env=ENV, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    if check and result.returncode:
        # Docker diagnostics can contain expanded settings. Never echo them.
        raise InstallError("Command failed: " + " ".join(args[:3]) + ". Check Docker availability and instance status; credentials were not printed.")
    return result


def digest(path):
    with path.open("rb") as stream:
        hasher = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
        return hasher.hexdigest()


def docker_json(*args):
    return json.loads(run(["docker", *args]).stdout)


def preflight():
    if not shutil.which("docker"):
        raise InstallError("Install Docker Engine and Docker Compose first; this installer does not modify the host's package manager.")
    if ENV.get("DOCKER_CONTEXT") or not ENV.get("DOCKER_HOST"):
        endpoint = docker_json("context", "inspect")[0]["Endpoints"]["docker"]["Host"]
    else:
        endpoint = ENV["DOCKER_HOST"]
    if not endpoint.startswith("unix://"):
        raise InstallError("Use a local Docker Unix socket; remote Docker contexts are not supported.")
    info = docker_json("info", "--format", "{{json .}}")
    if info.get("OSType") != "linux" or info.get("Architecture") not in ("x86_64", "amd64"):
        raise InstallError("This release requires a Linux/AMD64 Docker daemon. ARM servers need a separate image build.")
    help_text = run(["docker", "compose", "up", "--help"]).stdout
    if "--wait-timeout" not in help_text or "--pull" not in help_text:
        raise InstallError("Docker Compose with --wait, --wait-timeout and --pull is required.")


def project_resources(project):
    found = []
    for kind, arguments in (("container", ["ps", "-aq"]), ("network", ["network", "ls", "-q"]), ("volume", ["volume", "ls", "-q"])):
        ids = run(["docker", *arguments, "--filter", "label=com.docker.compose.project=" + project]).stdout.split()
        found.extend((kind, item) for item in ids)
    return found


def check_named_resources(project, existing=False):
    # Compose may reuse a same-named volume/network even without ownership
    # labels. Check names as well as project labels before touching anything.
    targets = (("volume", project + "_translation-postgres"),
               ("volume", project + "_translation-recordings"),
               ("network", project + "_default"),
               ("container", project + "-postgres-1"),
               ("container", project + "-astracalls-1"))
    for kind, name in targets:
        result = run(["docker", kind, "inspect", name], check=False)
        if result.returncode:
            continue
        item = json.loads(result.stdout)[0]
        labels = ((item.get("Config") or {}).get("Labels") if kind == "container" else item.get("Labels")) or {}
        if not existing or labels.get("com.docker.compose.project") != project:
            raise InstallError("A Docker resource with this instance's name already exists and is not owned by this installation: " + name)


def container_info():
    ids = run(["docker", "ps", "-aq"]).stdout.split()
    return docker_json("inspect", *ids) if ids else []


def reserved_ports(containers, exclude_project=None):
    ports = set()
    for item in containers:
        if exclude_project and ((item.get("Config") or {}).get("Labels") or {}).get("com.docker.compose.project") == exclude_project:
            continue
        bindings_by_port = list((item.get("HostConfig", {}).get("PortBindings") or {}).values())
        bindings_by_port += list((item.get("NetworkSettings", {}).get("Ports") or {}).values())
        for bindings in bindings_by_port:
            for binding in bindings or []:
                value = binding.get("HostPort", "")
                if value.isdigit():
                    ports.add(int(value))
                elif re.fullmatch(r"[0-9]+-[0-9]+", value):
                    low, high = map(int, value.split("-"))
                    ports.update(range(low, high + 1))
    return ports


def socket_available(address, port, media=False):
    opened = []
    try:
        for kind in ((socket.SOCK_STREAM, socket.SOCK_DGRAM) if media else (socket.SOCK_STREAM,)):
            sock = socket.socket(socket.AF_INET, kind)
            opened.append(sock)
            sock.bind((address, port))
        return True
    except OSError:
        return False
    finally:
        for sock in opened:
            sock.close()


def choose_port(requested, start, stop, address, reserved, media=False):
    choices = [requested] if requested is not None else range(start, stop)
    for port in choices:
        if port not in reserved and socket_available(address, port, media):
            reserved.add(port)
            return port
    raise InstallError("Requested port is occupied/reserved, or no free port was found. Choose different --http-port/--media-port values.")


def validate_ip(value):
    try:
        return str(ipaddress.IPv4Address(value))
    except ipaddress.AddressValueError as exc:
        raise argparse.ArgumentTypeError("Expected an IPv4 address") from exc


def validate_port(value):
    try:
        port = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("Expected an integer port") from exc
    if not 1024 <= port <= 65535:
        raise argparse.ArgumentTypeError("Use an unprivileged port from 1024 through 65535")
    return port


def parse_args():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--name", default="portable")
    parser.add_argument("--dir")
    parser.add_argument("--http-port", type=validate_port)
    parser.add_argument("--media-port", type=validate_port)
    parser.add_argument("--public-ip", type=validate_ip)
    parser.add_argument("--http-bind", type=validate_ip)
    parser.add_argument("--media-bind", type=validate_ip)
    parser.add_argument("--public-url")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9-]{0,39}", args.name):
        parser.error("Name must be 1–40 lowercase letters, digits or hyphens, starting with a letter/digit")
    if args.public_url is not None:
        url = urlsplit(args.public_url)
        if url.scheme != "https" or not url.hostname or url.username or url.password or re.search(r"[\s#$'\"\\]", args.public_url):
            parser.error("Public URL must be a plain HTTPS URL without credentials or special shell/env characters")
    return args


def read_settings(path):
    settings = {}
    for line in path.read_text().splitlines():
        if not line or line.startswith("#"):
            continue
        key, separator, value = line.partition("=")
        if not separator or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in settings:
            raise InstallError("Unsupported .env format; retain simple KEY=value lines without duplicate keys.")
        settings[key] = value
    return settings


def validate_release_version(release):
    if release.get("version") not in SUPPORTED_VERSIONS:
        raise InstallError("Unsupported release manifest.")


def managed_files(release):
    # Keep old-release validation possible without silently changing its file
    # set. A different version is never treated as an in-place upgrade.
    validate_release_version(release)
    return MANAGED + ("RESTAURANT.ar.md",)


def new_settings(release, *, public_ip, http_bind, media_bind, http_port, media_port, public_url):
    """Generate independent private settings; never call this for a reinstall."""
    settings = {
        "ASTRACALLS_IMAGE": release["images"]["app"]["tag"], "ASTRACALLS_VERSION": release["version"],
        "POSTGRES_IMAGE": release["images"]["postgres"]["tag"],
        "WACALLS_API_KEY": secrets.token_hex(32), "POSTGRES_PASSWORD": secrets.token_hex(32),
        "WACALLS_PUBLIC_BASE_URL": public_url or "", "WACALLS_HTTP_BIND": http_bind, "WACALLS_HTTP_PORT": str(http_port),
    }
    return settings


def load_images(release):
    missing = False
    expected_tags = set()
    for image in release["images"].values():
        expected_tags.add(image["tag"])
        current = run(["docker", "image", "inspect", image["tag"], "--format", "{{.Id}}"], check=False)
        if current.returncode:
            missing = True
        elif current.stdout.strip() not in image["allowed_ids"]:
            raise InstallError("A private release image tag already points to a different image. No tags were replaced: " + image["tag"])
    if missing:
        archive = PAYLOAD / "images.tar.gz"
        if not archive.is_file() or digest(archive) != release["archive_sha256"]:
            raise InstallError("The offline image archive is missing or failed its checksum.")
        with tarfile.open(archive, "r:gz") as tar:
            member = tar.getmember("manifest.json")
            if not member.isfile() or member.size > 1024 * 1024:
                raise InstallError("Invalid Docker archive manifest.")
            manifest = json.load(tar.extractfile(member))
            tags = {tag for entry in manifest for tag in entry.get("RepoTags", [])}
            if tags != expected_tags:
                raise InstallError("Docker archive contains unexpected tags; refusing to alter shared images.")
        print("Loading the release's private Docker images (no network pull)...", flush=True)
        run(["docker", "image", "load", "--input", str(archive)])
    for image in release["images"].values():
        current = docker_json("image", "inspect", image["tag"])[0]
        if current["Id"] not in image["allowed_ids"] or current["Os"] != "linux" or current["Architecture"] != "amd64":
            raise InstallError("Loaded image identity or platform does not match this release.")


def compose(directory, project, *args):
    return ["docker", "compose", "--project-directory", str(directory), "--env-file", str(directory / ".env"),
            "-p", project, "-f", str(directory / "compose.yml"), *args]


def validate_existing(directory, project, release, args):
    marker_path = directory / ".installation.json"
    if marker_path.is_symlink() or not marker_path.is_file():
        raise InstallError("Directory already exists but is not a managed installation. Choose a new --dir and --name.")
    marker = json.loads(marker_path.read_text())
    if marker.get("schema") != 1 or marker.get("project") != project or marker.get("directory") != str(directory):
        raise InstallError("Installation marker does not match the requested directory/project. No changes made.")
    if marker.get("version") != release["version"]:
        raise InstallError("This is another release. Back up and use an explicit update workflow; installation is not an implicit upgrade.")
    for name in managed_files(release):
        path = directory / name
        if path.is_symlink() or not path.is_file() or digest(path) != marker.get("files", {}).get(name) or digest(path) != digest(PAYLOAD / name):
            raise InstallError("Managed deployment files differ. Refusing to overwrite or run modified configuration: " + name)
    env_path = directory / ".env"
    if env_path.is_symlink() or not env_path.is_file() or env_path.stat().st_mode & 0o077:
        raise InstallError("Existing .env must be a regular private file (chmod 600).")
    settings = read_settings(env_path)
    for option, key in (("http_port", "WACALLS_HTTP_PORT"),
                        ("http_bind", "WACALLS_HTTP_BIND"), ("public_url", "WACALLS_PUBLIC_BASE_URL")):
        requested = getattr(args, option)
        if requested is not None and str(requested) != settings.get(key):
            raise InstallError("Requested options differ from the existing configuration. Edit its .env and use manage.sh restart explicitly.")
    if settings.get("ASTRACALLS_IMAGE") != release["images"]["app"]["tag"] or settings.get("POSTGRES_IMAGE") != release["images"]["postgres"]["tag"]:
        raise InstallError("Configured images differ from this release. Use the explicit update workflow.")
    for item in container_info():
        labels = item.get("Config", {}).get("Labels") or {}
        if labels.get("com.docker.compose.project") == project and labels.get("com.docker.compose.project.working_dir") != str(directory):
            raise InstallError("Project name belongs to another installation directory.")
    check_named_resources(project, existing=True)
    return settings


def main():
    os.umask(0o077)
    args = parse_args()
    requested_dir = Path(args.dir or ("astracalls-" + args.name)).absolute()
    if requested_dir.is_symlink():
        raise InstallError("Installation directory must not be a symlink.")
    directory = requested_dir.resolve()
    if directory in (Path("/"), Path.home(), Path.cwd().resolve(), PAYLOAD):
        raise InstallError("Choose a dedicated installation subdirectory.")
    if args.media_port is not None or args.media_bind is not None or args.public_ip is not None:
        raise InstallError("Calling media options were removed; only HTTP is supported.")
    project = "astracalls-" + args.name
    preflight()
    release = json.loads((PAYLOAD / "release.json").read_text())
    validate_release_version(release)
    # A per-user lock serializes installers on the same Docker host without
    # touching unrelated projects. Docker remains the final arbiter for races.
    lock_path = Path("/tmp") / ("astracalls-installer-" + str(os.getuid()) + ".lock")
    descriptor = os.open(lock_path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, "w") as lock:
        if os.fstat(lock.fileno()).st_uid != os.getuid():
            raise InstallError("Installer lock is not owned by the current user.")
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as exc:
            raise InstallError("Another installer is running for this user. Retry after it completes.") from exc
        if directory.exists():
            settings = validate_existing(directory, project, release, args)
            load_images(release)
            print("Starting the existing installation; keeping credentials and data unchanged...", flush=True)
        else:
            if project_resources(project):
                raise InstallError("Docker project already exists and is not this managed directory. Choose another --name.")
            check_named_resources(project)
            public_ip = args.public_ip or "127.0.0.1"
            http_bind = args.http_bind or "127.0.0.1"
            media_bind = args.media_bind or ("127.0.0.1" if ipaddress.ip_address(public_ip).is_loopback else "0.0.0.0")
            reserved = reserved_ports(container_info())
            http_port = choose_port(args.http_port, 8080, 9000, http_bind, reserved)
            media_port = None
            load_images(release)
            settings = new_settings(release, public_ip=public_ip, http_bind=http_bind, media_bind=media_bind,
                                    http_port=http_port, media_port=media_port, public_url=args.public_url)
            directory.parent.mkdir(parents=True, exist_ok=True)
            directory.mkdir(mode=0o700)  # atomic refusal if another writer created it
            for name in managed_files(release):
                shutil.copyfile(PAYLOAD / name, directory / name)
                (directory / name).chmod(0o700 if name == "manage.sh" else 0o600)
            with (directory / ".env").open("x") as stream:
                stream.write("# Private instance configuration. Never commit or share this file.\n")
                stream.writelines(key + "=" + value + "\n" for key, value in settings.items())
            marker = {"schema": 1, "version": release["version"], "project": project, "directory": str(directory),
                      "files": {name: digest(directory / name) for name in managed_files(release)}}
            with (directory / ".installation.json").open("x") as stream:
                json.dump(marker, stream, indent=2)
                stream.write("\n")
            print("Created a clean isolated installation: " + str(directory), flush=True)
        result = run(compose(directory, project, "up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "120"), check=False)
        if result.returncode:
            # Do not delete a database after a partial boot or interrupted retry.
            # Keep the owned project/configuration for diagnosis and a safe rerun.
            raise InstallError("Startup did not become healthy. Configuration and any instance data were retained for a safe retry. Run " + str(directory / "manage.sh") + " status. No unrelated containers were changed.")
        print("Installation healthy: " + project)
        print("HTTP: http://" + settings["WACALLS_HTTP_BIND"] + ":" + settings["WACALLS_HTTP_PORT"])
        print("Manage: " + str(directory / "manage.sh") + " status")
        print("Private settings: " + str(directory / ".env") + " (keys are not printed)")
        print("Restaurant: / | Restaurant administration: /admin")
        print("Configure HTTPS and replace the demo menu before accepting orders.")


if __name__ == "__main__":
    try:
        main()
    except (InstallError, OSError, ValueError, KeyError, tarfile.TarError) as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        sys.exit(1)
    except KeyboardInterrupt:
        print("Interrupted. Any created instance configuration/data are retained; rerun the same command to resume.", file=sys.stderr)
        sys.exit(130)
