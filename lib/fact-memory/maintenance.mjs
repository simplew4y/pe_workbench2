/** Explicit compatibility operations. Legacy assertions never become verified.
 * Import/rollback preserve original files and immutable imported payloads.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {normalizeValue,norm} from './value.mjs';
import {isFactExpired} from '../fact-register.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
const fail=code=>{throw Object.assign(new Error(code),{code});};
const timestamp=()=>new Date().toISOString();
const scalar=v=>typeof v==='string'?v:'';
export function legacyObsoleteReason(memory,record,corrections=[]) {
  if(record.supersededBy || (record.status && !['current','conflict'].includes(record.status)))return 'legacy_inactive_status';
  if(isFactExpired(record))return 'legacy_expired';
  if(record.expiresAt && (!Number.isFinite(Date.parse(record.expiresAt)) || Date.now()>=Date.parse(record.expiresAt)))return 'legacy_expired';
  const citation=record.citation;
  if(citation?.materialId && memory.store.getVersionRow) {
    const current=memory.store.getVersionRow(citation.materialId);
    if(!current || Number(current.version.v)!==Number(citation.version))return 'legacy_source_changed';
  }
  for(const correction of corrections.filter(c=>c && typeof c==='object')) {
    const b=record.binding || {},cb=correction.binding || {};
    if(['company','entity','metric','period','scope','basis_type','currency'].some(k=>b[k] && cb[k] && norm(b[k])!==norm(cb[k])))continue;
    const a=normalizeValue(record.value,scalar(record.unit),scalar(b.currency));
    const c=normalizeValue(correction.from,scalar(correction.unit),scalar(cb.currency || b.currency));
    const sameValue=a.canonical_value!=null && c.canonical_value!=null && a.canonical_value===c.canonical_value && a.canonical_unit===c.canonical_unit && a.currency===c.currency;
    const sameRaw=norm(record.value)===norm(correction.from);
    if(sameValue || (sameRaw && (!record.unit || !correction.unit)))return 'legacy_correction_requires_reconciliation';
    if(c.canonical_value==null && correction.claim && norm(correction.claim)===norm(record.claim))return 'legacy_correction_requires_reconciliation';
  }
  return null;
}
function readLegacy(memory,sessionId) {
  if(typeof sessionId!=='string' || !/^[A-Za-z0-9_-]{1,160}$/.test(sessionId))fail('unsafe_session_id');
  const file=path.join(memory.root,'.pi','ledger',sessionId+'.json');
  for(const name of [path.join(memory.root,'.pi'),path.dirname(file),file])if(fs.lstatSync(name).isSymbolicLink())fail('ledger_symlinks_forbidden');
  if(fs.statSync(file).size>10*1024*1024)fail('legacy_ledger_too_large');
  const bytes=fs.readFileSync(file),ledger=JSON.parse(bytes.toString('utf8'));
  if(ledger.version!==1 || ledger.sessionId!==sessionId || !['facts','corrections','open'].every(k=>Array.isArray(ledger[k])))fail('invalid_legacy_schema');
  if(['claims','topics'].some(k=>ledger[k]!==undefined && !Array.isArray(ledger[k])))fail('invalid_legacy_schema');
  if(ledger.facts.some(f=>!f || typeof f!=='object' || Array.isArray(f)))fail('invalid_legacy_fact');
  const accepted=[],skipped=[];
  ledger.facts.forEach((f,index)=>{
    const value=normalizeValue(f.value,scalar(f.unit),scalar(f.binding?.currency));
    (value.canonical_value==null?skipped:accepted).push(index);
  });
  return {ledger,sha256:hash(bytes),accepted,skipped};
}
export function legacySourceUnchanged(memory,source) {
  try {return Boolean(source?.session_id && source.sha256 && readLegacy(memory,source.session_id).sha256===source.sha256);}catch{return false;}
}
const batchId=(session,sha)=>`import:${hash(JSON.stringify([session,sha])).slice(0,32)}`;
const fetchBatch=(m,id)=>m.db.prepare('select * from fm_imports where project_id=? and batch_id=?').get(m.projectId,id);
const summary=row=>{const p=JSON.parse(row.payload);return {batch_id:row.batch_id,status:row.status,session_id:p.session_id,sha256:p.sha256,fact_refs:p.fact_refs,skipped_indices:p.skipped_indices};};
export function previewLegacy(memory,sessionId) {
  const r=readLegacy(memory,sessionId),id=batchId(sessionId,r.sha256),existing=fetchBatch(memory,id);
  return {status:'preview',batch_id:id,session_id:sessionId,sha256:r.sha256,numeric_candidates:r.accepted.length,skipped_indices:r.skipped,claims_not_imported:(r.ledger.claims || []).length,corrections_not_imported:r.ledger.corrections.length,existing_status:existing?.status || null,quality_after_import:'needs_review',source_unchanged:true};
}
export function importLegacy(memory,{session_id,expected_sha256},metadata={}) {
  if(!/^[a-f0-9]{64}$/.test(expected_sha256 || ''))fail('expected_sha256_required');
  const r=readLegacy(memory,session_id);
  if(r.sha256!==expected_sha256)fail('legacy_source_changed');
  const batch_id=batchId(session_id,r.sha256);
  return memory.tx(()=>{
    const existing=fetchBatch(memory,batch_id);if(existing)return {...summary(existing),idempotent:true};
    const refs=[];
    for(const index of r.accepted) {
      const record=r.ledger.facts[index],b=record.binding || {};
      const identity={entity:scalar(b.company || b.entity),metric:scalar(b.metric),period:scalar(b.period || record.period),scope:scalar(b.scope || record.scope),basis_type:['actual','forecast','assumption'].includes(b.basis_type)?b.basis_type:'unknown',scenario:scalar(b.scenario),currency:scalar(b.currency)};
      const obsoleteReason=legacyObsoleteReason(memory,record,r.ledger.corrections);
      const fact=memory._append({...identity,raw_value:record.value,raw_unit:scalar(record.unit),origin_type:'disclosed',reason:obsoleteReason || 'legacy_import_unverified',legacy_record:record,legacy_source:{session_id,sha256:r.sha256},import_batch_id:batch_id,legacy_index:index},{...metadata,session_id,event_id:batch_id},null,{factId:`legacy:${hash(JSON.stringify([batch_id,index])).slice(0,32)}`});
      // Superseded/expired assertions must never return as current after migration.
      if(obsoleteReason)memory.db.prepare("update fm_facts set lifecycle='stale' where project_id=? and fact_id=? and fact_version=?").run(memory.projectId,fact.fact_id,fact.fact_version);
      refs.push({fact_id:fact.fact_id,fact_version:fact.fact_version});
    }
    const payload={schema_version:1,session_id,sha256:r.sha256,fact_refs:refs,skipped_indices:r.skipped,original_ledger:r.ledger,metadata,created_at:timestamp()};
    memory.db.prepare('insert into fm_imports values(?,?,?,?)').run(memory.projectId,batch_id,'imported',JSON.stringify(payload));
    return {...summary(fetchBatch(memory,batch_id)),source_unchanged:true};
  });
}
export function rollbackLegacy(memory,batch_id) {
  return memory.tx(()=>{
    const row=fetchBatch(memory,batch_id);if(!row)fail('import_batch_unavailable');
    if(row.status==='rolled_back')return {...summary(row),idempotent:true};
    const refs=JSON.parse(row.payload).fact_refs;
    for(const ref of refs) {
      const fact=memory.get(ref.fact_id,ref.fact_version);
      if(!fact || fact.import_batch_id!==batch_id)fail('import_integrity_mismatch');
      if(fact.lifecycle==='current')memory.db.prepare("update fm_facts set lifecycle='stale' where project_id=? and fact_id=? and fact_version=?").run(memory.projectId,fact.fact_id,fact.fact_version);
      memory._invalidate(fact);
    }
    memory.db.prepare("update fm_imports set status='rolled_back' where project_id=? and batch_id=?").run(memory.projectId,batch_id);
    return {...summary(fetchBatch(memory,batch_id)),source_unchanged:true};
  });
}
export function rebuildFactIndex(memory) {
  return memory.tx(()=>{
    memory.db.exec('create index if not exists fm_facts_current on fm_facts(project_id,lifecycle); reindex fm_facts_current;');
    const checks=memory.db.prepare('pragma integrity_check').all();
    if(checks.some(row=>Object.values(row)[0]!=='ok'))fail('fact_store_integrity_failed');
    return {status:'rebuilt',index:'fm_facts_current',facts:memory.db.prepare('select count(*) as n from fm_facts where project_id=?').get(memory.projectId).n,source:'immutable_fact_rows',truth_unchanged:true};
  });
}
