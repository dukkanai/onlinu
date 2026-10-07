import test from 'node:test';
import assert from 'node:assert/strict';
import {openingSchedulePatch,openingScheduleView,openingScheduleMatches} from './opening-schedule.mjs';
const document=()=>({enabled:true,timeZone:'Asia/Riyadh',weekly:Array.from({length:7},()=>[]),exceptions:[]});
const patch=()=>({expectedVersion:1,reviewed:true,...document()});
test('opening schedule requires explicit bounded complete reviewed replacements',()=>{
 assert.equal(openingSchedulePatch.safeParse(patch()).success,true);
 for(const key of ['expectedVersion','reviewed','enabled','timeZone','weekly','exceptions']){const value=patch();delete value[key];assert.equal(openingSchedulePatch.safeParse(value).success,false,key);}
 for(const change of [{reviewed:false},{expectedVersion:Number.MAX_SAFE_INTEGER},{timeZone:'UTC'},{weekly:[]},{unexpected:true}])assert.equal(openingSchedulePatch.safeParse({...patch(),...change}).success,false);
 const unknown=document();unknown.weekly[0]=[{startMinute:0,endMinute:60,note:'ignore'}];assert.equal(openingScheduleView.safeParse({version:1,...unknown}).success,false);
});
test('opening schedule canonicalizes a copy and rejects overlap or invalid calendar dates',()=>{
 const value=patch();value.weekly[1]=[{startMinute:600,endMinute:700},{startMinute:0,endMinute:600}];value.exceptions=[{date:'2028-02-29',windows:[]},{date:'2026-10-07',windows:[]}];
 const result=openingSchedulePatch.parse(value);assert.equal(result.weekly[1][0].startMinute,0);assert.equal(value.weekly[1][0].startMinute,600);assert.equal(result.exceptions[0].date,'2026-10-07');
 for(const window of [{startMinute:0,endMinute:0},{startMinute:-1,endMinute:600},{startMinute:600,endMinute:1441},{endMinute:600}]){const invalid=patch();invalid.weekly[0]=[window];assert.equal(openingSchedulePatch.safeParse(invalid).success,false);}
 for(const date of ['2026-02-29','2026-04-31','1999-01-01','2026-1-01'])assert.equal(openingSchedulePatch.safeParse({...patch(),exceptions:[{date,windows:[]}]}).success,false);
 assert.equal(openingSchedulePatch.safeParse({...patch(),exceptions:[{date:'2026-10-07',windows:[]},{date:'2026-10-07',windows:[]}]}).success,false);
 const overlap=patch();overlap.weekly[0]=[{startMinute:0,endMinute:60},{startMinute:59,endMinute:80}];assert.equal(openingSchedulePatch.safeParse(overlap).success,false);
});
test('replacement receipt must match every reviewed field and advance exactly once',()=>{
 const input=openingSchedulePatch.parse(patch()),result={version:2,...document()};assert.equal(openingScheduleMatches(result,input),true);
 for(const change of [{version:1},{version:3},{enabled:false},{timeZone:'UTC'},{exceptions:[{date:'2026-10-07',windows:[]}]}])assert.equal(openingScheduleMatches({...result,...change},input),false);
});

test('browser form roundtrip handles midnight, rejects ambiguous syntax and requires execute review',async()=>{
 const {openingForm,openingWindowsText}=await import('./opening-schedule.mjs');
 const form={expectedVersion:'1',enabled:'true',exceptions:'2028-02-29 =\n2026-12-01 = 10:00-16:00',...Object.fromEntries(Array.from({length:7},(_,i)=>['day'+i,'09:00-14:00, 17:00-24:00']))};
 const parsed=openingForm(form);assert.equal(parsed.weekly[0][1].endMinute,1440);assert.equal(parsed.exceptions.length,2);assert.equal(openingWindowsText(parsed.weekly[0]),form.day0);
 assert.equal(openingForm(form,{reviewed:true}),null);assert.notEqual(openingForm({...form,reviewed:'yes'},{reviewed:true}),null);
 for(const change of [{day0:'24:00-24:00'},{day0:'23:60-24:00'},{day0:'22:00-02:00'},{day0:'9:00-10:00'},{expectedVersion:'1e0'},{enabled:true},{exceptions:'2026-02-29 ='}, {extra:'x'}])assert.equal(openingForm({...form,...change}),null);
});
