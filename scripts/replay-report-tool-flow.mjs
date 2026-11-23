/** Offline, immutable-source replay of recorded report submissions. No provider. */
import {recordedFactContext} from './recorded-fact-context.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {indexGraph,queryGraph} from '../lib/workbook-query.mjs';
import {guardResearchDelivery} from '../lib/research-delivery.mjs';
import {questionWithoutAttachments} from '../lib/answer-length.mjs';
import {runWithPostAnswer} from '../server/agent/post-answer.mjs';
import {createResearchReview} from '../lib/research-review.mjs';
import {createResearchWriteTool} from '../lib/research-write-tool.mjs';
import {parseAudit,createResearchAuditor} from '../lib/research-audit.mjs';
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>i%2?a:[...a,[v.replace(/^--/,''),all[i+1]]],[]));
if(!args.session || !args.audit || !args.output)throw new Error('--session JSONL --audit JSONL --output DIRECTORY required');
globalThis.fetch=()=>{throw new Error('network disabled');};
const read=p=>fs.readFileSync(p,'utf8').split('\n').filter(Boolean).map(x=>JSON.parse(x));
const rows=read(args.session),audits=read(args.audit).filter(a=>a.kind==='report');
const recordedRoot=rows.find(r=>r.type==='session')?.cwd;
const replayPath=file=>{
 if(!recordedRoot || !path.isAbsolute(file))return file;
 const relative=path.relative(recordedRoot,file);
 return relative && !relative.startsWith('../') && !path.isAbsolute(relative)?relative:file;
};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'report-record-replay-'));
const summaries=[];
const replayAuditor=createResearchAuditor();
try {
 const materialMap=new Map(),calls=new Map(),cells=new Map(),graphs=new Map();
 const messages=rows.filter(r=>r.type==='message').map(r=>r.message);
 const store={findMaterialByPath:p=>materialMap.get(p) || null};
 for(const [index,m] of messages.entries()) {
  if(m.role==='assistant')for(const c of m.content || [])if(c.type==='toolCall')calls.set(c.id,c);
  const call=calls.get(m.toolCallId),d=m.details;
  if(m.role==='toolResult' && !m.isError && call && ['workbook_query','workbook_trace'].includes(call.name) && d?.materialId) {
   if(args['graph-cache'] && d.sha256 && !graphs.has(d.materialId)){
    assert.match(d.sha256,/^[a-f0-9]{64}$/);
    const attachment=path.resolve(path.dirname(args.session),'../..',call.arguments.path);
    assert.equal(createHash('sha256').update(fs.readFileSync(attachment)).digest('hex'),d.sha256);
    graphs.set(d.materialId,indexGraph(JSON.parse(gunzipSync(fs.readFileSync(path.join(args['graph-cache'],d.sha256+'.json.gz'))))));
   }
   materialMap.set(call.arguments.path,{id:d.materialId,version:d.version,name:d.name,path:call.arguments.path});
   const add=c=>{if(!c)return;if(c.ref){const key=d.materialId+':'+c.ref;cells.set(key,{...cells.get(key),...c});}for(const child of c.children || [])add(child);};
   for(const c of [...(d.cells || []),...(d.researchEvidence || [])])add(c);add(d.tree);add(d.target);
  }
  if(m.role!=='assistant')continue;
  for(const call of m.content || []) {
   if(call.type!=='toolCall' || !['review_research','write'].includes(call.name) || !call.arguments?.path?.endsWith('.md'))continue;
   const original=messages.find(x=>x.role==='toolResult' && x.toolCallId===call.id);
   let originalBody;try{originalBody=JSON.parse(original?.content?.filter(p=>p.type==='text').map(p=>p.text).join('\n'));}catch{}
   const audit=audits.find(a=>Date.parse(a.at)>=Number(m.timestamp) && Date.parse(a.at)<=Number(original?.timestamp));
   // review_research also performs local cell reads. Its host-recorded source
   // cells belong to this submission, even if semantic review later failed.
   const reviewCells=new Map((original?.details?.sourceCells || originalBody?.sourceCells || []).map(c=>[store.findMaterialByPath(c.file)?.id+':'+c.ref,
    {...c,value:c.rawValue,columnLabel:c.header}]));
   for(const [key,cell] of reviewCells)cells.set(key,{...cells.get(key),...cell});
   const missingLookups=[];
   const review=createResearchReview({ctx:{root,store,workbooks:{queryMaterial:async(id,ref)=>{
    if(graphs.has(id))return queryGraph(graphs.get(id),ref,{maxCells:1});
    const cell=cells.get(id+':'+ref) || reviewCells.get(id+':'+ref);if(!cell)missingLookups.push({id,ref});
    return {seeds:[ref],cells:cell?[cell]:[]};
   }}}});
   review.restoreEvidence(messages.slice(0,index));
   const sibling=path.posix.join(path.posix.dirname(replayPath(call.arguments.path)),'analysis-state.json');
   let stateBody;
   for(const prior of messages.slice(0,index)){
    if(prior.role!=='toolResult' || prior.isError)continue;
    const c=calls.get(prior.toolCallId);
    if(!c?.arguments?.path || replayPath(c.arguments.path)!==sibling)continue;
    if(c.name==='write')stateBody=c.arguments.content;
    if(c.name==='edit' && typeof stateBody==='string'){
     for(const {oldText,newText} of c.arguments.edits || [c.arguments]) {
       assert.equal(stateBody.split(oldText).length,2,'recorded state edit must have one base');
       stateBody=stateBody.replace(oldText,()=>newText);
     }
    }
   }
   fs.mkdirSync(path.join(root,path.dirname(sibling)),{recursive:true});
   if(stateBody!==undefined){
     fs.writeFileSync(path.join(root,sibling),stateBody);
     review.record({toolCall:{name:'write'},args:{path:sibling,content:stateBody},result:{content:[]}});
   }
   let invocations=0,replayedVerdict;const providerAttempts=[];
   review.setAuditor(async(content,extra)=>{invocations++;

    if(!audit)return {ok:false,status:'unavailable',issues:[{check:'audit',reason:'该提交没有对应已录制审校回执，离线回放不能生成新裁决'}]};
    if(args['review-loop']==='true'){
     const exactBody=createHash('sha256').update(content).digest('hex')===audit.draftHash;
     const oldSemanticPass=exactBody && audit.status==='reviewed' && audit.checks &&
       Object.values(audit.checks).every(check=>check==='pass'||check==='not_applicable');
     // Older records combined local and semantic findings. When every recorded
     // semantic check passed, re-run the local checks on the identical report.
     const issues=exactBody && Array.isArray(audit.reviewIssues)?audit.reviewIssues:
       oldSemanticPass?[]:(audit.issues || []).filter(i=>i.check!=='audit');
     const provider=async(_model,context,options)=>{
      const stopReason=options.reasoning==='low' && audit.auditAttempts?.[0]?.stopReason==='length'?'length':'stop';
      const payload=JSON.parse(context.messages[0].content[0].text);
      providerAttempts.push({reasoning:options.reasoning,stopReason,inputChars:context.messages[0].content[0].text.length,
       includedCalculationIds:payload.timeline.filter(r=>r.role==='toolResult' && !r.isError && ['model_whatif','calc','ratio','unit_convert'].includes(r.toolName)).map(r=>r.toolCallId)});
      const message={stopReason,content:[{type:'text',text:JSON.stringify({checks:audit.checks,issues,inputCoverageGaps:audit.inputCoverageGaps || []})}]};
      return {async *[Symbol.asyncIterator](){yield {type:'done'};},result:async()=>message};
     };
     const question=messages.slice(0,index).filter(m=>m.role==='user').at(-1)?.content;
     replayedVerdict=await replayAuditor(provider,{id:'recorded-model',provider:'offline',reasoning:true,maxTokens:64000},{messages:messages.slice(0,index)},{},content,
      {...extra,question:typeof question==='string'?question:'',workbookEvidence:review.evidenceSnapshot()});
     return replayedVerdict;
    }
    if(audit.status==='unavailable')return audit;
    const parsed=parseAudit(JSON.stringify({checks:audit.checks,issues:(audit.issues || []).filter(i=>i.check!=='audit')}),content);
    return {...audit,...parsed};
   });
   const rawWrite={description:'offline writer',name:'write',execute:async(_id,p)=>{
    fs.mkdirSync(path.dirname(path.join(root,p.path)),{recursive:true});fs.writeFileSync(path.join(root,p.path),p.content);return {content:[]};
   }};
   const writer=createResearchWriteTool({rawWrite,review});
   const toolContext={executeTool:async(_name,p)=>({result:await writer.execute('nested',p)})};
   const replayArgs={...call.arguments,path:replayPath(call.arguments.path)};
   const execute=()=>call.name==='write'?writer.execute(call.id,replayArgs,undefined,undefined,toolContext):review.tool.execute(call.id,replayArgs,undefined,undefined,toolContext);
   const result=await execute();
   const savedBeforeHandoff=review.draftSnapshot()?.saved;
   let handoff;
   const recoveredSave=args.handoff==='replayed' && original?.isError && replayedVerdict?.ok &&
     audit?.status==='reviewed' && audit.draftHash===review.draftSnapshot()?.reviewedHash;
   if(!result.isError && ((args.handoff==='true' && audit?.ok && original && !original.isError) || recoveredSave)) {
     const report=review.draftSnapshot();
     assert.equal(report.reviewedHash,audit.draftHash,'report must match the recorded approval');
     assert.equal(report.reviewedHash,createHash('sha256').update(report.content).digest('hex'));
     const until=messages.indexOf(original),start=messages.slice(0,index).findLastIndex(m=>m.role==='user');
     const history=messages.slice(start,until+1);
     if(recoveredSave)history[history.length-1]={...original,...result,isError:false};
     const terminal=messages[until+1];
     const signoff=terminal?.researchReportHash===audit.draftHash?terminal.content:
       [{type:'text',text:read(args.audit).find(a=>a.kind==='answer' && Date.parse(a.at)>=Number(original.timestamp))?.draft}];
     assert.ok(signoff.some(c=>c.type==='text' && c.text),'missing recorded answer');
     const question=questionWithoutAttachments(typeof history[0].content==='string'?history[0].content:history[0].content.map(p=>p.text || '').join('\n'));
     const sessionMessages=[],branch=[],records=[];let answerAudits=0,signoffs=0,bindingReviews=0;
     const guard=guardResearchDelivery(async()=>{
       signoffs++;const message={role:'assistant',stopReason:'stop',content:signoff};
       return {async *[Symbol.asyncIterator](){yield {type:'done'};},result:async()=>message};
     },{audit:async()=>{answerAudits++;throw Error('unexpected new answer audit');},
       getSessionMessages:()=>sessionMessages,getReportDraft:review.draftSnapshot,getArtifacts:review.artifactSnapshot});
     const session={messages:sessionMessages,sessionManager:{getBranch:()=>branch,appendCustomEntry:(type,data)=>records.push({type,data})},
       async prompt(){sessionMessages.push(...history);const stream=await guard({}, {messages:sessionMessages},{});
         for await(const _event of stream){}sessionMessages.push(await stream.result());},
       async sendCustomMessage(_message,options){assert.ok(!options.triggerTurn,'unexpected second answer generation');}};
     const facts=args.facts?JSON.parse(fs.readFileSync(args.facts,'utf8')):[];
     assert.ok(facts.every(f=>Date.parse(f.created_at)<=original.timestamp),'fact snapshot must predate the answer');
     const reconstructed=args['recorded-facts']==='true'?recordedFactContext(root,rows.find(r=>r.type==='session')?.id):null;
     if(reconstructed)messages.slice(0,until+1).forEach(reconstructed.observe);
     const factMemory=reconstructed || (args.facts?{recover(){},query:()=>({status:'found',facts,total:facts.length})}:undefined);
     const delivery=await runWithPostAnswer({session,ctx:{root,factMemory},reconcileEvidence:async()=>{bindingReviews++;throw Error('unexpected answer binding review');},reportDraftSnapshot:review.draftSnapshot,
       artifactSnapshot:review.artifactSnapshot,publishReportDelivery:review.publishDelivery},question);
     assert.equal(delivery.reviewedReportHash,audit.draftHash,JSON.stringify({status:delivery.status,reason:delivery.reason,answerAudits,bindingReviews,signoffs,reportMarker:sessionMessages.at(-1)?.researchReportHash,priorReason:delivery.publicationReview?.priorReason,findings:records.findLast(r=>r.type==='pe_answer_lint')?.data?.findings?.filter(f=>f.severity==='error').slice(0,2).map(f=>[f.rule,f.message,f.excerpt?.slice(0,100)])}));
     assert.equal(answerAudits,0);assert.equal(bindingReviews,0);assert.equal(signoffs,1);
     assert.equal(fs.readFileSync(path.join(root,report.path),'utf8'),delivery.text);
     assert.ok(delivery.text.startsWith(report.content),'all reviewed text must survive publication');
     const manifest=JSON.parse(fs.readFileSync(path.join(root,delivery.reportPublication.manifestPath)));
     for(const item of [manifest.report,manifest.state])assert.equal(createHash('sha256').update(fs.readFileSync(path.join(root,item.path))).digest('hex'),item.sha256);
     const publishedState=JSON.parse(fs.readFileSync(path.join(root,sibling)));
     assert.equal(publishedState.delivery.reportHash,manifest.report.sha256);
     const counts={};
     for(const key of ['theses','assumptions','sensitivities','falsifiers','valuations'].filter(key=>key in JSON.parse(stateBody))){
       assert.deepEqual(publishedState[key],JSON.parse(stateBody)[key]);counts[key]=publishedState[key].length;
     }
     fs.mkdirSync(args.output,{recursive:true});
     fs.writeFileSync(path.join(args.output,'delivered.md'),delivery.text);
     for(const relative of [report.path,sibling,delivery.reportPublication.manifestPath,publishedState.delivery.candidatePath,
       publishedState.delivery.candidateReportPath].filter(Boolean)){
       const target=path.join(args.output,relative);
       fs.mkdirSync(path.dirname(target),{recursive:true});
       fs.copyFileSync(path.join(root,relative),target);
     }
     handoff={recoveredSave,answerAudits,bindingReviews,signoffs,registeredFacts:reconstructed?reconstructed.query({limit:100}).facts.length:facts.length,status:delivery.status,reportHash:audit.draftHash,reviewedChars:report.content.length,deliveredChars:delivery.text.length,
       stateStatus:publishedState.delivery.status,trackingEnabled:publishedState.delivery.trackingEnabled,counts};
     reconstructed?.close();
   }
   const repeated=handoff?result:await execute();
   const detail=result.details || {};
   summaries.push({callId:call.id,handoff,recordedAudit:!!audit,originalErrors:originalBody?.errorCount,originalCoverage:originalBody?.coverageErrors?.length,
    replayError:result.isError,coverageErrors:detail.coverageErrors?.length,automaticBindings:detail.automaticBindings?.length,
    auditUnavailable:detail.auditUnavailable,...(handoff?{reviewCalls:invocations}:{reviewCallsForTwoIdenticalSubmissions:invocations}),reusedReview:repeated.details?.reusedReview,
    saved:savedBeforeHandoff,modelFeedbackChars:result.content?.map(p=>p.text||'').join('\n').length,
    originalFeedbackChars:original?.content?.map(p=>p.text||'').join('\n').length,missingLookups,remainingErrors:detail.errors,
    localFailure:result.isError && !detail.errors?result.content?.map(p=>p.text||'').join('\n'):undefined,
    providerAttempts,arithmeticCorrections:replayedVerdict?.arithmeticCorrections,recordedVerdictReplay:args['review-loop']==='true',newFinancialVerdict:false});
  }
 }
 if(['true','replayed'].includes(args.handoff))assert.ok(summaries.some(s=>s.handoff),'no approved delivery replayed');
 fs.mkdirSync(args.output,{recursive:true});
 fs.writeFileSync(path.join(args.output,'report-flow-replay.json'),JSON.stringify({network:false,paidCalls:0,reports:summaries},null,2));
 console.log(JSON.stringify({network:false,paidCalls:0,reports:summaries.map(({remainingErrors,...s})=>s)},null,2));
} finally {fs.rmSync(root,{recursive:true,force:true});}
