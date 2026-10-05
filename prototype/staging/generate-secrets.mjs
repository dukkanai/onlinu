#!/usr/bin/env node
// One-shot generation. Never writes secrets into the repository or stdout.
import { randomBytes } from 'node:crypto';
import { mkdir, chmod, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import bcrypt from '../platform/node_modules/bcryptjs/index.js';

const directory = '/home/chatbot/.local/share/almujeeb-staging';
const origin = 'https://almujeeb.info';
const random = () => randomBytes(32).toString('base64url');
process.umask(0o077);

async function generate() {
  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  // Fails even for an empty existing directory: never silently rotate secrets
  // for existing database volumes or replace an operator's existing files.
  await mkdir(directory, { mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_secret_directory');
  await chmod(directory, 0o700);

  const files = new Map();
  const databases = [
    ['platform', 'staging_platform', 'staging_platform_app', 'platform-db'],
    ['tenant-a', 'staging_restaurant_a', 'staging_restaurant_a_app', 'tenant-a-db'],
    ['tenant-b', 'staging_restaurant_b', 'staging_restaurant_b_app', 'tenant-b-db'],
    ['identity', 'staging_identity', 'staging_identity_app', 'identity-db'],
  ];
  let identityPassword;
  for (const [name, database, role, host] of databases) {
    const applicationPassword = random();
    files.set(`${name}-bootstrap-password`, random());
    files.set(`${name}-app-password`, applicationPassword);
    if (name === 'identity') identityPassword = applicationPassword;
    else files.set(`${name}-database-url`, `postgres://${role}:${applicationPassword}@${host}:5432/${database}?sslmode=disable`);
  }

  const clientSecret = random();
  files.set('oidc-client-secret', clientSecret);
  files.set('tenant-a-token', random());
  files.set('tenant-b-token', random());
  files.set('events-encryption-key', randomBytes(32).toString('base64'));
  files.set('session-csrf-key', randomBytes(32).toString('base64'));

  const identities = [
    ['customer-alice', '20114f28-04b3-4101-b7ea-f26f2a977e8a'],
    ['customer-bob', '5774d8a1-e6d0-4d1b-b061-9b576d7fb7f0'],
    ['merchant-a', '12a5b6d3-0322-47b1-a3b6-33fd9a2f29b1'],
    ['merchant-b', '9988c850-64b5-4210-a974-c0b797029d64'],
  ];
  const testers = [];
  const staticPasswords = [];
  const identityMap = {};
  for (const [identity, userID] of identities) {
    const email = `${identity}@staging.invalid`;
    const password = random();
    testers.push({ identity, email, password });
    identityMap[email] = identity;
    staticPasswords.push({ email, hash: await bcrypt.hash(password, 12), username: identity, userID, emailVerified: true });
  }

  const dexConfig = {
    issuer: `${origin}/identity`,
    storage: { type: 'postgres', config: {
      host: 'identity-db', port: 5432, database: 'staging_identity',
      user: 'staging_identity_app', password: identityPassword,
      ssl: { mode: 'disable' }, maxOpenConns: 5, maxIdleConns: 2,
    } },
    web: { http: '0.0.0.0:5556' },
    logger: { level: 'error', format: 'json' },
    oauth2: { grantTypes: ['authorization_code'], responseTypes: ['code'], skipApprovalScreen: false },
    expiry: { idTokens: '10m', authRequests: '5m' },
    enablePasswordDB: true,
    staticClients: [{ id: 'restaurant-staging-web', name: 'Almujeeb Staging',
      redirectURIs: [`${origin}/auth/callback`], secret: clientSecret }],
    staticPasswords,
  };
  files.set('oidc-identity-map.json', JSON.stringify(identityMap, null, 2));
  // JSON is valid YAML and avoids interpolating values into hand-written YAML.
  files.set('dex-config.yaml', JSON.stringify(dexConfig, null, 2));
  files.set('testers.json', JSON.stringify({ loginUrl: `${origin}/auth/login`, syntheticOnly: true, testers }, null, 2));

  for (const [name, value] of files) {
    const target = path.join(directory, name);
    await writeFile(target, `${value}\n`, { flag: 'wx', mode: 0o600 });
    // Compose uses read-only bind mounts for secrets. Non-root application
    // users need read permission; the private 0700 parent protects host access.
    await chmod(target, name === 'testers.json' ? 0o600 : 0o444);
  }
  console.log(directory);
}

generate().catch(error => {
  const code = error?.code === 'EEXIST' ? 'secret_directory_already_exists' : 'secret_generation_failed';
  console.error(`${code}: ${directory}`);
  process.exitCode = 1;
});
