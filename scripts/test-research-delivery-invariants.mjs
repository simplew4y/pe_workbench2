import {canonicalWorkbookRefs} from '../lib/workbook-source-names.mjs';
import assert from 'node:assert/strict';
import {resolvedToolFailures} from '../lib/research-evidence-scope.mjs';
import {quantityIssues} from '../lib/research-quantities.mjs';
import {calcReplacement} from '../lib/tool-failure-recovery.mjs';
import {calculate} from '../lib/calc-tool.mjs';
import {workbookScenarioDelivery} from '../lib/workbook-scenario-delivery.mjs';
import {accountingReasoningIssues} from '../lib/research-reasoning.mjs';
import {clarifyResearchInference} from '../lib/research-inference.mjs';
import {compactResearchBrief} from '../lib/research-brief.mjs';
import {visibleAnswerChars} from '../lib/answer-length.mjs';
import {isResearchCondition} from '../lib/research-condition.mjs';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';

for (const [sheet, company, row] of [['Planet','甲能源',2],['Base','乙医疗',8],['Ops','丙科技',14]]) {
  const a=sheet+'!B'+row, b=a+'06', v=row*83;
  const facts=[{ref:a,amount:true,value:v,rowLabel:'Revenue'},{ref:b,amount:true,value:v*3,rowLabel:'Revenue'}];
  assert.deepEqual(quantityIssues('收入'+v*3+'百万元（'+b+'）。',facts),[]);
  assert.ok(quantityIssues('收入'+v+'百万元（'+b+'）。',facts).length);
  assert.deepEqual(quantityIssues('收入'+v*3+'百万元（'+b+'）。',facts.slice(0,1)),[]);
  const sha=String(row%10).repeat(64),file=company+'.xlsx';
  const input={id:'in',locator:a,materialId:company,version:2,sha256:sha,storedFilename:file,value:v,metric:'设备数'};
  const target={...input,id:'out',locator:b,value:v*3,metric:'产出'};
  const args={path:'uploads/'+file,inputs:[{cell:a,value:v+1}],targets:[b]};
  const d={...args,sourceSha256:sha,cached:{[b]:v*3},baselineChanged:[],recalculated:true,results:[{cell:b,before:v*3,after:v*3+3}]};
  const render=(patch={},sources=[input,target],success=true)=>workbookScenarioDelivery([{name:'model_whatif',args,details:{...d,...patch},success}],sources,{}).text;
  assert.ok(render().includes(v*3+' → '+(v*3+3)));
  const recalculated=[{cell:b,before:v*3+12,after:v*3+9}];
  const rebased=render({baselineChanged:[b],results:recalculated});
  assert.ok(rebased.includes('| '+v*3+' | '+(v*3+12)+' | '+(v*3+9)+' |'));
  assert.equal(render({results:recalculated}),'');
  assert.equal(render({baselineChanged:[b]}),'');
  assert.equal(render({sourceSha256:'f'.repeat(64)}),'');
  assert.equal(render({inputs:[{cell:a,value:v-1}]}),'');
  assert.equal(render({cached:{[b]:9999}}),'');
  assert.equal(render({},[input,{...target,version:3}]),'');
  assert.equal(render({},[input,target],false),'');
  const pair=[{...input,raw_unit:'吨'},{...target,raw_unit:'吨'}];
  const share={expression:'component/total',unit:'%',ratioEncoding:'percentage_points',value:String(100/3),
    bindings:{component:pair[0],total:pair[1]}};
  const withRatio = result => workbookScenarioDelivery([{name:'model_whatif',args,details:d,success:true},
    {name:'calc',success:true,details:{results:[result]}}],pair,{}).text;
  assert.match(withRatio(share),/33\.33%/);
  assert.doesNotMatch(withRatio({...share,value:'66.67'}),/按同一分母/);
  assert.doesNotMatch(withRatio({...share,bindings:{...share.bindings,component:{...pair[0],version:1}}}),/按同一分母/);
  const failed={name:company+'增长率',expression:v+'/200-1',outputUnit:'%',ratioEncoding:'fraction',error:'ratioEncoding=fraction 与结果单位 % 冲突'};
  for(const units of [{fromUnit:'decimal',toUnit:'%'},{ratioEncoding:'fraction',outputUnit:'decimal'}]){
    const retry={name:failed.name,expression:failed.expression,...units,precision:3};
    const result={...calculate(retry),unit:retry.toUnit || retry.outputUnit};
    assert.equal(calcReplacement(failed,{args:retry,result}),'verified_fraction_retry');
    assert.equal(calcReplacement(failed,{args:retry,result:{...result,value:'9999'}}),null);
    assert.equal(calcReplacement(failed,{args:{...retry,expression:retry.expression+'+0'},result}),null);
  }
  const q='仅用截至2021年12月31日可公开核验的资料，分析'+company;
  assert.ok(accountingReasoningIssues('2022年初转跌。',{question:q}).length);
  assert.deepEqual(accountingReasoningIssues('当时预计2022年初转跌。',{question:q}),[]);
}
const question='虚构服务公司：收入增26%，毛利率68%不变。建三条命题和证伪条件。';
const evidence=text=>financialEvidenceFindings(text,{question,citations:[],toolCalls:[]},[]).filter(f=>f.severity==='error');
assert.deepEqual(evidence('题设：收入增26%、毛利率68%不变。'),[]);
assert.ok(evidence('题设：毛利率26%。').length);
assert.deepEqual(evidence('证伪条件为下期毛利率低于52%。'),[]);
assert.ok(evidence('公告披露毛利率低于52%。').length);
assert.equal(isResearchCondition('证伪条件为下期现金流转负。',question),true);
assert.equal(isResearchCondition('证伪条件为去年已经实现利润翻倍。',question),false);
assert.ok(accountingReasoningIssues('2022年第二季度已实现正增长。',{question:'仅用截至2022年3月31日公开的信息回答。'}).length);
assert.deepEqual(accountingReasoningIssues('预计2022年第二季度将转跌。',{question:'仅用截至2022年3月31日公开的信息回答。'}),[]);
assert.equal(visibleAnswerChars('**价格** [年报](https://example.test/very/long)'),4);
// Subset expenses must have a receipt for that specific scope. A linked
// consolidated disclosure only supports the total, even when a use is named.
const disclosure='https://example.invalid/disclosure';
const source={success:true,name:'web_fetch',details:{url:disclosure,status:200},result:{content:[
  {type:'text',text:'合并业绩\n▪ 资本支出为人民币42 亿元，同比增加18%。'}]}};
const claim='算力资本支出42亿元、+18%。[公告]('+disclosure+')';
assert.match(clarifyResearchInference(claim,'说明投入',[source]),/整体资本支出42亿元/);
assert.equal(clarifyResearchInference(claim.replace('18%','19%'),'说明投入',[source]),claim.replace('18%','19%'));
assert.equal(clarifyResearchInference(claim,'原样返回',[source]),claim);
assert.match(clarifyResearchInference('“票据结算不形成预收”。','评估回款'),/“票据结算不形成预收”/);
assert.equal(clarifyResearchInference('不能说票据结算不形成预收。','评估回款'),'不能说票据结算不形成预收。');
const forecasts='预测：未来六季单位毛利不低于基准且客户流失率保持低位。若毛利和留存同时下降，则命题被推翻。';
assert.match(clarifyResearchInference(forecasts,'列可证伪命题'),/任一条件未达到/);
assert.equal(clarifyResearchInference(forecasts.replace('且','或'),'列可证伪命题'),forecasts.replace('且','或'));
const withLink='值得注意的是，估值见[原表](https://example.invalid/model)。若收入下降，估值须重算。';
assert.equal(compactResearchBrief(withLink,'原样输出',8),withLink);
assert.match(compactResearchBrief(withLink,'说明估值',10),/\[原表\]\(https:\/\/example.invalid\/model\)。若收入下降/);
assert.match(compactResearchBrief('值得注意的是，<https://example.invalid/abc>。','限10字',10),/<https:\/\/example.invalid\/abc>/);
const alternative='虚构公司两年，经营现金流35→22，应收增加。';
const rules=accountingReasoningIssues('本期现金税少缴2。',{question:'虚构情景：计提8减值，税率25%，税务当期可扣除。算现金流。',sourceQuestions:[alternative]});
assert.ok(rules.some(r=>r.correction?.includes('22＋8×25%＝24')));
const failedBatch=[{role:'toolResult',toolName:'calc',toolCallId:'batch',isError:false,receipt:{partial:true,failures:[{index:1},{index:3}]}}];
const outside={id:'batch',index:1,reason:'本次设计渠道访谈方法，正文没有采用该补充指标',disposition:'outside_scope'};
assert.deepEqual(resolvedToolFailures([outside,{...outside,index:0},{...outside,index:null}],failedBatch),[outside]);
assert.deepEqual(resolvedToolFailures([{...outside,disposition:'replaced',evidenceIds:['batch']}],failedBatch),[]);
console.log('PASS independent industries, scale, locator prefixes, changed sources, failed receipts, conditional and observed claims, reporting date and visible length');

{
  const file='1700000000000_Valuation.xlsx';
  const cells=['Val!B2','Val!C2'].map(locator=>({materialId:'abcde123-0041',version:1,filename:file,locator}));
  const claim='下文[附件]指上传的 **Valuation.xlsx**。\n[附件]Val!B2、C2。';
  assert.ok(canonicalWorkbookRefs(claim,cells,{}).includes('['+file+']Val!B2、['+file+']Val!C2'));
  assert.equal(canonicalWorkbookRefs('[abcde123@v2]Val!B2',cells,{}),'[abcde123@v2]Val!B2');
  assert.equal(canonicalWorkbookRefs(claim,cells,{'abcde123-0041':2}),claim);
  const collision=cells.map(c=>({...c,materialId:'abcde123-0099',filename:'1800000000000_Valuation.xlsx'}));
  assert.equal(canonicalWorkbookRefs(claim,[...cells,...collision],{}),claim);
  assert.equal(canonicalWorkbookRefs('[abcde123@v1]Val!B2',[...cells,...collision],{}),'[abcde123@v1]Val!B2');
}
