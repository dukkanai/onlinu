import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import * as oidc from 'openid-client';

const FLOW_TTL_MS = 600_000;
const MAX_RESPONSE = 1_048_576;
const token = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const safeEqual = (left, right) => timingSafeEqual(Buffer.from(hash(left), 'hex'), Buffer.from(hash(right), 'hex'));
const opaqueToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

export class OidcLoginError extends Error {
  constructor(code, status = 400) { super(code); this.name = 'OidcLoginError'; this.code = code; this.status = status; }
}
const invalid = () => new OidcLoginError('oidc_invalid_flow');
const denied = () => new OidcLoginError('oidc_identity_not_allowed', 403);
const unavailable = () => new OidcLoginError('oidc_unavailable', 503);

function httpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('OIDC configuration requires HTTPS URLs'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('OIDC configuration requires HTTPS URLs without credentials, query or fragment');
  }
  return url;
}

export function validateReturnTo(value, baseUrl) {
  if (typeof value !== 'string' || value.length > 4096 || !value.startsWith('/') || value.startsWith('//') ||
      /[\\\x00-\x20\x7f]/.test(value) || /%(?:0[0-9a-f]|1[0-9a-f]|7f|5c)/i.test(value)) throw invalid();
  let destination;
  try { destination = new URL(value, baseUrl); } catch { throw invalid(); }
  if (destination.origin !== new URL(baseUrl).origin || destination.username || destination.password || destination.hash ||
      !(destination.pathname === '/' || destination.pathname === '/oauth/authorize' || destination.pathname === '/manage' ||
        /^\/manage\/[a-z0-9][a-z0-9-]{0,63}\/(orders(?:\/R[0-9]{8,20})?|channels|stock|menu(?:\/items\/[A-Za-z0-9][A-Za-z0-9_-]{0,79})?)$/.test(destination.pathname) ||
        /^\/checkout\/[A-Za-z0-9_-]{1,160}$/.test(destination.pathname))) throw invalid();
  if (destination.pathname !== '/oauth/authorize' && destination.search) throw invalid();
  return `${destination.pathname}${destination.search}`;
}

// Exported to test the real library's signature/claim validation with a fake
// HTTPS provider transport. The deployment does not inject fetch or adapters.
export function createOidcClientAdapter({ issuer, clientId, clientSecret, fetchImpl = globalThis.fetch }) {
  const issuerUrl = httpsUrl(issuer);
  let configuration;

  async function providerFetch(input, options = {}) {
    let destination;
    try { destination = new URL(input instanceof Request ? input.url : input); } catch { throw unavailable(); }
    if (destination.protocol !== 'https:' || destination.origin !== issuerUrl.origin ||
        destination.username || destination.password || destination.hash) throw unavailable();
    const signal = options.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000);
    try {
      const response = await fetchImpl(destination.href, { ...options, signal, redirect: 'error' });
      if (response.status >= 300 && response.status < 400 || Number(response.headers.get('content-length')) > MAX_RESPONSE) throw unavailable();
      const chunks = [];
      let bytes = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const part = await reader.read();
            if (part.done) break;
            bytes += part.value.length;
            if (bytes > MAX_RESPONSE) { await reader.cancel(); throw unavailable(); }
            chunks.push(Buffer.from(part.value));
          }
        } finally { reader.releaseLock(); }
      }
      return new Response(bytes ? Buffer.concat(chunks) : null,
        { status: response.status, statusText: response.statusText, headers: response.headers });
    } catch { throw unavailable(); }
  }

  async function config() {
    if (!configuration) {
      configuration = (async () => {
        const discovered = await oidc.discovery(issuerUrl, clientId, undefined,
          oidc.ClientSecretBasic(clientSecret), { [oidc.customFetch]: providerFetch, timeout: 10,
            execute: [oidc.enableNonRepudiationChecks] });
        const metadata = discovered.serverMetadata();
        if (metadata.issuer !== issuerUrl.href) throw unavailable();
        for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
          const endpoint = new URL(metadata[key]);
          if (endpoint.protocol !== 'https:' || endpoint.origin !== issuerUrl.origin || endpoint.username || endpoint.password || endpoint.hash) throw unavailable();
        }
        return discovered;
      })().catch(() => { configuration = undefined; throw unavailable(); });
    }
    return configuration;
  }

  return {
    async authorizationUrl({ state, nonce, codeChallenge, redirectUri }) {
      return oidc.buildAuthorizationUrl(await config(), {
        response_type: 'code', scope: 'openid email', redirect_uri: redirectUri,
        state, nonce, code_challenge: codeChallenge, code_challenge_method: 'S256',
      }).href;
    },
    async exchange({ callbackUrl, state, nonce, codeVerifier }) {
      const configured = await config();
      try {
        const tokens = await oidc.authorizationCodeGrant(configured, new URL(callbackUrl), {
          expectedState: state, expectedNonce: nonce, pkceCodeVerifier: codeVerifier, idTokenExpected: true,
        });
        return tokens.claims(); // Access/refresh/ID token strings never leave this adapter.
      } catch (error) {
        if (error instanceof OidcLoginError || error?.cause instanceof OidcLoginError) throw unavailable();
        throw new OidcLoginError('oidc_verification_failed', 403);
      }
    },
  };
}

export function createOidcLogin({ pool, issuer, clientId, clientSecret, baseUrl, identityMap, identityResolver,
  clientAdapter, now = Date.now }) {
  if (!pool?.query || !pool?.connect) throw new Error('OIDC requires a PostgreSQL pool');
  const issuerUrl = httpsUrl(issuer);
  const applicationUrl = httpsUrl(baseUrl);
  if (applicationUrl.pathname !== '/') throw new Error('OIDC baseUrl must be an origin');
  if (typeof clientId !== 'string' || !clientId || clientId.length > 200 ||
      typeof clientSecret !== 'string' || clientSecret.length < 16) throw new Error('OIDC client configuration missing');
  if (identityResolver !== undefined && (typeof identityResolver !== 'function' || identityMap !== undefined)) throw new Error('Choose one verified OIDC identity mapping');
  if (!identityResolver && (!identityMap || typeof identityMap !== 'object' || Array.isArray(identityMap))) throw new Error('OIDC identity map required');
  const allowed = new Map(Object.entries(identityMap ?? {}));
  if (!identityResolver && (!allowed.size || new Set(allowed.values()).size !== allowed.size || [...allowed].some(([email, principal]) =>
    typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
    typeof principal !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(principal)))) {
    throw new Error('OIDC identity map must uniquely map exact verified emails to internal identities');
  }
  const redirectUri = `${applicationUrl.origin}/auth/callback`;
  const adapter = clientAdapter ?? createOidcClientAdapter({ issuer: issuerUrl.href, clientId, clientSecret });
  const clock = () => new Date(now());

  async function init() {
    await pool.query(`CREATE TABLE IF NOT EXISTS oidc_login_states (
      state_hash text PRIMARY KEY, binding_hash text NOT NULL, nonce text NOT NULL,
      pkce_verifier text NOT NULL, return_to text NOT NULL,
      created_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
    );
    CREATE INDEX IF NOT EXISTS oidc_login_states_expiry ON oidc_login_states(expires_at);
    CREATE TABLE IF NOT EXISTS oidc_identity_bindings (
      issuer text NOT NULL, subject text NOT NULL, principal_id text NOT NULL, created_at timestamptz NOT NULL,
      PRIMARY KEY (issuer,subject), UNIQUE (issuer,principal_id)
    );`);
    // No discovery at startup: the HTTPS proxy/provider may still be starting.
  }

  async function begin(returnTo = '/') {
    const destination = validateReturnTo(returnTo, applicationUrl.origin);
    const state = token();
    const bindingCookie = token();
    const nonce = token();
    const verifier = token();
    let authorizationUrl;
    try {
      authorizationUrl = await adapter.authorizationUrl({ state, nonce, redirectUri,
        codeChallenge: createHash('sha256').update(verifier).digest('base64url') });
      const redirect = new URL(authorizationUrl);
      if (redirect.protocol !== 'https:' || redirect.origin !== issuerUrl.origin || redirect.username || redirect.password || redirect.hash) throw unavailable();
      const at = clock();
      await pool.query('DELETE FROM oidc_login_states WHERE expires_at<=$1', [at]);
      await pool.query(`INSERT INTO oidc_login_states
        (state_hash,binding_hash,nonce,pkce_verifier,return_to,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [hash(state), hash(bindingCookie), nonce, verifier, destination, at, new Date(at.getTime() + FLOW_TTL_MS)]);
    } catch (error) { if (error instanceof OidcLoginError) throw error; throw unavailable(); }
    return { authorizationUrl, bindingCookie };
  }

  async function consume(state, bindingCookie) {
    let db;
    try { db = await pool.connect(); } catch { throw unavailable(); }
    try {
      await db.query('BEGIN');
      const found = await db.query('SELECT * FROM oidc_login_states WHERE state_hash=$1 FOR UPDATE', [hash(state)]);
      const row = found.rows[0];
      if (!row || new Date(row.expires_at) <= clock() || !safeEqual(row.state_hash, hash(state)) || !safeEqual(row.binding_hash, hash(bindingCookie))) throw invalid();
      await db.query('DELETE FROM oidc_login_states WHERE state_hash=$1', [hash(state)]);
      await db.query('COMMIT');
      return row;
    } catch (error) {
      await db.query('ROLLBACK');
      if (error instanceof OidcLoginError) throw error;
      throw unavailable();
    } finally { db.release(); }
  }

  async function complete(callbackUrl, bindingCookie) {
    let callback;
    try { callback = new URL(callbackUrl); } catch { throw invalid(); }
    if (callback.origin !== applicationUrl.origin || callback.pathname !== '/auth/callback' ||
        callback.username || callback.password || callback.hash ||
        ['state', 'code', 'error', 'iss'].some(key => callback.searchParams.getAll(key).length > 1)) throw invalid();
    const state = callback.searchParams.get('state');
    if (!opaqueToken(state) || !opaqueToken(bindingCookie)) throw invalid();
    const saved = await consume(state, bindingCookie); // One use, even on failed exchange.
    let claims;
    try {
      claims = await adapter.exchange({ callbackUrl: callback.href, state,
        nonce: saved.nonce, codeVerifier: saved.pkce_verifier, redirectUri });
    } catch (error) {
      if (error instanceof OidcLoginError) throw error;
      throw new OidcLoginError('oidc_verification_failed', 403);
    }
    if (!claims || claims.iss !== issuerUrl.href ||
        (claims.aud !== clientId && !(Array.isArray(claims.aud) && claims.aud.includes(clientId))) ||
        typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || /[\x00-\x1f\x7f]/.test(claims.sub) ||
        typeof claims.nonce !== 'string' || !safeEqual(claims.nonce, saved.nonce)) throw denied();
    let principalId;
    if (identityResolver) {
      // The library has verified the signed token and this layer has checked
      // issuer/audience/nonce before creating any identity. Never link by email.
      try { principalId = (await identityResolver({ issuer: claims.iss, subject: claims.sub }))?.id; }
      catch (error) { if (error?.status === 403) throw denied(); throw unavailable(); }
    } else {
      principalId = typeof claims.email === 'string' ? allowed.get(claims.email) : undefined;
      if (claims.email_verified !== true) throw denied();
    }
    if (typeof principalId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(principalId)) throw denied();
    try {
      // Neither a new subject claiming a previously bound email nor an existing
      // subject changing to another allowed email can take over an identity.
      await pool.query(`INSERT INTO oidc_identity_bindings (issuer,subject,principal_id,created_at)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [issuerUrl.href, claims.sub, principalId, clock()]);
      const existing = await pool.query('SELECT principal_id FROM oidc_identity_bindings WHERE issuer=$1 AND subject=$2', [issuerUrl.href, claims.sub]);
      if (existing.rows[0]?.principal_id !== principalId) throw denied();
    } catch (error) { if (error instanceof OidcLoginError) throw error; throw unavailable(); }
    return { principalId, returnTo: validateReturnTo(saved.return_to, applicationUrl.origin) };
  }

  return { init, begin, complete };
}
