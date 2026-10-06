import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvisioningComposeApply } from './provisioning-compose-apply.mjs';
const local = JSON.stringify([{ Name: 'default', Endpoints: { docker: { Host: 'unix:///var/run/docker.sock' } } }]);
const fail = e => e.code === 'provisioning_compose_apply_unconfirmed' && !JSON.stringify(e).includes('PRIVATE');
function setup({ run, verify, checkpoint, empty } = {}) {
  const calls = [], events = [];
  const apply = createProvisioningComposeApply({ processRunner: { async run(args, opts) {
    calls.push(args); events.push(args.includes('up') ? 'up' : args.includes('config') ? 'config' : 'context');
    return run ? await run(args, opts) : args.includes('context') ? local : '';
  } }, verifyExecution: async () => { events.push('verify'); return verify ? await verify() : '/synthetic/compose.json'; },
  assertEmpty: async () => { events.push('empty'); if (empty) await empty(); } });
  const fence = async () => { events.push('checkpoint'); if (checkpoint) await checkpoint(); };
  return { apply, calls, events, fence };
}
test('single compose attempt sequences authority, integrity and emptiness before fixed no-pull commands', async () => {
  const f = setup(); assert.deepEqual(await f.apply.apply({ checkpoint: f.fence }), { commandCompleted: true });
  assert.deepEqual(f.events, ['checkpoint','verify','context','config','checkpoint','verify','empty','checkpoint','verify','up']);
  assert.deepEqual(f.calls[2], ['--context','default','compose','--env-file','/dev/null','-f','/synthetic/compose.json','up','--wait','--wait-timeout','90','--pull','never','--no-build']);
  await assert.rejects(f.apply.apply({ checkpoint: f.fence }), fail); assert.equal(f.calls.length, 3);
});
test('remote context, changed manifest and revoked checkpoint cannot reach apply', async () => {
  let n = 0;
  for (const f of [
    setup({ run: async () => JSON.stringify([{ Name:'default', Endpoints:{docker:{Host:'tcp://remote:2375'}} }]) }),
    setup({ verify: async () => ++n === 1 ? '/synthetic/compose.json' : '/PRIVATE/other.json' }),
    setup({ checkpoint: async () => { throw new Error('PRIVATE authority'); } }),
    setup({ empty: async () => { throw new Error('PRIVATE conflict'); } }),
    setup({ verify: async () => '../unsafe' }),
  ]) { await assert.rejects(f.apply.apply({ checkpoint: f.fence }), fail); assert.ok(!f.calls.some(v => v.includes('up'))); }
});
test('lost apply reply is sanitized and never retried or automatically removed', async () => {
  const f = setup({ run: async args => { if (args.includes('up')) throw new Error('PRIVATE daemon details'); return args.includes('context') ? local : ''; } });
  await assert.rejects(f.apply.apply({ checkpoint: f.fence }), fail);
  await assert.rejects(f.apply.apply({ checkpoint: f.fence }), fail);
  assert.equal(f.calls.filter(v => v.includes('up')).length, 1);
  assert.ok(!f.calls.some(v => v.includes('down') || v.includes('rm') || v.includes('pull')));
});
test('cancellation aborts before effects and remains single-attempt', async () => {
  const abort = new AbortController();
  const f = setup({ empty: async () => abort.abort() });
  await assert.rejects(f.apply.apply({ checkpoint: f.fence, signal: abort.signal }), fail);
  assert.ok(!f.calls.some(v => v.includes('up')));
  await assert.rejects(f.apply.apply({ checkpoint: f.fence }), fail);
});
