import {createHash} from 'node:crypto';
import {coreQuoteSchema} from './core-adapter.mjs';

// Go's JSON encoder escapes HTML characters and U+2028/U+2029. Keep the
// versioned positional encoding byte-identical across the two runtimes.
export function quoteBinding(value){
  const q=coreQuoteSchema.parse(value),tax=q.tax;
  const data=JSON.stringify(['onlinu-quote-v1',q.currency,q.subtotalMinor,q.deliveryFeeMinor,q.totalMinor,q.demo,q.tableName??'',q.paymentMethods,
    [tax.enabled,tax.rateBps,tax.number,tax.netMinor,tax.taxMinor,tax.grossMinor],
    q.items.map(item=>[item.itemId,item.name,item.quantity,item.unitPriceMinor,item.totalMinor,
      (item.options??[]).map(option=>[option.id,option.name,option.priceMinor,option.available])]),
  ]).replace(/[<>&\u2028\u2029]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
  return createHash('sha256').update(data).digest('hex');
}
