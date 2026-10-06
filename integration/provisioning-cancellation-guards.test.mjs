import test from 'node:test';
import assert from 'node:assert/strict';
import { validateContext, assertOwned, assertInert } from './provisioning-cancellation-smoke.mjs';

const env = { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '1234', GITHUB_RUN_ATTEMPT: '1',
  GITHUB_SHA: 'a'.repeat(40), RUNNER_TEMP: '/tmp/fixture' };
const image = 'onlinu-runtime-smoke:' + env.GITHUB_SHA;
const expected = { name: 'onlinu-fixture', imageId: 'sha256:' + 'b'.repeat(64), labels: { fixture: 'unique' } };
const info = () => ({ Id: 'c'.repeat(64), Name: '/' + expected.name, Image: expected.imageId,
  Config: { Labels: { ...expected.labels }, User: '10001:10001' }, State: { Status: 'created', Running: false },
  HostConfig: { ReadonlyRootfs: true, Privileged: false, NetworkMode: 'none', CapDrop: ['ALL'],
    CapAdd: null, PortBindings: null, SecurityOpt: ['no-new-privileges'] }, Mounts: [] });

test('cancellation fixture requires exact ephemeral run and image context', () => {
  validateContext(env, image);
  for (const change of [{ GITHUB_ACTIONS: 'false' }, { GITHUB_RUN_ID: '../bad' }, { GITHUB_RUN_ATTEMPT: '' },
    { GITHUB_SHA: 'latest' }, { RUNNER_TEMP: 'relative' }])
    assert.throws(() => validateContext({ ...env, ...change }, image), /context/);
  assert.throws(() => validateContext(env, 'postgres:16'), /context/);
});

test('cleanup requires exact fixture ID, name, image and all ownership labels', () => {
  assertOwned(info(), expected);
  for (const changed of [{ Id: 'bad' }, { Name: '/neighbor' }, { Image: 'sha256:' + 'd'.repeat(64) },
    { Config: { Labels: { fixture: 'different' } } }])
    assert.throws(() => assertOwned({ ...info(), ...changed }, expected), /ownership/);
});

test('fixture must remain unstarted, isolated, mount-free and hardened', () => {
  assertInert(info());
  for (const mutate of [x => { x.State.Running = true; }, x => { x.State.Status = 'exited'; },
    x => { x.Mounts = [{ Destination: '/data' }]; }, x => { x.Config.User = '0'; },
    x => { x.HostConfig.Privileged = true; }, x => { x.HostConfig.NetworkMode = 'host'; },
    x => { x.HostConfig.ReadonlyRootfs = false; }, x => { x.HostConfig.CapDrop = []; },
    x => { x.HostConfig.CapAdd = ['SYS_ADMIN']; }, x => { x.HostConfig.SecurityOpt = []; },
    x => { x.HostConfig.PortBindings = { '8080/tcp': [] }; }]) {
    const value = info(); mutate(value); assert.throws(() => assertInert(value), /inert/);
  }
});
