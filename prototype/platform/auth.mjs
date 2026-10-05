import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const NATIVE_CLIENT_ID='onlinu-native-windows-v1';
export const NATIVE_SCOPE='staff:access';
const nativeRedirectTemplate='http://127.0.0.1/oauth/callback';
export const CUSTOMER_SCOPES = ['orders:read', 'orders:write', 'events:read'];
export const FIXTURES = Object.freeze({
  'customer-alice': { role: 'customer', tenantIds: [] },
  'customer-bob': { role: 'customer', tenantIds: [] },
  'merchant-a': { role: 'merchant', tenantIds: ['demo-a'] },
  'merchant-b': { role: 'merchant', tenantIds: ['demo-b'] },
});
export const hash = value => createHash('sha256').update(value).digest('hex');
export const opaque = () => randomBytes(32).toString('base64url');
export function problem(status, code) {
  return Object.assign(new Error(code), { status, code });
}
export function requireScope(principal, scope) {
  if (!principal || principal.role !== 'customer') throw problem(403, 'customer_required');
  if (!principal.scopes?.includes(scope)) throw problem(403, 'insufficient_scope');
}
export function pkceChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}
export function verifyPkce(verifier, challenge) {
  return typeof verifier === 'string' && /^[A-Za-z0-9._~-]{43,128}$/.test(verifier)
    && pkceChallenge(verifier) === challenge;
}

// The local mode selects fixtures; staging obtains identities only from a
// separately verified OIDC provider. This broker authorizes synthetic data only.
export function createAuth({ pool, baseUrl, redirectAllowlist = [],
  cookieName = 'prototype_session', allowSyntheticAuthorization = true, csrfKey, principalResolver,
  onRegistrationRejected = () => {}, onGrantRevoked = async () => {}, profile='customer' }) {
  if(!['customer','native_staff'].includes(profile))throw new Error('invalid_auth_profile');
  const native=profile==='native_staff';
  if(native&&(allowSyntheticAuthorization||typeof principalResolver!=='function'||new URL(baseUrl).protocol!=='https:'||baseUrl!==new URL(baseUrl).origin+'/native'||redirectAllowlist.length))throw new Error('invalid_native_auth_configuration');
  const supportedScopes=Object.freeze(native?[NATIVE_SCOPE]:[...CUSTOMER_SCOPES]);
  const accessSeconds=native?900:1800,familySeconds=native?8*3600:7*86400,refreshSeconds=native?8*3600:86400;
  if (principalResolver !== undefined && (typeof principalResolver !== 'function' || allowSyntheticAuthorization)) throw new Error('persistent_identity_requires_verified_login');
  if (!/^[A-Za-z0-9_-]+$/.test(cookieName)) throw new Error('invalid_cookie_name');
  if (!allowSyntheticAuthorization && (!csrfKey || Buffer.from(csrfKey,'base64').length!==32)) throw new Error('csrf_key_required');
  if (typeof onRegistrationRejected !== 'function') throw new Error('invalid_registration_reporter');
  if (typeof onGrantRevoked !== 'function') throw new Error('invalid_grant_reporter');
  const resource = `${baseUrl}/${native?'api':'mcp'}`;
  const allowedRedirects = new Set(native?[nativeRedirectTemplate]:redirectAllowlist);
  function redirectAllowed(value){
    if(!native)return allowedRedirects.has(value);
    if(typeof value!=='string')return false;
    const match=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/oauth\/callback$/.exec(value);
    return !!match&&Number(match[1])>=1024&&Number(match[1])<=65535;
  }
  const registeredRedirect=(uris,value)=>redirectAllowed(value)&&uris.includes(native?nativeRedirectTemplate:value);
  const metadata = {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    ...(native?{}:{registration_endpoint: `${baseUrl}/oauth/register`}),
    revocation_endpoint: `${baseUrl}/oauth/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: supportedScopes,
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: false,
  };
  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS demo_identities (id TEXT PRIMARY KEY, enabled BOOLEAN NOT NULL DEFAULT TRUE);
      CREATE TABLE IF NOT EXISTS demo_sessions (
        token_hash TEXT PRIMARY KEY, principal_id TEXT NOT NULL REFERENCES demo_identities(id),
        issuer TEXT NOT NULL, audience TEXT NOT NULL, scopes JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE TABLE IF NOT EXISTS demo_oauth_clients (id TEXT PRIMARY KEY, redirect_uris JSONB NOT NULL);
      CREATE TABLE IF NOT EXISTS demo_oauth_codes (
        code_hash TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES demo_oauth_clients(id),
        principal_id TEXT NOT NULL REFERENCES demo_identities(id), redirect_uri TEXT NOT NULL,
        challenge TEXT NOT NULL, resource TEXT NOT NULL, scopes JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL
      );
      ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS session_kind TEXT NOT NULL DEFAULT 'oauth';
      ALTER TABLE demo_oauth_clients ADD COLUMN IF NOT EXISTS grant_types JSONB NOT NULL DEFAULT '["authorization_code"]'::jsonb;
      CREATE TABLE IF NOT EXISTS demo_oauth_grants (
        id TEXT PRIMARY KEY, client_id TEXT NOT NULL REFERENCES demo_oauth_clients(id),
        principal_id TEXT NOT NULL REFERENCES demo_identities(id), resource TEXT NOT NULL,
        scopes JSONB NOT NULL, expires_at TIMESTAMPTZ NOT NULL, revoked BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE TABLE IF NOT EXISTS demo_oauth_refresh_tokens (
        token_hash TEXT PRIMARY KEY, family_id TEXT NOT NULL REFERENCES demo_oauth_grants(id),
        expires_at TIMESTAMPTZ NOT NULL, consumed BOOLEAN NOT NULL DEFAULT FALSE
      );
      CREATE INDEX IF NOT EXISTS demo_refresh_family ON demo_oauth_refresh_tokens(family_id);
      ALTER TABLE demo_sessions ADD COLUMN IF NOT EXISTS oauth_family_id TEXT REFERENCES demo_oauth_grants(id);
    `);
    if(native){
      await pool.query('INSERT INTO demo_oauth_clients(id,redirect_uris,grant_types) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[NATIVE_CLIENT_ID,JSON.stringify([nativeRedirectTemplate]),JSON.stringify(['authorization_code','refresh_token'])]);
      const {rows}=await pool.query('SELECT redirect_uris,grant_types FROM demo_oauth_clients WHERE id=$1',[NATIVE_CLIENT_ID]);
      if(JSON.stringify(rows[0]?.redirect_uris)!==JSON.stringify([nativeRedirectTemplate])||JSON.stringify(rows[0]?.grant_types)!==JSON.stringify(['authorization_code','refresh_token']))throw new Error('native_client_registration_mismatch');
    }
    for (const id of principalResolver ? [] : Object.keys(FIXTURES)) {
      await pool.query('INSERT INTO demo_identities(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    }
  }
  async function principal(id, scopes) {
    if (principalResolver) {
      const identity = await principalResolver(id);
      if (!identity || identity.id !== id || identity.role !== 'customer') return null;
      const { rows } = await pool.query('SELECT enabled FROM demo_identities WHERE id=$1', [id]);
      if (rows[0]?.enabled === false) return null;
      const granted = scopes ?? supportedScopes;
      if (!Array.isArray(granted) || granted.some(scope => !supportedScopes.includes(scope))) return null;
      return { ...identity, scopes: [...new Set(granted)] };
    }
    const fixture = FIXTURES[id];
    if (!fixture) return null;
    const { rows } = await pool.query('SELECT enabled FROM demo_identities WHERE id=$1', [id]);
    if (!rows[0]?.enabled) return null;
    return { id, ...fixture, scopes: scopes ?? (fixture.role === 'customer' ? supportedScopes : []) };
  }
  async function issue(id, scopes, {kind='oauth', database=pool, familyId=null, expiresAt=new Date(Date.now() + accessSeconds * 1000).toISOString()} = {}) {
    if (!['browser','oauth'].includes(kind)||(native&&kind!=='oauth')) throw problem(400,'invalid_session_kind');
    const who = await principal(id, scopes);
    if (!who) throw problem(403, 'identity_disabled');
    if (principalResolver) await database.query('INSERT INTO demo_identities(id) VALUES($1) ON CONFLICT DO NOTHING', [id]);
    const token = opaque();
    await database.query(`INSERT INTO demo_sessions(token_hash,principal_id,issuer,audience,scopes,expires_at,session_kind,oauth_family_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [hash(token), id, baseUrl, resource, JSON.stringify(who.scopes), expiresAt,kind,familyId]);
    return { accessToken: token, expiresAt, principal: who };
  }
  function browserToken(req) {
    const matches=(req.headers.cookie ?? '').split(';').map(value=>value.trim()).filter(value=>value.startsWith(`${cookieName}=`));
    if(matches.length!==1)return null;
    const token=matches[0].slice(cookieName.length+1);
    return /^[A-Za-z0-9_-]{43}$/.test(token)?token:null;
  }
  function csrfToken(req) {
    const token=browserToken(req);
    if(!token || !csrfKey)throw problem(403,'csrf_required');
    return createHmac('sha256',Buffer.from(csrfKey,'base64')).update(token).digest('base64url');
  }
  function verifyCsrf(req,value=req.headers['x-csrf-token']) {
    if(typeof value!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(value))throw problem(403,'csrf_rejected');
    const actual=Buffer.from(value),expected=Buffer.from(csrfToken(req));
    if(actual.length!==expected.length || !timingSafeEqual(actual,expected))throw problem(403,'csrf_rejected');
  }
  async function authenticate(req, { bearerOnly = false, cookieOnly = false } = {}) {
    const authorization = req.headers.authorization;
    if(native&&(!authorization||cookieOnly))return null;
    let token;
    if (authorization !== undefined && !cookieOnly) {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
      if (!match) return null;
      token = match[1];
    } else if (!bearerOnly) {
      token = browserToken(req);
    }
    if (!token) return null;
    const { rows } = await pool.query(`SELECT s.principal_id,s.scopes,s.session_kind,s.expires_at,g.expires_at AS grant_expires_at FROM demo_sessions s
      LEFT JOIN demo_oauth_grants g ON g.id=s.oauth_family_id
      WHERE s.token_hash=$1 AND s.issuer=$2 AND s.audience=$3 AND s.expires_at>now()
      AND (s.oauth_family_id IS NULL OR (g.revoked=FALSE AND g.expires_at>now()))`, [hash(token), baseUrl, resource]);
    if((cookieOnly || !authorization) && rows[0]?.session_kind!=='browser')return null;
    if(!allowSyntheticAuthorization && authorization && !cookieOnly && rows[0]?.session_kind!=='oauth')return null;
    const identity=rows[0]?await principal(rows[0].principal_id,rows[0].scopes):null;
    if(identity&&!native&&rows[0].session_kind==='oauth'&&rows[0].expires_at)return{...identity,eventGrantExpiresAt:new Date(rows[0].grant_expires_at??rows[0].expires_at).toISOString()};
    return identity;
  }
  async function register(input) {
    if(native)throw problem(403,'registration_disabled');
    const rejected = [];
    if (!Array.isArray(input?.redirect_uris) || input.redirect_uris.length < 1 || input.redirect_uris.length > 3
      || input.redirect_uris.some(uri => !redirectAllowed(uri))) rejected.push('redirect_uris');
    if (input?.token_endpoint_auth_method && input.token_endpoint_auth_method !== 'none') rejected.push('token_endpoint_auth_method');
    const grants = input?.grant_types ?? ['authorization_code'];
    if (!Array.isArray(grants) || grants.length < 1 || grants.length > 2
      || new Set(grants).size !== grants.length || !grants.includes('authorization_code')
      || grants.some(grant => !metadata.grant_types_supported.includes(grant))) rejected.push('grant_types');
    if (input?.response_types && JSON.stringify(input.response_types) !== '["code"]') rejected.push('response_types');
    if (rejected.length) {
      // Only bounded, fixed labels describing protocol metadata. Never report
      // submitted URLs, callback IDs, client names, credentials, or raw input.
      const method = input?.token_endpoint_auth_method;
      const report = {
        fields: rejected,
        authMethod: ['none','client_secret_basic','client_secret_post','private_key_jwt'].includes(method) ? method : method ? 'other' : 'default',
        grantTypes: Array.isArray(input?.grant_types) ? input.grant_types.slice(0,4).map(value => ['authorization_code','refresh_token','client_credentials'].includes(value) ? value : 'other') : input?.grant_types ? ['invalid'] : ['default'],
        redirectKinds: Array.isArray(input?.redirect_uris) ? input.redirect_uris.slice(0,3).map(uri => redirectAllowed(uri) ? 'configured'
          : typeof uri === 'string' && /^https:\/\/chatgpt\.com\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(uri) ? 'chatgpt_connection_specific' : 'other') : ['invalid'],
      };
      try { onRegistrationRejected(report); } catch { /* Reporting must not alter authorization behavior. */ }
      throw problem(400, 'invalid_client_metadata');
    }
    const clientId = `demo_${opaque()}`;
    await pool.query('INSERT INTO demo_oauth_clients(id,redirect_uris,grant_types) VALUES($1,$2,$3)', [clientId, JSON.stringify(input.redirect_uris), JSON.stringify(grants)]);
    return { client_id: clientId, redirect_uris: input.redirect_uris,
      token_endpoint_auth_method: 'none', grant_types: grants, response_types: ['code'] };
  }
  async function validateAuthorization(input) {
    if(native&&input.client_id!==NATIVE_CLIENT_ID)throw problem(400,'invalid_client_metadata');
    const { rows } = await pool.query('SELECT redirect_uris FROM demo_oauth_clients WHERE id=$1', [input.client_id ?? '']);
    if (!rows[0] || !registeredRedirect(rows[0].redirect_uris,input.redirect_uri)) {
      throw problem(400, 'invalid_redirect_uri');
    }
    if (input.resource !== resource || input.response_type !== 'code' || input.code_challenge_method !== 'S256'
      || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge ?? '')
      || typeof input.state !== 'string' || input.state.length < 1 || input.state.length > 512) {
      throw problem(400, 'invalid_authorization_request');
    }
    if (typeof input.scope !== 'string') throw problem(400, 'invalid_scope');
    const scopes = input.scope.split(' ').filter(Boolean);
    if (!scopes.length || scopes.some(scope => !supportedScopes.includes(scope))) throw problem(400, 'invalid_scope');
    return { scopes: [...new Set(scopes)] };
  }
  async function authorize(input, verifiedPrincipal) {
    const { scopes } = await validateAuthorization(input);
    if(!allowSyntheticAuthorization && !verifiedPrincipal)throw problem(401,'authentication_required');
    if(!allowSyntheticAuthorization && input.identity!==undefined)throw problem(400,'identity_parameter_forbidden');
    const who = await principal(verifiedPrincipal?.id ?? input.identity);
    if (who?.role !== 'customer') throw problem(403, native?'staff_membership_required':'customer_required');
    if (principalResolver) await pool.query('INSERT INTO demo_identities(id) VALUES($1) ON CONFLICT DO NOTHING', [who.id]);
    const code = opaque();
    await pool.query(`INSERT INTO demo_oauth_codes VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '2 minutes')`,
      [hash(code), input.client_id, who.id, input.redirect_uri, input.code_challenge, resource, JSON.stringify(scopes)]);
    const redirect = new URL(input.redirect_uri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', input.state);
    redirect.searchParams.set('iss', baseUrl);
    return redirect.href;
  }
  async function exchange(input) {
    if (input.grant_type === 'refresh_token') return refresh(input);
    if (input.grant_type !== 'authorization_code' || input.resource !== resource || typeof input.code !== 'string'||(native&&input.client_id!==NATIVE_CLIENT_ID)) {
      throw problem(400, 'invalid_grant');
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query(`SELECT code.*,registered.grant_types FROM demo_oauth_codes code
        JOIN demo_oauth_clients registered ON registered.id=code.client_id
        WHERE code.code_hash=$1 AND code.expires_at>now() FOR UPDATE OF code`, [hash(input.code)]);
      const row = rows[0];
      if (!row || row.client_id !== input.client_id || row.redirect_uri !== input.redirect_uri
        || row.resource !== input.resource || !redirectAllowed(input.redirect_uri)
        || !verifyPkce(input.code_verifier, row.challenge)) throw problem(400, 'invalid_grant');
      // Code consumption, access-token minting and optional refresh family are
      // atomic. A committed authorization code can never be exchanged twice.
      await client.query('DELETE FROM demo_oauth_codes WHERE code_hash=$1', [hash(input.code)]);
      let result;
      if (row.grant_types.includes('refresh_token')) {
        const familyId = opaque();
        const familyExpiry = new Date(Date.now() + familySeconds * 1000).toISOString();
        await client.query(`INSERT INTO demo_oauth_grants(id,client_id,principal_id,resource,scopes,expires_at)
          VALUES($1,$2,$3,$4,$5,$6)`,[familyId,row.client_id,row.principal_id,resource,JSON.stringify(row.scopes),familyExpiry]);
        result = await mintFamilyTokens(client,row.principal_id,row.scopes,familyId,familyExpiry);
      } else {
        const session = await issue(row.principal_id,row.scopes,{database:client});
        result = {access_token:session.accessToken,token_type:'Bearer',expires_in:accessSeconds,scope:row.scopes.join(' '),resource};
      }
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async function mintFamilyTokens(client,principalId,scopes,familyId,familyExpiry) {
    const expiresAt = new Date(Math.min(Date.now()+accessSeconds*1000,new Date(familyExpiry).getTime())).toISOString();
    const session = await issue(principalId,scopes,{database:client,familyId,expiresAt});
    const refreshToken = opaque();
    await client.query(`INSERT INTO demo_oauth_refresh_tokens(token_hash,family_id,expires_at)
      VALUES($1,$2,LEAST(now()+($4::int*interval '1 second'),$3::timestamptz))`,[hash(refreshToken),familyId,familyExpiry,refreshSeconds]);
    return {access_token:session.accessToken,refresh_token:refreshToken,token_type:'Bearer',
      expires_in:Math.max(0,Math.ceil((new Date(expiresAt).getTime()-Date.now())/1000)),scope:scopes.join(' '),resource};
  }

  async function revokeFamily(client,family) {
    await client.query('UPDATE demo_oauth_grants SET revoked=TRUE WHERE id=$1',[family.id]);
    await client.query('DELETE FROM demo_sessions WHERE oauth_family_id=$1',[family.id]);
    // The platform cancels the owner's event subscriptions in this SAME
    // transaction, including pending deliveries and callback verification.
    await onGrantRevoked(family.principal_id,client);
  }

  async function refresh(input) {
    if (input.resource!==resource || typeof input.client_id!=='string' || input.client_id.length>128 || typeof input.refresh_token!=='string'
      || !/^[A-Za-z0-9_-]{43}$/.test(input.refresh_token ?? '')) throw problem(400,'invalid_grant');
    const client = await pool.connect();
    let committed = false;
    try {
      await client.query('BEGIN');
      const tokenHash = hash(input.refresh_token);
      const {rows:lookup} = await client.query('SELECT family_id FROM demo_oauth_refresh_tokens WHERE token_hash=$1',[tokenHash]);
      if (!lookup[0]) throw problem(400,'invalid_grant');
      // Lock the family first for rotation, reuse detection and revocation.
      // Concurrent refreshes cannot mint two successors or resurrect a grant.
      const {rows:families} = await client.query('SELECT * FROM demo_oauth_grants WHERE id=$1 FOR UPDATE',[lookup[0].family_id]);
      const family = families[0];
      if (!family || family.client_id!==input.client_id || family.resource!==resource
        || family.revoked || new Date(family.expires_at).getTime()<=Date.now()) throw problem(400,'invalid_grant');
      const {rows:tokens} = await client.query('SELECT * FROM demo_oauth_refresh_tokens WHERE token_hash=$1',[tokenHash]);
      const token = tokens[0];
      if (token.consumed) {
        await revokeFamily(client,family);
        await client.query('COMMIT');committed=true;
        throw problem(400,'invalid_grant');
      }
      if (new Date(token.expires_at).getTime()<=Date.now()) throw problem(400,'invalid_grant');
      if (!(await principal(family.principal_id))) {
        await revokeFamily(client,family);
        await client.query('COMMIT');committed=true;
        throw problem(400,'invalid_grant');
      }
      let scopes = family.scopes;
      if (input.scope!==undefined) {
        if (typeof input.scope!=='string' || input.scope.length>512) throw problem(400,'invalid_scope');
        scopes = [...new Set(input.scope.split(' ').filter(Boolean))];
        if (!scopes.length || scopes.some(scope=>!family.scopes.includes(scope))) throw problem(400,'invalid_scope');
        if (scopes.length!==family.scopes.length) {
          await client.query('UPDATE demo_oauth_grants SET scopes=$2 WHERE id=$1',[family.id,JSON.stringify(scopes)]);
          await client.query('DELETE FROM demo_sessions WHERE oauth_family_id=$1',[family.id]);
          if (!scopes.includes('events:read')) await onGrantRevoked(family.principal_id,client);
        }
      }
      await client.query('UPDATE demo_oauth_refresh_tokens SET consumed=TRUE WHERE token_hash=$1',[tokenHash]);
      const result = await mintFamilyTokens(client,family.principal_id,scopes,family.id,family.expires_at);
      await client.query('COMMIT');committed=true;
      return result;
    } catch (error) {
      if (!committed) await client.query('ROLLBACK');
      throw error;
    } finally {client.release();}
  }

  async function revoke(token) {
    if (typeof token!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const tokenHash = hash(token);
      const {rows} = await client.query(`SELECT oauth_family_id AS family_id,principal_id,session_kind FROM demo_sessions WHERE token_hash=$1 AND issuer=$2 AND audience=$3
        UNION SELECT r.family_id,g.principal_id,'oauth' AS session_kind FROM demo_oauth_refresh_tokens r
        JOIN demo_oauth_grants g ON g.id=r.family_id WHERE r.token_hash=$1 AND g.resource=$3`,[tokenHash,baseUrl,resource]);
      let owner = null;
      if (rows[0]?.family_id) {
        const {rows:families} = await client.query('SELECT * FROM demo_oauth_grants WHERE id=$1 FOR UPDATE',[rows[0].family_id]);
        if (families[0]) {await revokeFamily(client,families[0]);owner=families[0].principal_id;}
      } else {
        await client.query('DELETE FROM demo_sessions WHERE token_hash=$1 AND issuer=$2 AND audience=$3',[tokenHash,baseUrl,resource]);
        if(rows[0]?.session_kind==='oauth'){owner=rows[0].principal_id;await onGrantRevoked(owner,client);}
      }
      await client.query('COMMIT');
      return owner;
    } catch(error) {await client.query('ROLLBACK');throw error;}
    finally {client.release();}
  }
  async function nativeGrants(principalId){
    if(!native||typeof principalId!=='string'||!/^[a-f0-9-]{36}$/.test(principalId))throw problem(404,'not_found');
    const {rows}=await pool.query('SELECT id,client_id,expires_at FROM demo_oauth_grants WHERE principal_id=$1 AND resource=$2 AND revoked=FALSE AND expires_at>now() ORDER BY expires_at DESC LIMIT 100',[principalId,resource]);
    return rows.map(row=>({id:row.id,clientId:row.client_id,expiresAt:new Date(row.expires_at).toISOString()}));
  }
  async function revokeNativeGrant(principalId,grantId){
    if(!native||typeof principalId!=='string'||!/^[a-f0-9-]{36}$/.test(principalId)||(grantId!=='all'&&!/^[A-Za-z0-9_-]{43}$/.test(grantId??'')))throw problem(404,'not_found');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      const {rows}=await client.query("SELECT * FROM demo_oauth_grants WHERE principal_id=$1 AND resource=$2 AND ($3='all' OR id=$3) ORDER BY id FOR UPDATE",[principalId,resource,grantId]);
      if(grantId!=='all'&&!rows.length)throw problem(404,'not_found');
      for(const family of rows)if(!family.revoked)await revokeFamily(client,family);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  return { init, principal, issue, authenticate, browserToken, csrfToken, verifyCsrf, register, validateAuthorization, authorize, exchange, revoke, nativeGrants, revokeNativeGrant, metadata,
    resourceMetadata: { resource, authorization_servers: [baseUrl], scopes_supported: supportedScopes } };
}
