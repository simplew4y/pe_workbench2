import assert from 'node:assert/strict';
import {Value} from 'typebox/value';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {reviewClaims,createResearchReview} from '../lib/research-review.mjs';
const store={findMaterialByPath: file=>file==='uploads/model.xlsx'?{id:'m'}:null};
const workbooks={queryMaterial:async(_id,ref)=>({seeds:[ref],cells:[{ref,value:8.34,rowLabel:'ASP (US$ / GB)',columnLabel:'2026E'}]})};
const cell={id:'A',kind:'cell',text:'HBM ASP 8.34 US$/GB（2026E，Assumption!AH122）',valueText:'8.34',file:'uploads/model.xlsx',ref:'Assumption!AH122',value:8.34,unit:'US$ / GB',period:'2026E',entity:'CXMT',metric:'HBM ASP'};
const review=claims=>reviewClaims({content:claims.map(c=>c.text).join('\n'),claims,store,workbooks});
const mode=process.argv[2] || 'all';
if(['all','threshold'].includes(mode)){
 assert.equal((await review([{id:'T',kind:'threshold',text:'良率必须达到50%',value:.5,valueText:'50%',unit:'ratio',rationale:'经验'}])).ok,false);
 assert.equal((await review([{id:'U',kind:'unknown',text:'良率50%阈值无法推导，待验证'}])).ok,true);
 assert.equal((await review([cell,{id:'T',kind:'threshold',text:'阈值8.34',basisId:'A',value:9,valueText:'8.34',unit:cell.unit,rationale:'修改'}])).ok,false);
 assert.equal((await review([cell,{id:'T',kind:'threshold',text:'阈值8.34',basisId:'A',value:8.34,valueText:'8.34',unit:cell.unit,rationale:'沿用模型值作为待核验边界'}])).ok,false);
 const source={id:'s',kind:'source',text:'试验2026失效阈值50%',evidenceId:'e',quote:'试验2026失效阈值50%',locator:'source.pdf',value:.5,valueText:'50%',unit:'ratio',period:'2026',entity:'试验',metric:'失效阈值'};
 const threshold={id:'t',kind:'threshold',text:'阈值50%',basisId:'s',value:.5,valueText:'50%',unit:'ratio',rationale:'原文明确设定'};
 assert.equal((await reviewClaims({content:source.text+'\n'+threshold.text,claims:[source,threshold],store,workbooks,evidence:new Map([['e',source.quote+' source.pdf']])})).ok,true,'explicit source threshold accepted');
 console.log('PASS threshold: missing proof, invented value rejected; unknown accepted; ordinary model value cannot become a threshold');
}
if(['all','comparison'].includes(mode)){
 const a={id:'a',kind:'source',text:'CXMT 2026H1净利率51.6%',value:.516,valueText:'51.6%',unit:'ratio',period:'2026H1',entity:'CXMT',metric:'净利率',product:'all',valueType:'actual',locator:'https://example.test/report'};
 async function compare(patch={}) {
   const b={...a,id:'b',...patch};
   const claims=[a,b].map(c=>({...c,evidenceId:c.id,quote:`${c.entity} ${c.period} ${c.metric} ${c.valueText} ${c.unit}`}));
   const evidence=new Map(claims.map(c=>[c.id,`${c.quote} ${c.locator}`]));
   return reviewClaims({content:[a.text,b.text,'口径对齐'].join('\n'),claims:[...claims,{id:'c',kind:'comparison',text:'口径对齐',leftId:'a',rightId:'b'}],store,workbooks,evidence});
 }
 assert.equal((await compare()).ok,true,'same-basis positive control');
 for(const [field,value] of Object.entries({entity:'SMIC',product:'DDR5',metric:'毛利率',unit:'%',period:'2026FY',valueType:'forecast'})){
   const result=await compare({[field]:value,text:field==='unit'?'CXMT 2026H1净利率51.6%':a.text});
   assert.equal(result.ok,false,field);
   assert.ok(result.errors.some(e=>e.includes(`${field} 不一致`)),JSON.stringify(result));
 }
 console.log('PASS comparison: same basis accepted; company/product/metric/unit/period/actual-vs-forecast mismatch rejected');
}
if(['all','citation'].includes(mode)){
 assert.equal((await review([cell])).ok,true);
 assert.equal((await review([{...cell,unit:'USD/GB'}])).ok,true,'equivalent currency alias and spaces accepted');
 assert.equal((await reviewClaims({content:cell.text,claims:[cell],store,workbooks:{queryMaterial:async()=>({seeds:[cell.ref],cells:[{ref:cell.ref,value:8.34039754980094,rowLabel:'ASP (US$ / GB)',columnLabel:'2026E'}]})}})).ok,true,'rounded tool display can be cited without guessing hidden precision');
 for(const patch of [{unit:'US$ / Gb'},{period:'2027E'},{value:9},{file:'missing'},{text:cell.text.replace('8.34','9.34')},{text:cell.text.replace('GB','Gb')},{text:cell.text+'，另有良率50%'}]) assert.equal((await review([{...cell,...patch}])).ok,false);
 assert.equal((await review([{...cell,text:'# '+cell.text+' 多出50%'}])).ok,false,'headings cannot hide unsupported numbers');
 const uncovered=await reviewClaims({content:'未经核验的良率50%',claims:[],store,workbooks});assert.equal(uncovered.ok,false);
 console.log('PASS citations: exact value/unit/period/file checked, uncovered numeric lines rejected');
}
if(['all','correction'].includes(mode)){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-review-'));fs.mkdirSync(path.join(root,'exports'));
 try{
 const guard=createResearchReview({ctx:{root,store,workbooks}});
 guard.before('workbook_query',{});
 assert.equal(guard.before('write',{path:'exports/report.md',content:'结论50%'}).block,true);
 assert.equal(guard.before('edit',{path:'exports/report.md',oldText:'a',newText:'b'}).block,true);
 const inline={path:'exports/inline.md',file:'uploads/model.xlsx',content:'模型售价 {{Assumption!AH122}}',save:true};
 let nestedCalls=0;
 const toolContext={executeTool:async(name,write)=>{
   assert.equal(name,'write');
   assert.match(write.content,/2026E.*8.34.*Assumption!AH122/);
   fs.writeFileSync(path.join(root,write.path),write.content);nestedCalls++;
   return {isError:false,result:{content:[]}};
 }};
 const saved=await guard.tool.execute('inline',inline,undefined,undefined,toolContext);
 assert.equal(saved.isError,false,JSON.stringify(saved));
 assert.match(saved.content[0].text,/research_write_verified/);
 const bad=await guard.tool.execute('bad',{...inline,content:inline.content+'，失效门槛50%'},undefined,undefined,toolContext);
 assert.equal(bad.isError,true);assert.equal(nestedCalls,1,'unsupported number must prevent save');
 const readOnly=createResearchReview({ctx:{root,store,workbooks},authorizeWrite:()=>({block:true,reason:"只读"})});
 assert.equal((await readOnly.tool.execute('denied',inline,undefined,undefined,toolContext)).isError,true);
 assert.equal(nestedCalls,1,'nested write respects host write roots');
 const partialArgs={...inline,allowPartial:true,path:'exports/partial.md',content:inline.content+'，未经验证50%'};
 assert.equal((await guard.tool.execute('repair1',partialArgs,undefined,undefined,toolContext)).isError,true);
 const partial=await guard.tool.execute('repair2',partialArgs,undefined,undefined,toolContext);
 assert.ok(partial.content.some(p=>p.text.includes('[research_partial_delivery]')));
 assert.doesNotMatch(fs.readFileSync(path.join(root,partialArgs.path),'utf8'),/50%/);
 const args={path:'exports/report.md',content:cell.text,claims:[cell]};
 assert.equal((await guard.tool.execute('id',args)).isError,false);
 assert.equal(guard.before('write',args),undefined);
 assert.equal(guard.record({toolCall:{name:'write'},args,result:{content:[]}}).isError,true,'missing write cannot be declared complete');
 fs.writeFileSync(path.join(root,args.path),args.content);
 assert.match(guard.record({toolCall:{name:'write'},args,result:{content:[]}}).content[0].text,/research_write_verified/);

 assert.equal(guard.before('write',args).block,true,'approval single use');
 await guard.tool.execute('id',args);fs.writeFileSync(path.join(root,args.path),'concurrent change');
 assert.equal(guard.before('write',args).block,true,'baseline changed');
 fs.writeFileSync(path.join(root,'exports/old.md'),'错误：HBM收入占比65%');
 assert.equal((await guard.tool.execute('id',{...args,retracted:['HBM收入占比65%']})).isError,true);
 const old=fs.readFileSync(path.join(root,'exports/old.md'),'utf8');
 const withdrawal='> 已撤回：指标误读，更正见 report.md\n'+old;
 assert.equal(guard.before('write',{path:'exports/old.md',content:withdrawal}),undefined);
 fs.writeFileSync(path.join(root,'exports/old.md'),withdrawal);
 assert.equal((await guard.tool.execute('id',{...args,retracted:['HBM收入占比65%']})).isError,false);
 assert.equal((await guard.tool.execute('id',{...args,path:'../escape.md'})).isError,true);
 const stale='旧报告写道：HBM收入占比达到65%，这是核心估值假设。';
 fs.writeFileSync(path.join(root,args.path),stale);
 fs.writeFileSync(path.join(root,'exports/stale-copy.md'),stale);
 assert.equal((await guard.tool.execute('id',args)).isError,true,'automatically find removed quantitative lines copied to sibling reports');
 fs.symlinkSync(os.tmpdir(),path.join(root,'exports/link'));
 assert.equal((await guard.tool.execute('id',{...args,path:'exports/link/escape-new.md'})).isError,true);
 assert.equal(createResearchReview({ctx:{root,store,workbooks}}).before('write',{path:'exports/plain.md',content:'价格50'}).block,true);
 console.log('PASS correction: full-content approval, edit block, baseline race, old-report scan, withdrawal and path guard');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}

if (mode==='all') {
 const metadata = '> 模型：`uploads/model.xlsx`（2026-09-04 版）\n> 证据截止：2026-11-05\n## 0. 对象身份校准\n## 1. 结论\n## 2.1 假设与失效信号\n| A1 | 待验证 |';
 const check = (content,claims=[],evidence=new Map())=>reviewClaims({content,claims,evidence,store,workbooks,file:'uploads/model.xlsx'});
 assert.equal((await check(metadata)).ok,true,'version/date/heading/table identifiers are metadata');
 assert.equal((await check('> 模型：长鑫 Model 20260904（.xlsx，2026-09-04 版）')).ok,true);
 for (const content of ['## 1. 毛利率已达70%','> 证据截止：2026-11-05，良率70%', '> 模型：2026年毛利率70%', '2026 毛利率待观察', metadata+'\n毛利率70%', '| A1 | 毛利率70% |']) {
  assert.equal((await check(content)).ok,false,'financial claims not exempt: '+content);
 }
 const source={id:'s',kind:'source',text:'甲公司2026年营业利润率70%（来源披露，待独立验证）',evidenceId:'fetch',quote:'公司营业利润率达到70%。',contextQuote:'甲公司2026年财报\n公司营业利润率达到70%。',locator:'https://example.test/report',value:.7,valueText:'70%',unit:'ratio',entity:'甲公司',metric:'营业利润率',period:'2026年'};
 const evidence=new Map([['fetch',{kind:'fetched_document',text:source.contextQuote+'\n'+source.locator}]]);
 assert.equal((await check(source.text,[source],evidence)).ok,true,'verbatim nearby title supplies subject/period');
 assert.equal((await check(source.text,[{...source,contextQuote:source.contextQuote.replace('2026年','2026 年').replace('\n',' '),period:'2026 年'}],evidence)).ok,true,'formatting whitespace is not a factual difference');
 assert.equal((await check(source.text,[source],new Map([['fetch',{kind:'fetched_document',text:evidence.get('fetch').text.replace('70%','7 0%')}]]))).ok,false,'whitespace cannot join distinct numbers');
 const recovered=await check(source.text,[{...source,evidenceId:undefined}],evidence);
 assert.equal(recovered.ok,true);assert.deepEqual(recovered.resolvedEvidence,[{id:'s',evidenceId:'fetch'}]);
 const ambiguous=new Map([...evidence,['other',evidence.get('fetch')]]);
 assert.equal((await check(source.text,[{...source,evidenceId:undefined}],ambiguous)).ok,false,'ambiguous evidence must not be guessed');
 for (const patch of [{evidenceId:'invented'},{quote:'营业利润率为70%'},{entity:'乙公司'},{period:'2027年'},{contextQuote:'甲公司2026年财报\n公司营业利润率为70%。'},{contextQuote:'x'.repeat(2100)+source.contextQuote},{valueText:'营业利润率达到70%'},{value:70},{locator:'https://invented.test'}]) {
  assert.equal((await check(source.text,[{...source,...patch}],evidence)).ok,false,JSON.stringify(patch));
 }
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-source-'));
 try {
  fs.mkdirSync(path.join(root,'exports'));
  const guard=createResearchReview({ctx:{root,store,workbooks}});
  const args={path:'exports/source.md',content:metadata+'\n'+source.text,file:'uploads/model.xlsx',claims:[source],save:true};
  assert.equal(Value.Check(guard.tool.parameters,args),true,'valid source schema');
  for (const patch of [{evidenceId:undefined},{quote:undefined},{value:undefined},{valueText:'营业利润率70%'}]) assert.equal(Value.Check(guard.tool.parameters,{...args,claims:[{...source,...patch}]}),false,'invalid source arguments rejected at contract');
  guard.record({toolCall:{id:'fetch',name:'deepseek_fetch'},args:{url:source.locator},result:{content:[{type:'text',text:evidence.get('fetch').text}]}});
  const restored=createResearchReview({ctx:{root,store,workbooks}});
  restored.restoreEvidence([
    {role:'assistant',content:[{type:'toolCall',id:'fetch',name:'deepseek_fetch'}]},
    {role:'toolResult',toolCallId:'fetch',isError:false,content:[{type:'text',text:evidence.get('fetch').text+'\n[research_evidence_id] fetch'}]},
    {role:'assistant',content:[{type:'toolCall',id:'error-source',name:'deepseek_fetch'}]},
    {role:'toolResult',toolCallId:'error-source',isError:true,content:[{type:'text',text:evidence.get('fetch').text}]}
  ]);
  assert.equal((await restored.tool.execute('resume',{...args,save:false})).isError,false,'resume reuses recorded evidence without refetching');
  restored.restoreEvidence([
    {role:'assistant',content:[{type:'toolCall',id:'wb',name:'workbook_query',arguments:{path:'uploads/model.xlsx'}}]},
    {role:'toolResult',toolCallId:'wb',isError:false,content:[],details:{researchEvidence:[{ref:'Model!C11',value:.7,metricContext:{label:'GM'}}]}}
  ]);
  assert.equal(restored.evidenceSnapshot()[0].metricContext.label,'GM','resume preserves structured workbook semantics for auditing');
  assert.equal((await restored.tool.execute('resume-error',{...args,save:false,claims:[{...source,evidenceId:'error-source'}]})).isError,true,'failed fetch cannot become evidence');
  let audited=0,writes=0;
  guard.setAuditor(async()=>{audited++;return {ok:true,issues:[]};});
  const saved=await guard.tool.execute('save',args,undefined,undefined,{executeTool:async(_name,write)=>{
   fs.writeFileSync(path.join(root,write.path),write.content);writes++;return {result:{content:[]}};
  }});
  assert.equal(saved.isError,false,JSON.stringify(saved));assert.equal(audited,1);assert.equal(writes,1);
  assert.equal(fs.readFileSync(path.join(root,args.path),'utf8'),args.content);
  const broken=Array.from({length:12},(_,i)=>({...source,id:'bad'+i,evidenceId:'missing'+i}));
  const failed=await guard.tool.execute('bad',{...args,path:'exports/bad.md',claims:broken});
  assert.ok(failed.details.errors.some(e=>e.startsWith('claims[11]')),'later claim errors must remain visible');
  assert.match(failed.details.nextStep,/evidenceId/);
  assert.equal(writes,1);assert.equal(audited,1,'bad source blocked before audit/write');
  const excerpt={path:'exports/excerpt.md',save:true,content:'# 核验报告\n\n{{source:s1}}\n\n该比例尚未独立核实，需取得分子分母复算。',
    sources:[{id:'s1',evidenceId:'fetch',quote:source.contextQuote,locator:source.locator}]};
  const writeContext={executeTool:async(_name,write)=>{fs.writeFileSync(path.join(root,write.path),write.content);writes++;return {result:{content:[]}};}};
  assert.equal(Value.Check(guard.tool.parameters,excerpt),true);
  assert.equal((await guard.tool.execute('excerpt',excerpt,undefined,undefined,writeContext)).isError,false);
  const body=fs.readFileSync(path.join(root,excerpt.path),'utf8');
  assert.match(body,/来源原文（不等于独立验证）/);assert.match(body,/70%/);assert.doesNotMatch(body,/\{\{source:/);
  const bound={...excerpt,content:'# 2026 年核验\n\n来源披露营业利润率70%。{{source:s1}}'};
  assert.equal((await guard.tool.execute('bound',bound,undefined,undefined,writeContext)).isError,false,'same-paragraph quote binds restated number');
  assert.equal((await guard.tool.execute('unbound',{...bound,content:'来源披露营业利润率70%。\n\n{{source:s1}}'},undefined,undefined,writeContext)).isError,true,'unrelated paragraph not automatically bound');
  for(const value of ['90%','-70%','202670%']) assert.equal((await guard.tool.execute('invented-number',{...bound,content:'来源披露营业利润率'+value+'。{{source:s1}}'},undefined,undefined,writeContext)).isError,true,'adjacent citation cannot cover fabricated number '+value);
  const beforeWrites=writes;
  for(const patch of [{evidenceId:'fabricated'},{quote:'公司营业利润率为90%。'},{locator:'https://fake.test'}, {quote:source.contextQuote.replace('70%','7 0%')}]) {
   assert.equal((await guard.tool.execute('bad-excerpt',{...excerpt,sources:[{...excerpt.sources[0],...patch}]},undefined,undefined,writeContext)).isError,true);
  }
  assert.equal((await guard.tool.execute('extra-number',{...excerpt,content:excerpt.content+'\n良率门槛50%'},undefined,undefined,writeContext)).isError,true);
  assert.equal(writes,beforeWrites);
  guard.setAuditor(async()=>({ok:false,issues:[{reason:'来源摘录不能证明独立验证'}]}));
  assert.equal((await guard.tool.execute('overclaim',{...excerpt,content:excerpt.content+'\n已独立证实。'},undefined,undefined,writeContext)).isError,true);
  assert.equal(writes,beforeWrites,'source excerpt never bypasses semantic audit');
  guard.setAuditor(async()=>({ok:false,status:'unavailable',issues:[{check:'audit',reason:'审校返回协议错误'}]}));
  assert.equal((await guard.tool.execute('audit-outage',excerpt,undefined,undefined,writeContext)).isError,false,'auditor outage does not veto proven provenance and file save');
  assert.match(fs.readFileSync(path.join(root,excerpt.path),'utf8'),/补充复核暂未完成/);
  assert.equal((await guard.tool.execute('bad-during-outage',{...excerpt,content:excerpt.content+'\n良率门槛99%'},undefined,undefined,writeContext)).isError,true,'real numeric failure still blocks save during outage');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
 console.log('PASS source report regression: metadata, contract, exact evidence recovery, context, complete errors, audited save and negative controls');
}
