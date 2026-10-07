#!/usr/bin/env python3
"""Read-only hosted-runner emulator prerequisites. Never installs or changes permissions."""
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess


def inspect_sdk(sdk, kvm=Path('/dev/kvm')):
    sdk = sdk.resolve(strict=True)
    images = []
    for metadata in sorted(sdk.glob('system-images/*/*/*/source.properties')):
        if (metadata.is_symlink() or not metadata.resolve().is_relative_to(sdk)
                or metadata.stat().st_size > 65536 or not (metadata.parent / 'system.img').is_file()):
            continue
        values = dict(line.split('=', 1) for line in metadata.read_text().splitlines() if '=' in line)
        values = {key.strip(): value.strip() for key, value in values.items()}
        path_parts = metadata.parent.relative_to(sdk / 'system-images').parts
        image = 'system-images;' + ';'.join(path_parts)
        if values.get('Pkg.Path', image) != image:
            continue
        if re.fullmatch(r'system-images;android-[0-9]+;(default|google_apis|google_apis_atd);x86_64', image):
            images.append(image)
    emulator = sdk / 'emulator/emulator'
    executable = emulator.is_file() and os.access(emulator, os.X_OK)
    acceleration = None
    if executable:
        result = subprocess.run([str(emulator), '-accel-check'], capture_output=True, text=True, timeout=30)
        acceleration = {'exitCode': result.returncode, 'diagnostic': (result.stdout + result.stderr)[:4096]}
    return {'hostArchitecture': platform.machine(), 'emulatorInstalled': executable,
            'installedX86Images': images, 'kvmExists': kvm.exists(),
            'kvmReadable': os.access(kvm, os.R_OK), 'kvmWritable': os.access(kvm, os.W_OK),
            'accelerationCheck': acceleration, 'freeBytes': shutil.disk_usage(sdk).free,
            'installedOrChangedAnything': False, 'deviceStarted': False,
            'runtimeAcceptance': False}


def main():
    if (os.environ.get('GITHUB_ACTIONS') != 'true'
            or os.environ.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or os.environ.get('GITHUB_REPOSITORY') != 'dukkanai/onlinu'
            or os.environ.get('RUNNER_OS') != 'Linux'
            or not re.fullmatch(r'[a-f0-9]{40}', os.environ.get('GITHUB_SHA', ''))):
        raise ValueError('Requires explicit owner-hosted diagnostic workflow.')
    sdk = Path(os.environ['ANDROID_HOME'])
    if not sdk.is_absolute() or not sdk.is_dir():
        raise ValueError('Preinstalled Android SDK is unavailable.')
    report = {'sourceCommit': os.environ['GITHUB_SHA'], **inspect_sdk(sdk)}
    output = Path(__file__).resolve().parents[1] / 'artifacts/android-emulator-preflight'
    output.mkdir(parents=True, exist_ok=False)
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
