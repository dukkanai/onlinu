import {z} from 'zod';
import {problem} from './auth.mjs';
import {coreOpeningStatusSchema} from './core-adapter.mjs';
const id=z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export const openSearchInput=z.object({query:z.string().max(100).optional(),cuisine:z.string().max(60).optional(),after:id.optional(),limit:z.number().int().min(1).max(20).optional()}).strict();
export const openSearchOutput=z.object({restaurants:z.array(z.object({id,name:z.string().max(4096),cuisine:z.string().max(4096),opening:coreOpeningStatusSchema})).max(20),checked:z.number().int().min(0).max(20),closed:z.number().int().min(0).max(20),unconfigured:z.number().int().min(0).max(20),unavailable:z.number().int().min(0).max(20),nextAfter:id.nullable(),hasMore:z.boolean(),evaluatedAt:z.string().datetime({offset:true})}).strict();

// Explicit candidate pagination, never a whole-directory scan or guessed status.
// At most two searches and five core reads per search can be active per process.
export function createOpenRestaurantSearch({listRestaurants,openingStatus,now=Date.now}){
 let active=0;
 return async input=>{
  const parsed=openSearchInput.safeParse(input);if(!parsed.success)throw problem(400,'invalid_request');
  if(active>=2)throw problem(429,'rate_limited');active++;
  try{
   const {query,cuisine,after,limit=20}=parsed.data;
   const candidates=(await listRestaurants({query,cuisine})).filter(row=>!after||row.id>after).toSorted((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
   const page=candidates.slice(0,limit),results=new Array(page.length);let index=0;
   await Promise.all(Array.from({length:Math.min(5,page.length)},async()=>{
    for(;;){const slot=index++;if(slot>=page.length)return;const row=page[slot];
     try{
      const response=await openingStatus(row.id),{tenantId,...raw}=response;
      const state=coreOpeningStatusSchema.safeParse(raw),age=now()-Date.parse(raw.evaluatedAt);
      if(tenantId!==row.id||!state.success||!Number.isFinite(age)||age < -30000||age > 60000)throw Error('unverified_status');
      results[slot]=!state.data.scheduleEnabled?{kind:'unconfigured'}:state.data.withinHours&&state.data.acceptingOrders?{kind:'open',value:{id:row.id,name:row.name,cuisine:row.cuisine,opening:state.data}}:{kind:'closed'};
     }catch{results[slot]={kind:'unavailable'};}
    }
   }));
   return {restaurants:results.filter(v=>v.kind==='open').map(v=>v.value),checked:page.length,closed:results.filter(v=>v.kind==='closed').length,unconfigured:results.filter(v=>v.kind==='unconfigured').length,unavailable:results.filter(v=>v.kind==='unavailable').length,nextAfter:candidates.length>page.length?page.at(-1).id:null,hasMore:candidates.length>page.length,evaluatedAt:new Date(now()).toISOString()};
  }finally{active--;}
 };
}
