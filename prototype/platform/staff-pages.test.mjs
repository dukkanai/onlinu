import test from 'node:test';
import assert from 'node:assert/strict';
import {staffHome,staffOrdersPage,staffChannelsPage,staffStockPage,staffMenuPage,staffMenuItemPage,menuPriceMinor,staffMembersPage,staffErrorPage} from './staff-pages.mjs';
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
test('stock interface distinguishes untracked amounts and does not offer writes to read-only staff',()=>{
  const config={tenantId:'a',items:[{itemId:'rice',tracked:false,available:0,held:0,version:0}],catalog:{items:[{id:'rice',name:'<Rice>'}]},csrf:'test'};
  const read=staffStockPage({...config,membership:{permissions:['stock:read']}});
  assert.match(read,/ليس قياسًا/);assert.match(read,/&lt;Rice&gt;/);assert.doesNotMatch(read,/<form/);
  const edit=staffStockPage({...config,membership:{permissions:['stock:read','stock:update']}});
  assert.match(edit,/name="version" value="0"/);assert.match(edit,/حفظ مخزون &lt;Rice&gt;/);assert.match(edit,/لا يمسح الحجوزات القائمة/);
});
test('menu form prices are exact minor units without floating point parsing',()=>{
  for(const [input,expected] of [['0',0],['0.01',1],['12.29',1229],['١٢٫٥',1250],['۱۲.۵۰',1250],['1000000.00',100000000]])assert.equal(menuPriceMinor(input),expected);
  for(const value of ['',null,12,'-1','1e3','1,000','12.345','1000000.01','NaN','Infinity'])assert.equal(menuPriceMinor(value),null);
});
test('menu views escape names and do not give read-only staff editing forms',()=>{
  const item={id:'rice',categoryId:'main',name:'<Rice>',description:'<script>text</script>',priceMinor:1200,available:true,sort:0,options:[]};
  const menu={name:'Test',version:2,currency:'SAR',categories:[{id:'main',name:'Main',sort:0}],items:[item],item};
  assert.match(staffMenuPage({tenantId:'a',menu}),/&lt;Rice&gt;/);
  assert.doesNotMatch(staffMenuItemPage({tenantId:'a',menu,membership:{permissions:['menu:read']},csrf:'test'}),/<form/);
  const editable=staffMenuItemPage({tenantId:'a',menu,membership:{permissions:['menu:read','menu:update']},csrf:'test'});
  assert.match(editable,/value="12\.00"/);assert.match(editable,/&lt;script&gt;/);assert.doesNotMatch(editable,/<script>/);
});

test('menu creation requires write permission and stable form IDs; new items start disabled',()=>{
 const menu={version:4,name:'Test',categories:[{id:'main',name:'Main'}],items:[]};
 const html=staffMenuPage({tenantId:'a',menu,membership:{permissions:['menu:read','menu:update']},csrf:'token',newItemId:'item-id',newCategoryId:'category-id'});
 assert.match(html,/new-category/);assert.match(html,/new-item/);assert.match(html,/value="item-id"/);assert.match(html,/غير مفعّل/);
 assert.doesNotMatch(staffMenuPage({tenantId:'a',menu,membership:{permissions:['menu:read']}}),/<form/);
 assert.doesNotMatch(staffMenuPage({tenantId:'a',menu:{...menu,categories:[]},membership:{permissions:['menu:update']},csrf:'token',newCategoryId:'id'}),/action="[^"]*new-item/);
});

test('option forms preserve stable IDs, escape text and enforce the visible limit',()=>{
 const item={id:'rice',name:'Rice',description:'',priceMinor:100,categoryId:'main',sort:0,available:true,options:[{id:'extra',name:'<Extra>',priceMinor:25,available:true}]};
 const config={tenantId:'a',menu:{version:2,item,categories:[]},membership:{permissions:['menu:update']},csrf:'test',newOptionId:'new-option'};
 const html=staffMenuItemPage(config);assert.match(html,/options\/extra/);assert.match(html,/aria-label="تفعيل الإضافة"/);assert.match(html,/value="new-option"/);assert.match(html,/&lt;Extra&gt;/);assert.doesNotMatch(html,/<Extra>/);
 const full=staffMenuItemPage({...config,menu:{...config.menu,item:{...item,options:Array.from({length:50},(_,i)=>({...item.options[0],id:'o'+i}))}}});
 assert.doesNotMatch(full,/إضافة الخيار/);assert.match(full,/50 إضافة/);
 assert.doesNotMatch(staffMenuItemPage({...config,membership:{permissions:['menu:read']}}),/<form/);
});

test('image forms use native multipart and preview only own content-addressed media',()=>{
 const item={id:'rice',name:'<Rice>',description:'',priceMinor:100,categoryId:'main',sort:0,available:true,options:[],imageUrl:'/restaurant-media/'+'a'.repeat(64)+'.png'};
 const config={tenantId:'a',menu:{version:2,item,categories:[]},membership:{permissions:['menu:update']},csrf:'test',newOptionId:'new-option'};
 const html=staffMenuItemPage(config);assert.match(html,/enctype="multipart\/form-data"/);assert.match(html,/accept="image\/png,image\/jpeg"/);assert.match(html,/src="\/restaurant-media\/a\/a{64}\.png"/);
 const external=staffMenuItemPage({...config,menu:{...config.menu,item:{...item,imageUrl:'https://images.example/private.jpg'}}});assert.doesNotMatch(external,/<img/);
 assert.doesNotMatch(staffMenuItemPage({...config,membership:{permissions:['menu:read']}}),/<form/);
});

test('member editor escapes aliases and names permissions without exposing login claims',()=>{
 const html=staffMembersPage({tenantId:'a',csrf:'token',actorId:'owner',members:[{principalId:'worker',displayName:'<Chef>',version:2,role:'kitchen',enabled:true,permissions:['orders:read']}]});
 assert.match(html,/&lt;Chef&gt;/);assert.doesNotMatch(html,/<Chef>/);assert.match(html,/name="perm:orders:read" value="yes" checked/);
 assert.match(html,/معرّف حساب الموظف/);assert.match(html,/آخر مالك نشط/);assert.match(staffErrorPage('last_owner_required'),/عيّن مالكًا آخر/);assert.equal(staffErrorPage('secret'),null);
 const home=staffHome({id:'own-id',memberships:[{tenantId:'a',role:'owner',permissions:['orders:read','members:manage']}]},{coreEnabled:false});
 assert.match(home,/own-id/);assert.match(home,/\/a\/members/);assert.doesNotMatch(home,/\/a\/orders/);
});
