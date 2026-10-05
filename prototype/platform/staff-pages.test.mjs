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
