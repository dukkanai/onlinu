"""Fixture preparation/ownership guards only; no Docker calls are made here."""
import copy
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('tenant_compose_smoke', Path(__file__).resolve().parents[1] / 'integration/tenant-compose-smoke.py')
smoke = importlib.util.module_from_spec(spec)
spec.loader.exec_module(smoke)
IMAGE = 'onlinu-runtime-smoke:' + 'a' * 40


class TenantComposeSmokeTests(unittest.TestCase):
    def test_requires_ephemeral_context_and_exact_image(self):
        env = {'GITHUB_ACTIONS': 'true', 'GITHUB_RUN_ID': '123', 'GITHUB_RUN_ATTEMPT': '1',
               'GITHUB_SHA': 'a' * 40, 'RUNNER_TEMP': '/tmp/owned-fixture'}
        smoke.validate_context(env, IMAGE)
        for field, value in [('GITHUB_ACTIONS', 'false'), ('GITHUB_RUN_ID', 'not-a-run'),
                             ('GITHUB_RUN_ATTEMPT', ''), ('RUNNER_TEMP', 'relative')]:
            with self.subTest(field=field), self.assertRaises(smoke.SmokeError):
                smoke.validate_context(dict(env, **{field: value}), IMAGE)
        with self.assertRaises(smoke.SmokeError):
            smoke.validate_context(env, 'arbitrary:latest')

    def test_only_declared_fixture_reference_overrides_change_the_renderer(self):
        with tempfile.TemporaryDirectory() as temporary:
            fixture = smoke.prepare_fixture(Path(temporary) / 'a', 'fixture-a', 18080, IMAGE, 0)
            original = smoke.planner.compose_tenant(fixture['config'], fixture['plan']['planDigest'], '/srv/onlinu/ci-secret-fixtures')
            reconstructed = copy.deepcopy(fixture['spec'])
            for service in ('restaurant', 'postgres'):
                reconstructed['services'][service]['image'] = original['services'][service]['image']
            reconstructed['secrets'] = original['secrets']
            reconstructed['configs'] = original['configs']
            self.assertEqual(reconstructed, original)
            self.assertFalse(fixture['owned'])
            self.assertEqual(set(fixture['values']), set(original['secrets']))

    def test_fixture_files_are_distinct_and_existing_directories_are_not_overwritten(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            a = smoke.prepare_fixture(root / 'a', 'fixture-a', 18080, IMAGE, 0)
            b = smoke.prepare_fixture(root / 'b', 'fixture-b', 18081, IMAGE, 1)
            self.assertNotEqual(a['values']['administrator'], b['values']['administrator'])
            self.assertNotEqual(a['values']['runtime_password'], b['values']['runtime_password'])
            for fixture in (a, b):
                for name, row in fixture['spec']['secrets'].items():
                    path = Path(row['file'])
                    self.assertEqual(path.read_text().rstrip('\n'), fixture['values'][name])
                    self.assertEqual(path.stat().st_mode & 0o777, 0o444)
            before = a['manifest'].read_bytes()
            with self.assertRaises(FileExistsError):
                smoke.prepare_fixture(root / 'a', 'fixture-a', 18080, IMAGE, 0)
            self.assertEqual(a['manifest'].read_bytes(), before)

    def test_resource_owner_mismatch_is_refused_before_cleanup(self):
        fixture = {'config': {'tenantId': 'a'}, 'plan': {'planDigest': 'a' * 64, 'projectName': 'owned'}}
        labels = {'org.onlinu.tenant': 'a', 'org.onlinu.plan-digest': 'a' * 64, 'com.docker.compose.project': 'owned'}
        smoke.assert_owned(labels, fixture)
        for field in labels:
            with self.subTest(field=field), self.assertRaises(smoke.SmokeError):
                smoke.assert_owned(dict(labels, **{field: 'other'}), fixture)
        docker = mock.Mock()
        docker.text.return_value = 'container-id'
        docker.inspect.return_value = {'Config': {'Labels': {}}}
        with self.assertRaises(smoke.SmokeError):
            smoke.verify_owned_resources(docker, fixture)
        docker.compose.assert_not_called()

    def test_actual_runtime_settings_must_match_security_and_port_contract(self):
        fixture = {'config': {'httpPort': 18080}}
        info = {'Config': {'User': '10001:10001', 'Env': ['WACALLS_API_KEY_FILE=/run/secrets/administrator']},
                'HostConfig': {'PortBindings': {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': '18080'}]},
                               'ReadonlyRootfs': True, 'Privileged': False, 'CapDrop': ['ALL'], 'CapAdd': [],
                               'SecurityOpt': ['no-new-privileges:true']}, 'Mounts': []}
        smoke.assert_container_constraints(info, fixture, 'restaurant')
        for field, value in [('ReadonlyRootfs', False), ('Privileged', True), ('CapDrop', []),
                             ('CapAdd', ['SYS_ADMIN']), ('SecurityOpt', ['no-new-privileges:false']),
                             ('PortBindings', {'8080/tcp': [{'HostIp': '0.0.0.0', 'HostPort': '18080'}]})]:
            changed = copy.deepcopy(info); changed['HostConfig'][field] = value
            with self.subTest(field=field), self.assertRaises(smoke.SmokeError):
                smoke.assert_container_constraints(changed, fixture, 'restaurant')
        with self.assertRaises(smoke.SmokeError):
            smoke.assert_container_constraints(info, fixture, 'postgres')
        changed = copy.deepcopy(info); changed['Config']['Env'].append('WACALLS_API_KEY=fixture')
        with self.assertRaises(smoke.SmokeError):
            smoke.assert_container_constraints(changed, fixture, 'restaurant')

    def test_connected_timeout_or_command_error_is_not_network_isolation(self):
        self.assertTrue(smoke.tcp_blocked(7, ''))
        self.assertTrue(smoke.tcp_blocked(28, ''))
        for code, address in ((28, '172.18.0.2'), (0, ''), (0, '172.18.0.2'), (2, ''), (125, '')):
            self.assertFalse(smoke.tcp_blocked(code, address))

    def test_fixture_diagnostics_redact_values_and_unrecognized_database_urls(self):
        fixtures = [{'values': {'administrator': 'fixture-key', 'database': 'fixture-password'}}]
        result = smoke.redact('fixture-key fixture-password postgres://unexpected:secret@db/postgres', fixtures)
        self.assertNotIn('fixture-key', result)
        self.assertNotIn('fixture-password', result)
        self.assertNotIn('unexpected:secret', result)
        self.assertIn('[database-url-redacted]', result)


if __name__ == '__main__':
    unittest.main()
