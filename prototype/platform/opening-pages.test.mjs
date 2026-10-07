import test from 'node:test';
import assert from 'node:assert/strict';
import {staffOpeningPage} from './opening-pages.mjs';
const data={version:1,enabled:false,timeZone:'Asia/Riyadh',weekly:Array.from({length:7},()=>[]),exceptions:[]};
test('schedule editor and review escape content, keep read-only users out and surface uncertainty',()=>{
 const args={tenantId:'<a>',data,csrf:'<csrf>',canUpdate:true};
 const edit=staffOpeningPage(args);assert.match(edit,/&lt;a&gt;/);assert.match(edit,/&lt;csrf&gt;/);assert.match(edit,/day6/);assert.match(edit,/\/review/);assert.doesNotMatch(edit,/\/execute/);
 const read=staffOpeningPage({...args,canUpdate:false});assert.doesNotMatch(read,/<button>/);assert.match(read,/readonly/);
 const review=staffOpeningPage({...args,review:{expectedVersion:1,...data}});assert.match(review,/\/execute/);assert.match(review,/name="reviewed"/);assert.match(review,/إلغاء والعودة/);
 assert.match(staffOpeningPage({...args,outcome:'unknown'}),/role="alert"/);
});
