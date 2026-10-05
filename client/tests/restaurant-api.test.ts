import assert from 'node:assert/strict';
import test from 'node:test';
import { storefront, adminRestaurant, RestaurantAPIError } from '../src/restaurant/api';

test('public restaurant requests never inherit master credentials or another origin', async () => {
  const previous = globalThis.fetch;
  const seen: {url: string; options?: RequestInit}[] = [];
  globalThis.fetch = async (url, options) => {
    seen.push({url: String(url), options});
    return new Response(JSON.stringify({ok:true}), {status:200, headers:{'Content-Type':'application/json'}});
  };
  try {
    await storefront('/catalog', { headers: {'X-API-Key':'must-not-be-sent'} });
    assert.equal(seen[0].url, '/storefront-api/catalog');
    assert.equal(new Headers(seen[0].options?.headers).has('X-API-Key'),false);
    assert.equal(seen[0].options?.credentials,'same-origin');
    assert.equal(seen[0].options?.redirect,'error');
    await assert.rejects(storefront('//evil.example/path'),RestaurantAPIError);
    await assert.rejects(storefront('/../api/config'),RestaurantAPIError);
    assert.equal(seen.length,1);
  } finally { globalThis.fetch = previous; }
});

test('admin multipart requests retain the browser boundary and use only same-origin key transport', async () => {
  const previousFetch=globalThis.fetch;
  const previousStorage=Object.getOwnPropertyDescriptor(globalThis,'localStorage');
  Object.defineProperty(globalThis,'localStorage',{configurable:true,value:{getItem:(key:string)=>key==='wacalls.apiKey'?'test-admin-only':null}});
  globalThis.fetch=async (url, options)=>{
    assert.equal(url,'/api/restaurant/images');
    const headers=new Headers(options?.headers);
    assert.equal(headers.get('X-API-Key'),'test-admin-only');
    assert.equal(headers.has('Content-Type'),false);
    return new Response(null,{status:204});
  };
  try { assert.equal(await adminRestaurant('/images',{method:'POST',body:new FormData()}),undefined); }
  finally { globalThis.fetch=previousFetch;if(previousStorage)Object.defineProperty(globalThis,'localStorage',previousStorage);else Reflect.deleteProperty(globalThis,'localStorage'); }
});

test('restaurant failures expose a stable code and status without redirecting the public UI', async()=>{
  const previous=globalThis.fetch;
  globalThis.fetch=async()=>new Response(JSON.stringify({error:'session_expired'}),{status:401});
  try { await assert.rejects(storefront('/account'), (error: unknown)=>error instanceof RestaurantAPIError&&error.code==='session_expired'&&error.status===401); }
  finally {globalThis.fetch=previous;}
});
