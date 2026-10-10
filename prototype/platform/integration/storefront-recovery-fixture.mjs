// In-process synthetic data only. This fixture cannot call a restaurant core,
// payment provider, external identity service, or persistent database.
import assert from 'node:assert/strict';

export const pendingKey = 'restaurant-pending-order-v1';
export const cartKey = 'restaurant-cart-v1';
export const tableCode = 'synthetic-table';
export const customer = id => ({id, username:id, displayName:id === 'customer-A' ? 'Customer A' : 'Customer B', phone:'', addresses:[]});
const emptyAddress = () => ({country:'SA',city:'',district:'',street:'',building:'',postalCode:'',additionalNumber:'',nationalAddress:'',addressLine:'',area:'',latitude:null,longitude:null});
const settings = {name:'Synthetic recovery restaurant',description:'',address:'',phone:'',logoUrl:'',coverUrl:'',currency:'SAR',country:'SA',defaultLanguage:'en',menuLanguage:'en',demo:true,acceptingOrders:true,deliveryEnabled:false,pickupEnabled:false,tableEnabled:true,deliveryPricingMode:'flat',deliveryZones:[],deliveryFeeMinor:0,deliveryMinimumMinor:0,deliveryAreas:[],deliveryRadiusKm:0,latitude:null,longitude:null,requireDeliveryLocation:false,pickupInstructions:'',paymentInstructions:'',openingHours:'',taxEnabled:false,taxRateBps:0,taxNumber:'',paymentMethods:{table:['cash_after'],delivery:[],pickup:[]}};
export const catalog = {version:1,settings,categories:[{id:'main',name:'Synthetic dishes',sort:0}],items:[
  {id:'dish-A',categoryId:'main',name:'Synthetic dish A',description:'Test only',priceMinor:1000,imageUrl:'',available:true,sort:0,options:[]},
  {id:'dish-B',categoryId:'main',name:'Synthetic dish B',description:'Test only',priceMinor:700,imageUrl:'',available:true,sort:1,options:[]},
],tables:[{id:'table-A',name:'Synthetic table',code:tableCode,active:true}]};

export function quoteFor(input) {
  assert.equal(input.mode,'table');
  assert.equal(input.tableCode,tableCode);
  assert.equal(input.paymentMethod,'cash_after');
  assert.equal(input.paymentProvider,'');
  assert.ok(Array.isArray(input.items) && input.items.length > 0);
  const items = input.items.map(line => {
    const item = catalog.items.find(item => item.id === line.itemId);
    assert.ok(item && Number.isInteger(line.quantity) && line.quantity > 0 && line.quantity <= 99);
    assert.deepEqual(line.optionIds,[]);
    return {itemId:item.id,name:item.name,quantity:line.quantity,unitPriceMinor:item.priceMinor,totalMinor:item.priceMinor*line.quantity,options:[]};
  });
  const totalMinor = items.reduce((total,item)=>total+item.totalMinor,0);
  return {items,subtotalMinor:totalMinor,deliveryFeeMinor:0,totalMinor,currency:'SAR',demo:true,tableName:'Synthetic table',paymentMethods:['cash_after'],tax:{enabled:false,rateBps:0,number:'',netMinor:totalMinor,taxMinor:0,grossMinor:totalMinor}};
}
function receiptFor(number,input) {
  const quote = quoteFor(input), at = '2026-10-10T00:00:00Z';
  return {order:{...quote,number,version:1,status:'new',mode:'table',customerName:input.customerName??'Synthetic guest',phone:'',address:emptyAddress(),tableId:'table-A',tableChanges:[],notes:input.notes??'',createdAt:at,updatedAt:at,deliveryEvents:[],payment:{method:'cash_after',provider:'',status:'unpaid',amountMinor:quote.totalMinor}},trackingToken:`synthetic-token-${number}`,accessCode:`CODE${number}`};
}
const response = (body,status=200) => ({status,body});

export function createRecoveryFixture({initialCustomer=null}={}) {
  let activeCustomer = initialCustomer, sequence = 10;
  const requests = [], unexpected = [], orders = new Map(), submissions = new Map(), holds = new Map();
  const seedInput = {mode:'table',tableCode,paymentMethod:'cash_after',paymentProvider:'',items:[{itemId:'dish-A',quantity:1,optionIds:[]}]};
  for (const number of ['R00000001','R00000002']) orders.set(number,{receipt:receiptFor(number,seedInput),owner:''});
  function hold(method,path) {
    const key = `${method} ${path}`;
    assert.equal(holds.has(key),false,'only one active hold for a route');
    let entered, release;
    const seen = new Promise(resolve=>{entered=resolve;});
    const gate = new Promise(resolve=>{release=resolve;});
    const value = {entered,gate,release}; holds.set(key,value);
    return {entered:seen,release(override){holds.delete(key);release(override);}};
  }
  async function handle(method,path,body=null,headers={}) {
    const request = {method,path,body:structuredClone(body),headers:{...headers},customerId:activeCustomer?.id??''};
    requests.push(request);
    if (headers['x-api-key']) unexpected.push('master key on public fixture request');
    const key = `${method} ${path}`, blocked = holds.get(key);
    let result;
    if (key==='GET /catalog') result=response(catalog);
    else if (key==='GET /account') result=response({customer:activeCustomer});
    else if (key==='GET /account/orders') result=response({orders:[...orders.values()].filter(entry=>entry.owner===activeCustomer?.id).map(entry=>entry.receipt.order)});
    else if (key==='GET /opening-status') result=response({version:1,scheduleEnabled:false,withinHours:null,acceptingOrders:true,timeZone:'Asia/Riyadh',evaluatedAt:new Date().toISOString()});
    else if (key==='GET /payments') result=response({providers:[]});
    else if (key===`GET /tables/${tableCode}`) result=response(catalog.tables[0]);
    else if (key==='POST /quote') result=response(quoteFor(body));
    else if (key==='POST /orders') {
      assert.match(headers['idempotency-key']??'',/^[0-9a-f-]{36}$/);
      assert.match(body.expectedQuoteHash??'',/^[0-9a-f]{64}$/);
      const saved = submissions.get(headers['idempotency-key']);
      if (saved) {
        if(saved.owner!==request.customerId || JSON.stringify(saved.input)!==JSON.stringify(body)) result=response({error:'idempotency_conflict'},409);
        else result=response(saved.receipt);
      } else {
        const quote=quoteFor(body); assert.equal(body.expectedTotalMinor,quote.totalMinor);
        const receipt=receiptFor(`R${String(++sequence).padStart(8,'0')}`,body);
        const entry={receipt,owner:request.customerId,input:structuredClone(body)};
        submissions.set(headers['idempotency-key'],entry);orders.set(receipt.order.number,entry);result=response(receipt);
      }
    } else if(key==='POST /orders/lookup') {
      const entry=orders.get(body?.number);
      result=entry && entry.receipt.accessCode===body.accessCode ? response(entry.receipt) : response({error:'invalid_order_access'},403);
    } else if(key==='POST /account/logout') {activeCustomer=null;result=response(null,204);}
    else if(key==='POST /account/login') {
      assert.ok(['customer-A','customer-B'].includes(body?.username));
      assert.equal(body.password,'synthetic-password-only');
      activeCustomer=customer(body.username);result=response({customer:activeCustomer});
    } else if(method==='GET' && /^\/orders\/R\d+(?:\/refunds)?$/.test(path)) {
      const number=path.split('/')[2], entry=orders.get(number);
      if(!entry || (headers['x-order-token']!==entry.receipt.trackingToken && (!entry.owner || entry.owner!==activeCustomer?.id))) result=response({error:'invalid_order_access'},403);
      else result=response(path.endsWith('/refunds')?{refunds:[]}:entry.receipt.order);
    } else {unexpected.push(key);result=response({error:'not_found'},404);}
    if(blocked){blocked.entered(request);const override=await blocked.gate;if(override)result=override;}
    return structuredClone(result);
  }
  return {handle,hold,requests,unexpected,submissions,orders,releaseAll(){for(const entry of holds.values())entry.release();holds.clear();}};
}
