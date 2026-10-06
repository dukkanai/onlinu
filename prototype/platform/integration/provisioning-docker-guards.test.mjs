import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTestDatabase, owned, constraints } from './provisioning-docker-check.mjs';

const url = 'postgres://postgres:ci-only-test-password@127.0.0.1:5432/astracalls_identity_test?sslmode=disable';
const f = { config: { tenantId: 'fixture', httpPort: 18080 }, plan: { planDigest: 'a'.repeat(64), projectName: 'project' },
  images: { restaurant: 'sha256:' + 'b'.repeat(64), postgres: 'sha256:' + 'c'.repeat(64) } };
const labels = { 'org.onlinu.tenant': 'fixture', 'org.onlinu.plan-digest': f.plan.planDigest, 'com.docker.compose.project': 'project' };
const runtime = () => ({ Image: f.images.restaurant, Config: { User: '10001:10001', Env: ['WACALLS_API_KEY_FILE=/run/secrets/administrator'] },
  HostConfig: { Privileged: false, ReadonlyRootfs: true, CapDrop: ['ALL'], CapAdd: null, SecurityOpt: ['no-new-privileges'],
    PortBindings: { '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '18080' }] } }, Mounts: [] });

test('journal Docker fixture accepts only its known loopback CI database', () => {
  assert.equal(verifyTestDatabase(url), url);
  for (const value of [url.replace('127.0.0.1', 'remote.example'), url.replace('5432', '5433'),
    url.replace('astracalls_identity_test', 'production'), url.replace('postgres:', 'postgresql:'),
    url.replace('ci-only-test-password', 'real-secret'), url + '#fragment', url + '&extra=1'])
    assert.throws(() => verifyTestDatabase(value), error => error.message === 'fixture_database_not_allowed'
      && !JSON.stringify(error).includes('real-secret'));
});

test('journal Docker cleanup ownership is tenant, digest and project specific', () => {
  owned(labels, f);
  for (const key of Object.keys(labels)) assert.throws(() => owned({ ...labels, [key]: 'neighbor' }, f), /ownership/);
  assert.throws(() => owned({}, f), /ownership/);
});

test('runtime image, user, private binding and secret/socket hardening are checked', () => {
  constraints(runtime(), f, 'restaurant');
  for (const mutate of [x => { x.Image = f.images.postgres; }, x => { x.Config.User = '0'; },
    x => { x.HostConfig.Privileged = true; }, x => { x.HostConfig.ReadonlyRootfs = false; },
    x => { x.HostConfig.CapDrop = []; }, x => { x.HostConfig.CapAdd = ['SYS_ADMIN']; },
    x => { x.HostConfig.SecurityOpt = []; }, x => { x.Config.Env.push('WACALLS_API_KEY=not-allowed'); },
    x => { x.Mounts.push({ Destination: '/var/run/docker.sock' }); },
    x => { x.HostConfig.PortBindings['8080/tcp'][0].HostIp = '0.0.0.0'; }]) {
    const info = runtime(); mutate(info); assert.throws(() => constraints(info, f, 'restaurant'), /fixture/);
  }
  assert.throws(() => constraints(runtime(), f, 'unexpected-service'), /fixture/);
  const database = { Image: f.images.postgres, HostConfig: { Privileged: false, PortBindings: {} } };
  constraints(database, f, 'postgres');
  database.HostConfig.PortBindings = { '5432/tcp': [] };
  assert.throws(() => constraints(database, f, 'postgres'), /published/);
});
