"""Validate synthetic rendered Compose syntax without creating any resource."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('onlinu_tenant_plan', ROOT / 'deploy/tenant_plan.py')
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)
config = {
    'tenantId': 'compose-schema-fixture',
    'runtimeImage': 'registry.example/onlinu@sha256:' + 'a' * 64,
    'postgresImage': 'postgres@sha256:' + 'b' * 64,
    'httpPort': 18080,
    'publicOrigin': 'https://restaurant.example.invalid',
    'platformIssuer': 'https://platform.example.invalid',
    'platformPublicKey': base64.b64encode(bytes(range(32))).decode(),
}
plan = planner.plan_tenant(config)
rendered = planner.compose_tenant(config, plan['planDigest'], '/srv/onlinu/ci-fixture-secrets')
with tempfile.TemporaryDirectory(prefix='onlinu-compose-schema-') as temporary:
    root = Path(temporary)
    manifest = root / 'compose.json'
    manifest.write_text(json.dumps(rendered))
    (root / 'tenant-bootstrap.sql').write_bytes((ROOT / 'deploy/tenant-bootstrap.sql').read_bytes())
    # No image digest resolution, daemon operation, environment interpolation,
    # secret-file content access, or weakened model-consistency checking.
    subprocess.run(['docker', 'compose', '--env-file', '/dev/null', '-f', str(manifest),
                    'config', '--no-interpolate', '--no-env-resolution',
                    '--no-path-resolution', '--quiet'], check=True, timeout=30)
print('Synthetic Compose model validated; no image pull or Docker resource changes.')
