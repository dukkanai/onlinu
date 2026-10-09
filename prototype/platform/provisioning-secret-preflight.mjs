/** Metadata-only check of already-approved file-backed secret references.
 * Reads no secret bytes, changes no ownership/permissions and creates no keys.
 * The trusted caller owns authority, host exclusion and container UID policy.
 */
import { lstat, realpath } from 'node:fs/promises';
import { isAbsolute, resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { problem } from './auth.mjs';
const suffixes = { administrator: 'admin-key', runtime_pg_url: 'runtime-pg-url',
  pg_bootstrap: 'pg-bootstrap', runtime_password: 'runtime-db-password' };
const names = Object.keys(suffixes);
const fail = () => { throw problem(409, 'provisioning_secret_preflight_rejected'); };
const uid = v => Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const sameStat = (a,b) => ['dev','ino','uid','gid','mode','nlink','size','mtimeMs','ctimeMs'].every(k=>a[k]===b[k]);
export function createProvisioningSecretPreflight({ directory, expectedOwners, ownerUID = process.getuid?.() }) {
  if (process.platform !== 'linux' || typeof directory !== 'string' || !isAbsolute(directory) || directory.includes('\0')
      || directory.length > 3800 || !uid(ownerUID) || !expectedOwners
      || Object.keys(expectedOwners).sort().join(',') !== [...names].sort().join(',') || !Object.values(expectedOwners).every(uid))
    throw new Error('invalid_provisioning_secret_preflight_configuration');
  const root=resolve(directory),owners=Object.freeze({...expectedOwners});
  async function check(input) {
    try {
      if(!input||Object.keys(input).sort().join(',')!=='refs,tenantId')fail();
      const {tenantId,refs}=structuredClone(input);
      if (typeof tenantId!=='string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(tenantId)
          || !refs || Object.keys(refs).sort().join(',')!==[...names].sort().join(',')) fail();
      const projectName='onlinu-'+createHash('sha256').update(tenantId).digest('hex').slice(0,32);
      const paths=Object.fromEntries(names.map(name=>[name,join(root,projectName+'-'+suffixes[name])]));
      if(names.some(name=>refs[name]!==paths[name]))fail();
      const beforeRoot=await lstat(root);
      if(!beforeRoot.isDirectory()||beforeRoot.isSymbolicLink()||beforeRoot.uid!==ownerUID
          ||(beforeRoot.mode&0o077)!==0||await realpath(root)!==root)fail();
      const observed={};
      for(const name of names){
        const info=await lstat(paths[name]);
        if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.uid!==owners[name]
            ||![0o400,0o600].includes(info.mode&0o7777)||info.size<1||info.size>65536)fail();
        observed[name]=info;
      }
      // Detect changes across the observation window without opening file bytes.
      for(const name of names)if(!sameStat(observed[name],await lstat(paths[name])))fail();
      if(!sameStat(beforeRoot,await lstat(root)))fail();
      return Object.freeze({tenantId,projectName,checkedReferences:Object.freeze([...names])});
    } catch { fail(); }
  }
  return Object.freeze({check});
}
