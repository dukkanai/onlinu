#!/usr/bin/env bash
# Build a clean, self-extracting offline installer. Never packages the working
# tree, local .env, WhatsApp sessions, recordings, database files, or backups.
# Usage: bash scripts/build-installer.sh [image_archive.tar.gz] [output.run]
set +x
set -Eeuo pipefail
umask 077

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    printf '%s\n' \
        'Usage: bash scripts/build-installer.sh [image_archive.tar.gz] [output.run]' \
        '' \
        'Builds an offline Linux/AMD64 installer from an explicit clean file list.' \
        'Defaults: ../artifacts/astracalls-installer-images-0.4.0-linux-amd64.tar.gz' \
        '          ../artifacts/astracalls-installer-0.4.0-linux-amd64.run' \
        'The output must not already exist. No Docker or network access is used.'
    exit 0
fi
[[ $# -le 2 ]] || fail 'Expected at most an image archive and an output path.'

for dependency in bash tar sha256sum gzip mktemp cp chmod dirname mkdir ln rm cat python3; do
    command -v "$dependency" >/dev/null || fail "Required command is missing: $dependency"
done

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)"
artifacts_dir="$(cd -- "$project_dir/.." && pwd -P)/artifacts"
image_archive="${1:-$artifacts_dir/astracalls-installer-images-0.4.0-linux-amd64.tar.gz}"
output="${2:-$artifacts_dir/astracalls-installer-0.4.0-linux-amd64.run}"
[[ -f "$image_archive" && -r "$image_archive" ]] || fail 'Image archive must be a readable regular file.'
[[ ! -e "$output" && ! -L "$output" ]] || fail 'Output already exists; choose a new versioned filename.'

# Fail before making a bundle if the release metadata still describes a prior
# image archive. This guard reads only the public manifest, never private env.
python3 - "$project_dir/deploy/release.json" "$image_archive" <<'PY'
import hashlib
import json
from pathlib import Path
import sys
release = json.loads(Path(sys.argv[1]).read_text())
if release.get('version') != '0.4.0' or release.get('platform') != 'linux/amd64':
    raise SystemExit('ERROR: Builder requires the finalized 0.4.0 Linux/AMD64 manifest.')
digest = hashlib.sha256()
with Path(sys.argv[2]).open('rb') as stream:
    for chunk in iter(lambda: stream.read(1024 * 1024), b''):
        digest.update(chunk)
if digest.hexdigest() != release.get('archive_sha256'):
    raise SystemExit('ERROR: Docker image archive does not match the release manifest.')
PY

# Every source is intentional. In particular, never replace this with a tar of
# the repository or a wildcard copy of the deployment directory.
source_files=(
    deploy/install.sh
    deploy/install.py
    deploy/compose.yml
    deploy/manage.sh
    deploy/INSTALL.ar.md
    deploy/release.json
    RESTAURANT.ar.md
    .env.example
    LICENSE
    LICENSE.WaCalls
)
payload_files=(
    install.sh
    install.py
    compose.yml
    manage.sh
    INSTALL.ar.md
    release.json
    RESTAURANT.ar.md
    .env.example
    LICENSE
    LICENSE.WaCalls
    images.tar.gz
)
for source_file in "${source_files[@]}"; do
    [[ -f "$project_dir/$source_file" && ! -L "$project_dir/$source_file" ]] \
        || fail "Missing or symlinked release file: $source_file"
done
bash -n "$project_dir/deploy/install.sh"
bash -n "$project_dir/deploy/manage.sh"
# install.sh must handle --help before dependency checks or state changes. Its
# exact help is embedded, so .run --help does not extract the image archive.
installer_help="$(bash "$project_dir/deploy/install.sh" --help)"
[[ -n "$installer_help" ]] || fail 'Installer did not provide --help output.'
gzip --test -- "$image_archive"

output_parent="$(dirname -- "$output")"
mkdir -p -- "$output_parent"
output_parent="$(cd -- "$output_parent" && pwd -P)"
output_name="${output##*/}"
[[ -n "$output_name" && "$output_name" != . && "$output_name" != .. ]] || fail 'Invalid output filename.'
output="$output_parent/$output_name"
[[ ! -e "$output" && ! -L "$output" ]] || fail 'Output already exists; choose a new versioned filename.'

build_tmp=''
build_tmp_parent="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
temporary_output=''
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    if [[ -n "$temporary_output" \
        && "$temporary_output" == "$output_parent"/.astracalls-installer.???????? \
        && -f "$temporary_output" && ! -L "$temporary_output" && -O "$temporary_output" ]]; then
        rm -f -- "$temporary_output" || status=1
    fi
    if [[ -n "$build_tmp" \
        && "$build_tmp" == "$build_tmp_parent"/astracalls-bundle.???????? \
        && -d "$build_tmp" && ! -L "$build_tmp" && -O "$build_tmp" ]]; then
        rm -rf -- "$build_tmp" || status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
build_tmp="$(mktemp -d "$build_tmp_parent/astracalls-bundle.XXXXXXXX")"
chmod 700 -- "$build_tmp"
mkdir -- "$build_tmp/files"

for index in "${!source_files[@]}"; do
    cp -- "$project_dir/${source_files[$index]}" "$build_tmp/files/${payload_files[$index]}"
done
cp --reflink=auto -- "$image_archive" "$build_tmp/files/images.tar.gz"
chmod 644 -- "${payload_files[@]/#/$build_tmp/files/}"
chmod 755 -- "$build_tmp/files/install.sh" "$build_tmp/files/manage.sh"
(
    cd -- "$build_tmp/files"
    sha256sum -- "${payload_files[@]}" > SHA256SUMS
)

# The outer payload is deliberately uncompressed: images.tar.gz is already
# compressed. Fixed names and normalized ownership make extraction predictable.
tar --create --format=ustar --owner=0 --group=0 --numeric-owner --mtime=@0 \
    --file="$build_tmp/payload.tar" --directory="$build_tmp/files" \
    -- "${payload_files[@]}" SHA256SUMS
payload_hash="$(sha256sum < "$build_tmp/payload.tar")"
payload_hash="${payload_hash%% *}"
temporary_output="$(mktemp "$output_parent/.astracalls-installer.XXXXXXXX")"

{
    printf '%s\n' '#!/usr/bin/env bash' 'set +x' 'set -Eeuo pipefail' 'umask 077'
    printf 'payload_sha256=%q\n' "$payload_hash"
    printf 'installer_help=%q\n' "$installer_help"
    cat <<'RUN_HEADER'

fail() {
    printf 'ERROR: %s\n' "$*" >&2
    exit 1
}

if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    printf '%s\n' "$installer_help"
    exit 0
fi
for dependency in bash tar sha256sum mktemp tail awk mkdir chmod rm; do
    command -v "$dependency" >/dev/null || fail "Required command is missing: $dependency"
done
bundle_file="${BASH_SOURCE[0]}"
[[ -r "$bundle_file" && -f "$bundle_file" ]] || fail 'Run the installer from a saved local .run file.'
payload_line="$(awk '/^__ASTRACALLS_PAYLOAD_BELOW__$/ { print NR + 1; exit }' "$bundle_file")"
[[ "$payload_line" =~ ^[0-9]+$ ]] || fail 'Installer payload marker is missing.'

run_tmp=''
run_tmp_parent="$(cd -- "${TMPDIR:-/tmp}" && pwd -P)"
cleanup() {
    local status=$?
    trap - EXIT INT TERM
    # Only remove the private directory this invocation successfully created.
    if [[ -n "$run_tmp" \
        && "$run_tmp" == "$run_tmp_parent"/astracalls-run.???????? \
        && -d "$run_tmp" && ! -L "$run_tmp" && -O "$run_tmp" ]]; then
        rm -rf -- "$run_tmp" || status=1
    fi
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
run_tmp="$(mktemp -d "$run_tmp_parent/astracalls-run.XXXXXXXX")"
chmod 700 -- "$run_tmp"

printf '%s\n' 'Verifying and extracting the AstraCalls offline installer...'
tail -n +"$payload_line" -- "$bundle_file" > "$run_tmp/payload.tar"
actual_hash="$(sha256sum < "$run_tmp/payload.tar")"
actual_hash="${actual_hash%% *}"
[[ "$actual_hash" == "$payload_sha256" ]] || fail 'Installer payload checksum mismatch; obtain an intact copy.'

# Verify the exact member list before extracting, including order. The verified
# payload was built exclusively from regular files with these fixed names.
expected_members="$(printf '%s\n' \
    install.sh install.py compose.yml manage.sh INSTALL.ar.md release.json RESTAURANT.ar.md .env.example \
    LICENSE LICENSE.WaCalls images.tar.gz SHA256SUMS)"
actual_members="$(tar --list --file="$run_tmp/payload.tar")"
[[ "$actual_members" == "$expected_members" ]] || fail 'Unexpected installer payload members.'
mkdir -- "$run_tmp/files"
tar --extract --file="$run_tmp/payload.tar" --directory="$run_tmp/files" \
    --no-same-owner --no-same-permissions
(
    cd -- "$run_tmp/files"
    sha256sum --check --strict --status SHA256SUMS
) || fail 'An extracted installer file failed checksum verification.'
rm -f -- "$run_tmp/payload.tar"
bash "$run_tmp/files/install.sh" "$@"
exit 0
__ASTRACALLS_PAYLOAD_BELOW__
RUN_HEADER
    cat -- "$build_tmp/payload.tar"
} > "$temporary_output"
chmod 755 -- "$temporary_output"
# Creating a hard link in the same directory publishes the complete file
# atomically and fails if any file, symlink, or directory already uses the name.
ln --no-target-directory -- "$temporary_output" "$output" \
    || fail 'Could not publish installer; the output may have appeared during the build.'
rm -f -- "$temporary_output"
temporary_output=''
printf 'Created: %s\n' "$output"
printf 'Installer SHA-256: '
sha256sum < "$output"
printf '%s\n' 'Only the explicitly listed release files and Docker images were packaged.'
