import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {evidenceTimeline} from '../lib/research-audit.mjs';
import {selectResearchEvidence} from '../lib/research-evidence-package.mjs';
import {researchRecoveryToolEvidence} from '../lib/research-delivery.mjs';
globalThis.fetch=()=>{throw Error('Network disabled');};
const [input,output]=process.argv.slice(2);
const rows=fs.readFileSync(input,'utf8').trim().split('\n').map(JSON.parse),history=[],results=[];
let question='';
for(const row of rows){const m=row.message;if(!m)continue;
 if(m.role==='user')question=typeof m.content==='string'?m.content:m.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
 if(m.role==='assistant')for(const call of m.content || []){
  if(call.type!=='toolCall' || !['review_research','write'].includes(call.name) || !call.arguments?.path?.endsWith('.md'))continue;
  const options={draft:call.arguments.content || '',question};
  const pack=selectResearchEvidence(evidenceTimeline(history),options);
  const recovery=researchRecoveryToolEvidence(history,options).filter(r=>!r.metadataOnly);
  assert.deepEqual(recovery.map(r=>[r.toolCallId,r.text]),pack.timeline.filter(r=>r.role==='toolResult').map(r=>[r.toolCallId,r.text]));
  assert.ok(JSON.stringify(pack).length<=150000);
  const timeline=evidenceTimeline(history);
  const calculations=timeline.filter(r=>['calc','model_whatif','ratio','unit_convert'].includes(r.toolName) && !r.isError);
  const quotes=timeline.filter(r=>r.toolName==='westock_query' && !r.isError && /high_52week/.test(r.text));
  results.push({reportCall:call.id,tool:call.name,chars:JSON.stringify(pack).length,coverage:pack.coverage,quotes:quotes.map(q=>{
   const kept=pack.timeline.find(r=>r.toolCallId===q.toolCallId);
   return {id:q.toolCallId,retained:!!kept,identical:kept?.text===q.text,hasYtd:!!kept?.text.includes('chg_ytd'),hasHigh:!!kept?.text.includes('high_52week')};
  }),calculationReceipts:calculations.map(q=>{
   const kept=pack.timeline.find(r=>r.toolCallId===q.toolCallId);
   return {id:q.toolCallId,tool:q.toolName,retained:!!kept,identical:kept?.text===q.text,
    structuredReceiptIdentical:!!kept && JSON.stringify(kept.receipt)===JSON.stringify(q.receipt),hasArguments:!!kept?.arguments};
  })});
 }
 history.push(m);
}
if(process.argv.includes('--require-calculations'))for(const r of results)
 assert.ok(r.calculationReceipts.every(c=>c.retained && c.identical && c.structuredReceiptIdentical && c.hasArguments),`Calculation receipt omitted or altered at ${r.reportCall}`);
fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify({network:false,results},null,2));
console.log(JSON.stringify({network:false,reviews:results.length,quotes:results.map(r=>r.quotes),maxChars:Math.max(...results.map(r=>r.chars))},null,2));
