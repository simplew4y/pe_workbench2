/** Conservative, deterministic checks for clearly bound claims in final answers. */
const NUMBER = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
const number = value => Number(value.replaceAll(',', ''));
const units = { 元: 1, 千元: 1000, 万元: 10000, 百万元: 1000000, 百万: 1000000, 亿元: 100000000, 亿: 100000000, 十亿: 1000000000 };
const tolerance = value => 0.5 * 10 ** -(value.split('.')[1]?.length || 0) + 1e-8;
export function answerStats(text) {
  return {
    processTextCount: (String(text).match(/让我|我来|让me/gi) || []).length,
    markdownTables: (String(text).match(/^\s*\|?\s*:?-{3,}:?\s*\|.*$/gm) || []).length,
  };
}
export function lintAnswer(text) {
  const t = String(text || '').trim();
  const findings = [];
  const add = (rule, message, excerpt, expected) => findings.push({ rule, severity: 'error', message, excerpt, expected });
  const unit = '(十亿|百万元|百 万元|千元|万元|亿元|百万|亿|元)'.replace('百 万元|', '');
  const conversion = new RegExp(`(${NUMBER})\\s*${unit}\\s*(?:≈|≃|=|约为|约|即|合|相当于|等于)\\s*(${NUMBER})\\s*${unit}`, 'g');
  for (const m of t.matchAll(conversion)) {
    const expected = number(m[1]) * units[m[2]] / units[m[4]];
    if (Math.abs(expected - number(m[3])) > tolerance(m[3])) add('unit_conversion', '单位换算不一致', m[0], expected);
  }
  const percent = new RegExp(`(${NUMBER})\\s*(?:→|->|至)\\s*(${NUMBER})[^。\\n]{0,24}?(变化|增长|下降|减少|增幅|涨幅)\\s*(${NUMBER})\\s*%`, 'g');
  for (const m of t.matchAll(percent)) {
    const a = number(m[1]);
    if (!a) continue;
    // "2025→2027 收入增长 30%" binds years, not the changed quantity.
    const isYear = (v) => /^(19|20|21)\d{2}$/.test(v);
    if (isYear(m[1]) && isYear(m[2])) continue;
    const expected = (number(m[2]) / a - 1) * 100 * (/下降|减少/.test(m[3]) ? -1 : 1);
    if (Math.abs(expected - number(m[4])) > tolerance(m[4])) add('percent_change', '百分比变化不一致', m[0], expected);
  }
  const ratio = new RegExp(`(${NUMBER})\\s*/\\s*(${NUMBER})\\s*[-−]\\s*1\\s*=\\s*(${NUMBER})\\s*%`, 'g');
  for (const m of t.matchAll(ratio)) {
    if (!number(m[2])) continue;
    const expected = (number(m[1]) / number(m[2]) - 1) * 100;
    if (Math.abs(expected - number(m[3])) > tolerance(m[3])) add('percent_change', '百分比计算不一致', m[0], expected);
  }
  // Restrict repeated-label checks to explicit line-start label:value claims.
  const labels = new Map();
  const labelled = new RegExp(`^\\s*([\\p{L}][\\p{L} _]{1,24})[：:]\\s*(${NUMBER})\\s*(亿元|百万元|万元|元|%)`, 'gmu');
  for (const m of t.matchAll(labelled)) {
    const section = [...t.slice(0, m.index).matchAll(/^#{1,6}\s+(.+)$/gm)].at(-1)?.[1] || "";
    const key = `${section}:${m[1].trim()}:${m[3]}`;
    if (labels.has(key) && labels.get(key) !== number(m[2])) add('inconsistent_value', '同名同单位数值不一致', m[0], labels.get(key));
    labels.set(key, number(m[2]));
  }
  const reasons = [];
  for (const [open, close] of [['（', '）'], ['(', ')'], ['“', '”'], ['「', '」']]) {
    let balance = 0;
    for (const char of t) { if (char === open) balance++; if (char === close) balance--; if (balance < 0) break; }
    if (balance !== 0) reasons.push(`${open}${close}未闭合`);
  }
  if ((t.match(/```/g) || []).length % 2) reasons.push('代码块未闭合');
  if ((t.match(/\*\*/g) || []).length % 2) reasons.push('粗体标记未闭合');
  const last = t.split('\n').at(-1) || '';
  if (!/[。！？.!?；;）)」”`|*\]]$/.test(t) && !/^\s*(?:[-*+]\s|\d+[.)、]\s|#{1,6}\s|\|)/.test(last)) reasons.push('句末可能截断');
  if (reasons.length) add('incomplete', reasons.join('；'), t.slice(-180), '补完并闭合回答');
  return findings;
}

// F5 is separate from lintAnswer: existing lint behavior remains unchanged.
import {correctedValues} from './ledger.mjs';
import {correctionMatches} from './correction-match.mjs';
export function lintLedgerAnswer(answer, ledger) {
  return correctedValues(ledger).flatMap(c => correctionMatches(answer,c).map(m => ({
    rule:'repeats_corrected_value',severity:'error',message:'重复已更正的旧值',
    excerpt:String(answer).slice(Math.max(0,m.start-40),m.end+40),
    expected:`${c.claim} 当前值 ${c.to} ${c.unit}`,
  })));
}
