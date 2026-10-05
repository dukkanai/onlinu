import test from 'node:test';
import assert from 'node:assert/strict';
import {staffHome,staffOrdersPage,staffChannelsPage} from './staff-pages.mjs';
const order={number:'R2026000001',version:2,status:'accepted',paymentStatus:'unpaid',paymentMethod:'cash_on_delivery',mode:'delivery',totalMinor:3500};
test('staff pages display only authorized actions and escape dynamic content',()=>{
  const kitchen={permissions:['orders:read','orders:update'],tenantStatus:'active'};
  const html=staffOrdersPage({tenantId:'restaurant-a',membership:kitchen,orders:[order],csrf:'test-csrf'});
  assert.match(html,/\/status/);assert.doesNotMatch(html,/\/cash/);assert.match(html,/35\.00/);
  assert.match(html,/name="version" value="2"/);
  const cashier=staffOrdersPage({tenantId:'restaurant-a',membership:{permissions:['orders:read','payments:collect'],tenantStatus:'suspended'},orders:[order],csrf:'<synthetic>'});
  assert.match(cashier,/\/cash/);assert.doesNotMatch(cashier,/\/status/);assert.match(cashier,/&lt;synthetic&gt;/);
  assert.match(cashier,/المطعم موقوف/);
  assert.doesNotMatch(staffOrdersPage({tenantId:'a',membership:{permissions:['payments:collect']},orders:[{...order,paymentStatus:'paid'}],csrf:'x'}),/\/cash/);
  assert.doesNotMatch(staffHome({memberships:[{tenantId:'secret',role:'courier',permissions:['delivery:read']}]}),/secret/);
});
test('channel controls separate ordering capability from existing WhatsApp connectivity',()=>{
  const html=staffChannelsPage({tenantId:'a',csrf:'token',channels:[
    {channel:'web',newOrdersEnabled:true,adapterImplemented:true,version:1},
    {channel:'whatsapp_qr',newOrdersEnabled:false,adapterImplemented:false,version:1},
  ]});
  assert.match(html,/action="\/manage\/a\/channels\/web"/);
  assert.doesNotMatch(html,/action="\/manage\/a\/channels\/whatsapp_qr"/);
  assert.match(html,/المكالمات القائمة/);
  assert.match(staffHome({memberships:[{tenantId:'a',role:'manager',permissions:['channels:manage']}]}),/\/manage\/a\/channels/);
});
test('kitchen detail uses historical lines and escapes customer instructions',()=>{
  const html=staffOrdersPage({tenantId:'a',membership:{permissions:['orders:read']},csrf:'test',orders:[{...order,
    items:[{name:'<Rice>',quantity:2,totalMinor:3000,options:[{name:'Extra'}]}],notes:'<script>untrusted</script>',tableName:'One'}]});
  assert.match(html,/&lt;Rice&gt;/);assert.match(html,/Extra/);assert.match(html,/&lt;script&gt;/);
  assert.doesNotMatch(html,/<script>/);assert.match(html,/تفاصيل الأصناف/);assert.doesNotMatch(html,/أحدث 100 طلب/);
});
