// Read-only replay: compare numeric lint on existing drafts, without API calls
// or rewriting delivered history. Inputs must be explicit session JSONL files.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {indexGraph,cellMetadata} from '../lib/workbook-query.mjs';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
const text=m=>typeof m?.content==='string'?m.content:(m?.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n');
const counts=items=>items.reduce((out,f)=>(out[f.field||f.rule]=(out[f.field||f.rule]||0)+1,out),{});
for(const file of process.argv.slice(2)) {
 const rows=fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
 const root=path.resolve(path.dirname(file),'../..');
 const lint=rows.filter(r=>r.customType==='pe_answer_lint').at(-1)?.data;
 if(!lint)throw Error('session has no lint record');
 const delivery=rows.filter(r=>r.customType==='pe_turn_delivery').at(-1)?.data;
 const messages=rows.filter(r=>r.message).map(r=>r.message);
 const question=text(messages.find(m=>m.role==='user'));
 const draft=text(messages.findLast(m=>m.role==='assistant' && !m.content?.some?.(c=>c.type==='toolCall')));
 const graphs=new Map();
 const refreshed=new Map();
 const refresh=c=>{
  const key=JSON.stringify([c.id,c.locator,c.value]);if(refreshed.has(key))return refreshed.get(key);
  if(!c.storedFilename || !c.locator || !/\.xlsx$/.test(c.storedFilename))return c;
  const workbook=path.join(root,'uploads',path.basename(c.storedFilename));
  if(!fs.existsSync(workbook))return c;
  if(!graphs.has(workbook)) {
   const parsed=spawnSync('python3',['services/workbook/parse_workbook.py',workbook],{encoding:'utf8',maxBuffer:150e6});
   if(parsed.status!==0)throw Error(parsed.stderr);graphs.set(workbook,indexGraph(JSON.parse(parsed.stdout)));
  }
  const graph=graphs.get(workbook), raw=graph.cells.get(c.locator);
  const cell=raw?cellMetadata(raw,graph):null;
  const result=cell?{...c,display_unit:cell.display_unit,raw_unit:cell.unit,currency:cell.currency,period:cell.period || '',basis_type:cell.basis_type,scope:cell.scope,scenario:cell.scenario}:c;
  refreshed.set(key,result);return result;
 };
 const citations=lint.citations.map(refresh);
 const toolCalls=messages.filter(m=>m.role==='assistant').flatMap(m=>(m.content||[]).filter(c=>c.type==='toolCall')).map(c=>{
  const result=messages.find(m=>m.role==='toolResult' && m.toolCallId===c.id);
  return {id:c.id,name:c.name,args:c.arguments,success:!!result && !result.isError,result,details:result?.details};
 });
 const freshCalls=toolCalls.map(c=>{const details=c.details?{...c.details,...(c.details.citations?{citations:c.details.citations.map(refresh)}:{})}:undefined;return {...c,details,result:c.result?{...c.result,details}:undefined};});
 const before=financialEvidenceFindings(draft,{question,citations:lint.citations,toolCalls},[]);
 const after=financialEvidenceFindings(draft,{question,citations,toolCalls:freshCalls},[]);
 console.log(JSON.stringify({session:file,draftChars:draft.length,originalDeliveredChars:delivery?.text?.length,
  recordedFindings:counts(lint.findings),currentLintOldMetadata:counts(before),currentLintFreshMetadata:counts(after),
  remainingExamples:after.slice(0,3),note:'Offline numeric lint only; does not regenerate or certify this draft.'},null,2));
}
