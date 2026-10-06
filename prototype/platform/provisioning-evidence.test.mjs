import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, lstat, chmod, rm, rmdir, symlink, link, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createProvisioningEvidence } from './provisioning-evidence.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const now=()=>new Date('2026-10-06T14:00:00.000Z');
function report(){return{
 jobId:randomUUID(),workerId:randomUUID(),tenantId:'fixture-a',planDigest:'a'.repeat(64),
 projectName:'onlinu-'+digest('fixture-a').slice(0,32),sourceCommit:'b'.repeat(40),scope:'fixture',
 resources:{restaurant:{containerId:'c'.repeat(64),imageId:'sha256:'+'d'.repeat(64)},postgres:{containerId:'e'.repeat(64),imageId:'sha256:'+'f'.repeat(64)}},
 checks:{ownership:true,healthy:true,authenticated:true,unauthorizedRejected:true},
};}
async function fixture(t){
 const directory=await mkdtemp(join(tmpdir(),'onlinu-evidence-test-'));await chmod(directory,0o700);
 t.after(()=>rm(directory,{recursive:true,force:true}));
 return{directory,store:createProvisioningEvidence({directory,now})};
}
function filePath(directory,ref){return join(directory,'onlinu-'+digest(ref.tenantId).slice(0,32),`${ref.jobId}-${ref.workerId}-${ref.sha256}.json`);}

test('private evidence is durable, content-addressed, immutable and idempotent only for identical bytes',async t=>{
 const {directory,store}=await fixture(t),input=report();
 const ref=await store.write(input),path=filePath(directory,ref),bytes=await readFile(path),saved=await store.read(ref);
 assert.equal(digest(bytes),ref.sha256);assert.equal((await lstat(path)).mode&0o777,0o600);
 assert.deepEqual(saved,{schemaVersion:1,observedAt:now().toISOString(),report:input});
 assert.equal(Object.isFrozen(saved.report.resources.restaurant),true);assert.equal(Object.isFrozen(ref),true);
 const first=(await lstat(path)).ino;assert.deepEqual(await store.write(input),ref);assert.equal((await lstat(path)).ino,first);
 const later=createProvisioningEvidence({directory,now:()=>new Date('2026-10-06T14:01:00Z')});
 const next=await later.write(input);assert.notEqual(next.sha256,ref.sha256);assert.equal((await readdir(join(directory,input.projectName))).length,2);
});

test('evidence write snapshots caller data before async work',async t=>{
 const {store}=await fixture(t),input=report(),expected=structuredClone(input);
 const pending=store.write(input);input.tenantId='other';input.resources.restaurant.containerId='0'.repeat(64);
 const ref=await pending;assert.deepEqual((await store.read(ref)).report,expected);
});

test('invalid, unbound and arbitrary secret-bearing reports fail before files are created',async t=>{
 const {directory,store}=await fixture(t);
 const mutations=[
  v=>({...v,secret:'do-not-store'}),v=>({...v,tenantId:'../other'}),v=>({...v,jobId:'not-a-job'}),
  v=>({...v,workerId:undefined}),v=>({...v,projectName:'onlinu-'+'0'.repeat(32)}),
  v=>({...v,sourceCommit:'not-a-commit'}),v=>({...v,scope:'production-ready'}),
  v=>({...v,resources:{...v.resources,other:v.resources.restaurant}}),
  v=>({...v,resources:{...v.resources,restaurant:{...v.resources.restaurant,environment:['SECRET=x']}}}),
  v=>({...v,resources:{...v.resources,postgres:{...v.resources.postgres,containerId:v.resources.restaurant.containerId}}}),
  v=>({...v,checks:{...v.checks,healthy:false}}),v=>({...v,checks:{ownership:true}}),
 ];
 for(const mutate of mutations)await assert.rejects(store.write(mutate(report())),{code:'provisioning_evidence_rejected'});
 assert.deepEqual(await readdir(directory),[]);
});

test('read binds receipt metadata and rejects malformed references and content corruption',async t=>{
 const {directory,store}=await fixture(t),ref=await store.write(report());
 for(const value of [{...ref,extra:true},{...ref,tenantId:'other'},{...ref,jobId:randomUUID()},{...ref,workerId:randomUUID()},{...ref,planDigest:'0'.repeat(64)},{...ref,sha256:'../escape'}])await assert.rejects(store.read(value),{code:'provisioning_evidence_rejected'});
 await writeFile(filePath(directory,ref),'broken');
 await assert.rejects(store.read(ref),{code:'provisioning_evidence_rejected'});
});

test('evidence rejects symlink, hardlink and public file substitutions without overwriting',async t=>{
 for(const kind of ['symlink','hardlink','public'])await t.test(kind,async t=>{
  const {directory,store}=await fixture(t),input=report(),ref=await store.write(input),path=filePath(directory,ref);
  const contents=await readFile(path),outside=join(directory,'fixture-source');
  await writeFile(outside,contents,{mode:0o600});await rm(path);
  if(kind==='symlink')await symlink(outside,path);
  if(kind==='hardlink')await link(outside,path);
  if(kind==='public')await writeFile(path,contents,{mode:0o644});
  await assert.rejects(store.read(ref),{code:'provisioning_evidence_rejected'});
  await assert.rejects(store.write(input),{code:'provisioning_evidence_rejected'});
  assert.deepEqual(await readFile(outside),contents);
 });
});

test('unsafe directories and incorrect owner fail closed with sanitized errors',async t=>{
 const {directory,store}=await fixture(t),input=report();
 await mkdir(join(directory,input.projectName),{mode:0o755});
 await assert.rejects(store.write(input),e=>e.code==='provisioning_evidence_rejected'&&!e.message.includes(directory));
 await rmdir(join(directory,input.projectName));await symlink(directory,join(directory,input.projectName));
 await assert.rejects(store.write(input),{code:'provisioning_evidence_rejected'});
 await rm(join(directory,input.projectName));
 const wrongOwner=createProvisioningEvidence({directory,ownerUID:process.getuid()+1,now});
 await assert.rejects(wrongOwner.write(input),{code:'provisioning_evidence_rejected'});
 await chmod(directory,0o755);await assert.rejects(store.write(input),{code:'provisioning_evidence_rejected'});
});

test('oversized and noncanonical evidence cannot be adopted even with matching digest',async t=>{
 const {directory,store}=await fixture(t),input=report(),ref=await store.write(input),original=await readFile(filePath(directory,ref),'utf8');
 for(const bytes of [' '.repeat(16385),original.replace('"schemaVersion":1','"schemaVersion":1,"schemaVersion":1')]){
  const altered={...ref,sha256:digest(bytes)};await writeFile(filePath(directory,altered),bytes,{mode:0o600});
  await assert.rejects(store.read(altered),{code:'provisioning_evidence_rejected'});
 }
});
