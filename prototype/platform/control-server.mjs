import {trustedClientAddress} from './request-limits.mjs';
import http from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { createControlPlane } from './control-plane.mjs';

function setting(env,name,required=false){
  if(env[name]&&env[`${name}_FILE`])throw new Error(`Ambiguous ${name}`);
  let value=env[name];
  if(env[`${name}_FILE`]){
    const path=env[`${name}_FILE`],info=statSync(path);
    if(!info.isFile()||info.size>65536)throw new Error(`Invalid ${name} file`);
    value=readFileSync(path,'utf8').trim();
  }
  if(required&&!value)throw new Error(`Missing ${name}`);
  return value;
}
export function controlConfiguration(env=process.env){
  const baseUrl=setting(env,'CORE_PUBLIC_BASE_URL',true),base=new URL(baseUrl);
  if(base.protocol!=='https:'||base.origin!==baseUrl)throw new Error('Invalid CORE_PUBLIC_BASE_URL');
  const routesFile=env.CORE_RESTAURANTS_FILE;
  if(!routesFile||!statSync(routesFile).isFile()||statSync(routesFile).size>128000)throw new Error('CORE_RESTAURANTS_FILE required');
  const restaurants=JSON.parse(readFileSync(routesFile,'utf8'));
  const port=Number(env.PORT??18789),bind=env.BIND_ADDRESS??'127.0.0.1';
  if(!Number.isInteger(port)||port<1024||port>65535||!['127.0.0.1','0.0.0.0','::1'].includes(bind))throw new Error('Invalid listener configuration');
  if(env.CORE_PROVISIONING_READ_ENABLED!==undefined&&!['true','false'].includes(env.CORE_PROVISIONING_READ_ENABLED))throw new Error('Invalid CORE_PROVISIONING_READ_ENABLED');
  if(env.CORE_NATIVE_STAFF_ENABLED!==undefined&&!['true','false'].includes(env.CORE_NATIVE_STAFF_ENABLED))throw new Error('Invalid CORE_NATIVE_STAFF_ENABLED');
  let trustedProxyCidrs=[];
  if(env.CORE_TRUSTED_PROXY_CIDRS!==undefined){
    try{trustedProxyCidrs=JSON.parse(env.CORE_TRUSTED_PROXY_CIDRS);trustedClientAddress(trustedProxyCidrs);}catch{throw new Error('Invalid CORE_TRUSTED_PROXY_CIDRS');}
  }
  return{baseUrl,restaurants,port,bind,trustedProxyCidrs,provisioningReadEnabled:env.CORE_PROVISIONING_READ_ENABLED==='true',nativeStaffEnabled:env.CORE_NATIVE_STAFF_ENABLED==='true',databaseUrl:setting(env,'DATABASE_URL',true),
    csrfKey:setting(env,'CSRF_KEY',true),serviceSigningKey:setting(env,'SERVICE_SIGNING_KEY'),
    eventsEncryptionKey:setting(env,'EVENTS_ENCRYPTION_KEY'),
    redirectAllowlist:(setting(env,'OAUTH_REDIRECT_URIS')??'').split(',').map(value=>value.trim()).filter(Boolean),
    oidc:{issuer:setting(env,'OIDC_ISSUER',true),clientId:setting(env,'OIDC_CLIENT_ID',true),clientSecret:setting(env,'OIDC_CLIENT_SECRET',true)},
  };
}

export async function startControlServer(config){
  const pool=new pg.Pool({connectionString:config.databaseUrl,max:16,connectionTimeoutMillis:5000,query_timeout:15000});
  let app;
  try{app=await createControlPlane({...config,pool});}catch(error){await pool.end();throw error;}
  const server=http.createServer(app.handle);
  server.requestTimeout=15000;server.headersTimeout=10000;
  try{await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(config.port,config.bind,resolve);});}
  catch(error){await app.stopWorkers();await pool.end();throw error;}
  app.startWorkers();
  const close=async()=>{server.closeIdleConnections();await new Promise(resolve=>server.close(resolve));await app.stopWorkers();await pool.end();};
  return{server,app,close};
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{
    const service=await startControlServer(controlConfiguration());
    console.log('Restaurant control plane ready; external acceptance remains separate');
    let stopping=false;
    const stop=async()=>{if(stopping)return;stopping=true;const deadline=setTimeout(()=>process.exit(1),30000);deadline.unref();await service.close();clearTimeout(deadline);};
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
  }catch{console.error('Control plane startup failed; check required configuration, secrets and database connectivity');process.exitCode=1;}
}
