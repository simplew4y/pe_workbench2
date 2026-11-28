// Single-turn replay. Supply the original session and sidecar audit JSONL.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {createResearchAuditor,AUDIT_PROMPT} from '../lib/research-audit.mjs';
import {guardResearchDelivery} from '../lib/research-delivery.mjs';
import {createResearchReview} from '../lib/research-review.mjs';

const [sessionFile,auditFile,output]=process.argv.slice(2);
if(!output)throw Error('Expected session.jsonl audit.jsonl output-directory');
globalThis.fetch=()=>{throw Error('Network disabled during replay');};
const read=file=>fs.readFileSync(file,'utf8').trim().split('\n').map(JSON.parse);
const rows=read(sessionFile);
const turns=rows.filter(r=>r.customType==='pe_turn_started');
assert.equal(turns.length,1,'Replay one isolated turn');
const final=rows.find(r=>r.customType==='pe_turn_delivery');
assert.ok(final);
const records=read(auditFile).filter(r=>r.kind==='answer' && r.at>=turns[0].timestamp && r.at<=final.timestamp);
assert.ok(records.length);
fs.mkdirSync(output,{recursive:true});
const history=[], reviews=[], timings=[],corrections={};
const assistant=rows.filter(r=>r.message?.role==='assistant');
const sample=assistant.at(-1).message;
const model={id:sample.model,provider:sample.provider,reasoning:true};
const source=createResearchReview({ctx:{root:path.resolve(output)}});
const recorder=createResearchAuditor();
const tape=[...assistant.filter(r=>r.message.stopReason==='toolUse'),
  ...records.map(record=>({timestamp:record.at,record}))].sort((a,b)=>a.timestamp.localeCompare(b.timestamp));
let active,attempts,position=0;
const makeStream=message=>{
  const stream=createAssistantMessageEventStream();
  stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
};
const provider=async(_model,ctx)=>{
  if(ctx.systemPrompt===AUDIT_PROMPT){
    assert.ok(active);
    const payload=JSON.parse(ctx.messages[0].content[0].text);
    assert.equal(payload.editableDraft || payload.draft,active.draft);
    const stopReason=active.auditAttempts[attempts++]?.stopReason;
    assert.ok(stopReason,'Replay requested an unrecorded verdict');
    const numericCoverage=(active.verifiedPassages || []).map(p=>({
      index:payload.unboundNumericLines.indexOf(p.text),evidenceIds:p.evidenceIds})).filter(p=>p.index>=0);
    const content={checks:active.checks,issues:[...active.reviewIssues.filter(i=>i.check!=='audit'),...(active.rejectedIssues || [])],numericCoverage};
    return makeStream({...sample,stopReason,content:[{type:'text',text:JSON.stringify(content)}]});
  }
  const item=tape[position++];assert.ok(item,'Unrecorded model generation');
  if(!item.record)return makeStream(item.message);
  active=item.record;attempts=0;
  return makeStream({...sample,content:[{type:'text',text:active.draft}],researchAnswerGaps:undefined,
    researchVerification:undefined,researchResolvedToolFailures:undefined});
};
const guard=guardResearchDelivery(provider,{getSessionMessages:()=>history,queueReviewCorrection:request=>{
    if(timings.length || corrections[timings.length])return false;
    corrections[timings.length]=request;return true;
  },
  onContext:(_model,ctx)=>source.restoreEvidence(ctx.messages),
  audit:(sourceProvider,model,ctx,options,draft,extra)=>recorder(sourceProvider,model,ctx,options,draft,
    {...extra,workbookEvidence:source.evidenceSnapshot()}),
  recordAudit:r=>{
    reviews.push({at:active.at,status:r.status,mode:r.reviewMode,fullReviewReason:r.fullReviewReason,revisionReview:r.revisionReview,attempts:r.auditAttempts?.length || 0,
      numericFacts:r.numericFacts,issues:r.issues.map(i=>({check:i.check,excerpt:i.excerpt,reason:i.reason}))});
    if(r.status==='unavailable')assert.equal(active.status,'unavailable','Unexpected replay verification failure');
  }});
for(const row of rows){
  const m=row.message;
  if(!m)continue;
  if(m.role!=='assistant'){history.push(m);continue;}
  const stream=await guard(model,{messages:history},{});for await(const event of stream){}
  const result=await stream.result();
  assert.equal(result.stopReason,m.stopReason,'Model tape diverged from recorded tool flow');
  if(m.stopReason==='stop'){
    timings.push({timestamp:row.timestamp,identical:JSON.stringify(result.content.filter(p=>p.type==='text'))===
      JSON.stringify(m.content.filter(p=>p.type==='text'))});
    row.message={...m,content:result.content,researchAnswerGaps:result.researchAnswerGaps,researchVerification:result.researchVerification,
      researchResolvedToolFailures:result.researchResolvedToolFailures};
  }else assert.deepEqual(result.content.filter(p=>p.type==='toolCall'),m.content.filter(p=>p.type==='toolCall'));
  history.push(row.message);
}
assert.equal(position,tape.length);assert.equal(reviews.length,records.length);
fs.writeFileSync(path.join(output,'audits.json'),JSON.stringify({reviews,drafts:timings},null,2));
const correctionFile=path.join(output,'review-corrections.json');
fs.writeFileSync(correctionFile,JSON.stringify(corrections));
const reconstructed=path.join(output,'reconstructed.jsonl');
fs.writeFileSync(reconstructed,rows.map(r=>JSON.stringify(r)).join('\n'));
const result=spawnSync(process.execPath,[fileURLToPath(new URL('./replay-research-delivery.mjs',import.meta.url)),
  reconstructed,output,'--recorded-facts','--review-corrections='+correctionFile,...process.argv.slice(5)],{stdio:'inherit'});
assert.equal(result.status,0);
