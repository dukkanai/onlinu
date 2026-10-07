import importlib.util
from pathlib import Path
import plistlib
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('ios_smoke', Path(__file__).resolve().parents[1] / 'integration/ios-native-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)


class IosSmokeTests(unittest.TestCase):
    def test_only_explicit_ephemeral_macos_owner_workflow_is_allowed(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_EVENT_NAME': 'workflow_dispatch', 'GITHUB_REPOSITORY': 'dukkanai/onlinu',
               'RUNNER_OS': 'macOS', 'GITHUB_RUN_ID': '1', 'GITHUB_SHA': 'a' * 40,
               'GITHUB_WORKSPACE': str(smoke.SOURCE), 'RUNNER_TEMP': '/tmp/owned-ios'}
        smoke.validate_context(env)
        for key, value in [('GITHUB_EVENT_NAME', 'pull_request'), ('RUNNER_OS', 'Linux'), ('GITHUB_REPOSITORY', 'other/repo'),
                           ('GITHUB_SHA', 'unknown'), ('GITHUB_WORKSPACE', '/other'), ('RUNNER_TEMP', 'relative')]:
            with self.assertRaises(ValueError):
                smoke.validate_context(dict(env, **{key: value}))

    def test_generated_plist_retains_identity_and_disables_arbitrary_loads_and_file_sharing(self):
        with tempfile.TemporaryDirectory(prefix='onlinu-ios-test-') as directory:
            path = Path(directory) / 'Info.plist'
            path.write_bytes(plistlib.dumps({'CFBundleIdentifier': '$(PRODUCT_BUNDLE_IDENTIFIER)', 'OtherKey': True}))
            smoke.secure_plist(path)
            result = plistlib.loads(path.read_bytes())
            self.assertEqual(result['CFBundleIdentifier'], '$(PRODUCT_BUNDLE_IDENTIFIER)')
            self.assertTrue(result['OtherKey'])
            self.assertFalse(result['UIFileSharingEnabled'])
            self.assertFalse(result['NSAppTransportSecurity']['NSAllowsArbitraryLoads'])
            path.write_bytes(plistlib.dumps({'CFBundleIdentifier': 'real.other.app'}))
            with self.assertRaises(ValueError):
                smoke.secure_plist(path)

    def test_built_bundle_must_be_expected_simulator_only_identity(self):
        info = {'CFBundleIdentifier': smoke.PACKAGE, 'CFBundleSupportedPlatforms': ['iPhoneSimulator'],
                'DTPlatformName': 'iphonesimulator', 'CFBundleExecutable': 'Runner', 'UIFileSharingEnabled': False,
                'NSAppTransportSecurity': {'NSAllowsArbitraryLoads': False}}
        smoke.verify_built_plist(info)
        for key, value in [('CFBundleIdentifier', 'other'), ('CFBundleSupportedPlatforms', ['iPhoneOS']),
                           ('DTPlatformName', 'iphoneos'), ('CFBundleExecutable', '../other'), ('UIFileSharingEnabled', True),
                           ('NSAppTransportSecurity', {'NSAllowsArbitraryLoads': True})]:
            with self.assertRaises(ValueError):
                smoke.verify_built_plist(dict(info, **{key: value}))
