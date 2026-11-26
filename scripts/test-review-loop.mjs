import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createResearchReview} from '../lib/research-review.mjs';
import {createNumericReviewReuse} from '../lib/report-numeric-reuse.mjs';
import {auditResearch,createResearchAuditor,evidenceTimeline,AUDIT_CHECKS} from '../lib/research-audit.mjs';
import {selectResearchEvidence,recoveryEvidenceRows} from '../lib/research-evidence-package.mjs';
import {correctReviewerArithmetic} from '../lib/audit-arithmetic.mjs';
import {canonicalMetricContext,indexGraph,metricContext} from '../lib/workbook-query.mjs';
import {selectWorkbookAuditEvidence} from '../lib/workbook-audit-evidence.mjs';

globalThis.fetch=()=>{throw Error('Offline regression: network disabled');};
const success=(id,name,text,details={})=>({role:'toolResult',toolCallId:id,toolName:name,content:[{type:'text',text}],details});
const call=(id,name,args)=>({role:'assistant',content:[{type:'toolCall',id,name,arguments:args}]});
const pass={checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass'])),issues:[]};
const stream=(body,stopReason='stop')=>({async *[Symbol.asyncIterator](){yield {type:'done'};},result:async()=>({stopReason,content:[{type:'text',text:JSON.stringify(body)}]})});

test('report retry only requests fresh numeric coverage for the changed block but still sends the whole draft',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'pe-numeric-review-'));
 try {
  const review=createResearchReview({ctx:{root,store:{findMaterialByPath:()=>null}}});
  const stable='基准目标价为 129 元。', initial='现价隐含市盈率为 19.5 倍。', revised='现价隐含市盈率为 14.89 倍。';
  const draft=text=>`## 模型估值\n\n${stable}\n\n## 市场对比\n\n${text}`;
  const audits=[];
  review.setAuditor(async(text,extra)=>{
   audits.push({text,extra});
   if(audits.length===1)return {status:'reviewed',ok:false,coverageValidated:[0],
    reusableNumericCoverage:[{index:0,evidenceIds:['cell:model:Valuation!A1']}],
    issues:[{check:'comparison_basis',excerpt:initial,reason:'分母口径有误'}]};
   return {status:'reviewed',ok:true,coverageValidated:extra.unboundNumericLines.map((_,index)=>index),issues:[]};
  });
  const run=text=>review.tool.execute('report',{path:'exports/投资框架报告.md',content:draft(text)});
  assert.equal((await run(initial)).isError,true);
  const result=await run(revised);
  assert.equal(result.isError,false);
  assert.deepEqual(audits.map(audit=>audit.extra.unboundNumericLines.length),[2,1]);
  assert.equal(audits[1].text,draft(revised));
  assert.equal(result.details.reusedNumericCoverageCount,1);
  await writeFile(path.join(root,'source.txt'),'new evidence');
  review.record({toolCall:{name:'read',id:'new'},args:{path:'source.txt'},result:{content:[{type:'text',text:'new evidence'}]}});
  await run(revised);
  assert.equal(audits[2].extra.unboundNumericLines.length,2);
 } finally { await rm(root,{recursive:true,force:true}); }
});

test('numeric receipts cannot cover changed context, ambiguous lines, gaps or a later contradiction',()=>{
 const reuse=createNumericReviewReuse();
 const line='目标价 129 元', draft=`## 目标估值\n\n${line}`;
 const receipt={status:'reviewed',coverageValidated:[0],reusableNumericCoverage:[{index:0,evidenceIds:['valid']}],issues:[]};
 reuse.prepare('same',draft,[3],[line]).merge(receipt);
 assert.equal(reuse.prepare('same',draft,[3],[line]).reusedCount,1);
 assert.equal(reuse.prepare('same',draft.replace('目标估值','实际价格'),[3],[line]).reusedCount,0);
 assert.equal(reuse.prepare('same',draft+'\n\n'+line,[3,5],[line,line]).reusedCount,0);
 const gap=reuse.prepare('same',draft,[3],[line]).merge({status:'unavailable',inputCoverageGaps:[{}]});
 assert.deepEqual(gap.coverageValidated,[]);
 const contradiction=reuse.prepare('same',draft,[3],[line]).merge({status:'reviewed',issues:[{excerpt:line}]});
 assert.deepEqual(contradiction.coverageValidated,[]);
 assert.equal(reuse.prepare('same',draft,[3],[line]).reusedCount,0);
 reuse.prepare('same',draft,[3],[line]).merge({...receipt,reusableNumericCoverage:[]});
 assert.equal(reuse.prepare('same',draft,[3],[line]).reusedCount,0);
});

test('report auditor issues reusable coverage only for real, included evidence without a matching objection',async()=>{
 const first='目标价为 129 元。', second='市盈率为 19.5 倍。';
 const reviewed=await auditResearch(()=>stream({
  ...pass,checks:{...pass.checks,comparison_basis:'fail'},
  issues:[{check:'comparison_basis',excerpt:second,reason:'口径不一致'}],
  numericCoverage:[{index:0,evidenceIds:['source']},{index:1,evidenceIds:['source']},{index:2,evidenceIds:['invented']}],
 }),{}, {messages:[success('source','web_fetch','模型目标价为 129 元；历史市盈率为 19.5 倍。')]}, {},
 `${first}\n\n${second}\n\n净利润为 999 元。`, {mode:'report',unboundNumericLines:[first,second,'净利润为 999 元。']});
 assert.deepEqual(reviewed.reusableNumericCoverage,[{index:0,evidenceIds:['source']}]);
 assert.equal(reviewed.ok,false);
});

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
