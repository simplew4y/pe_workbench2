import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createModelWhatifTool } from '../lib/model-whatif-tool.mjs';
import { createWorkbookTraceTool } from '../lib/workbook-trace-tool.mjs';
import { traceGraph,formatTrace } from '../lib/workbook-trace.mjs';
import { validateState } from '../lib/validate-state.mjs';
import { createValidateStateTool } from '../lib/validate-state-tool.mjs';
import { createResearchTools,installResearchContext } from '../lib/research-context.mjs';
import { snapshotMessages } from '../server/agent/snapshot.mjs';
import { lintAnswer } from '../lib/answer-lint.mjs';
import { sofficeInfo } from '../lib/calc-engine.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pe-reliability-integration-'));
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}}
try{
 const original=JSON.parse(fs.readFileSync(new URL('../skills/investment-framework/assets/analysis-state.example.json',import.meta.url)));
 await test('pending draft valid; armed pending invalid; calibrated legacy still valid',async()=>{
  const state=structuredClone(original);state.stage='draft';
  for(const f of state.falsifiers){f.threshold_status='pending';f.status='unknown';f.threshold=null;f.calibration_plan='收集8季同口径数据，明确可容忍误报率后做样本外校准';}
  assert.equal(validateState(state).ok,true,JSON.stringify(validateState(state).errors));
  state.falsifiers[0].status='armed';assert.equal(validateState(state).ok,false);
  assert.equal(validateState(original).ok,true);
  fs.mkdirSync(path.join(root,'exports'),{recursive:true});fs.writeFileSync(path.join(root,'exports','analysis-state.json'),JSON.stringify(state));
  const r=await createValidateStateTool({workspace:root}).execute('x',{path:'exports/analysis-state.json'});assert.equal(r.isError,true);
 });
 await test('runtime ASR status warns only for the linked transcription gap',async()=>{
  const state=structuredClone(original);state.gaps.push({id:'GASR',kind:'tool',status:'open',question:'音频尚未转写',impact:'无法核验',source_ids:['SRC1']});
  assert(validateState(state,{sourceStatus:{SRC1:'done'}}).warnings.some(w=>w.includes('ASR_GAP_STALE')));
  assert(!validateState(state,{sourceStatus:{SRC2:'done'}}).warnings.some(w=>w.includes('ASR_GAP_STALE')));
 });
 await test('trace tool forwards path/impact modes to graph core',async()=>{
  const graph={sheets:[],cells:[['M!A1',null,1,1,1,'input',''],['M!B1','=A1+1',2,1,2,'output','']],edges:[['M!A1','M!B1']]};fs.writeFileSync(path.join(root,'fixture.xlsx'),'fixture');
  const tool=createWorkbookTraceTool({workspace:root,store:{findMaterialByPath:()=>({id:'m'})},workbooks:{traceMaterial:async(_id,args)=>{const result=traceGraph(graph,args);return {...result,text:formatTrace(result)};}}});
  const r=await tool.execute('x',{path:'fixture.xlsx',mode:'path',from:'M!A1',to:'M!B1'});assert.equal(r.details.reachable,true,JSON.stringify(r));assert.match(r.content[0].text,/M!B1/);
 });
 await test('real SDK sends date/ledger on first request, tool continuation and next user turn',async()=>{
  const {Agent}=await import('@earendil-works/pi-agent-core');
  const {AssistantMessageEventStream,getCurrentSystemPrompt,getCurrentTools}=await import('@earendil-works/pi-ai');
  const captured=[];let transforms=0;let preparations=0;let clock=new Date('2026-11-03T00:00:00Z');
  const tool={name:'probe',description:'probe',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'ok'}]})};
  const agent=new Agent({initialState:{systemPrompt:'base',tools:[tool]},transformContext:async messages=>{transforms++;return messages;},prepareNextTurnWithContext:async()=>{preparations++;},streamFn:(_model,context)=>{
   captured.push(context);const stream=new AssistantMessageEventStream();const first=captured.length===1;
   const message={role:'assistant',content:first?[{type:'toolCall',id:'p',name:'probe',arguments:{}}]:[{type:'text',text:'done'}],api:'openai-completions',provider:'test',model:'test',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},stopReason:first?'toolUse':'stop',timestamp:Date.now()};
   stream.push({type:'start',partial:message});stream.push({type:'done',reason:message.stopReason,message});return stream;
  }});
  const record=createResearchTools({workspace:root,getSession:()=>({sessionId:'sdk',messages:[]})})[0];await record.execute('x',{kind:'correction',claim:'2027H1',replaces:'2026H1',source:'user correction'});
  installResearchContext(agent,{workspace:root,id:'sdk',now:()=>clock});await agent.prompt('请核查并纠正上一条回答');assert.equal(captured.length,2);
  assert.match(getCurrentSystemPrompt(captured[0].messages),/本轮交付要求（单项核查）/);
  assert.match(getCurrentSystemPrompt(captured[1].messages),/本轮交付要求（单项核查）/);
  clock=new Date('2026-11-04T00:00:00Z');await agent.prompt('second');assert.equal(captured.length,3);assert.equal(transforms,3);
  for(const c of captured){const prompt=getCurrentSystemPrompt(c.messages);assert.match(prompt,/研究协议/);assert.match(prompt,/最终回答必须直接列出原错/);assert.match(prompt,/2027H1/);assert.match(prompt,/base/);assert.equal((prompt.match(/研究协议/g)||[]).length,1);assert.equal(getCurrentTools(c.messages)[0].name,'probe');}
  assert.match(getCurrentSystemPrompt(captured[2].messages),/2026-11-04/);assert(!getCurrentSystemPrompt(captured[2].messages).includes('本轮交付要求（单项核查）'));
  assert(!getCurrentSystemPrompt(agent.state.messages).includes('研究协议'));assert(preparations>0);
  agent.state.messages=[{role:'system',content:'compacted base',timestamp:0},{role:'user',content:'summary',timestamp:1}];
  await agent.prompt('after compacted context');assert.match(getCurrentSystemPrompt(captured[3].messages),/2027H1/);assert.match(getCurrentSystemPrompt(captured[3].messages),/compacted base/);
  const isolated={transformContext:async m=>m};installResearchContext(isolated,{workspace:root,id:'other'});
  assert(!getCurrentSystemPrompt(await isolated.transformContext([{role:'system',content:'base',timestamp:0}])).includes('2027H1'));

 });
 await test('ledger symlink isolation and artifact stale badge',async()=>{
  const ledgerRoot=path.join(root,'isolated-ledger');fs.mkdirSync(ledgerRoot);
  const outside=fs.mkdtempSync(path.join(os.tmpdir(),'pe-outside-'));try{
   fs.mkdirSync(path.join(ledgerRoot,'.pi'),{recursive:true});fs.symlinkSync(outside,path.join(ledgerRoot,'.pi','ledger'));
   const session={sessionId:'s',messages:[]};const tool=createResearchTools({workspace:ledgerRoot,getSession:()=>session})[0];assert.equal((await tool.execute('x',{kind:'fact',claim:'x',source:'y'})).isError,true);assert.equal(fs.readdirSync(outside).length,0);fs.unlinkSync(path.join(ledgerRoot,'.pi','ledger'));
   await tool.execute('x',{kind:'correction',claim:'72.93亿元',replaces:'7.3亿元',source:'calc',affected_artifacts:['exports/report.md']});
   session.messages=[{role:'user',content:'report',timestamp:1},{role:'assistant',timestamp:2,content:[{type:'text',text:'[报告](exports/report.md)'}]}];
   const messages=snapshotMessages(session,{root:ledgerRoot,store:{listToolPresentations:()=>[]}},{id:'s'});assert(messages[1].qualityWarnings.some(w=>w.code==='ARTIFACT_REVIEW_PENDING'));
  }finally{fs.rmSync(outside,{recursive:true,force:true});}
 });
 await test('lint warns on clear unit equation but preserves quotes/code/corrections',async()=>{
  assert(lintAnswer('7293百万元=7.3亿元').some(w=>w.code==='UNIT_CONVERSION'));
  for(const s of ['7293百万元=72.93亿元','> 7293百万元=7.3亿元','```text\n7293百万元=7.3亿元\n```','原话7293百万元=7.3亿元错误，应为72.93亿元。'])assert.equal(lintAnswer(s).length,0,s);
 });
 await test('what-if rejects formula overwrite, isolates source, cleans temp copies on failure',async()=>{
  const source=path.join(root,'guard.xlsx');fs.writeFileSync(source,'original');let temp;
  const fake={sofficeInfo:async()=>({available:true}),readCells:async(file)=>{temp=path.dirname(file);return {'M!A1':'=B1+1'};}};
  const result=await createModelWhatifTool({workspace:root,calculator:fake}).execute('x',{path:'guard.xlsx',changes:[{cell:'M!A1',value:3}],outputs:['M!B1']});assert.equal(result.isError,true);assert.match(result.content[0].text,/禁止独立扰动/);assert.equal(fs.readFileSync(source,'utf8'),'original');assert.equal(fs.existsSync(temp),false);
  const unavailable=await createModelWhatifTool({workspace:root,calculator:{sofficeInfo:async()=>({available:false})}}).execute('x',{path:'guard.xlsx',changes:[{cell:'M!A1',value:3}],outputs:['M!B1']});assert.equal(unavailable.isError,true);assert.match(unavailable.content[0].text,/未执行重算/);
 });
 await test('real LibreOffice synthetic baseline/scenario; original bytes unchanged',async()=>{
  const info=await sofficeInfo();if(!info.available)throw Error('LibreOffice unavailable: real check not executed');
  const file=path.join(root,'simple.xlsx');execFileSync(process.env.PYTHON_BIN||'python3',['-c','import openpyxl,sys; w=openpyxl.Workbook();s=w.active;s.title="Model";s["A1"]=10;s["B1"]="=A1*2";w.save(sys.argv[1])',file]);const bytes=fs.readFileSync(file);
  const r=await createModelWhatifTool({workspace:root}).execute('x',{path:'simple.xlsx',changes:[{cell:'Model!A1',value:15}],outputs:['Model!B1']});assert.equal(r.isError,undefined,JSON.stringify(r));assert.equal(r.details.outputs[0].baseline,20);assert.equal(r.details.outputs[0].scenario,30);assert.equal(r.details.outputs[0].delta,10);assert.deepEqual(fs.readFileSync(file),bytes);
 });
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log(JSON.stringify({passed,failed}));process.exitCode=failed?1:0;
