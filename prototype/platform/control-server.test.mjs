import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {join} from 'node:path';
import {controlConfiguration} from './control-server.mjs';

test('control deployment configuration fails closed and supports secret files',async t=>{
  const root=await mkdtemp(join(tmpdir(),'onlinu-control-test-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const routes=join(root,'routes.json'),secret=join(root,'oidc-secret');
  await writeFile(routes,'[]');await writeFile(secret,'synthetic-parser-secret',{mode:0o600});
  const env={CORE_PUBLIC_BASE_URL:'https://platform.example',CORE_RESTAURANTS_FILE:routes,
    DATABASE_URL:'postgres://fixture@127.0.0.1/disposable',CSRF_KEY:Buffer.alloc(32).toString('base64'),
    OIDC_ISSUER:'https://identity.example/',OIDC_CLIENT_ID:'test',OIDC_CLIENT_SECRET_FILE:secret};
  const config=controlConfiguration(env);assert.equal(config.oidc.clientSecret,'synthetic-parser-secret');
  assert.equal(config.bind,'127.0.0.1');assert.equal(config.port,18789);assert.deepEqual(config.restaurants,[]);
  assert.equal(config.serviceSigningKey,undefined);assert.equal(config.nativeStaffEnabled,false);assert.equal(controlConfiguration({...env,CORE_NATIVE_STAFF_ENABLED:'true'}).nativeStaffEnabled,true);
  for(const change of [{CORE_PUBLIC_BASE_URL:'http://platform.example'},{CORE_PUBLIC_BASE_URL:'https://platform.example/path'},
    {OIDC_CLIENT_SECRET:'ambiguous'},{DATABASE_URL:''},{PORT:'80'},{BIND_ADDRESS:'arbitrary-name'},{CORE_NATIVE_STAFF_ENABLED:'yes'}])assert.throws(()=>controlConfiguration({...env,...change}));
});
