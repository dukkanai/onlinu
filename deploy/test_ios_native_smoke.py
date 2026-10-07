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

    def simulator_inventory(self):
        runtime = 'com.apple.CoreSimulator.SimRuntime.iOS-26-6'
        kind = 'com.apple.CoreSimulator.SimDeviceType.iPhone-16'
        identifier = '12345678-1234-4234-8234-123456789ABC'
        return {'runtimes': [{'identifier': runtime, 'version': '26.6', 'isAvailable': True}],
                'devicetypes': [{'identifier': kind, 'productFamily': 'iPhone'}],
                'devices': {runtime: [{'udid': identifier, 'name': 'owned-fixture', 'isAvailable': True,
                                      'deviceTypeIdentifier': kind, 'state': 'Shutdown'}]}}, runtime, kind, identifier

    def test_simulator_selection_uses_available_observed_iphone_type_not_existing_device(self):
        inventory, runtime, kind, identifier = self.simulator_inventory()
        self.assertEqual(smoke.simulator_template(inventory), (runtime, kind))
        inventory['runtimes'][0]['isAvailable'] = False
        with self.assertRaises(ValueError):
            smoke.simulator_template(inventory)
        inventory['runtimes'][0]['isAvailable'] = True
        inventory['devicetypes'][0]['productFamily'] = 'iPad'
        with self.assertRaises(ValueError):
            smoke.simulator_template(inventory)

    def test_simulator_cleanup_requires_exact_created_name_uuid_and_runtime(self):
        inventory, runtime, kind, identifier = self.simulator_inventory()
        self.assertEqual(smoke.owned_simulator(inventory, runtime, identifier, 'owned-fixture')['state'], 'Shutdown')
        for values in [(runtime, identifier, 'someone-else'), ('other-runtime', identifier, 'owned-fixture'),
                       (runtime, '87654321-1234-4234-8234-123456789ABC', 'owned-fixture')]:
            with self.assertRaises(ValueError):
                smoke.owned_simulator(inventory, *values)
        inventory['devices'][runtime].append(dict(inventory['devices'][runtime][0]))
        with self.assertRaises(ValueError):
            smoke.owned_simulator(inventory, runtime, identifier, 'owned-fixture')

    def test_unknown_creation_reply_never_boots_or_cleans_arbitrary_device(self):
        import json
        from unittest.mock import patch
        inventory, _, _, _ = self.simulator_inventory()
        with patch.dict(smoke.os.environ, {'GITHUB_RUN_ID': '123'}), \
             patch.object(smoke.subprocess, 'check_output', side_effect=[json.dumps(inventory), 'unknown-result']), \
             patch.object(smoke, 'run') as run:
            with self.assertRaisesRegex(ValueError, 'uncertain'):
                smoke.simulator_checks(['flutter'], Path('/unused-fixture'), Path('/unused-output'))
            run.assert_not_called()
