import {createHash} from 'node:crypto';
import {problem} from './auth.mjs';

export const mediaName=/^[a-f0-9]{64}\.(png|jpg)$/;
const localImage=/^\/restaurant-media\/([a-f0-9]{64}\.(?:png|jpg))$/;
export function platformImageURL(baseUrl,tenantId,value){
  const match=typeof value==='string'&&localImage.exec(value);
  return match?`${baseUrl}/restaurant-media/${tenantId}/${match[1]}`:value;
}
export function publicMenuImages(baseUrl,tenantId,menu){
  const image=value=>platformImageURL(baseUrl,tenantId,value);
  const brand={...menu.settings.brand};
  for(const key of ['logoUrl','coverUrl','introImageUrl'])if(brand[key])brand[key]=image(brand[key]);
  return {...menu,settings:{...menu.settings,...(menu.settings.brand?{brand}:{})},items:menu.items.map(item=>({...item,imageUrl:image(item.imageUrl)}))};
}

// Public image reads only use deployment-owned restaurant origins and exact
// content-addressed paths. No caller URL, redirect, cookie or service key is used.
export function createCoreMedia({restaurants,fetchImpl=fetch}){
  const routes=new Map();let active=0;
  for(const row of restaurants){
    const url=new URL(row.baseUrl);
    if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(row.id)||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.pathname!=='/'||url.search||url.hash||routes.has(row.id))throw Error('invalid_media_routes');
    routes.set(row.id,url.origin);
  }
  return {async image(tenantId,name){
    if(!routes.has(tenantId)||!mediaName.test(name??''))throw problem(404,'not_found');
    if(active>=8)throw problem(429,'rate_limited');
    active++;
    try{
      const response=await fetchImpl(routes.get(tenantId)+'/restaurant-media/'+name,{redirect:'error',signal:AbortSignal.timeout(10_000),headers:{accept:'image/png,image/jpeg'}});
      if(response.status===404){await response.body?.cancel();throw problem(404,'not_found');}
      const type=name.endsWith('.png')?'image/png':'image/jpeg';
      if(!response.ok||response.headers.get('content-type')?.split(';')[0]!==type||Number(response.headers.get('content-length'))>5*1024*1024){await response.body?.cancel();throw problem(503,'restaurant_unavailable');}
      const chunks=[];let size=0;
      for await(const chunk of response.body??[]){size+=chunk.length;if(size>5*1024*1024)throw problem(503,'restaurant_unavailable');chunks.push(chunk);}
      const bytes=Buffer.concat(chunks),hash=createHash('sha256').update(bytes).digest('hex');
      if(hash!==name.split('.')[0]||!(type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes[0]===255&&bytes[1]===216&&bytes[2]===255))throw problem(503,'restaurant_unavailable');
      return{bytes,type};
    }catch(error){if(['not_found','restaurant_unavailable'].includes(error.code))throw error;throw problem(503,'restaurant_unavailable');}
    finally{active--;}
  }};
}
