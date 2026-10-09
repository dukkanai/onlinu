"""Two synthetic rendered tenants on an ephemeral runner, never production.
Only image references and fixture host-file paths override the renderer output.
No registry is published, no credentials are reused, and no real calls occur.
"""
import base64
import hashlib
import importlib.util
import ipaddress
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('onlinu_smoke_planner', ROOT / 'deploy/tenant_plan.py')
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


class SmokeError(RuntimeError):
    pass


def validate_context(env, image):
    if (env.get('GITHUB_ACTIONS') != 'true' or not re.fullmatch(r'[0-9]+', env.get('GITHUB_RUN_ID', ''))
            or not re.fullmatch(r'[0-9]+', env.get('GITHUB_RUN_ATTEMPT', ''))
            or not re.fullmatch(r'[a-f0-9]{40}', env.get('GITHUB_SHA', ''))
            or not env.get('RUNNER_TEMP', '').startswith('/')
            or image != 'onlinu-runtime-smoke:' + env.get('GITHUB_SHA', '')):
        raise SmokeError('Requires the exact built image on an ephemeral GitHub Actions runner.')


def free_port():
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        return listener.getsockname()[1]


def prepare_fixture(root, tenant, port, image, number):
    config = {'tenantId': tenant, 'runtimeImage': 'registry.example/onlinu@sha256:' + 'a' * 64,
              'postgresImage': 'postgres@sha256:' + 'b' * 64, 'httpPort': port,
              'publicOrigin': 'https://' + tenant + '.example.invalid',
              'platformIssuer': 'https://platform.example.invalid',
              'platformPublicKey': base64.b64encode(bytes(range(32))).decode()}
    plan = planner.plan_tenant(config)
    bootstrap = ROOT / 'deploy/tenant-bootstrap.sql'
    if hashlib.sha256(bootstrap.read_bytes()).hexdigest() != plan['postgres']['bootstrapAssetSha256']:
        raise SmokeError('Bootstrap asset differs from reviewed plan.')
    rendered = planner.compose_tenant(config, plan['planDigest'], '/srv/onlinu/ci-secret-fixtures')
    if not re.fullmatch(r'onlinu-runtime-smoke:[a-f0-9]{40}', image):
        raise SmokeError('Unexpected fixture image reference.')
    root.mkdir()
    root.chmod(0o755)
    files = root / 'secrets'
    files.mkdir(mode=0o755)
    values = {'administrator': f'synthetic-compose-{number}-administrator',
              'pg_bootstrap': f'synthetic-compose-{number}-bootstrap',
              'runtime_password': f'synthetic-compose-{number}-database',
              'runtime_pg_url': f'postgres://onlinu_runtime:synthetic-compose-{number}-database@postgres:5432/postgres?sslmode=disable'}
    if set(rendered['secrets']) != set(values):
        raise SmokeError('Unexpected fixture secret contract.')
    for name, ref in rendered['secrets'].items():
        path = files / Path(ref['file']).name
        with path.open('x') as stream:
            stream.write(values[name] + '\n')
        path.chmod(0o444)
        ref['file'] = str(path)
    # Test-only reference overrides. Production registry digest/host-secret
    # provisioning is not claimed by this acceptance run.
    rendered['services']['restaurant']['image'] = image
    rendered['services']['postgres']['image'] = 'postgres:16'
    rendered['configs']['runtime_bootstrap']['file'] = str(bootstrap)
    manifest = root / 'compose.json'
    manifest.write_text(json.dumps(rendered))
    return {'root': root, 'manifest': manifest, 'config': config, 'plan': plan,
            'spec': rendered, 'values': values, 'owned': False, 'ids': {}}


class Docker:
    def __init__(self):
        self.env = dict(os.environ)
        self.env.pop('DOCKER_HOST', None)
        self.env.pop('DOCKER_CONTEXT', None)

    def call(self, args, *, check=True, input=None, timeout=240, binary=False):
        result = subprocess.run(['docker', '--context', 'default', *args], env=self.env,
                                input=input, capture_output=True, text=not binary, timeout=timeout)
        if check and result.returncode:
            raise SmokeError('Fixture Docker operation failed: ' + args[0])
        return result

    def text(self, args, **kwargs):
        return self.call(args, **kwargs).stdout.strip()

    def compose(self, fixture, args, **kwargs):
        return self.call(['compose', '--env-file', '/dev/null', '-f', str(fixture['manifest']), *args], **kwargs)

    def inspect(self, identifier, kind=None):
        args = ([kind] if kind else []) + ['inspect', identifier]
        return json.loads(self.text(args))[0]


def assert_owned(labels, fixture):
    if (labels.get('org.onlinu.tenant') != fixture['config']['tenantId']
            or labels.get('org.onlinu.plan-digest') != fixture['plan']['planDigest']
            or labels.get('com.docker.compose.project') != fixture['plan']['projectName']):
        raise SmokeError('Refusing to operate on a resource without exact fixture ownership.')


def preflight(docker, fixture):
    project = fixture['plan']['projectName']
    if docker.text(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + project]):
        raise SmokeError('Fixture project already has containers.')
    for kind, plural in [('volume', 'volumes'), ('network', 'networks')]:
        existing = set(docker.text([kind, 'ls', '--format', '{{.Name}}']).splitlines())
        if any(row['name'] in existing for row in fixture['spec'][plural].values()):
            raise SmokeError('Fixture resource name already exists.')


def verify_owned_resources(docker, fixture):
    identifiers = docker.text(['ps', '-aq', '--filter', 'label=com.docker.compose.project=' + fixture['plan']['projectName']]).splitlines()
    for identifier in identifiers:
        info = docker.inspect(identifier)
        labels = info['Config'].get('Labels') or {}
        assert_owned(labels, fixture)
        if labels.get('com.docker.compose.service') not in ('restaurant', 'postgres'):
            raise SmokeError('Unexpected container in fixture project.')
    for kind, plural in [('volume', 'volumes'), ('network', 'networks')]:
        existing = set(docker.text([kind, 'ls', '--format', '{{.Name}}']).splitlines())
        for row in fixture['spec'][plural].values():
            if row['name'] in existing:
                assert_owned(docker.inspect(row['name'], kind).get('Labels') or {}, fixture)


def assert_container_constraints(info, fixture, service):
    host = info['HostConfig']
    bindings = host.get('PortBindings') or {}
    if service == 'postgres':
        if bindings:
            raise SmokeError('Fixture database unexpectedly publishes a host port.')
        return
    expected_binding = {'8080/tcp': [{'HostIp': '127.0.0.1', 'HostPort': str(fixture['config']['httpPort'])}]}
    if bindings != expected_binding:
        raise SmokeError('Runtime host binding differs from the reviewed loopback port.')
    if (info['Config']['User'] != '10001:10001' or not host['ReadonlyRootfs'] or host['Privileged']
            or 'ALL' not in (host.get('CapDrop') or []) or host.get('CapAdd')
            or not set(host.get('SecurityOpt') or []).intersection({'no-new-privileges', 'no-new-privileges:true'})):
        raise SmokeError('Runtime container hardening differs from the reviewed model.')
    if any(entry.startswith(('WACALLS_API_KEY=', 'WACALLS_PG_URL=', 'WACALLS_META_ENCRYPTION_KEY=', 'POSTGRES_PASSWORD='))
           for entry in info['Config'].get('Env', [])):
        raise SmokeError('Runtime has a raw secret environment setting.')
    if any(mount.get('Destination') == '/var/run/docker.sock' for mount in info.get('Mounts', [])):
        raise SmokeError('Runtime received a Docker socket.')


def load_containers(docker, fixture):
    for service in ('restaurant', 'postgres'):
        identifier = docker.compose(fixture, ['ps', '-q', service]).stdout.strip()
        if not re.fullmatch(r'(?:[a-f0-9]{12}|[a-f0-9]{64})', identifier):
            raise SmokeError('Missing unique fixture container.')
        info = docker.inspect(identifier)
        identifier = info['Id']
        if not re.fullmatch(r'[a-f0-9]{64}', identifier):
            raise SmokeError('Invalid canonical fixture container identity.')
        assert_owned(info['Config'].get('Labels') or {}, fixture)
        assert_container_constraints(info, fixture, service)
        if info['Image'] != fixture['expectedImages'][service]:
            raise SmokeError('Fixture image changed after review.')
        if not info['State']['Running'] or info['State'].get('Health', {}).get('Status') != 'healthy':
            raise SmokeError('Fixture is not running and healthy.')
        fixture['ids'][service] = identifier


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def http_status(port, path, key=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    request = urllib.request.Request(f'http://127.0.0.1:{port}' + path)
    if key:
        request.add_header('X-API-Key', key)
    try:
        with opener.open(request, timeout=5) as response:
            return response.status
    except urllib.error.HTTPError as error:
        error.close()
        return error.code


def private_ip(docker, fixture, service, network):
    value = docker.inspect(fixture['ids'][service])['NetworkSettings']['Networks'][network]['IPAddress']
    address = ipaddress.ip_address(value)
    if address.version != 4 or not address.is_private or address.is_loopback or address.is_unspecified:
        raise SmokeError('Unexpected fixture network address.')
    return str(address)


def tcp_blocked(returncode, remote_ip):
    # A connected but idle TCP socket may time out too: remote_ip must be empty.
    return returncode in (7, 28) and not remote_ip.strip()


def check_cross_network(docker, source, target):
    for service, network, port in [('restaurant', target['plan']['networks']['runtimeEgress'], 8080),
                                    ('postgres', target['plan']['networks']['database'], 5432)]:
        address = private_ip(docker, target, service, network)
        result = docker.call(['exec', source['ids']['restaurant'], 'curl', '--noproxy', '*',
                              '--connect-timeout', '2', '--max-time', '3', '--silent', '--output', '/dev/null',
                              '--write-out', '%{remote_ip}', f'telnet://{address}:{port}'], check=False, timeout=10)
        if not tcp_blocked(result.returncode, result.stdout):
            raise SmokeError('Cross-tenant TCP connection was not demonstrably blocked.')
    load_containers(docker, target)


def restore_database_name(fixture):
    tenant = fixture.get('config', {}).get('tenantId', '')
    if (not fixture.get('owned') or not re.fullmatch(r'ci-[0-9]+-[a-f0-9]{10}-[01]', tenant)
            or not re.fullmatch(r'[a-f0-9]{64}', fixture.get('ids', {}).get('postgres', ''))):
        raise SmokeError('Backup requires an exact owned disposable fixture.')
    return 'onlinu_restore_' + hashlib.sha256(tenant.encode()).hexdigest()[:16]


def database_sql(docker, fixture, database, statement):
    if database != 'wacalls_main' and not re.fullmatch(r'onlinu_restore_[a-f0-9]{16}', database):
        raise SmokeError('Unexpected fixture database target.')
    return docker.text(['exec', '-i', '-e', 'PGOPTIONS=-c timezone=UTC', fixture['ids']['postgres'], 'psql', '-U', 'onlinu_runtime',
                        '-d', database, '-At', '-v', 'ON_ERROR_STOP=1'], input=statement)


def sql(docker, fixture, statement):
    return database_sql(docker, fixture, 'wacalls_main', statement)


def database_fingerprint(docker, fixture, database):
    tables = database_sql(docker, fixture, database,
                          "SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename;").splitlines()
    sequences = database_sql(docker, fixture, database,
                             "SELECT sequencename FROM pg_sequences WHERE schemaname='public' ORDER BY sequencename;").splitlines()
    if (not tables or len(tables) > 300 or len(sequences) > 300
            or any(not re.fullmatch(r'[a-z][a-z0-9_]{0,62}', name) for name in tables + sequences)):
        raise SmokeError('Unexpected fixture relation inventory.')
    result = {'tables': {}, 'sequences': {}}
    for name in tables:
        query = ("SELECT md5(COALESCE(jsonb_agg(row_data ORDER BY row_data::text)::text,'[]')),count(*) "
                 'FROM (SELECT to_jsonb(row_value) AS row_data FROM public."' + name + '" row_value) snapshot_rows;')
        value = database_sql(docker, fixture, database, query)
        if not re.fullmatch(r'[a-f0-9]{32}\|[0-9]+', value):
            raise SmokeError('Unexpected fixture table fingerprint.')
        result['tables'][name] = value
    for name in sequences:
        value = database_sql(docker, fixture, database, 'SELECT last_value,is_called FROM public."' + name + '";')
        if not re.fullmatch(r'-?[0-9]+\|[tf]', value):
            raise SmokeError('Unexpected fixture sequence fingerprint.')
        result['sequences'][name] = value
    return result


def check_database_backup_restore(docker, fixture):
    restored = restore_database_name(fixture)
    verify_owned_resources(docker, fixture)
    database_info = docker.inspect(fixture['ids']['postgres'])
    assert_owned(database_info['Config'].get('Labels') or {}, fixture)
    if database_info['Image'] != fixture['expectedImages']['postgres'] or not database_info['State']['Running']:
        raise SmokeError('Fixture database identity changed before backup.')
    # Stop only this fixture's application while keeping its database and the
    # neighbor running. The ordinary recreation step below restarts it afterward.
    docker.compose(fixture, ['stop', '--timeout', '15', 'restaurant'])
    before = database_fingerprint(docker, fixture, 'wacalls_main')
    archive = docker.call(['exec', fixture['ids']['postgres'], 'pg_dump', '-U', 'onlinu_runtime',
                           '-d', 'wacalls_main', '--format=custom', '--no-owner', '--no-acl'], binary=True).stdout
    if not isinstance(archive, bytes) or not archive.startswith(b'PGDMP') or not 5 < len(archive) <= 32 * 1024 * 1024:
        raise SmokeError('Unexpected fixture backup archive.')
    backup_root = fixture['root'] / 'private-backup'
    backup_root.mkdir(mode=0o700)
    path = backup_root / 'main.dump'
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, 'wb') as stream:
        stream.write(archive)
        stream.flush()
        os.fsync(stream.fileno())
    restored_bytes = path.read_bytes()
    archive_hash = hashlib.sha256(archive).hexdigest()
    if hashlib.sha256(restored_bytes).hexdigest() != archive_hash:
        raise SmokeError('Fixture backup read-back differs.')
    # A name collision fails closed. Never drop, overwrite or restore onto an
    # existing database. This copy lives only inside the owned disposable volume.
    exists = docker.text(['exec', '-i', fixture['ids']['postgres'], 'psql', '-U', 'onlinu_runtime',
                          '-d', 'postgres', '-At', '-v', 'ON_ERROR_STOP=1'],
                         input="SELECT count(*) FROM pg_database WHERE datname='" + restored + "';")
    if exists != '0':
        raise SmokeError('Fixture restore target already exists.')
    docker.call(['exec', fixture['ids']['postgres'], 'createdb', '-U', 'onlinu_runtime', restored])
    docker.call(['exec', '-i', fixture['ids']['postgres'], 'pg_restore', '-U', 'onlinu_runtime',
                 '-d', restored, '--exit-on-error', '--no-owner', '--no-acl'], input=restored_bytes, binary=True)
    after = database_fingerprint(docker, fixture, restored)
    if before != after or before != database_fingerprint(docker, fixture, 'wacalls_main'):
        raise SmokeError('Fixture restore or original database fingerprint differs.')
    # Report hashes/counts only. Archive bytes are never uploaded as an artifact.
    return {'sourceDatabase': 'wacalls_main', 'freshRestoreDatabase': restored,
            'archiveBytes': len(archive), 'archiveSha256': archive_hash,
            'tableCount': len(before['tables']), 'sequenceCount': len(before['sequences']),
            'logicalFingerprint': hashlib.sha256(json.dumps(before, sort_keys=True).encode()).hexdigest()}


def redact(value, fixtures):
    for fixture in fixtures:
        for secret in fixture['values'].values():
            value = value.replace(secret, '[fixture-redacted]')
    return re.sub(r'postgres(?:ql)?://\S+', '[database-url-redacted]', value)


def run_smoke(image):
    validate_context(os.environ, image)
    docker = Docker()
    context = json.loads(docker.text(['context', 'inspect', 'default']))[0]
    if context['Endpoints']['docker']['Host'] != 'unix:///var/run/docker.sock':
        raise SmokeError('Only the ephemeral runner local Docker socket is supported.')
    docker.text(['info', '--format', '{{.ServerVersion}}'])
    image_ids = {'restaurant': docker.inspect(image, 'image')['Id'],
                 'postgres': docker.inspect('postgres:16', 'image')['Id']}
    fixtures = []
    report = None
    with tempfile.TemporaryDirectory(prefix='onlinu-two-tenants-', dir=os.environ['RUNNER_TEMP']) as temporary:
        root = Path(temporary)
        root.chmod(0o755)
        nonce = uuid.uuid4().hex[:10]
        ports = [free_port(), free_port()]
        while ports[0] == ports[1]:
            ports[1] = free_port()
        try:
            for number in range(2):
                tenant = f'ci-{os.environ["GITHUB_RUN_ID"]}-{nonce}-{number}'
                fixture = prepare_fixture(root / str(number), tenant, ports[number], image, number)
                fixtures.append(fixture)
                fixture['expectedImages'] = image_ids
                preflight(docker, fixture)
                docker.compose(fixture, ['config', '--quiet'])
                fixture['owned'] = True
                docker.compose(fixture, ['up', '--wait', '--wait-timeout', '180', '--pull', 'never', '--no-build'])
                load_containers(docker, fixture)
            for number, fixture in enumerate(fixtures):
                other = fixtures[1 - number]
                port = fixture['config']['httpPort']
                if (http_status(port, '/healthz') != 200
                        or http_status(port, '/api/restaurant/catalog', fixture['values']['administrator']) != 200
                        or http_status(port, '/api/restaurant/catalog', other['values']['administrator']) != 401):
                    raise SmokeError('Tenant administrator authentication isolation failed.')
                for secret in ('pg_bootstrap', 'runtime_password'):
                    docker.call(['exec', fixture['ids']['restaurant'], 'test', '!', '-e', '/run/secrets/' + secret])
                marker = f'fixture-marker-{number}'
                sql(docker, fixture, "CREATE TABLE onlinu_ci_marker(value TEXT NOT NULL); INSERT INTO onlinu_ci_marker VALUES ('" + marker + "');")
                docker.call(['exec', fixture['ids']['restaurant'], 'sh', '-c',
                             'printf %s "$1" > /data/recordings/ci-storage-marker', 'sh', marker])
                check_cross_network(docker, fixture, other)
            neighbor_start = {service: docker.inspect(identifier)['State']['StartedAt']
                              for service, identifier in fixtures[1]['ids'].items()}
            backup_restore = check_database_backup_restore(docker, fixtures[0])
            verify_owned_resources(docker, fixtures[0])
            docker.compose(fixtures[0], ['stop', '--timeout', '15'])
            docker.compose(fixtures[0], ['up', '--force-recreate', '--wait', '--wait-timeout', '180', '--pull', 'never', '--no-build'])
            for number, fixture in enumerate(fixtures):
                load_containers(docker, fixture)
                marker = f'fixture-marker-{number}'
                if (sql(docker, fixture, 'SELECT value FROM onlinu_ci_marker;') != marker
                        or docker.text(['exec', fixture['ids']['restaurant'], 'cat', '/data/recordings/ci-storage-marker']) != marker):
                    raise SmokeError('Tenant database/media persistence or isolation failed.')
            for service, started_at in neighbor_start.items():
                if docker.inspect(fixtures[1]['ids'][service])['State']['StartedAt'] != started_at:
                    raise SmokeError('Neighbor tenant was restarted by fixture recreation.')
            check_cross_network(docker, fixtures[0], fixtures[1])
            check_cross_network(docker, fixtures[1], fixtures[0])
            report = {'sourceCommit': os.environ['GITHUB_SHA'], 'productionDeployed': False,
                      'registryPublished': False, 'fixtureCount': 2, 'localImageIds': image_ids,
                      'planDigests': [f['plan']['planDigest'] for f in fixtures],
                      'databaseBackupRestore': backup_restore,
                      'testOnlyOverrides': ['image references', 'host secret/config file paths'],
                      'checks': ['two-rendered-fixtures-started', 'actual-container-hardening', 'loopback-only-runtime-ingress',
                                 'cross-administrator-key-rejected',
                                 'bootstrap-secrets-absent-from-runtime', 'cross-network-tcp-blocked',
                                 'separate-database-and-media-markers', 'database-and-media-survive-recreation',
                                 'neighbor-uptime-preserved', 'private-main-database-dump-readback',
                                 'fresh-database-restore-without-overwrite', 'restored-table-and-sequence-fingerprints',
                                 'original-database-unchanged-after-restore'],
                      'notVerified': ['production-registry-digests', 'production-secret-provisioning',
                                      'public-https-routing', 'real-calls', 'capacity', 'production-backup-restore',
                                      'media-backup-restore', 'cross-resource-snapshot-consistency', 'host-compromise-isolation']}
        except Exception:
            for fixture in fixtures:
                if fixture['owned']:
                    logs = docker.compose(fixture, ['logs', '--no-color', '--tail', '30'], check=False, timeout=20)
                    print(redact(logs.stdout + logs.stderr, fixtures)[-6000:], file=sys.stderr)
            raise
        finally:
            cleanup_failed = False
            for fixture in reversed(fixtures):
                if fixture['owned']:
                    try:
                        verify_owned_resources(docker, fixture)
                        docker.compose(fixture, ['down', '--volumes', '--timeout', '15'], timeout=90)
                    except Exception:
                        cleanup_failed = True
                        print('Owned fixture cleanup could not be verified; no broader removal attempted.', file=sys.stderr)
            if cleanup_failed:
                raise SmokeError('Fixture cleanup did not complete safely.')
    if report is None:
        raise SmokeError('Fixture acceptance report is missing.')
    target = Path(os.environ['RUNNER_TEMP']) / 'onlinu-tenant-compose-report.json'
    target.write_text(json.dumps(report, indent=2))
    print('Two synthetic rendered tenant fixtures passed isolation and recreation checks.')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise SmokeError('Exact built runtime image argument required.')
        run_smoke(sys.argv[1])
    except (SmokeError, subprocess.TimeoutExpired) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1)
