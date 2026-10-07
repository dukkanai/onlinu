#!/usr/bin/env python3
"""Opt-in ephemeral Android compilation. No device, store, signing account or live API."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ANDROID = '{http://schemas.android.com/apk/res/android}'
PACKAGE = 'dev.synthetic.restaurant_admin_prototype'
SOURCE = Path(__file__).resolve().parents[1]


def validate_context(env):
    if (env.get('GITHUB_ACTIONS') != 'true' or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or env.get('GITHUB_REPOSITORY') != 'dukkanai/onlinu' or env.get('RUNNER_OS') != 'Linux'
            or not re.fullmatch(r'[0-9]+', env.get('GITHUB_RUN_ID', ''))
            or not re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', ''))
            or Path(env.get('GITHUB_WORKSPACE', '')).resolve() != SOURCE
            or not Path(env.get('RUNNER_TEMP', '')).is_absolute()):
        raise ValueError('Android smoke requires its explicit ephemeral CI context.')


def secure_manifest(path):
    ET.register_namespace('android', ANDROID[1:-1])
    tree = ET.parse(path)
    root = tree.getroot()
    app = root.find('application')
    if root.tag != 'manifest' or app is None or len(root.findall('application')) != 1:
        raise ValueError('Unexpected generated Android manifest.')
    app.set(ANDROID + 'label', 'Onlinu Android Smoke')
    app.set(ANDROID + 'allowBackup', 'false')
    app.set(ANDROID + 'usesCleartextTraffic', 'false')
    if not any(node.get(ANDROID + 'name') == 'android.permission.INTERNET' for node in root.findall('uses-permission')):
        ET.SubElement(root, 'uses-permission', {ANDROID + 'name': 'android.permission.INTERNET'})
    tree.write(path, encoding='utf-8', xml_declaration=True)


def verify_built_manifest(xml):
    root = ET.fromstring(xml)
    app = root.find('application')
    if (root.get('package') != PACKAGE or app is None or app.get(ANDROID + 'allowBackup') != 'false'
            or app.get(ANDROID + 'usesCleartextTraffic') != 'false' or app.get(ANDROID + 'debuggable') != 'true'
            or not any(x.get(ANDROID + 'name') == 'android.permission.INTERNET' for x in root.findall('uses-permission'))):
        raise ValueError('Built Android smoke manifest failed its isolation contract.')


def verify_apk_abi(path):
    with zipfile.ZipFile(path) as archive:
        libraries = [name for name in archive.namelist() if name.startswith('lib/') and name.endswith('/libflutter.so')]
    if libraries != ['lib/arm64-v8a/libflutter.so']:
        raise ValueError('Android smoke must contain only the selected arm64 Flutter engine.')


def run(args, cwd, timeout=900):
    subprocess.run([str(x) for x in args], cwd=cwd, check=True, timeout=timeout)


def main():
    validate_context(os.environ)
    current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    if current != os.environ['GITHUB_SHA']:
        raise ValueError('Source commit does not match this CI run.')
    sdk = Path(os.environ['ONLINU_FLUTTER_SDK']).resolve()
    temporary = Path(os.environ['RUNNER_TEMP']).resolve()
    if not sdk.is_relative_to(temporary) or not (sdk / 'bin/flutter').is_file():
        raise ValueError('Flutter SDK must be the checksum-verified ephemeral SDK.')
    flutter = [sdk / 'bin/flutter', '--suppress-analytics', '--no-version-check']
    version = json.loads(subprocess.check_output([*map(str, flutter), '--version', '--machine'], text=True, timeout=120))
    if version.get('frameworkVersion') != '3.47.5':
        raise ValueError('Unexpected Flutter SDK version.')
    directory = Path(tempfile.mkdtemp(prefix='onlinu-android-smoke-', dir=temporary))
    project = directory / 'app'
    run([*flutter, 'create', '--no-pub', '--platforms=android', '--project-name=restaurant_admin_prototype',
         '--org=dev.synthetic', project], SOURCE)
    # Only the tool-created template test is replaced; never touch the source tree.
    (project / 'test/widget_test.dart').unlink()
    source = SOURCE / 'prototype/admin_flutter'
    for name in ['lib', 'test', 'integration_http', 'integration_test']:
        shutil.copytree(source / name, project / name, dirs_exist_ok=True)
    for name in ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml']:
        shutil.copy2(source / name, project / name)
    secure_manifest(project / 'android/app/src/main/AndroidManifest.xml')
    properties = project / 'android/gradle.properties'
    text = properties.read_text()
    text = re.sub(r'^org.gradle.jvmargs=.*$', 'org.gradle.jvmargs=-Xmx3G -XX:MaxMetaspaceSize=1G -XX:ReservedCodeCacheSize=256m', text, flags=re.M)
    properties.write_text(text + '\norg.gradle.workers.max=2\n')
    run([*flutter, 'pub', 'get', '--enforce-lockfile'], project)
    if (project / 'pubspec.lock').read_bytes() != (source / 'pubspec.lock').read_bytes():
        raise ValueError('Android dependency restore changed the reviewed lockfile.')
    run([*flutter, 'analyze', '--no-pub'], project)
    run([*flutter, 'test', '--no-pub', '--reporter=expanded'], project)
    run([*flutter, 'build', 'apk', '--debug', '--no-pub', '--target-platform=android-arm64',
         '--dart-define=CORE_API_BASE_URL=https://control.invalid'], project, timeout=1500)
    apk = project / 'build/app/outputs/flutter-apk/app-debug.apk'
    if not apk.is_file() or not 0 < apk.stat().st_size <= 256 * 1024 * 1024:
        raise ValueError('Expected bounded Android debug APK is missing.')
    verify_apk_abi(apk)
    android_sdk = Path(os.environ['ANDROID_HOME'])
    analyzers = sorted(android_sdk.glob('cmdline-tools/*/bin/apkanalyzer'))
    if not analyzers:
        raise ValueError('Preinstalled APK analyzer is required; no new SDK agreement is accepted here.')
    decoded = subprocess.check_output([str(analyzers[-1]), 'manifest', 'print', str(apk)], text=True, timeout=120)
    verify_built_manifest(decoded)
    output = SOURCE / 'artifacts/android-native'
    output.mkdir(parents=True, exist_ok=False)
    target = output / 'onlinu-android-smoke-debug-arm64.apk'
    shutil.copy2(apk, target)
    with target.open('rb') as stream:
        digest = hashlib.file_digest(stream, 'sha256').hexdigest()
    report = {'sourceCommit': current, 'flutterVersion': version['frameworkVersion'], 'package': PACKAGE,
              'apkSha256': digest, 'apkBytes': target.stat().st_size, 'targetABI': 'arm64-v8a',
              'debugBuild': True, 'productionConfigured': False, 'storePublished': False,
              'actualDeviceTested': False, 'realCredentialsUsed': False,
              'checks': ['reviewed-lockfile-unchanged', 'flutter-analysis', 'flutter-unit-widget-tests',
                         'android-debug-compilation', 'arm64-only-flutter-engine', 'built-manifest-network-backup-debug-contract'],
              'notVerified': ['android-device-rendering', 'android-secure-storage', 'mobile-login',
                              'background-resume', 'notifications', 'release-signing', 'store-distribution', 'ios']}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
