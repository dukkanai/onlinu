import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import pg from 'pg';
import { Webhook } from 'standardwebhooks';
import { createEvents, createPinnedWebhookFetch, isPublicAddress, callbackUrl, canonicalJson } from './events.mjs';

const alice = { id: 'customer-alice', role: 'customer', tenantIds: [] };
const bob = { id: 'customer-bob', role: 'customer', tenantIds: [] };
const secret = `whsec_${randomBytes(32).toString('base64')}`;
const params = (overrides = {}) => ({ name: 'order.status_changed',
  arguments: { tenantId: 'demo-a', orderId: 'order-1' },
  delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret },
  ...overrides });
const unsubscribeParams = value => ({ name: value.name, arguments: value.arguments,
  delivery: { mode: 'webhook', url: value.delivery.url } });
const forbidden = () => Object.assign(new Error('Not found'), { status: 404 });

test('callback URL and IP checks reject non-public and disguised local destinations', () => {
  for (const value of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.0.1',
    '169.254.169.254', '100.64.0.1', '192.0.2.1', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fe80::1', 'ff02::1', '2001:db8::1', '::ffff:127.0.0.1',
    '::ffff:169.254.169.254', '2002:7f00:1::', '64:ff9b::7f00:1']) {
    assert.equal(isPublicAddress(value), false, value);
  }
  for (const value of ['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111']) assert.equal(isPublicAddress(value), true, value);
  for (const value of ['http://example.com/hook', 'https://user:pass@example.com/',
    'https://example.com:8443/', 'https://example.com/#fragment', 'https://2130706433/',
    'https://0x7f000001/', 'https://[::ffff:127.0.0.1]/', 'file:///etc/passwd']) {
    assert.throws(() => callbackUrl(value), undefined, value);
  }
});

test('canonical filters ignore object-key ordering without changing values', () => {
  assert.equal(canonicalJson({ tenantId: 'demo-a', orderId: '1' }), canonicalJson({ orderId: '1', tenantId: 'demo-a' }));
  assert.notEqual(canonicalJson({ tenantId: 'demo-a', orderId: '1' }), canonicalJson({ tenantId: 'demo-b', orderId: '1' }));
});

function connectionStub({ status = 200, body = '{}', contentLength, inspect = () => {} } = {}) {
  return (url, options, callback) => {
    inspect(url, options);
    const request = new EventEmitter();
    request.end = () => queueMicrotask(() => {
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = status;
      response.headers = contentLength === undefined ? {} : { 'content-length': String(contentLength) };
      callback(response);
    });
    return request;
  };
}
const postOptions = { method: 'POST', redirect: 'error', headers: {}, body: '{}' };

test('HTTPS resolves on every connection, pins the validated IP, and preserves TLS hostname', async () => {
  let resolutions = 0;
  let connections = 0;
  const fetch = createPinnedWebhookFetch({
    resolve: async host => {
      assert.equal(host, 'receiver.example');
      return [{ address: ++resolutions === 1 ? '1.1.1.1' : '127.0.0.1', family: 4 }];
    },
    connect: connectionStub({ inspect: (url, options) => {
      connections++;
      assert.equal(url.hostname, 'receiver.example');
      assert.equal(options.servername, 'receiver.example');
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.agent, false);
      options.lookup('receiver.example', {}, (error, address, family) => {
        assert.equal(error, null); assert.equal(address, '1.1.1.1'); assert.equal(family, 4);
      });
    } }),
  });
  assert.equal((await fetch('https://receiver.example/callback', postOptions)).status, 200);
  await assert.rejects(fetch('https://receiver.example/callback', postOptions), error => error.data.reason === 'address_blocked');
  assert.equal(resolutions, 2); assert.equal(connections, 1);
});

test('mixed public/private DNS answers fail before connecting', async () => {
  const fetch = createPinnedWebhookFetch({
    resolve: async () => [{ address: '1.1.1.1', family: 4 }, { address: '::ffff:10.0.0.1', family: 6 }],
    connect: () => assert.fail('Must not connect'),
  });
  await assert.rejects(fetch('https://receiver.example/', postOptions), error => error.data.reason === 'address_blocked');
});

test('webhook transport blocks redirects and oversized responses and requests', async () => {
  const resolve = async () => [{ address: '1.1.1.1', family: 4 }];
  for (const config of [{ status: 302 }, { body: 'x'.repeat(16_385) }, { contentLength: 20_000 }]) {
    const fetch = createPinnedWebhookFetch({ resolve, connect: connectionStub(config) });
    await assert.rejects(fetch('https://receiver.example/', postOptions), error =>
      ['redirect_blocked', 'response_too_large'].includes(error.data.reason));
  }
  const fetch = createPinnedWebhookFetch({ resolve, connect: () => assert.fail('Must not connect') });
  await assert.rejects(fetch('https://receiver.example/', { ...postOptions, body: 'x'.repeat(262_145) }), error => error.data.reason === 'payload_too_large');
  for (const status of [410, 413]) {
    const terminal = createPinnedWebhookFetch({ resolve, connect: connectionStub({ status, contentLength: 1_000_000 }) });
    assert.equal((await terminal('https://receiver.example/', postOptions)).status, status);
  }
});

test('DNS resolution respects abort deadlines', async () => {
  const fetch = createPinnedWebhookFetch({ resolve: () => new Promise(() => {}), connect: () => assert.fail('Must not connect') });
  const controller = new AbortController();
  const pending = fetch('https://receiver.example/', { ...postOptions, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, error => error.data.reason === 'timeout');
});

test('customer ownership is checked before callback contact or persistence', async () => {
  let checked = 0;
  const events = createEvents({ pool: { query: async sql => { assert.match(sql, /^SELECT epoch /, 'No database write'); return { rows: [], rowCount: 0 }; }, connect() {} },
    encryptionKey: randomBytes(32),
    authorizeOrder: async () => { checked++; throw forbidden(); },
    webhookFetch: () => assert.fail('No callback contact'),
  });
  await assert.rejects(events.subscribe(alice, params()), error => error.status === 404);
  assert.equal(checked, 1);
  await assert.rejects(events.subscribe({ id: 'merchant-a', role: 'merchant' }, params()), error => error.status === 403);
  for (const invalid of [params({ name: 'other' }), params({ arguments: { tenantId: 'demo-a', orderId: '1', ownerId: bob.id } }),
    params({ cursor: 'unimplemented-replay' }), params({ delivery: { mode: 'webhook', url: 'https://receiver.example/', secret: 'whsec_invalid' } })]) {
    await assert.rejects(events.subscribe(alice, invalid), error => error.code === -32602);
  }
  assert.equal(checked, 1);
  assert.deepEqual(events.list(null), { events: [] });
  assert.equal(events.list(alice).events[0].name, 'order.status_changed');
  assert.throws(() => createEvents({ pool: { query() {}, connect() {} }, authorizeOrder() {}, encryptionKey: 'missing' }), /32-byte/);
});

// A separate schema keeps integration assertions away from the platform's
// synthetic orders/sessions. Set TEST_DATABASE_URL to the prototype DB only.
test('PostgreSQL event lifecycle and durable delivery security', { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 }, async t => {
  const schema = `event_test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  const key = randomBytes(32);
  let time = Date.now();
  let allow = true;
  let responseStatus = 200;
  let wrongChallenge = false;
  let requests = [];
  const options = { pool, encryptionKey: key, now: () => time,
    authorizeOrder: async (principal, args) => {
      if (!allow || principal.id !== alice.id || args.tenantId !== 'demo-a' || args.orderId !== 'order-1') throw forbidden();
      return { ownerId: alice.id };
    },
    webhookFetch: async (url, request) => {
      requests.push({ url, ...request });
      const payload = JSON.parse(request.body);
      return { status: payload.type === 'verification' ? 200 : responseStatus,
        ok: payload.type === 'verification' || responseStatus >= 200 && responseStatus < 300,
        json: async () => ({ challenge: wrongChallenge ? 'incorrect' : payload.challenge }) };
    },
  };
  let events = createEvents(options);
  const source = (id = 'evt-1', extra = {}) => ({ sequence: 1, eventId: id, tenantId: 'demo-a', orderId: 'order-1',
    ownerId: alice.id, status: 'accepted', paymentStatus: 'paid', version: 2,
    occurredAt: new Date(time).toISOString(), ...extra });
  async function reset() {
    await pool.query('TRUNCATE event_deliveries,event_subscriptions,event_callback_verifications');
    time = Date.now(); allow = true; responseStatus = 200; wrongChallenge = false; requests = [];
    events = createEvents(options);
  }
  try {
    await events.init();
    await t.test('canonical idempotent subscriptions, encrypted secrets, cache, restart, deduplication and signed exact bytes', async () => {
      const first = await events.subscribe(alice, params());
      const second = await events.subscribe(alice, params({ arguments: { orderId: 'order-1', tenantId: 'demo-a' }, _meta: { progressToken: 'test-only' } }));
      assert.equal(first.id, second.id); assert.equal(first.cursor, null); assert.equal(requests.length, 1);
      assert.equal(new Webhook(secret).verify(requests[0].body, requests[0].headers).type, 'verification');
      const stored = await pool.query('SELECT * FROM event_subscriptions');
      assert.equal(stored.rowCount, 1); assert.equal(JSON.stringify(stored.rows).includes(secret), false);
      assert.equal((await events.enqueue(source())).enqueued, 1);
      assert.equal((await events.enqueue(source())).enqueued, 0);
      for (const extra of [{ tenantId: 'demo-b' }, { ownerId: bob.id }, { orderId: 'order-2' }]) {
        assert.equal((await events.enqueue(source('evt-foreign', extra))).enqueued, 0);
      }
      events = createEvents(options); // Process restart: no in-memory subscription data.
      assert.equal((await events.dispatchOnce()).delivered, 1);
      const delivery = requests.at(-1);
      const verified = new Webhook(secret).verify(delivery.body, delivery.headers);
      assert.equal(verified.eventId, 'evt-1'); assert.equal(delivery.headers['webhook-id'], 'evt-1');
      assert.equal(delivery.headers['X-MCP-Subscription-Id'], first.id);
      assert.equal(Object.hasOwn(verified.data, 'ownerId'), false);
      assert.equal(Object.hasOwn(verified, 'type'), false);
      assert.equal((await events.dispatchOnce()).attempted, 0);
    });

    await t.test('additive fencing migration is repeatable and seeds existing owner rows', async () => {
      await reset();
      await events.subscribe(alice, params());
      await events.enqueue(source());
      await pool.query(`ALTER TABLE event_subscriptions DROP COLUMN revocation_epoch, DROP COLUMN generation;
        ALTER TABLE event_deliveries DROP COLUMN subscription_generation;
        DROP TABLE event_owner_epochs`);
      await events.init(); await events.init();
      assert.equal((await pool.query('SELECT owner_id FROM event_owner_epochs')).rows[0].owner_id, alice.id);
      assert.equal((await events.dispatchOnce()).delivered, 1);
    });

    await t.test('failed challenge never activates a subscription', async () => {
      await reset(); wrongChallenge = true;
      await assert.rejects(events.subscribe(alice, params()), error => error.code === -32015 && error.data.reason === 'challenge_failed');
      assert.equal((await pool.query('SELECT * FROM event_subscriptions')).rowCount, 0);
      assert.equal((await pool.query('SELECT * FROM event_callback_verifications')).rowCount, 0);
    });

    await t.test('retry survives restart with same event/body, fresh signature and bounded attempts', async () => {
      await reset(); await events.subscribe(alice, params()); await events.enqueue(source()); responseStatus = 503;
      for (let attempt = 1; attempt <= 5; attempt++) {
        events = createEvents(options);
        const result = await events.dispatchOnce();
        assert.equal(attempt === 5 ? result.terminal : result.retried, 1);
        time += 1000 * 2 ** (attempt - 1);
      }
      const deliveries = requests.filter(value => !JSON.parse(value.body).type);
      assert.equal(deliveries.length, 5);
      assert.equal(new Set(deliveries.map(value => value.headers['webhook-id'])).size, 1);
      assert.equal(new Set(deliveries.map(value => value.body)).size, 1);
      assert.equal(new Set(deliveries.map(value => value.headers['webhook-signature'])).size, 5);
      assert.equal((await events.dispatchOnce()).attempted, 0);
    });

    await t.test('410 and 413 stop retry; 410 deactivates the subscription', async () => {
      for (const status of [410, 413]) {
        await reset(); await events.subscribe(alice, params()); await events.enqueue(source()); responseStatus = status;
        assert.equal((await events.dispatchOnce()).terminal, 1);
        time += 60_000;
        assert.equal((await events.dispatchOnce()).attempted, 0);
        assert.equal((await pool.query('SELECT active FROM event_subscriptions')).rows[0].active, status !== 410);
      }
    });

    await t.test('finite TTL, ownership revocation and owner-scoped idempotent unsubscribe stop delivery', async () => {
      await reset(); await events.subscribe(alice, params({ ttlMs: 1000 })); await events.enqueue(source());
      time += 1001;
      assert.equal((await events.dispatchOnce()).expired, 1); assert.equal(requests.length, 1);
      await reset(); await events.subscribe(alice, params()); await events.enqueue(source()); allow = false;
      assert.equal((await events.dispatchOnce()).revoked, 1); assert.equal(requests.length, 1);
      await reset(); await events.subscribe(alice, params());
      await events.unsubscribe(bob, unsubscribeParams(params()));
      assert.equal((await pool.query('SELECT active FROM event_subscriptions')).rows[0].active, true);
      await events.unsubscribe(alice, unsubscribeParams(params()));
      await events.unsubscribe(alice, unsubscribeParams(params()));
      assert.equal((await events.enqueue(source())).enqueued, 0);
      const finite = await events.subscribe(alice, params({ ttlMs: null }));
      assert.ok(finite.refreshBefore); assert.equal(Date.parse(finite.refreshBefore) - time, 86_400_000);
    });

    await t.test('rotating signing keys requires verification and signs with both keys for a short window', async () => {
      await reset(); const original = await events.subscribe(alice, params());
      const replacement = `whsec_${randomBytes(32).toString('base64')}`;
      const updated = await events.subscribe(alice, params({ delivery: { mode: 'webhook', url: params().delivery.url, secret: replacement } }));
      assert.equal(original.id, updated.id); assert.equal(requests.length, 2);
      await events.enqueue(source()); await events.dispatchOnce();
      const sent = requests.at(-1);
      assert.equal(new Webhook(secret).verify(sent.body, sent.headers).eventId, 'evt-1');
      assert.equal(new Webhook(replacement).verify(sent.body, sent.headers).eventId, 'evt-1');
      assert.equal(sent.headers['webhook-signature'].split(' ').length, 2);
    });

    await t.test('owner-wide revocation cancels current subscriptions and retries without touching another owner', async () => {
      await reset();
      const bothOwners = createEvents({ ...options, authorizeOrder: async (principal, args) => {
        if (principal.id === bob.id && args.tenantId === 'demo-b' && args.orderId === 'bob-order') return { ownerId: bob.id };
        return options.authorizeOrder(principal, args);
      } });
      await bothOwners.subscribe(alice, params());
      await bothOwners.subscribe(alice, params({ delivery: { ...params().delivery, url: 'https://receiver.example/second-callback' } }));
      await bothOwners.enqueue(source());
      responseStatus = 503;
      assert.equal((await bothOwners.dispatchOnce()).retried, 1);
      await bothOwners.subscribe(bob, params({ arguments: { tenantId: 'demo-b', orderId: 'bob-order' } }));
      await bothOwners.enqueue(source('evt-bob', { ownerId: bob.id, tenantId: 'demo-b', orderId: 'bob-order' }));
      const before = requests.length;
      assert.equal(await bothOwners.revokeAll(alice.id), undefined);
      assert.equal(await bothOwners.revokeAll(alice.id), undefined);
      assert.equal(await bothOwners.revokeAll('customer-unknown'), undefined);
      assert.equal(requests.length, before);
      const states = await pool.query(`SELECT s.owner_id,s.active,d.status FROM event_subscriptions s
        JOIN event_deliveries d ON d.subscription_id=s.id ORDER BY s.owner_id`);
      assert.equal(states.rows.filter(row => row.owner_id === alice.id).length, 2);
      assert.ok(states.rows.filter(row => row.owner_id === alice.id).every(row => !row.active && row.status === 'revoked'));
      assert.deepEqual(states.rows.find(row => row.owner_id === bob.id), { owner_id: bob.id, active: true, status: 'pending' });
      const cached = await pool.query('SELECT owner_id FROM event_callback_verifications');
      assert.deepEqual(cached.rows, [{ owner_id: bob.id }]);
      assert.equal((await bothOwners.enqueue(source('evt-after-revocation'))).enqueued, 0);
      responseStatus = 200; time += 2000;
      assert.equal((await bothOwners.dispatchOnce()).delivered, 1);
      assert.equal(JSON.parse(requests.at(-1).body).eventId, 'evt-bob');
      assert.equal((await bothOwners.dispatchOnce()).attempted, 0);
    });

    for (const pauseAt of ['order authorization', 'callback verification']) {
      await t.test(`revocation fences a pending subscription during ${pauseAt}`, async () => {
        await reset();
        const started = Promise.withResolvers(), resume = Promise.withResolvers();
        const delayed = createEvents({ ...options,
          authorizeOrder: async (...args) => {
            if (pauseAt === 'order authorization') { started.resolve(); await resume.promise; }
            return options.authorizeOrder(...args);
          },
          webhookFetch: async (...args) => {
            if (pauseAt === 'callback verification') { started.resolve(); await resume.promise; }
            return options.webhookFetch(...args);
          },
        });
        const pending = delayed.subscribe(alice, params());
        const rejected = assert.rejects(pending, error => error.code === -32001);
        await started.promise;
        await events.revokeAll(alice.id);
        resume.resolve();
        await rejected;
        assert.equal((await pool.query('SELECT 1 FROM event_subscriptions WHERE active')).rowCount, 0);
        assert.equal((await pool.query('SELECT 1 FROM event_callback_verifications')).rowCount, 0);
        // A fresh explicitly authorized operation after revocation may subscribe.
        await events.subscribe(alice, params());
        assert.equal((await events.enqueue(source('evt-after-fresh-subscribe'))).enqueued, 1);
        assert.equal((await events.dispatchOnce()).delivered, 1);
      });
    }

    await t.test('callback delay cannot extend or outlive the originating grant expiry', async () => {
      await reset();
      const expiresAt = time + 1000;
      const delayed = createEvents({ ...options, webhookFetch: async (...args) => {
        const response = await options.webhookFetch(...args); time += 1001; return response;
      } });
      await assert.rejects(delayed.subscribe({ ...alice, eventGrantExpiresAt: new Date(expiresAt).toISOString() }, params()),
        error => error.code === -32001);
      assert.equal((await pool.query('SELECT 1 FROM event_subscriptions')).rowCount, 0);
      assert.equal((await pool.query('SELECT 1 FROM event_callback_verifications')).rowCount, 0);
    });

    await t.test('callback time is not added to the absolute grant expiry', async () => {
      await reset();
      const expiresAt = time + 1000;
      const delayed = createEvents({ ...options, webhookFetch: async (...args) => {
        const response = await options.webhookFetch(...args); time += 500; return response;
      } });
      const result = await delayed.subscribe({ ...alice, eventGrantExpiresAt: new Date(expiresAt).toISOString() }, params());
      assert.equal(Date.parse(result.refreshBefore), expiresAt);
    });

    await t.test('failed subscription persistence rolls back callback verification', async () => {
      await reset();
      await pool.query('ALTER TABLE event_subscriptions ADD CONSTRAINT reject_test_subscription CHECK (FALSE) NOT VALID');
      try {
        await assert.rejects(events.subscribe(alice, params()), error => error.code === '23514');
        assert.equal((await pool.query('SELECT 1 FROM event_callback_verifications')).rowCount, 0);
      } finally { await pool.query('ALTER TABLE event_subscriptions DROP CONSTRAINT reject_test_subscription'); }
    });

    await t.test('unsubscribe permanently cancels a retry even if the same subscription is recreated', async () => {
      await reset(); await events.subscribe(alice, params()); await events.enqueue(source()); responseStatus = 503;
      assert.equal((await events.dispatchOnce()).retried, 1);
      await events.unsubscribe(alice, unsubscribeParams(params()));
      assert.equal((await pool.query('SELECT status FROM event_deliveries')).rows[0].status, 'cancelled');
      await events.subscribe(alice, params()); responseStatus = 200; time += 2000;
      const before = requests.length;
      assert.equal((await events.dispatchOnce()).attempted, 0);
      assert.equal(requests.length, before);
      await events.enqueue(source('evt-fresh'));
      assert.equal((await events.dispatchOnce()).delivered, 1);
    });

    await t.test("a busy delivery does not block another owner's due delivery", async () => {
      await reset();
      const started = Promise.withResolvers(), resume = Promise.withResolvers();
      const parallel = createEvents({ ...options, authorizeOrder: async () => ({}), webhookFetch: async (...args) => {
        if (JSON.parse(args[1].body).eventId === 'evt-slow-alice') { started.resolve(); await resume.promise; }
        return options.webhookFetch(...args);
      } });
      await parallel.subscribe(alice, params());
      await parallel.subscribe(bob, params());
      await parallel.enqueue(source('evt-slow-alice'));
      // One busy subscription cannot occupy the whole bounded candidate batch.
      for (let index = 0; index < 40; index++) await parallel.enqueue(source(`evt-slow-alice-${index}`));
      time++;
      await parallel.enqueue(source('evt-fast-bob', { ownerId: bob.id }));
      const first = parallel.dispatchOnce();
      await started.promise;
      try { assert.equal((await parallel.dispatchOnce()).delivered, 1, 'A different unlocked delivery must be claimed'); }
      finally { resume.resolve(); await first; }
    });

    await t.test('parallel dispatchers claim a delivery once; wrong encryption key preserves it', async () => {
      await reset(); await events.subscribe(alice, params()); await events.enqueue(source());
      const wrongKey = createEvents({ ...options, encryptionKey: randomBytes(32) });
      await assert.rejects(wrongKey.dispatchOnce());
      assert.equal((await pool.query('SELECT status FROM event_deliveries')).rows[0].status, 'pending');
      const results = await Promise.all([events.dispatchOnce(), createEvents(options).dispatchOnce()]);
      assert.equal(results.reduce((sum, result) => sum + result.delivered, 0), 1);
    });
  } finally {
    await pool.end();
    // This randomly named, test-owned schema is the only deletion target.
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
