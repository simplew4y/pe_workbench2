import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createResearchReview,reviewClaims} from '../lib/research-review.mjs';
import {createResearchWriteTool} from '../lib/research-write-tool.mjs';
import {parseAudit,AUDIT_CHECKS} from '../lib/research-audit.mjs';
import {extractPresentation} from '../lib/contracts/index.mjs';
import {createCalcTool} from '../lib/calc-tool.mjs';
import {createValidateStateTool} from '../lib/validate-state-tool.mjs';
import {snapshotMessages} from '../server/agent/snapshot.mjs';
import {attachSessionEvents} from '../server/agent/event-bridge.mjs';
import {createWebFetchTool} from '../lib/web-fetch-tool.mjs';
import {createAgentSession,createWriteToolDefinition,SessionManager,SettingsManager,DefaultResourceLoader} from '@earendil-works/pi-coding-agent';
globalThis.fetch=()=>{throw new Error('network disabled');};
const fixture=()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'report-flow-'));
 const material={id:'book',version:1,name:'模型.xlsx',path:'uploads/model.xlsx'};
 const store={findMaterialByPath:p=>p===material.path?material:null};
 const review=createResearchReview({ctx:{root,store,workbooks:{}}});
 const rawWrite={name:'write',description:'write',execute:async(id,args)=>{
  fs.mkdirSync(path.dirname(path.join(root,args.path)),{recursive:true});fs.writeFileSync(path.join(root,args.path),args.content);
  return {content:[{type:'text',text:'saved'}]};
 }};
 return {root,material,store,review,rawWrite,close:()=>fs.rmSync(root,{recursive:true,force:true})};
};
test('plain tool data is not a rich presentation; broken declared envelopes still fail',()=>{
 for(const result of [{content:[]},{structuredContent:'text'},{details:{structuredContent:{path:'a',ok:true}}}])
  assert.equal(extractPresentation(result).absent,true);
 for(const result of [{presentation:'broken'},{details:{presentation:{schema:{name:'unknown',version:1}}}},{structuredContent:{schemaName:'unknown',schemaVersion:1}}]){
  assert.equal(extractPresentation(result).ok,false);assert.notEqual(extractPresentation(result).absent,true);
 }
});
test('metadata exemptions do not exempt financial claims on the same line',async()=>{
 const check=content=>reviewClaims({content,store:{findMaterialByPath:()=>null},workbooks:{}});
 for(const s of ['- 证券：示例公司（hk01234，港股）','- 信息截止日：2026-11-22（含2026Q3业绩与2026-11-20收盘行情）','- 投资期限：12–24个月'])
  assert.equal((await check(s)).ok,true,s);
 for(const s of ['- 证券：示例公司（hk01234），利润120亿元','- 信息截止日：2026-11-22，利润120亿元','- 投资期限：12–24个月，回报30%'])
  assert.equal((await check(s)).ok,false,s);
});
test('read evidence binds identity-matched quantities without manual claims; mismatches remain blocked',async()=>{
 const f=fixture();try{
  f.review.record({toolCall:{id:'failed',name:'workbook_query'},args:{path:f.material.path},result:{content:[],details:{error:'read failed',materialId:'book',version:1,cells:[{ref:'Model!A1',value:777,unit:'亿元',rowLabel:'利润'}]}}});
  assert.equal(f.review.evidenceSnapshot().length,0,'failed result cannot provide a positive receipt');
  f.review.record({toolCall:{id:'read',name:'workbook_query'},args:{path:f.material.path},result:{content:[],details:{materialId:'book',version:1,name:'模型.xlsx',cells:[
   {ref:'Model!B2',value:120,unit:'亿元',display_unit:'亿元',rowLabel:'营业收入',period:'2026',currency:'CNY'},
  ]}}});
  const good=await f.review.tool.execute('review',{path:'exports/report.md',content:'2026年营业收入120亿元。'});
  assert.equal(good.isError,false,JSON.stringify(good));assert.ok(good.details.automaticBindings.length);
  for(const content of ['2026年营业收入1200亿元。','2025年营业收入120亿元。','2026年营业收入120亿美元。','2026年净利润120亿元。','2026年营业收入120亿元，净利润120亿元。'])
   assert.equal((await f.review.tool.execute('bad',{path:'exports/report.md',content})).isError,true,content);
  f.material.version=2;
  assert.equal((await f.review.tool.execute('stale',{path:'exports/report.md',content:'2026年营业收入120亿元。'})).isError,true);
 }finally{f.close();}
});
test('write routes a report through review once; nested SDK write uses a single exact-body capability',async()=>{
 const f=fixture();try{
  const writer=createResearchWriteTool({rawWrite:f.rawWrite,review:f.review});let audits=0;
  f.review.setAuditor(async()=>{audits++;return {ok:true,status:'reviewed',issues:[]};});
  const saved=await writer.execute('w',{path:'exports/report.md',content:'公司利润取决于收入和成本。'});
  assert.equal(saved.isError,false);assert.equal(audits,1);assert.equal(f.review.artifactSnapshot()[0].saved,true);
  const ctx={executeTool:async(name,args)=>({result:await writer.execute('nested',args)})};
  const direct=await f.review.tool.execute('r',{path:'exports/report.md',content:'利润也受到竞争影响。',save:true},undefined,undefined,ctx);
  assert.equal(direct.isError,false,JSON.stringify(direct));assert.equal(audits,2);
  assert.equal(f.review.takeSavingWrite({path:'exports/report.md',content:'利润也受到竞争影响。'}),false);
  const denied=createResearchWriteTool({rawWrite:f.rawWrite,review:f.review,authorizeWrite:()=>({block:true,reason:'read only'})});
  assert.equal((await denied.execute('no',{path:'exports/report.md',content:'bad'})).isError,true);
  assert.equal(fs.readFileSync(path.join(f.root,'exports/report.md'),'utf8'),'利润也受到竞争影响。');
 }finally{f.close();}
});
test('identical report failures do not repeat paid review; evidence, state and new turns invalidate reuse',async()=>{
 const f=fixture();try{
  let audits=0;f.review.setAuditor(async()=>{audits++;return {ok:false,status:'unavailable',issues:[{check:'audit',reason:'bad protocol'}]};});
  const args={path:'exports/report.md',content:'营业收入88亿元。'};
  for(let i=0;i<2;i++)assert.equal((await f.review.tool.execute('r',args)).isError,true);
  assert.equal(audits,1);
  f.review.record({toolCall:{id:'q',name:'web_fetch'},args:{url:'https://example.test'},result:{content:[{type:'text',text:'新来源 https://example.test'}]}});
  await f.review.tool.execute('r',args);assert.equal(audits,2);
  fs.mkdirSync(path.join(f.root,'exports'),{recursive:true});fs.writeFileSync(path.join(f.root,'exports/analysis-state.json'),'{}');
  await f.review.tool.execute('r',args);assert.equal(audits,3);
  f.review.startRun();await f.review.tool.execute('r',args);assert.equal(audits,4);
 }finally{f.close();}
});
test('contradictory numeric review is quarantined, not a business error or a pass',()=>{
 const checks=Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass']));checks.numeric_units='fail';
 const draft='营业利润率37.7%。';
 const parsed=parseAudit(JSON.stringify({checks,issues:[{check:'numeric_units',excerpt:draft,reason:'与回执一致。当前未发现数值冲突。'}]}),draft);
 assert.equal(parsed.ok,false);assert.equal(parsed.status,'unavailable');assert.equal(parsed.rejectedIssues.length,1);
 assert.equal(parsed.issues.some(i=>i.check==='numeric_units'),false);
 const actual=parseAudit(JSON.stringify({checks,issues:[{check:'numeric_units',excerpt:draft,reason:'部分数字与回执一致，但该利润率与所引单元格冲突。'}]}),draft);
 assert.equal(actual.status,'reviewed');assert.equal(actual.issues[0].check,'numeric_units');
});
test('percentage scale must be explicit; currency is not inherited by dimensionless results',async()=>{
 const calc=createCalcTool();
 assert.equal((await calc.execute('x',{expression:'150/120-1',outputUnit:'%',precision:1})).isError,true);
 const r=await calc.execute('x',{expression:'150/120-1',fromUnit:'decimal',toUnit:'%',precision:1,currency:'HKD'});
 assert.equal(r.details.results[0].value,'25.0');assert.equal(r.details.results[0].currency,null);
 const small=await calc.execute('x',{expression:'0.2',outputUnit:'%',ratioEncoding:'percentage_points'});
 assert.equal(small.details.results[0].value,'0.2');
});
test('state write returns all structure findings immediately; template and validator share enums',async()=>{
 const f=fixture();try{
  const writer=createResearchWriteTool({rawWrite:f.rawWrite,review:f.review});
  const r=await writer.execute('w',{path:'exports/analysis-state.json',content:'{}'});
  assert.notEqual(r.isError,true);assert.equal(r.details.stateValidation.structureValid,false);
  assert.ok(r.details.stateValidation.errors.length>5);
  const template=await createValidateStateTool({workspace:f.root}).execute('t',{action:'template'});
  assert.ok(template.details.template.model.understanding);assert.ok(template.details.enums.multiple_basis.includes('EPS'));
  assert.equal(template.details.template.stage,'draft');
 }finally{f.close();}
});
test('live and refreshed plain read results do not render legacy missing-card errors',()=>{
 let listener;const events=[],presentations=[];
 const entry={id:'s',toolArgs:new Map(),session:{subscribe:fn=>{listener=fn;return ()=>{};}},ctx:{root:'/tmp',store:{saveToolPresentation:r=>presentations.push(r)}}};
 attachSessionEvents(entry,{bus:{broadcast:(_e,p)=>events.push(p)}});
 listener({type:'tool_execution_end',toolCallId:'read',toolName:'read',result:{content:[{type:'text',text:'a'}],structuredContent:'a'}});
 assert.equal(events[0].status,'done');assert.equal(events[0].presentationError,undefined);assert.equal(presentations.length,0);
 const session={messages:[{role:'user',content:'读取资料'},
  {role:'assistant',content:[{type:'toolCall',name:'read',id:'read',arguments:{path:'test.md'}}]},
  {role:'toolResult',toolName:'read',toolCallId:'read',isError:false,content:[{type:'text',text:'a'}]}]};
 const ctx={root:'/tmp',store:{listToolPresentations:()=>[{toolCallId:'read',schemaName:'presentation.error',payload:{error:'tool result has no structured presentation'}}]}};
 const snapshot=snapshotMessages(session,ctx,{id:'s'});
 assert.equal(snapshot.at(-1).tools[0].presentationError,undefined);
 ctx.store.listToolPresentations=()=>[{toolCallId:'read',schemaName:'presentation.error',payload:{error:'invalid schema'}}];
 assert.equal(snapshotMessages(session,ctx,{id:'s'}).at(-1).tools[0].presentationError,'invalid schema');
});
test('network failure preserves safe cause code without exposing connection secrets',async()=>{
 const tool=createWebFetchTool({fetchImpl:async()=>{throw Object.assign(new Error('fetch failed'),{cause:{code:'ECONNRESET',message:'secret proxy credential'}});},
  lookup:async()=>[{address:'93.184.216.34',family:4}]});
 const result=await tool.execute('f',{url:'https://example.test/page'});
 assert.equal(result.isError,true);assert.equal(result.details.causeCode,'ECONNRESET');
 assert.doesNotMatch(JSON.stringify(result),/secret proxy credential/);
});
test('installed SDK uses the guarded custom write rather than its built-in write',async()=>{
 const f=fixture();let session;
 try{
  const loader=new DefaultResourceLoader({cwd:f.root,agentDir:f.root,noExtensions:true,noSkills:true,noPromptTemplates:true,noThemes:true});await loader.reload();
  const writer=createResearchWriteTool({rawWrite:createWriteToolDefinition(f.root),review:f.review});
  ({session}=await createAgentSession({cwd:f.root,agentDir:f.root,resourceLoader:loader,
   sessionManager:SessionManager.inMemory(f.root),settingsManager:SettingsManager.inMemory(),
   tools:['write','review_research'],customTools:[writer,f.review.tool]}));
  const installed=session.agent.state.tools.find(t=>t.name==='write');
  assert.match(installed.description,/自动先审校后保存/);
  const bad=await installed.execute('bad',{path:'exports/report.md',content:'营业收入123亿元。'});
  assert.equal(bad.isError,true);assert.equal(fs.existsSync(path.join(f.root,'exports/report.md')),false);
  const good=await installed.execute('good',{path:'exports/report.md',content:'利润受到收入与成本的影响。'});
  assert.equal(good.isError,false);assert.equal(fs.readFileSync(path.join(f.root,'exports/report.md'),'utf8'),'利润受到收入与成本的影响。');
 }finally{session?.dispose();f.close();}
});
