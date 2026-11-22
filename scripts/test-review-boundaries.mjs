import assert from 'node:assert/strict';
import test from 'node:test';
import {auditResearch,AUDIT_CHECKS} from '../lib/research-audit.mjs';
import {overruledArithmetic,calcReceipts} from '../lib/audit-arithmetic.mjs';
import {calcFailureRecovery} from '../lib/tool-failure-recovery.mjs';
import {createCalcTool,calculate} from '../lib/calc-tool.mjs';
import {researchPortion} from '../server/agent/answer-delivery.mjs';

globalThis.fetch=()=>{throw new Error('Offline regression: network disabled');};
const rate={toolCallId:'calc-rate',index:0,name:'甲公司2024年单价',unit:'元/Wh',
  expression:'249.59/28/10',value:calculate({expression:'249.59/28/10'}).value};
const issue={check:'numeric_units',excerpt:'甲公司2024年单价：0.891元/Wh',
  reason:'249.59亿元÷28GWh，249.59亿元=2.496×10^11元，结果应为8.91元/Wh，正文存在10倍错误。'};
const percent={toolCallId:'calc-ratio',index:0,name:'甲公司2024年收现比',unit:'decimal',ratioEncoding:'fraction',expression:'9/10',value:'0.9'};
const percentIssue={check:'numeric_units',excerpt:'甲公司2024年收现比90%',reason:'把小数0.9写成百分比90%，应按百分数读成0.9%。'};

test('arithmetic override requires one named, typed, reproducible successful receipt',()=>{
  assert.equal(overruledArithmetic(issue),null);
  assert.ok(overruledArithmetic(issue,[rate]));
  assert.ok(overruledArithmetic(percentIssue,[percent]));
  for(const changed of [{name:'乙公司2024年收现比'},{name:'甲公司2023年收现比'},{name:'甲公司2024年净利润'},
    {unit:'亿元'},{unit:'%'},{unit:null},{expression:'8/10'},{toolCallId:null}])
    assert.equal(overruledArithmetic(percentIssue,[{...percent,...changed}]),null,JSON.stringify(changed));
  assert.equal(overruledArithmetic(percentIssue,[percent,{...percent,toolCallId:'ambiguous'}]),null);
  assert.equal(overruledArithmetic({...percentIssue,check:'comparison_basis'},[percent]),null);
  assert.equal(overruledArithmetic({...percentIssue,reason:percentIssue.reason+'但主体、期间不同。'},[percent]),null);
  assert.equal(overruledArithmetic({...issue,excerpt:issue.excerpt+'；另一产品单价100元/Wh。'},[rate]),null);
  assert.equal(overruledArithmetic({...issue,excerpt:'收入100亿元÷10GWh，约1元/Wh；另一产品单价100元/Wh。',
    reason:'第一项100亿元÷10GWh=1元/Wh无误，另一产品实际10元/Wh，高出10倍。'},[]),null);
  const message={role:'toolResult',toolName:'calc',toolCallId:'calc-rate',details:{results:[rate]}};
  assert.equal(calcReceipts([message],new Set()).length,0);
  assert.equal(calcReceipts([{...message,isError:true}]).length,0);
  assert.equal(calcReceipts([{...message,details:{error:'failed',results:[rate]}}]).length,0);
  assert.equal(calcReceipts([message],new Set(['calc-rate']))[0].toolCallId,'calc-rate');
});

const audit=async(issues,opts={})=>{
  const checks=Object.fromEntries(AUDIT_CHECKS.map(k=>[k,issues.some(i=>i.check===k)?'fail':'pass']));
  if(opts.malformed)delete checks.coverage;
  const provider=async(_model,ctx)=>{
    const payload=JSON.parse(ctx.messages[0].content[0].text);
    if(payload.arithmeticReceipts)assert.equal(payload.arithmeticReceipts[0]?.toolCallId,'calc-rate');
    return {async *[Symbol.asyncIterator](){yield {type:'done'};},async result(){
      return {role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({checks,issues})}]};}};
  };
  return auditResearch(provider,{}, {messages:[{role:'user',content:'解释单位换算'},
    {role:'assistant',content:[{type:'toolCall',id:'calc-rate',name:'calc',arguments:{expression:rate.expression}}]},
    {role:'toolResult',toolName:'calc',toolCallId:'calc-rate',content:[{type:'text',text:JSON.stringify(rate)}],details:{results:[rate]}}]},
    {},issue.excerpt+(opts.hard?'\n拟合质量很差。':''),{question:'解释单位换算'});
};
test('adjudication synchronizes ok/checks/issues; malformed or remaining errors still block',async()=>{
  const good=await audit([issue]);
  assert.equal(good.status,'reviewed');assert.equal(good.ok,true);
  assert.equal(good.issues.length,0);assert.equal(good.checks.numeric_units,'pass');
  assert.equal(good.overruledIssues[0].evidenceId,'calc-rate');
  const mixed=await audit([issue,{check:'metric_meaning',excerpt:issue.excerpt,reason:'指标尚未核实'}]);
  assert.equal(mixed.ok,false);assert.equal(mixed.issues.length,1);assert.equal(mixed.checks.metric_meaning,'fail');
  const malformed=await audit([issue],{malformed:true});
  assert.equal(malformed.ok,false);assert.equal(malformed.status,'unavailable');assert.equal(malformed.overruledIssues.length,0);
  const hard=await audit([issue],{hard:true});assert.equal(hard.ok,false);assert.ok(hard.issues.length);
});

const bad='乙业务收入999亿元。';
const finding={rule:'unsourced_number',severity:'error',evidenceStatus:'source_conflict',sourceText:bad,excerpt:bad};
const clean='## 甲业务\n\n甲业务收入100亿元，成本80亿元。\n\n结论：甲业务毛利为20亿元。';
const dirty='## 乙业务\n\n'+bad;
const portion=(text,options={})=>researchPortion(text,()=>{throw new Error('Must not relint isolated fragments');},[finding],[],options);
test('one rejected section does not erase an independent conclusion in either order',()=>{
  for(const text of [clean+'\n\n'+dirty,dirty+'\n\n'+clean]) {
    const kept=portion(text);assert.ok(kept.includes('结论：甲业务毛利为20亿元。'));assert.ok(!kept.includes('999'));
  }
});
test('global, same-section and cross-section dependent conclusions remain blocked',()=>{
  for(const suffix of ['\n\n因此乙业务明显低估。','\n\n## 结论\n\n判断：乙业务增长已被证实。',
    '\n\n## 其他影响\n\n因此该增长已被证实。','\n\n## 甲业务\n\n甲业务收入100亿元。\n\n因此乙业务增长已被证实。']) {
    const kept=portion(clean+'\n\n'+dirty+suffix);
    assert.ok(!kept.includes('明显低估'));assert.ok(!kept.includes('已被证实'));
  }
  assert.ok(!portion('综上可以断言明显低估。\n\n'+clean+'\n\n'+dirty).includes('明显低估'));
  for (const text of ['- 因此建议直接买入。','更正：因此建议直接买入。','还有待观察的事项。因此建议直接买入。'])
    assert.ok(!portion(clean+'\n\n'+dirty+'\n\n'+text).includes('建议直接买入'));
  assert.ok(!portion('结论：值得买入。当前证据足够支持投资判断。\n\n'+clean+'\n\n'+dirty).includes('足够支持投资判断'));
  for(const procedure of ['因此后续核对合同与回款。','因此本分析采用订单变化代理需求变化，并保留缺口。'])
    assert.ok(portion(clean+'\n\n'+dirty+'\n\n资料不全。'+procedure).includes(procedure));
  assert.ok(!portion(clean+'\n\n'+dirty+'\n\n因此本分析采用订单变化代理需求变化，保留缺口，但证明值得买入。').includes('值得买入'));
  const artifact=researchPortion(clean+'\n\n报告已保存。',()=>[],[{...finding,rule:'artifact_status',sourceText:'报告已保存。',excerpt:'报告已保存。'}]);
  assert.ok(artifact.includes('结论：甲业务毛利为20亿元。'));
});
test('public corrections survive; internal label removal never destroys checked facts',()=>{
  const correction='更正：上一轮已交付答文把甲公司年份写成2025年，真实来源为2024年。';
  assert.ok(portion(clean+'\n\n'+dirty+'\n\n'+correction,{visibleHistory:['甲公司年份为2025年。']}).includes(correction));
  assert.ok(portion(clean+'\n\n'+dirty+'\n\n'+correction).includes(correction),'unknown history is not proof of an internal draft');
  const internal='更正：甲业务适用年份为2024年。';
  const result=portion(clean+'\n\n'+dirty+'\n\n'+internal,{visibleHistory:[],question:'分析业务'});
  assert.ok(result.includes('甲业务适用年份为2024年。'));assert.ok(!result.includes('更正：'));
  assert.ok(!portion(clean+'\n\n'+dirty+'\n\n'+internal.replace('更正','**更正**'),{visibleHistory:[]}).includes('更正'));
  assert.ok(portion(clean+'\n\n'+dirty+'\n\n'+internal,{visibleHistory:[],question:'请更正这段描述'}).includes(internal));
});

test('failed calculations require observed source versions, not retry argument wildcards',()=>{
  const binding={materialId:'book',locator:'Sheet1!A1',version:1};
  const fail={id:'failed',name:'calc',success:false,args:{name:'收入',expression:'x*2',outputUnit:'亿元',bindings:{x:binding}},result:{isError:true}};
  const retry=observed=>({id:'retry',name:'calc',success:true,args:{...fail.args,bindings:{x:{materialId:'book',locator:'Sheet1!A1'}}},
    result:{details:{results:[{index:0,name:'收入',expression:'x*2',evaluatedExpression:'20*2',value:'40',unit:'亿元',bindings:{x:observed}}]}}});
  assert.equal(calcFailureRecovery([fail,retry({...binding,value:20})])[0].unresolved.length,0);
  for(const observed of [{...binding,version:2},{...binding,version:undefined},{...binding,materialId:'other'},{...binding,locator:'Sheet1!A2'}])
    assert.equal(calcFailureRecovery([fail,retry(observed)])[0].unresolved.length,1);
  const falseSuccess=retry(binding);falseSuccess.result.isError=true;
  assert.equal(calcFailureRecovery([fail,falseSuccess])[0].unresolved.length,1);
  const failedDetails=retry(binding);failedDetails.result.details.error='failed';
  assert.equal(calcFailureRecovery([fail,failedDetails])[0].unresolved.length,1);
  const absent=retry(binding);delete absent.result.details.results[0].bindings;
  assert.equal(calcFailureRecovery([fail,absent])[0].unresolved.length,1);
});

test('small percentages retain their declared unit; contradictory ratio encoding fails explicitly',async()=>{
  const tool=createCalcTool();
  for(const expression of ['0.8-0.3','0.5','-0.5','1/200','100/200']) {
    const result=await tool.execute('percent',{expression,outputUnit:'%',ratioEncoding:'percentage_points'});
    assert.ok(!result.isError);assert.equal(result.details.results[0].unit,'%');
    assert.equal(result.details.results[0].ratioEncoding,'percentage_points');
  }
  for(const expression of ['9/10','90/100','2']) {
    const result=await tool.execute('conflict',{expression,outputUnit:'%',ratioEncoding:'fraction'});
    assert.equal(result.isError,true);assert.match(result.details.error,/ratioEncoding/);
  }
  for(const outputUnit of [undefined,'元/Wh'])assert.equal((await tool.execute('bad-label',
    {expression:'0.5',outputUnit,ratioEncoding:'fraction'})).isError,true);
  const converted=await tool.execute('convert',{expression:'9/10',fromUnit:'decimal',toUnit:'%',ratioEncoding:'percentage_points'});
  assert.equal(converted.details.results[0].unit,'%');assert.equal(Number(converted.details.results[0].value),90);
});
