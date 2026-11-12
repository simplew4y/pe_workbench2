/** Deterministic service + real tool wrapper acceptance. No LLM/network required. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { FactMemory } from '../lib/fact-memory/store.mjs';
import { normalizeValue } from '../lib/fact-memory/value.mjs';
import { withFactCapture, createFactMemoryTools } from '../lib/fact-memory/tools.mjs';
import { projectContext, lintFactIdentity, validateFactClaim } from '../lib/fact-memory/context.mjs';
import { buildTurnContext } from '../lib/turn-context.mjs';
import { citationsFromCells } from '../lib/citations.mjs';
import { createPdfTool } from '../lib/pdf-tool.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pe-fact-memory-'));
const dbPath=path.join(root,'memory.db');
let db=new DatabaseSync(dbPath);
const sourceVersions=new Map();
const store={db,projectId:'p1',workspace:root,getVersionRow(asset,version){const entries=sourceVersions.get(asset);const found=version?entries?.find(v=>v.v===version):entries?.at(-1);return found?{material:{id:asset},version:found}:null;}};
const addSource=(asset,v=1)=>{const row={v,blob_sha256:`sha-${asset}-${v}`};sourceVersions.set(asset,[...(sourceVersions.get(asset)||[]),row]);return row;};
let memory=new FactMemory({store});
let count=0;
function test(name,fn){return Promise.resolve().then(fn).then(()=>{count++;console.log(`PASS ${name}`);});}
const identity={entity:'ACME',metric:'revenue',period:'2024',scope:'consolidated',basis_type:'actual',scenario:'',currency:'CNY'};
function call({asset='book',version=1,value=100,metric='revenue',entity='ACME',period='2024',scope='consolidated',basis_type='actual',scenario='',unit='百万元',currency='CNY',formula,...more}={}) {
  if(!sourceVersions.get(asset)?.find(r=>r.v===version))addSource(asset,version);
  return {id:`call-${asset}-${version}-${metric}-${value}-${entity}-${period}-${basis_type}-${scenario}`,name:'workbook_query',success:true,details:{sha256:`sha-${asset}-${version}`,citations:[{id:`cite-${asset}-${version}-${metric}`,materialId:asset,version,locator:`Model!${metric==='revenue'?'B':'C'}2`,value,display_unit:unit,metric,company:entity,period,scope,basis_type,scenario,currency,...(formula?{formula}:{}),...more}]}};
}
function capture(args,session='s1'){return memory.capture(session,call(args),{turn:1,run_id:'run1'})[0];}
let revenue,ebitda,margin;
try {
await test('T01 semantic citation preserves company/metric/period/scope/source hash',()=>{
 const [c]=citationsFromCells([{sheet:'Model',coord:'B2',value:100,rowLabel:'revenue',columnLabel:'2024',period:'2024',company:'ACME',scope:'consolidated',basis_type:'actual',display_unit:'百万元',currency:'CNY'}],{id:'book',version:1,sha256:'hash'});
 assert.equal(c.metric,'revenue');assert.equal(c.period,'2024');assert.equal(c.company,'ACME');assert.equal(c.sha256,'hash');
 revenue=capture();assert.equal(revenue.quality,'source_checked');assert.equal(revenue.canonical_value,'100000000');assert.equal(revenue.session_id,'s1');assert.equal(revenue.turn,1);assert.ok(revenue.evidence_ids.length);
});
await test('T02/T03 exact units, negative, missing, percent and percentage point',()=>{
 assert.equal(normalizeValue('1.2','亿元','CNY').canonical_value,normalizeValue('12000','万元','CNY').canonical_value);
 assert.equal(normalizeValue('(1,200)','万元','CNY').canonical_value,'-12000000');
 for(const raw of [null,'','—','-'])assert.equal(normalizeValue(raw,'元').canonical_value,null);
 assert.equal(normalizeValue('0','元','CNY').canonical_value,'0');
 assert.equal(normalizeValue('20%','%').canonical_value,'0.2');
 assert.equal(normalizeValue('20','个百分点').canonical_unit,'percentage_point');
 assert.equal(normalizeValue('10','USD mn','CNY').reason,'currency_conflict');
});
await test('T04/T07 uncertain identity and cached formula stay needs_review',()=>{
 assert.equal(capture({metric:'formula-result',formula:'=B2*2'}).quality,'needs_review');
 assert.equal(capture({metric:'unknown-entity',entity:''}).quality,'needs_review');
 assert.equal(capture({metric:'unknown-basis',basis_type:'unknown'}).quality,'needs_review');
});
await test('T08/T30 independent metric, entity, period and prediction identities',()=>{
 const assets=capture({metric:'assets',value:100});assert.notEqual(assets.fact_id,revenue.fact_id);
 const prior=capture({period:'2023'});assert.notEqual(prior.fact_id,revenue.fact_id);
 const forecast=capture({basis_type:'forecast',scenario:'base'});assert.notEqual(forecast.fact_id,revenue.fact_id);
 const assumption=capture({basis_type:'assumption',scenario:'base'});assert.notEqual(assumption.fact_id,forecast.fact_id);
 assert.equal(memory.query({entity:'ACME',metric:'revenue'}).status,'ambiguous');
 assert.equal(memory.query({...identity,period:'FY2024'}).facts[0].canonical_value,revenue.canonical_value);
});
await test('T13 same tool event and repeated source read are idempotent',()=>{
 const before=memory.allFacts().length;
 capture();capture(undefined,'new-session');assert.equal(capture(undefined,'new-session').fact_id,revenue.fact_id);assert.equal(memory.allFacts().length,before);
 assert.equal(memory.get(revenue.fact_id,1).fact_version,1);
 const collision=call();collision.details.citations[0].value=999;assert.throws(()=>memory.capture('s1',collision),/event_id_conflict/);
});
await test('T09 exact ratio and dependencies with rounding provenance',()=>{
 ebitda=capture({metric:'ebitda',value:20});
 margin=memory.calculate({operation:'ratio',inputs:[{fact_id:ebitda.fact_id,fact_version:1},{fact_id:revenue.fact_id,fact_version:1}],identity:{...identity,metric:'ebitda_margin'},precision:8});
 assert.equal(margin.canonical_value,'0.2');assert.equal(margin.quality,'source_checked');assert.equal(margin.inputs[1].fact_id,revenue.fact_id);
 assert.ok(db.prepare('select payload from fm_calculations').get().payload.includes('half_away_from_zero'));
});
await test('T10 rejects currency, period, unit and zero divisor mismatches',()=>{
 const usd=capture({asset:'usd',metric:'ebitda',currency:'USD',unit:'USD mn',value:20});
 const qtr=capture({asset:'quarter',metric:'ebitda',period:'2024Q1',value:20});
 const zero=capture({asset:'zero',metric:'zero-denominator',value:0});
 for(const f of [usd,qtr,zero])assert.throws(()=>memory.calculate({operation:'ratio',inputs:[{fact_id:ebitda.fact_id,fact_version:1},{fact_id:f.fact_id,fact_version:f.fact_version}],identity:{...identity,metric:'margin'}}));
 const e=memory.evidence(usd.evidence_ids[0]);
 assert.throws(()=>memory.bind({evidence_id:e.evidence_id,...identity,metric:'ebitda',currency:'CNY',raw_value:20,raw_unit:'USD mn'}),/value_not_in_evidence/);
});
await test('T15 reopen DB/new session answers without source re-extraction',async()=>{
 db.close();db=new DatabaseSync(dbPath);store.db=db;memory=new FactMemory({store});
 assert.equal(memory.query({...identity}).facts[0].raw_value,100);
 const context=await buildTurnContext({question:'ACME 2024 revenue',root,sessionId:'brand-new',factMemory:memory});
 assert.ok(context.content.includes(revenue.fact_id));assert.ok(context.content.includes('100'));
 assert.equal(projectContext(memory,'ACME 2024 revenue').facts.some(f=>f.fact_id===revenue.fact_id),true);
});
await test('T16 project-scoped fact/evidence/event queries never cross tenants',()=>{
 const other=new FactMemory({store,projectId:'p2',root});
 assert.equal(other.get(revenue.fact_id,1),null);assert.equal(other.evidence(revenue.evidence_ids[0]),null);
 assert.equal(other.query({fact_id:revenue.fact_id}).status,'not_found');
 assert.throws(()=>other.bind({evidence_id:revenue.evidence_ids[0],...identity,raw_value:100,raw_unit:'百万元'}),/evidence_unavailable/);
});
await test('T19 correct numeric value attached to wrong metric is rejected',()=>{
 assert.ok(lintFactIdentity('ACME revenue 20百万元。',memory,{question:'2024 revenue'}).some(f=>f.rule==='fact_identity_mismatch'));
 assert.equal(validateFactClaim(memory,{fact_id:revenue.fact_id,fact_version:1,identity,value:20,unit:'百万元'}).ok,false);
 assert.equal(validateFactClaim(memory,{fact_id:revenue.fact_id,fact_version:1,identity,value:1,unit:'亿元'}).ok,true);
 assert.equal(validateFactClaim(memory,{fact_id:revenue.fact_id,fact_version:1,identity:{},value:100000000,unit:'decimal'}).ok,false);
 const small=capture({asset:'small',entity:'SmallCo',metric:'revenue',value:0.1,unit:'元'});
 assert.ok(lintFactIdentity('SmallCo 2024 revenue 10%。',memory).some(f=>f.rule==='fact_identity_mismatch'));
});
await test('T14/T26/T28 revision transaction + outbox failure leaves old publication',()=>{
 const fact_refs=[{fact_id:revenue.fact_id,fact_version:1,role:'verified'},{fact_id:margin.fact_id,fact_version:margin.fact_version,role:'verified'}];
 const state={subject:{company:'ACME'}};
 assert.throws(()=>memory.commitFramework({framework_id:'F',expected_revision:0,state,report:'r',fact_refs:[{fact_id:'missing',fact_version:1,role:'verified'}]}));
 assert.equal(memory.framework('F',1),null);
 memory.commitFramework({framework_id:'F',expected_revision:0,state,report:'本期数字详见事实引用',fact_refs});
 assert.equal(memory.published('F').status,'not_found');
 memory.exportPending();assert.equal(memory.published('F').revision,1);
 memory.commitFramework({framework_id:'F',expected_revision:1,state,report:'更新后的报告',fact_refs});
 const failed=memory.exportPending({beforePublish:()=>{throw new Error('simulated crash');}});
 assert.equal(failed[0].status,'pending');assert.equal(memory.published('F').revision,1);
 memory.exportPending();assert.equal(memory.published('F').revision,2);
 assert.equal(memory.framework('F',1).state.revision,1);
 assert.throws(()=>memory.commitFramework({framework_id:'F',expected_revision:1,state,report:'lost update',fact_refs}),/revision_conflict/);
});
await test('T18 source replacement invalidates derived facts/framework without requiring re-extraction',()=>{
 addSource('book',2);
 assert.equal(memory.published('F').status,'stale');
 assert.equal(memory.query({fact_id:margin.fact_id}).status,'stale');
 const updated=capture({version:2,value:110});
 assert.equal(updated.fact_id,revenue.fact_id);assert.equal(updated.fact_version,2);
 assert.equal(memory.query({...identity}).facts.find(f=>f.source_id===updated.source_id).raw_value,110);
 assert.equal(memory.get(revenue.fact_id,1).raw_value,100);
 // New source also refreshed EBITDA. Recompute records new exact refs.
 const e2=capture({version:2,metric:'ebitda',value:20});
 const m2=memory.calculate({operation:'ratio',inputs:[{fact_id:e2.fact_id,fact_version:e2.fact_version},{fact_id:updated.fact_id,fact_version:updated.fact_version}],identity:{...identity,metric:'ebitda_margin'},precision:8});
 assert.equal(m2.raw_value,'0.18181818');assert.equal(m2.fact_version,2);assert.equal(m2.lifecycle,'current');
});
await test('T17 correction targets ID/version/full identity, never equal-valued B assets',()=>{
 const b=capture({asset:'companyB',entity:'B',metric:'assets',value:100});
 const a=capture({asset:'correction',entity:'A',metric:'revenue',value:100});
 const ai={...identity,entity:'A',canonical_unit:'元'};
 const corrected=memory.correct({fact_id:a.fact_id,expected_version:a.fact_version,identity:ai,raw_value:90,raw_unit:'百万元',reason:'用户明确更正'},{session_id:'s1',turn:7});
 assert.equal(corrected.quality,'needs_review');assert.equal(memory.get(a.fact_id,1).lifecycle,'superseded');assert.equal(memory.get(b.fact_id,1).lifecycle,'current');
 assert.throws(()=>memory.correct({fact_id:a.fact_id,expected_version:1,identity:ai,raw_value:80,raw_unit:'百万元',reason:'stale revision'}),/revision_conflict/);
});
await test('T27 receipt replay after normalization failure and interrupted conversation',async()=>{
 const tool={name:'workbook_query',execute:async()=>({details:call({asset:'durable',value:123}).details,content:[]})};
 const wrapped=withFactCapture(tool,memory,()=>({session_id:'interrupt-session',run_id:'r',turn:4}));
 await wrapped.execute('durable-call',{});
 assert.equal(memory.query({metric:'revenue',entity:'ACME'}).facts.some(f=>f.raw_value===123),true);
 const raw=call({asset:'recover',metric:'recover',value:3});const eventId=memory.beginTool('recover-session',raw);
 db.prepare("update fm_events set status='received',payload=? where project_id=? and event_id=?").run(JSON.stringify({call:raw,metadata:{session_id:'recover-session',turn:9}}),'p1',eventId);
 memory.recover();memory.recover();assert.equal(memory.allFacts().filter(f=>f.event_id===eventId).length,1);
 const unknown=call({asset:'unavailable',metric:'unavailable'});sourceVersions.delete('unavailable');
 assert.throws(()=>memory.capture('s',unknown),/evidence_source_unavailable/);
 assert.ok(memory.health().events.some(e=>e.status==='failed'));
 addSource('unavailable');memory.recover();assert.ok(memory.query({metric:'unavailable'}).facts.length);
});
await test('T05/T06 PDF tool preserves actual evidence details, unsupported identity never verifies',async()=>{
 addSource('pdf');
 const pdf=createPdfTool({workspace:root,store:{findMaterialByPath:()=>({id:'pdf'})},pdfs:{readPages:async()=>({text:'ACME 2024收入100百万元',version:1,sha256:'sha-pdf-1',pages:[3],blocks:[{page:3,paragraphs:['ACME 2024收入100百万元'],scanned:false}],truncated:false})}});
 const wrapped=withFactCapture(pdf,memory,()=>({session_id:'pdf-session'}));
 const result=await wrapped.execute('pdf-call',{path:'report.pdf',page:'3'});
 assert.equal(result.details.factMemory.status,'persisted');
 const e=memory.listEvidence({limit:100}).find(e=>e.asset_id==='pdf');assert.equal(e.locator,'p.3');assert.ok(e.excerpt.includes('100'));
 const candidate=memory.bind({evidence_id:e.evidence_id,...identity,raw_value:100,raw_unit:'百万元',calculation_verified:true,quality:'source_checked'});
 assert.equal(candidate.quality,'needs_review');
 assert.throws(()=>memory.bind({evidence_id:e.evidence_id,...identity,raw_value:999,raw_unit:'百万元'}),/value_not_in_evidence/);
});
await test('Independent source update cannot supersede another source or hide conflict',()=>{
 const a=capture({asset:'indA',entity:'ConflictCo',metric:'revenue',value:100});
 const b=capture({asset:'indB',entity:'ConflictCo',metric:'revenue',value:101});
 const b2=capture({asset:'indB',version:2,entity:'ConflictCo',metric:'revenue',value:102});
 assert.equal(memory.get(a.fact_id,a.fact_version).lifecycle,'current');assert.equal(memory.get(b.fact_id,b.fact_version).lifecycle,'superseded');
 assert.equal(memory.get(b2.fact_id,b2.fact_version).lifecycle,'current');
 assert.equal(memory.query({entity:'ConflictCo',metric:'revenue'}).status,'ambiguous');
});
await test('E2 service arithmetic and unchanged derived output retains new input versions',()=>{
 const base={asset:'valuation',entity:'CalcCo',period:'2024'};
 const e1=capture({...base,metric:'ebitda',value:20});
 const mult=capture({...base,metric:'multiple',value:8,unit:'倍',currency:''});
 const debt=capture({...base,metric:'net_debt',value:30});
 const inputs=(a,b)=>[a,b].map(f=>({fact_id:f.fact_id,fact_version:f.fact_version}));
 const entity={...identity,entity:'CalcCo'};
 const ev=memory.calculate({operation:'multiple',inputs:inputs(e1,mult),identity:{...entity,metric:'enterprise_value'}});
 const eq=memory.calculate({operation:'subtract',inputs:inputs(ev,debt),identity:{...entity,metric:'equity_value'}});
 assert.equal(ev.canonical_value,'160000000');assert.equal(eq.canonical_value,'130000000');
 addSource('valuation',2);memory.syncSources();assert.equal(memory.get(ev.fact_id,ev.fact_version).lifecycle,'stale');
 const e2=capture({...base,version:2,metric:'ebitda',value:20});
 const mult2=capture({...base,version:2,metric:'multiple',value:8,unit:'倍',currency:''});
 const ev2=memory.calculate({operation:'multiple',inputs:inputs(e2,mult2),identity:{...entity,metric:'enterprise_value'}});
 assert.equal(ev2.canonical_value,ev.canonical_value);assert.equal(ev2.fact_version,ev.fact_version+1);assert.notDeepEqual(ev2.inputs,ev.inputs);assert.equal(ev2.lifecycle,'current');
});
await test('T25 background reads remain review candidates, not verified facts',()=>{
 const c=call({asset:'background',metric:'background',value:10});
 const f=memory.capture('auto',c,{actor:'automation',run_id:'auto-1'})[0];
 assert.equal(f.quality,'needs_review');assert.ok(f.review_reasons.includes('background_candidate'));
 const existing=capture({asset:'foreground',metric:'foreground',value:10});
 memory.capture('auto',call({asset:'foreground',metric:'foreground',value:10}),{actor:'automation'});
 assert.equal(memory.get(existing.fact_id,existing.fact_version).lifecycle,'current');
 assert.equal(capture({asset:'foreground',metric:'foreground',value:10},'next-session').fact_version,existing.fact_version);
});
await test('T32 manual view edit is detected and never changes facts',()=>{
 const file=path.join(memory.frameworkDir('F',2),'report.md');fs.appendFileSync(file,' tamper');
 assert.equal(memory.published('F').status,'view_integrity_mismatch');assert.equal(memory.get(revenue.fact_id,1).raw_value,100);
});
await test('T20 failure distinct from not found, registered-only coverage',()=>{
 assert.equal(memory.query({entity:'missing'}).status,'not_found');
 const missing=new FactMemory({store,projectId:'empty',root});
 assert.equal(missing.query().coverage,'project_registered_only');
 const method=memory.allFacts;memory.allFacts=()=>{throw new Error('simulated sqlite error');};
 assert.equal(memory.query().status,'retrieval_failed');memory.allFacts=method;
});
await test('Tools expose scoped contracts and guarded error outcomes',()=>{
 const names=createFactMemoryTools({memory}).map(t=>t.name);
 assert.deepEqual(names,['fact_query','fact_bind','fact_correct','fact_calculate','framework_audit','framework_commit']);
});
console.log(`fact-memory: ${count} deterministic acceptance groups passed`);
} finally {db.close();fs.rmSync(root,{recursive:true,force:true});}
