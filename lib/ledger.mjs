/** Durable session facts. All mutations share a per-file in-process queue. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {correctionMatches} from './correction-match.mjs';
const queues=new Map();
const rows=v=>Array.isArray(v)?v:[];
export async function serializeFile(file, fn) {
  const prior=queues.get(file)||Promise.resolve();
  const run=prior.catch(()=>{}).then(fn); queues.set(file,run);
  try {return await run;} finally {if(queues.get(file)===run) queues.delete(file);}
}
function ledgerPath(root,id) {
  if(!root||typeof id!=='string'||!/^[A-Za-z0-9_-]{1,160}$/.test(id)) throw new Error('unsafe session id');
  const file=path.resolve(root,'.pi','ledger',`${id}.json`);
  for(const p of [path.join(root,'.pi'),path.dirname(file),file]) {
    try {if(fs.lstatSync(p).isSymbolicLink()) throw new Error('ledger symlinks forbidden');} catch(e){if(e.code!=='ENOENT') throw e;}
  }
  return file;
}
export function readLedgerSync(root,id) {
  try {const l=JSON.parse(fs.readFileSync(ledgerPath(root,id),'utf8')); return l&&typeof l==='object'&&!Array.isArray(l)?l:null;} catch{return null;}
}
export async function readLedger(root,id) {
  try {const l=JSON.parse(await fsp.readFile(ledgerPath(root,id),'utf8')); return l&&typeof l==='object'&&!Array.isArray(l)?l:null;} catch{return null;}
}
export async function atomicWrite(file,text) {
  const tmp=`${file}.${randomUUID()}.tmp`;
  try {await fsp.writeFile(tmp,text,{flag:'wx',mode:0o600}); await fsp.rename(tmp,file);} finally {await fsp.rm(tmp,{force:true});}
}
async function mutate(root,id,fn) {
  const file=ledgerPath(root,id);
  return serializeFile(file,async()=>{
    await fsp.mkdir(path.dirname(file),{recursive:true}); ledgerPath(root,id);
    let l;
    try {l=JSON.parse(await fsp.readFile(file,'utf8'));} catch(e){if(e.code!=='ENOENT') throw e;}
    l??={version:1,sessionId:id,facts:[],corrections:[],open:[]};
    if(l.version!==1||l.sessionId!==id||!['facts','corrections','open'].every(k=>Array.isArray(l[k]))) throw new Error('invalid ledger schema');
    const result=fn(l); await atomicWrite(file,JSON.stringify(l,null,2)+'\n'); return result;
  });
}
const scalar=v=>['string','number','boolean'].includes(typeof v)&&String(v).length>0&&String(v).length<=2000;
function text(v,name){if(typeof v!=='string'||!v.trim()||v.length>2000) throw new Error(`${name} required (max 2000)`);return v;}
function record(p) {
  text(p.claim,'claim');
  if(!p.evidence||!['cell','page','url','tool','user'].includes(p.evidence.type)) throw new Error('evidence required');
  text(p.evidence.ref,'evidence.ref');
  if(!(Number.isInteger(p.turn)&&p.turn>=0)&&!(typeof p.turn==='string'&&p.turn.length>0&&p.turn.length<=160)) throw new Error('turn required');
  return {id:p.id?text(p.id,'id'):randomUUID(),claim:p.claim,evidence:{type:p.evidence.type,ref:p.evidence.ref},turn:p.turn,createdAt:new Date().toISOString()};
}
function unique(list,item){if(list.some(v=>v.id===item.id)) throw new Error('duplicate ledger id'); list.push(item); return item;}
export async function appendFact(root,id,p) {
  const r=record(p);if(!scalar(p.value)) throw new Error('value required');
  return mutate(root,id,l=>unique(l.facts,{...r,value:p.value,unit:String(p.unit||''),period:String(p.period||'')}));
}
export async function appendCorrection(root,id,p) {
  const r=record(p); if(!scalar(p.from)||!scalar(p.to)||String(p.from)===String(p.to)) throw new Error('distinct from/to required');
  return mutate(root,id,l=>unique(l.corrections,{...r,from:p.from,to:p.to,unit:String(p.unit||''),reason:String(p.reason||''),affects:[]}));
}
export async function appendOpen(root,id,p) {
  text(p.text,'text'); if(p.turn==null) throw new Error('turn required');
  return mutate(root,id,l=>unique(l.open,{id:randomUUID(),text:p.text,turn:p.turn}));
}
export async function resolveOpen(root,id,openId) {
  return mutate(root,id,l=>{const i=l.open.findIndex(o=>o.id===openId);if(i<0) throw new Error('open item not found');return l.open.splice(i,1)[0];});
}
export async function markArtifact(root,id,correctionId,affect,{expectedApprovalId}={}) {
  if(!['pending_merge','merged','dismissed'].includes(affect.status)||!affect.path) throw new Error('invalid artifact status/path');
  return mutate(root,id,l=>{const c=l.corrections.find(c=>c.id===correctionId);if(!c) throw new Error('correction not found');
    const old=c.affects.find(a=>a.path===affect.path);const item={artifact:affect.artifact||affect.path,...affect};
    if(expectedApprovalId && old?.approvalId!==expectedApprovalId) return old;
    if(old) Object.assign(old,item); else c.affects.push(item);return old||item;});
}
export function correctedValues(l) {
  const cs=rows(l?.corrections).filter(c=>c&&scalar(c.from)&&scalar(c.to));
  return cs.map((c,i)=>{let to=c.to;for(const next of cs.slice(i+1)) if(next.claim===c.claim&&String(next.from)===String(to)) to=next.to;
    return {from:c.from,to,unit:c.unit||'',claim:c.claim||''};});
}
const clip=(v,n)=>String(v??'').replace(/[<>\r\n]/g,' ').slice(0,n);
export function summarizeLedger(l) {
  if(!l||typeof l!=='object') return '';
  const cs=correctedValues(l), old=new Set(cs.map(c=>String(c.from)));
  const current=cs.filter(c=>!old.has(String(c.to))).slice(-2).map(c=>`更正现值:${clip(c.to,25)} ${clip(c.unit,10)}`);
  const facts=rows(l.facts).filter(f=>f&&!old.has(String(f.value))).slice(0,2).map(f=>clip([f.id,f.value,f.unit,f.period].filter(v=>v!=null).join(' '),45));
  // Free prose (claim/reason/open text) can quote obsolete values; never inject it.
  return [...current,...facts,rows(l.open).length?'待核项:'+l.open.length:''].filter(Boolean).filter(part=>!cs.some(c=>correctionMatches(part,c,{context:c.claim,allowOld:true}).length)).join('；').slice(0,150);
}
export function pendingMerges(l) {
  return rows(l?.corrections).flatMap(c=>rows(c.affects).filter(a=>a.status==='pending_merge').map(a=>({...a,correctionId:c.id})));
}
