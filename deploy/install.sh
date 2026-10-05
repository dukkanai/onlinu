#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077
if [[ "${1:-}" == --help || "${1:-}" == -h ]]; then
    printf '%s\n' \
        'AstraCalls 0.3.0 offline installer — Linux/AMD64' \
        'Usage: bash astracalls-installer-0.3.0-linux-amd64.run [options]' \
        '  --name NAME          Instance name (default: portable)' \
        '  --dir PATH           Installation directory (default: ./astracalls-NAME)' \
        '  --http-port PORT     HTTP port (default: first free port from 8080)' \
        '  --media-port PORT    TCP/UDP media port (default: first free port from 50000)' \
        '  --public-ip IPv4    Advertised media IP (default: 127.0.0.1)' \
        '  --http-bind IPv4    HTTP bind address (default: 127.0.0.1)' \
        '  --media-bind IPv4   Media bind (default: localhost; 0.0.0.0 with public IP)' \
        '  --public-url URL    Public HTTPS application URL (optional)' \
        '  --help              Show this help without installing anything' \
        '' \
        'Requires Docker Engine, Docker Compose with --wait, Python 3 and a local Linux/AMD64 daemon.' \
        'No Docker installation, firewall changes, image pulls or existing-data migration.' \
        'Each instance gets new credentials and separate databases/recordings.' \
        'Rerun the same command to preserve and start an existing managed installation.'
    exit 0
fi
command -v python3 >/dev/null || { printf 'ERROR: Python 3 is required.\n' >&2; exit 1; }
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
exec python3 "$script_dir/install.py" "$@"
