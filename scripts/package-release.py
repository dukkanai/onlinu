#!/usr/bin/env python3
"""Create private Docker image or clean source archives without overwriting releases.

Examples:
  python3 scripts/package-release.py images --version 0.3.0
  # Review the printed manifest and apply it to deploy/release.json.
  bash scripts/build-installer.sh
  python3 scripts/package-release.py source --version 0.3.0

Image packaging requires the already-built astracalls-translation:<version> image.
It never builds, pulls, publishes, loads, or changes running containers. Source
packaging uses Git's tracked/non-ignored file list plus explicit secret/data
exclusions, and checks local configured secret values without printing them.
"""
import argparse
import fnmatch
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile


PROJECT = Path(__file__).resolve().parents[1]
ARTIFACTS = PROJECT.parent / "artifacts"
POSTGRES_TAG = "astracalls-bundle/postgres:16-efedf3595f1d"
POSTGRES_IDS = {
    "sha256:efedf3595f1d6f415c08568ba171029bf54052e754cc9f030e3f2412b21f3d67",
    "sha256:345c8087a592c68bc6b1c347bb865b43e14cdefec77d741f85195588028f57a4",
}
EXCLUDED_PARTS = {".git", ".venv", "venv", "data", "auth", "backups", "artifacts",
                  "node_modules", "dist", "bin", "vendor", "__pycache__", "prints", ".playwright-mcp",
                  "secrets", "credentials", "recordings"}
EXCLUDED_PATTERNS = ("*.db", "*.db-*", "*.sqlite*", "*.sql", "*.sql.gz", "*.dump", "*.log",
                     "*.keys", "*.pem", "*.key", "*.p12", "*.pfx", "*.pyc", "*.tsbuildinfo",
                     "*.tar", "*.tar.gz", "*.run", "*.pcap", "*.pcapng", "*.env",
                     "secrets.*", "credentials.*", "auth.json", "nc-qr.txt")


class ReleaseError(Exception):
    pass


def run(arguments, *, check=True):
    result = subprocess.run(arguments, cwd=PROJECT, capture_output=True)
    if check and result.returncode:
        raise ReleaseError("Release command failed; output withheld: " + " ".join(arguments[:3]))
    return result


def file_hash(path):
    with path.open("rb") as stream:
        hasher = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            hasher.update(chunk)
        return hasher.hexdigest()


def configured_secrets():
    values = list(os.environ.items())
    private_env = PROJECT / ".env"
    if private_env.is_file():
        for line in private_env.read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator and not key.startswith("#"):
                values.append((key, value.strip().strip("\"'")))
    return {value.encode() for key, value in values
            if key.startswith(("WACALLS_", "OPENAI_", "POSTGRES_", "ASTRACALLS_", "META_"))
            and re.search(r"KEY|TOKEN|SECRET|PASSWORD|PASSWD", key)
            and len(value) >= 8 and not value.startswith("replace_with_")}


def scan_stream(stream, secrets, label):
    longest = max(map(len, secrets), default=1)
    previous = b""
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        combined = previous + chunk
        if any(value in combined for value in secrets):
            raise ReleaseError("A configured private value was found in " + label + "; nothing was published.")
        previous = combined[-(longest - 1):] if longest > 1 else b""


def image_info(tag):
    result = run(["docker", "image", "inspect", tag], check=False)
    if result.returncode:
        return None
    image = json.loads(result.stdout)[0]
    if image.get("Os") != "linux" or image.get("Architecture") != "amd64":
        raise ReleaseError("Image platform must be linux/amd64: " + tag)
    return image


def publish(temporary, destination):
    # A hard link is atomic on the artifact filesystem and never overwrites.
    temporary.chmod(0o644)
    try:
        os.link(temporary, destination)
    except FileExistsError as exc:
        raise ReleaseError("Artifact already exists; choose a new release filename: " + destination.name) from exc


def inspect_archive(path, tags, secrets):
    manifest = None
    configs = {}
    member_names = set()
    with tarfile.open(path, "r|gz") as archive:
        for member in archive:
            member_path = PurePosixPath(member.name)
            if member_path.is_absolute() or ".." in member_path.parts or member.name in member_names:
                raise ReleaseError("Unsafe or duplicate member in the Docker image archive.")
            member_names.add(member.name)
            if not member.isfile():
                if not member.isdir():
                    raise ReleaseError("Unexpected nonregular member in Docker image archive.")
                continue
            with io.BufferedReader(archive.extractfile(member)) as stream:
                prefix = stream.peek(4)[:4]
                if member.name == "manifest.json":
                    if member.size > 1024 * 1024:
                        raise ReleaseError("Oversized Docker archive manifest.")
                    data = stream.read()
                    scan_stream(io.BytesIO(data), secrets, "Docker archive manifest")
                    manifest = json.loads(data)
                elif prefix[:2] == b"\x1f\x8b":
                    # Docker's OCI export contains individually gzipped layers.
                    # Scan decoded layer bytes, not merely the outer .tar.gz.
                    with gzip.GzipFile(fileobj=stream) as layer:
                        scan_stream(layer, secrets, "a decoded Docker image layer")
                elif prefix == b"\x28\xb5\x2f\xfd":
                    raise ReleaseError("Zstandard layers require an explicit decoder before secret scanning.")
                elif member.size <= 1024 * 1024:
                    data = stream.read()
                    scan_stream(io.BytesIO(data), secrets, "Docker image metadata")
                    try:
                        decoded = json.loads(data)
                    except (ValueError, UnicodeDecodeError):
                        continue
                    if isinstance(decoded, dict) and "architecture" in decoded and "os" in decoded:
                        # OCI exports may also include unknown-platform build
                        # attestation configs. Check the configurations actually
                        # referenced by Docker's load manifest below.
                        configs[member.name] = {"id": "sha256:" + hashlib.sha256(data).hexdigest(),
                                                "architecture": decoded["architecture"], "os": decoded["os"]}
                else:
                    scan_stream(stream, secrets, "Docker archive data")
    if not isinstance(manifest, list):
        raise ReleaseError("Missing Docker archive manifest.")
    found_tags = {tag for item in manifest for tag in item.get("RepoTags", [])}
    if found_tags != set(tags):
        raise ReleaseError("The image archive contains missing or unexpected repository tags.")
    result = {}
    for item in manifest:
        config = configs.get(item.get("Config"))
        if not config:
            raise ReleaseError("An exported image configuration was not verified.")
        if config["architecture"] != "amd64" or config["os"] != "linux":
            raise ReleaseError("An exported image configuration has an unexpected platform.")
        for tag in item.get("RepoTags", []):
            result[tag] = config["id"]
    return result


def package_images(version, secrets):
    destination = ARTIFACTS / f"astracalls-installer-images-{version}-linux-amd64.tar.gz"
    if destination.exists() or destination.is_symlink():
        raise ReleaseError("Image archive already exists; existing releases are never overwritten.")
    app = image_info("astracalls-translation:" + version)
    postgres = image_info(POSTGRES_TAG)
    if not app or not postgres:
        raise ReleaseError("The requested application build and private PostgreSQL image must already exist.")
    if postgres["Id"] not in POSTGRES_IDS:
        raise ReleaseError("The existing private PostgreSQL tag no longer matches its approved image identity.")
    if (app.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.version") != version:
        raise ReleaseError("The built application's version label does not match this release.")
    app_tag = "astracalls-bundle/app:" + version + "-" + app["Id"].split(":", 1)[1][:12]
    current = image_info(app_tag)
    if current and current["Id"] != app["Id"]:
        raise ReleaseError("The private application tag is already owned by a different image.")
    if not current:
        run(["docker", "image", "tag", app["Id"], app_tag])
    ARTIFACTS.mkdir(exist_ok=True)
    with tempfile.NamedTemporaryFile(prefix=".astracalls-images-", dir=ARTIFACTS) as temporary:
        with tempfile.TemporaryFile() as errors:
            process = subprocess.Popen(["docker", "image", "save", app_tag, POSTGRES_TAG],
                                       stdout=subprocess.PIPE, stderr=errors)
            try:
                with gzip.GzipFile(filename="", mode="wb", fileobj=temporary, mtime=0) as compressed:
                    shutil.copyfileobj(process.stdout, compressed, 1024 * 1024)
                if process.wait():
                    raise ReleaseError("Docker image save failed; nothing was published.")
            finally:
                process.stdout.close()
                if process.poll() is None:
                    process.terminate()
                    process.wait()
        temporary.flush()
        temp_path = Path(temporary.name)
        config_ids = inspect_archive(temp_path, [app_tag, POSTGRES_TAG], secrets)
        manifest = {"version": version, "platform": "linux/amd64", "archive_sha256": file_hash(temp_path),
                    "images": {"app": {"tag": app_tag, "allowed_ids": sorted({app["Id"], config_ids[app_tag]})},
                               "postgres": {"tag": POSTGRES_TAG, "allowed_ids": sorted({postgres["Id"], config_ids[POSTGRES_TAG]})}}}
        publish(temp_path, destination)
    print("Created image archive: " + str(destination), file=sys.stderr)
    print("Verified private tags, Linux/AMD64 configurations, and decoded layers against local secret values.", file=sys.stderr)
    print(json.dumps(manifest, indent=2))


def include_source(name):
    path = PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts or set(path.parts) & EXCLUDED_PARTS:
        return False
    if path.name.startswith(".env") and name != ".env.example":
        return False
    return not any(fnmatch.fnmatch(path.name, pattern) for pattern in EXCLUDED_PATTERNS)


def package_source(version, secrets):
    destination = ARTIFACTS / f"astracalls-source-portable-{version}.tar.gz"
    if destination.exists() or destination.is_symlink():
        raise ReleaseError("Source archive already exists; existing releases are never overwritten.")
    release = json.loads((PROJECT / "deploy/release.json").read_text())
    if release.get("version") != version:
        raise ReleaseError("Apply the verified release manifest before packaging source.")
    archive = ARTIFACTS / f"astracalls-installer-images-{version}-linux-amd64.tar.gz"
    if not archive.is_file() or file_hash(archive) != release.get("archive_sha256"):
        raise ReleaseError("Release manifest does not match the published image archive.")
    listed = run(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"]).stdout
    names = sorted({os.fsdecode(name) for name in listed.split(b"\0") if name and include_source(os.fsdecode(name))})
    required = {"Dockerfile", "deploy/release.json", "deploy/test_install.py", "META.ar.md", "deploy/INSTALL.ar.md",
                ".env.example", "scripts/build-installer.sh", "scripts/package-release.py"}
    if version == "0.3.0":
        required.add("RESTAURANT.ar.md")
    if not required.issubset(names):
        raise ReleaseError("Required build, release, documentation, or test files are missing from the clean source list.")
    with tempfile.NamedTemporaryFile(prefix=".astracalls-source-", dir=ARTIFACTS) as temporary:
        with gzip.GzipFile(filename="", mode="wb", fileobj=temporary, mtime=0) as compressed:
            with tarfile.open(fileobj=compressed, mode="w", format=tarfile.PAX_FORMAT) as archive:
                for name in names:
                    path = PROJECT / name
                    if path.is_symlink() or not path.is_file():
                        raise ReleaseError("Source entries must be existing regular files: " + name)
                    data = path.read_bytes()
                    scan_stream(io.BytesIO(data), secrets, "source file " + name)
                    info = tarfile.TarInfo("AstraCalls/" + name)
                    info.size = len(data)
                    info.mode = 0o755 if path.stat().st_mode & 0o111 else 0o644
                    info.mtime = 0
                    archive.addfile(info, io.BytesIO(data))
        temporary.flush()
        temp_path = Path(temporary.name)
        with tarfile.open(temp_path, "r:gz") as archive:
            if archive.getnames() != ["AstraCalls/" + name for name in names]:
                raise ReleaseError("Source archive entries differ from the explicit clean file list.")
        digest = file_hash(temp_path)
        publish(temp_path, destination)
    print("Created clean source archive: " + str(destination))
    print("Verified " + str(len(names)) + " regular source files; private paths and configured secret values excluded.")
    print("SHA-256: " + digest)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("stage", choices=("images", "source"))
    parser.add_argument("--version", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", args.version):
        parser.error("Use a numeric major.minor.patch release version")
    secrets = configured_secrets()
    (package_images if args.stage == "images" else package_source)(args.version, secrets)


if __name__ == "__main__":
    try:
        main()
    except (ReleaseError, OSError, ValueError, KeyError, tarfile.TarError) as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        sys.exit(1)
