import importlib.util
from pathlib import Path
import tempfile
import unittest
import zipfile
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('android_smoke', Path(__file__).resolve().parents[1] / 'integration/android-native-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class AndroidSmokeTests(unittest.TestCase):
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
            path.write_text('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application android:name="${applicationName}"/></manifest>')
            smoke.secure_manifest(path)
            smoke.secure_manifest(path)
            root = ET.parse(path).getroot()
            app = root.find('application')
            self.assertEqual(app.get(smoke.ANDROID + 'name'), '${applicationName}')
            self.assertEqual(app.get(smoke.ANDROID + 'allowBackup'), 'false')
            self.assertEqual(app.get(smoke.ANDROID + 'usesCleartextTraffic'), 'false')
            self.assertEqual(len(root.findall('uses-permission')), 1)

    def test_built_apk_must_be_expected_debug_package_with_restrictions(self):
        xml = '<manifest xmlns:android="http://schemas.android.com/apk/res/android" package="dev.synthetic.restaurant_admin_prototype"><application android:allowBackup="false" android:usesCleartextTraffic="false" android:debuggable="true"/><uses-permission android:name="android.permission.INTERNET"/></manifest>'
        smoke.verify_built_manifest(xml)
        for altered in [xml.replace('restaurant_admin_prototype', 'other_app'), xml.replace('allowBackup="false"', 'allowBackup="true"'),
                        xml.replace('usesCleartextTraffic="false"', 'usesCleartextTraffic="true"'), xml.replace('debuggable="true"', 'debuggable="false"'),
                        xml.replace('android.permission.INTERNET', 'other.permission')]:
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
