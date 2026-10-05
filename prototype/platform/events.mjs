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
const VALID_STATES = new Set(['pending_payment', 'accepted', 'preparing', 'ready', 'completed']);

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
  return { id: principal.id, role: principal.role, tenantIds: [] };
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
      !identifier(event.ownerId) || !VALID_STATES.has(event.status) || !['pending', 'paid'].includes(event.paymentStatus) ||
      !Number.isSafeInteger(event.version) || event.version < 1 ||
      typeof event.occurredAt !== 'string' || !/(Z|[+-]\d\d:\d\d)$/.test(event.occurredAt) ||
      !Number.isFinite(Date.parse(event.occurredAt))) invalid('Invalid source event');
  return {
    eventId: event.eventId, name: NAME, timestamp: new Date(event.occurredAt).toISOString(),
    data: { tenantId: event.tenantId, orderId: event.orderId, status: event.status,
      paymentStatus: event.paymentStatus, version: event.version }, cursor: null,
  };
}

export function createEvents({ pool, encryptionKey, authorizeOrder, webhookFetch = secureWebhookFetch, now = Date.now }) {
  if (!pool?.query || !pool?.connect || typeof authorizeOrder !== 'function') throw new Error('Events require a PostgreSQL pool and authorization callback');
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
        created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL
      );
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
        finished_at timestamptz, last_status integer,
        PRIMARY KEY (subscription_id,event_id)
      );
      CREATE INDEX IF NOT EXISTS event_deliveries_due ON event_deliveries (next_attempt_at) WHERE status='pending';
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
        paymentStatus: { type: 'string', enum: ['pending', 'paid'] }, version: { type: 'integer', minimum: 1 },
      }, required: ['tenantId', 'orderId', 'status', 'paymentStatus', 'version'], additionalProperties: false },
    }] };
  }

  async function verify(subscription, secretHash) {
    const at = clock();
    const cached = await pool.query(`SELECT 1 FROM event_callback_verifications
      WHERE owner_id=$1 AND callback_url=$2 AND secret_hash=$3 AND verified_until>$4`,
    [subscription.identity.id, subscription.callback_url, secretHash, at]);
    if (cached.rowCount) return;
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
    await pool.query(`INSERT INTO event_callback_verifications (owner_id,callback_url,secret_hash,verified_until)
      VALUES ($1,$2,$3,$4) ON CONFLICT (owner_id,callback_url,secret_hash)
      DO UPDATE SET verified_until=EXCLUDED.verified_until`,
    [subscription.identity.id, subscription.callback_url, secretHash, new Date(at.getTime() + VERIFY_CACHE_MS)]);
  }

  async function subscribe(principal, params) {
    const { id, identity, args, url } = subscriptionInput(principal, params, true);
    // Authorization precedes all callback traffic and all subscription writes.
    await authorizeOrder(identity, args);
    let ttl = params.ttlMs;
    if (ttl === undefined || ttl === null) ttl = DAY; // Never grant non-expiring subscriptions.
    if (!Number.isSafeInteger(ttl) || ttl < 1) invalid('Invalid subscription lifetime');
    ttl = Math.min(ttl, 7 * DAY);
    const secret = validateSecret(params.delivery.secret);
    const secretHash = digest(secret);
    await verify({ id, identity, secret, callback_url: url }, secretHash);
    const at = clock();
    const expires = new Date(at.getTime() + ttl);
    await pool.query(`INSERT INTO event_subscriptions
      (id,owner_id,principal,event_name,arguments,callback_url,secret_cipher,secret_hash,expires_at,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
      ON CONFLICT (id) DO UPDATE SET
        previous_secret_cipher=CASE WHEN event_subscriptions.secret_hash<>EXCLUDED.secret_hash
          THEN event_subscriptions.secret_cipher ELSE event_subscriptions.previous_secret_cipher END,
        rotation_until=CASE WHEN event_subscriptions.secret_hash<>EXCLUDED.secret_hash
          THEN $11 ELSE event_subscriptions.rotation_until END,
        secret_cipher=EXCLUDED.secret_cipher, secret_hash=EXCLUDED.secret_hash,
        expires_at=EXCLUDED.expires_at, principal=EXCLUDED.principal, active=true, updated_at=EXCLUDED.updated_at`,
    [id, identity.id, identity, NAME, args, url, encrypt(secret, id), secretHash, expires, at, new Date(at.getTime() + ROTATION_MS)]);
    return { id, refreshBefore: expires.toISOString(), cursor: null, truncated: false };
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
      UPDATE event_subscriptions SET active=false,updated_at=$2
      WHERE owner_id=$1 AND ($3::text IS NULL OR id=$3) RETURNING id
    ) UPDATE event_deliveries d SET status=$4,finished_at=$2
      FROM stopped WHERE d.subscription_id=stopped.id AND d.status='pending'`,
    [principalId, clock(), subscriptionId, reason]);
  }

  async function revokeAll(principalId, transaction) {
    // Trusted platform lifecycle hook, never an MCP tool or user-selected ID.
    // Deliberately return no counts or details about the owner's subscriptions.
    if (!identifier(principalId)) invalid('Invalid principal identifier');
    if (transaction) {
      await cancelSubscriptions(transaction, principalId, null, 'revoked');
      await transaction.query('DELETE FROM event_callback_verifications WHERE owner_id=$1', [principalId]);
      return;
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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
    const result = await pool.query(`INSERT INTO event_deliveries (subscription_id,event_id,body,next_attempt_at,created_at)
      SELECT id,$1,$2,$3,$3 FROM event_subscriptions
      WHERE active AND expires_at>$3 AND owner_id=$4 AND event_name=$5
        AND arguments->>'tenantId'=$6 AND arguments->>'orderId'=$7
      ON CONFLICT (subscription_id,event_id) DO NOTHING`,
    [event.eventId, body, at, event.ownerId, NAME, event.tenantId, event.orderId]);
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
      const found = await client.query(`SELECT d.*, s.id, s.owner_id, s.principal, s.arguments,
        s.callback_url,s.secret_cipher,s.previous_secret_cipher,s.rotation_until,s.expires_at,s.active
        FROM event_deliveries d JOIN event_subscriptions s ON s.id=d.subscription_id
        WHERE d.status='pending' AND d.next_attempt_at<=$1
        ORDER BY d.next_attempt_at, d.created_at LIMIT 1 FOR UPDATE OF d,s SKIP LOCKED`, [clock()]);
      if (!found.rowCount) { await client.query('COMMIT'); return counts; }
      const row = found.rows[0];
      const at = clock();
      let outcome;
      let httpStatus = null;
      if (!row.active || new Date(row.expires_at) <= at) {
        outcome = 'expired'; counts.expired++;
      } else {
        let authorized = false;
        try { await authorizeOrder(row.principal, row.arguments); authorized = true; }
        catch (error) {
          if ([401, 403, 404].includes(error?.status ?? error?.statusCode) || error?.code === -32001) {
            outcome = 'revoked'; counts.revoked++;
            await client.query('UPDATE event_subscriptions SET active=false,updated_at=$2 WHERE id=$1', [row.id, at]);
          } else outcome = 'retry';
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
