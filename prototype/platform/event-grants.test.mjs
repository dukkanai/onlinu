import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { createAuth, hash, pkceChallenge } from './auth.mjs';
import { createEvents } from './events.mjs';

// Only synthetic identities, disposable schemas and injected callback traffic.
// Origin binding is exercised with real OAuth rows and PostgreSQL row locks.
test('Events remain bound to their originating OAuth connection', { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 }, async t => {
  const url = new URL(process.env.TEST_DATABASE_URL);
  assert.equal(url.pathname, '/astracalls_oauth_refresh_test', 'Only the disposable OAuth test database is allowed');
  assert.equal(url.searchParams.has('dbname'), false, 'Database query overrides are not allowed');
  const schema = `event_grants_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: url.href });
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: url.href, options: `-c search_path=${schema}`, max: 10 });
  const baseUrl = 'https://platform.example', resource = `${baseUrl}/mcp`;
  const redirect = 'https://chatgpt.com/connector_platform_oauth_redirect';
  let events, requests = [], beforeOrder, beforeCallback;
  const auth = createAuth({ pool, baseUrl, redirectAllowlist: [redirect],
    onGrantRevoked: (id, transaction) => events.revokeAll(id, transaction) });
  const options = { pool, encryptionKey: randomBytes(32), authorizeGrant: auth.authorizeEventGrant,
    authorizeOrder: async () => { if (beforeOrder) await beforeOrder(); return { id: 'order-1' }; },
    webhookFetch: async (_url, request) => {
      if (beforeCallback) await beforeCallback(request);
      requests.push(request);
      return { ok: true, status: 200, json: async () => ({ challenge: JSON.parse(request.body).challenge }) };
    } };
  const params = () => ({ name: 'order.status_changed', arguments: { tenantId: 'demo-a', orderId: 'order-1' },
    delivery: { mode: 'webhook', url: 'https://receiver.example/callback', secret: `whsec_${randomBytes(32).toString('base64')}` } });
  const who = token => auth.authenticate({ headers: { authorization: `Bearer ${token}` } }, { bearerOnly: true });
  const source = id => ({ eventId: id, tenantId: 'demo-a', orderId: 'order-1', ownerId: 'customer-alice',
    status: 'accepted', paymentStatus: 'paid', version: 2, occurredAt: new Date().toISOString() });
  let familyClient, legacyClient;
  async function grant(kind = 'family') {
    const client = kind === 'family' ? familyClient : legacyClient;
    const verifier = randomBytes(32).toString('base64url');
    const location = new URL(await auth.authorize({ client_id: client.client_id, redirect_uri: redirect, resource,
      response_type: 'code', scope: 'orders:read events:read', code_challenge_method: 'S256',
      code_challenge: pkceChallenge(verifier), state: randomBytes(24).toString('base64url') }, { id: 'customer-alice' }));
    const tokens = await auth.exchange({ grant_type: 'authorization_code', client_id: client.client_id,
      redirect_uri: redirect, resource, code: location.searchParams.get('code'), code_verifier: verifier });
    return { ...tokens, principal: await who(tokens.access_token) };
  }
  async function reset() {
    beforeOrder = beforeCallback = undefined; requests = [];
    await pool.query('TRUNCATE event_deliveries,event_subscriptions,event_callback_verifications,event_owner_epochs');
    events = createEvents(options);
  }
  const rejectGrant = operation => assert.rejects(operation, error => error.status === 403 || error.code === -32001);
  try {
    await auth.init(); events = createEvents(options); await events.init();
    familyClient = await auth.register({ redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'] });
    legacyClient = await auth.register({ redirect_uris: [redirect] });

    for (const kind of ['family', 'session']) {
      await t.test(`${kind}: exact originating grant is persisted, and another grant cannot replace expired authority`, async () => {
        await reset();
        const origin = await grant(kind), other = await grant();
        assert.equal(origin.principal.eventGrant.kind, kind);
        const subscribed = await events.subscribe(origin.principal, params());
        const stored = (await pool.query('SELECT principal,expires_at FROM event_subscriptions WHERE id=$1', [subscribed.id])).rows[0];
        assert.deepEqual(stored.principal.eventGrant, origin.principal.eventGrant);
        assert.ok(stored.expires_at <= new Date(origin.principal.eventGrantExpiresAt));
        await events.enqueue(source(`evt-expired-${kind}`));
        const table = kind === 'family' ? 'demo_oauth_grants' : 'demo_sessions';
        const column = kind === 'family' ? 'id' : 'token_hash';
        await pool.query(`UPDATE ${table} SET expires_at=clock_timestamp()-interval '1 second' WHERE ${column}=$1`, [origin.principal.eventGrant.id]);
        assert.ok(await who(other.access_token), 'Unrelated grant stays active');
        const before = requests.length;
        assert.equal((await events.dispatchOnce()).revoked, 1);
        assert.equal(requests.length, before, 'No callback using the unrelated active grant');
        await rejectGrant(events.subscribe(origin.principal, params()));
        assert.equal(requests.length, before, 'Stale captured authentication cannot start a challenge');
        // An explicit new subscription using the still-valid connection works.
        await events.subscribe(other.principal, params());
        await events.enqueue(source(`evt-fresh-${kind}`));
        assert.equal((await events.dispatchOnce()).delivered, 1);
      });

      for (const pauseAt of ['order', 'verification']) {
        await t.test(`${kind}: revoke while ${pauseAt} is pending cannot restore a subscription or verification cache`, async () => {
          await reset();
          const origin = await grant(kind), other = await grant();
          const started = Promise.withResolvers(), resume = Promise.withResolvers();
          const pause = async () => { started.resolve(); await resume.promise; };
          if (pauseAt === 'order') beforeOrder = pause; else beforeCallback = pause;
          const pending = rejectGrant(events.subscribe(origin.principal, params()));
          await started.promise;
          await auth.revoke(origin.access_token);
          assert.ok(await who(other.access_token));
          resume.resolve(); await pending;
          assert.equal((await pool.query('SELECT 1 FROM event_subscriptions WHERE active')).rowCount, 0);
          assert.equal((await pool.query('SELECT 1 FROM event_callback_verifications')).rowCount, 0);
          const before = requests.length;
          beforeOrder = beforeCallback = undefined;
          await rejectGrant(events.subscribe(origin.principal, params()));
          assert.equal(requests.length, before);
        });
      }

      await t.test(`${kind}: delivery locks serialize revocation without deadlocking or later callbacks`, async () => {
        await reset();
        const origin = await grant(kind), other = await grant();
        await events.subscribe(origin.principal, params());
        await events.enqueue(source(`evt-inflight-${kind}`));
        const started = Promise.withResolvers(), resume = Promise.withResolvers();
        beforeOrder = async () => { started.resolve(); await resume.promise; };
        const dispatch = events.dispatchOnce();
        await started.promise;
        // A second connection must be unable to lock the exact origin while the
        // dispatcher is paused in its owned-order check, before webhook traffic.
        const probe = await pool.connect();
        try {
          await probe.query('BEGIN');
          const table = kind === 'family' ? 'demo_oauth_grants' : 'demo_sessions';
          const column = kind === 'family' ? 'id' : 'token_hash';
          await assert.rejects(probe.query(`SELECT 1 FROM ${table} WHERE ${column}=$1 FOR UPDATE NOWAIT`,
            [origin.principal.eventGrant.id]), error => error.code === '55P03');
        } finally { await probe.query('ROLLBACK'); probe.release(); }
        const revoke = auth.revoke(origin.access_token);
        resume.resolve();
        assert.equal((await dispatch).delivered, 1);
        await revoke;
        assert.ok(await who(other.access_token));
        beforeOrder = undefined;
        const before = requests.length;
        await events.enqueue(source(`evt-after-revoke-${kind}`));
        assert.equal((await events.dispatchOnce()).attempted, 0);
        assert.equal(requests.length, before);
      });
    }

    await t.test('owner-wide revocation fences pending work even when its own connection stays active', async () => {
      await reset();
      const origin = await grant(), other = await grant();
      const started = Promise.withResolvers(), resume = Promise.withResolvers();
      beforeOrder = async () => { started.resolve(); await resume.promise; };
      const pending = rejectGrant(events.subscribe(origin.principal, params()));
      await started.promise;
      await auth.revoke(other.access_token);
      assert.ok(await who(origin.access_token), 'The pending operation retains a valid original grant');
      resume.resolve(); await pending;
      beforeOrder = undefined;
      assert.equal(requests.length, 0);
      assert.equal((await pool.query('SELECT 1 FROM event_subscriptions WHERE active')).rowCount, 0);
      await events.subscribe(origin.principal, params());
    });

    await t.test('revoked originating family cannot deliver through another active family', async () => {
      await reset();
      const origin = await grant(), other = await grant();
      await events.subscribe(origin.principal, params());
      await events.enqueue(source('evt-origin-revoked'));
      // Simulate an already revoked source row with queued data still present,
      // independently of the usual owner-wide cancellation lifecycle hook.
      await pool.query('UPDATE demo_oauth_grants SET revoked=TRUE WHERE id=$1', [origin.principal.eventGrant.id]);
      assert.ok(await who(other.access_token));
      const before = requests.length;
      assert.equal((await events.dispatchOnce()).revoked, 1);
      assert.equal(requests.length, before);
    });

    await t.test('expiry while delivery waits for owned order status prevents callback traffic', async () => {
      await reset();
      const origin = await grant();
      let time = Date.now();
      const expiring = createEvents({ ...options, now: () => time });
      await expiring.subscribe(origin.principal, params());
      await expiring.enqueue(source('evt-expiring-in-order-read'));
      const before = requests.length;
      beforeOrder = async () => { time = Date.parse(origin.principal.eventGrantExpiresAt) + 1; };
      assert.equal((await expiring.dispatchOnce()).expired, 1);
      assert.equal(requests.length, before);
    });

    await t.test('refresh preserves the same grant binding while scope narrowing removes it', async () => {
      await reset();
      const origin = await grant(), other = await grant();
      await events.subscribe(origin.principal, params());
      const renewed = await auth.exchange({ grant_type: 'refresh_token', client_id: familyClient.client_id,
        resource, refresh_token: origin.refresh_token });
      assert.deepEqual((await who(renewed.access_token)).eventGrant, origin.principal.eventGrant);
      await events.enqueue(source('evt-after-refresh'));
      assert.equal((await events.dispatchOnce()).delivered, 1);
      await auth.exchange({ grant_type: 'refresh_token', client_id: familyClient.client_id,
        resource, refresh_token: renewed.refresh_token, scope: 'orders:read' });
      assert.ok(await who(other.access_token));
      await rejectGrant(events.subscribe(origin.principal, params()));
      assert.equal((await pool.query('SELECT 1 FROM event_subscriptions WHERE active')).rowCount, 0);
    });

    await t.test('two queued deliveries cannot survive expiry and rebind to a fresh connection', async () => {
      await reset();
      const origin = await grant(), other = await grant();
      const input = params();
      await events.subscribe(origin.principal, input);
      await events.enqueue(source('evt-expired-queue-1'));
      await events.enqueue(source('evt-expired-queue-2'));
      await pool.query('UPDATE demo_oauth_grants SET revoked=TRUE WHERE id=$1', [origin.principal.eventGrant.id]);
      assert.equal((await events.dispatchOnce()).revoked, 1);
      await events.subscribe(other.principal, input);
      const before = requests.length;
      assert.equal((await events.dispatchOnce()).attempted, 0);
      assert.equal(requests.length, before, 'Old queued data never borrows the new connection');
      await events.enqueue(source('evt-rebound-new-data'));
      assert.equal((await events.dispatchOnce()).delivered, 1);
    });

    await t.test('replacing a still-active originating grant discards its queued data', async () => {
      await reset();
      const origin = await grant(), other = await grant();
      const input = params();
      await events.subscribe(origin.principal, input);
      await events.enqueue(source('evt-previous-origin'));
      await events.subscribe(other.principal, input);
      const before = requests.length;
      assert.equal((await events.dispatchOnce()).attempted, 0);
      assert.equal(requests.length, before);
      await events.enqueue(source('evt-replacement-origin'));
      assert.equal((await events.dispatchOnce()).delivered, 1);
    });

    await t.test('an enqueue using a pre-revocation snapshot cannot survive re-creation', async () => {
      await reset();
      const origin = await grant(), other = await grant();
      const input = params();
      const subscription = await events.subscribe(origin.principal, input);
      const key = randomBytes(4).readUInt32BE() % 2_000_000_000;
      const blocker = await pool.connect();
      let pending;
      try {
        await blocker.query('BEGIN');
        await blocker.query('SELECT pg_advisory_xact_lock(5173,$1)', [key]);
        // Pause the INSERT after its SELECT captured the active old generation,
        // but before the row (and its FK) can become visible to cancellation.
        await pool.query(`CREATE FUNCTION pause_test_enqueue() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN PERFORM pg_advisory_xact_lock(5173,${key}); RETURN NEW; END $$;
          CREATE TRIGGER pause_test_enqueue BEFORE INSERT ON event_deliveries
            FOR EACH ROW EXECUTE FUNCTION pause_test_enqueue()`);
        pending = events.enqueue(source('evt-late-old-generation'));
        const deadline = Date.now() + 3000;
        while (!(await pool.query(`SELECT 1 FROM pg_locks WHERE locktype='advisory'
          AND classid=5173 AND objid=$1::oid AND NOT granted`, [key])).rowCount) {
          assert.ok(Date.now() < deadline, 'Enqueue reached the controlled barrier');
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        await auth.revoke(origin.access_token);
        await events.subscribe(other.principal, input);
        await blocker.query('COMMIT');
        assert.equal((await pending).enqueued, 1);
        const before = requests.length;
        assert.equal((await events.dispatchOnce()).revoked, 1);
        assert.equal(requests.length, before);
        assert.equal((await pool.query('SELECT active FROM event_subscriptions WHERE id=$1', [subscription.id])).rows[0].active, true,
          'Discarding stale queued data must preserve the newly authorized subscription');
      } finally {
        await blocker.query('ROLLBACK'); blocker.release();
        if (pending) await pending;
        await pool.query('DROP TRIGGER IF EXISTS pause_test_enqueue ON event_deliveries; DROP FUNCTION IF EXISTS pause_test_enqueue()');
      }
      await events.enqueue(source('evt-valid-new-generation'));
      assert.equal((await events.dispatchOnce()).delivered, 1);
    });

    await t.test('pre-upgrade subscriptions without an origin binding fail closed', async () => {
      await reset();
      const origin = await grant();
      await events.subscribe(origin.principal, params());
      await pool.query("UPDATE event_subscriptions SET principal=principal-'eventGrant'");
      await events.enqueue(source('evt-legacy-unbound'));
      const before = requests.length;
      assert.equal((await events.dispatchOnce()).revoked, 1);
      assert.equal(requests.length, before);
    });

    await t.test('wrong owner, resource, scope and missing binding cannot borrow another connection', async () => {
      await reset();
      const origin = await grant();
      const binding = origin.principal.eventGrant;
      for (const principal of [{ ...origin.principal, id: 'customer-bob' },
        { ...origin.principal, eventGrant: undefined },
        { ...origin.principal, eventGrant: { kind: 'session', id: hash(origin.access_token) } }]) {
        await rejectGrant(events.subscribe(principal, params()));
      }
      await pool.query("UPDATE demo_oauth_grants SET resource='https://other.example/mcp' WHERE id=$1", [binding.id]);
      await rejectGrant(events.subscribe(origin.principal, params()));
      await pool.query("UPDATE demo_oauth_grants SET resource=$2,scopes='[\"orders:read\"]' WHERE id=$1", [binding.id, resource]);
      await rejectGrant(events.subscribe(origin.principal, params()));
      assert.equal(requests.length, 0);
    });
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
});
