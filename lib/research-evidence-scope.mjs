import {selectResearchEvidence} from './research-evidence-package.mjs';
// Source-reading tools already enforce their own output budget. Keep those
// excerpts intact instead of silently removing their middle a second time.
export const evidenceTextLimit = toolName => ['web_fetch','deepseek_fetch','pdf_read'].includes(toolName)?64000:18000;
export function boundedEvidenceText(text,cap) {
  const original=String(text || '');
  if(original.length<=cap)return {text:original,truncated:false};
  return {text:original.slice(0,cap/2)+'\n[上下文节选，中间省略；不能据此声称原文不存在]\n'+original.slice(-cap/2),truncated:true,originalChars:original.length};
}

/** Scope failed attempts to the exact reviewed answer and actual tool receipts. */
export function resolvedToolFailures(items,timeline) {
  if(!Array.isArray(items))return [];
  const failures=new Set(timeline.filter(x=>x.role==='toolResult' && x.isError).map(x=>x.toolCallId));
  const partial=new Map(timeline.filter(x=>x.role==='toolResult' && x.toolName==='calc' && !x.isError &&
    x.receipt?.partial && x.receipt.failures?.length).map(x=>[x.toolCallId,new Set(x.receipt.failures.map(f=>f.index))]));
  const successes=new Set(timeline.filter(x=>x.role==='toolResult' && !x.isError && ['web_fetch','deepseek_fetch','pdf_read','workbook_query','workbook_trace','calc','model_whatif'].includes(x.toolName)).map(x=>x.toolCallId));
  return items.filter(x=>x && (x.index==null ? failures.has(x.id) : Number.isInteger(x.index) && partial.get(x.id)?.has(x.index)) && typeof x.reason==='string' && x.reason.trim() &&
    (x.disposition==='outside_scope' || (x.disposition==='replaced' && Array.isArray(x.evidenceIds) && x.evidenceIds.length && x.evidenceIds.every(id=>id!==x.id && successes.has(id)))));
}
export function auditTimeline(timeline,options=150000) {
  return selectResearchEvidence(timeline,typeof options==='number'?{maxChars:options}:options).timeline;
}

/** Only real, successful document reads can be reused; old assistant prose cannot. */
export function historicalSourceCalls(messages,question='') {
  if(/当前|最新|实时|今天|今日/.test(question))return [];
  const calls=new Map(),sources=new Map();
  for(const m of messages) {
    if(m.role==='assistant' && Array.isArray(m.content)) for(const c of m.content) {
      if(c.type==='toolCall' && ['web_fetch','deepseek_fetch'].includes(c.name))calls.set(c.id,c);
    }
    const c=calls.get(m.toolCallId);
    if(m.role!=='toolResult' || !c || m.isError!==false)continue;
    sources.set(c.id,{id:c.id,name:c.name,args:c.arguments,result:m,details:m.details,success:true,historical:true});
  }
  return [...sources.values()];
}
