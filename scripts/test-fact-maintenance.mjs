import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {DatabaseSync} from 'node:sqlite';
import {FactMemory} from '../lib/fact-memory/store.mjs';
import {createFactMemoryTools} from '../lib/fact-memory/tools.mjs';
import {previewLegacy,importLegacy,rollbackLegacy,rebuildFactIndex} from '../lib/fact-memory/maintenance.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pe-import-')),db=new DatabaseSync(':memory:');
const memory=new FactMemory({store:{db,projectId:'p',workspace:root}}),foreign=new FactMemory({store:{db,projectId:'other',workspace:root}});
const dir=path.join(root,'.pi','ledger');fs.mkdirSync(dir,{recursive:true});const file=path.join(dir,'old.json');
const binding={company:'ACME',metric:'revenue',period:'2024',scope:'consolidated',basis_type:'actual',currency:'CNY'};
const ledger={version:1,sessionId:'old',facts:[{id:'a',value:100,unit:'百万元',binding,claim:'Revenue',evidence:{type:'cell',ref:'Old!A1'}},{id:'b',value:90,unit:'百万元',binding,status:'superseded'},{id:'c',value:'—',unit:'百万元'},{id:'d',value:0,unit:'元',binding:{...binding,metric:'net_debt'}}],corrections:[],open:[],claims:[{value:999}]};
fs.writeFileSync(file,JSON.stringify(ledger));const original=fs.readFileSync(file);
try {
 const tool=createFactMemoryTools({memory}).find(t=>t.name==='fact_maintenance');
 const toolPreview=await tool.execute('preview',{action:'preview_legacy',session_id:'old'});assert.equal(toolPreview.details.status,'preview');
 const invalid=await tool.execute('bad',{action:'preview_legacy',session_id:'../outside'});assert.equal(invalid.isError,true);assert.equal(invalid.details.error,'unsafe_session_id');
 const preview=previewLegacy(memory,'old');assert.equal(preview.numeric_candidates,3);assert.equal(preview.claims_not_imported,1);assert.equal(memory.allFacts().length,0);
 assert.throws(()=>previewLegacy(memory,'../../secret'),/unsafe_session_id/);
 fs.symlinkSync(file,path.join(dir,'alias.json'));assert.throws(()=>previewLegacy(memory,'alias'),/ledger_symlinks_forbidden/);
 assert.throws(()=>importLegacy(memory,{session_id:'old',expected_sha256:'a'.repeat(64)}),/legacy_source_changed/);
 const imported=importLegacy(memory,{session_id:'old',expected_sha256:preview.sha256});assert.equal(imported.fact_refs.length,3);assert.equal(imported.status,'imported');assert.equal(foreign.allFacts().length,0);
 const repeated=importLegacy(memory,{session_id:'old',expected_sha256:preview.sha256});assert.equal(repeated.idempotent,true);assert.equal(memory.allFacts().length,3);
 for(const f of memory.allFacts())assert.equal(f.quality,'needs_review');assert.equal(memory.allFacts().filter(f=>f.lifecycle==='current').length,2);
 assert.deepEqual(memory.get(imported.fact_refs[0].fact_id,1).legacy_record,ledger.facts[0]);
 assert.throws(()=>rollbackLegacy(foreign,imported.batch_id),/import_batch_unavailable/);
 const first=memory.get(imported.fact_refs[0].fact_id,1),last=memory.get(imported.fact_refs[2].fact_id,1);
 memory.commitFramework({framework_id:'oldview',expected_revision:0,state:{note:'旧值待核'},report:'旧值待核',fact_refs:[{...imported.fact_refs[2],role:'needs_review',reason:'旧台账待核'}]});memory.exportPending();
 const changed=memory.correct({fact_id:first.fact_id,expected_version:1,identity:first,raw_value:110,raw_unit:'百万元',reason:'user correction'});assert.equal(changed.fact_version,2);
 const rolled=rollbackLegacy(memory,imported.batch_id);assert.equal(rolled.status,'rolled_back');assert.equal(memory.get(first.fact_id,2).lifecycle,'current');assert.equal(memory.get(last.fact_id,1).lifecycle,'stale');assert.equal(memory.published('oldview').status,'stale');assert.equal(rollbackLegacy(memory,imported.batch_id).idempotent,true);
 assert.equal(importLegacy(memory,{session_id:'old',expected_sha256:preview.sha256}).status,'rolled_back');assert.equal(memory.allFacts().length,4);assert.deepEqual(fs.readFileSync(file),original);
 const before=JSON.stringify(memory.allFacts());db.exec('drop index fm_facts_current');assert.equal(rebuildFactIndex(memory).status,'rebuilt');assert.equal(JSON.stringify(memory.allFacts()),before);assert.equal(memory.query({fact_id:first.fact_id}).facts[0].raw_value,110);
 // Failure mid-batch leaves no half-import and source file remains byte-identical.
 fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify({...ledger,sessionId:'failure'}));const failure=previewLegacy(memory,'failure'),append=memory._append.bind(memory);let n=0;memory._append=(...args)=>{const f=append(...args);if(++n===2)throw new Error('injected');return f;};
 assert.throws(()=>importLegacy(memory,{session_id:'failure',expected_sha256:failure.sha256}),/injected/);memory._append=append;assert.equal(memory.allFacts().length,4);assert.equal(previewLegacy(memory,'failure').existing_status,null);
 assert.equal(importLegacy(memory,{session_id:'failure',expected_sha256:failure.sha256}).fact_refs.length,3);
 const lifecycleLedger={version:1,sessionId:'lifecycle',facts:[
   {value:11,unit:'元',status:'stale_source'},
   {value:12,unit:'元',source:'westock',fetchedAt:'2020-01-01T00:00:00Z',expiresAt:'2020-01-02T00:00:00Z'},
   {value:13,unit:'元',claim:'Revenue',status:'current'},
   {value:14,unit:'元',claim:'Unchanged',status:'current'}
 ],corrections:[{from:13,to:15,unit:'元',claim:'Revenue'}],open:[]};
 fs.writeFileSync(path.join(dir,'lifecycle.json'),JSON.stringify(lifecycleLedger));const lifecyclePreview=previewLegacy(memory,'lifecycle');const life=importLegacy(memory,{session_id:'lifecycle',expected_sha256:lifecyclePreview.sha256});
 assert.deepEqual(life.fact_refs.map(r=>memory.get(r.fact_id,r.fact_version).lifecycle),['stale','stale','stale','current']);
 assert.ok(memory.get(life.fact_refs[2].fact_id,1).review_reasons.includes('legacy_correction_requires_reconciliation'));
 fs.writeFileSync(path.join(dir,'lifecycle.json'),JSON.stringify({...lifecycleLedger,corrections:[...lifecycleLedger.corrections,{from:14,to:16,unit:'元'}]}));
 assert.equal(memory.query({fact_id:life.fact_refs[3].fact_id}).status,'stale');
 console.log('PASS legacy preview/import idempotency, review-only migration, scoped rollback, retained correction/dependent invalidation, original bytes unchanged, atomic failure and index rebuild');
} finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
