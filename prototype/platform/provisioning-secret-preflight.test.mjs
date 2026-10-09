import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm,chmod,unlink,symlink,link,mkdir}from'node:fs/promises';
import {tmpdir}from'node:os';import{join}from'node:path';import{createHash}from'node:crypto';
import{createProvisioningSecretPreflight}from'./provisioning-secret-preflight.mjs';
const suffixes={administrator:'admin-key',runtime_pg_url:'runtime-pg-url',pg_bootstrap:'pg-bootstrap',runtime_password:'runtime-db-password'};
const rejected=e=>e.code==='provisioning_secret_preflight_rejected'&&!JSON.stringify(e).includes('PRIVATE_VALUE');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'onlinu-secret-metadata-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const tenantId='fixture-a',projectName='onlinu-'+createHash('sha256').update(tenantId).digest('hex').slice(0,32);
 const refs={},owners={};
 for(const [name,suffix]of Object.entries(suffixes)){refs[name]=join(root,projectName+'-'+suffix);owners[name]=process.getuid();await writeFile(refs[name],'PRIVATE_VALUE synthetic only\n',{mode:0o400});}
 return{root,refs,owners,tenantId,check:createProvisioningSecretPreflight({directory:root,expectedOwners:owners}).check};
}
test('metadata-only secret preflight is read-only and returns no bytes or host paths',async t=>{
 const f=await fixture(t),before=await readFile(f.refs.administrator);
 const result=await f.check({tenantId:f.tenantId,refs:f.refs});
 assert.ok(Object.isFrozen(result)&&Object.isFrozen(result.checkedReferences));assert.equal(result.checkedReferences.length,4);
 assert.ok(!JSON.stringify(result).includes('PRIVATE_VALUE'));assert.ok(!JSON.stringify(result).includes(f.root));
 assert.deepEqual(await readFile(f.refs.administrator),before);
});
test('secret preflight refuses unknown missing cross-tenant or traversing references',async t=>{
 const f=await fixture(t);
 for(const refs of [{...f.refs,extra:f.refs.administrator},{...f.refs,administrator:'/other/secret'},Object.fromEntries(Object.entries(f.refs).slice(1)),{...f.refs,administrator:join(f.root,'..','other')}])
  await assert.rejects(f.check({tenantId:f.tenantId,refs}),rejected);
 await assert.rejects(f.check({tenantId:'neighbor',refs:f.refs}),rejected);
});
test('secret preflight refuses permissive modes, wrong owner, empty and oversized files without repair',async t=>{
 for(const kind of ['mode','owner','empty','oversize']){
  const f=await fixture(t);let check=f.check;
  if(kind==='mode')await chmod(f.refs.administrator,0o444);
  if(kind==='owner')check=createProvisioningSecretPreflight({directory:f.root,expectedOwners:{...f.owners,administrator:process.getuid()+1}}).check;
  if(['empty','oversize'].includes(kind)){await chmod(f.refs.administrator,0o600);await writeFile(f.refs.administrator,kind==='empty'?'':'x'.repeat(65537));}
  await assert.rejects(check({tenantId:f.tenantId,refs:f.refs}),rejected);
 }
});
test('secret preflight rejects symlinks hardlinks and directories without opening secret bytes',async t=>{
 for(const kind of ['symlink','hardlink','directory']){
  const f=await fixture(t),path=f.refs.administrator;
  if(kind==='hardlink')await link(path,join(f.root,'alias'));
  else{await unlink(path);if(kind==='symlink')await symlink(f.refs.runtime_pg_url,path);else await mkdir(path);}
  await assert.rejects(f.check({tenantId:f.tenantId,refs:f.refs}),rejected);
 }
});
test('secret preflight rejects unsafe root and snapshots configured owners',async t=>{
 const f=await fixture(t),factory=createProvisioningSecretPreflight({directory:f.root,expectedOwners:f.owners});
 f.owners.administrator++;
 await factory.check({tenantId:f.tenantId,refs:f.refs});
 await chmod(f.root,0o755);await assert.rejects(factory.check({tenantId:f.tenantId,refs:f.refs}),rejected);
 for(const directory of ['relative','/bad\0path'])assert.throws(()=>createProvisioningSecretPreflight({directory,expectedOwners:f.owners}),/configuration/);
});
