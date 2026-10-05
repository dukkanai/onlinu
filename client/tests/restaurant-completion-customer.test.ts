import assert from "node:assert/strict";
import test from "node:test";
import { activeLocationOrder, mapViewport, recentLocation, validMapPoint, worldPoint, type CourierLocation } from "../src/restaurant/customer/location";
import { parseSupportRequest, refundStatusKey, supportStorageKey, type CustomerRefund, type SupportRequest } from "../src/restaurant/customer/support";
import type { Order } from "../src/restaurant/types";

test("location viewport is bounded and only requests integer public tile URLs",()=>{
  const map=mapViewport([{latitude:24.7136,longitude:46.6753},{latitude:24.72,longitude:46.69}])!;
  assert.ok(map.tiles.length<=9);assert.ok(map.tiles.length>0);
  for(const tile of map.tiles){assert.match(tile.url,/^https:\/\/tile\.openstreetmap\.org\/\d+\/\d+\/\d+\.png$/);assert.ok(!tile.url.includes("24.7136"));}
  assert.ok(map.markers.every(p=>p.x>=0&&p.x<=480&&p.y>=0&&p.y<=300));
  assert.equal(mapViewport([{latitude:NaN,longitude:0}]),null);
  assert.ok(Number.isFinite(worldPoint({latitude:90,longitude:180},18).y));
  assert.equal(validMapPoint({latitude:91,longitude:0}),false);
});
test("expired and terminal courier points are not displayed",()=>{
  const now=Date.now();const point:CourierLocation={latitude:1,longitude:2,accuracy:15,capturedAt:new Date(now).toISOString(),receivedAt:new Date(now).toISOString(),expiresAt:new Date(now+1000).toISOString(),stale:false};
  assert.equal(recentLocation(point,now),point);assert.equal(recentLocation(point,now+1001),null);
  assert.equal(recentLocation({...point,latitude:Infinity},now),null);
  assert.equal(activeLocationOrder({mode:"delivery",courierId:"assigned",status:"ready",deliveryStatus:"assigned"} as Order),true);
  for(const status of ["completed","cancelled"]) assert.equal(activeLocationOrder({mode:"delivery",courierId:"assigned",status} as Order),false);
  assert.equal(activeLocationOrder({mode:"delivery",status:"ready"} as Order),false);
});
test("support retries bind immutable request to order and original private identity",()=>{
  const now=Date.now();const pending:SupportRequest={number:"R100",scope:"account:alice",kind:"cancel",reason:"A duplicate",version:7,key:"91612392-7d09-48b6-819d-f3894c82ae21",createdAt:now,uncertain:true};
  assert.deepEqual(parseSupportRequest(JSON.stringify(pending),"R100","account:alice",now),pending);
  assert.equal(parseSupportRequest(JSON.stringify(pending),"R101","account:alice",now),null);
  assert.equal(parseSupportRequest(JSON.stringify(pending),"R100","account:bob",now),null);
  assert.equal(parseSupportRequest(JSON.stringify(pending),"R100","account:alice",now+86400001),null);
  assert.equal(parseSupportRequest(JSON.stringify({...pending,key:"untrusted"}),"R100","account:alice",now),null);
  assert.notEqual(supportStorageKey("R100","account:alice"),supportStorageKey("R101","account:alice"));
  assert.notEqual(supportStorageKey("R100","account:alice"),supportStorageKey("R100","account:bob"));
});
test("manual or unverified refund cannot be presented as gateway confirmed",()=>{
  assert.equal(refundStatusKey({status:"succeeded",confirmation:"provider"} as CustomerRefund),"refund.succeeded");
  assert.equal(refundStatusKey({status:"succeeded",confirmation:"none"} as CustomerRefund),"refund.review");
  assert.equal(refundStatusKey({status:"succeeded",confirmation:"manual"} as CustomerRefund),"refund.review");
  assert.equal(refundStatusKey({status:"manual_reported",confirmation:"manual"} as CustomerRefund),"refund.manual_reported");
  assert.equal(refundStatusKey({status:"processing",confirmation:"none"} as CustomerRefund),"refund.processing");
});
