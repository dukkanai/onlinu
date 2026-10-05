import {problem} from './auth.mjs';

// One permission-checked staff operation router, shared by browser and native
// transports. Authentication/CSRF belongs to the caller; platform-admin
// registry endpoints are deliberately not included here.
export function createStaffApi({directory,orderClient,body,json}){
  return async(req,res,who,url)=>{
        const categoryEditRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/menu\/categories\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/.exec(url.pathname);
        if(categoryEditRoute&&orderClient&&req.method==='POST'){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,categoryId]=categoryEditRoute;await directory.authorize(who.id,tenantId,'menu:update');
          return json(res,200,await orderClient.patchMenuCategory(tenantId,who.id,categoryId,await body(req)));
        }
        const menuCreateRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/menu\/(items|categories)$/.exec(url.pathname);
        if(menuCreateRoute&&orderClient&&req.method==='POST'){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,kind]=menuCreateRoute;await directory.authorize(who.id,tenantId,'menu:update');
          const input=await body(req,128*1024);
          return json(res,201,await orderClient[kind==='items'?'createMenuItem':'createMenuCategory'](tenantId,who.id,input));
        }
        const menuRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/menu(?:\/items\/([A-Za-z0-9][A-Za-z0-9_-]{0,79}))?$/.exec(url.pathname);
        if(menuRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,itemId]=menuRoute;
          if(req.method==='GET'){
            await directory.authorize(who.id,tenantId,'menu:read');
            return json(res,200,itemId?await orderClient.menuItem(tenantId,who.id,itemId):await orderClient.menu(tenantId,who.id));
          }
          if(req.method==='POST'&&itemId){
            await directory.authorize(who.id,tenantId,'menu:update');
            return json(res,200,await orderClient.patchMenuItem(tenantId,who.id,itemId,await body(req,128*1024)));
          }
        }
        const stockRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/stock(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(url.pathname);
        if(stockRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,itemId]=stockRoute;
          if(req.method==='GET'&&!itemId){await directory.authorize(who.id,tenantId,'stock:read');return json(res,200,await orderClient.stock(tenantId,who.id));}
          if(req.method==='POST'&&itemId){await directory.authorize(who.id,tenantId,'stock:update');return json(res,200,await orderClient.setStock(tenantId,who.id,itemId,await body(req)));}
        }
        const channelRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/channels(?:\/(web|chatgpt|whatsapp_qr|whatsapp_cloud))?$/.exec(url.pathname);
        if(channelRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,channel]=channelRoute;
          await directory.authorize(who.id,tenantId,'channels:manage');
          if(req.method==='GET'&&!channel)return json(res,200,await orderClient.channels(tenantId,who.id));
          if(req.method==='POST'&&channel)return json(res,200,await orderClient.setChannel(tenantId,who.id,channel,await body(req)));
        }
        const staffRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/orders(?:\/(R[0-9]{8,20})(?:\/(status|cash))?)?$/.exec(url.pathname);
        if(staffRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,number,action]=staffRoute;
          if(req.method==='GET'&&!action){
            await directory.authorize(who.id,tenantId,'orders:read');
            return json(res,200,number?await orderClient.staffOrder(tenantId,who.id,number):await orderClient.staffOrders(tenantId,who.id));
          }
          if(req.method==='POST'&&number){
            await directory.authorize(who.id,tenantId,action==='status'?'orders:update':'payments:collect');
            return json(res,200,await orderClient.staffChange(tenantId,who.id,number,action,await body(req)));
          }
        }
        const match = /^\/api\/restaurants\/([a-z0-9-]{1,64})\/members(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
        if (match && req.method === 'GET' && !match[2]) return json(res, 200, { members: await directory.members(who.id, match[1]) });
        if (match && req.method === 'PUT' && match[2]) return json(res, 200, await directory.setMembership(who.id, match[1], match[2], await body(req)));
    throw problem(404,'not_found');
  };
}
