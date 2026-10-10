import {createCourierApi} from './courier-service.mjs';
import {problem} from './auth.mjs';

// One permission-checked staff operation router, shared by browser and native
// transports. Authentication/CSRF belongs to the caller; platform-admin
// registry endpoints are deliberately not included here.
export function createStaffApi({directory,orderClient,body,json,uploadSlots={active:0}}){
  const courierApi=orderClient?createCourierApi({directory,orderClient,body,json}):null;
  // The initial grant can expire while an asynchronous body is being read.
  // Recheck immediately before delegating a signed mutation; never retry it.
  const authorizedBody=async(req,who,tenantId,permission,limit)=>{const input=await body(req,limit);await directory.authorize(who.id,tenantId,permission);return input;};
  return async(req,res,who,url,{restaurantOnly=false,authorizeMutation}={})=>{
        // The native transport supplies a request-bound credential check. Keep
        // its original family separate from current restaurant permissions.
        // Courier operations retain their existing, separately reviewed path.
        const authorizedNativeBody=async(req,who,tenantId,permission,limit)=>{const input=await authorizedBody(req,who,tenantId,permission,limit);await authorizeMutation?.();return input;};
        if(courierApi&&/^\/api\/restaurants\/[^/]+\/(courier-links|courier-work)(?:\/|$)/.test(url.pathname))return courierApi(req,res,who,url);
        const couriersRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/couriers$/.exec(url.pathname);
        if(couriersRoute&&orderClient&&req.method==='GET'){
          if(url.search)throw problem(400,'invalid_request');const tenantId=couriersRoute[1];await directory.authorize(who.id,tenantId,'delivery:assign');return json(res,200,await orderClient.couriers(tenantId,who.id));
        }
        const assignRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/orders\/(R[0-9]{8,20})\/courier$/.exec(url.pathname);
        if(assignRoute&&orderClient&&req.method==='POST'){
          if(url.search)throw problem(400,'invalid_request');const [,tenantId,number]=assignRoute;await directory.authorize(who.id,tenantId,'delivery:assign');return json(res,200,await orderClient.assignCourier(tenantId,who.id,number,await authorizedBody(req,who,tenantId,'delivery:assign')));
        }
        const paymentMethodsRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/payment-methods$/.exec(url.pathname);
        if(paymentMethodsRoute&&orderClient){
          const tenantId=paymentMethodsRoute[1];if(url.search||!['GET','POST'].includes(req.method))throw problem(400,'invalid_request');
          await directory.authorize(who.id,tenantId,'settings:read');
          if(req.method==='GET')return json(res,200,await orderClient.paymentMethods(tenantId,who.id));
          await directory.authorize(who.id,tenantId,'settings:update');const input=await body(req);
          await directory.authorize(who.id,tenantId,'settings:read');await directory.authorize(who.id,tenantId,'settings:update');
          await authorizeMutation?.();
          return json(res,200,await orderClient.patchPaymentMethods(tenantId,who.id,input));
        }
        const deliveryRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/delivery(?:\/(pricing|zone|location))?$/.exec(url.pathname);
        if(deliveryRoute&&orderClient){
          const [,tenantId,action]=deliveryRoute;if(url.search||!(req.method==='GET'&&!action||req.method==='POST'&&action))throw problem(400,'invalid_request');
          await directory.authorize(who.id,tenantId,req.method==='GET'?'settings:read':'settings:update');
          if(req.method==='GET')return json(res,200,await orderClient.delivery(tenantId,who.id));
          const input=await body(req);
          // A streamed body can outlive the permission checked above. Check the
          // current membership again before issuing a signed core mutation.
          await directory.authorize(who.id,tenantId,'settings:update');
          await authorizeMutation?.();
          return json(res,200,await orderClient.patchDelivery(tenantId,who.id,action,input));
        }
        const geoRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/geography\/(regions|cities|districts)(?:\/([A-Za-z0-9][A-Za-z0-9_-]{0,79}))?$/.exec(url.pathname);
        if(geoRoute&&orderClient&&req.method==='GET'){
          if(url.search)throw problem(400,'invalid_request');const [,tenantId,kind,parent]=geoRoute;await directory.authorize(who.id,tenantId,'settings:read');
          return json(res,200,await orderClient.geography(tenantId,who.id,kind,parent));
        }
        const refundRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/orders\/(R[0-9]{8,20})\/refunds\/([a-f0-9-]{36})(?:\/(authorize|manual|verify|refresh))?$/.exec(url.pathname);
        if(refundRoute&&orderClient){
          const [,tenantId,number,refundId,action]=refundRoute;
          if(url.search||!(req.method==='GET'&&!action||req.method==='POST'&&action))throw problem(400,'invalid_request');
          const authorize=async()=>{for(const grant of ['orders:read','payments:read','refunds:manage'])await directory.authorize(who.id,tenantId,grant);};
          await authorize();
          if(req.method==='GET')return json(res,200,await orderClient.refund(tenantId,who.id,number,refundId));
          const input=await body(req);await authorize();await authorizeMutation?.();
          return json(res,200,await orderClient.refundCommand(tenantId,who.id,number,refundId,action,input));
        }
        const financeRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/orders\/(R[0-9]{8,20})\/finance$/.exec(url.pathname);
        if(financeRoute&&orderClient&&req.method==='GET'){
          if(url.search)throw problem(400,'invalid_request');const [,tenantId,number]=financeRoute;await directory.authorize(who.id,tenantId,'orders:read');await directory.authorize(who.id,tenantId,'payments:read');return json(res,200,await orderClient.finance(tenantId,who.id,number));
        }
        const brandRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/brand(?:\/(draft|publish|revert))?$/.exec(url.pathname);
        if(brandRoute&&orderClient){
          const [,tenantId,action]=brandRoute;if(url.search||!(req.method==='GET'&&!action||req.method==='POST'&&action))throw problem(400,'invalid_request');
          await directory.authorize(who.id,tenantId,'settings:read');
          if(req.method==='GET')return json(res,200,await orderClient.brand(tenantId,who.id));
          await directory.authorize(who.id,tenantId,'settings:update');const input=await body(req);
          await directory.authorize(who.id,tenantId,'settings:read');await directory.authorize(who.id,tenantId,'settings:update');
          await authorizeMutation?.();
          return json(res,200,await orderClient.brandCommand(tenantId,who.id,action,input));
        }
        const supportRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/support(?:\/orders\/(R[0-9]{8,20})(?:\/([a-f0-9-]{36})\/(decide|resolve))?)?$/.exec(url.pathname);
        if(supportRoute&&orderClient){
          const [,tenantId,number,id,action]=supportRoute;
          if(url.search||!(req.method==='GET'&&!action||req.method==='POST'&&action))throw problem(400,'invalid_request');
          await directory.authorize(who.id,tenantId,'orders:read');
          if(req.method==='GET')return json(res,200,number?await orderClient.supportDetail(tenantId,who.id,number):await orderClient.support(tenantId,who.id));
          await directory.authorize(who.id,tenantId,'support:manage');const input=await body(req);
          await directory.authorize(who.id,tenantId,'orders:read');await directory.authorize(who.id,tenantId,'support:manage');
          await authorizeMutation?.();
          return json(res,200,await orderClient.supportCommand(tenantId,who.id,number,id,action,input));
        }
        const taxRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/tax$/.exec(url.pathname);
        if(taxRoute&&orderClient&&['GET','POST'].includes(req.method)){
          if(url.search)throw problem(400,'invalid_request');const tenantId=taxRoute[1];
          await directory.authorize(who.id,tenantId,'settings:read');
          if(req.method==='GET')return json(res,200,await orderClient.tax(tenantId,who.id));
          await directory.authorize(who.id,tenantId,'settings:update');const input=await body(req);
          await directory.authorize(who.id,tenantId,'settings:read');await directory.authorize(who.id,tenantId,'settings:update');
          await authorizeMutation?.();
          return json(res,200,await orderClient.patchTax(tenantId,who.id,input));
        }
        const openingRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/opening-schedule$/.exec(url.pathname);
        if(openingRoute&&orderClient){
          if(url.search||!['GET','POST'].includes(req.method))throw problem(400,'invalid_request');
          const tenantId=openingRoute[1];await directory.authorize(who.id,tenantId,'settings:read');
          if(req.method==='GET')return json(res,200,await orderClient.openingSchedule(tenantId,who.id));
          await directory.authorize(who.id,tenantId,'settings:update');const input=await body(req);
          await directory.authorize(who.id,tenantId,'settings:read');await directory.authorize(who.id,tenantId,'settings:update');
          await authorizeMutation?.();
          return json(res,200,await orderClient.patchOpeningSchedule(tenantId,who.id,input));
        }
        const serviceRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/service$/.exec(url.pathname);
        if(serviceRoute&&orderClient&&['GET','POST'].includes(req.method)){
          if(url.search)throw problem(400,'invalid_request');const tenantId=serviceRoute[1];await directory.authorize(who.id,tenantId,req.method==='GET'?'settings:read':'settings:update');
          return json(res,200,req.method==='GET'?await orderClient.service(tenantId,who.id):await orderClient.patchService(tenantId,who.id,await authorizedNativeBody(req,who,tenantId,'settings:update')));
        }
        const profileRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/profile$/.exec(url.pathname);
        if(profileRoute&&orderClient&&['GET','POST'].includes(req.method)){
          if(url.search)throw problem(400,'invalid_request');
          const tenantId=profileRoute[1];await directory.authorize(who.id,tenantId,req.method==='GET'?'settings:read':'settings:update');
          return json(res,200,req.method==='GET'?await orderClient.profile(tenantId,who.id):await orderClient.patchProfile(tenantId,who.id,await authorizedNativeBody(req,who,tenantId,'settings:update')));
        }
        const imageRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/menu\/items\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})\/image$/.exec(url.pathname);
        if(imageRoute&&orderClient&&req.method==='POST'){
          const [,tenantId,itemId]=imageRoute,rawVersion=req.headers['x-menu-version'],version=Number(rawVersion);
          if(url.search||typeof rawVersion!=='string'||!/^\d{1,16}$/.test(rawVersion)||!Number.isSafeInteger(version)||version<1)throw problem(400,'invalid_request');
          if(req.headers['content-type']?.split(';')[0].trim().toLowerCase()!=='application/octet-stream')throw problem(415,'image_binary_required');
          await directory.authorize(who.id,tenantId,'menu:update');
          if(uploadSlots.active>=2)throw problem(429,'rate_limited');uploadSlots.active++;
          try{
            const chunks=[];let size=0;
            for await(const chunk of req){size+=chunk.length;if(size>5*1024*1024)throw problem(413,'image_too_large');chunks.push(chunk);}
            if(size<1)throw problem(400,'image_invalid');
            await directory.authorize(who.id,tenantId,'menu:update');
            const current=await orderClient.menuItem(tenantId,who.id,itemId);
            if(current.version!==version)throw problem(409,'catalog_changed');
            await directory.authorize(who.id,tenantId,'menu:update');
            await authorizeMutation?.();
            const uploaded=await orderClient.uploadImage(tenantId,who.id,Buffer.concat(chunks));
            // Recheck authority after reading/normalizing a potentially large file.
            // The final original-core catalogue CAS still guards concurrent edits.
            await directory.authorize(who.id,tenantId,'menu:update');
            await authorizeMutation?.();
            return json(res,200,await orderClient.patchMenuItem(tenantId,who.id,itemId,{expectedVersion:version,imageUrl:uploaded.url}));
          }finally{uploadSlots.active--;}
        }

        const categoryEditRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/menu\/categories\/([A-Za-z0-9][A-Za-z0-9_-]{0,79})$/.exec(url.pathname);
        if(categoryEditRoute&&orderClient&&req.method==='POST'){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,categoryId]=categoryEditRoute;await directory.authorize(who.id,tenantId,'menu:update');
          return json(res,200,await orderClient.patchMenuCategory(tenantId,who.id,categoryId,await authorizedNativeBody(req,who,tenantId,'menu:update')));
        }
        const menuCreateRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/menu\/(items|categories)$/.exec(url.pathname);
        if(menuCreateRoute&&orderClient&&req.method==='POST'){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,kind]=menuCreateRoute;await directory.authorize(who.id,tenantId,'menu:update');
          const input=await authorizedNativeBody(req,who,tenantId,'menu:update',128*1024);
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
            return json(res,200,await orderClient.patchMenuItem(tenantId,who.id,itemId,await authorizedNativeBody(req,who,tenantId,'menu:update',128*1024)));
          }
        }
        const stockRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/stock(?:\/([A-Za-z0-9_-]{1,128}))?$/.exec(url.pathname);
        if(stockRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,itemId]=stockRoute;
          if(req.method==='GET'&&!itemId){await directory.authorize(who.id,tenantId,'stock:read');return json(res,200,await orderClient.stock(tenantId,who.id));}
          if(req.method==='POST'&&itemId){await directory.authorize(who.id,tenantId,'stock:update');return json(res,200,await orderClient.setStock(tenantId,who.id,itemId,await authorizedNativeBody(req,who,tenantId,'stock:update')));}
        }
        const channelRoute=/^\/api\/restaurants\/([a-z0-9-]{1,64})\/staff\/channels(?:\/(web|chatgpt))?$/.exec(url.pathname);
        if(channelRoute&&orderClient){
          if(url.search)throw problem(400,'invalid_request');
          const [,tenantId,channel]=channelRoute;
          await directory.authorize(who.id,tenantId,'channels:manage');
          if(req.method==='GET'&&!channel)return json(res,200,await orderClient.channels(tenantId,who.id));
          if(req.method==='POST'&&channel){
            const input=await body(req);
            await directory.authorize(who.id,tenantId,'channels:manage');
            await authorizeMutation?.();
            return json(res,200,await orderClient.setChannel(tenantId,who.id,channel,input));
          }
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
            return json(res,200,await orderClient.staffChange(tenantId,who.id,number,action,await authorizedNativeBody(req,who,tenantId,action==='status'?'orders:update':'payments:collect')));
          }
        }
        const match = /^\/api\/restaurants\/([a-z0-9-]{1,64})\/members(?:\/([a-f0-9-]{36}))?$/.exec(url.pathname);
        if (match && req.method === 'GET' && !match[2]) return json(res, 200, { members: await directory.members(who.id, match[1],{allowPlatformAdmin:!restaurantOnly}) });
        if (match && req.method === 'PUT' && match[2]) return json(res, 200, await directory.setMembership(who.id, match[1], match[2], await body(req),{allowPlatformAdmin:!restaurantOnly,authorizeMutation}));
    throw problem(404,'not_found');
  };
}
