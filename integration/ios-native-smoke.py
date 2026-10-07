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


def run(args, cwd, timeout=900):
    subprocess.run([str(x) for x in args], cwd=cwd, check=True, timeout=timeout)


def main():
    validate_context(os.environ)
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
    report = {'sourceCommit': current, 'flutterVersion': version['frameworkVersion'], 'xcodeVersion': xcode,
              'package': PACKAGE, 'archiveSha256': digest, 'archiveBytes': archive.stat().st_size,
              'architectures': architectures, 'simulatorOnly': True, 'codeSigningDisabledArgument': True,
              'productionConfigured': False, 'storePublished': False, 'actualDeviceTested': False,
              'simulatorExecutionTested': False, 'realCredentialsUsed': False,
              'checks': ['reviewed-lockfile-unchanged', 'flutter-analysis', 'flutter-unit-widget-tests',
                         'ios-simulator-debug-compilation', 'built-plist-simulator-identity-transport-contract',
                         'no-device-provisioning-profile', 'simulator-executable-architecture'],
              'notVerified': ['ios-rendering', 'ios-keychain', 'mobile-login', 'background-resume',
                              'notifications', 'device-signing', 'store-distribution']}
    (output / 'report.json').write_text(json.dumps(report, indent=2) + '\n')


if __name__ == '__main__':
    main()
