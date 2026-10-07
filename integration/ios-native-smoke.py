#!/usr/bin/env python3
"""Opt-in iOS Simulator compilation, without a device, Apple account or signing grant."""
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import tempfile
import uuid

SOURCE = Path(__file__).resolve().parents[1]
PACKAGE = 'dev.synthetic.restaurantAdminPrototype'


def validate_context(env):
    if (env.get('GITHUB_ACTIONS') != 'true' or env.get('GITHUB_EVENT_NAME') != 'workflow_dispatch'
            or env.get('GITHUB_REPOSITORY') != 'dukkanai/onlinu' or env.get('RUNNER_OS') != 'macOS'
            or not re.fullmatch(r'[0-9]+', env.get('GITHUB_RUN_ID', ''))
            or not re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', ''))
            or Path(env.get('GITHUB_WORKSPACE', '')).resolve() != SOURCE
            or not Path(env.get('RUNNER_TEMP', '')).is_absolute()):
        raise ValueError('iOS smoke requires its explicit ephemeral macOS CI context.')


def secure_plist(path):
    with path.open('rb') as stream:
        info = plistlib.load(stream)
    if info.get('CFBundleIdentifier') != '$(PRODUCT_BUNDLE_IDENTIFIER)':
        raise ValueError('Unexpected generated iOS application identity.')
    info['CFBundleDisplayName'] = 'Onlinu iOS Smoke'
    info['UIFileSharingEnabled'] = False
    info.setdefault('NSAppTransportSecurity', {})['NSAllowsArbitraryLoads'] = False
    with path.open('wb') as stream:
        plistlib.dump(info, stream)


def verify_built_plist(info):
    if (info.get('CFBundleIdentifier') != PACKAGE or info.get('CFBundleSupportedPlatforms') != ['iPhoneSimulator']
            or info.get('DTPlatformName') != 'iphonesimulator' or info.get('CFBundleExecutable') != 'Runner'
            or info.get('UIFileSharingEnabled') is not False
            or info.get('NSAppTransportSecurity', {}).get('NSAllowsArbitraryLoads') is not False):
        raise ValueError('Built iOS bundle failed its Simulator-only smoke contract.')



def simulator_template(inventory):
    runtimes = [item for item in inventory.get('runtimes', []) if item.get('isAvailable') is True
                and str(item.get('identifier', '')).startswith('com.apple.CoreSimulator.SimRuntime.iOS-')]
    runtimes.sort(key=lambda item: tuple(int(part) for part in str(item.get('version', '0')).split('.')), reverse=True)
    types = {item.get('identifier') for item in inventory.get('devicetypes', []) if item.get('productFamily') == 'iPhone'}
    for runtime in runtimes:
        for device in inventory.get('devices', {}).get(runtime['identifier'], []):
            if device.get('isAvailable') is True and device.get('deviceTypeIdentifier') in types:
                return runtime['identifier'], device['deviceTypeIdentifier']
    raise ValueError('An existing available iPhone Simulator runtime is required; nothing is downloaded.')


def owned_simulator(inventory, runtime, identifier, name):
    matches = [item for item in inventory.get('devices', {}).get(runtime, []) if item.get('udid', '').upper() == identifier]
    if len(matches) != 1 or matches[0].get('name') != name or matches[0].get('isAvailable') is not True:
        raise ValueError('Created Simulator ownership could not be verified.')
    return matches[0]


def simulator_checks(flutter, project, output):
    def inventory(devices_only=False):
        args = ['xcrun', 'simctl', 'list', *(['devices'] if devices_only else []), '--json']
        # A freshly booted hosted Simulator can still be settling its service.
        # Bound the read, but do not weaken identity checks or restart the daemon.
        return json.loads(subprocess.check_output(args, text=True, timeout=180))
    runtime, device_type = simulator_template(inventory())
    name = 'onlinu-ci-' + os.environ['GITHUB_RUN_ID'] + '-' + uuid.uuid4().hex[:12]
    identifier = subprocess.check_output(['xcrun', 'simctl', 'create', name, device_type, runtime], text=True, timeout=60).strip().upper()
    if not re.fullmatch(r'[A-F0-9]{8}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{12}', identifier):
        raise ValueError('Simulator creation result is uncertain; no arbitrary cleanup is attempted.')
    try:
        owned_simulator(inventory(devices_only=True), runtime, identifier, name)
        run(['xcrun', 'simctl', 'boot', identifier], project, timeout=90)
        run(['xcrun', 'simctl', 'bootstatus', identifier, '-b'], project, timeout=300)
        print('Checking owned Simulator after initial boot.', flush=True)
        owned_simulator(inventory(devices_only=True), runtime, identifier, name)
        print('Running actual iOS Keychain and rendering tests.', flush=True)
        run([*flutter, 'test', 'integration_test/ios_smoke_test.dart', '--no-pub', '-d', identifier,
             '--reporter=expanded'], project, timeout=900)
        container = Path(subprocess.check_output(['xcrun', 'simctl', 'get_app_container', identifier, PACKAGE, 'data'], text=True, timeout=60).strip()).resolve(strict=True)
        if not container.is_absolute() or '/' + identifier + '/' not in str(container).upper():
            raise ValueError('Unexpected owned Simulator application container.')
        screenshot = container / 'tmp/onlinu-ios-orders.png'
        if not screenshot.is_file() or not 8 < screenshot.stat().st_size <= 16 * 1024 * 1024:
            raise ValueError('Expected bounded iOS rendering evidence is missing.')
        picture = screenshot.read_bytes()
        if not picture.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('Unexpected iOS rendering format.')
        (output / 'ios-orders.png').write_bytes(picture)
        result = {'runtime': runtime, 'deviceType': device_type, 'screenshotSha256': hashlib.sha256(picture).hexdigest(),
                  'checks': ['real-ios-keychain-isolation', 'owned-test-key-removal', 'external-browser-capability-only',
                             'arabic-rtl-order-detail-rendering', 'logout-clears-detail', 'owned-simulator-cleanup']}
    finally:
        current = owned_simulator(inventory(devices_only=True), runtime, identifier, name)
        if current.get('state') != 'Shutdown':
            run(['xcrun', 'simctl', 'shutdown', identifier], project, timeout=90)
        owned_simulator(inventory(devices_only=True), runtime, identifier, name)
        run(['xcrun', 'simctl', 'delete', identifier], project, timeout=90)
        remaining = inventory(devices_only=True)
        if any(item.get('udid', '').upper() == identifier for devices in remaining.get('devices', {}).values() for item in devices):
            raise ValueError('Owned Simulator cleanup was not confirmed.')
        print('Owned Simulator cleanup confirmed.', flush=True)
    return result


def run(args, cwd, timeout=900):
    subprocess.run([str(x) for x in args], cwd=cwd, check=True, timeout=timeout)


def main():
    validate_context(os.environ)
    execute = os.environ.get('ONLINU_IOS_EXECUTE', '0')
    if execute not in {'0', '1'}:
        raise ValueError('Unexpected Simulator execution selection.')
    current = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=SOURCE, text=True).strip()
    if current != os.environ['GITHUB_SHA']:
        raise ValueError('Source commit does not match this CI run.')
    temporary = Path(os.environ['RUNNER_TEMP']).resolve()
    sdk = Path(os.environ['ONLINU_FLUTTER_SDK']).resolve()
    if not sdk.is_relative_to(temporary) or not (sdk / 'bin/flutter').is_file():
        raise ValueError('Flutter SDK must be the checksum-verified ephemeral SDK.')
    flutter = [sdk / 'bin/flutter', '--suppress-analytics', '--no-version-check']
    version = json.loads(subprocess.check_output([*map(str, flutter), '--version', '--machine'], text=True, timeout=120))
    if version.get('frameworkVersion') != '3.47.5':
        raise ValueError('Unexpected Flutter SDK version.')
    # Read the preinstalled toolchain. Never accept a license or install profiles.
    xcode = subprocess.check_output(['xcodebuild', '-version'], text=True, timeout=60).strip()
    project = Path(tempfile.mkdtemp(prefix='onlinu-ios-smoke-', dir=temporary)) / 'app'
    run([*flutter, 'create', '--no-pub', '--platforms=ios', '--project-name=restaurant_admin_prototype',
         '--org=dev.synthetic', project], SOURCE)
    (project / 'test/widget_test.dart').unlink()
    source = SOURCE / 'prototype/admin_flutter'
    for name in ['lib', 'test', 'integration_http', 'integration_test']:
        shutil.copytree(source / name, project / name, dirs_exist_ok=True)
    for name in ['pubspec.yaml', 'pubspec.lock', 'analysis_options.yaml']:
        shutil.copy2(source / name, project / name)
    secure_plist(project / 'ios/Runner/Info.plist')
    run([*flutter, 'pub', 'get', '--enforce-lockfile'], project)
    if (project / 'pubspec.lock').read_bytes() != (source / 'pubspec.lock').read_bytes():
        raise ValueError('iOS dependency restore changed the reviewed lockfile.')
    run([*flutter, 'analyze', '--no-pub'], project)
    run([*flutter, 'test', '--no-pub', '--reporter=expanded'], project)
    run([*flutter, 'build', 'ios', '--simulator', '--debug', '--no-codesign', '--no-pub',
         '--dart-define=CORE_API_BASE_URL=https://control.invalid'], project, timeout=1500)
    app = project / 'build/ios/iphonesimulator/Runner.app'
    with (app / 'Info.plist').open('rb') as stream:
        info = plistlib.load(stream)
    verify_built_plist(info)
    if (app / 'embedded.mobileprovision').exists():
        raise ValueError('A provisioned device application is outside this smoke.')
    architectures = subprocess.check_output(['lipo', '-archs', str(app / 'Runner')], text=True, timeout=30).split()
    if not architectures or len(set(architectures)) != len(architectures) or not set(architectures) <= {'arm64', 'x86_64'}:
        raise ValueError('Unexpected iOS Simulator executable architecture.')
    output = SOURCE / 'artifacts/ios-native'
    output.mkdir(parents=True, exist_ok=False)
    archive = output / 'onlinu-ios-simulator-debug.zip'
    run(['ditto', '-c', '-k', '--keepParent', app, archive], project, timeout=180)
    if not 0 < archive.stat().st_size <= 512 * 1024 * 1024:
        raise ValueError('Unexpected iOS Simulator archive size.')
    checksum = hashlib.sha256()
    with archive.open('rb') as stream:
        for block in iter(lambda: stream.read(1048576), b''):
            checksum.update(block)
    digest = checksum.hexdigest()
    for name in ['LICENSE', 'LICENSE.WaCalls']:
        shutil.copy2(SOURCE / name, output / name)
    (output / 'SOURCE.txt').write_text('Source: https://github.com/dukkanai/onlinu/tree/' + current + '\nCompile-only Simulator debug artifact; no production endpoint or release signing.\n')
    execution = simulator_checks(flutter, project, output) if execute == '1' else None
    report = {'sourceCommit': current, 'flutterVersion': version['frameworkVersion'], 'xcodeVersion': xcode,
              'package': PACKAGE, 'archiveSha256': digest, 'archiveBytes': archive.stat().st_size,
              'architectures': architectures, 'simulatorOnly': True, 'codeSigningDisabledArgument': True,
              'productionConfigured': False, 'storePublished': False, 'actualDeviceTested': False,
              'simulatorExecutionTested': execution is not None, 'realCredentialsUsed': False,
              'simulatorExecution': execution,
              'checks': ['reviewed-lockfile-unchanged', 'flutter-analysis', 'flutter-unit-widget-tests',
                         'ios-simulator-debug-compilation', 'built-plist-simulator-identity-transport-contract',
                         'no-device-provisioning-profile', 'simulator-executable-architecture'],
              'notVerified': ([] if execution else ['ios-rendering', 'ios-keychain']) + ['mobile-login', 'background-resume',
                              'notifications', 'device-signing', 'store-distribution']}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
