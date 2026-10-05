import { problem } from './auth.mjs';

/** Durable cursor ingestion. Callback delivery retains the existing signed,
 * SSRF-protected, owner-authorized Events service. No timer starts implicitly.
 */
export function createCoreEventWorker({ pool, orderClient, events, resolvePrincipal }) {
  let running=false,lastOwner='',lastTenant='';
  const health={lastSuccessAt:null,consecutiveFailures:0};
  async function init(){
    await pool.query(`CREATE TABLE IF NOT EXISTS platform_core_event_cursors (
      owner_id UUID NOT NULL REFERENCES platform_identities(id),tenant_id TEXT NOT NULL REFERENCES platform_tenants(id),
      sequence BIGINT NOT NULL DEFAULT 0 CHECK(sequence>=0 AND sequence<=9007199254740991),PRIMARY KEY(owner_id,tenant_id)
    )`);
  }
  async function ingest(ownerId,tenantId){
    const identity=await resolvePrincipal(ownerId);
    if(!identity){await events.revokeAll(ownerId);return;}
    await pool.query('INSERT INTO platform_core_event_cursors(owner_id,tenant_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[ownerId,tenantId]);
    const current=(await pool.query('SELECT sequence FROM platform_core_event_cursors WHERE owner_id=$1 AND tenant_id=$2',[ownerId,tenantId])).rows[0];
    const after=Number(current.sequence);
    if(!Number.isSafeInteger(after))throw problem(503,'invalid_event_cursor');
    const page=await orderClient.events(tenantId,ownerId,after,100);
    let cursor=after;
    for(const event of page.events){
      if(!Number.isSafeInteger(event.sequence)||event.sequence<=cursor)throw problem(503,'invalid_event_cursor');
      const order=event.order;
      await events.enqueue({eventId:`core_${tenantId}_${ownerId}_${event.sequence}`,ownerId,tenantId,
        orderId:order.number,status:order.status,paymentStatus:order.paymentStatus,version:order.version,occurredAt:order.updatedAt});
      // Commit delivery BEFORE advancing. Repeating after a crash is deduped by
      // the stable event ID; GREATEST prevents concurrent workers regressing it.
      await pool.query('UPDATE platform_core_event_cursors SET sequence=GREATEST(sequence,$3) WHERE owner_id=$1 AND tenant_id=$2',[ownerId,tenantId,event.sequence]);
      cursor=event.sequence;
    }
  }
  async function tick(){
    if(running)return;running=true;
    try{
      const {rows}=await pool.query(`SELECT DISTINCT owner_id,arguments->>'tenantId' AS tenant_id FROM event_subscriptions
        WHERE active AND expires_at>now() AND (owner_id,arguments->>'tenantId')>($1,$2)
        ORDER BY owner_id,tenant_id LIMIT 100`,[lastOwner,lastTenant]);
      // Fair keyset rotation instead of permanently selecting the first 100.
      if(rows.length===100){lastOwner=rows.at(-1).owner_id;lastTenant=rows.at(-1).tenant_id;}else{lastOwner='';lastTenant='';}
      let failed=false;
      for(let index=0;index<rows.length;index+=4){
        const results=await Promise.allSettled(rows.slice(index,index+4).map(row=>ingest(row.owner_id,row.tenant_id)));
        if(results.some(result=>result.status==='rejected'))failed=true;
      }
      for(let index=0;index<20;index++){const result=await events.dispatchOnce();if(!result.attempted&&!result.revoked&&!result.expired)break;}
      if(failed)throw problem(503,'event_ingestion_pending');
      health.lastSuccessAt=new Date().toISOString();health.consecutiveFailures=0;
    }catch{health.consecutiveFailures++;}
    finally{running=false;}
  }
  return{init,ingest,tick,health,async settle(){while(running)await new Promise(resolve=>setTimeout(resolve,10));}};
}
