/** Durable session facts. All mutations share a per-file in-process queue. */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {correctionMatches} from './correction-match.mjs';
import {convertExact, formatDecimal} from './calc-tool.mjs';
const queues=new Map();
const rows=v=>Array.isArray(v)?v:[];
/**
 * v1 ledgers written before DT-2 have facts/corrections/open only. `claims` is
 * additive and optional on disk: old files stay readable, mutations add it.
 */
function normalizeLedger(l) {
  if(!l||typeof l!=='object'||Array.isArray(l)) return null;
  if(l.claims!==undefined&&!Array.isArray(l.claims)) throw new Error('invalid ledger schema');
  if(!Array.isArray(l.claims)) l.claims=[];
  return l;
}
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
  try {return normalizeLedger(JSON.parse(fs.readFileSync(ledgerPath(root,id),'utf8')));} catch{return null;}
}
export async function readLedger(root,id) {
  try {return normalizeLedger(JSON.parse(await fsp.readFile(ledgerPath(root,id),'utf8')));} catch{return null;}
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
    l??={version:1,sessionId:id,facts:[],corrections:[],open:[],claims:[]};
    if(l.version!==1||l.sessionId!==id||!['facts','corrections','open'].every(k=>Array.isArray(l[k]))) throw new Error('invalid ledger schema');
    normalizeLedger(l);
    const result=fn(l); await atomicWrite(file,JSON.stringify(l,null,2)+'\n'); return result;
  });
}
/** Internal-compatible atomic extension point for additive ledger features. */
export async function updateLedger(root,id,fn) { return mutate(root,id,fn); }
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
const numeric=v=>{const s=String(v??'').replaceAll(',','').trim();return /^[+-]?\d+(?:\.\d+)?$/.test(s)?s:null;};
const numEqual=(a,b)=>{const x=numeric(a),y=numeric(b);return x!=null&&y!=null&&Number(x)===Number(y);};
const unitKey=u=>String(u??'').toLowerCase().replace(/\s+/g,'').replace(/^(rmb|hkd|usd)/,'');
const UNIT_ALIASES={ '亿':'亿元','亿元':'亿元','百万':'百万元','百万元':'百万元','mn':'百万元','million':'百万元','mm':'百万元','m':'百万元','千元':'千元','万元':'万元','元':'元','十亿':'十亿','十亿元':'十亿' };
function sameUnit(a,b) {
  if(!a||!b) return true; // a correction may omit the unit; value match still supersedes.
  const x=UNIT_ALIASES[unitKey(a)]||unitKey(a), y=UNIT_ALIASES[unitKey(b)]||unitKey(b);
  return x===y;
}
export async function appendFact(root,id,p) {
  const r=record(p);if(!scalar(p.value)) throw new Error('value required');
  const optional=Object.fromEntries(['binding','citation','source','scope','status','supersededBy','conflictsWith','fetchedAt','expiresAt'].filter(k=>p[k]!==undefined).map(k=>[k,p[k]]));
  return mutate(root,id,l=>unique(l.facts,{...r,value:p.value,unit:String(p.unit||''),period:String(p.period||''),...optional}));
}
/** User-stated claim (usually an erroneous value) or an explicit doubt. Append-only. */
export async function appendClaim(root,id,p) {
  const r=record(p);
  if(p.value!=null&&!scalar(p.value)) throw new Error('claim value must be scalar');
  if(p.correctValue!=null&&!scalar(p.correctValue)) throw new Error('correctValue must be scalar');
  const item={
    ...r,
    type:p.type==='doubt'?'doubt':'user_claim',
    role:p.role==='assistant'?'assistant':'user',
    value:p.value??null,
    unit:String(p.unit||''),
    correctValue:p.correctValue??null,
    correctUnit:String(p.correctUnit||''),
    period:String(p.period||''),
    status:'active',
    supersededBy:null,
  };
  return mutate(root,id,l=>unique(l.claims,item));
}
export async function appendCorrection(root,id,p) {
  const r=record(p); if(!scalar(p.from)||!scalar(p.to)||String(p.from)===String(p.to)) throw new Error('distinct from/to required');
  return mutate(root,id,l=>{
    const item={...r,from:p.from,to:p.to,unit:String(p.unit||''),reason:String(p.reason||''),affects:[],supersedes:[],resolves:[]};
    unique(l.corrections,item);
    const linked=[];
    if(p.claimId!=null) {
      const c=l.claims.find(c=>c.id===p.claimId);
      if(!c) throw new Error('claim not found');
      linked.push(c);
    }
    // Supersede matching active claims without deleting them. Old claims remain searchable.
    for(const c of l.claims) {
      if(linked.includes(c)||c.status==='superseded') continue;
      if(numeric(c.value)!=null&&numeric(p.from)!=null&&numEqual(c.value,p.from)&&sameUnit(c.unit,p.unit)) linked.push(c);
    }
    for(const c of linked) {
      c.status='superseded';
      c.supersededBy=item.id;
      c.currentValue=p.to;
      c.currentUnit=String(p.unit||'');
    }
    item.supersedes=linked.map(c=>c.id);
    // A claim that already asserted the corrected value is confirmed, not left pending.
    const confirmed=[];
    for(const c of l.claims) {
      if(linked.includes(c)||c.status!=='active') continue;
      if(String(c.value)===String(p.to)&&String(p.from)!==String(p.to)) {c.status='confirmed';c.confirmedBy=item.id;confirmed.push(c);}
    }
    item.resolves=confirmed.map(c=>c.id);
    return item;
  });
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
export function activeClaims(l) {
  return rows(l?.claims).filter(c=>c&&(c.status||'active')==='active');
}
const clip=(v,n)=>String(v??'').replace(/[<>\r\n]/g,' ').slice(0,n);
export function summarizeLedger(l) {
  if(!l||typeof l!=='object') return '';
  const cs=correctedValues(l), old=new Set(cs.map(c=>String(c.from)));
  const current=cs.filter(c=>!old.has(String(c.to))).slice(-2).map(c=>`更正现值:${clip(c.to,25)} ${clip(c.unit,10)}`);
  const facts=rows(l.facts).filter(f=>f&&!old.has(String(f.value))&&(f.status==null||['current','conflict','stale_source'].includes(f.status))).map(f=>{
    const b=f.binding||{}; const binding=[b.company,b.metric,b.line,b.period||f.period,b.currency||b.unit||f.unit].filter(Boolean).join(' / ');
    const status=f.status==='conflict'?'【冲突】':f.status==='stale_source'?'【来源版本已变】':'';
    const marketDay=d=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
    const fetched=f.fetchedAt?new Date(f.fetchedAt):null;
    const expired=f.source==='westock'&&f.fetchedAt&&(!Number.isFinite(fetched?.getTime())||marketDay(fetched)!==marketDay(new Date()))?'【行情已过期，须再查】':'';
    return clip(`${status}${expired}${f.id?`[${f.id}] `:''}${binding?`${binding}：`:''}${f.value}${f.unit?` ${f.unit}`:''}`,240);
  });
  const claims=activeClaims(l).length;
  // Free prose (claim/reason/open text) can quote obsolete values; never inject it.
  return [...current,...facts,claims?`待核主张:${claims}`:'',rows(l.open).length?'待核项:'+l.open.length:''].filter(Boolean).filter(part=>!cs.some(c=>correctionMatches(part,c,{context:c.claim,allowOld:true}).length)).join('\n');
}
export function pendingMerges(l) {
  return rows(l?.corrections).flatMap(c=>rows(c.affects).filter(a=>a.status==='pending_merge').map(a=>({...a,correctionId:c.id})));
}

/* ----------------------------- ledger.search ----------------------------- */
const TENFOLD=/^(?:十倍|10倍|十倍错|十倍错误|order[-_ ]?of[-_ ]?magnitude|oom)$/i;
const escRe=s=>String(s).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const ratioOf=(a,b)=>{const na=numeric(a),nb=numeric(b);if(na==null||nb==null) return null;const x=Number(na),y=Number(nb);return Number.isFinite(x)&&Number.isFinite(y)&&x!==0?Math.abs(y/x):null;};
function claimExpected(c) {
  if(numeric(c.correctValue)==null) return null;
  if(c.unit&&c.correctUnit) {
    try {return formatDecimal(convertExact(c.correctValue,c.correctUnit,c.unit));} catch { /* period/unknown unit */ }
  }
  return String(c.correctValue);
}
function highlight(text,terms) {
  if(!terms.length) return text;
  const re=new RegExp(terms.map(escRe).sort((a,b)=>b.length-a.length).join('|'),'gi');
  return text.replace(re,m=>`**${m}**`);
}
/**
 * Search user+assistant+claim+correction by keyword / magnitude / type.
 * Always returns an array in `matches` (empty when nothing matches); it never
 * turns "no candidates" into the phrase "全部正确".
 */
export function searchLedger(l,opts={}) {
  const rawTerms=String(opts.query||'').trim().split(/\s+/).filter(Boolean).slice(0,20);
  const tenfold=rawTerms.some(t=>TENFOLD.test(t));
  const terms=rawTerms.filter(t=>!TENFOLD.test(t));
  const limit=Math.max(1,Math.min(50,Number(opts.limit)||5));
  const wantedType=opts.type?String(opts.type):null;
  const wantedRole=opts.role?String(opts.role):null;
  let targetRatio=tenfold?10:null, order=null;
  if(opts.magnitude!=null) {
    const m=String(opts.magnitude).trim();
    if(/^\d+(?:\.\d+)?\s*x$/i.test(m)) targetRatio=Number(m.replace(/\s*x$/i,''));
    else if(Number.isFinite(Number(m))) order=Number(m);
  }
  const defs=[];
  const cs=rows(l?.corrections).filter(c=>c&&scalar(c.from)&&scalar(c.to));
  const corrected=correctedValues(l);
  const correctionOld=new Set(cs.map(c=>String(c.from)));
  for(const [i,c] of rows(l?.claims).filter(Boolean).entries()) {
    if(c.type==='doubt'&&wantedType&&!['claim','doubt','user_claim'].includes(wantedType)) continue;
    const expected=claimExpected(c);
    const superseded=c.status==='superseded'||cs.some(x=>numEqual(x.from,c.value)&&sameUnit(x.unit,c.unit));
    const status=superseded?'superseded':(c.status==='confirmed'?'confirmed':'active');
    defs.push({
      kind:'claim', type:c.type||'user_claim', role:c.role||'user', id:c.id, turn:c.turn??null,
      timestamp:c.createdAt??null, status,
      value:c.value??null, unit:c.unit||'', expected, ratio:ratioOf(c.value,expected),
      text:[c.type||'user_claim',c.claim,c.value??'',c.unit||'',c.correctValue??'',c.correctUnit||'',c.period||'',c.status||'active'].join(' '),
    });
  }
  for(const [i,c] of cs.entries()) {
    const final=corrected[i]?.to??c.to;
    const status=String(final)===String(c.to)?'current':'superseded';
    defs.push({
      kind:'correction', type:'correction', role:c.evidence?.type==='user'?'user':'assistant', id:c.id, turn:c.turn??null,
      timestamp:c.createdAt??null, status, value:c.from, unit:c.unit||'', expected:final, ratio:ratioOf(c.from,final),
      text:['correction',c.claim,c.from,c.to,c.unit||'',c.reason||'',status].join(' '),
    });
  }
  for(const f of rows(l?.facts).filter(Boolean)) {
    const status=correctionOld.has(String(f.value))?'superseded':'current';
    defs.push({
      kind:'fact', type:'fact', role:f.evidence?.type==='user'?'user':'assistant', id:f.id, turn:f.turn??null,
      timestamp:f.createdAt??null, status, value:f.value??null, unit:f.unit||'', expected:null, ratio:null,
      text:['fact',f.value??'',f.unit||'',f.period||'',f.claim||'',status].join(' '),
    });
  }
  const matches=[];
  for(const d of defs) {
    if(wantedType) {
      const ok=wantedType==='claim'?['claim','user_claim','doubt'].includes(d.type)
        :wantedType==='user_claim'?['claim','user_claim'].includes(d.type)
        :wantedType==='correction'?d.type==='correction'
        :wantedType==='fact'?d.type==='fact'
        :d.type===wantedType;
      if(!ok) continue;
    }
    if(wantedRole&&d.role!==wantedRole) continue;
    const haystack=d.text.toLowerCase();
    if(!terms.every(t=>haystack.includes(t.toLowerCase()))) continue;
    if(targetRatio!=null) {
      const literal=/十倍|10倍/.test(d.text);
      const near=d.ratio!=null&&d.ratio>=targetRatio/1.5&&d.ratio<=targetRatio*1.5;
      // A money claim without a known expected value is still a self-check candidate.
      const unknown=d.ratio==null&&['claim','correction'].includes(d.kind)&&/元|亿|万|千|mn|million|mm/i.test(d.unit);
      if(!literal&&!near&&!unknown) continue;
    }
    if(order!=null) {
      const n=Number(numeric(d.value));
      if(!Number.isFinite(n)||n===0||Math.round(Math.log10(Math.abs(n)))!==order) continue;
    }
    const excerpt=highlight(String(d.text).replace(/\s+/g,' ').trim(),terms).slice(0,400);
    matches.push({turn:d.turn,role:d.role,type:d.type,status:d.status,id:d.id,timestamp:d.timestamp,value:d.value,unit:d.unit,expected:d.expected,ratio:d.ratio==null?null:Number(d.ratio.toFixed(4)),excerpt});
  }
  matches.sort((a,b)=>(Number(a.turn)||0)-(Number(b.turn)||0)||String(a.timestamp).localeCompare(String(b.timestamp))||String(a.id).localeCompare(String(b.id)));
  return {
    matches:matches.slice(0,limit),
    totalMatches:matches.length,
    coverage:{claimsScanned:rows(l?.claims).filter(Boolean).length,correctionsScanned:cs.length,factsScanned:rows(l?.facts).filter(Boolean).length,totalEvents:defs.length,truncated:matches.length>limit},
  };
}
export const ledgerSearch=searchLedger;
