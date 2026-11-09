import assert from 'node:assert/strict';
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
// L4: prose without a coordinate never reports; missing citations context keeps legacy behavior.
assert.deepEqual(locatorFindings('收入增长 10%。', []), []);
assert.deepEqual(locatorFindings('收入见 Model!A1。', undefined), []);
console.log('cell citation lint L1-L4 passed');
