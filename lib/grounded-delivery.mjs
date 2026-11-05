import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
import { insideProjectRealRoot } from './workspace-path.mjs';
import { groundingIssues,groundingFeedback } from './answer-grounding.mjs';
const textOf=m=>typeof m?.content==='string'?m.content:(m?.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('\n');
const hasTools=m=>m.content?.some(b=>b.type==='toolCall');
function saveReview(workspace,id,record){
 if(!workspace||!id)return null;
 if(!/^[a-zA-Z0-9_-]{1,100}$/.test(id))throw Error('invalid session id');
 const dir=path.join(workspace,'.pi','answer-reviews',id);
 for(const p of [path.join(workspace,'.pi'),path.join(workspace,'.pi','answer-reviews'),dir])if(fs.existsSync(p)&&!insideProjectRealRoot(workspace,p))throw Error('review outside project');
 fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,crypto.randomUUID()+'.json');
 fs.writeFileSync(file,JSON.stringify(record,null,2),{flag:'wx',mode:0o600});return path.relative(workspace,file);
}
function addUsage(a,b){
 const usage={...b,cost:{...b?.cost}};
 for(const k of ['input','output','cacheRead','cacheWrite','totalTokens'])usage[k]=(a?.[k]||0)+(b?.[k]||0);
 for(const k of ['input','output','cacheRead','cacheWrite','total'])usage.cost[k]=(a?.cost?.[k]||0)+(b?.cost?.[k]||0);
 return usage;
}
async function collect(stream){
 const events=[];for await(const event of stream)events.push(event);
 const generated=await stream.result();
 if(['error','aborted'].includes(generated.stopReason)){
  const message={...generated,content:[]};
  return {events:[{type:'error',reason:message.stopReason,error:message}],message,partialText:textOf(generated)};
 }
 return {events,message:generated};
}
/** Buffer focused responses; at most one extra generation per user turn.
 * A clean narrow check is not an exhaustive correctness certification.
 */
export function installGroundedDelivery(agent,{workspace,id,shouldReview}={}){
 if(!agent.streamFunction)return;
 const original=agent.streamFunction.bind(agent);let reviewedKey=null,pending=null;
 const persist=(record,message)=>{
  let auditPath=null,auditError=null;try{auditPath=saveReview(workspace,id,record);}catch(e){auditError=e.message;}
  if(message)message.groundingReview={attempted:true,reviewId:record.reviewId,status:record.status,remainingIssues:record.remainingIssues||[],auditPath,...(auditError?{auditError}:{})};
 };
 const finishPending=(message,raw,status)=>{
  const record={...pending.record,timestamp:new Date().toISOString(),status,revised:textOf(message),stopReason:message.stopReason,remainingIssues:hasTools(message)?[]:groundingIssues(textOf(message),raw),followups:[...pending.followups],parentAuditPath:pending.auditPath};
  persist(record,message);pending=null;
 };
 agent.subscribe?.((event,signal)=>{
  if(event.type==='agent_end'&&pending){
   const record={...pending.record,timestamp:new Date().toISOString(),status:signal?.aborted?'aborted':'incomplete',remainingIssues:null,followups:pending.followups,parentAuditPath:pending.auditPath};
   persist(record);pending=null;
  }
 });
 agent.streamFunction=(model,context,options)=>{
  const raw=[...(agent.state?.messages||context.messages)],user=raw.findLast(m=>m.role==='user');
  const key=user?`${user.timestamp}:${textOf(user)}`:null;
  if(pending&&pending.key!==key){persist({...pending.record,status:'interrupted_by_new_request',remainingIssues:null,followups:pending.followups,parentAuditPath:pending.auditPath});pending=null;}
  if(!shouldReview?.(raw))return original(model,context,options);
  const out=new AssistantMessageEventStream();
  void (async()=>{
   let first,activeRecord;
   try{
    first=await collect(await original(model,context,options));let final=first;
    const candidate=first.message,issues=groundingIssues(textOf(candidate),raw);
    if(pending&&pending.key===key){
     pending.followups.push({text:textOf(candidate),toolCalls:candidate.content.filter(b=>b.type==='toolCall'),usage:structuredClone(candidate.usage),stopReason:candidate.stopReason});
     if(!hasTools(candidate)||['error','aborted'].includes(candidate.stopReason))finishPending(candidate,raw,candidate.stopReason==='stop'?'complete':candidate.stopReason);
     else candidate.groundingReview={attempted:true,reviewId:pending.record.reviewId,status:'awaiting_tool_results',remainingIssues:[],auditPath:pending.auditPath};
    }else if(key && key!==reviewedKey && issues.length && !options?.signal?.aborted && candidate.stopReason==='stop' && !hasTools(candidate)){
     reviewedKey=key;
     const feedback=groundingFeedback(issues);
     activeRecord={reviewId:crypto.randomUUID(),timestamp:new Date().toISOString(),draft:textOf(candidate),issues,feedback,usage:{draft:structuredClone(candidate.usage)}};
     final=await collect(await original(model,{...context,messages:[...context.messages,candidate,{role:'user',content:'[内部交付检查，不是用户新增请求]\n'+feedback,timestamp:Date.now()}]},options));
     const awaiting=hasTools(final.message)&&final.message.stopReason==='toolUse';
     const record={...activeRecord,status:awaiting?'awaiting_tool_results':final.message.stopReason==='stop'?'complete':final.message.stopReason,revised:textOf(final.message),...(final.partialText?{revisionPartial:final.partialText}:{}),remainingIssues:awaiting?null:groundingIssues(textOf(final.message),raw),stopReason:final.message.stopReason,revisionTools:final.message.content.filter(b=>b.type==='toolCall'),usage:{...activeRecord.usage,revision:structuredClone(final.message.usage)}};
     persist(record,final.message);
     if(awaiting)pending={key,record,auditPath:final.message.groundingReview.auditPath,followups:[]};
     final.message.usage=addUsage(candidate.usage,final.message.usage);
    }else if(issues.length&&!hasTools(candidate))candidate.groundingReview={attempted:false,status:'needs_review',remainingIssues:issues,reason:'review_budget_or_interruption'};
    for(const event of final.events)out.push(event);out.end(final.message);
   }catch(e){
    const reason=options?.signal?.aborted?'aborted':'error';
    const message={role:'assistant',content:[],api:model.api,provider:model.provider,model:model.id,stopReason:reason,errorMessage:e.message,timestamp:Date.now(),usage:first?.message.usage||{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
    if(activeRecord)persist({...activeRecord,status:reason,error:e.message,revised:'',remainingIssues:null},message);
    if(pending)finishPending(message,raw,reason);
    out.push({type:'error',reason,error:message});
   }
  })();return out;
 };
}
