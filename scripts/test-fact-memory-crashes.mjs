import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn,spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {FactMemory} from '../lib/fact-memory/store.mjs';
import {previewLegacy,importLegacy} from '../lib/fact-memory/maintenance.mjs';
const base=fs.mkdtempSync(path.join(os.tmpdir(),'pe-faults-')),worker=fileURLToPath(new URL('./fixtures/fact-memory-crash-worker.mjs',import.meta.url));
const open=root=>{const db=new DatabaseSync(path.join(root,'test.db'));db.exec('pragma journal_mode=WAL; pragma busy_timeout=5000;');return new FactMemory({store:{db,projectId:'p',workspace:root}});};
const make=label=>{const root=path.join(base,label);fs.mkdirSync(root);return root;};
const kill=(root,mode)=>{const result=spawnSync(process.execPath,[worker,root,mode],{encoding:'utf8'});assert.equal(result.signal,'SIGKILL',JSON.stringify(result));};
const seed=memory=>{const f=memory.capture('seed',{id:'one',name:'workbook_query',success:true,details:{sha256:'sha',citations:[{materialId:'m',version:1,locator:'S!B2',company:'ACME',metric:'revenue',period:'2024',scope:'consolidated',basis_type:'actual',currency:'CNY',value:100,display_unit:'百万元'}]}})[0];memory.commitFramework({framework_id:'F',expected_revision:0,state:{note:'old'},report:'旧版本',fact_refs:[{fact_id:f.fact_id,fact_version:f.fact_version,role:'verified'}]});memory.exportPending();return f;};
try {
 for(const mode of ['start','receipt','normalization']) {
  const root=make(mode);let memory=open(root);memory.db.close();kill(root,mode);memory=open(root);
  assert.equal(memory.allFacts().length,0);memory.recover({markInterrupted:true});
  if(mode==='start')assert.equal(memory.health().events[0].status,'interrupted');
  else {assert.equal(memory.allFacts().length,1);assert.equal(memory.health().events[0].status,'processed');memory.recover();assert.equal(memory.allFacts().length,1);assert.equal(memory.listEvidence().length,1);}
  memory.db.close();
 }
 const root=make('publication');let memory=open(root);seed(memory);memory.db.close();
 kill(root,'commit');memory=open(root);assert.equal(memory.framework('F',2).status,'pending');assert.equal(memory.published('F').revision,1);assert.equal(fs.existsSync(path.join(root,'exports/fact-memory/F/r2')),false);memory.db.close();
 kill(root,'export-first');memory=open(root);assert.equal(memory.published('F').revision,1);assert.ok(fs.existsSync(path.join(root,'exports/fact-memory/F/r2/analysis-state.json')));assert.equal(fs.existsSync(path.join(root,'exports/fact-memory/F/r2/report.md')),false);memory.db.close();
 kill(root,'export-both');memory=open(root);assert.equal(memory.published('F').revision,1);assert.ok(fs.existsSync(path.join(root,'exports/fact-memory/F/r2/report.md')));assert.equal(memory.exportPending()[0].revision,2);assert.equal(memory.published('F').revision,2);assert.deepEqual(memory.exportPending(),[]);assert.equal(memory.db.prepare('select count(*) as n from fm_frameworks').get().n,2);memory.db.close();
 const imported=make('import');memory=open(imported);memory.db.close();fs.mkdirSync(path.join(imported,'.pi/ledger'),{recursive:true});const ledger=JSON.stringify({version:1,sessionId:'old',facts:[{value:10,unit:'元'},{value:20,unit:'元'}],corrections:[],open:[]});fs.writeFileSync(path.join(imported,'.pi/ledger/old.json'),ledger);
 kill(imported,'import');memory=open(imported);assert.equal(memory.allFacts().length,0);const preview=previewLegacy(memory,'old');assert.equal(preview.existing_status,null);assert.equal(importLegacy(memory,{session_id:'old',expected_sha256:preview.sha256}).fact_refs.length,2);assert.equal(fs.readFileSync(path.join(imported,'.pi/ledger/old.json'),'utf8'),ledger);memory.db.close();
 const raceRoot=make('race');memory=open(raceRoot);seed(memory);memory.db.close();const gate=path.join(raceRoot,'go');
 const racers=Array.from({length:2},()=>new Promise((resolve,reject)=>{const p=spawn(process.execPath,[worker,raceRoot,'race',gate]);let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('exit',code=>{if(code!==0)reject(new Error(err));else try{resolve(JSON.parse(out));}catch(e){reject(e);}});}));
 fs.writeFileSync(gate,'go');const results=await Promise.all(racers);assert.equal(results.filter(r=>r.status==='pending').length,1,JSON.stringify(results));assert.equal(results.filter(r=>r.error==='revision_conflict').length,1,JSON.stringify(results));memory=open(raceRoot);assert.equal(memory.db.prepare('select count(*) as n from fm_frameworks').get().n,2);memory.exportPending();assert.equal(memory.published('F').revision,2);memory.db.close();
 console.log('PASS SIGKILL before receipt, after receipt, during normalization/import transactions, after framework DB commit, after first/both export files; idempotent recovery and two-process revision race');
} finally {fs.rmSync(base,{recursive:true,force:true});}
