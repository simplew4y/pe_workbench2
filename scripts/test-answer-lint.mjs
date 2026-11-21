import assert from 'node:assert/strict';
import { financialEvidenceFindings, pdfReportAmounts, scenarioDirectionFindings } from '../lib/financial-evidence.mjs';
import { dividendTotals } from '../lib/pdf-dividend-evidence.mjs';
const { lintAnswer } = await import('../lib/answer-lint.mjs');
const has = (text, rule) => lintAnswer(text).some(x => x.rule === rule);
const withCtx = (text, ctx) => lintAnswer(text, ctx);
assert(has('70534.2 百万元约 7053 亿元。', 'unit_conversion'));
assert(!has('7,053,400 百万元约 70,534 亿元。', 'unit_conversion'));
assert(has('7293 百万元合 7.3 亿元。', 'unit_conversion'));
assert(!has('7293 百万元合 72.93 亿元。', 'unit_conversion'));
assert(has('100→120，增长30%。', 'percent_change'));
assert(!has('100→120，增长20%。', 'percent_change'));
assert(has('120/100-1 = 30%。', 'percent_change'));
assert(has('目标价：100元。\n目标价：120元。', 'inconsistent_value'));
for (const text of ['未完成（内容。', '“没有闭合。', '```js\nconst a=1;', '**标题', '回答在句中']) assert(has(text, 'incomplete'), text);
for (const text of ['完成。', '- 条目', '| 名称 | 数值 |', '# 标题', '（已闭合）']) assert(!has(text, 'incomplete'), text);
assert(!has('先核对报告。\n\n官方链接：https://www.example.com/disclosure?stockCode=300274&orgId=9900016846', 'incomplete'));
assert(has('官方链接：https://', 'incomplete'));
for (const text of ['**监控规则**：1) 观察相关性；2) 更新波动率；3) 跟踪回撤。',
  '**三项待核**：1）营销趋势；2）AI 资本开支；3）2025 年现金流。',
  '1) 看波动率\n2）看回撤。', '计算结果按区间 (0; 2) 说明。']) assert(!has(text, 'incomplete'), text);
for (const text of ['1) 观察相关性；2) 核对风险（仍缺数据。', '正常文本里多了一个 2)。']) assert(has(text, 'incomplete'), text);
const unclosedBold = '1. **估值折价足够深。具体失效门槛尚缺推导依据，暂不能确定。';
assert(!has(unclosedBold, 'incomplete'));
assert.equal(lintAnswer(unclosedBold).find(finding => finding.rule === 'markdown_unclosed_bold')?.severity, 'warning');
console.log('answer lint passed');
assert(!has('# Base\n目标价：100元。\n# Bull\n目标价：120元。', 'inconsistent_value'));
assert(!has('原目标价：100元。\n新目标价：120元。', 'inconsistent_value'));
assert(has('7.3 亿约 7293 百万元。', 'unit_conversion'));
assert(!has('72.93 亿即 7293 百万元。', 'unit_conversion'));
assert(has('10000 万元约 10 亿元。', 'unit_conversion'));
assert(!has('10000 万元即 1 亿元。', 'unit_conversion'));
assert(has('1000 千元约 1 亿元。', 'unit_conversion'));
assert(!has('1000 千元约 0.01 亿元。', 'unit_conversion'));
// DT-1 U1: Rmb mn / 百万元 -> 亿元 claims are recomputed with Decimal.
assert(has('7053443 百万元 = 7053 亿元。', 'unit_conversion'));
assert(!has('7053443 百万元 = 70534.43 亿元。', 'unit_conversion'));
assert(has('7053443 Rmb mn = 7053 亿元。', 'unit_conversion'));
assert(!has('7053443 Rmb mn = 70534.43 亿元。', 'unit_conversion'));
// Relative 0.5% gate, not an absolute digit tolerance: 0.38% passes, 0.52% fails.
assert(!has('7053443 百万元 = 70534.44 亿元。', 'unit_conversion'));
assert(!has('7053443 百万元 = 70800 亿元。', 'unit_conversion'));
assert(has('7053443 百万元 = 70900 亿元。', 'unit_conversion'));
const u1 = withCtx('7053443 百万元 = 7053 亿元。', {}).find(x => x.rule === 'unit_conversion');
assert.equal(u1.severity, 'error');
assert.equal(u1.code, 'U1');
// DT-1 U2: order-of-magnitude gate vs market cap context. Warning only, never blind scaling.
const u2 = withCtx('公司市值约 5,000 亿元。', { marketCap: 500 }).find(x => x.rule === 'magnitude');
assert.ok(u2);
assert.equal(u2.code, 'U2');
assert.equal(u2.severity, 'warning');
assert.equal(withCtx('公司市值约 5,000 亿元。', { marketCap: 6000 }).filter(x => x.rule === 'magnitude').length, 0);
assert.equal(withCtx('公司市值约 5,000 亿元。', {}).filter(x => x.rule === 'magnitude').length, 0);
assert.equal(withCtx('公司市值约 5,000 Rmb mn。', { marketCap: 500 }).filter(x => x.rule === 'magnitude').length, 1);
assert.equal(withCtx('公司市值约 10,000 亿元。', { price: 100, shares: 1e10 }).filter(x => x.rule === 'magnitude').length, 0);
assert.equal(withCtx('公司市值约 100 亿元。', { price: 100, shares: 1e10 }).filter(x => x.rule === 'magnitude').length, 1);
// Explicit raw-unit context is honoured; claims outside market-cap language do not trigger.
assert.equal(withCtx('公司市值约 3,500 亿元。', { marketCap: 3.5e11, marketCapUnit: '元' }).filter(x => x.rule === 'magnitude').length, 0);
assert.equal(withCtx('目标价 100 元。', { marketCap: 500 }).filter(x => x.rule === 'magnitude').length, 0);
const { answerStats } = await import('../lib/answer-lint.mjs');
assert.deepEqual(answerStats('让我核对。我来检查。让me想想。\n| A | B |\n| --- | --- |'), { processTextCount: 3, markdownTables: 1 });
assert.deepEqual(lintAnswer('让我核对。'), []);

// CELL-CITE L1-L4: locator verification is opt-in via this turn's citations.
const cite = (locator = 'Model!A1') => ({ id: `c:${locator}`, materialId: 'mat-1', version: 1, locator });
const locatorFindings = (text, citations) => withCtx(text, { citations }).filter((item) => item.rule === 'unverified_locator');
// L1: answer locator matches a tool citation.
assert.deepEqual(locatorFindings('收入见 Model!A1。', [cite('Model!A1')]), []);
// L2: answer locator has no citation -> soft warning, code L2.
const l2 = locatorFindings('收入见 Model!Z99。', [cite('Model!A1')]);
assert.equal(l2.length, 1);
assert.equal(l2[0].severity, 'warning');
assert.equal(l2[0].code, 'L2');
assert.match(l2[0].excerpt, /Model!Z99/);
// Explicitly marking it unverified is the documented escape hatch.
assert.deepEqual(locatorFindings('收入见 Model!Z99（未核验）。', [cite('Model!A1')]), []);
// L3: quoted sheets and ranges normalise to the same citation.
assert.deepEqual(locatorFindings("收入见 'Discount PE'!H33。", [cite('Discount PE!H33')]), []);
assert.deepEqual(locatorFindings('区域 Model!A1:B2。', [cite('Model!A1:B2')]), []);
// A range is verified when every cell inside it was returned, and stays a warning when one is missing.
const rectangle = ['A1', 'B1', 'A2', 'B2'].map((coord) => cite(`Model!${coord}`));
assert.deepEqual(locatorFindings('区域 Model!A1:B2。', rectangle), []);
assert.equal(locatorFindings('区域 Model!A1:B2。', rectangle.slice(0, 3)).length, 1);
// Bare coordinates are not locators, so a shorthand list does not raise L2.
assert.deepEqual(locatorFindings('见 Discount PE!N35、N36。', [cite('Discount PE!N35')]), []);
// L4: prose without a coordinate never reports; missing citations context keeps legacy behavior.
assert.deepEqual(locatorFindings('收入增长 10%。', []), []);
assert.deepEqual(locatorFindings('收入见 Model!A1。', undefined), []);
console.log('cell citation lint L1-L4 passed');

// G1-G3: gap IDs are never cells; target/deviation answers need model + live price.
const { readFileSync } = await import('node:fs');
const badSection2 = readFileSync(new URL('./fixtures/g1-answer-section2.md', import.meta.url), 'utf8');
const byCode = (text, ctx, code) => lintAnswer(text, ctx).filter(x => x.code === code);
// The live bad answer (section 2) mixes a gap id with a cell claim, denies a
// target, and never gives the model price.
const g1 = byCode(badSection2, { userAsksDeviation: true }, 'G1');
assert.ok(g1.length >= 1, 'bad section 2 must hit G1');
assert.equal(g1[0].rule, 'gap_id_as_cell');
assert.equal(g1[0].severity, 'error');
assert.match(g1[0].excerpt, /G1/);
assert.ok(byCode(badSection2, { userAsksDeviation: true }, 'G2').length >= 1);
assert.ok(byCode(badSection2, { userAsksDeviation: true }, 'G3').length >= 1);
// G1 variants.
for (const text of ['目标价单元格（G1）不存在。', '没有独立目标价单元格（G1）。', '单元格(G2)留空。', '目标价单元格 G3 为空。']) {
  assert.ok(byCode(text, {}, 'G1').length >= 1, text);
}
// Gap ledgers/status tables are legitimate and must not trigger.
const gapStatus = '| 项 | 状态 |\n| --- | --- |\n| gaps: G1 | tool open |\n缺口 G2 待补；gaps[].id=G3。';
assert.deepEqual(lintAnswer(gapStatus).filter(x => ['gap_id_as_cell', 'target_missing_claim', 'deviation_no_model_price'].includes(x.rule)), []);
// G2: absence claims are warnings; a context target escalates to error.
const g2 = byCode('模型底层没有独立目标价，无法精确回答目标价与现价的偏离。', {}, 'G2');
assert.ok(g2.length >= 1);
assert.equal(g2[0].severity, 'warning');
const g2Escalated = byCode('模型底层没有独立目标价。', { valuations: [{ id: 'V1', output: 'target_price', value: 752 }] }, 'G2');
assert.ok(g2Escalated.length >= 1);
assert.equal(g2Escalated[0].severity, 'error');
// The same escalation works from a trace citation that already read SOTP!J134=752.
const g2Citation = byCode('模型底层没有独立目标价。', { citations: [{ materialId: 'm1', version: 1, locator: 'SOTP!J134', value: 752, role: 'output' }] }, 'G2');
assert.equal(g2Citation[0].severity, 'error');
assert.deepEqual(byCode('没有目标价变化，维持原值。', {}, 'G2'), []);
// G3: deviation question + broker target only is incomplete.
const a2 = '券商目标价 520 港元，较现价 418.4 港元有约 24% 上行空间。';
const g3 = byCode(a2, { userAsksDeviation: true }, 'G3');
assert.ok(g3.length >= 1);
assert.equal(g3[0].severity, 'warning');
// An answer that self-labels a deviation section supplies the context itself.
assert.ok(byCode('## 目标价与现价偏离\n\n券商目标价 520。', {}, 'G3').length >= 1);
// A3: model target + live price + upside is clean.
const a3 = '模型目标价 752 港元 vs 现价 418.4 港元，空间约 +79.7%；驱动来自 SOTP 分部重估。';
assert.deepEqual(lintAnswer(a3, { userAsksDeviation: true }).filter(x => ['gap_id_as_cell', 'target_missing_claim', 'deviation_no_model_price'].includes(x.rule)), []);
// A failed live quote is acceptable only when it is stated as unverified.
const unverifiedPrice = '模型目标价 752 港元 vs 现价未获取（westock_query 失败），空间未获取。';
assert.deepEqual(byCode(unverifiedPrice, { userAsksDeviation: true }, 'G3'), []);
// A context-known target counts when the answer quotes it without the label.
assert.deepEqual(byCode('752 港元 vs 现价 418.4 港元，空间约 +79.7%。', { userAsksDeviation: true, modelTargetPrice: 752 }, 'G3'), []);
const missingQuote = '模型目标价为129元。没有现价，无法计算上行空间。';
const knownTargetWithoutQuote = { modelTargetPrice: 129, userAsksDeviation: true };
for (const code of ['G2', 'G3']) assert.deepEqual(byCode(missingQuote, knownTargetWithoutQuote, code), []);
assert.equal(byCode('无法复现模型目标价。', knownTargetWithoutQuote, 'G2')[0].severity, 'error');
console.log('target deviation lint G1-G3 passed');

const proposal = pdfReportAmounts({page: 35, paragraphs: [
  '2024 年度公司现金分配方案为：以股权登记日总股本为基数，拟向全体股东每10股派现金31.69元，共计分配现金12,300,815,767.85元。',
]});
const otherProposal = pdfReportAmounts({page: 35, paragraphs: [
  '2024年度现金分配方案为：拟向全体股东派发股利，共计分配现金5,045,000,000.00元。',
]});
const pdfReports = [
  {filename:'五粮液_2024年报.pdf', facts:proposal},
  {filename:'另一公司_2024年报.pdf', facts:otherProposal},
];
const pdfFindings = answer => financialEvidenceFindings(answer, {pdfReports}, []);
const wrongProposal = pdfFindings('五粮液2024年度现金分红预案为123.08亿元（第35页）。');
assert.equal(wrongProposal[0]?.rule, 'pdf_amount_mismatch');
assert.match(wrongProposal[0].expected, /123\.01亿元.*12,300,815,767\.85元/);
assert.deepEqual(pdfFindings('五粮液2024年度现金分红预案为123.01亿元（第35页）。'), []);
assert.deepEqual(pdfFindings('五粮液2024年度现金分红预案为12,300.82百万元（第35页）。'), []);
assert.equal(pdfFindings('五粮液2024年度现金分红预案为123.01亿元（第24页）。')[0]?.rule, 'pdf_source_mismatch');
assert.equal(pdfFindings('另一公司2024年度现金分红预案为123.01亿元（第35页）。')[0]?.rule, 'pdf_amount_mismatch');
assert.equal(pdfFindings('2024年度现金分红预案为123.01亿元（第35页）。')[0]?.rule, 'unsourced_number');
assert.equal(pdfFindings('五粮液2024年中期现金分红为123.01亿元（第35页）。')[0]?.rule, 'unsourced_number');

const table = pdfReportAmounts({page: 36, paragraphs: [
  '5、现金流', '单位：元', '项目 2024年 2023年 同比增减',
  '经营活动产生的现金流量净额 12,068,326,644.66 6,981,838,977.28 72.85%',
]});
const cashFlowFindings = answer => financialEvidenceFindings(answer, {pdfReports:[{filename:'示例_2024年报.pdf', facts:table}]}, []);
assert.deepEqual(cashFlowFindings('2024年经营现金流净额120.68亿元、同比增长72.85%（p.36）。'), []);
assert.deepEqual(cashFlowFindings('2024年经营现金流净额同比增长72.85%（p.36）。'), []);
assert.equal(cashFlowFindings('2024年经营现金流净额同比下降72.85%（p.36）。')[0]?.rule, 'pdf_amount_mismatch');
assert.equal(cashFlowFindings('2024年经营现金流净额120.68亿元、同比增长72.58%（p.36）。')[0]?.rule, 'pdf_amount_mismatch');
assert.equal(cashFlowFindings('2023年经营现金流净额120.68亿元（p.36）。')[0]?.rule, 'pdf_period_mismatch');
assert.deepEqual(cashFlowFindings('2024年经营现金流净额120.68亿元（12,068,326,644.66元），同比+72.85%（p.36）。'), []);
assert.equal(cashFlowFindings('2024年经营现金流净额120.68亿元（12,066,326,644.66元），同比+72.85%（p.36）。')[0]?.rule, 'pdf_amount_mismatch');

const industryCash = pdfReportAmounts({page:8, paragraphs:[
  '华南某酒股份有限公司2024年年度报告', '单位：元 币种：人民币', '变动比例', '科目 本期数 上年同期数', '（%）',
  '营业收入 1,000,000,000.00 800,000,000.00 25.00经营活动产生的现金流量净额 500,000,000.00 400,000,000.00 25.00投资活动产生的现金流量净额 -10,000.00 -8,000.00 不适用',
]});
const compareCash = answer => financialEvidenceFindings(answer, {pdfReports:[
  {filename:'华南某酒_2024年年报.pdf', facts:industryCash}, {filename:'示例_2024年报.pdf', facts:table},
]}, []);
const comparison = '某酒2024年经营现金流净额5.00亿元（某酒p.8）；示例2024年经营现金流净额120.68亿元、同比+72.85%（示例_2024年报.pdf p.36）。';
assert.deepEqual(compareCash(comparison), []);
assert.equal(compareCash(comparison.replace('5.00亿元', '120.68亿元'))[0]?.rule, 'pdf_amount_mismatch');
assert.equal(compareCash(comparison.replace('某酒p.8', 'p.8'))[0]?.rule, 'unsourced_number');

const channelTable = {
  page:10, paragraphs:[
    '甲公司2024年度报告全文',
    '1、不同模式、不同产品的营业收入、营业成本、毛利率情况单位：元营业收入比 营业成本比 毛利率比上年项目 营业收入 营业成本 毛利率上年同期增减销售模式酒类产品 2,000.00 300.00 85.00% 8.74%其中：经销模式 1,200.00 200.00 83.33% 5.99%直销模式 800.00 100.00 87.50% 12.89%产品分类酒类产品 2,000.00 300.00 85.00%',
  ],
};
const channel = pdfReportAmounts(channelTable).find(fact => fact.metric === 'annual_sales_channels');
assert.equal(channel?.directShare, '40.00');
assert.equal(channel?.direct.margin, '87.50');
const mixedChannel = {...channelTable, paragraphs:channelTable.paragraphs.map(text => text.replace('800.00 100.00', '810.00 100.00'))};
assert.equal(pdfReportAmounts(mixedChannel).some(fact => fact.metric === 'annual_sales_channels'), false);

const components = [
  ...pdfReportAmounts({page: 2, paragraphs: [
    '公司拟以股权登记日股本为基数，实施2024年年度利润分配，向全体股东每10股派发现金红利276.24元。以此计算合计派发现金红利34,671,299,522.40元。',
  ]}),
  ...pdfReportAmounts({page: 34, paragraphs: [
    '根据《2024年中期利润分配方案》，公司以股权登记日125,619.78万股为基数，向全体股东每10股派发现金红利238.82元。该方案已实施完毕。',
  ]}),
];
const dividendReport = {filename:'贵州茅台_2024年报.pdf', facts:[...components, ...dividendTotals(components)]};
const combined = '贵州茅台2024年中期每10股派238.82元；年度预案每10股派276.24元（贵州茅台年报p.2、p.34），两项合计约646.72亿元。';
const dividendFindings = answer => financialEvidenceFindings(answer, {pdfReports:[dividendReport]}, []);
assert.deepEqual(dividendFindings(combined), []);
assert.equal(dividendFindings(combined.replace('646.72', '646.87'))[0]?.rule, 'pdf_amount_mismatch');
assert.equal(dividendFindings(combined.replace('、p.34', '')).some(f => f.rule === 'pdf_source_mismatch'), true);
const allDividendUnits = combined
  .replace('中期每10股派238.82元', '中期分红238.82元/10股已实施')
  .replace('年度预案每10股派276.24元', '年度预案为276.24元/10股，合计346.71亿元');
assert.deepEqual(dividendFindings(allDividendUnits), []);
assert.match(dividendFindings(allDividendUnits.replace('346.71', '346.72'))[0].expected, /^346\.71亿元/u);

const groupMargins = pdfReportAmounts({page: 10, paragraphs: [
  '截至十二月三十一日止年度', '二零二四年 二零二三年 同比變動 二零二四年 二零二三年毛利╱（虧） 毛利率（人民幣百萬元）',
  '營銷服務 67,232 51,344 31% 55% 51%', '本集團 349,246 293,109 19% 53% 48%',
]});
const grossMarginFindings = answer => financialEvidenceFindings(answer, {pdfReports:[{filename:'示例_2024年报.pdf', facts:groupMargins}]}, []);
assert.deepEqual(grossMarginFindings('2024年整体毛利率由48%升至53%（p.10）。'), []);
assert.deepEqual(grossMarginFindings('集团毛利率由2023年48%升至2024年53%（p.10）。'), []);
assert.equal(grossMarginFindings('2024年整体毛利率由48%升至55%（p.10）。')[0]?.rule, 'pdf_amount_mismatch');
assert.equal(grossMarginFindings('2024年营销服务毛利率由48%升至53%（p.10）。')[0]?.rule, 'unsourced_number');
const profitComparisonPage = {page:11, paragraphs:[
  '截至二零二四年十二月三十一日止年度的本公司權益持有人應佔盈利同比增長68%至人民幣1,941億元。',
  '截至二零二四年十二月三十一日止年度的非國際財務報告準則本公司權益持有人應佔盈利增長41%至人民幣2,227億元。',
]};
assert.deepEqual(pdfReportAmounts(profitComparisonPage).find(f => f.metric === 'annual_owner_profit_yoy_comparison'), {
  metric:'annual_owner_profit_yoy_comparison', year:'2024', part:'FY', page:11, reported:'68', adjusted:'41',
});
const mixedProfitPeriods = {...profitComparisonPage, paragraphs:[profitComparisonPage.paragraphs[0], profitComparisonPage.paragraphs[1].replace('二零二四', '二零二三')]};
assert.equal(pdfReportAmounts(mixedProfitPeriods).some(f => f.metric === 'annual_owner_profit_yoy_comparison'), false);
const carriedIdentity = {filename:'示例_2024年报.pdf', materialId:'pdf-margin', version:1, sha256:'margin-source'};
const carriedReport = {...carriedIdentity, facts:groupMargins};
const carriedContext = {pdfReports:[carriedReport], pdfDisclosure:{kind:'segment_margins', facts:[{...carriedIdentity,...groupMargins[0]}]}};
assert.deepEqual(financialEvidenceFindings('**判断**：2024年集团毛利率48%→53%。', carriedContext, []), []);
assert.equal(financialEvidenceFindings('2024年集团毛利率48%→55%。', carriedContext, [])[0]?.rule, 'pdf_amount_mismatch');
assert.equal(financialEvidenceFindings('2024年集团毛利率48%→53%。', {...carriedContext,pdfReports:[{...carriedReport,version:2}]}, [])[0]?.rule, 'unsourced_number');
const scenario = '虚构情景：未来两季营销收入增速降至5%，游戏收入增长15%，AI资本开支上升，经营现金流未知。哪些命题需要下调，哪些仍不能判断？';
assert.deepEqual(scenarioDirectionFindings('营销收入增速降至5%，分子升、分母降。', scenario)
  .map(f => f.message), ['漏答题设中的游戏收入变化', '用分部增速放缓推出了总收入下降']);
assert.deepEqual(scenarioDirectionFindings('营销放缓会削弱增量，游戏增长提供缓冲。总收入是否下降取决于收入权重。', scenario), []);
