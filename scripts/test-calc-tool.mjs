import assert from "node:assert/strict";
import { calculate, createCalcTool, unitConvert, createUnitConvertTool } from "../lib/calc-tool.mjs";
import { calculateUserScenario, scenarioAmountEvidence, scenarioInterpretationFindings } from '../lib/scenario-calculation.mjs';
import { ratioInterpretationFindings } from '../lib/scenario-ratios.mjs';
const value = (expression, options = {}) => calculate({ expression, ...options }).value;
assert.equal(value("0.1+0.2", { precision: 2 }), "0.30");
assert.equal(value("ROUNDUP(831.1,0)"), "832");
assert.equal(value("ROUNDUP(831.1*(1-15%),0)"), "707");
assert.equal(value("ROUNDUP(-1.21,1)"), "-1.3");
assert.equal(value("ROUNDDOWN(-1.29,1)"), "-1.2");
assert.equal(value("ROUND(-1.25,1)"), "-1.3");
assert.equal(value("ROUND(125,-1)"), "130");
assert.equal(value("SUM(1,2,ABS(-3),MIN(4,5),MAX(6,7))"), "17");
assert.equal(value("2^3^2"), "512");
assert.equal(value("(3+2)*4/8"), "2.5");
assert.equal(value("1/3", { precision: 8 }), "0.33333333");
assert.equal(value("LN(2)", { precision: 12 }), "0.693147180560");
assert.equal(value("LN(0.5)+LN(2)", { precision: 12 }), "0.000000000000");
assert.equal(value("LN(1e1000)/LN(10)", { precision: 8 }), "1000.00000000");
assert.equal(value("SQRT(0.0175)*100", { precision: 2 }), "13.23");
assert.equal(value("0.0075^(1/2)*100", { precision: 2 }), "8.66");
assert.equal(value("SQRT(1/4)"), "0.5");
assert.throws(() => value("LN(0)"), /大于零/);
assert.throws(() => value("SQRT(-1)"), /不能为负数/);
const dcf = '假设公司基期FCFF100，未来1至3年每年增10%，第3年后永续增长3%，WACC10%，净债务200，股数200，现金流年末发生。DCF计算企业价值、每股价值和终值占比，列公式。';
const valuation = calculateUserScenario(dcf);
assert.equal(valuation.receipt.outputs.enterpriseValue.value, '1771.43');
assert.equal(valuation.receipt.outputs.perShare.value, '7.86');
assert.equal(valuation.receipt.outputs.terminalShare.value, '83.06');
assert.equal(calculateUserScenario(dcf.replace('WACC10%', 'WACC3%')), null);
assert.equal(calculateUserScenario(dcf + '股数另行改为300，同时计算每股价值。'), null);
const discountChange = '只把WACC改12%，其他不变，重算企业价值、每股价值及相对原情景变化，不沿用旧终值。';
const discountResult = calculateUserScenario(discountChange, [dcf]);
assert.deepEqual([discountResult.receipt.outputs.perShare.value, discountResult.receipt.outputs.perShareChange.value], ['5.87', '-25.31']);
assert.deepEqual(discountResult.receipt.inputs.adjustedDiscount, { value: '12%', userTurn: 2 });
assert.equal(calculateUserScenario(discountChange, [dcf, '首轮之后把净债务改为300。']), null);
const omission = '有人用第3年FCFF直接除以WACC减永续增速，忘乘1.03。指出错误，并计算在WACC12%时对每股价值造成的差额。';
assert.equal(calculateUserScenario(omission, [dcf, discountChange]).receipt.outputs.perShareDifference.value, '0.16');
assert.equal(calculateUserScenario(omission.replace('1.03', '1.04'), [dcf, discountChange]), null);
const boundary = '回到WACC10%，永续增速改10%，其他不变。这个情景能否得到有限估值？';
const recap = '恢复WACC10%、永续增长3%。用紧凑表总结已测试的有效和无效情景，说明DCF的两种虚假精确性。';
const history = [dcf, discountChange, omission, boundary];
const restored = calculateUserScenario(recap, history);
assert.equal(restored.completeAnswer,true);
assert.match(restored.body,/未来现金流和折现率都是估计[\s\S]*终值对一点变化就越敏感/u);
assert.equal(calculateUserScenario(recap+'另请估算净债务增加后的影响。',history).completeAnswer,false);
assert.match(restored.body, /7\.86[\s\S]*5\.87[\s\S]*5\.71[\s\S]*无有限值/);
assert.match(calculateUserScenario(recap, [dcf.replace('股数200','股数100'), ...history.slice(1)]).body, /15\.71[\s\S]*11\.74[\s\S]*11\.42/);
assert.equal(calculateUserScenario(recap, [...history, '同时把股数改为500。']), null);
assert.equal(calculateUserScenario(recap, [dcf,discountChange,omission.replace('WACC12%时','别的折现率时'),boundary]), null);

const split = '虚构情景：总收入增长50%，第一大IP占比20%升至40%。原总收入100，计算该IP与其他IP合计收入增长率。总收入增长能证明IP矩阵更健康吗？';
for (const [change, amounts] of [['50%',['200.00','12.50','40','10','80.00','20.00']], ['25%',['150.00','-6.25','30','-5','120.00','-20.00']]]) {
  const {outputs} = calculateUserScenario(split.replace('50%',change)).receipt;
  assert.deepEqual(['firstGrowth','otherGrowth','firstDelta','otherDelta','contribution','otherContribution'].map(key=>outputs[key].value), amounts);
}
const component = calculateUserScenario(split).receipt;
for (const [claim, blocked] of [['总收入增长全靠第一大 IP。',true],['不能证明增长全靠第一大IP。',false],['第一大IP是主要来源，其余也贡献了增长。',false],['增长全靠海外渠道。',false]]) {
  assert.equal(ratioInterpretationFindings(claim, component).length > 0, blocked, claim);
}
assert.match(calculateUserScenario(split.replace('增长50%', '增长0%')).body, /总变动为零/);
assert.match(calculateUserScenario(split.replace('占比20%', '占比0%')).body, /无定义/);
assert.equal(calculateUserScenario(split.replace('40%', '140%')), null);
const dividend = '虚构对比：A归母净利100、经营现金流120、资本开支20、分红80；B对应100、90、10、100。算简化自由现金流和分红覆盖倍数；能否据此判A更值得投资？列缺口。';
const payouts = calculateUserScenario(dividend).receipt;
assert.deepEqual(['A.fcf','B.fcf','A.coverage','B.coverage'].map(key=>payouts.outputs[key].value), ['100','80','1.25','0.80']);
assert.equal(calculateUserScenario(dividend.replace('分红80','分红0')).receipt.outputs['A.coverage'], undefined);
assert.equal(calculateUserScenario(dividend.replace('分红80','分红50')).receipt.outputs['A.coverage'].value, '2.00');
for (const [claim, blocked] of [['分红覆盖倍数是分红除以自由现金流。',true],['A覆盖倍数为0.80倍。',true],['B的覆盖倍数为0.8倍。',false],['分红除以自由现金流是支付比例。',false],['| 公司 | 分红覆盖倍数 |\n|---|---|\n| A | 0.80 |',true],['| 公司 | 分红覆盖倍数 |\n|---|---|\n| B | 0.80 |',false]]) {
  assert.equal(ratioInterpretationFindings(claim, payouts).length > 0, blocked, claim);
}

const portfolio = '假设组合A、B权重分别60%、40%，预期年收益10%、6%，年波动20%、10%，相关系数0.5。计算组合预期收益和波动率。';
const changeCorrelation = '只改相关系数为−0.5，重算组合波动率，收益是否变化？';
const recalculated = calculateUserScenario(changeCorrelation, [portfolio]);
assert.equal(recalculated.receipt.outputs.volatility.value, '10.58');
assert.equal(recalculated.receipt.outputs.expectedReturn.value, '8.40');
assert.deepEqual(recalculated.receipt.inputs.weightA, { value: '60%', userTurn: 1 });
assert.deepEqual(recalculated.receipt.inputs.updatedCorrelation, { value: '-0.5', userTurn: 2 });
assert.equal(calculateUserScenario(changeCorrelation), null);
assert.equal(calculateUserScenario(changeCorrelation.replace('0.5', '1.5'), [portfolio]), null);
const askLoss = '负相关能保证组合不亏损吗？反驳并给与题设不矛盾的亏损情景。';
const stressVolatility = '压力期相关系数升至1，两资产波动率都翻倍，权重不变。算压力波动率，与原情景比较；最大损失等于波动率吗？';
const stressResult = calculateUserScenario(stressVolatility, [portfolio, changeCorrelation, askLoss]);
assert.deepEqual([stressResult.receipt.outputs.baseVolatility.value, stressResult.receipt.outputs.stressVolatility.value], ['14.42', '32.00']);
assert.equal(stressResult.receipt.inputs.stressCorrelation.userTurn, 4);
assert.equal(calculateUserScenario(stressVolatility, [portfolio, changeCorrelation, '把权重改成100%。']), null);
const summarize = '总结框架：哪些输入是假设、输出是条件计算、关键风险未建模？给3条监控规则，不编造风险承受能力，不下买卖指令。限400字。';
const summary = calculateUserScenario(summarize, [portfolio, changeCorrelation, askLoss, stressVolatility]);
assert.deepEqual(Object.values(summary.receipt.outputs).map(output => output.value), ['8.40', '14.42', '10.58', '32.00']);
assert.match(summary.body, /未建模风险/);
assert.match(summary.body, /监控规则.*1\).*2\).*3\)/);
assert.equal(calculateUserScenario(summarize + '还要核对工作簿里记录的风险限额。', [portfolio, changeCorrelation, askLoss, stressVolatility]), null);

const stress = '虚构情景：储能销量增加20%、单价下降10%，单位成本不变，基期毛利率40%。计算收入、毛利额、毛利率变化。';
const contracts = '新增客户数增60%，平均合同额降20%。能用这两项直接解释收入增30%吗？';
const bookings = calculateUserScenario(contracts, ['首轮数据']);
assert.equal(bookings.receipt.outputs.bookingsChange.value, '28.00');
assert.equal(bookings.receipt.inputs.revenueChange.value, '30%');
const sustained = calculateUserScenario(contracts+'指出存量客户、口径、确认与时间滞后缺口。',['虚构SaaS公司：收入增30%，NRR118%降至102%，毛利率不变。']);
assert.deepEqual(sustained.receipt.inputs.latestRetention,{value:'102%',userTurn:1});
assert.match(sustained.body,/118% 变为 102%/);
assert.equal(scenarioInterpretationFindings('没有老客户的净收入留存率。',sustained.receipt).length,1);
assert.equal(scenarioInterpretationFindings('没有老客户的净收入留存率拆分。',sustained.receipt).length,0);
assert.equal(scenarioInterpretationFindings('没有老客户的净收入留存率。',bookings.receipt).length,0);
const metric = (line, label, val) => scenarioAmountEvidence(line,label,val,'%',bookings);
assert.equal(metric('新增客户数增60%', '新增客户数增','60').matches,true);
assert.equal(metric('新增客户数增61%', '新增客户数增','61').matches,false);
assert.equal(metric('公司收入增30%', '公司收入增','30').matches,true);
assert.equal(metric('竞争对手收入增30%', '竞争对手收入增','30'),null);
assert.equal(metric('年报预计新增客户数增60%', '年报预计新增客户数增','60'),null);
const equation='新客签约额按(1+60%)×(1−20%)−1得+28%。';
assert.equal(metric(equation, equation.slice(0,equation.indexOf('60')), '60').matches,true);
assert.equal(metric(equation, equation.slice(0,equation.indexOf('+28')), '+28').matches,true);
const wrongEquation = equation.replace('+28','+29');
assert.equal(metric(wrongEquation, wrongEquation.slice(0,wrongEquation.indexOf('+29')),'+29').matches,false);
const comparison = '按新增客户签约额推算，但新老收入拆分未列，无法判断28.00%与30%的差距是否来自老客户';
for (const val of ['28.00','30']) assert.equal(metric(comparison,comparison.slice(0,comparison.indexOf(val)),val).matches,true);
const unsupportedPair = comparison.replace('30%','31%');
assert.equal(metric(unsupportedPair,unsupportedPair.slice(0,unsupportedPair.indexOf('31')),'31').matches,false);
const otherMetric = '毛利率变化，无法判断28.00%与30%的差距原因';
assert.equal(metric(otherMetric,otherMetric.slice(0,otherMetric.indexOf('28')),'28.00'),null);
assert.equal(bookings.receipt.inputs.contractSizeChange.userTurn, 2);
assert.match(bookings.body, /各期新增客户.*合同数不变/);
assert.equal(calculateUserScenario(contracts.replace('增60%', '降10%')).receipt.outputs.bookingsChange.value, '-28.00');
for (const different of ['新增合同数', '存量客户数']) assert.equal(calculateUserScenario(contracts.replace('新增客户数', different)), null);
assert.equal(calculateUserScenario(contracts.replace('平均合同额', '全体客户平均合同额')), null);
assert.equal(calculateUserScenario(contracts.replace('降20%', '降至20%')), null);
const pressure = calculateUserScenario(stress);
assert.equal(pressure.receipt.outputs.revenueChange.value, '8.00');
assert.equal(pressure.receipt.outputs.grossProfitChange.value, '-10.00');
assert.equal(pressure.receipt.outputs.grossMargin.value, '33.33');
assert.equal(calculateUserScenario(stress.replace('单位成本不变', '单位成本也下降')), null);
assert.equal(value("7053400", { fromUnit: "百万元", toUnit: "亿元", precision: 0 }), "70534");
assert.equal(value("7293", { fromUnit: "百万元", toUnit: "亿元", precision: 2 }), "72.93");
assert.throws(() => calculate({ expression: "1", currency: "USD", toCurrency: "RMB" }), /汇率/);
assert.equal(value("2", { currency: "USD", toCurrency: "RMB", rate: "7.2" }), "14.4");
assert.equal(value("1", { fromUnit: "Rmb mn", toUnit: "HKD mn", rate: "1.1" }), "1.1");
assert.throws(() => value("process.exit()"));
assert.throws(() => value("1/0"));
const tool = createCalcTool();
const batch = await tool.execute("test", { expressions: [{ name: "a", expression: "1+2" }, { name: "b", expression: "3*4" }] });
assert.equal(batch.details.results[1].value, "12");
assert.equal(batch.details.results[0].name, "a");
assert.match(batch.content[0].text, /a/);
assert.equal((await tool.execute("test", { expression: "1/0" })).isError, true);
console.log("calc tool deterministic tests passed");
assert.throws(() => value('(2^1000)^100'), /数值大小/);
assert.throws(() => value('1/((2^1000)^100)'), /数值大小/);

// DT-1 gold: 7,053,443 Rmb mn = 70,534.43 亿元 (divide by 100), never 7,053 亿元.
const gold = unitConvert({ value: "7053443", from_unit: "Rmb mn", to_unit: "亿元" });
assert.equal(gold.value, "70534.43");
assert.equal(gold.unit, "亿元");
assert.equal(gold.currency, "RMB");
assert.match(gold.conversionChain, /7053443 Rmb mn/);
assert.match(gold.conversionChain, /70534\.43 亿元/);
assert.equal(unitConvert({ value: "7053443", from_unit: "RMB mn", to_unit: "亿" }).value, "70534.43");
assert.equal(unitConvert({ value: "7053443", from_unit: "rmb mn", to_unit: "亿元" }).value, "70534.43");
assert.equal(unitConvert({ value: "7053443", from_unit: "mn", to_unit: "亿元" }).value, "70534.43");
assert.equal(unitConvert({ value: "7053443", from_unit: "HKD mn", to_unit: "亿元" }).currency, "HKD");
assert.equal(unitConvert({ value: "15", from_unit: "%", to_unit: "decimal" }).value, "0.15");
assert.equal(unitConvert({ value: "0.15", from_unit: "decimal", to_unit: "%" }).value, "15");
assert.throws(() => unitConvert({ value: "1", from_unit: "元", to_unit: "%" }), /不兼容/);
assert.throws(() => unitConvert({ value: "1", from_unit: "Rmb mn", to_unit: "HKD mn" }), /币种/);
assert.equal(value("7053443", { fromUnit: "Rmb mn", toUnit: "亿元" }), "70534.43");
const unitTool = createUnitConvertTool();
const unitOut = await unitTool.execute("test", { value: "7053443", from_unit: "Rmb mn", to_unit: "亿元" });
assert.equal(unitOut.details.value, "70534.43");
assert.match(unitOut.content[0].text, /换算链/);
assert.match(unitOut.content[0].text, /70534\.43 亿元/);

// Real calculations must flow into numeric evidence, without turning bare arithmetic into sourced facts.
const {collectCitationsFromToolCalls,derivedEvidenceIssue}=await import('../lib/citations.mjs');
const {financialEvidenceFindings}=await import('../lib/financial-evidence.mjs');
const source={id:'sales',materialId:'model',version:1,locator:'PL!B2',filename:'model.xlsx',value:100,
 display_unit:'百万元',raw_unit:'百万元',currency:'CNY',metric:'收入'};
const bound=await tool.execute('bound',{expressions:[
 {name:'收入',expression:'revenue*2',bindings:{revenue:source},fromUnit:'百万元',toUnit:'亿元',currency:'RMB'},
 {name:'收入',expression:'revenue*3',bindings:{revenue:source},fromUnit:'百万元',toUnit:'亿元',currency:'RMB'}]});
assert.equal(bound.isError,undefined);assert.equal(bound.details.results[0].value,'2');
assert.equal(bound.details.citations.length,2);assert.notEqual(bound.details.citations[0].id,bound.details.citations[1].id);
const calls=[{id:'read',name:'workbook_query',success:true,details:{citations:[source]}},
 {id:'bound',name:'calc',success:true,result:bound}];
const cites=collectCitationsFromToolCalls(calls);
assert.equal(derivedEvidenceIssue(bound.details.citations[0],new Map(cites.map(c=>[c.id,c])),calls),null);
assert.deepEqual(financialEvidenceFindings('收入为2亿元。',{citations:cites,toolCalls:calls},[]),[]);
const fakeParents=new Map(cites.map(c=>[c.id,c]));fakeParents.set('sales',{...source,value:200});
assert.match(derivedEvidenceIssue(bound.details.citations[0],fakeParents,calls),/输入与上游/);
assert.match(derivedEvidenceIssue(bound.details.citations[0],new Map(),calls),/缺少上游/);
assert.equal(batch.details.citations.length,0);
assert.equal((await tool.execute('bad',{expression:'revenue',bindings:{revenue:{...source,value:'process.exit()'}}})).isError,true);
assert.equal((await tool.execute('bad',{expression:'100',fromUnit:'亿元',toUnit:'百万元',outputUnit:'亿元'})).isError,true);
assert.equal(calculate({expression:'100',fromUnit:'亿元',toUnit:'百万元'}).value,'10000');
console.log('PASS bound calculation evidence, batch identity, forged inputs rejected, explicit unit conversion');

const {calculationSourceText}=await import('../lib/citations.mjs');
const shown=calculationSourceText([source]);
const modelVisible=JSON.parse(shown.slice(shown.indexOf('[')))[0];
const fromVisible=await tool.execute('visible',{expression:'revenue*2',bindings:{revenue:modelVisible},fromUnit:'百万元',toUnit:'亿元',currency:'RMB'});
assert.equal(fromVisible.details.results[0].value,'2');
assert.ok(fromVisible.details.citations[0].derivedFrom.includes(source.id));
const withoutId={...source};delete withoutId.id;
const normalized=await tool.execute('normalized',{expression:'revenue',outputUnit:'百万元',bindings:{revenue:withoutId}});
assert.ok(normalized.details.results[0].bindings.revenue.id.startsWith('cite:'));
assert.equal(JSON.parse(calculationSourceText(Array.from({length:100},(_,i)=>({...source,id:'s'+i}))).replace(/^[^\[]*/, '')).length,8);
console.log('PASS model-visible calculation sources and optional input ID normalization');

assert.equal((await tool.execute('names',{expression:'Revenue2026*2',outputUnit:'百万元',bindings:{Revenue2026:source}})).details.results[0].value,'200');
assert.equal((await tool.execute('reserved',{expression:'SUM(1,2)',bindings:{SUM:source}})).isError,true);
assert.equal((await tool.execute('exponent',{expression:'revenue*1e2',outputUnit:'百万元',bindings:{revenue:source}})).details.results[0].value,'10000');

assert.equal(calculate({expression:'100',fromUnit:'CNY mn',toUnit:'亿元',currency:'CNY'}).value,'1');
assert.equal(calculate({expression:'100',currency:'CNY',toCurrency:'RMB'}).currency,'RMB');
assert.equal(calculate({expression:'100',currency:'CNY',toCurrency:'HKD',rate:'1.1'}).value,'110');

assert.equal((await tool.execute('missing-unit',{expression:'revenue/100',bindings:{revenue:source}})).isError,true);

assert.equal((await tool.execute('shared-batch-unit',{outputUnit:'%',expressions:[{expression:'revenue',bindings:{revenue:source}}]})).isError,true);
