import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createCoreMedia,publicMenuImages,platformImageURL} from './core-media.mjs';
const bytes=Buffer.from([137,80,78,71,13,10,26,10,1,2,3]),name=createHash('sha256').update(bytes).digest('hex')+'.png';
const restaurants=[{id:'a',baseUrl:'http://127.0.0.1:1234'}];
test('public media uses fixed exact routes and hash/type validation without credentials',async()=>{
 let calls=0;
 const media=createCoreMedia({restaurants,fetchImpl:async(url,options)=>{calls++;assert.equal(url,'http://127.0.0.1:1234/restaurant-media/'+name);assert.equal(options.redirect,'error');assert.equal(options.headers.cookie,undefined);assert.equal(options.headers.authorization,undefined);return new Response(bytes,{headers:{'content-type':'image/png'}});}});
 assert.deepEqual((await media.image('a',name)).bytes,bytes);
 await assert.rejects(media.image('other',name),{code:'not_found'});await assert.rejects(media.image('a','../../.env'),{code:'not_found'});assert.equal(calls,1);
});
test('media proxy rejects changed content, HTML, oversized and missing responses',async()=>{
 for(const response of [()=>new Response(Buffer.from('changed'),{headers:{'content-type':'image/png'}}),()=>new Response(bytes,{headers:{'content-type':'text/html'}}),()=>new Response(bytes,{headers:{'content-type':'image/png','content-length':String(6*1024*1024)}})]){
  await assert.rejects(createCoreMedia({restaurants,fetchImpl:async()=>response()}).image('a',name),{code:'restaurant_unavailable'});
 }
 await assert.rejects(createCoreMedia({restaurants,fetchImpl:async()=>new Response('',{status:404})}).image('a',name),{code:'not_found'});
});
test('public catalogue rewrites only valid local content paths and never mutates original settings',()=>{
 const local='/restaurant-media/'+name,menu={settings:{brand:{logoUrl:local,coverUrl:'https://images.example/cover.jpg'}},items:[{id:'rice',imageUrl:local}]};
 const converted=publicMenuImages('https://platform.example','a',menu);
 assert.equal(converted.items[0].imageUrl,'https://platform.example/restaurant-media/a/'+name);assert.equal(menu.items[0].imageUrl,local);
 assert.equal(converted.settings.brand.logoUrl,converted.items[0].imageUrl);assert.equal(converted.settings.brand.coverUrl,menu.settings.brand.coverUrl);
 assert.equal(platformImageURL('https://platform.example','a','/restaurant-media/../../.env'),'/restaurant-media/../../.env');
});
