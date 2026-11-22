import {createHash} from 'node:crypto';
import {MARKET_QUANTITY_FIELDS} from './market-evidence.mjs';

const sourceTools=new Set(['workbook_query','workbook_trace','model_whatif','calc','ratio','unit_convert','web_fetch','deepseek_fetch','pdf_read','westock_query','anysearch_search','deepseek_search','web_search']);
const calculationTools=new Set(['model_whatif','calc','ratio','unit_convert']);
const aliases=[['现价','股价','行情','收盘','price'],['年内','ytd','chg_ytd'],['52周','52week','high_52week','low_52week'],
 ...MARKET_QUANTITY_FIELDS.map(d=>[...d.aliases,d.field]),['市盈率','pe_ratio','p/e'],['股本','total_shares'],['市值','market_cap'],['汇率','fx'],['收入','revenue'],['净利润','net profit'],['现金流','cash flow']];
const segmenter=new Intl.Segmenter('zh',{granularity:'word'});
const stop=new Set(['模型','报告','数据','来源','分析','公司','当前','本次','需要','判断','投资','以及','其中','可以','the','and','for','from','with','this','that']);
const terms=text=>new Set([...segmenter.segment(String(text).toLowerCase())].filter(x=>x.isWordLike && x.segment.length>1 && !/^\d+$/.test(x.segment) && !stop.has(x.segment)).map(x=>x.segment));
const hash=s=>createHash('sha256').update(s).digest('hex');
const size=o=>JSON.stringify(o).length;
export function recoveryEvidenceRows(pack) {
 const rows=pack.timeline.filter(row=>row.role==='toolResult').map(row=>({...row,id:row.toolCallId,name:row.toolName}));
 if(!pack.catalog.length && !rows.length)return [];
 return rows.concat({name:'evidence_coverage',isError:false,text:JSON.stringify({coverage:pack.coverage,catalog:pack.catalog}),metadataOnly:true});
}
const packageSize=pack=>Math.max(size(pack),size(recoveryEvidenceRows(pack)));
function matchingTerms(text,wanted){const found=terms(text);return [...wanted].filter(t=>found.has(t)).length;}
function sanitized(timeline){
 const calls=new Map(timeline.flatMap(row=>(row.calls || []).map(call=>[call.id,call])));
 return timeline.flatMap(row=>{
  if(row.role==='assistant' && !row.calls?.length)return [];
  if(row.role==='assistant')return [{...row,text:'',calls:row.calls.map(c=>{
   const {content,claims,sources,oldText,newText,edits,...args}=c.arguments || {};
   return {...c,arguments:['write','edit','review_research'].includes(c.name)?{...args,...(Array.isArray(edits)?{editCount:edits.length}:{})}:c.arguments};
  })}];
  if(row.role==='toolResult' && ['read','write','edit','review_research'].includes(row.toolName))return [{...row,text:
   row.toolName==='read'?row.text:row.isError?'此前产物操作未成功；旧草稿及错误信息不是财务证据。':'此前产物操作已返回；文件状态须以当前回读回执为准。',evidenceRole:'workflow_status'}];
  return [{...row,...(calls.has(row.toolCallId)?{arguments:calls.get(row.toolCallId).arguments}:{})}];
 });
}

// Selection ranks semantic context and explicit references, never equal numbers.
// It is NOT a truth/approval cache: every consumer still checks the current claim.
export function selectResearchEvidence(timeline,{draft='',question='',sourceIds=[],maxChars=150000}={}){
 if(!Number.isInteger(maxChars) || maxChars<256)throw new RangeError('Evidence budget must be an integer >= 256');
 const wanted=terms(draft+'\n'+question),pinned=new Set(sourceIds);
 const referenceText=draft+'\n'+question;
 const concepts=aliases.filter(a=>a.some(t=>referenceText.toLowerCase().includes(t.toLowerCase())));
 const rankText=text=>matchingTerms(text,wanted)+concepts.reduce((n,a)=>n+(a.some(t=>text.toLowerCase().includes(t.toLowerCase()))?4:0),0);
 const clean=sanitized(timeline),turnStart=clean.findLastIndex(r=>r.role==='user');
 const rows=clean.map((row,index)=>{
  const text=String(row.text || ''),args=JSON.stringify(row.arguments || {});
  const urls=[...text.matchAll(/https?:\/\/[^\s)\]"<>]+/g)].map(m=>m[0]);
  const explicit=!!row.toolCallId && (pinned.has(row.toolCallId) || referenceText.includes(row.toolCallId)) || urls.some(url=>referenceText.includes(url));
  const source=row.role==='toolResult' && sourceTools.has(row.toolName) && !row.isError;
  const score=rankText(text)+rankText(args)*2;
  // Calculation receipts are atomic executions, not prose. A scenario may be
  // named only in the report while its receipt uses cell locators. Word overlap
  // must not let large workbook dumps evict its inputs and actual outputs.
  const calculation=source && calculationTools.has(row.toolName);
  return {row:{...row,text},index,source,explicit,calculation,currentCalculation:calculation && (index>=turnStart || explicit),score};
 });
 // Broad workbook dumps share many generic words with a long report. Without
 // per-concept coverage they crowd out compact, specific quote receipts even
 // under relevance ranking. Reserve the strongest original receipts for each
 // mentioned concept, including a second source that may correct the first.
 const anchors=new Set();
 for(const concept of concepts){
  const candidates=rows.filter(r=>r.source && concept.some(t=>String(r.row.text).toLowerCase().includes(t.toLowerCase())));
  const specific=r=>concept.some(t=>r.row.text.toLowerCase().includes('| '+t+' |') || r.row.text.toLowerCase().includes('"'+t+'":'))?1000:0;
  candidates.sort((a,b)=>specific(b)-specific(a) || (b.score+1)/Math.sqrt(b.row.text.length+100)-(a.score+1)/Math.sqrt(a.row.text.length+100) || a.index-b.index);
  for(const candidate of candidates.slice(0,2))anchors.add(candidate);
 }
 // Atomic executions in this turn (or explicitly reused from an older turn)
 // are allocated before long prose, including pinned source documents. Pins
 // cannot consume the budget first and silently erase derived evidence.
 const tier=item=>item.currentCalculation?0:item.explicit?1:anchors.has(item)?2:item.source?3:4;
 // Immutable receipt IDs and fingerprints make exclusions visible without
 // confusing old drafts or metadata with supporting evidence.
 const catalog=rows.filter(r=>r.source).map(r=>({id:r.row.toolCallId,tool:r.row.toolName,sha256:hash(r.row.text),originalChars:r.row.text.length}));
 const selection=[],omitted=[],budget=Math.max(0,maxChars-Math.min(12000,Math.floor(maxChars*.2)));
 let used=2;
 for(const item of rows.toSorted((a,b)=>tier(a)-tier(b) || b.score-a.score || a.index-b.index)){
  const cap=Math.min(item.source?32000:4000,Math.max(0,budget-used-500));
  const excerpt=item.calculation && item.row.text.length>cap
   ? {text:'',truncated:true,originalChars:item.row.text.length}
   : excerptEvidence(item.row.text || '',cap,rankText);
  const row={...item.row,...excerpt};
  const chars=size(row)+1;
  if(!excerpt.text && !row.calls?.length || used+chars>budget){if(item.source)omitted.push(item.row.toolCallId);continue;}
  selection.push({row,index:item.index,explicit:item.explicit,score:item.score});used+=chars;
 }
 selection.sort((a,b)=>a.index-b.index);
 const keptIds=new Set(selection.map(x=>x.row.toolCallId));
 const manifest=catalog.map(c=>({...c,included:keptIds.has(c.id),excerpted:selection.some(x=>x.row.toolCallId===c.id && x.row.truncated)}));
 const coverage={status:omitted.length || selection.some(x=>x.row.truncated)?'limited':'covered',omittedCount:omitted.length,omittedIds:omitted,
  note:'未包含或节选的来源不等于没有取得。catalog 只证明回执存在，不能替代原文核验；未见原文的主张应标为本次输入未覆盖，不得虚构数值错误。'};
 const pack={timeline:selection.map(x=>x.row),coverage,catalog:[...manifest]};
 while(packageSize(pack)>maxChars && pack.catalog.length)pack.catalog.pop();
 if(pack.catalog.length<manifest.length)coverage.catalogTruncated=true;
 while(packageSize(pack)>maxChars && coverage.omittedIds.length){coverage.omittedIds.pop();coverage.omittedIdsTruncated=true;}
 while(packageSize(pack)>maxChars && pack.timeline.length){const row=pack.timeline.pop();coverage.status='limited';
  const item=pack.catalog.find(c=>c.id===row.toolCallId);if(item?.included){item.included=false;coverage.omittedCount++;}
 }
 if(packageSize(pack)>maxChars)return {timeline:[],coverage:{status:'limited'},catalog:[]};
 return pack;
}

function excerptEvidence(text,cap,rank){
 if(text.length<=cap)return {text,truncated:false,originalChars:text.length};
 // Keep whole paragraph/table blocks and adjacent qualification, not naked
 // numbers or chopped table rows. An oversized indivisible block stays omitted.
 const blocks=text.split(/\n\s*\n/),picked=new Set(),order=blocks.map((text,i)=>({i,score:rank(text)})).sort((a,b)=>b.score-a.score || a.i-b.i);
 let used=120;
 for(const {i,score} of order){
  if(score===0 && picked.size)continue;
  const group=[Math.max(0,i-1),i,Math.min(blocks.length-1,i+1)].filter((n,k,a)=>a.indexOf(n)===k && !picked.has(n));
  const cost=group.reduce((n,j)=>n+blocks[j].length+2,0);
  if(cost+used>cap)continue;
  group.forEach(j=>picked.add(j));used+=cost;
 }
 if(!picked.size)return {text:'',truncated:true,originalChars:text.length};
 return {text:'[来源原文节选；省略部分不能据此判不存在]\n'+[...picked].sort((a,b)=>a-b).map(i=>blocks[i]).join('\n\n'),truncated:true,originalChars:text.length};
}
