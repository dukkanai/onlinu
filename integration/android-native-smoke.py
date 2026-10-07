#!/usr/bin/env python3
"""Opt-in Android compile/software-emulator checks. No physical device, store or live API."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import time
import uuid
import xml.etree.ElementTree as ET
import zipfile

ANDROID = '{http://schemas.android.com/apk/res/android}'
PACKAGE = 'dev.synthetic.restaurant_admin_prototype'
CALLBACK_SCHEME = 'invalid.control.onlinu.android'
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
    activities = [x for x in app.findall('activity') if x.get(ANDROID + 'name') == '.MainActivity']
    if len(activities) != 1:
        raise ValueError('Expected one generated Flutter activity.')
    activity = activities[0]
    for node in list(activity):
        if (node.tag == 'meta-data' and node.get(ANDROID + 'name') == 'flutter_deeplinking_enabled'
                or node.tag == 'intent-filter' and any(x.get(ANDROID + 'scheme') == CALLBACK_SCHEME for x in node.findall('data'))):
            activity.remove(node)
    ET.SubElement(activity, 'meta-data', {ANDROID + 'name': 'flutter_deeplinking_enabled', ANDROID + 'value': 'false'})
    callback = ET.SubElement(activity, 'intent-filter')
    ET.SubElement(callback, 'action', {ANDROID + 'name': 'android.intent.action.VIEW'})
    for category in ['android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE']:
        ET.SubElement(callback, 'category', {ANDROID + 'name': category})
    ET.SubElement(callback, 'data', {ANDROID + 'scheme': CALLBACK_SCHEME})
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
    activities = [x for x in app.findall('activity') if x.get(ANDROID + 'name') in ['.MainActivity', PACKAGE + '.MainActivity']]
    if len(activities) != 1:
        raise ValueError('Built Flutter activity is not unique.')
    activity = activities[0]
    metadata = [x for x in activity.findall('meta-data') if x.get(ANDROID + 'name') == 'flutter_deeplinking_enabled']
    callbacks = [x for x in activity.findall('intent-filter') if any(d.get(ANDROID + 'scheme') == CALLBACK_SCHEME for d in x.findall('data'))]
    if (len(metadata) != 1 or metadata[0].get(ANDROID + 'value') != 'false' or len(callbacks) != 1
            or len(callbacks[0].findall('data')) != 1
            or callbacks[0].find('data').attrib != {ANDROID + 'scheme': CALLBACK_SCHEME}
            or [x.get(ANDROID + 'name') for x in callbacks[0].findall('action')] != ['android.intent.action.VIEW']
            or {x.get(ANDROID + 'name') for x in callbacks[0].findall('category')} != {'android.intent.category.DEFAULT', 'android.intent.category.BROWSABLE'}):
        raise ValueError('Built mobile callback contract is missing or broadened.')


def verify_apk_abi(path):
    with zipfile.ZipFile(path) as archive:
        libraries = [name for name in archive.namelist() if name.startswith('lib/') and name.endswith('/libflutter.so')]
    if libraries != ['lib/arm64-v8a/libflutter.so']:
        raise ValueError('Android smoke must contain only the selected arm64 Flutter engine.')


def run(args, cwd, timeout=900):
    subprocess.run([str(x) for x in args], cwd=cwd, check=True, timeout=timeout)


def unused_emulator_port():
    for port in range(5554, 5682, 2):
        sockets = []
        try:
            for candidate in [port, port + 1]:
                connection = socket.socket()
                sockets.append(connection)
                connection.bind(('127.0.0.1', candidate))
            return port
        except OSError:
            pass
        finally:
            for connection in sockets:
                connection.close()
    raise ValueError('No unoccupied emulator console/ADB port pair.')


def verify_avd_name(actual, expected):
    if actual.strip() != expected or not re.fullmatch(r'onlinu-ci-[0-9]+-[a-f0-9]{12}', expected):
        raise ValueError('Emulator identity differs from the newly created owned AVD.')


def emulator_checks(flutter, project, output, sdk):
    image = 'system-images;android-35;google_apis;x86_64'
    tools = sorted(sdk.glob('cmdline-tools/*/bin/sdkmanager'))
    if not tools or shutil.disk_usage(sdk).free < 8 * 1024**3:
        raise ValueError('Official SDK manager and 8 GiB free space are required.')
    manager = tools[-1]
    emulator = sdk / 'emulator/emulator'
    system_image = sdk / 'system-images/android-35/google_apis/x86_64/system.img'
    if not emulator.is_file() or not system_image.is_file():
        # Use only the official SDK manager and already-accepted runner licenses.
        # A new license prompt is declined, never automatically accepted.
        subprocess.run([str(manager), '--install', 'emulator', image], input='n\n', text=True,
                       check=True, timeout=600)
    if not emulator.is_file() or not system_image.is_file():
        raise ValueError('Emulator packages unavailable; no new SDK agreement was accepted.')
    root = Path(tempfile.mkdtemp(prefix='onlinu-android-emulator-', dir=os.environ['RUNNER_TEMP']))
    name = 'onlinu-ci-' + os.environ['GITHUB_RUN_ID'] + '-' + uuid.uuid4().hex[:12]
    port = unused_emulator_port()
    serial = 'emulator-' + str(port)
    env = dict(os.environ, ANDROID_AVD_HOME=str(root / 'avd'),
               ANDROID_USER_HOME=str(root / 'user'), ANDROID_EMULATOR_HOME=str(root / 'emulator'),
               ANDROID_I_WANT_MY_TCG='yes')
    for field in ['ANDROID_AVD_HOME', 'ANDROID_USER_HOME', 'ANDROID_EMULATOR_HOME']:
        Path(env[field]).mkdir()
    adb = sdk / 'platform-tools/adb'
    process = None
    try:
        subprocess.run([str(manager.parent / 'avdmanager'), 'create', 'avd', '--name', name,
                        '--package', image, '--path', str(root / 'device.avd')],
                       input='no\n', text=True, env=env, check=True, timeout=120)
        with (root / 'emulator.log').open('wb') as log:
            process = subprocess.Popen([str(emulator), '-avd', name, '-port', str(port),
                                        '-no-window', '-no-audio', '-no-boot-anim', '-no-snapshot',
                                        '-camera-back', 'none', '-camera-front', 'none',
                                        '-gpu', 'swiftshader_indirect', '-accel', 'off', '-memory', '2048',
                                        '-cores', '2'], env=env, stdout=log, stderr=subprocess.STDOUT,
                                       start_new_session=True)
            deadline = time.monotonic() + 600
            while True:
                if process.poll() is not None:
                    raise ValueError('Owned software emulator exited before boot: ' + (root / 'emulator.log').read_text(errors='replace')[-2000:])
                try:
                    completed = subprocess.check_output([str(adb), '-s', serial, 'shell', 'getprop', 'sys.boot_completed'],
                                                        text=True, stderr=subprocess.DEVNULL, timeout=10).strip()
                    if completed == '1':
                        actual = subprocess.check_output([str(adb), '-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name'],
                                                         text=True, timeout=10)
                        verify_avd_name(actual, name)
                        break
                except (subprocess.CalledProcessError, subprocess.TimeoutExpired):
                    pass
                if time.monotonic() >= deadline:
                    raise ValueError('Owned software emulator boot exceeded its ten-minute bound.')
                time.sleep(5)
            print('Owned Android emulator boot and identity verified; no KVM permission change.', flush=True)
            subprocess.run([*map(str, flutter), 'test', 'integration_test/android_smoke_test.dart',
                            '--no-pub', '--no-uninstall', '-d', serial, '--reporter=expanded'],
                           cwd=project, env=env, check=True, timeout=900)
            verify_avd_name(subprocess.check_output([str(adb), '-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name'],
                                                   text=True, timeout=10), name)
            picture = subprocess.check_output([str(adb), '-s', serial, 'exec-out', 'run-as', PACKAGE,
                                               'cat', 'cache/onlinu-android-orders.png'], timeout=30)
            if not 8 < len(picture) <= 16 * 1024**2 or not picture.startswith(b'\x89PNG\r\n\x1a\n'):
                raise ValueError('Expected bounded Android rendering evidence is missing.')
            (output / 'android-orders.png').write_bytes(picture)
            result = {'systemImage': image, 'acceleration': 'software-only',
                      'screenshotSha256': hashlib.sha256(picture).hexdigest(),
                      'checks': ['owned-avd-identity', 'real-android-keystore-isolation', 'owned-url-scheme-roundtrip',
                                 'synthetic-token-transport', 'arabic-rendering', 'logout-clears-detail']}
    finally:
        if process is not None and process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=10)
        # Never kill the shared ADB daemon or another device. Only the owned
        # process group and this exclusively created temporary directory belong here.
        if process is not None:
            deadline = time.monotonic() + 30
            while True:
                try:
                    remaining = subprocess.check_output([str(adb), '-s', serial, 'shell', 'getprop', 'ro.boot.qemu.avd_name'],
                                                        text=True, stderr=subprocess.DEVNULL, timeout=5).strip()
                except subprocess.CalledProcessError:
                    remaining = ''
                if remaining != name:
                    break
                if time.monotonic() >= deadline:
                    raise ValueError('Owned AVD still responds after process shutdown; files retained.')
                time.sleep(1)
        if process is None or process.poll() is not None:
            shutil.rmtree(root)
        else:
            raise ValueError('Owned emulator shutdown could not be confirmed.')
    result['ownedProcessStopped'] = True
    result['ownedFilesRemoved'] = not root.exists()
    return result


def main():
    validate_context(os.environ)
    execute = os.environ.get('ONLINU_ANDROID_EXECUTE', '0')
    if execute not in ['0', '1']:
        raise ValueError('Invalid Android execution flag.')
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
    for name in ['LICENSE', 'LICENSE.WaCalls']:
        shutil.copy2(SOURCE / name, output / name)
    (output / 'SOURCE.txt').write_text('Source: https://github.com/dukkanai/onlinu/tree/' + current + '\nCompile-only debug artifact; no production endpoint or release signing.\n')
    execution = emulator_checks(flutter, project, output, android_sdk) if execute == '1' else None
    report = {'sourceCommit': current, 'flutterVersion': version['frameworkVersion'], 'package': PACKAGE,
              'apkSha256': digest, 'apkBytes': target.stat().st_size, 'targetABI': 'arm64-v8a',
              'debugBuild': True, 'productionConfigured': False, 'storePublished': False,
              'actualDeviceTested': False, 'realCredentialsUsed': False,
              'emulatorExecutionTested': execution is not None, 'emulatorExecution': execution,
              'checks': ['reviewed-lockfile-unchanged', 'flutter-analysis', 'flutter-unit-widget-tests',
                         'android-debug-compilation', 'arm64-only-flutter-engine', 'built-manifest-network-backup-debug-contract'],
              'notVerified': ([] if execution else ['android-device-rendering', 'android-secure-storage']) + ['mobile-login',
                              'background-resume', 'notifications', 'release-signing', 'store-distribution', 'ios']}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
