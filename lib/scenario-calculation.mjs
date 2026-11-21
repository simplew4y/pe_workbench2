import { calculate, evaluateExpression } from './calc-tool.mjs';
import { calculateScenarioRatios, ratioInterpretationFindings } from './scenario-ratios.mjs';

// Automatic calculation is limited to explicit, complete hypothetical inputs.
// The model remains responsible for questions with other inputs or assumptions.
const magnitude = String.raw`(?:\d{1,14}(?:\.\d{1,8})?|\.\d{1,8})`;
const signed = String.raw`[+-]?${magnitude}`;
const pct = String.raw`${signed}\s*%`;
const sep = String.raw`\s*[,;、]\s*`;
const valuePrefix = String.raw`\s*(?:为|:|=)?\s*`;
const atEnd = String.raw`(?=[。!?;]|$)`;
const additionalScenario = /另(?:一|外|做|算)?(?:个|种|组)?情景|(?:再|同时|顺便)[^。!?]{0,12}(?:重算|测算|计算)|(?:净债务|股数|增长率|增速|WACC|相关系数|权重|成本)(?:同时)?(?:改为|变为|调整为)/i;
const dcfInputs = new RegExp([
  String.raw`^(?:虚构公司|假设(?:某)?公司)\s*[:,]?\s*基期\s*(?:FCFF|自由现金流)${valuePrefix}(?<fcff>${signed})`,
  String.raw`(?:未来)?\s*1\s*(?:至|到|-)\s*(?<years>\d{1,2})\s*年(?:每年|逐年)\s*(?:增(?:长)?|增速为)${valuePrefix}(?<growth>${pct})`,
  String.raw`第\s*(?<terminalYear>\d{1,2})\s*年后\s*永续(?:增长|增速)${valuePrefix}(?<terminalGrowth>${pct})`,
  String.raw`(?:WACC|加权平均资本成本)${valuePrefix}(?<discount>${pct})`,
  String.raw`净债务${valuePrefix}(?<debt>${signed})`,
  String.raw`(?:股数|总股数)${valuePrefix}(?<shares>${magnitude})`,
  String.raw`现金流(?:于|在)?年末(?:发生|收取)${atEnd}`,
].join(sep), 'i');
const discountUpdate = new RegExp(String.raw`^(?:只|仅)\s*(?:把|将)?\s*WACC\s*(?:改(?:为|至)?|调整为)\s*(${pct})${sep}(?:其[他余](?:参数)?不变)${sep}(?:重算|重新计算)`, 'i');
const omittedGrowth = new RegExp(String.raw`^(?:有人|若|如果)用第\s*(\d{1,2})\s*年\s*FCFF\s*直接除以\s*WACC\s*(?:减|-)\s*永续(?:增速|增长率)${sep}(?:忘了?乘|漏乘)\s*(${magnitude})(?=[。!?;])`, 'i');
const statedDiscount = new RegExp(String.raw`WACC${valuePrefix}(${pct})\s*时`, 'i');

const portfolioInputs = new RegExp([
  String.raw`^(?:虚构|假设)(?:双资产)?组合\s*[:,]?\s*A\s*(?:、|,|和|与)\s*B\s*(?:各\s*(?<equalWeight>${pct})|(?:的)?权重(?:分别)?${valuePrefix}(?<weightA>${pct})\s*[,、]\s*(?<weightB>${pct}))`,
  String.raw`预期(?:年)?收益(?:率)?${valuePrefix}(?<returnA>${pct})\s*[,、]\s*(?<returnB>${pct})`,
  String.raw`(?:年化|年)波动(?:率)?${valuePrefix}(?<volA>${pct})\s*[,、]\s*(?<volB>${pct})`,
  String.raw`相关系数${valuePrefix}(?<correlation>${signed})${atEnd}`,
].join(sep), 'i');
const correlationUpdate = new RegExp(String.raw`^(?:只|仅)(?:将|把)?(?:修改|调整|改)\s*相关系数\s*(?:为|至|到|=)\s*(${signed})\s*[,;。]\s*(?:重算|重新计算)组合波动(?:率)?`);
const stressUpdate = new RegExp(String.raw`^压力(?:期|情景)\s*相关系数\s*(?:升至|变为|调至|改为)\s*(${signed})${sep}两(?:项)?资产(?:的)?波动率(?:都|均)?翻倍${sep}权重不变${atEnd}`);
const portfolioSummary = /^(?:总结|汇总)(?:组合)?框架:\s*(?:哪些)?输入(?:是|为)假设[、,]\s*输出(?:是|为)条件计算[、,]\s*关键风险未建模[!?。]\s*(?:请)?(?:给|列)(?:出)?\s*[3三]条监控规则(?:,\s*(?:不编造风险承受能力|不下买卖指令))*[。!?]?(?:\s*(?:限|不超过)\s*\d+\s*字[。!?]?)?$/;
const portfolioLossExample = /^(?:负相关能保证组合不亏损吗|负相关能否保证组合不亏损)[!?。].*(?:例子|情景)/;

const direction = '(?<FIELD>增长|增加|上升|增|下降|减少|下跌|降)';
const grossProfitInputs = new RegExp([
  String.raw`^(?:虚构(?:压力)?情景|假设(?:情景)?)\s*[:,]?\s*[\p{L}]{0,20}?销量\s*${direction.replace('FIELD', 'volumeDirection')}\s*(?<volumeChange>${magnitude}\s*%)`,
  String.raw`单价\s*${direction.replace('FIELD', 'priceDirection')}\s*(?<priceChange>${magnitude}\s*%)`,
  '单位成本不变',
  String.raw`(?:原|基期)毛利率${valuePrefix}(?<baseMargin>${pct})(?=\s*[,;。]|$)`,
].join(sep), 'u');

const normalize = question => question.normalize('NFKC').replace(/[−–—]/g, '-').trim();
const token = value => value.replace(/\s+/g, '');
const rate = value => Number(value.replace('%', '')) / 100;
const toInput = (value, turn) => ({ value: token(value), userTurn: turn });
const exact = expression => evaluateExpression(expression).n;
const result = (expression, unit = '', precision = 2) => ({ value: calculate({ expression, precision }).value, unit, expression });
const signedPercent = value => `${Number(value) > 0 ? '+' : ''}${value}%`;
const recordInputs = (values, turn) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, toInput(value, turn)]));

// Customer count times average deal size is only a conditional booking estimate:
// the same customer cohort, comparable periods and contracts per customer matter.
const changeWords = '(增加|增长|增|上升|降低|下降|减少|降)';
const rateChange = String.raw`(?:同比)?\s*${changeWords}\s*(${magnitude}%)`;
const newContracts = new RegExp(String.raw`^(?:新增客户|新客户|新客)数(?:量)?\s*${rateChange}${sep}(?:新客(?:户)?的?)?平均合同(?:金)?额\s*${rateChange}[。;!?]\s*(?:能否|能|是否|可以)[^。;!?]{0,20}解释[^。;!?]{0,12}收入`, 'u');

function impliedNewBookings(match, turn, question, previousQuestion) {
  const change = (word, value) => /^(?:降|减)/u.test(word) ? '-' + value : value;
  const count = change(match[1], match[2]);
  const size = change(match[3], match[4]);
  if (rate(count) <= -1 || rate(size) < -1) return null;
  const delta = result(`((1+(${count}))*(1+(${size}))-1)*100`, '%');
  const equals = exact(`(${delta.expression})-(${delta.value})`) === 0n ? '=' : '≈';
  const inputs = { customerChange: toInput(count, turn), contractSizeChange: toInput(size, turn) };
  const revenue = question.slice(match[0].length).match(new RegExp('^' + rateChange, 'u'));
  if (revenue) inputs.revenueChange = toInput(change(revenue[1], revenue[2]), turn);
  const comparison = revenue ? `。题中全公司收入的变动是 ${inputs.revenueChange.value}，两者统计的业务不同` : '';
  const priorRetention = /^(?:虚构|假设)[^。!?]{0,12}(?:SaaS|软件)公司/iu.test(previousQuestion) && /存量客户/u.test(question)
    ? previousQuestion.match(new RegExp(String.raw`(?:NRR|净收入留存率)\s*(${pct})\s*(?:降至|升至|变为|到)\s*(${pct})`, 'iu')) : null;
  let retention = '';
  if (priorRetention) {
    inputs.priorRetention = toInput(priorRetention[1], turn-1);
    inputs.latestRetention = toInput(priorRetention[2], turn-1);
    retention = `上一轮题设给了老客户的净收入留存率（NRR），从 ${priorRetention[1]} 变为 ${priorRetention[2]}。它把加购、降配和流失合在一个数里，无法单独看出哪一项起了多大作用。`;
  }
  return {
    receipt: { template: 'new-customer-bookings', inputs, outputs: { bookingsChange: delta } },
    body: [`**仅凭这两项，无法解释全公司的收入增长。** 若平均合同额也只统计各期新增客户、两个指标比较的是同一对期间，且平均每位新客签的合同数不变，按题设，新客签约总额的变动为 (1${count.startsWith('-') ? count : '+' + count}) × (1${size.startsWith('-') ? size : '+' + size}) − 1 ${equals} ${signedPercent(delta.value)}${comparison}。合同签了多少钱，与本期履约后能确认多少收入，是两件事。`,retention].filter(Boolean).join('\n\n'),
    supplement: [retention ? '上轮已给老客净留存率，缺的是加购、降配、流失和新老收入的拆分。' : '老客户可能加购、降配或流失，合计净变动不足以断定哪一项主导。','说明剩余的统计口径、本期确认和时间滞后。合同服务期和履约时间表决定本期能确认多少。'].join(''),
  };
}

function dcfExpressions(values) {
  const { fcff, years, terminalYear, growth, terminalGrowth, discount, debt, shares } = values;
  const periods = Number(years);
  if (periods < 1 || periods > 30 || periods !== Number(terminalYear) ||
      Number(fcff) === 0 || Number(shares) <= 0 || rate(growth) <= -1 ||
      rate(terminalGrowth) <= -1 || rate(discount) <= rate(terminalGrowth)) return null;
  const factor = `(1+(${discount}))`;
  const flow = year => `(${fcff})*(1+(${growth}))^${year}`;
  const early = Array.from({ length: periods }, (_, index) => `${flow(index + 1)}/${factor}^${index + 1}`);
  const discountedLastFlow = `${flow(periods)}/(${discount}-(${terminalGrowth}))/${factor}^${periods}`;
  const terminal = `(${discountedLastFlow}*(1+(${terminalGrowth})))`;
  const ev = `(${early.join('+')}+${terminal})`;
  return { ev, equity: `(${ev}-(${debt}))`, terminal, discountedLastFlow };
}

function dcfOutputs(values, formula) {
  return {
    enterpriseValue: result(formula.ev),
    equityValue: result(formula.equity),
    perShare: result(`${formula.equity}/${values.shares}`, '每股'),
    terminalShare: result(`${formula.terminal}/${formula.ev}*100`, '%'),
  };
}

function dcfEvidence(values, turn) {
  return { ...recordInputs(values, turn), cashFlowTiming: toInput('年末', turn) };
}

function requestedDcf(question) {
  const matched = question.match(dcfInputs);
  if (!matched) return null;
  const request = question.slice(matched[0].length);
  return !additionalScenario.test(request) && /\bDCF\b|现金流折现/i.test(request) && /计算|估算|求/.test(request) &&
    ['企业价值', '每股价值', '终值占比'].every(item => request.includes(item)) ? matched.groups : null;
}

function requestedDiscount(question) {
  const matched = question.match(discountUpdate);
  if (!matched) return null;
  const request = question.slice(matched[0].length);
  return !additionalScenario.test(request) && /企业价值.*每股价值.*变化/.test(request) ? matched[1] : null;
}

function calculateDcf(values, turn) {
  const formula = dcfExpressions(values);
  if (!formula) return null;
  const outputs = dcfOutputs(values, formula);
  const { fcff, growth, discount, years, terminalGrowth, shares, debt } = values;
  return {
    receipt: {
      template: 'constant-growth-fcff-dcf',
      inputs: dcfEvidence(values, turn),
      outputs,
    },
    body: [
      `按题设复算，**企业价值 ${outputs.enterpriseValue.value}，每股价值 ${outputs.perShare.value}，终值现值占企业价值 ${outputs.terminalShare.value}%**。`,
      `第 t 年 FCFF = ${fcff}×(1+${growth})^t。按 WACC ${discount} 折现第 1 至 ${years} 年现金流。第 ${years} 年末终值 = 下一年 FCFF÷(${discount}−${terminalGrowth})，再折现 ${years} 年。两部分现值相加得到企业价值，减净债务 ${debt} 后得股权价值 ${outputs.equityValue.value}，再除以股数 ${shares}。终值占比 = 终值现值÷企业价值。`,
    ].join('\n\n'),
    supplement: '用一句话解释终值占比对估值敏感性的含义。保留题设金额口径。',
  };
}

function calculateDiscountChange(values, discount, basisTurn, turn) {
  const baseline = dcfExpressions(values);
  const adjusted = { ...values, discount };
  const formula = dcfExpressions(adjusted);
  if (!baseline || !formula) return null;
  const outputs = dcfOutputs(adjusted, formula);
  const change = (from, to) => result(`(${to}/${from}-1)*100`, '%');
  outputs.enterpriseValueChange = change(baseline.ev, formula.ev);
  if (exact(baseline.equity) !== 0n) outputs.perShareChange = change(baseline.equity, formula.equity);
  const perShareChange = outputs.perShareChange ? `每股变化 ${signedPercent(outputs.perShareChange.value)}` : '基准每股价值为零，每股变化率无定义';
  return {
    receipt: { template: 'fcff-dcf-discount-change', inputs: { ...dcfEvidence(values, basisTurn), adjustedDiscount: toInput(discount, turn) }, outputs },
    body: [
      `按第 ${basisTurn} 轮题设，仅将 WACC 从 ${values.discount} 改为 ${discount}。**企业价值 ${outputs.enterpriseValue.value}，每股价值 ${outputs.perShare.value}；相对原情景，企业价值变化 ${signedPercent(outputs.enterpriseValueChange.value)}，${perShareChange}。**`,
      `下一年 FCFF 沿用原题设。新 WACC 同时用于终值的分母（${discount}−${values.terminalGrowth}）及各期现值折现。企业价值等于显式期与终值的现值之和，扣除净债务后除以股数，得到每股价值。`,
    ].join('\n\n'),
    supplement: '用一句话说明固定净债务怎样使企业价值和每股价值的相对变动不同。省略已写出的终值公式。',
  };
}

function calculateMissingGrowth(values, missing, discount, basisTurn, turn) {
  const [, year, multiplier] = missing;
  if (Number(year) !== Number(values.years) || exact(`${multiplier}-(1+(${values.terminalGrowth}))`) !== 0n) return null;
  const formula = dcfExpressions({ ...values, discount });
  if (!formula) return null;
  const correct = `${formula.equity}/${values.shares}`;
  const difference = `(${formula.terminal}-(${formula.discountedLastFlow}))/${values.shares}`;
  const outputs = {
    correctPerShare: result(correct, '每股'),
    omittedGrowthPerShare: result(`(${correct})-(${difference})`, '每股'),
    perShareDifference: result(difference, '每股'),
  };
  return {
    receipt: { template: 'fcff-dcf-missing-forward-growth', activeInputs:{discount:'testedDiscount'}, inputs: { ...dcfEvidence(values, basisTurn), testedDiscount: toInput(discount, turn), omittedMultiplier: toInput(multiplier, turn) }, outputs },
    body: [
      `按第 ${basisTurn} 轮题设、WACC ${discount} 复算，**正确每股价值 ${outputs.correctPerShare.value}，漏乘后为 ${outputs.omittedGrowthPerShare.value}，正确值减漏乘值约为 ${outputs.perShareDifference.value}。**`,
      `第 ${year} 年末的终值应以第 ${Number(year) + 1} 年 FCFF 为分子，即第 ${year} 年 FCFF × ${multiplier}。两种终值的差额折现 ${year} 年后除以股数，就是每股差额。显式期现金流和净债务口径相同。`,
    ].join('\n\n'),
    supplement: '用一句话说明终值分子为什么应取下一期。',
  };
}

// A recap uses the user's tested parameters in order. An unrecognised change
// invalidates this reconstruction; an earlier assistant table is never an input.
function restoredDcf(text, questions) {
  const rates = new RegExp(String.raw`^(?:恢复|还原)(?:到|至)?\s*WACC${valuePrefix}(${pct})${sep}永续(?:增长率?|增速)${valuePrefix}(${pct})[。;]`, 'i');
  const restored = text.match(rates);
  if (!restored || !/表.*(?:情景|方案)/u.test(text)) return null;
  const baseIndex = questions.findLastIndex(q => requestedDcf(q));
  if (baseIndex < 0) return null;
  const values = requestedDcf(questions[baseIndex]);
  const baseTurn = baseIndex + 1;
  if (rate(restored[1]) !== rate(values.discount) || rate(restored[2]) !== rate(values.terminalGrowth)) return null;
  const baseline = calculateDcf(values,baseTurn);
  if (!baseline) return null;
  const {inputs} = baseline.receipt;
  const outputs = {...baseline.receipt.outputs};
  const rows = ['| 情景 | 每股价值 | 判断 |','|---|---:|---|',
    `| 原假设／本轮恢复（折现率 ${values.discount}，永续增速 ${values.terminalGrowth}） | ${outputs.perShare.value} | 有效 |`];
  let discount = values.discount;
  const changeRates = new RegExp(String.raw`^(?:回到|调回)\s*WACC${valuePrefix}(${pct})${sep}永续(?:增长率?|增速)(?:改为?|调至|变为)\s*(${pct})[，,;。]`, 'i');
  for (let i = baseTurn; i < questions.length; i++) {
    const q = questions[i];
    const update = requestedDiscount(q);
    const missed = q.match(omittedGrowth);
    const testedDiscount = missed && q.match(statedDiscount);
    const boundary = q.match(changeRates);
    let row;
    if (update && i === baseTurn) {
      const changed = calculateDiscountChange(values,update,baseTurn,i+1);
      if (!changed) return null;
      discount = update;
      inputs['discountTurn'+(i+1)] = toInput(update,i+1);
      outputs['perShareTurn'+(i+1)] = changed.receipt.outputs.perShare;
      row = [`折现率改为 ${update}`, changed.receipt.outputs.perShare.value, '有效，其余输入沿用基期'];
    } else if (missed && testedDiscount && /差额|差异/u.test(q) && rate(testedDiscount[1]) === rate(discount) && !additionalScenario.test(q.slice(missed[0].length))) {
      const mistake = calculateMissingGrowth(values,missed,discount,baseTurn,i+1);
      if (!mistake) return null;
      inputs['multiplierTurn'+(i+1)] = toInput(missed[2],i+1);
      outputs['omittedPerShareTurn'+(i+1)] = mistake.receipt.outputs.omittedGrowthPerShare;
      row = ['终值漏乘下一期增长因子', mistake.receipt.outputs.omittedGrowthPerShare.value, '公式错误，该数值仅作误算对照'];
    } else if (boundary && rate(boundary[1]) <= rate(boundary[2]) && !additionalScenario.test(q.slice(boundary[0].length))) {
      inputs['rateTurn'+(i+1)] = toInput(boundary[1],i+1);
      inputs['growthTurn'+(i+1)] = toInput(boundary[2],i+1);
      row = [`折现率 ${boundary[1]}、永续增速 ${boundary[2]}`, '无有限值', '永续现金流不收敛'];
    } else return null;
    rows.push('| ' + row.join(' | ') + ' |');
  }
  if (rows.length === 3) return null;
  const explainsPrecision = /(?:两|2)(?:种|类)(?:虚假精确性|虚假的精确性)/u.test(text);
  if (explainsPrecision) {
    rows.push('', '**为什么不能把小数位当成预测的准头？** 每股估值可以算到分，但未来现金流和折现率都是估计。换一组合理输入，算式同样正确，价格却会变。',
      '', '**为什么永续期特别容易误导？** 模型假设公司往后一直按同一速度增长。永续增速越接近折现率，两者的差越小，终值对一点变化就越敏感。达到或超过折现率时，这个模型算不出有限价值。');
  }
  const recapOnly = /^(?:用|以)?(?:一张)?(?:紧凑|简明|简短)?表(?:格)?(?:总结|汇总)已测试的有效和无效情景[,，](?:并)?说明\s*DCF\s*的(?:两|2)(?:种|类)虚假精确性[。!?]?(?:\s*限\s*\d+\s*字[。!?]?)?$/iu.test(text.slice(restored[0].length));
  return {receipt:{template:'fcff-dcf-tested-scenarios',inputs,outputs},
    body:rows.join('\n'), completeAnswer:recapOnly && explainsPrecision,
    supplement:explainsPrecision ? '情景表和两类精确性的解释均已写完，只补原题另外点名的事项。' : '只回答原题在情景表以外点名的事项。'};
}

function portfolioWeights(values) {
  const { equalWeight, weightA, weightB, ...rest } = values;
  return { weightA: equalWeight ?? weightA, weightB: equalWeight ?? weightB, ...rest };
}

function portfolioVariance(values, correlation, scale = 1) {
  const a = `(${values.weightA}*${values.volA}*${scale})`;
  const b = `(${values.weightB}*${values.volB}*${scale})`;
  return `(${a}^2+${b}^2+2*${a}*${b}*(${correlation}))`;
}

const volatility = variance => `(SQRT(${variance})*100)`;

function calculatePortfolio(values, update, turn) {
  const { weightA, weightB, returnA, returnB, volA, volB, correlation } = values;
  if (rate(weightA) < 0 || rate(weightB) < 0 || exact(`${weightA}+${weightB}-1`) !== 0n ||
      rate(volA) < 0 || rate(volB) < 0 || Math.abs(Number(correlation)) > 1 ||
      (update !== null && Math.abs(Number(update)) > 1)) return null;
  const rho = update ?? correlation;
  const a = `(${weightA}*${volA})`;
  const b = `(${weightB}*${volB})`;
  const variance = portfolioVariance(values, rho);
  const outputs = {
    expectedReturn: result(`(${weightA}*(${returnA})+${weightB}*(${returnB}))*100`, '%'),
    variance: result(variance, '', 8),
    volatility: result(volatility(variance), '%'),
    ...(update === null ? {} : { priorVolatility: result(volatility(portfolioVariance(values, correlation)), '%') }),
  };
  const inputTurn = update === null ? turn : turn - 1;
  const inputs = recordInputs(values, inputTurn);
  if (update !== null) inputs.updatedCorrelation = toInput(update, turn);
  const risk = outputs.volatility.value;
  const expected = outputs.expectedReturn.value;
  const summary = update === null
    ? `按本轮题设，**组合预期收益 ${expected}%，组合波动率 ${risk}%**。`
    : `沿用上一轮题设，相关系数改为 ${rho.replace('-', '−')} 后，**组合波动率由 ${outputs.priorVolatility.value}% 变为 ${risk}%，预期收益仍为 ${expected}%**。`;
  const varianceValue = outputs.variance.value.replace(/0+$/, '').replace(/\.$/, '');
  const hasCovariance = exact(`${a}*${b}`) > 0n;
  const interpretation = hasCovariance
    ? (update === null
      ? '两项资产的波动不总同向。只有完全正相关时，组合波动率才等于两项波动率的加权平均。'
      : '其余参数固定时，相关性回升会减弱分散效果，抬高组合波动率。相关性不稳时，可用偏高的相关性检验当前权重下的风险。')
    : '本题有一项资产的权重或波动率为零，相关系数所乘的项等于零，改变相关系数不会改变组合风险。';
  return {
    receipt: { template: 'two-asset-portfolio', inputs, outputs },
    body: [summary,
      `预期收益 = ${weightA}×(${returnA}) + ${weightB}×(${returnB})。设 a = ${weightA}×${volA}，b = ${weightB}×${volB}。组合方差 = a²+b²+2ab×(${rho.replace('-', '−')}) = ${varianceValue}，波动率为方差的平方根。`,
      interpretation,
    ].join('\n\n'),
    supplement: '只用一句话补充配置时如何观察相关性变化。无需重复题设、公式或展望新情景。',
  };
}

function portfolioHistory(questions) {
  const index = questions.findLastIndex(question => portfolioInputs.test(question));
  if (index < 0) return null;
  const matched = questions[index].match(portfolioInputs);
  if (additionalScenario.test(questions[index].slice(matched[0].length))) return null;
  const values = portfolioWeights(matched.groups);
  const basisTurn = index + 1;
  const baseline = calculatePortfolio(values, null, basisTurn);
  if (!baseline) return null;
  let correlation = null;
  let stress = null;
  for (let i = index + 1; i < questions.length; i++) {
    const question = questions[i];
    const update = question.match(correlationUpdate);
    const pressure = question.match(stressUpdate);
    if (update && !correlation && i === index + 1 && !additionalScenario.test(question.slice(update[0].length))) {
      correlation = calculatePortfolio(values, update[1], i + 1);
      if (!correlation) return null;
    } else if (pressure && !stress && !additionalScenario.test(question.slice(pressure[0].length))) {
      stress = calculatePortfolioStress(values, pressure[1], basisTurn, i + 1);
      if (!stress) return null;
    } else if (!portfolioLossExample.test(question) || additionalScenario.test(question)) {
      return null;
    }
  }
  return { values, basisTurn, baseline, correlation, stress };
}

function calculatePortfolioStress(values, rho, basisTurn, turn) {
  if (Math.abs(Number(rho)) > 1) return null;
  const base = volatility(portfolioVariance(values, values.correlation));
  const stressed = volatility(portfolioVariance(values, rho, 2));
  const outputs = {
    baseVolatility: result(base, '%'),
    stressVolatility: result(stressed, '%'),
    volatilityChange: result(`${stressed}-${base}`, '百分点'),
  };
  return {
    receipt: { template: 'two-asset-portfolio-stress', inputs: { ...recordInputs(values, basisTurn), stressCorrelation: toInput(rho, turn), volatilityScale: toInput('2', turn) }, outputs },
    body: [
      `沿用第 ${basisTurn} 轮权重，两项波动率翻倍，相关系数设为 ${rho}。**压力波动率 ${outputs.stressVolatility.value}%，原情景 ${outputs.baseVolatility.value}%，变化 ${outputs.volatilityChange.value} 个百分点。**`,
      `令 a=${values.weightA}×${values.volA}×2，b=${values.weightB}×${values.volB}×2，压力波动率=√(a²+b²+2ab×${rho})。波动率衡量收益的离散程度，不能当作亏损上限。`,
    ].join('\n\n'),
    supplement: '只用一句话说明为什么压力波动率不能当作亏损上限。',
  };
}

function summarizePortfolio({ values, basisTurn, baseline, correlation, stress }) {
  const { inputs, outputs: base } = baseline.receipt;
  const adjusted = correlation?.receipt;
  const pressure = stress?.receipt;
  const inputsEvidence = { ...inputs };
  const outputs = { expectedReturn: base.expectedReturn, baseVolatility: base.volatility };
  const comparisons = [`基准波动率 ${base.volatility.value}%`];
  if (adjusted) {
    inputsEvidence.updatedCorrelation = adjusted.inputs.updatedCorrelation;
    outputs.updatedVolatility = adjusted.outputs.volatility;
    comparisons.push(`相关系数改为 ${adjusted.inputs.updatedCorrelation.value} 时为 ${outputs.updatedVolatility.value}%`);
  }
  if (pressure) {
    inputsEvidence.stressCorrelation = pressure.inputs.stressCorrelation;
    inputsEvidence.volatilityScale = pressure.inputs.volatilityScale;
    outputs.stressVolatility = pressure.outputs.stressVolatility;
    comparisons.push(`相关系数为 ${pressure.inputs.stressCorrelation.value}、单项波动率翻倍时为 ${outputs.stressVolatility.value}%`);
  }
  return {
    receipt: { template: 'two-asset-portfolio-summary', inputs: inputsEvidence, outputs },
    body: [
      `**假设输入**（第 ${basisTurn} 轮）：权重 ${values.weightA}、${values.weightB}，预期年收益 ${values.returnA}、${values.returnB}，年波动率 ${values.volA}、${values.volB}，原相关系数 ${values.correlation}。`,
      `**条件计算**：组合预期收益 ${base.expectedReturn.value}%，${comparisons.join('；')}。这些结果依赖对应假设。`,
      '**未建模风险**：尾部亏损、最大回撤、杠杆与保证金、流动性及交易成本。',
      '**监控规则**：1) 跟踪滚动相关性，持续偏离设定值时重算组合波动率；2) 用实际波动率复核两项输入，持续偏离时更新压力情景；3) 分别记录实际回撤和模型波动率，定期复核流动性和杠杆暴露。',
    ].join('\n\n'),
    supplement: '只用一句话说明定期重算的意义。省去重复的监控规则、实际资料缺口和额外阈值。',
    optionalSupplement: true,
  };
}

function calculateGrossProfit(values, turn) {
  const { volumeDirection, volumeChange, priceDirection, priceChange, baseMargin } = values;
  const change = (direction, value) => /^[下减降]/.test(direction) ? `-${value}` : value;
  const volume = change(volumeDirection, volumeChange);
  const price = change(priceDirection, priceChange);
  if (rate(volume) < -1 || rate(price) <= -1 || rate(baseMargin) <= 0 || rate(baseMargin) > 1) return null;
  const quantity = `(1+(${volume}))`;
  const newPrice = `(1+(${price}))`;
  const cost = `(1-(${baseMargin}))`;
  const unitProfit = `(${newPrice}-${cost})`;
  const outputs = {
    revenueChange: result(`(${quantity}*${newPrice}-1)*100`, '%'),
    grossProfitChange: result(`(${quantity}*${unitProfit}/(${baseMargin})-1)*100`, '%'),
    grossMargin: result(`${unitProfit}/${newPrice}*100`, '%'),
    grossMarginChange: result(`(${unitProfit}/${newPrice}-(${baseMargin}))*100`, '百分点'),
  };
  const interpretation = rate(volume) > 0 && rate(price) < 0 && exact(unitProfit) > 0n && Number(outputs.grossProfitChange.value) < 0
    ? '这一情景中，放量有助于增加毛利，增量却填不平降价造成的单件毛利损失。判断放量能否增利，需要同时看销量和售价减单位成本后的差额。'
    : '检验放量能否带动利润时，既要看销量，也要看售价减单位成本后的差额。收入、毛利额和毛利率应分别判断。';
  return {
    receipt: { template: 'gross-profit-constant-unit-cost', inputs: { volumeChange: toInput(volume, turn), priceChange: toInput(price, turn), baseMargin: toInput(baseMargin, turn), unitCost: { value: 'unchanged', userTurn: turn } }, outputs },
    body: [
      `按题设的虚构情景，**收入 ${signedPercent(outputs.revenueChange.value)}，毛利额 ${signedPercent(outputs.grossProfitChange.value)}，毛利率 ${outputs.grossMargin.value}%（变动 ${outputs.grossMarginChange.value} 个百分点）**。`,
      `基期销量和单价均设为 1，单位成本为 1−${baseMargin}，本轮保持不变。新销量 = 1+(${volume})，新单价 = 1+(${price})。收入 = 销量×单价，毛利额 = 销量×(单价−单位成本)，毛利率 = (单价−单位成本)÷单价。前两项各自与基期相比。`,
      interpretation,
    ].join('\n\n'),
    supplement: '只用一句话说明可以跟踪哪些经营指标来判断投资命题。省略已经给出的量价和利润推导，不声明现实业务的结论。',
  };
}

export function calculateUserScenario(question, priorQuestions = []) {
  const text = normalize(question);
  const turn = priorQuestions.length + 1;
  const previousQuestion = normalize(priorQuestions.at(-1) ?? '');
  const contracts = text.match(newContracts);
  if (contracts) return impliedNewBookings(contracts, turn, text, previousQuestion);
  const ratios = calculateScenarioRatios(text, turn);
  if (ratios) return ratios;
  const valuation = requestedDcf(text);
  if (valuation) return calculateDcf(valuation, turn);
  if (/^(?:恢复|还原)/u.test(text)) return restoredDcf(text, priorQuestions.map(normalize));
  const discount = requestedDiscount(text);
  if (discount) {
    const baseline = requestedDcf(previousQuestion);
    if (baseline) return calculateDiscountChange(baseline, discount, turn - 1, turn);
  }
  const missing = text.match(omittedGrowth);
  if (missing) {
    const update = requestedDiscount(previousQuestion);
    const tested = text.slice(missing[0].length).match(statedDiscount);
    const basisTurn = update ? turn - 2 : turn - 1;
    const baseline = requestedDcf(normalize(priorQuestions[basisTurn - 1] ?? ''));
    if (baseline && tested && rate(tested[1]) === rate(update ?? baseline.discount) && /每股价值.*(?:差额|差异|影响)/.test(text) &&
        !additionalScenario.test(text.slice(missing[0].length))) {
      return calculateMissingGrowth(baseline, missing, tested[1], basisTurn, turn);
    }
  }
  const update = text.match(correlationUpdate);
  const portfolio = (update ? previousQuestion : text).match(portfolioInputs);
  const portfolioRequest = text.slice(update?.[0].length ?? portfolio?.[0].length ?? 0);
  if (portfolio && !additionalScenario.test(portfolioRequest) &&
      (update || /算[^。]*收益[^。]*波动率/.test(portfolioRequest))) {
    return calculatePortfolio(portfolioWeights(portfolio.groups), update?.[1] ?? null, turn);
  }
  const stress = text.match(stressUpdate);
  if (stress || portfolioSummary.test(text)) {
    const request = text.slice(stress?.[0].length ?? 0);
    if (additionalScenario.test(request)) return null;
    const history = portfolioHistory(priorQuestions.map(normalize));
    if (history && stress && /压力波动率.*与(?:原情景|基准)比较/.test(request)) {
      return calculatePortfolioStress(history.values, stress[1], history.basisTurn, turn);
    }
    if (history && !stress) return summarizePortfolio(history);
  }
  const grossProfit = text.match(grossProfitInputs);
  const grossProfitRequest = text.slice(grossProfit?.[0].length ?? 0);
  if (grossProfit && !additionalScenario.test(grossProfitRequest) && /计算[^。]*收入[^。]*毛利额[^。]*毛利率/.test(grossProfitRequest)) {
    return calculateGrossProfit(grossProfit.groups, turn);
  }
  return null;
}

export function scenarioInterpretationFindings(answer, receipt) {
  if (receipt?.template !== 'new-customer-bookings' || !receipt.inputs.priorRetention) return ratioInterpretationFindings(answer, receipt);
  const findings = [];
  for (const excerpt of answer.split(/[。！？；\n]/u)) {
    const claim = excerpt.replace(/[\s*]/gu,'');
    if (/(?:没有(?:给(?:出)?)?|未(?:给出|提供|披露)|缺(?:少|乏))(?:此前|当期|上期|上轮|存量|老)?(?:客户)?(?:的)?(?:净收入留存率|净留存率|NRR)(?!的?(?:分拆|拆分|明细|构成|分项|贡献))/iu.test(claim)) {
      findings.push({rule:'scenario_conclusion',severity:'error',excerpt:excerpt.trim(),message:'上一轮题设已提供老客净留存率，尚缺的是它的组成',
        expected:'区分已有的合计值和缺少的加购、降配、流失明细。'});
    }
  }
  return findings;
}

// An input or output can support a restatement only when its local metric,
// units and scenario match. Seeing the same number elsewhere is insufficient.
const scenarioLabels = [
  [/基期(?:的)?(?:fcff|(?:企业)?自由现金流(?:fcff)?)$/iu,'fcff'],
  [/(?:wacc|加权平均资本成本|折现率)$/iu,'discount'],
  [/永续(?:增长率?|增速)$/u,'terminalGrowth'],
  [/净债务$/u,'debt'], [/(?:总股数|股数)$/u,'shares'],
  [/企业价值$/u,'enterpriseValue'], [/每股(?:价值|估值)$/u,'perShare'],
  [/终值(?:现值)?占(?:企业价值(?:的比例)?|比)$/u,'terminalShare'],
  [/(?:组合)?预期(?:年化|年)?收益率?$/u,'expectedReturn'],
  [/(?:组合)(?:年化|年)?波动率$/u,'volatility'],
  [/(?:新增客户|新客户|新客)数(?:量)?(?:同比)?(?:增幅|增速|变动|增长|增加|增|降幅|下降|减少|降)$/u,'customerChange'],
  [/平均合同(?:金)?额(?:同比)?(?:增幅|增速|变动|增长|增加|增|降幅|下降|减少|降)$/u,'contractSizeChange'],
  [/(?:新客(?:户)?|新增客户)(?:签约(?:总)?额|合同总额)(?:的)?(?:变动|增速|增长率|增长|增加|增)$/u,'bookingsChange'],
  [/(?:全公司|公司|总体|总)?收入(?:的)?(?:变动|增速|增长率|增长|增加|增|下降|降)$/u,'revenueChange'],
];

export function scenarioAmountEvidence(statement, prefix, textValue, unit, calculation, localStatement = statement) {
  if (!calculation || /年报|季报|财报|据披露|实际(?:值|发生|实现)|工作簿|单元格|公告|\bp\.\s*\d|第\s*\d+\s*页|[!！][A-Z]+\$?\d+/iu.test(statement)) return null;
  const {inputs, outputs, template} = calculation.receipt;
  if (template === 'new-customer-bookings' && inputs.revenueChange && unit === '%' &&
      /(?:新客|新增客户)[^。；;]{0,8}(?:签约|合同)(?:总)?额/u.test(statement) &&
      /(?:公司|总体|新老|总)收入|收入口径|收入增(?:速|长)/u.test(statement) &&
      /无法判断|不能(?:说明|证明|直接|据此)|口径不同|不代表/u.test(statement)) {
    // A comparison of these two rates is not an attribution to old customers.
    // Grant evidence only to this adjacent pair and only at its token positions.
    for (const pair of localStatement.matchAll(/([+−-]?\d+(?:\.\d+)?\s*%)\s*(?:与|和|跟)\s*([+−-]?\d+(?:\.\d+)?\s*%)/gu)) {
      const start = prefix.length;
      if (start !== pair.index && start !== pair.index + pair[0].lastIndexOf(pair[2])) continue;
      const numbers = [pair[1],pair[2]].map(v=>Number.parseFloat(v.replace('−','-'))).sort((a,b)=>a-b);
      const known = [outputs.bookingsChange.value, inputs.revenueChange.value].map(v=>Number.parseFloat(v)).sort((a,b)=>a-b);
      return {matches:numbers[0] === known[0] && numbers[1] === known[1], expected:`新客签约额 ${outputs.bookingsChange.value}%，全公司收入 ${inputs.revenueChange.value}`};
    }
  }
  if (template === 'new-customer-bookings' && /(?:新客|新增客户)[^。；;\n]{0,8}(?:签约|合同)额|新客签约总额/u.test(localStatement)) {
    // A repeated calculation proves only tokens inside its exact expression.
    // Other numbers in the same sentence still need their own metric and basis.
    const canonical = part => part.normalize('NFKC').replace(/[−–]/gu,'-').replace(/×/gu,'*').replace(/[\s\x60]/gu,'');
    const factor = value => '(1' + (value.startsWith('-') ? value : '+' + value) + ')';
    const expression = factor(inputs.customerChange.value) + '*' + factor(inputs.contractSizeChange.value) + '-1';
    const line = canonical(localStatement), offset = canonical(prefix).length;
    const start = line.indexOf(expression);
    if (start >= 0 && offset >= start && offset < start + expression.length) return {matches:true,expected:textValue+unit};
    if (start >= 0 && /^(?:=|≈|得|等于)$/u.test(line.slice(start + expression.length,offset)) && unit === '%') {
      const places = (textValue.split('.')[1] || '').length;
      if (places <= 100) return {matches:Number(calculate({expression:outputs.bookingsChange.expression,precision:places}).value) === Number(textValue.replace('−','-')),expected:outputs.bookingsChange.value+'%'};
    }
  }
  const scope = prefix.normalize('NFKC').replace(/[*\x60\s]/gu,'').replace(/\(FCFF\)/giu,'FCFF');
  if (template === 'new-customer-bookings' && inputs.priorRetention && unit === '%' && !/未来|预测|预计|下期/u.test(scope)) {
    const retention = /(?:净收入留存率|净留存率|NRR)(?:\(NRR\))?[,，]?(?:由|从)(\d+(?:\.\d+)?%\s*(?:降至|降到|升至|变为|到))?$/iu.exec(scope);
    if (retention) {
      const expected = retention[1] ? inputs.latestRetention.value : inputs.priorRetention.value;
      return {matches:Number.parseFloat(expected) === Number(textValue),expected};
    }
  }
  const label = scope.split(/[，,、；;。|（）()]/u).at(-1).replace(/(?:约为|等于|改为|变为|仍为|恢复到|[为是约至到:=≈])+$/u,'');
  const named = scenarioLabels.find(([pattern]) => pattern.test(label));
  if (!named) return null;
  const context = scope.split(/[。；;]/u).at(-1);
  let key = named[1];
  if (key === 'revenueChange' && (template !== 'new-customer-bookings' || !/(?:^|题设|题中|假设|同期|[，,；;])(?:中)?(?:全公司|公司|总体|总)?收入/u.test(scope))) return null;
  const original = /原(?:始|情景|假设)|基准|调整前|恢复/u.test(context);
  const activeKey = calculation.receipt.activeInputs?.[key];
   if (!original && activeKey && inputs[activeKey]) key = activeKey;
   else if (key === 'discount' && inputs.adjustedDiscount && !original) key = 'adjustedDiscount';
  if (key === 'volatility' && outputs.priorVolatility && /由|从|原情景|基准/u.test(context)) key='priorVolatility';
  if (template === 'fcff-dcf-tested-scenarios' && ['perShare','enterpriseValue','discount','terminalGrowth'].includes(key) &&
      !original && !/题设给定|题设基期|原题设/u.test(context)) return null;
  if (template === 'fcff-dcf-discount-change' && ['perShare','enterpriseValue'].includes(key) && original) return null;
  const proof = outputs[key] || inputs[key];
  if (!proof || !/^[+−-]?\d+(?:\.\d+)?%?$/u.test(proof.value)) return null;
  const suppliedUnit = (unit || '').replace('％','%');
  const proofUnit = proof.unit === '每股' ? '' : (proof.unit || (proof.value.endsWith('%') ? '%' : ''));
  if (suppliedUnit !== proofUnit) return null;
  const direction = /(?:降幅|下降|减少|降)$/u.test(label) ? -1 : 1;
  const expected = Number.parseFloat(proof.value) * direction;
  const claimed = Number(textValue.replaceAll(',','').replace('−','-'));
  if (!Number.isFinite(claimed)) return null;
  // Repeating an input is exact. A calculated output may be rounded at the
  // stated precision, e.g. 8.660...% displayed as 8.66%.
  const digits = (textValue.split('.')[1] || '').length;
  if (digits > 100) return null;
  const rounded = outputs[key] ? direction * Number(calculate({expression:proof.expression,precision:digits}).value) : expected;
  return {matches: rounded === claimed, expected: String(expected)+proofUnit};
}
