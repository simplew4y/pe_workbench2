import {retainedScenarioCalculations} from '../lib/retained-read-evidence.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {createResearchReview} from '../lib/research-review.mjs';
import {selectWorkbookAuditEvidence} from '../lib/workbook-audit-evidence.mjs';
import {calcFailureRecovery,recoveredUnitConversions} from '../lib/tool-failure-recovery.mjs';
import {unitConvert} from '../lib/calc-tool.mjs';
import {derivedCitation} from '../lib/citations.mjs';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {accountingReasoningIssues} from '../lib/research-reasoning.mjs';
import {researchPortion} from '../server/agent/answer-delivery.mjs';
globalThis.fetch=()=>{throw Error('Offline regression: network disabled');};

const source=(locator,value,display_unit='亿元',metric='收入')=>({id:locator,materialId:'book',version:1,filename:'模型.xlsx',locator,value,display_unit,metric});
test('evidence archive survives large reads; audit budgets select cited early cells without deleting them',()=>{
  const guard=createResearchReview({ctx:{root:'/tmp',store:{},workbooks:{}}});
  for(let batch=0;batch<8;batch++)guard.record({toolCall:{id:'read'+batch,name:'workbook_trace'},args:{path:'模型.xlsx'},
    result:{details:{cells:Array.from({length:100},(_,i)=>({ref:'Model!A'+(batch*100+i+1),value:batch*100+i+1,unit:'亿元'}))},content:[]}});
  const archive=guard.evidenceSnapshot();assert.equal(archive.length,800);
  const selected=selectWorkbookAuditEvidence(archive,'已读取的资料：[模型.xlsx]Model!A1、A2',1500);
  assert.ok(selected.cells.some(c=>c.ref==='Model!A1'));assert.equal(selected.coverage.truncated,true);
  assert.ok(selected.cells.some(c=>c.ref==='Model!A2'));
  assert.equal(guard.evidenceSnapshot().length,800);
  const second=selectWorkbookAuditEvidence(archive,'[模型.xlsx]Model!A750',1500);
  assert.ok(second.cells.some(c=>c.ref==='Model!A750'));
});

const x=source('Model!A1',30),y=source('Model!A2',80);
const failed={id:'failed',name:'calc',success:true,args:{expressions:[{name:'原比例',expression:'numerator/DEN',ratioEncoding:'fraction',bindings:{numerator:x,DEN:y}}]},
  result:{details:{failures:[{index:0,error:'缺少结果单位'}]}}};
const retry={id:'retry',name:'calc',success:true,args:{expressions:[{name:'修订后的中文名称',expression:'a/b*100',outputUnit:'%',ratioEncoding:'percentage_points',bindings:{a:x,b:y}}]},
  result:{details:{results:[{index:0,name:'修订后的中文名称',expression:'a/b*100',evaluatedExpression:'30/80*100',value:'37.5',unit:'%',bindings:{a:x,b:y}}]}}};
test('bound ratio recovery survives renamed variables and explicit percent conversion, never different source/formula/scale',()=>{
  assert.equal(calcFailureRecovery([failed,retry])[0].unresolved.length,0);
  for(const change of ['denominator','version','scale','inverse','currency']) {
    const bad=structuredClone(retry),a=bad.args.expressions[0],r=bad.result.details.results[0];
    if(change==='denominator'){a.bindings.b.locator='Model!A3';r.bindings.b.locator='Model!A3';}
    if(change==='version'){a.bindings.b.version=2;r.bindings.b.version=2;}
    if(change==='scale')a.expression='a/b';
    if(change==='inverse')a.expression='b/a*100';
    if(change==='currency')a.currency='USD';
    assert.equal(calcFailureRecovery([failed,bad])[0].unresolved.length,1,change);
  }
});
test('CNY unit conversions and dimensionless derived citations preserve semantics',()=>{
  assert.equal(unitConvert({value:2300000,from_unit:'百万元',to_unit:'万亿元',currency:'CNY',precision:2}).value,'2.30');
  const ratio=derivedCitation({value:'37.5',unit:'%',name:'占比'},[{...x,currency:'HKD'}, {...y,currency:'HKD'}],{role:'derived_calc_0',toolCallId:'ratio'})[0];
  assert.equal(ratio.currency,undefined);
  const f={id:'f',name:'unit_convert',success:false,args:{value:100,from_unit:'百万元',to_unit:'亿元',currency:'CNY',citations:[x]}};
  const args={...f.args};delete args.currency;
  const good={id:'g',name:'unit_convert',success:true,args,result:{details:unitConvert(args)}};
  assert.ok(recoveredUnitConversions([f,good]).has('f'));
  assert.ok(!recoveredUnitConversions([f,{...good,args:{...args,citations:[{...x,version:2}]}}]).has('f'));
});
test('trillion amounts, percentages and distinct operating margins are not misbound',()=>{
  const citations=[{...source('S!A1',2300000,'百万元','核心业务价值'),currency:'CNY'},
    source('S!B1',14.7,'%','投资占比'),source('S!C1',0.557,'%', '% operating margin'),
    source('S!D1',37.7,'%','集团经营利润率')];citations[2].raw_unit='decimal';
  const context={citations,question:'解释模型',toolCalls:[]};
  for(const text of ['核心业务价值2.30万亿元人民币，投资占比14.7%。','国内业务经营利润率55.7%。'])
    assert.deepEqual(financialEvidenceFindings(text,context,[]).filter(f=>f.severity==='error'),[],text);
  assert.ok(financialEvidenceFindings('核心业务价值23.0万亿元人民币。',context,[]).some(f=>f.severity==='error'));
  assert.ok(financialEvidenceFindings('核心业务价值2.30万亿美元。',context,[]).some(f=>f.severity==='error'));
});
test('paragraph references bind source identity; explicit wrong local citations still fail',()=>{
  const context={citations:[source('S!A1',120),source('S!A2',25,'亿元','利润')],toolCalls:[]};
  assert.equal(financialEvidenceFindings('收入120亿元。利润25亿元。[模型.xlsx]S!A1、A2',context,[]).filter(f=>f.severity==='error').length,0);
  assert.ok(financialEvidenceFindings('收入120亿元[模型.xlsx]S!A2。',context,[]).some(f=>f.severity==='error'));
});
test('unknown unit is not absence, but never hides a known currency or period conflict',()=>{
  const c={...source('S!A1',12,'unit_unknown','市盈率'),currency:'HKD',period:'2025'};
  const context={citations:[c],toolCalls:[]};
  const metadata=financialEvidenceFindings('2025年市盈率12倍[模型.xlsx]S!A1。',context,[]);
  assert.ok(metadata.some(f=>f.severity==='warning' && f.evidenceStatus==='metadata_missing'));
  assert.ok(financialEvidenceFindings('2024年市盈率12倍[模型.xlsx]S!A1。',context,[]).some(f=>f.severity==='error'));
  assert.ok(financialEvidenceFindings('价值12美元[模型.xlsx]S!A1。',context,[]).some(f=>f.severity==='error'));
  assert.ok(financialEvidenceFindings('净利润12亿元[模型.xlsx]S!A1。',context,[]).some(f=>f.severity==='error'));
});
test('scenario inputs require a matching input and output transition from one successful recalculation',()=>{
  const input={...source('V!A1',24,'倍','市盈率'),storedFilename:'stored.xlsx'};
  const context={citations:[input,source('V!B1',120,'元/股','目标价')],toolCalls:[{id:'scenario',name:'model_whatif',success:true,
    args:{path:'uploads/stored.xlsx',inputs:[{cell:'V!A1',value:18}]},result:{details:{path:'uploads/stored.xlsx',recalculated:true,
      inputs:[{cell:'V!A1',value:18}],results:[{cell:'V!B1',before:120,after:90}]}}}]};
  assert.equal(financialEvidenceFindings('市盈率24→18倍：120→90。',context,[]).filter(f=>f.severity==='error').length,0);
  for(const statement of ['市盈率24→17倍：120→90。','市盈率24→18倍：120→80。'])
    assert.ok(financialEvidenceFindings(statement,context,[]).some(f=>f.severity==='error'),statement);
  const failed=structuredClone(context);failed.toolCalls[0].result.isError=true;
  assert.ok(financialEvidenceFindings('市盈率24→18倍：120→90。',failed,[]).some(f=>f.severity==='error'));
});
test('historical page ranges and independent factual clauses survive qualification of conclusions',()=>{
  assert.deepEqual(accountingReasoningIssues('2024年收入120亿元[2024年报第8–9页]。',{question:'虚构情景：收入增长5%，现金流未知。'}),[]);
  const fact='年报收入120亿元[年报第8–9页]；',bad='因此一定低估。';
  const answer=fact+bad;
  const kept=researchPortion(answer,()=>[],[{rule:'source_quality',severity:'error',excerpt:bad}],[]);
  assert.ok(kept.includes(fact));assert.ok(!kept.includes(bad));
  const dependent=researchPortion('未核验收入999亿元。因此一定低估。',()=>[],[{rule:'unsourced_number',severity:'error',excerpt:'未核验收入999亿元'}],[]);
  assert.ok(!dependent.includes('因此一定低估'));
});

test('retaining a Markdown sentence keeps emphasis and leaves no dangling comparison',()=>{
  const lost='成本增幅为 999%。';
  const text='**核心驱动。** '+lost+'注意后者采用合并成本，不能代表单一产品成本；但它证明产品有优势。独立合同数据可用于检查价格。';
  const result=researchPortion(text,()=>[],[{rule:'unsourced_number',severity:'error',sourceText:lost}],[]);
  assert.match(result,/\*\*核心驱动。\*\*/);
  assert.match(result,/采用合并成本，不能代表单一产品成本/);
  assert.match(result,/独立合同数据/);
  assert.doesNotMatch(result,/999|注意后者|它证明/);
});

test('local valuation proof uses bound scalar formulas and the workbook rounding policy',async()=>{
  const {valuationFormulaDelivery,asksModelOverview}=await import('../lib/valuation-formula-delivery.mjs');
  const cell=(ref,value,metric,unit,formula)=>({...source('Base!'+ref,value,unit,metric),raw_unit:unit,formula,sha256:'a'.repeat(64)});
  const cells=[cell('B3',31,'Revenue','百万元'),cell('B4',4,'Shares','百万股'),
    cell('B5',8,'Target Price','USD','=ROUND(B3/B4,0)')];
  const draft='Revenue 决定该估值。目标价 8 美元 [模型.xlsx]Base!B5。';
  const r=valuationFormulaDelivery(draft,cells);
  assert.equal(r.receipt.base,8);
  assert.equal(r.receipt.changes[0].output,7);
  assert.equal(r.receipt.sourceIds.length,3);
  assert.equal(valuationFormulaDelivery(draft,[...cells.slice(0,2),{...cells[2],value:9}]),null);
  assert.equal(valuationFormulaDelivery(draft,[{...cells[0],version:2},...cells.slice(1)]),null);
  assert.equal(valuationFormulaDelivery(draft,[{...cells[0],sha256:'b'.repeat(64)},...cells.slice(1)]),null);
  assert.equal(valuationFormulaDelivery(draft,[...cells.slice(0,2),{...cells[2],formula:'=INDIRECT("B3")'}]),null);
  assert.equal(valuationFormulaDelivery(draft,[...cells.slice(0,2),{...cells[2],value:'#NAME?'}]),null);
  assert.ok(asksModelOverview('请拆解这份估值模型'));
  assert.ok(!asksModelOverview('只核对模型收入，200字以内'));
  assert.ok(!asksModelOverview('若成本下调 5%，请重算模型'));
});

test('retain only an independently reproducible local shocked result on the same evidence',()=>{
 const c={...source('Costs!B12',200,'万元','采购成本'),sha256:'a'.repeat(64),id:'cite:book:v1:Costs!B12',period:'2029E',raw_unit:'万元'};
 const r={name:'2029年原料价下调15%(产量不变)时成本',unit:'万元',value:'170',expression:'cost*0.85',
  evaluatedExpression:'(200)*0.85',bindings:{cost:{...c}},provenance:'bound_inputs'};
 r.citations=derivedCitation(r,[c],{toolCallId:'testcalc',role:'derived_calc_0'});
 const calls=[{id:'read',name:'workbook_query',success:true,details:{citations:[c]}},
  {id:'testcalc',name:'calc',success:true,details:{results:[r],citations:r.citations}}];
 const args={answer:'假设 2029 年原料价下调 15%、产量不变，成本降至 170 万元。',retained:'采购计划。',findings:[],calls,versions:{book:1}};
 const run=changes=>retainedScenarioCalculations({...args,...changes});
 assert.equal(run({}).citations.length,2);
 for(const change of [
  {answer:args.answer.replace('2029','2027')},{answer:args.answer.replace('万元','元')},
  {answer:args.answer.replace('原料价下调','原料价不变，售价下调')},
  {answer:args.answer.replace('成本降至 170 万元','成本从 170 万元降至 120 万元')},
  {answer:args.answer.replace('产量不变','产量下降')},{retained:args.answer},{versions:{book:2}},
  {calls:calls.slice(1)},{disputedCalcIds:[r.citations[0].id]},{limit:4}
 ])assert.deepEqual(run(change).citations,[]);
 const mutate=fn=>{const altered=structuredClone(calls);fn(altered);assert.deepEqual(run({calls:altered}).citations,[]);};
 mutate(a=>a[0].details.citations[0].sha256='b'.repeat(64));
 mutate(a=>a[1].details.results[0].evaluatedExpression='(200)*1.15');
 mutate(a=>a[1].details.results[0].unit='美元');
 mutate(a=>a[1].success=false);
});
