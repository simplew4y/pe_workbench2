import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {researchPortion} from '../server/agent/answer-delivery.mjs';
import {findingKey} from '../lib/evidence-reconciliation.mjs';
import {artifactDeliveryFindings,artifactDeliverySummary} from '../lib/artifact-delivery.mjs';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {runWithPostAnswer} from '../server/agent/post-answer.mjs';
import {publishFinalReport} from '../lib/report-publication.mjs';
const args=process.argv.slice(2);
const turnArg=args.find(arg=>arg.startsWith('--turn='));
const [input,output,projectRoot]=args.filter(arg=>!arg.startsWith('--'));
if(!input || !output)throw new Error('Usage: node scripts/replay-research-delivery.mjs session.jsonl output-dir [project-root] [--turn=N]');
globalThis.fetch=()=>{throw new Error('Network disabled in recorded replay');};
const allRows=fs.readFileSync(input,'utf8').trim().split('\n').map(JSON.parse);
// A multi-round session is replayed one user turn at a time. Earlier turns are
// restored as prior history; later turns are never fed into this turn.
const turnStarts=allRows.flatMap((row,index)=>row.customType==='pe_turn_started'?[index]:[]);
const turn=turnArg?Number(turnArg.slice('--turn='.length)):null;
if(turn!==null && !(Number.isInteger(turn) && turn>=1 && turn<=turnStarts.length))throw new Error(`--turn must be 1..${turnStarts.length}`);
const rows=turn===null?allRows:allRows.slice(turnStarts[turn-1],turnStarts[turn] ?? allRows.length);
const priorRows=turn===null?[]:allRows.slice(0,turnStarts[turn-1]);
const priorMessages=priorRows.filter(r=>r.message).map(r=>r.message);
const visibleHistory=priorRows.filter(r=>r.customType==='pe_turn_delivery').map(r=>r.data?.text).filter(Boolean);
const messages=rows.filter(r=>r.message).map(r=>r.message);
const text=m=>typeof m?.content==='string'?m.content:(m?.content || []).filter(p=>p.type==='text').map(p=>p.text).join('\n');
const question=text(messages.find(m=>m.role==='user'));
const calls=[],pending=new Map(),files=new Map(),recordedReceipts=new Map();
const hash=s=>createHash('sha256').update(s).digest('hex');
const fileReceipts=()=>[...new Map([...files].map(([filename,content])=>[filename,hash(content)]).concat([...recordedReceipts])).entries()].flatMap(([filename,digest])=>{
 if(!projectRoot)return [];
 const dest=path.resolve(projectRoot,filename),exportsRoot=path.resolve(projectRoot,'exports')+path.sep;
 return dest.startsWith(exportsRoot) && fs.existsSync(dest) && hash(fs.readFileSync(dest))===digest?[{path:filename,saved:true,sha256:digest}]:[];
});
fs.mkdirSync(output,{recursive:true});
let draft='',draftMessage,index=0;const results=[],draftMessages=[],lintRecords=[];
for(const row of rows) {
 const message=row.message;
 if(message?.role==='assistant')for(const c of Array.isArray(message.content)?message.content:[])if(c.type==='toolCall')pending.set(c.id,c);
 if(message?.role==='toolResult' && pending.has(message.toolCallId)) {
  const c=pending.get(message.toolCallId);
  calls.push({id:c.id,name:c.name,args:c.arguments,success:!message.isError,result:message,details:message.details});
  if(!message.isError)for(const match of text(message).matchAll(/\[research_write_verified\]\s+([^\n]+?)\s+sha256=([a-f0-9]{64})/g))recordedReceipts.set(match[1],match[2]);
  if(!message.isError && typeof c.arguments?.path==='string') {
   if(c.name==='write' && typeof c.arguments.content==='string')files.set(c.arguments.path,c.arguments.content);
   if(c.name==='edit' && files.has(c.arguments.path)) {
    let content=files.get(c.arguments.path);
    for(const edit of c.arguments.edits || [c.arguments]) {
     assert.equal(content.split(edit.oldText).length,2,'Replay requires an unambiguous recorded edit');
     content=content.replace(edit.oldText,()=>edit.newText);
    }
    files.set(c.arguments.path,content);
   }
  }
 }
 if(row.message?.role==='assistant' && row.message.stopReason==='stop'){draft=text(row.message);draftMessage=row.message;}
 if(row.customType!=='pe_answer_lint')continue;
 draftMessages.push(draftMessage);lintRecords.push(row.data);
 const citations=row.data.citations || [],context={question,citations,toolCalls:calls};
 const started=performance.now();const findings=financialEvidenceFindings(draft,context,[]);
 const summary=Object.fromEntries([...new Set(findings.map(f=>f.evidenceStatus))].map(key=>[key,findings.filter(f=>f.evidenceStatus===key && f.severity==='error').length]));
 const receipts=new Map((row.data.findings || []).filter(f=>f.evidenceStatus==='semantic_supported').map(f=>[findingKey(f),f]));
 const artifacts=fileReceipts();
 const merged=[...findings.map(f=>({...f,...receipts.get(findingKey(f)),sourceText:f.sourceText})),...(row.data.findings || []).filter(f=>!['unsourced_number','evidence_identity_mismatch'].includes(f.rule)),...artifactDeliveryFindings(draft,artifacts)];
 let retained=researchPortion(draft,()=>{throw new Error('Isolated paragraph must not be revalidated');},merged,citations,{visibleHistory,question});
 const normalize=s=>s.replace(/[*`#]/g,'').replace(/\s+/g,' ').trim();
 const leaked=merged.filter(f=>f.severity==='error' && (f.sourceText || f.excerpt) && normalize(retained).includes(normalize(f.sourceText || f.excerpt)));
 assert.equal(leaked.length,0,JSON.stringify(leaked.map(f=>({rule:f.rule,excerpt:f.excerpt})),null,2));
 const delivery=artifactDeliverySummary(artifacts);
 if(delivery)retained+='\n\n'+delivery;
 const result={index:++index,draftChars:draft.length,retainedChars:retained.length,elapsedMs:performance.now()-started,toolCalls:calls.length,files:artifacts,blockedSpanLeaks:leaked.length,summary,findings:merged,recordedFindings:row.data.findings};
 fs.writeFileSync(path.join(output,`draft-${index}.md`),draft);
 fs.writeFileSync(path.join(output,`retained-${index}.md`),retained);
 fs.writeFileSync(path.join(output,`draft-${index}.json`),JSON.stringify(result,null,2));
 results.push({...result,findings:undefined,recordedFindings:undefined});console.log(results.at(-1));
}
fs.writeFileSync(path.join(output,'summary.json'),JSON.stringify({input,network:false,question,toolCalls:calls.length,drafts:results},null,2));

// Replay the actual final-delivery state machine too. The model is a tape of
// recorded drafts, tools are already-recorded results, and fetch is disabled.
// This cannot predict how a live model will rewrite after a changed audit.
const records=[],requests=[],sessionMessages=structuredClone(priorMessages);let generations=0;
const branch=structuredClone(priorRows);
const appendMessage=message=>{sessionMessages.push(message);branch.push({type:'message',message});};
const firstDraftAt=messages.indexOf(draftMessages[0]);
const toolHistory=messages.slice(0,firstDraftAt).filter(m=>m.role==='toolResult' || m.role==='assistant' && Array.isArray(m.content) && m.content.some(p=>p.type==='toolCall'));
const session={messages:sessionMessages,sessionManager:{getBranch:()=>branch,appendCustomEntry(type,data){records.push({type,data});branch.push({type:'custom',customType:type,data});}},
 async prompt(){
  assert(generations<8,'Unexpected replay loop; do not call a paid provider');
  if(!generations)for(const message of structuredClone(toolHistory))appendMessage(message);
  appendMessage(structuredClone(draftMessages[Math.min(generations++,draftMessages.length-1)]));
 },
 async sendCustomMessage(message,options){requests.push(message);if(options.triggerTurn)await this.prompt();}
};
const replayRoot=fs.mkdtempSync(path.join(os.tmpdir(),'research-delivery-replay-'));
const published=[];
const finalReceipts=()=>[...new Map([...fileReceipts(),...published].map(r=>[r.path,r])).values()];
for(const receipt of fileReceipts()) {
 const destination=path.join(replayRoot,receipt.path);fs.mkdirSync(path.dirname(destination),{recursive:true});
 fs.copyFileSync(path.join(projectRoot,receipt.path),destination);
}
const lastReport=calls.findLast(c=>c.name==='review_research' && c.args?.save && c.args.path?.endsWith('.md'));
const reportDraft=lastReport ? {path:lastReport.args.path,content:lastReport.args.content,saveRequested:true,saved:false,baseline:
 projectRoot && fs.existsSync(path.join(projectRoot,lastReport.args.path)) ? hash(fs.readFileSync(path.join(projectRoot,lastReport.args.path))) : null,
 issues:lastReport.success?[]:['录制的报告审校未通过']} : null;
let deliveryRecord;
try {deliveryRecord=await runWithPostAnswer({session,ctx:{root:replayRoot},artifactSnapshot:finalReceipts,
 publishReportDelivery:(outcome,question)=>publishFinalReport({root:replayRoot,draft:reportDraft,outcome,question,receipts:finalReceipts(),record:receipt=>{
  published.push(receipt);
  const destination=path.join(output,'published',receipt.path);fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.copyFileSync(path.join(replayRoot,receipt.path),destination);
 }}),
 reconcileEvidence:async(answer,findings)=>{
  const recorded=lintRecords[draftMessages.findIndex(m=>text(m)===answer)];
  const accepted=new Map((recorded?.findings || []).filter(f=>f.evidenceStatus==='semantic_supported').map(f=>[findingKey(f),f]));
  return {findings:findings.map(f=>({...f,...accepted.get(findingKey(f)),sourceText:f.sourceText})),status:'recorded_replay'};
 }},question);
 if(published.length)fs.cpSync(path.join(replayRoot,'exports'),path.join(output,'published','exports'),{recursive:true});
} finally {fs.rmSync(replayRoot,{recursive:true,force:true});}
assert(['partial','completed'].includes(deliveryRecord.status),JSON.stringify(deliveryRecord));
assert.deepEqual(artifactDeliveryFindings(deliveryRecord.text,finalReceipts()),[],'Final persisted delivery must agree with file readback receipts');
fs.writeFileSync(path.join(output,'delivery.json'),JSON.stringify({network:false,generations,delivery:deliveryRecord,requests,records},null,2));
fs.writeFileSync(path.join(output,'delivered.md'),deliveryRecord.text);
console.log({actualPostprocessor:deliveryRecord.status,deliveredChars:deliveryRecord.text.length,generations,network:false});
