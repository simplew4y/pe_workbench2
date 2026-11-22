/**
 * Deterministic adjudication of arithmetic/unit disputes raised by the model
 * reviewer. The reviewer may flag inputs, scope and business meaning, but its
 * own free-hand arithmetic cannot overrule an exact computation. Only purely
 * arithmetic objections are decided here; scope objections are left intact.
 */
import { calculate } from './calc-tool.mjs';

// Check explicit arithmetic in the reviewer's proposed correction, even when
// the draft itself is wrong. Correcting this number never approves the draft
// or removes an objection about entity, period, units or metric identity.
export function correctReviewerArithmetic(issue) {
  const corrections=[];
  const reason=String(issue.reason || '').replace(
    /(?<![\d.,+*/−-])([+-]?\d[\d,]*(?:\.\d+)?(?:\s*[+−\-×*÷/]\s*[+-]?\d[\d,]*(?:\.\d+)?)+)\s*(=|＝|≈|实际为)\s*([+-]?\d[\d,]*(?:\.\d+)?)([%％]?)/gu,
    (original,expression,operator,digits,percent)=>{
      try {
        const normalized=expression.replaceAll(',','').replaceAll('−','-').replaceAll('×','*').replaceAll('÷','/');
        const result=calculate({expression:normalized,precision:15});
        const expected=Number(result.value)*(percent?100:1),stated=Number(digits.replaceAll(',',''));
        const tolerance=0.5*10**-((digits.split('.')[1] || '').length);
        if(!Number.isFinite(expected) || Math.abs(expected-stated)<=tolerance+1e-10*Math.abs(expected))return original;
        const corrected=expression+' '+operator+' '+Number(expected.toPrecision(15))+percent;
        corrections.push({original,expression:normalized,stated,result:String(expected),corrected});
        return corrected;
      } catch {return original;}
    });
  return {issue:corrections.length?{...issue,reason}:issue,corrections};
}

const SCALE = {
  '元': ['元', '1'], '千元': ['元', '1000'], '万元': ['元', '10000'], '百万元': ['元', '1000000'], '亿元': ['元', '100000000'], '十亿元': ['元', '1000000000'], '万亿元': ['元', '1000000000000'],
  'Wh': ['Wh', '1'], 'kWh': ['Wh', '1000'], 'MWh': ['Wh', '1000000'], 'GWh': ['Wh', '1000000000'], 'TWh': ['Wh', '1000000000000'],
  'W': ['W', '1'], 'kW': ['W', '1000'], 'MW': ['W', '1000000'], 'GW': ['W', '1000000000'], 'TW': ['W', '1000000000000'],
};
const PREFIX = { '': '1', '万': '10000', '亿': '100000000' };
const UNIT = '(?:万亿元|十亿元|百万元|千元|万元|亿元|元|TWh|GWh|MWh|kWh|Wh|TW|GW|MW|kW|W)';
const SUPERSCRIPT = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9', '⁻': '-' };
const NUMBER = String.raw`([+-]?\d+(?:,\d{3})*(?:\.\d+)?)(?:\s*[×xX*]\s*10\s*(?:\^\s*([+-]?\d+)|([⁰¹²³⁴⁵⁶⁷⁸⁹⁻]+)))?`;
const QUANTITY = new RegExp(`${NUMBER}\\s*(万|亿)?\\s*(${UNIT})(?![A-Za-z])`, 'gu');

function quantity(match) {
  let [, digits, power, superscript, prefix = '', unit] = match;
  const exponent = power ?? (superscript ? [...superscript].map(c => SUPERSCRIPT[c]).join('') : null);
  // "280亿元" carries its multiplier inside the unit; "280亿Wh" does not.
  if (prefix && SCALE[prefix + unit]) [prefix, unit] = ['', prefix + unit];
  if (prefix && unit.endsWith('元')) return null;
  const [base, factor] = SCALE[unit];
  const multiplier = PREFIX[prefix];
  const expression = `${digits.replaceAll(',', '')}${exponent ? `*10^(${exponent})` : ''}*${factor}*${multiplier}`;
  try { return { base, value: calculate({ expression }).value, text: match[0], digits: digits.replaceAll(',', ''), unit, prefix }; } catch { return null; }
}
const quantities = text => [...String(text || '').matchAll(QUANTITY)].map(m => ({ ...quantity(m), index: m.index })).filter(q => q.base);
const relativeDifference = (a, b) => Math.abs(Number(a) - Number(b)) / Math.max(Math.abs(Number(b)), Number.MIN_VALUE);

/** "A = B" conversions stated by the reviewer that are false (beyond 1% rounding). */
export function falseConversions(text) {
  const issues = [];
  const all = quantities(text);
  for (const [i, left] of all.entries()) {
    const right = all[i + 1];
    if (!right || left.base !== right.base) continue;
    const between = String(text).slice(left.index + left.text.length, right.index);
    if (!/^\s*(?:=|＝|即|等于)\s*$/u.test(between)) continue;
    if (relativeDifference(left.value, right.value) > 0.01) issues.push(`${left.text} = ${left.value} ${left.base}，不等于 ${right.text}`);
  }
  return issues;
}

// Display precision of a stated value: 0.891 proves three decimals, no more.
const tolerance = digits => 0.5 * 10 ** -((digits.split('.')[1] || '').length);

/** Exact "A ÷ B" computations in a text, expressed per base unit (e.g. 元/Wh). */
function divisions(text) {
  const all = quantities(text), out = [];
  for (const [i, numerator] of all.entries()) {
    const denominator = all[i + 1];
    if (!denominator) continue;
    const between = String(text).slice(numerator.index + numerator.text.length, denominator.index);
    if (!/^\s*(?:÷|\/|除以)\s*$/u.test(between)) continue;
    out.push({ unit: `${numerator.base}/${denominator.base}`, value: calculate({ expression: `${numerator.value}/(${denominator.value})`, precision: 15 }).value,
      text: `${numerator.text}÷${denominator.text}` });
  }
  return out;
}
const RATE = /([+-]?\d+(?:\.\d+)?)\s*(元|万元|亿元)\s*\/\s*(Wh|kWh|MWh|GWh|W|kW|MW|GW)(?![A-Za-z])/gu;
function rates(text) {
  return [...String(text || '').matchAll(RATE)].map(m => {
    const [money, moneyFactor] = SCALE[m[2]], [energy, energyFactor] = SCALE[m[3]];
    return { digits: m[1], text: m[0], unit: `${money}/${energy}`, value: calculate({ expression: `${m[1]}*${moneyFactor}/${energyFactor}`, precision: 15 }).value, scale: `${moneyFactor}/${energyFactor}` };
  });
}

/** Percent written from a fraction receipt: 0.9057 decimal == 90.57%; 0.9057 decimal != 0.9057%. */
function percentMatchesFraction(percentDigits, fraction) {
  const expected = Number(fraction) * 100;
  return Math.abs(Number(percentDigits) - expected) <= tolerance(percentDigits) + 1e-9;
}

const SCALE_CLAIM = /(?:\d+\s*倍|十倍|百倍|千倍|数量级|10\s*倍|量级)/u;
const PERCENT_CLAIM = /(?:按\s*%\s*读|按百分[比数]读|小数.{0,12}(?:写成|当作|误作|标为)|(?:写成|当作|误作)百分|百分[比数].{0,6}小数|%.{0,6}(?:而非|不是).{0,6}%)/u;
const SCOPE_DISPUTE = /主体|期间|年份|币种|来源|口径|另一|其他|不同|分子分母|指标|未经核验|缺少证据/u;
const compactClaim = text => String(text || '').replace(/[\s*`：:，,。；;（）()]/gu, '');

// A numeric coincidence is not a claim binding. Only a single complete named
// assertion can be discharged. Compound excerpts and unnamed legacy receipts
// remain for semantic review instead of clearing unrelated assertions.
function namedReceipt(excerpt, valueText, receipts) {
  const matches = receipts.filter(r => r?.toolCallId && r.name &&
    compactClaim(excerpt) === compactClaim(r.name + valueText));
  if (matches.length !== 1) return null;
  const receipt = matches[0];
  try {
    const evaluated = calculate({expression:receipt.evaluatedExpression || receipt.expression,
      fromUnit:receipt.fromUnit, toUnit:receipt.toUnit, precision:15});
    if (Math.abs(Number(evaluated.value) - Number(receipt.value)) > 1e-10 * Math.max(1, Math.abs(Number(receipt.value)))) return null;
  } catch { return null; }
  return receipt;
}

/**
 * @param issue   reviewer issue {check, excerpt, reason}
 * @param receipts successful calc results [{value, unit}]
 * @returns null when the issue stands, or {proof} when the arithmetic it disputes is exactly correct.
 */
export function overruledArithmetic(issue, receipts = []) {
  if (issue?.check !== 'numeric_units') return null;
  const reason = String(issue.reason || ''), excerpt = String(issue.excerpt || '');
  if (SCOPE_DISPUTE.test(reason)) return null;
  if (issue.check === 'numeric_units' && SCALE_CLAIM.test(reason)) {
    const stated = rates(excerpt);
    if (stated.length !== 1 || !falseConversions(reason).length) return null;
    const exact = divisions(reason + '\n' + excerpt);
    for (const rate of stated) for (const division of exact) {
      if (division.unit !== rate.unit) continue;
      const receipt = namedReceipt(excerpt, rate.text, receipts);
      if (!receipt || compactClaim(receipt.unit) !== compactClaim(rate.text.replace(rate.digits, ''))) continue;
      // Compare in the stated display unit at the precision actually printed.
      const display = calculate({ expression: `${division.value}/(${rate.scale})`, precision: 15 }).value;
      if (Math.abs(Number(display) - Number(receipt.value)) <= 1e-10 && Math.abs(Number(display) - Number(rate.digits)) <= tolerance(rate.digits) + 1e-12)
        return { evidenceId:receipt.toolCallId, resultIndex:receipt.index, proof: `${division.text} = ${Number(display).toPrecision(6)} ${rate.text.replace(rate.digits, '').trim()}，与正文 ${rate.text} 一致`, falseConversions: falseConversions(reason) };
    }
  }
  if (PERCENT_CLAIM.test(reason)) {
    const percents = [...excerpt.matchAll(/([+-]?\d+(?:\.\d+)?)\s*[%％]/gu)];
    if (percents.length !== 1) return null;
    const receipt = namedReceipt(excerpt, percents[0][0], receipts);
    if (receipt?.unit === 'decimal' && (!receipt.ratioEncoding || receipt.ratioEncoding === 'fraction') && percentMatchesFraction(percents[0][1], receipt.value))
      return { evidenceId:receipt.toolCallId, resultIndex:receipt.index, proof:`${percents[0][1]}% = ${receipt.value} decimal` };
  }
  return null;
}

/** Successful calc results in a message history (the receipts the reviewer saw). */
export function calcReceipts(messages = [], allowedIds) {
  return messages.filter(m => m?.role === 'toolResult' && m.toolName === 'calc' && !m.isError && !m.details?.error && (!allowedIds || allowedIds.has(m.toolCallId)))
    .flatMap(m => (Array.isArray(m.details?.results) ? m.details.results : [])
      .filter(r => !r.isError && !r.error)
      .map((r,index) => ({...r, toolCallId:m.toolCallId, index:r.index ?? index})));
}
