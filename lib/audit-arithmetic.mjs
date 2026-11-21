/**
 * Deterministic adjudication of arithmetic/unit disputes raised by the model
 * reviewer. The reviewer may flag inputs, scope and business meaning, but its
 * own free-hand arithmetic cannot overrule an exact computation. Only purely
 * arithmetic objections are decided here; scope objections are left intact.
 */
import { calculate, percentLabelAmbiguity } from './calc-tool.mjs';

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

/**
 * @param issue   reviewer issue {check, excerpt, reason}
 * @param receipts successful calc results [{value, unit}]
 * @returns null when the issue stands, or {proof} when the arithmetic it disputes is exactly correct.
 */
export function overruledArithmetic(issue, receipts = []) {
  if (!['numeric_units', 'comparison_basis'].includes(issue?.check)) return null;
  const reason = String(issue.reason || ''), excerpt = String(issue.excerpt || '');
  if (issue.check === 'numeric_units' && SCALE_CLAIM.test(reason)) {
    const stated = rates(excerpt);
    const exact = divisions(reason + '\n' + excerpt);
    for (const rate of stated) for (const division of exact) {
      if (division.unit !== rate.unit) continue;
      // Compare in the stated display unit at the precision actually printed.
      const display = calculate({ expression: `${division.value}/(${rate.scale})`, precision: 15 }).value;
      if (Math.abs(Number(display) - Number(rate.digits)) <= tolerance(rate.digits) + 1e-12)
        return { proof: `${division.text} = ${Number(display).toPrecision(6)} ${rate.text.replace(rate.digits, '').trim()}，与正文 ${rate.text} 一致`, falseConversions: falseConversions(reason) };
    }
  }
  if (PERCENT_CLAIM.test(reason)) {
    const percents = [...excerpt.matchAll(/([+-]?\d+(?:\.\d+)?)\s*[%％]/gu)].map(m => m[1]);
    // A receipt is a fraction when labelled decimal/unlabelled, or when its
    // "%" label sits on an unscaled ratio (older receipts, see calc-tool).
    const fractions = receipts.filter(r => r && r.value != null && Math.abs(Number(r.value)) < 10 &&
      (r.unit !== '%' || percentLabelAmbiguity(r.unit, r.expression, r.value)));
    if (percents.length && percents.every(p => fractions.some(r => percentMatchesFraction(p, r.value))))
      return { proof: percents.map(p => `${p}% = ${fractions.find(r => percentMatchesFraction(p, r.value)).value} decimal`).join('；') };
  }
  return null;
}

/** Successful calc results in a message history (the receipts the reviewer saw). */
export function calcReceipts(messages = []) {
  return messages.filter(m => m?.role === 'toolResult' && m.toolName === 'calc' && !m.isError)
    .flatMap(m => Array.isArray(m.details?.results) ? m.details.results : []).map(r => ({ value: r.value, unit: r.unit || r.requestedUnit, name: r.name, expression: r.expression }));
}
