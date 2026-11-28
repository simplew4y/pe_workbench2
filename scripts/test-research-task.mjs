import assert from 'node:assert/strict';
import { isResearchQuestion, isScenarioOnlyQuestion } from '../lib/research-task.mjs';
import { checkTurnTools } from '../lib/turn-context.mjs';
for (const question of ['建立投资框架','检查估值','解读模型','算组合收益与风险','给出证伪条件']) assert.ok(isResearchQuestion(question),question);
for(const q of ['理解这份模型，主要驱动是什么？','帮我梳理业务的关键影响因素','讲解这份报表','读懂公司的商业模式']) {
  assert.equal(isResearchQuestion(q),true,q);
  for(const file of ['普通附件.xlsx','估值分析.xlsx','为什么投资.pdf'])assert.equal(isResearchQuestion(q+'\n\n[已上传资料]\n- '+file),isResearchQuestion(q));
}
for(const q of ['列出文件','你好','查询A1单元格的值'])for(const file of ['估值分析.xlsx','情景.pdf'])
  assert.equal(isResearchQuestion(q+'\n\n[已上传资料]\n- '+file),isResearchQuestion(q));
assert.equal(isResearchQuestion('继续','读取A1\n\n[已上传资料]\n- 估值分析.xlsx'),false);
assert.ok(isResearchQuestion('只把折现率改为12%，其他不变','计算DCF企业价值'));
assert.ok(isResearchQuestion('压缩为五条','分析长期投资价值'));
for (const question of ['你好','谢谢','列出文件','新建项目']) assert.equal(isResearchQuestion(question,'解释估值'),false);
assert.ok(isScenarioOnlyQuestion('只把参数改为12%','虚构公司，仅用题设参数计算'));
assert.equal(isScenarioOnlyQuestion('比较附件工作簿与题设参数','虚构公司'),false);
assert.deepEqual(checkTurnTools({answer:'相关系数不影响组合预期收益。',routes:['dependency'],toolCalls:[]}),[]);
assert.ok(checkTurnTools({answer:'工作簿capex不进入估值。',routes:['dependency'],toolCalls:[],workbookContext:true}).length);
console.log('PASS research routing, scenario scope, follow-up inheritance and workbook-only path checks');

// Overview routing and recovery are independent of any company or valuation method.
{
  const {asksModelOverview}=await import('../ui/chat/model-overview.js');
  const {restoreModelOverview,overviewLayoutIssue}=await import('../lib/model-overview-delivery.mjs');
  for(const q of ['看看这个模型','理解一下这个财务和估值模型','拆解这份模型','看看这个模型，讲讲业务和关键假设'])
    assert.ok(asksModelOverview(q) && isResearchQuestion(q),q);
  for(const q of ['审计这个估值模型','核对目标价公式','看看这个模型的折旧年限','建立一个财务模型','看看机器学习模型'])
    assert.equal(asksModelOverview(q),false,q);
  const cell=(locator,metric,value,unit)=>({id:locator,filename:'模型.xlsx',materialId:'asset',version:1,sha256:'fixture',
    locator,metric,value,display_unit:unit});
  const owner=cell('封面!B2','公司名称','示例电力运营商'),business=cell('封面!B3','主营业务','电站运营');
  const method=cell('估值!B1',null,'DCF'),price=cell('估值!E6','目标价',22,'港元');
  const source={role:'toolResult',isError:false,toolName:'workbook_query',details:{citations:[owner,business,method,price]}};
  const text='然而，来水量存在波动。\n\n## 估值方法\n\n预测发电收入与维护成本，用自由现金流折现得到 22 港元 [模型.xlsx]估值!E6。\n\n## 风险提示\n\n来水不足会压低发电收入。';
  const answer={status:'partial',citations:[price],text};
  const q='看看这个模型';
  const repaired=restoreModelOverview(answer,q,[source]);
  assert.match(repaired.text.split('\n')[0],/示例电力运营商.*电站运营.*现金流折现估值.*22 港元/);
  assert.doesNotMatch(repaired.text,/市盈率/);
  assert.ok(repaired.text.indexOf('## 模型怎么算')<repaired.text.indexOf('## 哪些假设要小心'));
  assert.ok(repaired.text.indexOf('## 哪些假设要小心')<repaired.text.indexOf('来水量存在波动'));
  assert.equal(restoreModelOverview(repaired,q,[source]),repaired);
  assert.equal(restoreModelOverview(answer,'审计这个估值模型',[source]),answer);
  assert.equal(restoreModelOverview(answer,q,[{...source,isError:true}]),answer);
  assert.equal(restoreModelOverview(answer,q,[source,{...source,details:{citations:[{...price,materialId:'other'}]}}]),answer);
  assert.equal(overviewLayoutIssue(repaired.text,true),'');
  assert.ok(overviewLayoutIssue('示例公司采用现金流折现。\n\n## 风险提示\n\n来水不足。\n\n## 估值路径\n\n按未来自由现金流估值。',true));
}
