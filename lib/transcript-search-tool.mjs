import {Type} from 'typebox';
import {searchLedger} from './ledger.mjs';
const textOf=c=>typeof c==='string'?c:(Array.isArray(c)?c.filter(b=>b.type==='text').map(b=>b.text||'').join('\n'):'');
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function searchTranscript(messages=[],opts={}) {
  const terms=String(opts.query||'').trim().split(/\s+/).filter(Boolean).slice(0,20);
  const limit=Math.max(1,Math.min(50,Number(opts.limit)||5));
  let turn=0;const rows=[];const scanned=new Set();
  for(const m of messages) {
    if(m.peInternal||m.customType||m.role==='custom') continue;
    if(m.role==='user') turn++;
    if(!['user','assistant'].includes(m.role)||!turn) continue;
    if(m.role==='assistant'&&(m.stopReason&&m.stopReason!=='stop'||Array.isArray(m.content)&&m.content.some(b=>b.type==='toolCall'))) continue;
    if(opts.turn!=null&&turn!==Number(opts.turn)) continue;
    if(opts.turnRange&&(turn<opts.turnRange[0]||turn>opts.turnRange[1])) continue;
    scanned.add(turn);
    const text=textOf(m.content); const lower=text.toLowerCase();
    if(!terms.length||!terms.every(t=>lower.includes(t.toLowerCase()))) continue;
    const pos=Math.min(...terms.map(t=>lower.indexOf(t.toLowerCase())));
    const excerpt=text.slice(Math.max(0,pos-200),Math.min(text.length,pos+Math.max(...terms.map(t=>t.length))+200));
    const re=new RegExp(terms.map(escape).sort((a,b)=>b.length-a.length).join('|'),'gi');
    rows.push({turn,role:m.role,timestamp:m.timestamp??null,excerpt:excerpt.replace(re,m=>`**${m}**`)});
  }
  return {matches:rows.slice(0,limit),totalMatches:rows.length,coverage:{turnsScanned:scanned.size,turns:[...scanned],totalTurns:turn,truncated:rows.length>limit}};
}
export function createTranscriptSearchTool({getMessages,getLedger}) {
  return {name:'transcript_search',label:'检索前文与台账',description:'搜索本会话前文用户问题与助手最终回答，并同时检索本会话台账（用户主张/更正/事实），返回轮次、角色、摘录与覆盖范围。',
    promptSnippet:'transcript_search：检索本会话历史问答并返回台账命中',promptGuidelines:['自查、复核前文或「你之前说过」类问题必须先调用 transcript_search；它同时返回 ledgerMatches（可为空）。逐条核对 claim/correction，金额用 unit_convert/calc；没有候选人写「未发现候选人」，不得靠记忆声称「全部正确/没有十倍错误」。'],
    parameters:Type.Object({query:Type.String({minLength:1}),turn:Type.Optional(Type.Integer({minimum:1})),turnRange:Type.Optional(Type.Array(Type.Integer({minimum:1}),{minItems:2,maxItems:2})),limit:Type.Optional(Type.Integer({minimum:1,maximum:50}))}),
    execute:async(_id,p)=>{if(!String(p.query||'').trim())return {content:[{type:'text',text:'query 不能为空'}],isError:true};const messages=getMessages();const transcript=searchTranscript(messages,p);let ledger=null,ledgerResult=null;if(getLedger){ledger=await getLedger();ledgerResult=searchLedger(ledger,p);}const details={...transcript,...(ledger?{ledger,ledgerMatches:ledgerResult.matches,ledgerTotalMatches:ledgerResult.totalMatches,ledgerCoverage:ledgerResult.coverage}:{})};return {content:[{type:'text',text:JSON.stringify(details)}],details};}};
}
