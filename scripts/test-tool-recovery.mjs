import assert from 'node:assert/strict';
import { calcFailureRecovery, failedCalcItems } from '../lib/tool-failure-recovery.mjs';
import { overruledArithmetic, calcReceipts, falseConversions } from '../lib/audit-arithmetic.mjs';

// --- P1-02: a failed calc batch is superseded item by item, not by tool name.
const failed = {
  id: 'call_fail', name: 'calc', success: false,
  args: { expressions: [
    { name: '储能毛利额', expression: '249.5916612781-158.0085329138', outputUnit: '亿元' },
    { name: '逆变器毛利额', expression: '291.27038840­90-201.2800552330', outputUnit: '亿元' },
  ] },
  result: { isError: true, details: { error: '多余算式符号：­' } },
};
const ok = {
  id: 'call_ok', name: 'calc', success: true,
  args: { expressions: [
    { name: '储能毛利额', expression: '249.5916612781-158.0085329138', outputUnit: '亿元' },
    { name: '逆变器毛利额', expression: '291.2703884090-201.2800552330', outputUnit: '亿元' },
  ] },
  result: { isError: false, details: { results: [
    { index: 0, name: '储能毛利额', expression: '249.5916612781-158.0085329138', evaluatedExpression: '249.5916612781-158.0085329138', value: '91.5831283643', unit: '亿元', bindings: {} },
    { index: 1, name: '逆变器毛利额', expression: '291.2703884090-201.2800552330', evaluatedExpression: '291.2703884090-201.2800552330', value: '89.990333176', unit: '亿元', bindings: {} },
  ] } },
};
assert.equal(failedCalcItems(failed).length, 2);
const full = calcFailureRecovery([failed, ok]);
assert.equal(full.length, 1);
assert.equal(full[0].unresolved.length, 0);
assert.equal(full[0].replaced.length, 2);
assert.equal(full[0].replaced[1].by, 'call_ok');
assert.equal(full[0].replaced[1].kind, 'same_formula');

// Incomplete replacement leaves the unrecomputed item visible.
const partialOk = { ...ok, id: 'call_ok2', result: { isError: false, details: { results: [ok.result.details.results[0]] } } };
const partial = calcFailureRecovery([failed, partialOk]);
assert.equal(partial[0].replaced.length, 1);
assert.deepEqual(partial[0].unresolved.map(u => u.name), ['逆变器毛利额']);

// A different unit label, name or formula is not a replacement.
for (const [label, mutate] of [
  ['unit', r => ({ ...r, args: { expressions: [{ ...r.args.expressions[0], outputUnit: '%' }] }, result: { isError: false, details: { results: [{ index: 0, ...r.result.details.results[0], unit: '%' }] } } })],
  ['name', r => ({ ...r, args: { expressions: [{ ...r.args.expressions[0], name: '别的指标' }] } })],
]) {
  const bad = mutate(ok);
  bad.id = 'call_bad_' + label;
  const result = calcFailureRecovery([failed, bad]);
  assert.ok(result[0].unresolved.length >= 1, label);
}
// Same name + equivalent formula (whitespace/parens differ) still replaces.
const equivalent = {
  id: 'call_eq', name: 'calc', success: true,
  args: { expressions: [{ name: '储能毛利额', expression: '( 249.5916612781 )-( 158.0085329138 )', outputUnit: '亿元' }] },
  result: { isError: false, details: { results: [{ index: 0, name: '储能毛利额', expression: '( 249.5916612781 )-( 158.0085329138 )', evaluatedExpression: '( 249.5916612781 )-( 158.0085329138 )', value: '91.5831283643', unit: '亿元', bindings: {} }] } },
};
const eqOnly = calcFailureRecovery([{ ...failed, args: { expressions: [failed.args.expressions[0]] } }, equivalent]);
assert.equal(eqOnly[0].replaced[0].kind, 'equivalent_formula');
// Non-calc failures are never touched.
assert.deepEqual(calcFailureRecovery([{ id: 'w', name: 'web_fetch', success: false, args: {}, result: { isError: true } }]), []);
// A failed partial batch reports only its failed items.
const partialCall = {
  id: 'call_p', name: 'calc', success: true,
  args: { expressions: [{ name: 'a', expression: '1+#' }, { name: 'b', expression: '1+1' }] },
  result: { isError: false, details: { partial: true, results: [{ index: 1, name: 'b', value: '2' }], failures: [{ index: 0, name: 'a', error: '无效算式符号' }] } },
};
assert.deepEqual(failedCalcItems(partialCall).map(i => i.name), ['a']);
assert.equal(calcFailureRecovery([partialCall, ok])[0].unresolved.length, 1);

// --- P1-03: the reviewer's own tenfold arithmetic is overruled by exact math.
const t02Issue = {
  check: 'numeric_units',
  excerpt: '储能发货 28GWh，折 0.891 元/Wh',
  reason: '249.59亿元÷28GWh换算：249.59亿元=2.496×10^11元，28GWh=2.8×10^10Wh，结果约8.91元/Wh，程序输出的0.891元/Wh疑似分母用了280亿Wh=280GWh而非28GWh，数值与“元/Wh”语义存在10倍级不一致风险。',
};
const proof = overruledArithmetic(t02Issue, []);
assert.ok(proof, 'tenfold claim must be overruled');
assert.match(proof.proof, /0\.891/);
// The reviewer's false conversion is recorded, not trusted.
assert.ok(falseConversions(t02Issue.reason).length >= 1);
// A genuinely wrong stated value is NOT overruled.
const wrong = { ...t02Issue, excerpt: '储能发货 28GWh，折 8.91 元/Wh' };
assert.equal(overruledArithmetic(wrong, []), null);
// Percent-vs-decimal disputes are decided against calc receipts.
const percentIssue = {
  check: 'comparison_basis',
  excerpt: '收现比 90.6%（上年按同口径约 85.7%）',
  reason: 'calc回执“收现比2024”=0.905696340727，按%读是0.9057%而非90.6%；“收现比2023”=0.856821895526，同样按%读是0.8568%而非85.7%。正文将小数0.9057写成百分比90.6%，即把小数×100后加%，程序outputUnit写“%”但实际算的是比值，正文引用口径与程序输出口径不一致。',
};
const receipts = calcReceipts([
  { role: 'toolResult', toolName: 'calc', isError: false, details: { results: [
    { value: '0.905696340727', unit: '%', expression: '705.148/778.57' },
    { value: '0.856821895526', unit: '%', expression: '619.057/(778.57/1.0776)' },
  ] } },
]);
assert.ok(overruledArithmetic(percentIssue, receipts), 'percent/decimal dispute must be overruled');
// Scope objections are never overruled.
assert.equal(overruledArithmetic({ check: 'coverage', excerpt: 'x', reason: '249.59亿元=2.496×10^11元' }, []), null);
console.log('PASS calc failure supersession and arithmetic dispute adjudication');
