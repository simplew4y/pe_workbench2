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
