import test from 'node:test';
import assert from 'node:assert/strict';
import {quoteBinding} from './quote-binding.mjs';
const quote={currency:'SAR',subtotalMinor:100,deliveryFeeMinor:0,totalMinor:100,demo:true,paymentMethods:['cash_on_delivery'],
  tax:{enabled:false,rateBps:0,number:'',netMinor:100,taxMinor:0,grossMinor:100},
  items:[{itemId:'rice',name:'<Rice>&\u2028🍚',quantity:1,unitPriceMinor:100,totalMinor:100,
    options:[{id:'extra',name:'Free\u2029Sauce',priceMinor:0,available:true}]}]};
test('quote binding shares Go golden bytes including HTML and Unicode separators',()=>{
  assert.equal(quoteBinding(quote),'896ee9e55665b5ed69b6a17f4f72898438f91eb334e68a6bc22b820d4f32f542');
  assert.equal(quoteBinding({...quote,tableName:''}),quoteBinding(quote));
  const changed=structuredClone(quote);changed.items[0].name='Different';
  assert.notEqual(quoteBinding(changed),quoteBinding(quote));
  changed.items=quote.items;changed.tax={...quote.tax,enabled:true,rateBps:1500,netMinor:87,taxMinor:13};
  assert.notEqual(quoteBinding(changed),quoteBinding(quote));
});
