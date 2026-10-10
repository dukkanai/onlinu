/** Persistent control-plane identities and restaurant memberships.
 * Call verifiedIdentity only AFTER an OIDC verifier validates issuer/subject.
 * No email-based linking, fixture identity selection or public admin bootstrap.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { problem } from './auth.mjs';

export const RESTAURANT_PERMISSIONS = Object.freeze([
  'orders:read', 'orders:update', 'menu:read', 'menu:update', 'stock:read', 'stock:update',
  'delivery:read', 'delivery:assign', 'payments:read', 'payments:collect', 'refunds:manage', 'support:manage',
  'settings:read', 'settings:update', 'channels:manage', 'members:manage',
  'couriers:link', 'courier:read', 'courier:update', 'courier:collect',
]);
const roles = Object.freeze({
  owner: RESTAURANT_PERMISSIONS,
  manager: RESTAURANT_PERMISSIONS.filter(p => p !== 'members:manage' && p !== 'couriers:link' && !p.startsWith('courier:')),
  supervisor: ['orders:read', 'orders:update', 'menu:read', 'stock:read', 'delivery:read', 'delivery:assign'],
  kitchen: ['orders:read', 'orders:update', 'menu:read', 'stock:read'],
  cashier: ['orders:read', 'payments:read', 'payments:collect'],
  courier: ['courier:read','courier:update','courier:collect'],
});
const key = z.string().uuid();
const tenantIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const version = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER - 1);
const memberInput = z.object({ role: z.enum(['owner', 'manager', 'supervisor', 'kitchen', 'cashier', 'courier']),
  permissions: z.array(z.enum(RESTAURANT_PERMISSIONS)).max(RESTAURANT_PERMISSIONS.length).optional(),
  enabled: z.boolean(), expectedVersion: version.nullable(),
  displayName:z.string().trim().max(100).regex(/^[^\x00-\x1f\x7f]*$/).optional(),
}).strict();
function parse(schema, input) {
  const result = schema.safeParse(input);
  if (!result.success) throw problem(400, 'invalid_request');
  return result.data;
}
function safeRow(row) {
  return { principalId: row.principal_id, tenantId: row.tenant_id, role: row.role,
    permissions: row.permissions, enabled: row.enabled, version: Number(row.version), displayName:row.display_name??'',
    ...(row.tenant_status ? { tenantStatus: row.tenant_status } : {}),
    ...(typeof row.tenant_name==='string'?{tenantName:row.tenant_name}:{}) };
}

export function createIdentityDirectory({ pool, trustedIssuers }) {
  if (!pool?.query || !pool?.connect || !Array.isArray(trustedIssuers) || !trustedIssuers.length) throw new Error('identity_configuration_required');
  const issuers = new Set(trustedIssuers.map(value => {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.href !== value) throw new Error('invalid_trusted_issuer');
    return value;
  }));
  async function transaction(operation) {
    const db = await pool.connect();
    try { await db.query('BEGIN'); const result = await operation(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK'); throw error; }
    finally { db.release(); }
  }
  async function audit(db, actor, action, tenantId, target, details={}) {
    await db.query('INSERT INTO platform_identity_audit(actor_id,action,tenant_id,target_id,details) VALUES($1,$2,$3,$4,$5)',
      [actor, action, tenantId, target,JSON.stringify(details)]);
  }
  async function enabledIdentity(db, principalId) {
    parse(key, principalId);
    const { rows } = await db.query('SELECT id,issuer,platform_admin FROM platform_identities WHERE id=$1 AND enabled=TRUE', [principalId]);
    if (!rows[0]) throw problem(403, 'identity_disabled');
    if (!issuers.has(rows[0].issuer)) throw problem(403, 'untrusted_issuer');
    return rows[0];
  }
  async function administrator(db, principalId) {
    if (!(await enabledIdentity(db, principalId)).platform_admin) throw problem(403, 'forbidden');
  }
  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS platform_identities (
        id UUID PRIMARY KEY, issuer TEXT NOT NULL, subject TEXT NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT TRUE, platform_admin BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(issuer,subject)
      );
      CREATE TABLE IF NOT EXISTS platform_tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft','active','suspended','closed')),
        version BIGINT NOT NULL DEFAULT 1 CHECK(version>0), created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS platform_memberships (
        tenant_id TEXT NOT NULL REFERENCES platform_tenants(id),
        principal_id UUID NOT NULL REFERENCES platform_identities(id),
        role TEXT NOT NULL CHECK(role IN ('owner','manager','supervisor','kitchen','cashier','courier')),
        permissions JSONB NOT NULL CHECK(jsonb_typeof(permissions)='array'),
        enabled BOOLEAN NOT NULL DEFAULT TRUE, version BIGINT NOT NULL DEFAULT 1 CHECK(version>0),
        PRIMARY KEY(tenant_id,principal_id)
      );
      ALTER TABLE platform_memberships ADD COLUMN IF NOT EXISTS display_name TEXT NOT NULL DEFAULT '';
      CREATE TABLE IF NOT EXISTS platform_identity_audit (
        id BIGSERIAL PRIMARY KEY, actor_id UUID NOT NULL REFERENCES platform_identities(id),
        action TEXT NOT NULL, tenant_id TEXT REFERENCES platform_tenants(id), target_id UUID REFERENCES platform_identities(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      ALTER TABLE platform_identity_audit ADD COLUMN IF NOT EXISTS details JSONB NOT NULL DEFAULT '{}'::jsonb;
    `);
  }
  async function verifiedIdentity(input) {
    const identity = parse(z.object({ issuer: z.string().max(2048), subject: z.string().min(1).max(255) }).strict(), input);
    if (!issuers.has(identity.issuer)) throw problem(403, 'untrusted_issuer');
    // Existing disabled identities cannot be re-enabled by signing in again.
    const { rows } = await pool.query(`INSERT INTO platform_identities(id,issuer,subject) VALUES($1,$2,$3)
      ON CONFLICT(issuer,subject) DO UPDATE SET subject=EXCLUDED.subject RETURNING id,enabled`,
      [randomUUID(), identity.issuer, identity.subject]);
    if (!rows[0].enabled) throw problem(403, 'identity_disabled');
    return { id: rows[0].id };
  }
  async function resolve(principalId) {
    if (!key.safeParse(principalId).success) return null;
    const { rows } = await pool.query('SELECT id,issuer FROM platform_identities WHERE id=$1 AND enabled=TRUE', [principalId]);
    // Recheck current trust for stored principals, including existing sessions.
    // Retiring an issuer removes authority without deleting identity/history.
    if (!rows[0] || !issuers.has(rows[0].issuer)) return null;
    const memberships = await pool.query(`SELECT m.*,t.status AS tenant_status,t.name AS tenant_name FROM platform_memberships m
      JOIN platform_tenants t ON t.id=m.tenant_id WHERE m.principal_id=$1 AND m.enabled=TRUE AND t.status IN ('active','suspended')
      ORDER BY m.tenant_id`, [principalId]);
    // Staff can also be customers. Staff authority is never inferred from OAuth
    // customer scopes or a role string supplied in a token/request.
    return { id: principalId, role: 'customer', tenantIds: memberships.rows.map(row => row.tenant_id),
      memberships: memberships.rows.map(safeRow) };
  }
  async function createTenant(actorId, input) {
    const tenant = parse(z.object({ id: tenantIdSchema, name: z.string().trim().min(1).max(160), ownerId: key }).strict(), input);
    return transaction(async db => {
      await administrator(db, actorId); await enabledIdentity(db, tenant.ownerId);
      const created = await db.query('INSERT INTO platform_tenants(id,name) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING *', [tenant.id, tenant.name]);
      if (!created.rows[0]) throw problem(409, 'tenant_exists');
      await db.query(`INSERT INTO platform_memberships(tenant_id,principal_id,role,permissions) VALUES($1,$2,'owner',$3)`,
        [tenant.id, tenant.ownerId, JSON.stringify(roles.owner)]);
      await audit(db, actorId, 'tenant_created', tenant.id, tenant.ownerId);
      return { id: tenant.id, name: tenant.name, status: 'draft', version: 1 };
    });
  }
  async function setTenantStatus(actorId, tenantId, input) {
    parse(tenantIdSchema, tenantId);
    const change = parse(z.object({ status: z.enum(['active','suspended','closed']), expectedVersion: version }).strict(), input);
    return transaction(async db => {
      await administrator(db, actorId);
      const { rows } = await db.query('SELECT * FROM platform_tenants WHERE id=$1 FOR UPDATE', [tenantId]);
      if (!rows[0]) throw problem(404, 'tenant_not_found');
      if (Number(rows[0].version) !== change.expectedVersion) throw problem(409, 'version_conflict');
      const allowed = { draft: ['active','closed'], active: ['suspended','closed'], suspended: ['active','closed'], closed: [] };
      if (!allowed[rows[0].status].includes(change.status)) throw problem(409, 'invalid_tenant_transition');
      await db.query('UPDATE platform_tenants SET status=$2,version=version+1 WHERE id=$1', [tenantId, change.status]);
      await audit(db, actorId, 'tenant_' + change.status, tenantId, null);
      return { id: tenantId, status: change.status, version: change.expectedVersion + 1 };
    });
  }
  async function membershipAuthority(db, actorId, tenantId, {allowPlatformAdmin=true}={}) {
    const identity = await enabledIdentity(db, actorId);
    const tenant = await db.query('SELECT status FROM platform_tenants WHERE id=$1 FOR UPDATE', [tenantId]);
    if (!tenant.rows[0]) throw problem(404, 'tenant_not_found');
    if (tenant.rows[0].status === 'closed') throw problem(409, 'tenant_closed');
    if (allowPlatformAdmin && identity.platform_admin) return { role: 'owner', permissions: RESTAURANT_PERMISSIONS };
    if (!allowPlatformAdmin && tenant.rows[0].status !== 'active') throw problem(403, 'tenant_suspended');
    const member = await db.query(`SELECT role,permissions FROM platform_memberships WHERE tenant_id=$1 AND principal_id=$2 AND enabled=TRUE`, [tenantId, actorId]);
    if (!member.rows[0]?.permissions.includes('members:manage')) throw problem(403, 'forbidden');
    return member.rows[0];
  }
  async function setMembership(actorId, tenantId, principalId, input, options={}) {
    parse(tenantIdSchema, tenantId); parse(key, principalId);
    const change = parse(memberInput, input);
    const permissions = [...new Set(change.permissions ?? roles[change.role])].sort();
    if (change.role === 'owner' && (permissions.length !== roles.owner.length || !roles.owner.every(p => permissions.includes(p)))) throw problem(400, 'invalid_owner_permissions');
    return transaction(async db => {
      // Serializing on the tenant also prevents concurrent removal of its last owner.
      const authority = await membershipAuthority(db, actorId, tenantId, options);
      await enabledIdentity(db, principalId);
      const current = await db.query('SELECT * FROM platform_memberships WHERE tenant_id=$1 AND principal_id=$2', [tenantId, principalId]);
      const row = current.rows[0];
      if (authority.role !== 'owner' && (change.role === 'owner' || row?.role === 'owner'
          || permissions.some(permission => !authority.permissions.includes(permission)))) throw problem(403, 'forbidden');
      if ((row ? Number(row.version) : null) !== change.expectedVersion) throw problem(409, 'version_conflict');
      if (row?.role === 'owner' && row.enabled && (change.role !== 'owner' || !change.enabled)) {
        const others = await db.query(`SELECT 1 FROM platform_memberships m JOIN platform_identities i ON i.id=m.principal_id
          WHERE m.tenant_id=$1 AND m.principal_id<>$2 AND m.role='owner' AND m.enabled=TRUE AND i.enabled=TRUE
          AND i.issuer=ANY($3::text[]) LIMIT 1`, [tenantId, principalId, [...issuers]]);
        if (!others.rows.length) throw problem(409, 'last_owner_required');
      }
      // Native mutations carry the originally authenticated session/family.
      // Recheck after tenant-lock and target reads, before changing membership.
      await options.authorizeMutation?.(db);
      const result = await db.query(`INSERT INTO platform_memberships(tenant_id,principal_id,role,permissions,enabled,display_name)
        VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(tenant_id,principal_id) DO UPDATE SET
        role=EXCLUDED.role,permissions=EXCLUDED.permissions,enabled=EXCLUDED.enabled,display_name=EXCLUDED.display_name,version=platform_memberships.version+1 RETURNING *`,
        [tenantId, principalId, change.role, JSON.stringify(permissions), change.enabled,change.displayName??row?.display_name??'']);
      const snapshot=value=>value?{role:value.role,permissions:value.permissions,enabled:value.enabled,version:Number(value.version)}:null;
      await audit(db, actorId, 'membership_changed', tenantId, principalId,{before:snapshot(row),after:snapshot(result.rows[0]),displayNameChanged:(row?.display_name??'')!==result.rows[0].display_name});
      return safeRow(result.rows[0]);
    });
  }
  async function authorize(principalId, tenantId, permission) {
    parse(tenantIdSchema, tenantId);
    if (!RESTAURANT_PERMISSIONS.includes(permission)) throw problem(403, 'forbidden');
    await enabledIdentity(pool, principalId);
    const { rows } = await pool.query(`SELECT m.*,t.status AS tenant_status FROM platform_memberships m JOIN platform_tenants t ON t.id=m.tenant_id
      WHERE m.principal_id=$1 AND m.tenant_id=$2 AND m.enabled=TRUE AND t.status IN ('active','suspended')`, [principalId, tenantId]);
    if (!rows[0]?.permissions.includes(permission)) throw problem(403, 'forbidden');
    // Suspension prevents new business, not completion/refund of existing work.
    // couriers:link is retained for listing/revocation only; courier-service
    // rechecks active status for every nonempty binding and candidates hide grants.
    const settlement = ['orders:read', 'orders:update', 'delivery:read', 'delivery:assign',
      'payments:read', 'payments:collect', 'refunds:manage', 'support:manage','couriers:link','courier:read','courier:update','courier:collect'];
    if (rows[0].tenant_status === 'suspended' && !settlement.includes(permission)) throw problem(403, 'tenant_suspended');
    return safeRow(rows[0]);
  }
  async function published(ids) {
    const validated = parse(z.array(tenantIdSchema).max(1000), ids);
    const { rows } = await pool.query("SELECT id,name FROM platform_tenants WHERE id=ANY($1::text[]) AND status='active' ORDER BY id", [validated]);
    return rows;
  }
  async function members(actorId, tenantId, options={}) {
    parse(tenantIdSchema, tenantId);
    return transaction(async db => {
      await membershipAuthority(db, actorId, tenantId, options);
      const { rows } = await db.query('SELECT * FROM platform_memberships WHERE tenant_id=$1 ORDER BY principal_id', [tenantId]);
      return rows.map(safeRow);
    });
  }
  async function courierCandidates(actorId,tenantId){
    const authority=await authorize(actorId,tenantId,'couriers:link');
    const {rows}=await pool.query(`SELECT m.principal_id,m.display_name,m.enabled AS member_enabled,m.permissions,i.enabled AS identity_enabled FROM platform_memberships m JOIN platform_identities i ON i.id=m.principal_id WHERE m.tenant_id=$1 ORDER BY m.principal_id LIMIT 5000`,[tenantId]);
    return rows.map(row=>({principalId:row.principal_id,displayName:row.display_name??'',eligible:authority.tenantStatus==='active'&&row.member_enabled&&row.identity_enabled&&row.permissions.includes('courier:read')}));
  }
  return { init, verifiedIdentity, resolve, createTenant, setTenantStatus, setMembership, authorize, published, members, courierCandidates };
}
