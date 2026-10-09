import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lookup } from 'node:dns/promises';
import https from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { Webhook } from 'standardwebhooks';

// This module deliberately offers no insecure/local callback mode. A transport
// can be injected by unit tests; deployment always uses the pinned HTTPS one.
const NAME = 'order.status_changed';
const DAY = 86_400_000;
const MAX_BYTES = 262_144;
const RESPONSE_BYTES = 16_384;
const MAX_ATTEMPTS = 5;
const ROTATION_MS = 300_000;
const VERIFY_CACHE_MS = 300_000;
const VALID_STATES = new Set(['pending_payment', 'new', 'accepted', 'preparing', 'ready', 'out_for_delivery', 'completed', 'cancelled']);
const VALID_PAYMENT_STATES = ['unpaid','pending','paid','failed','refunded','review'];

export class EventError extends Error {
  constructor(message, code = -32602, reason) {
    super(message);
    this.name = 'EventError';
    this.code = code;
    this.status = code === -32015 ? 400 : code === -32001 ? 403 : 400;
    if (reason) this.data = { reason };
  }
}

function invalid(message = 'Invalid event parameters') { throw new EventError(message); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function onlyKeys(value, keys) {
  if (!object(value) || Object.keys(value).some(key => !keys.includes(key))) invalid();
}
function identifier(value) { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,159}$/.test(value); }
function owner(principal) {
  if (!principal || !identifier(principal.id) || principal.role !== 'customer') {
    throw new EventError('Customer authentication required', -32001);
  }
  return { id: principal.id, role: principal.role, tenantIds: [],
    ...(principal.eventGrant ? { eventGrant: { kind: principal.eventGrant.kind, id: principal.eventGrant.id } } : {}) };
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export function isPublicAddress(address) {
  try {
    // process normalizes IPv4-mapped IPv6 before applying the range policy.
    const parsed = ipaddr.process(address);
    return parsed.range() === 'unicast';
  } catch { return false; }
}

export function callbackUrl(value) {
  let url;
  try { url = new URL(value); } catch { invalid('Invalid callback URL'); }
  if (typeof value !== 'string' || Buffer.byteLength(url.href) > 2048 || url.protocol !== 'https:' ||
      url.username || url.password || url.hash || (url.port && url.port !== '443')) {
    invalid('Callback must be an HTTPS URL on port 443 without credentials or fragment');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host.includes('%') || (isIP(host) && !isPublicAddress(host))) {
    invalid('Callback address is not public');
  }
  return url.href;
}

function callbackFailure(reason) {
  return new EventError('Callback verification or delivery failed', -32015, reason);
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const aborted = () => reject(callbackFailure('timeout'));
    if (signal.aborted) return aborted();
    signal.addEventListener('abort', aborted, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', aborted));
  });
}

// resolve/connect injection is for tests only. HTTPS connects to the validated
// IP through lookup(), retaining the URL hostname for Host and certificate/SNI.
export function createPinnedWebhookFetch({ resolve = lookup, connect = https.request } = {}) {
  return async function pinnedWebhookFetch(rawUrl, options = {}) {
    const url = new URL(callbackUrl(rawUrl));
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (options.method !== 'POST' || options.redirect !== 'error' || typeof options.body !== 'string') {
      throw callbackFailure('invalid_request');
    }
    if (Buffer.byteLength(options.body) > MAX_BYTES) throw callbackFailure('payload_too_large');
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
      : AbortSignal.timeout(10_000);
    let addresses;
    try {
      addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
        : await abortable(resolve(host, { all: true, verbatim: true }), signal);
    } catch (error) {
      if (error instanceof EventError) throw error;
      throw callbackFailure('dns_failed');
    }
    if (!addresses.length || addresses.some(record => !isPublicAddress(record.address))) {
      throw callbackFailure('address_blocked');
    }
    if (signal.aborted) throw callbackFailure('timeout');
    const pinned = addresses[0];
    return new Promise((resolveResponse, reject) => {
      let finished = false;
      const fail = reason => { if (!finished) { finished = true; reject(callbackFailure(reason)); } };
      const req = connect(url, {
        method: 'POST', headers: { ...options.headers, 'Content-Length': Buffer.byteLength(options.body) },
        agent: false, signal, rejectUnauthorized: true,
        servername: isIP(host) ? undefined : host,
        family: pinned.family, autoSelectFamily: false,
        lookup(_hostname, lookupOptions, callback) {
          if (lookupOptions?.all) callback(null, [{ address: pinned.address, family: pinned.family }]);
          else callback(null, pinned.address, pinned.family);
        },
      }, response => {
        const status = response.statusCode ?? 0;
        if (status >= 300 && status < 400) {
          fail('redirect_blocked'); response.destroy(); return;
        }
        // No error body is needed. Preserve terminal 410/413 even when the
        // receiver's error body is oversized or never completes.
        if (status >= 400 && status <= 599) {
          finished = true;
          resolveResponse({ status, ok: false, json: async () => ({}), text: async () => '' });
          response.destroy(); return;
        }
        if (Number(response.headers['content-length']) > RESPONSE_BYTES) {
          fail('response_too_large'); response.destroy(); return;
        }
        const chunks = [];
        let bytes = 0;
        response.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > RESPONSE_BYTES) { fail('response_too_large'); response.destroy(); }
          else chunks.push(chunk);
        });
        response.on('error', () => fail('network_error'));
        response.on('aborted', () => fail('network_error'));
        response.on('end', () => {
          if (finished) return;
          finished = true;
          const text = Buffer.concat(chunks).toString('utf8');
          resolveResponse({ status, ok: status >= 200 && status < 300,
            json: async () => JSON.parse(text), text: async () => text });
        });
      });
      req.on('error', () => fail(signal.aborted ? 'timeout' : 'network_error'));
      req.end(options.body);
    });
  };
}

const secureWebhookFetch = createPinnedWebhookFetch();
const digest = value => createHash('sha256').update(value).digest('hex');

function validateSecret(secret) {
  if (typeof secret !== 'string' || secret.length > 94 || !/^whsec_[A-Za-z0-9+/]+={0,2}$/.test(secret)) invalid('Invalid webhook signing secret');
  const encoded = secret.slice(6);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.length < 24 || bytes.length > 64 || bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')) {
    invalid('Invalid webhook signing secret');
  }
  return `whsec_${bytes.toString('base64')}`;
}

function subscriptionInput(principal, params, creating) {
  const identity = owner(principal);
  onlyKeys(params, creating ? ['name', 'arguments', 'delivery', 'cursor', 'ttlMs', '_meta'] : ['name', 'arguments', 'delivery', '_meta']);
  if (params._meta !== undefined && !object(params._meta)) invalid('Invalid protocol metadata');
  if (params.name !== NAME) invalid('Unknown event');
  onlyKeys(params.arguments, ['tenantId', 'orderId']);
  if (!identifier(params.arguments.tenantId) || !identifier(params.arguments.orderId)) invalid('Invalid event filters');
  onlyKeys(params.delivery, creating ? ['mode', 'url', 'secret'] : ['mode', 'url']);
  if (params.delivery.mode !== 'webhook') invalid('Only webhook delivery is supported');
  if (params.cursor !== undefined && params.cursor !== null) invalid('Event history replay is not supported');
  const url = callbackUrl(params.delivery.url);
  const args = { tenantId: params.arguments.tenantId, orderId: params.arguments.orderId };
  const id = `sub_${digest(canonicalJson({ owner: identity.id, name: NAME, arguments: args, url }))}`;
  if (creating) validateSecret(params.delivery.secret);
  return { id, identity, args, url };
}

function eventBody(event) {
  if (!object(event) || !identifier(event.eventId) || !identifier(event.tenantId) || !identifier(event.orderId) ||
      !identifier(event.ownerId) || !VALID_STATES.has(event.status) || !VALID_PAYMENT_STATES.includes(event.paymentStatus) ||
      !Number.isSafeInteger(event.version) || event.version < 1 ||
      typeof event.occurredAt !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(event.occurredAt) ||
      !Number.isFinite(Date.parse(event.occurredAt))) invalid('Invalid source event');
  return {
    eventId: event.eventId, name: NAME, timestamp: new Date(event.occurredAt).toISOString(),
    data: { tenantId: event.tenantId, orderId: event.orderId, status: event.status,
      paymentStatus: event.paymentStatus, version: event.version }, cursor: null,
  };
}

export function createEvents({ pool, encryptionKey, authorizeOrder, authorizeGrant, webhookFetch = secureWebhookFetch, now = Date.now }) {
  if (!pool?.query || !pool?.connect || typeof authorizeOrder !== 'function') throw new Error('Events require a PostgreSQL pool and authorization callback');
  if (authorizeGrant !== undefined && typeof authorizeGrant !== 'function') throw new Error('Invalid Events grant authorization callback');
  const key = Buffer.isBuffer(encryptionKey) ? Buffer.from(encryptionKey)
    : typeof encryptionKey === 'string' ? Buffer.from(encryptionKey, 'base64') : Buffer.alloc(0);
  if (key.length !== 32) throw new Error('Events require an external 32-byte encryption key');
  const clock = () => new Date(now());
  function encrypt(secret, id) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(id));
    return Buffer.concat([iv, cipher.update(secret, 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  }
  function decrypt(ciphertext, id) {
    const bytes = Buffer.from(ciphertext, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString('utf8');
  }
  async function signedPost(subscription, body, eventId) {
    if (Buffer.byteLength(body) > MAX_BYTES) throw callbackFailure('payload_too_large');
    const signedAt = clock();
    const secret = subscription.secret ?? decrypt(subscription.secret_cipher, subscription.id);
    const signatures = [new Webhook(secret).sign(eventId, signedAt, body)];
    if (subscription.previous_secret_cipher && new Date(subscription.rotation_until) > signedAt) {
      signatures.push(new Webhook(decrypt(subscription.previous_secret_cipher, subscription.id)).sign(eventId, signedAt, body));
    }
    return webhookFetch(subscription.callback_url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
      headers: { 'Content-Type': 'application/json', 'webhook-id': eventId,
        'webhook-timestamp': String(Math.floor(signedAt.getTime() / 1000)),
        'webhook-signature': signatures.join(' '), 'X-MCP-Subscription-Id': subscription.id }, body,
    });
  }

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS event_subscriptions (
        id text PRIMARY KEY, owner_id text NOT NULL, principal jsonb NOT NULL,
        event_name text NOT NULL, arguments jsonb NOT NULL, callback_url text NOT NULL,
        secret_cipher text NOT NULL, secret_hash text NOT NULL,
        previous_secret_cipher text, rotation_until timestamptz,
        expires_at timestamptz NOT NULL, active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
        revocation_epoch bigint NOT NULL DEFAULT 0, generation bigint NOT NULL DEFAULT 0
      );
      ALTER TABLE event_subscriptions ADD COLUMN IF NOT EXISTS revocation_epoch bigint NOT NULL DEFAULT 0;
      ALTER TABLE event_subscriptions ADD COLUMN IF NOT EXISTS generation bigint NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS event_owner_epochs (
        owner_id text PRIMARY KEY, epoch bigint NOT NULL DEFAULT 0
      );
      INSERT INTO event_owner_epochs(owner_id) SELECT DISTINCT owner_id FROM event_subscriptions ON CONFLICT DO NOTHING;
      CREATE INDEX IF NOT EXISTS event_subscriptions_match ON event_subscriptions
        (owner_id, event_name) WHERE active;
      CREATE TABLE IF NOT EXISTS event_callback_verifications (
        owner_id text NOT NULL, callback_url text NOT NULL, secret_hash text NOT NULL,
        verified_until timestamptz NOT NULL, PRIMARY KEY (owner_id,callback_url,secret_hash)
      );
      CREATE TABLE IF NOT EXISTS event_deliveries (
        subscription_id text NOT NULL REFERENCES event_subscriptions(id), event_id text NOT NULL,
        body text NOT NULL, status text NOT NULL DEFAULT 'pending', attempts integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz NOT NULL, created_at timestamptz NOT NULL,
        finished_at timestamptz, last_status integer, subscription_generation bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (subscription_id,event_id)
      );
      ALTER TABLE event_deliveries ADD COLUMN IF NOT EXISTS subscription_generation bigint NOT NULL DEFAULT 0;
      CREATE INDEX IF NOT EXISTS event_deliveries_due ON event_deliveries (next_attempt_at) WHERE status='pending';
      CREATE INDEX IF NOT EXISTS event_deliveries_subscription_due ON event_deliveries
        (subscription_id,next_attempt_at,created_at,event_id) WHERE status='pending';
    `);
  }

  function list(principal) {
    if (!principal || principal.role !== 'customer') return { events: [] };
    owner(principal);
    return { events: [{ name: NAME, description: 'Status of one order owned by the connected customer. No event history replay.',
      delivery: ['webhook'], inputSchema: { type: 'object', properties: {
        tenantId: { type: 'string' }, orderId: { type: 'string' },
      }, required: ['tenantId', 'orderId'], additionalProperties: false },
      payloadSchema: { type: 'object', properties: {
        tenantId: { type: 'string' }, orderId: { type: 'string' }, status: { type: 'string', enum: [...VALID_STATES] },
        paymentStatus: { type: 'string', enum: VALID_PAYMENT_STATES }, version: { type: 'integer', minimum: 1 },
      }, required: ['tenantId', 'orderId', 'status', 'paymentStatus', 'version'], additionalProperties: false },
    }] };
  }

  async function verify(subscription, secretHash) {
    const at = clock();
    const cached = await pool.query(`SELECT 1 FROM event_callback_verifications
      WHERE owner_id=$1 AND callback_url=$2 AND secret_hash=$3 AND verified_until>$4`,
    [subscription.identity.id, subscription.callback_url, secretHash, at]);
    if (cached.rowCount) return null;
    const challenge = randomBytes(32).toString('base64url');
    const body = JSON.stringify({ type: 'verification', challenge });
    const started = Date.now();
    try {
      const response = await signedPost(subscription, body, `msg_verification_${randomBytes(16).toString('hex')}`);
      if (!response.ok) throw callbackFailure('challenge_failed');
      const result = await response.json();
      const returned = typeof result?.challenge === 'string' && result.challenge.length < 128
        ? Buffer.from(result.challenge) : Buffer.alloc(0);
      const expected = Buffer.from(challenge);
      if (Date.now() - started > 10_000 || returned.length !== expected.length || !timingSafeEqual(returned, expected)) {
        throw callbackFailure('challenge_failed');
      }
    } catch (error) {
      if (error instanceof EventError && error.code === -32015) throw error;
      throw callbackFailure(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : 'challenge_failed');
    }
    // Persist verification only with the fenced subscription transaction. A
    // challenge completing after revokeAll must not restore the cleared cache.
    return new Date(at.getTime() + VERIFY_CACHE_MS);
  }

  const grantDenied = () => new EventError('Event grant expired or revoked', -32001);
  const denied = error => [401, 403, 404].includes(error?.status ?? error?.statusCode) || error?.code === -32001;
  async function ownerEpoch(db, principalId, lock = false, nowait = false) {
    if (lock && !nowait) await db.query('INSERT INTO event_owner_epochs(owner_id) VALUES($1) ON CONFLICT DO NOTHING', [principalId]);
    const result = await db.query(`SELECT epoch FROM event_owner_epochs WHERE owner_id=$1${lock ? ` FOR SHARE${nowait ? ' NOWAIT' : ''}` : ''}`, [principalId]);
    if (lock && !result.rowCount) throw grantDenied();
    return String(result.rows[0]?.epoch ?? '0');
  }
  async function grantExpiry(identity, db = pool, lock = false, nowait = false) {
    if (!authorizeGrant) return Infinity; // Standalone use delegates account policy to authorizeOrder.
    const value = Date.parse(await authorizeGrant(identity, db, { lock, nowait }));
    if (!Number.isFinite(value) || value <= clock().getTime()) throw grantDenied();
    return value;
  }
  async function subscribe(principal, params) {
    const { id, identity, args, url } = subscriptionInput(principal, params, true);
    // Snapshot before any remote await: revokeAll also fences operations that
    // have not inserted a subscription yet, even if this grant stays valid.
    const epoch = await ownerEpoch(pool, identity.id);
    let expiry = await grantExpiry(identity);
    if (principal.eventGrantExpiresAt !== undefined) {
      const requestedExpiry = Date.parse(principal.eventGrantExpiresAt);
      if (!Number.isFinite(requestedExpiry)) throw grantDenied();
      expiry = Math.min(expiry, requestedExpiry);
    }
    // Ownership authorization still precedes callback traffic and all writes.
    await authorizeOrder(identity, args);
    let ttl = params.ttlMs;
    if (ttl === undefined || ttl === null) ttl = DAY;
    if (!Number.isSafeInteger(ttl) || ttl < 1) invalid('Invalid subscription lifetime');
    ttl = Math.min(ttl, 7 * DAY);
    // Avoid starting verification after a revocation observed during the remote
    // read. The final locked check is authoritative for concurrent changes.
    expiry = Math.min(expiry, await grantExpiry(identity));
    if (expiry <= clock().getTime() || await ownerEpoch(pool, identity.id) !== epoch) throw grantDenied();
    const secret = validateSecret(params.delivery.secret);
    const secretHash = digest(secret);
    const verifiedUntil = await verify({ id, identity, secret, callback_url: url }, secretHash);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      expiry = Math.min(expiry, await grantExpiry(identity, client, true));
      if (await ownerEpoch(client, identity.id, true) !== epoch) throw grantDenied();
      const at = clock();
      const expires = new Date(Math.min(at.getTime() + ttl, expiry));
      if (expires <= at) throw grantDenied();
      if (verifiedUntil && verifiedUntil > at) await client.query(`INSERT INTO event_callback_verifications (owner_id,callback_url,secret_hash,verified_until)
        VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,callback_url,secret_hash)
        DO UPDATE SET verified_until=EXCLUDED.verified_until`, [identity.id, url, secretHash, verifiedUntil]);
      await client.query(`INSERT INTO event_subscriptions
        (id,owner_id,principal,event_name,arguments,callback_url,secret_cipher,secret_hash,expires_at,created_at,updated_at,revocation_epoch)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$12)
        ON CONFLICT (id) DO UPDATE SET
          previous_secret_cipher=CASE WHEN event_subscriptions.secret_hash<>EXCLUDED.secret_hash
            THEN event_subscriptions.secret_cipher ELSE event_subscriptions.previous_secret_cipher END,
          rotation_until=CASE WHEN event_subscriptions.secret_hash<>EXCLUDED.secret_hash
            THEN $11 ELSE event_subscriptions.rotation_until END,
          secret_cipher=EXCLUDED.secret_cipher, secret_hash=EXCLUDED.secret_hash,
          created_at=CASE WHEN NOT event_subscriptions.active OR event_subscriptions.expires_at<=EXCLUDED.updated_at
            OR event_subscriptions.revocation_epoch<>EXCLUDED.revocation_epoch
            OR event_subscriptions.principal->'eventGrant' IS DISTINCT FROM EXCLUDED.principal->'eventGrant'
            THEN EXCLUDED.created_at ELSE event_subscriptions.created_at END,
          generation=CASE WHEN NOT event_subscriptions.active OR event_subscriptions.expires_at<=EXCLUDED.updated_at
            OR event_subscriptions.revocation_epoch<>EXCLUDED.revocation_epoch
            OR event_subscriptions.principal->'eventGrant' IS DISTINCT FROM EXCLUDED.principal->'eventGrant'
            THEN event_subscriptions.generation+1 ELSE event_subscriptions.generation END,
          expires_at=EXCLUDED.expires_at, principal=EXCLUDED.principal, revocation_epoch=EXCLUDED.revocation_epoch,
          active=true, updated_at=EXCLUDED.updated_at`,
      [id, identity.id, identity, NAME, args, url, encrypt(secret, id), secretHash, expires, at, new Date(at.getTime() + ROTATION_MS), epoch]);
      // Cancel already queued data on re-creation/rebinding. An enqueue that
      // read an older snapshot may still arrive afterward; dispatch separately
      // checks its saved generation so that late row can never borrow this grant.
      await client.query(`UPDATE event_deliveries d SET status='revoked',finished_at=$2
        FROM event_subscriptions s WHERE s.id=$1 AND d.subscription_id=s.id
          AND d.status='pending' AND d.subscription_generation<>s.generation`, [id, at]);
      await client.query('COMMIT');
      return { id, refreshBefore: expires.toISOString(), cursor: null, truncated: false };
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async function unsubscribe(principal, params) {
    const { id, identity } = subscriptionInput(principal, params, false);
    // Deriving the ID from the authenticated owner makes this both authorized
    // and idempotent, including after the order itself becomes inaccessible.
    await cancelSubscriptions(pool, identity.id, id, 'cancelled');
    return {};
  }

  async function cancelSubscriptions(db, principalId, subscriptionId, reason) {
    // One statement both disables delivery and cancels existing retries. A
    // subsequent explicit resubscribe must not reactivate those old deliveries.
    // dispatchOnce uses SKIP LOCKED; an already-started request can finish before
    // this statement acquires its subscription lock, never after cancellation
    // has returned successfully.
    await db.query(`WITH stopped AS (
      UPDATE event_subscriptions SET active=false,updated_at=$2,generation=generation+1
      WHERE owner_id=$1 AND ($3::text IS NULL OR id=$3) RETURNING id
    ) UPDATE event_deliveries d SET status=$4,finished_at=$2
      FROM stopped WHERE d.subscription_id=stopped.id AND d.status='pending'`,
    [principalId, clock(), subscriptionId, reason]);
  }

  async function revokeAll(principalId, transaction) {
    // Trusted platform lifecycle hook, never an MCP tool or user-selected ID.
    // Deliberately return no counts or details about the owner's subscriptions.
    if (!identifier(principalId)) invalid('Invalid principal identifier');
    const fence = db => db.query(`INSERT INTO event_owner_epochs(owner_id,epoch) VALUES($1,1)
      ON CONFLICT (owner_id) DO UPDATE SET epoch=event_owner_epochs.epoch+1`, [principalId]);
    if (transaction) {
      await fence(transaction);
      await cancelSubscriptions(transaction, principalId, null, 'revoked');
      await transaction.query('DELETE FROM event_callback_verifications WHERE owner_id=$1', [principalId]);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await fence(client);
      await cancelSubscriptions(client, principalId, null, 'revoked');
      await client.query('DELETE FROM event_callback_verifications WHERE owner_id=$1', [principalId]);
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  async function enqueue(event) {
    const body = JSON.stringify(eventBody(event));
    if (Buffer.byteLength(body) > MAX_BYTES) invalid('Event payload too large');
    const at = clock();
    const result = await pool.query(`INSERT INTO event_deliveries (subscription_id,event_id,body,next_attempt_at,created_at,subscription_generation)
      SELECT id,$1,$2,$3,$3,generation FROM event_subscriptions
      WHERE active AND expires_at>$3 AND owner_id=$4 AND event_name=$5
        AND arguments->>'tenantId'=$6 AND arguments->>'orderId'=$7
        AND created_at<=$8
      ON CONFLICT (subscription_id,event_id) DO NOTHING`,
    [event.eventId, body, at, event.ownerId, NAME, event.tenantId, event.orderId, new Date(event.occurredAt)]);
    return { enqueued: result.rowCount };
  }

  async function dispatchOnce() {
    const counts = { attempted: 0, delivered: 0, retried: 0, terminal: 0, expired: 0, revoked: 0 };
    // One bounded delivery per invocation; root owns scheduling/concurrency.
    // Row locks serialize subscription cancellation and delivery, and rollback
    // after a crash leaves the same event ID queued for at-least-once delivery.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Inspect a bounded batch without row locks. Every candidate uses a
      // savepoint so an unavailable candidate releases ALL grant/owner locks
      // before the next, preserving grant -> owner -> subscription ordering.
      const candidates = (await client.query(`SELECT d.subscription_id,d.event_id,s.owner_id,s.principal
        FROM (SELECT DISTINCT ON (subscription_id) subscription_id,event_id,next_attempt_at,created_at
          FROM event_deliveries WHERE status='pending' AND next_attempt_at<=$1
          ORDER BY subscription_id,next_attempt_at,created_at,event_id) d
        JOIN event_subscriptions s ON s.id=d.subscription_id
        ORDER BY d.next_attempt_at,d.created_at,d.subscription_id,d.event_id LIMIT 32`, [clock()])).rows;
      let row, expiry, epoch, grantAuthorized;
      for (const candidate of candidates) {
        await client.query('SAVEPOINT event_candidate');
        try {
          expiry = Infinity; grantAuthorized = true;
          try { expiry = await grantExpiry(candidate.principal, client, true, true); }
          catch (error) { if (!denied(error)) throw error; grantAuthorized = false; }
          epoch = await ownerEpoch(client, candidate.owner_id, true, true);
          const found = await client.query(`SELECT d.*, s.id, s.owner_id, s.principal, s.arguments,
            s.callback_url,s.secret_cipher,s.previous_secret_cipher,s.rotation_until,s.expires_at,s.active,s.revocation_epoch,s.generation
            FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id
            WHERE d.subscription_id=$1 AND d.event_id=$2 AND s.principal=$3::jsonb
              AND d.status='pending' AND d.next_attempt_at<=$4
            FOR UPDATE OF d,s SKIP LOCKED`, [candidate.subscription_id,candidate.event_id,candidate.principal,clock()]);
          row = found.rows[0];
          if (!row) await client.query('ROLLBACK TO SAVEPOINT event_candidate');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT event_candidate');
          if (error?.code !== '55P03') throw error; // A busy grant/owner is skipped, never revoked.
        }
        await client.query('RELEASE SAVEPOINT event_candidate');
        if (row) break;
      }
      if (!row) { await client.query('COMMIT'); return counts; }
      const at = clock();
      let outcome;
      let httpStatus = null;
      if (String(row.subscription_generation) !== String(row.generation)) {
        // This old delivery must not disable the newly authorized subscription.
        outcome = 'revoked'; counts.revoked++;
      } else if (!grantAuthorized || String(row.revocation_epoch) !== epoch) {
        outcome = 'revoked'; counts.revoked++;
        await cancelSubscriptions(client, row.owner_id, row.id, 'revoked');
      } else if (!row.active || new Date(row.expires_at) <= at) {
        outcome = 'expired'; counts.expired++;
      } else {
        let authorized = false;
        try { await authorizeOrder(row.principal, row.arguments); authorized = true; }
        catch (error) {
          if (denied(error)) {
            outcome = 'revoked'; counts.revoked++;
            await cancelSubscriptions(client, row.owner_id, row.id, 'revoked');
          } else outcome = 'retry';
        }
        if (authorized && (expiry <= clock().getTime() || new Date(row.expires_at) <= clock())) {
          outcome = 'expired'; counts.expired++; authorized = false;
        }
        if (authorized) {
          // Decryption failure is not an event failure: retain the delivery and
          // surface startup/key configuration problems without losing events.
          row.secret = decrypt(row.secret_cipher, row.id);
          counts.attempted++;
          try {
            const response = await signedPost(row, row.body, row.event_id);
            httpStatus = response.status;
            if (response.ok) { outcome = 'delivered'; counts.delivered++; }
            else if ([408, 429].includes(httpStatus) || httpStatus >= 500) outcome = 'retry';
            else {
              outcome = 'terminal'; counts.terminal++;
              if (httpStatus === 410) await client.query('UPDATE event_subscriptions SET active=false,updated_at=$2 WHERE id=$1', [row.id, at]);
            }
          } catch { outcome = 'retry'; }
        }
      }
      const attempts = row.attempts + 1;
      if (outcome === 'retry') {
        if (attempts >= MAX_ATTEMPTS) { outcome = 'terminal'; counts.terminal++; }
        else counts.retried++;
      }
      await client.query(`UPDATE event_deliveries SET status=$3,attempts=$4,next_attempt_at=$5,
        finished_at=$6,last_status=$7 WHERE subscription_id=$1 AND event_id=$2`,
      [row.subscription_id, row.event_id, outcome === 'retry' ? 'pending' : outcome, attempts,
        new Date(clock().getTime() + Math.min(60_000, 1000 * 2 ** (attempts - 1))),
        outcome === 'retry' ? null : clock(), httpStatus]);
      await client.query('COMMIT');
      return counts;
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }

  return { init, list, subscribe, unsubscribe, revokeAll, enqueue, dispatchOnce };
}
