import {z} from 'zod';
import {problem} from './auth.mjs';
const id=z.string().regex(/^[a-f0-9]{32}$/),version=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER-1);
const linkInput=z.object({expectedVersion:version,principalId:z.union([z.string().uuid(),z.literal('')])}).strict();
function parse(schema,input){const value=schema.safeParse(input);if(!value.success)throw problem(400,'invalid_request');return value.data;}
export function createCourierService({directory,orderClient}){
 const candidateMap=(tenant,candidates)=>new Map(candidates.map(v=>[orderClient.principalRef(tenant,v.principalId),v]));
 const mapped=(row,targets)=>{
  const target=row.ownerRef===null?null:targets.get(row.ownerRef);
  return {id:row.id,name:row.name,active:row.active,availability:row.availability,version:row.version,activeOrders:row.activeOrders,bound:row.ownerRef!==null,principalId:target?.principalId??null,principalName:target?.displayName??'',eligible:target?.eligible??false};
 };
 return {
  async links(actor,tenant){
   const candidates=await directory.courierCandidates(actor,tenant),data=await orderClient.courierLinks(tenant,actor);
   await directory.authorize(actor,tenant,'couriers:link');
   const targets=candidateMap(tenant,candidates);
   return {tenantId:tenant,limit:500,links:data.links.map(row=>mapped(row,targets)),candidates:candidates.filter(v=>v.eligible).map(v=>({principalId:v.principalId,displayName:v.displayName}))};
  },
  async setLink(actor,tenant,courier,input){
   parse(id,courier);const value=parse(linkInput,input),candidates=await directory.courierCandidates(actor,tenant);
   if(value.principalId&&!candidates.some(v=>v.principalId===value.principalId&&v.eligible))throw problem(403,'forbidden');
   const ownerRef=value.principalId?orderClient.principalRef(tenant,value.principalId):'';
   const authority=await directory.authorize(actor,tenant,'couriers:link');
   if(value.principalId&&authority.tenantStatus!=='active')throw problem(403,'tenant_suspended');
   const saved=await orderClient.setCourierLink(tenant,actor,courier,{expectedVersion:value.expectedVersion,ownerRef});
   if(saved.id!==courier||saved.version!==value.expectedVersion+1||saved.ownerRef!==(ownerRef||null))throw problem(503,'order_outcome_unknown');
   return {tenantId:tenant,link:mapped(saved,candidateMap(tenant,candidates))};
  },
  async work(actor,tenant){await directory.authorize(actor,tenant,'courier:read');return orderClient.courierWork(tenant,actor);},
  async detail(actor,tenant,number){await directory.authorize(actor,tenant,'courier:read');return orderClient.courierDetail(tenant,actor,number);},
  async change(actor,tenant,number,action,input){
   await directory.authorize(actor,tenant,'courier:read');await directory.authorize(actor,tenant,action==='cash'?'courier:collect':'courier:update');
   return orderClient.courierChange(tenant,actor,number,action,input);
  },
  async availability(actor,tenant,input){await directory.authorize(actor,tenant,'courier:read');await directory.authorize(actor,tenant,'courier:update');return orderClient.courierAvailability(tenant,actor,input);},
 };
}
export function createCourierApi({directory,orderClient,body,json}){
 const service=createCourierService({directory,orderClient});
 return async(req,res,who,url)=>{
  if(url.search)throw problem(400,'invalid_request');
  const links=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/courier-links(?:\/([a-f0-9]{32}))?$/.exec(url.pathname);
  if(links){const [,tenant,courier]=links;if(req.method==='GET'&&!courier)return json(res,200,await service.links(who.id,tenant));if(req.method==='POST'&&courier){const input=await body(req);return json(res,200,await service.setLink(who.id,tenant,courier,input));}}
  const own=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/courier-work(?:\/(availability|orders)(?:\/(R[0-9]{8,20})(?:\/(status|cash))?)?)?$/.exec(url.pathname);
  if(own){const [,tenant,section,number,action]=own;if(req.method==='GET'&&!section)return json(res,200,await service.work(who.id,tenant));if(req.method==='GET'&&section==='orders'&&number&&!action)return json(res,200,await service.detail(who.id,tenant,number));if(req.method==='POST'&&section==='orders'&&number&&action){const input=await body(req);return json(res,200,await service.change(who.id,tenant,number,action,input));}if(req.method==='POST'&&section==='availability'&&!number){const input=await body(req);return json(res,200,await service.availability(who.id,tenant,input));}}
  throw problem(404,'not_found');
 };
}
