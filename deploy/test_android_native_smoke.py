import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
from types import SimpleNamespace
import zipfile
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('android_smoke', Path(__file__).resolve().parents[1] / 'integration/android-native-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class AndroidSmokeTests(unittest.TestCase):
    def test_owned_avd_name_must_match_exact_new_nonce(self):
        smoke.verify_avd_name('onlinu-ci-12-aaaaaaaaaaaa\n', 'onlinu-ci-12-aaaaaaaaaaaa')
        for actual, expected in [('other', 'onlinu-ci-12-aaaaaaaaaaaa'), ('existing', 'existing')]:
            with self.assertRaises(ValueError):
                smoke.verify_avd_name(actual, expected)

    def emulator_fixture(self, root):
        sdk = root / 'sdk'
        for relative in ['cmdline-tools/latest/bin/sdkmanager', 'cmdline-tools/latest/bin/avdmanager',
                         'emulator/emulator', 'platform-tools/adb',
                         'system-images/android-35/google_apis/x86_64/system.img']:
            path = sdk / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'owned synthetic fixture')
        output = root / 'output'
        output.mkdir()
        return sdk, output

    def test_software_execution_uses_only_new_device_and_cleans_exact_process(self):
        class Process:
            pid = 12345
            returncode = None
            def poll(self): return self.returncode
            def wait(self, timeout): self.returncode = 0; return 0
        for wrong_name, failed_test in [(False, False), (True, False), (False, True)]:
            with self.subTest(wrong_name=wrong_name, failed_test=failed_test), tempfile.TemporaryDirectory(prefix='onlinu-emulator-guard-') as directory:
                root = Path(directory)
                sdk, output = self.emulator_fixture(root)
                process = Process()
                def query(args, **kwargs):
                    if process.returncode is not None:
                        raise subprocess.CalledProcessError(1, args)
                    if args[-1] == 'sys.boot_completed': return '1\n'
                    if args[-1] == 'ro.boot.qemu.avd_name': return 'other' if wrong_name else 'onlinu-ci-1-aaaaaaaaaaaa'
                    if args[-1] == 'cache/onlinu-android-orders.png': return smoke.base64.b64encode(bytes.fromhex('89504e470d0a1a0a') + b'fixture')
                    self.fail('Unexpected external read')
                def command(args, **kwargs):
                    if failed_test and 'test' in args:
                        raise subprocess.CalledProcessError(1, args)
                    return subprocess.CompletedProcess(args, 0)
                with patch.dict(smoke.os.environ, {'RUNNER_TEMP': str(root), 'GITHUB_RUN_ID': '1'}), \
                     patch.object(smoke.uuid, 'uuid4', return_value=SimpleNamespace(hex='a'*32)), \
                     patch.object(smoke, 'unused_emulator_port', return_value=5554), \
                     patch.object(smoke.shutil, 'disk_usage', return_value=SimpleNamespace(free=16*1024**3)), \
                     patch.object(smoke.subprocess, 'Popen', return_value=process) as launch, \
                     patch.object(smoke.subprocess, 'run', side_effect=command) as commands, \
                     patch.object(smoke.subprocess, 'check_output', side_effect=query), \
                     patch.object(smoke.os, 'killpg') as kill:
                    if wrong_name or failed_test:
                        with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                            smoke.emulator_checks(['flutter'], root, output, sdk)
                    else:
                        result = smoke.emulator_checks(['flutter'], root, output, sdk)
                        self.assertTrue(result['ownedProcessStopped'])
                        self.assertTrue(result['ownedFilesRemoved'])
                    args = launch.call_args.args[0]
                    self.assertEqual(args[args.index('-accel')+1], 'off')
                    self.assertTrue(launch.call_args.kwargs['start_new_session'])
                    kill.assert_called_once_with(12345, smoke.signal.SIGTERM)
                    self.assertEqual(len(list(root.glob('onlinu-android-emulator-*'))), 0)
                    if wrong_name:
                        self.assertFalse(any('test' in call.args[0] for call in commands.call_args_list))

    def test_missing_packages_never_auto_accept_license_or_launch_device(self):
        with tempfile.TemporaryDirectory(prefix='onlinu-emulator-license-') as directory:
            root = Path(directory)
            manager = root / 'cmdline-tools/latest/bin/sdkmanager'
            manager.parent.mkdir(parents=True)
            manager.write_text('synthetic fixture')
            with patch.object(smoke.shutil, 'disk_usage', return_value=SimpleNamespace(free=16*1024**3)), \
                 patch.object(smoke.subprocess, 'run') as install, patch.object(smoke.subprocess, 'Popen') as launch:
                with self.assertRaisesRegex(ValueError, 'no new SDK agreement'):
                    smoke.emulator_checks(['flutter'], root, root, root)
                self.assertEqual(install.call_args.kwargs['input'], 'n\n')
                launch.assert_not_called()

    def test_png_transfer_decodes_wrapping_but_never_remote_error_text(self):
        picture = bytes.fromhex('89504e470d0a1a0a') + b'synthetic fixture'
        encoded = smoke.base64.b64encode(picture)
        self.assertEqual(smoke.decode_rendering_png(encoded), picture)
        self.assertEqual(smoke.decode_rendering_png(encoded[:12] + bytes([13, 10]) + encoded[12:]), picture)
        for invalid in [b'', b'cat: file missing', smoke.base64.b64encode(b'not a PNG')]:
            with self.assertRaises(ValueError):
                smoke.decode_rendering_png(invalid)

    def test_only_explicit_ephemeral_owner_workflow_is_allowed(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': 'dukkanai/onlinu',
               'RUNNER_OS': 'Linux', 'GITHUB_RUN_ID': '1', 'GITHUB_SHA': 'a' * 40,
               'GITHUB_WORKSPACE': str(smoke.SOURCE), 'RUNNER_TEMP': '/tmp/owned-android'}
        smoke.validate_context(env)
        for key, value in [('GITHUB_ACTIONS', 'false'), ('GITHUB_EVENT_NAME', 'pull_request'),
                           ('GITHUB_REPOSITORY', 'other/repo'), ('RUNNER_OS', 'Windows'),
                           ('GITHUB_SHA', 'unknown'), ('RUNNER_TEMP', 'relative'), ('GITHUB_WORKSPACE', '/other')]:
            with self.assertRaises(ValueError):
                smoke.validate_context(dict(env, **{key: value}))

    def test_generated_manifest_disables_backup_cleartext_and_has_one_internet_permission(self):
        with tempfile.TemporaryDirectory(prefix='onlinu-android-test-') as directory:
            path = Path(directory) / 'AndroidManifest.xml'
            path.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name="${applicationName}"><activity android:name=".MainActivity"/></application></manifest>')
            smoke.secure_manifest(path)
            smoke.secure_manifest(path)
            root = ET.parse(path).getroot()
            app = root.find('application')
            self.assertEqual(app.get(smoke.ANDROID + 'name'), '${applicationName}')
            self.assertEqual(app.get(smoke.ANDROID + 'allowBackup'), 'false')
            self.assertEqual(app.get(smoke.ANDROID + 'usesCleartextTraffic'), 'false')
            self.assertEqual(len(root.findall('uses-permission')), 1)
            self.assertEqual(len(app.find('activity').findall('intent-filter')), 1)
            self.assertEqual(app.find('activity/meta-data').get(smoke.ANDROID + 'value'), 'false')

    def test_built_apk_must_be_expected_debug_package_with_restrictions(self):
        xml = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.synthetic.restaurant_admin_prototype"><application android:allowBackup="false" android:usesCleartextTraffic="false" android:debuggable="true"><activity android:name=".MainActivity"><meta-data android:name="flutter_deeplinking_enabled" android:value="false"/><intent-filter><action android:name="android.intent.action.VIEW"/><category android:name="android.intent.category.DEFAULT"/><category android:name="android.intent.category.BROWSABLE"/><data android:scheme="invalid.control.onlinu.android"/></intent-filter></activity></application><uses-permission android:name="android.permission.INTERNET"/></manifest>'
        smoke.verify_built_manifest(xml)
        for altered in [xml.replace('restaurant_admin_prototype', 'other_app'), xml.replace('allowBackup="false"', 'allowBackup="true"'),
                        xml.replace('usesCleartextTraffic="false"', 'usesCleartextTraffic="true"'), xml.replace('debuggable="true"', 'debuggable="false"'),
                        xml.replace('android.permission.INTERNET', 'other.permission'), xml.replace('invalid.control.onlinu.android', 'other.scheme'), xml.replace('flutter_deeplinking_enabled', 'other_flag')]:
            with self.assertRaises(ValueError):
                smoke.verify_built_manifest(altered)

    def test_apk_contains_exact_selected_flutter_engine(self):
        with tempfile.TemporaryDirectory(prefix='onlinu-apk-test-') as directory:
            path = Path(directory) / 'fixture.apk'
            for names in [['lib/arm64-v8a/libflutter.so'], [], ['lib/x86_64/libflutter.so'],
                          ['lib/arm64-v8a/libflutter.so', 'lib/x86_64/libflutter.so']]:
                with zipfile.ZipFile(path, 'w') as archive:
                    for name in names:
                        archive.writestr(name, b'synthetic fixture')
                if len(names) == 1 and 'arm64-v8a' in names[0]:
                    smoke.verify_apk_abi(path)
                else:
                    with self.assertRaises(ValueError):
                        smoke.verify_apk_abi(path)
