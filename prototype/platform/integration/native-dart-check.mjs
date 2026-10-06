import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,isAbsolute,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
const run=promisify(execFile);

// Isolated fixture only: no production hostname, global trust-store changes,
// certificate-warning bypass, external account, or actual browser login.
export async function checkNativeDart({app,browserCookie,principalId,orderNumber,imageBase64,courier=false,courierId,refund=false,refundId,support=false}){
 const flutter=process.env.CORE_FLUTTER_TEST_BIN;
 assert.ok(flutter&&isAbsolute(flutter)&&basename(flutter)==='flutter','An absolute official Flutter executable is required');
 const root=await mkdtemp(join(tmpdir(),'onlinu-native-tls-')),key=join(root,'key.pem'),cert=join(root,'cert.pem');
 let server;const peers=new Set();
 try{
  await run('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=platform.example','-addext','subjectAltName=DNS:platform.example'],{timeout:15000,maxBuffer:1024*1024});
  server=createServer({key:await readFile(key),cert:await readFile(cert),minVersion:'TLSv1.2'},(req,res)=>{peers.add(req.socket.remoteAddress);return app.handle(req,res);});
  server.on('tlsClientError',()=>{}); // The test deliberately rejects a wrong hostname.
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const {stdout}=await run(flutter,['--suppress-analytics','test','--no-pub',support?'integration_http/support_live_http_test.dart':refund?'integration_http/refund_live_http_test.dart':courier?'integration_http/courier_live_http_test.dart':'integration_http/core_live_http_test.dart','--reporter','expanded'],{
   cwd:fileURLToPath(new URL('../../admin_flutter/',import.meta.url)),timeout:60000,maxBuffer:4*1024*1024,
   env:{...process.env,CI:'true',BOT:'true',FLUTTER_SUPPRESS_ANALYTICS:'true',CORE_NATIVE_LIVE_TEST:'1',CORE_NATIVE_TLS_PORT:String(server.address().port),CORE_NATIVE_CERT_FILE:cert,CORE_NATIVE_BROWSER_COOKIE:browserCookie,CORE_NATIVE_PRINCIPAL:principalId,CORE_NATIVE_ORDER:orderNumber,CORE_NATIVE_IMAGE:imageBase64??'',CORE_NATIVE_COURIER:courierId??'',CORE_NATIVE_REFUND:refundId??''},
  });
  assert.match(stdout,/All tests passed!/);
  assert.deepEqual([...peers],['127.0.0.2'],'The synthetic native device must use its isolated loopback client identity, without weakening rate limits');
  console.log(support?'Verified actual Dart support queue, reviewed cancellation, separate finance read and complaint resolution through pinned TLS, Node and original Go; no payout authority':refund?'Verified actual Dart reviewed existing-refund authorization and same-ID recovery through pinned TLS, Node and original Go; synthetic ledger only':courier?'Verified actual Dart owned-courier delivery, separate cash confirmation and availability through strict fixture TLS, Node and original Go': 'Verified actual Dart PKCE/broker consent, strict fixture TLS, staff reads/versioned writes, rotating refresh and replay revocation against Node and the original Go core; OIDC identity and browser consent are seeded test fixtures');
 }finally{
  if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  await rm(root,{recursive:true,force:true});
 }
}
