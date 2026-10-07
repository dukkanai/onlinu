import {z} from 'zod';

const windowSchema=z.object({startMinute:z.number().int().min(0).max(1439),endMinute:z.number().int().min(1).max(1440)}).strict().refine(v=>v.startMinute<v.endMinute);
const windows=z.array(windowSchema).max(8).transform(rows=>rows.toSorted((a,b)=>a.startMinute-b.startMinute)).refine(rows=>rows.every((v,i)=>i===0||rows[i-1].endMinute<=v.startMinute));
const date=z.string().regex(/^[2-9][0-9]{3}-[0-9]{2}-[0-9]{2}$/).refine(value=>{const parsed=new Date(value+'T00:00:00Z');return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;});
const fields={enabled:z.boolean(),timeZone:z.literal('Asia/Riyadh'),weekly:z.array(windows).length(7),exceptions:z.array(z.object({date,windows}).strict()).max(64).refine(rows=>new Set(rows.map(v=>v.date)).size===rows.length).transform(rows=>rows.toSorted((a,b)=>a.date.localeCompare(b.date)))};
export const openingScheduleView=z.object({version:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),...fields}).strict();
export const openingSchedulePatch=z.object({expectedVersion:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER-1),reviewed:z.literal(true),...fields}).strict();

// Compare the complete canonical replacement, not merely its revision. An
// ambiguous response is never permission to replay a schedule mutation.
export function openingScheduleMatches(result,input){
 return result.version===input.expectedVersion+1&&result.enabled===input.enabled&&result.timeZone===input.timeZone&&JSON.stringify(result.weekly)===JSON.stringify(input.weekly)&&JSON.stringify(result.exceptions)===JSON.stringify(input.exceptions);
}

export const openingDayNames=['الأحد','الإثنين','الثلاثاء','الأربعاء','الخميس','الجمعة','السبت'];
const timeText=minutes=>String(Math.floor(minutes/60)).padStart(2,'0')+':'+String(minutes%60).padStart(2,'0');
export const openingWindowsText=rows=>rows.map(row=>timeText(row.startMinute)+'-'+timeText(row.endMinute)).join(', ');
export function openingForm(input,{reviewed=false}={}){
 const keys=['csrf','expectedVersion','enabled','exceptions','reviewed',...openingDayNames.map((_,i)=>'day'+i)];
 if(!input||Object.keys(input).some(key=>!keys.includes(key))||!/^\d{1,16}$/.test(input.expectedVersion)||!['true','false'].includes(input.enabled)||reviewed&&input.reviewed!=='yes')return null;
 function parseWindows(text){
  if(typeof text!=='string'||text.length>160)throw Error();if(!text.trim())return [];
  return text.split(',').map(part=>{
   const match=/^\s*([0-9]{2}):([0-9]{2})-([0-9]{2}):([0-9]{2})\s*$/.exec(part);if(!match)throw Error();
   const [,h1,m1,h2,m2]=match.map(Number);if(h1>23||m1>59||h2>24||m2>59||h2===24&&m2!==0)throw Error();
   return{startMinute:h1*60+m1,endMinute:h2*60+m2};
  });
 }
 try{
  if(typeof input.exceptions!=='string'||input.exceptions.length>12000)throw Error();
  const exceptions=input.exceptions.trim()?input.exceptions.trim().split(/\r?\n/).map(line=>{const match=/^(\d{4}-\d{2}-\d{2})\s*=\s*(.*)$/.exec(line.trim());if(!match)throw Error();return{date:match[1],windows:parseWindows(match[2])};}):[];
  const result=openingSchedulePatch.safeParse({expectedVersion:Number(input.expectedVersion),reviewed:true,enabled:input.enabled==='true',timeZone:'Asia/Riyadh',weekly:openingDayNames.map((_,i)=>parseWindows(input['day'+i])),exceptions});
  return result.success?result.data:null;
 }catch{return null;}
}
