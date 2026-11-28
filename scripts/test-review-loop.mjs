import {unfixedLocalFindings} from '../lib/research-delivery.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {auditResearch,createResearchAuditor,revisionScope,evidenceTimeline,AUDIT_CHECKS} from '../lib/research-audit.mjs';
import {selectResearchEvidence,recoveryEvidenceRows} from '../lib/research-evidence-package.mjs';
import {correctReviewerArithmetic,draftArithmetic} from '../lib/audit-arithmetic.mjs';
import {canonicalMetricContext,indexGraph,metricContext} from '../lib/workbook-query.mjs';
import {selectWorkbookAuditEvidence} from '../lib/workbook-audit-evidence.mjs';

globalThis.fetch=()=>{throw Error('Offline regression: network disabled');};
const success=(id,name,text,details={})=>({role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text}],details});
const call=(id,name,args)=>({role:'assistant',content:[{type:'toolCall',id,name,arguments:args}]});
const pass={checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass'])),issues:[]};
const stream=(body,stopReason='stop')=>({async *[Symbol.asyncIterator](){yield {type:'done'};},result:async()=>({stopReason,content:[{type:'text',text:JSON.stringify(body)}]})});

test('standalone cash-flow and tax metrics do not inherit prior interest income; product rows still retain sections',()=>{
 const rowLabels={1:'Interest income',2:'Effective tax rate',3:'Tax, ex-SBC',4:'Capex',5:'Free cash flow',6:'Revenue',7:'Product A'};
 const graph=indexGraph({cells:[],edges:[],sheets:[{name:'Income',rowLabels}]});
 for(const row of [2,3,4,5]){
  const cell={sheet:'Income',row,rowLabel:rowLabels[row],value:100,metricContext:{row:1,label:'Interest income'}};
  assert.equal(metricContext(graph,cell).label,rowLabels[row]);
  assert.equal(canonicalMetricContext(cell).label,rowLabels[row]);assert.equal(cell.metricContext.label,'Interest income','original record is immutable');
 }
 const product={sheet:'Income',row:7,rowLabel:'Product A'};
 assert.equal(metricContext(graph,product).label,'Revenue');
 assert.equal(canonicalMetricContext({...product,metricContext:metricContext(graph,product)}).label,'Revenue');
});

test('atomic scenario receipts retain inputs, versions and outputs when long matching workbook results compete',()=>{
 const messages=[];
 for(let i=0;i<18;i++)messages.push(success('book'+i,'workbook_query',('收入 估值 资本开支 市盈率 现金流 净利润 股本 汇率\n').repeat(800)));
 for(let i=0;i<8;i++)messages.push(call('scenario'+i,'model_whatif',{path:'uploads/company.xlsx',inputs:[{cell:'Valuation!A1',value:10+i}],targets:['Valuation!B2']}),
  success('scenario'+i,'model_whatif','Valuation!B2：100 → '+(80+i),{path:'uploads/company.xlsx',results:[{cell:'Valuation!B2',before:100,after:80+i}],recalculated:true}));
 const draft='收入、估值、资本开支、市盈率、现金流、净利润、股本和汇率。情景S1–S8是单因素敏感性。';
 const pack=selectResearchEvidence(evidenceTimeline(messages),{draft,maxChars:24000,sourceIds:Array.from({length:18},(_,i)=>'book'+i)});
 for(let i=0;i<8;i++){
  const row=pack.timeline.find(r=>r.toolCallId==='scenario'+i);
  assert.ok(row);assert.equal(row.arguments.inputs[0].value,10+i);
  assert.equal(row.receipt.results[0].after,80+i);assert.equal(row.truncated,false);
 }
 assert.ok(JSON.stringify(pack).length<=24000);
 assert.ok(JSON.stringify(recoveryEvidenceRows(pack)).length<=24000);
 const changed=selectResearchEvidence(evidenceTimeline(messages),{draft:draft+'情景目标价999元。',maxChars:24000});
 assert.deepEqual(changed.timeline.filter(r=>r.toolName==='model_whatif').map(r=>r.receipt),pack.timeline.filter(r=>r.toolName==='model_whatif').map(r=>r.receipt));
});

test('failed executions cannot become successful evidence; conflicting successful executions both remain',()=>{
 const rows=evidenceTimeline([success('old','calc','利润=8',{results:[{name:'利润',value:8}]}),success('new','calc','利润=9',{results:[{name:'利润',value:9}]}),
  success('failed','calc','利润=999',{error:'execution failed',results:[{value:999}]})]);
 const pack=selectResearchEvidence(rows,{draft:'利润9亿元'});
 assert.equal(pack.catalog.some(c=>c.id==='failed'),false);
 assert.ok(pack.catalog.some(c=>c.id==='old' && c.included));assert.ok(pack.catalog.some(c=>c.id==='new' && c.included));
 assert.equal(pack.timeline.find(r=>r.toolCallId==='failed')?.receipt,undefined);
});

test('calculation input identity is kept once without duplicating entire worksheet excerpts per operand',()=>{
 const binding={materialId:'m',version:3,locator:'Income!B2',value:100,metric:'Revenue',period:'2026',currency:'CNY',raw_unit:'百万元',formula:'=B3+B4',excerpt:'所有历史行标题。'.repeat(10000)};
 const message=success('calc','calc','收入比率=2',{results:[{name:'收入比率',value:2,unit:'decimal',expression:'revenue/base',evaluatedExpression:'100/50',bindings:{revenue:binding}}]});
 const row=evidenceTimeline([message])[0];const actual=row.receipt.results[0].bindings.revenue;
 for(const field of ['materialId','version','locator','value','metric','period','currency','raw_unit','formula'])assert.deepEqual(actual[field],binding[field]);
 assert.equal(actual.excerptOmitted,true);assert.match(actual.excerptSha256,/^[a-f0-9]{64}$/);
 assert.ok(JSON.stringify(row).length<2000);assert.equal(binding.excerpt.length,80000);
});

test('referenced receipts that cannot fit stop audit before any provider call without certifying the answer',async()=>{
 let calls=0;
 const verdict=await auditResearch(()=>{calls++;throw Error('must not call');},{},{messages:[success('required','web_fetch','原始表格'.repeat(60000))]}, {}, '该来源支持结论。',{sourceIds:['required']});
 assert.equal(calls,0);assert.equal(verdict.ok,false);assert.equal(verdict.status,'unavailable');
 assert.deepEqual(verdict.inputCoverageGaps[0].evidenceIds,['required']);
});

test('unchanged passage links can refer to workbook cells, with file identity retained',async()=>{
 const linked={file:'uploads/a.xlsx',ref:'Income!A2',rowLabel:'Revenue',period:'2026',value:100};
 const other={...linked,file:'uploads/b.xlsx',value:999};
 const id='cell:uploads/a.xlsx:Income!A2';
 const chosen=selectWorkbookAuditEvidence([linked,...Array.from({length:30},()=>other)],'收入100亿元。',150,[id]);
 assert.equal(chosen.cells[0].file,linked.file);
 let calls=0;
 const verdict=await auditResearch((_m,c)=>{
  calls++;const p=JSON.parse(c.messages[0].content[0].text);
  assert.ok(p.workbookEvidence.some(x=>x.file===linked.file && x.value===100));return stream(pass);
 },{},{messages:[]},{},'收入100亿元。',{sourceIds:[id],workbookEvidence:[linked,other]});
 assert.equal(calls,1);assert.equal(verdict.ok,true);
 const missing=await auditResearch(()=>{throw Error('unknown file cannot be approved');},{},{messages:[]},{},'收入100亿元。',
  {sourceIds:['cell:uploads/missing.xlsx:Income!A2'],workbookEvidence:[linked,other]});
 assert.equal(missing.status,'unavailable');
});

test('explicit prose describing an omitted execution is an input gap, not an instruction to erase financial facts',async()=>{
 const draft='敏感性情景得出80元。';
 const response={checks:{...pass.checks,coverage:'fail'},issues:[{check:'coverage',excerpt:draft,reason:'model_whatif 相关调用未包含，本次输入未覆盖其计算链。'}]};
 const verdict=await auditResearch(()=>stream(response),{}, {messages:[success('scenario','model_whatif','全模型原文'.repeat(60000))]}, {},draft);
 assert.equal(verdict.status,'unavailable');assert.equal(verdict.ok,false);
 assert.ok(verdict.inputCoverageGaps.length);assert.equal(verdict.issues.some(i=>i.check==='coverage'),false);
});

test('actual unverified numbers and wrong currency remain finance failures',async()=>{
 const draft='2025年收入100美元。';
 for(const reason of ['来源为人民币且期间是2026年，与正文币种和期间不一致。','没有取得该指标的 calc 成功回执。']){
  const verdict=await auditResearch(()=>stream({checks:{...pass.checks,numeric_units:'fail'},issues:[{check:'numeric_units',excerpt:draft,reason}]}),{}, {messages:[]},{},draft);
  assert.equal(verdict.ok,false);assert.equal(verdict.status,'reviewed');assert.ok(verdict.issues.some(i=>i.check==='numeric_units'));
 }
});

test('an unchanged claim with the same omitted input does not pay another reviewer after cosmetic rewrites',async()=>{
 const audit=createResearchAuditor(),claim='敏感性情景得出80元。';let calls=0;
 const context={messages:[{role:'user',content:'核验敏感性'},success('scenario','model_whatif','不可分割原文'.repeat(60000))]};
 const provider=()=>{calls++;return stream({checks:{...pass.checks,coverage:'fail'},issues:[{check:'coverage',excerpt:claim,reason:'model_whatif 相关调用未包含，本次输入未覆盖。'}]});};
 assert.equal((await audit(provider,{},context,{},claim)).status,'unavailable');
 const repeated=await audit(provider,{},context,{},claim+'补充一段不同措辞。');
 assert.equal(calls,1);assert.equal(repeated.status,'unavailable');assert.equal(repeated.ok,false);
 await audit(provider,{}, {messages:[...context.messages,success('new-source','web_fetch','新增有据输入')]},{},claim);
 assert.equal(calls,2,'new source evidence requires fresh review, not sticky old rejection');
});

test('a turn remembers audit truncation across report and answer reviews, never previous approvals',async()=>{
 const audit=createResearchAuditor(),attempts=[],model={id:'model',provider:'provider',reasoning:true,maxTokens:64000};
 const provider=(_m,_c,o)=>{attempts.push(o.reasoning);return stream(pass,o.reasoning==='low'?'length':'stop');};
 const context={messages:[{role:'user',content:'核验模型',timestamp:1}]};
 for(const mode of ['report','report','answer'])assert.equal((await audit(provider,model,context,{reasoning:'high'},'核验当前草稿。',{mode})).ok,true);
 assert.deepEqual(attempts,['low','off','off','off']);
 await audit(provider,model,{messages:[...context.messages,{role:'user',content:'核验模型',timestamp:2}]},{reasoning:'high'},'新一轮草稿。');
 assert.deepEqual(attempts.slice(-2),['low','off']);
 const failing=await audit(()=>stream({checks:{...pass.checks,numeric_units:'fail'},issues:[{check:'numeric_units',excerpt:'金额99元。',reason:'来源为98元。'}]}),model,context,{},'金额99元。');
 assert.equal(failing.ok,false,'policy cannot cache a financial pass');
});

test('reviewer arithmetic is corrected deterministically while retaining real metric and draft errors',async()=>{
 const issue={check:'numeric_units',excerpt:'归母净利186,983−113,437=69,023。',reason:'分子是净利润，不是归母。186,983−113,437 实际为 69,546，需修正指标和算式。'};
 const result=correctReviewerArithmetic(issue);
 assert.equal(result.corrections.length,1);assert.match(result.issue.reason,/73546/);assert.match(result.issue.reason,/不是归母/);
 const verdict=await auditResearch(()=>stream({checks:{...pass.checks,numeric_units:'fail'},issues:[issue]}),{},{messages:[]},{},issue.excerpt);
 assert.equal(verdict.ok,false);assert.equal(verdict.arithmeticCorrections.length,1);assert.match(verdict.issues[0].reason,/73546/);
 for(const reason of ['100-30=70','1/3≈0.33','1/2=50%','2024-2025为两个财年','该指标含税，不可与不含税指标相比。'])
  assert.equal(correctReviewerArithmetic({...issue,reason}).corrections.length,0,reason);
});

test('preflight separates percentage points, contributions, currencies and rounded units',()=>{
 const one=text=>draftArithmetic(text).map(f=>[f.matches,f.value,f.unit]);
 assert.deepEqual(one('利润率由 18.2% 升至 23.7%，增加 23.7 个百分点。'),[[false,5.5,'个百分点']]);
 assert.deepEqual(one('由 18.2% 降至 13.7%，下降 4.5 个百分点。'),[[true,-4.5,'个百分点']]);
 assert.equal(one('由 18.2% 降至 13.7%，增加 4.5 个百分点。')[0][0],false);
 assert.deepEqual(one('由 18.2% 升至 23.7%，2 个百分点来自提价。'),[]);
 assert.deepEqual(one('收入从 2% 到 3%，净利润率下降 9 个百分点。'),[]);
 assert.deepEqual(one('收入 12,345 百万元 = 123.5 亿元。'),[[true,123.45,'亿元']]);
 assert.deepEqual(one('计算：(6+2)×5 = 400。'),[[false,40,'']]);
 assert.deepEqual(one('份额：3/20 = 15%。'),[[true,15,'%']]);
 assert.deepEqual(one('收入/利润+2 = 4。'),[]);
 assert.deepEqual(one('5 GWh = 50 MWh。'),[[false,5000,'MWh']]);
 assert.deepEqual(one('5 GWh = 5 GW。'),[]);
 assert.deepEqual(one('100 美元 = 100 元。'),[]);
 assert.deepEqual(one('摊薄成本 2 元 = 2 元/股。'),[]);
});

test('a revision retains independent reviewed evidence and checks the whole answer for omissions',async()=>{
 const seen=[];
 const provider=(_model,ctx)=>{
  const payload=JSON.parse(ctx.messages[0].content[0].text);
  seen.push(payload);
  if(payload.revisionScope && !payload.draft.includes('取消订单即失效')) {
   return stream({checks:{...pass.checks,coverage:'fail'},issues:[{check:'coverage',excerpt:'需要跟踪订单。',reason:'原题要求给出证伪条件，改稿删除了条件。'}]});
  }
  return stream(pass);
 };
 const ask='说明经营驱动、估值、风险和证伪条件。';
 const messages=[{role:'user',content:ask,timestamp:1},success('source','workbook_query','财务原表')];
 const auditor=createResearchAuditor();
 const audit=draft=>auditor(provider,{provider:'offline',id:'model'},{messages},{},draft,{revisionAnswer:true,question:ask});
 const old='## 经营\n销量取决于订单。\n\n## 倍数\n按模型 PE!B4 取 15 倍。\n\n## 估值\n目标价按 PE!B4 乘预期盈利。\n\n## 风险\n取消订单即失效。';
 assert.equal((await audit(old)).ok,true);
 const changed=old.replace('15 倍','13 倍').replace('取消订单即失效。','需要跟踪订单。');
 const verdict=await audit(changed),scope=seen.at(-1).revisionScope;
 assert.equal(verdict.ok,false);
 assert.ok(scope.localReview.some(s=>s.heading==='估值'));
 assert.ok(scope.localReview.some(s=>s.heading==='风险'));
 assert.deepEqual(scope.retainedSections.map(s=>s.heading),['经营']);
 assert.equal(seen.at(-1).draft,changed);
 messages.push(success('revised-source','workbook_query','不同版本的新依据'));
 await audit(changed.replace('订单。','合同。'));
 assert.equal(seen.at(-1).revisionScope,undefined);
});

test('an initial numeric rejection cannot approve the revised or unrepaired answer',async()=>{
 const auditor=createResearchAuditor();
 const ctx={messages:[{role:'user',content:'请解释',timestamp:10}]};
 let calls=0;
 const provider=()=>{calls++;return stream(pass);};
 const run=async(draft,allowNumericPreflight)=>auditor(provider,{provider:'offline',id:'m'},ctx,{},draft,{revisionAnswer:true,allowNumericPreflight});
 const bad='营业利润率由 10.0% 升至 20.0%，提高了 20 个百分点。';
 assert.equal((await run(bad,true)).status,'precheck_failed');assert.equal(calls,0);
 assert.equal((await run(bad,false)).ok,false);assert.equal(calls,1);
 assert.equal((await run(bad.replace('提高了 20','提高了 10'),false)).ok,true);assert.equal(calls,2);
});

test('negative review reuse needs an unresolved local defect and unchanged context',()=>{
 const fact='该市场 2028 年销量为 390 万件。', issues=[{check:'comparison_basis',excerpt:fact}];
 const old=['首段','国内业务',fact,'假设不变'].join('\n\n');
 assert.ok(unfixedLocalFindings(old,old.replace('首段','新版摘要'),issues));
 for(const after of [old.replace('2028','2029'),old.replace('国内业务','海外业务'),old+'\n\n'+fact])
  assert.equal(unfixedLocalFindings(old,after,issues),false);
 assert.equal(unfixedLocalFindings(old,old,[{check:'coverage',excerpt:fact}]),false);
});

test('a revised cell range affects overlapping cells, not unrelated sections on the same worksheet',()=>{
 const previous={ok:true,issues:[],draft:'## 订单\n来源 Model!C3，订单金额为五万。\n\n## 融资\n来源 Model!Z9，借款已归还。\n\n## 经营\n采用 Model!B2:D5 的订单明细。'};
 const draft=previous.draft.replace('订单明细','最新订单明细');
 const scope=revisionScope(previous,draft);
 assert.deepEqual(scope.localReview.map(x=>x.heading),['订单','经营']);
 assert.deepEqual(scope.retainedSections.map(x=>x.heading),['融资']);
});
