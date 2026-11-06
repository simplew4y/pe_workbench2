/** Evidence-backed ledger corrections propose, never automatically apply, artifact revisions. */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {serializeFile,atomicWrite,markArtifact,readLedger,correctedValues} from './ledger.mjs';
import {correctionMatches} from './correction-match.mjs';
import {validateState} from './validate-state.mjs';
const MAX_SIZE=2*1024*1024;
const sha=s=>createHash('sha256').update(s).digest('hex');
async function safePath(root,rel) {
  if(typeof rel!=='string'||!rel.startsWith('exports/')||rel.includes('\\')||rel.split('/').some(p=>!p||p==='.'||p==='..')||rel.startsWith('exports/.revisions/')) throw new Error('invalid artifact path');
  const abs=path.resolve(root,rel);let current=path.resolve(root);
  for(const part of rel.split('/')) {current=path.join(current,part);const stat=await fs.lstat(current);if(stat.isSymbolicLink()) throw new Error('artifact symlinks forbidden');}
  if(!(path.basename(abs)==='analysis-state.json'||abs.endsWith('.md'))) throw new Error('unsupported artifact');
  const stat=await fs.stat(abs);if(!stat.isFile()||stat.size>MAX_SIZE) throw new Error('artifact too large');return abs;
}
async function filesUnder(root) {
 const files=[];let visited=0;
 async function walk(rel) {
  if(visited++>=200||files.length>=50) return;
  let entries;try {if((await fs.lstat(path.join(root,rel))).isSymbolicLink()) return;entries=await fs.readdir(path.join(root,rel),{withFileTypes:true});}catch(e){if(e.code==='ENOENT')return;throw e;}
  for(const e of entries.sort((a,b)=>a.name.localeCompare(b.name))) {
   if(files.length>=50)break;if(e.isSymbolicLink()||e.name==='.revisions')continue;
   const p=rel+'/'+e.name;
   if(e.isDirectory())await walk(p);else if(e.isFile()&&(e.name==='analysis-state.json'||e.name.endsWith('.md'))) files.push(p);
  }
 }
 await walk('exports');return files;
}
function patchesFor(text,c,isJSON) {
 if(!isJSON) return correctionMatches(text,c).map(m=>({...m,before:m.text,after:String(c.to),excerpt:text.slice(Math.max(0,m.start-100),m.end+100)}));
 const state=JSON.parse(text),patches=[];
 function walk(v,keys=[],context='') {
  if(typeof v==='string') {
   const matches=correctionMatches(v,c,{context});if(!matches.length)return;
   let after=v;for(const m of matches.reverse())after=after.slice(0,m.start)+String(c.to)+after.slice(m.end);
   patches.push({keys,before:v,after,excerpt:v.slice(0,400)});
  } else if(typeof v==='number'&&String(v)===String(c.from)&&correctionMatches(String(v),c,{context}).length) {
   patches.push({keys,before:v,after:Number.isFinite(Number(c.to))?Number(c.to):String(c.to),excerpt:context.slice(0,400)});
  } else if(v&&typeof v==='object') {
   // Historical changes are an audit record and must retain the original values.
   for(const [k,child] of Object.entries(v)) if(!['changes','corrections'].includes(k))walk(child,[...keys,k],JSON.stringify(v).slice(0,4000));
  }
 }
 walk(state);return patches;
}
export async function scanCorrection({ctx,sessionId,correction,broadcast=()=>{}}) {
 return serializeFile(path.resolve(ctx.root,'.pi',`artifact-scan-${sessionId}`),async()=>{
  const approvals=[];const files=await filesUnder(ctx.root);
  for(const rel of files) {
   let abs,text,patches;
   try {abs=await safePath(ctx.root,rel);text=await fs.readFile(abs,'utf8');patches=patchesFor(text,correction,rel.endsWith('.json'));} catch {continue;}
   if(!patches.length)continue;
   const existing=ctx.store.findPendingArtifactRevision?.({threadId:sessionId,path:rel,correctionId:correction.id}) || ctx.store.listApprovalRequests({threadId:sessionId,limit:10000}).find(a=>a.kind==='artifact_revision'&&['pending_approval','approved','applying'].includes(a.status)&&a.payload?.artifact?.path===rel&&a.payload.corrections?.some(c=>c.id===correction.id));
   let approval=existing;
   if(!approval) {
    const createdAt=new Date().toISOString();
    approval=ctx.store.createApprovalRequest({threadId:sessionId,kind:'artifact_revision',status:'pending_approval',payload:{schema:{name:'pe.artifact-revision.proposal',version:1},projectId:ctx.id,threadId:sessionId,artifact:{path:rel,sha256:sha(text),...(rel.endsWith('.json')?{revision:JSON.parse(text).revision}: {})},corrections:[{id:correction.id,from:correction.from,to:correction.to,claim:correction.claim,unit:correction.unit,evidence:correction.evidence}],excerpts:patches,status:'pending_approval',createdAt}});
   }
   await markArtifact(ctx.root,sessionId,correction.id,{artifact:path.basename(rel),path:rel,status:'pending_merge',approvalId:approval.id});
   approvals.push(approval);if(!existing)try{broadcast({type:'approval.created',approval});}catch{}
  }
  return {approvals,coverage:{filesScanned:files.length,maxFiles:50,maxBytes:MAX_SIZE}};
 });
}
async function mark(ctx,a,status) {
 for(const c of a.payload.corrections)await markArtifact(ctx.root,a.threadId,c.id,{artifact:path.basename(a.payload.artifact.path),path:a.payload.artifact.path,status,approvalId:a.id},{expectedApprovalId:a.id});
}
export async function decideArtifactRevision({ctx,store,id,action,reason='',broadcast=()=>{}}) {
 const initial=store.getApprovalRequest(id);const rel=initial?.payload?.artifact?.path;
 return serializeFile(path.resolve(ctx.root,typeof rel==='string'?rel:'.pi/invalid-artifact'),async()=>{
  let a=store.getApprovalRequest(id);
  const done=(ok,httpStatus,extra={})=>({ok,httpStatus,approval:a,...extra});
  const emit=()=>{try{broadcast({type:'approval.updated',approval:a});}catch{}};
  if(a.status==='applied')return action==='approve'?done(true,200,{already:true}):done(false,409,{code:'not_rejectable',error:'审批已应用'});
  if(a.status==='rejected')return action==='reject'?done(true,200,{already:true}):done(false,409,{code:'already_rejected',error:'审批已拒绝'});
  if(!ctx||a.payload?.projectId!==ctx.id||a.payload?.threadId!==a.threadId)return done(false,409,{code:'conflict',error:'项目或会话不一致'});
  if(action==='reject') {
   if(!['pending_approval','conflict','failed'].includes(a.status))return done(false,409,{error:'审批正在应用'});
   await mark(ctx,a,'dismissed');
   a=store.transitionApproval(id,{fromStatuses:[a.status],status:'rejected',payload:{...a.payload,status:'rejected'},decision:{reason,by:'local-user'}})||a;emit();return done(true,200);
  }
  if(a.status!=='pending_approval')return done(false,409,{code:a.status,error:'提案不可应用，请重新生成'});
  const proposal=a.payload;let abs,original,backup,wrote=false;
  try {
   if(proposal.schema?.name!=='pe.artifact-revision.proposal'||proposal.schema.version!==1||!proposal.corrections?.length||!proposal.excerpts?.length)throw new Error('invalid proposal schema');
   const currentValues=correctedValues(await readLedger(ctx.root,a.threadId));
   if(proposal.corrections.some(c=>!currentValues.some(v=>v.claim===c.claim&&String(v.from)===String(c.from)&&String(v.to)===String(c.to)))) {
    a=store.transitionApproval(id,{fromStatuses:['pending_approval'],status:'conflict',decision:{reason:'ledger correction superseded'}})||a;emit();return done(false,409,{code:'conflict',error:'台账现值已变化，请重新生成提案'});
   }
   try {abs=await safePath(ctx.root,rel);original=await fs.readFile(abs,'utf8');}
   catch(e) {
    a=store.transitionApproval(id,{fromStatuses:['pending_approval'],status:'conflict',decision:{reason:e.message}})||a;emit();return done(false,409,{code:'conflict',error:'产物路径或基线已变化，请重新生成提案'});
   }
   if(sha(original)!==proposal.artifact.sha256) {
    a=store.transitionApproval(id,{fromStatuses:['pending_approval'],status:'conflict',decision:{reason:'artifact sha256 changed'}})||a;emit();return done(false,409,{code:'conflict',error:'产物已变化，请重新生成提案'});
   }
   let next;
   if(rel.endsWith('.json')) {
    const state=JSON.parse(original);
    for(const p of proposal.excerpts) {
     if(!Array.isArray(p.keys)||!p.keys.length||p.keys.some(k=>['__proto__','prototype','constructor'].includes(k))) throw new Error('invalid patch');
     let parent=state;for(const key of p.keys.slice(0,-1))parent=parent[key];
     const key=p.keys.at(-1);if(parent[key]!==p.before)throw new Error('patch baseline changed');parent[key]=p.after;
    }
    state.revision=(Number(state.revision)||0)+1;
    state.changes=[...(Array.isArray(state.changes)?state.changes:[]),{id:`merge_${id}`,revision:state.revision,kind:'correction_merge',corrections:proposal.corrections.map(c=>c.id),approvalId:id}];
    next=JSON.stringify(state,null,2)+'\n';
   } else {
    next=original;
    for(const p of [...proposal.excerpts].sort((a,b)=>b.start-a.start)) {
     if(!Number.isInteger(p.start)||!Number.isInteger(p.end)||next.slice(p.start,p.end)!==p.before)throw new Error('patch baseline changed');
     next=next.slice(0,p.start)+p.after+next.slice(p.end);
    }
    next+='\n\n更正记录：'+proposal.corrections.map(c=>`${c.claim}：${c.from} → ${c.to}`).join('；')+`（审批 ${id}）\n`;
   }
   a=store.transitionApproval(id,{fromStatuses:['pending_approval'],status:'applying',decision:{by:'local-user'}});
   if(!a)throw new Error('approval already decided');
   const revDir=path.join(ctx.root,'exports','.revisions');
   await fs.mkdir(revDir,{recursive:true});if((await fs.lstat(revDir)).isSymbolicLink())throw new Error('revision symlink forbidden');
   const ext=path.extname(rel),name=path.basename(rel,ext),rev=proposal.artifact.revision||1;
   backup=`exports/.revisions/${name}.r${rev}.${sha(rel).slice(0,8)}.${id}${ext}`;
   await fs.writeFile(path.join(ctx.root,backup),original,{flag:'wx'});
   await atomicWrite(abs,next);wrote=true;
   const readback=await fs.readFile(abs,'utf8');if(readback!==next)throw new Error('readback mismatch');
   let validation=null;
   if(rel.endsWith('.json')) {validation=validateState(JSON.parse(readback));if(!validation.ok)throw new Error('validate-state: '+validation.errors.join('; '));}
   await mark(ctx,a,'merged');
   const finished=store.transitionApproval(id,{fromStatuses:['applying'],status:'applied',appliedAt:new Date().toISOString(),payload:{...proposal,status:'applied'},decision:{by:'local-user',backup,validation}});
   if(!finished)throw new Error('approval finalization failed');a=finished;
   emit();return done(true,200);
  } catch(e) {
   if(wrote) {await atomicWrite(abs,original);await mark(ctx,a,'pending_merge');}
   a=store.transitionApproval(id,{fromStatuses:['pending_approval','applying'],status:'failed',decision:{reason:e.message,backup:backup||null}})||store.getApprovalRequest(id);
   emit();return done(false,409,{code:'apply_failed',error:e.message});
  }
 });
}
