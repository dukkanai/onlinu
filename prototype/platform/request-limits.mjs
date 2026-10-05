import {BlockList,isIP} from 'node:net';
import {problem} from './auth.mjs';

// IP addresses are only a rate-limit key, never an identity or permission.
// No implicit trust for loopback, RFC1918, Forwarded, X-Real-IP or host headers.
function canonicalAddress(raw){
 if(typeof raw!=='string'||raw.length>64||raw.includes('%')||!isIP(raw))return null;
 if(isIP(raw)===4)return raw;
 const value=new URL(`http://[${raw}]/`).hostname.slice(1,-1);
 const mapped=/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
 if(!mapped)return value;
 const hi=parseInt(mapped[1],16),lo=parseInt(mapped[2],16);
 return `${hi>>>8}.${hi&255}.${lo>>>8}.${lo&255}`;
}
export function trustedClientAddress(trustedProxyCidrs=[]){
 if(!Array.isArray(trustedProxyCidrs)||trustedProxyCidrs.length>32)throw new Error('invalid_trusted_proxy_configuration');
 const trusted=new BlockList();
 for(const cidr of trustedProxyCidrs){
  if(typeof cidr!=='string'||cidr.length>80)throw new Error('invalid_trusted_proxy_configuration');
  const [address,prefix,...extra]=cidr.split('/'),family=isIP(address);
  if(extra.length||!family||address.includes('%')||!/^\d{1,3}$/.test(prefix??''))throw new Error('invalid_trusted_proxy_configuration');
  const bits=Number(prefix);
  // Trust-everything configuration defeats the proxy boundary and is forbidden.
  if(bits<1||bits>(family===4?32:128))throw new Error('invalid_trusted_proxy_configuration');
  trusted.addSubnet(address,bits,family===4?'ipv4':'ipv6');
 }
 const isTrusted=address=>trusted.check(address,isIP(address)===4?'ipv4':'ipv6');
 return req=>{
  let current=canonicalAddress(req.socket?.remoteAddress);
  if(!current)throw problem(400,'invalid_client_address');
  if(!isTrusted(current))return current;
  const forwarded=req.headers['x-forwarded-for'];
  if(forwarded===undefined)return current;
  if(typeof forwarded!=='string'||forwarded.length>2048)throw problem(400,'invalid_forwarded_address');
  const chain=forwarded.split(',');
  if(chain.length>16)throw problem(400,'invalid_forwarded_address');
  // Walk from the actual socket towards the client, stopping at the FIRST
  // untrusted hop. Arbitrary left-hand values supplied by that client do not
  // influence the key. Every trusted proxy must append/overwrite correctly.
  for(let index=chain.length-1;index>=0&&isTrusted(current);index--){
   const next=canonicalAddress(chain[index].trim());
   if(!next)throw problem(400,'invalid_forwarded_address');
   current=next;
  }
  return current;
 };
}
export function createRequestLimiter({trustedProxyCidrs=[],now=Date.now,limit=240,windowMs=60000,maxKeys=10000}={}){
 if(!Number.isInteger(limit)||limit<1||!Number.isInteger(windowMs)||windowMs<1||!Number.isInteger(maxKeys)||maxKeys<1)throw new Error('invalid_rate_configuration');
 const address=trustedClientAddress(trustedProxyCidrs),rows=new Map();let nextSweep=0;
 return req=>{
  const time=now(),key=address(req);
  // Once per second, not an O(n) scan on every request at high cardinality.
  if(time>=nextSweep){for(const [key,row] of rows)if(row.until<=time)rows.delete(key);nextSweep=time+1000;}
  let row=rows.get(key);
  if(row&&row.until<=time){rows.delete(key);row=undefined;}
  if(!row){
   if(rows.size>=maxKeys)throw Object.assign(problem(429,'rate_limited'),{retryAfter:1});
   row={until:time+windowMs,count:0};rows.set(key,row);
  }
  if(++row.count>limit)throw Object.assign(problem(429,'rate_limited'),{retryAfter:Math.max(1,Math.ceil((row.until-time)/1000))});
 };
}
