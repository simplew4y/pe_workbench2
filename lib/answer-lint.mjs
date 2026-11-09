/** Conservative, deterministic checks for clearly bound claims in final answers. */
import { convertExact, formatDecimal, ratioCalc, relativeErrorExceeds, unitInfo } from './calc-tool.mjs';
const NUMBER = String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
const number = value => Number(value.replaceAll(',', ''));
const tolerance = value => 0.5 * 10 ** -(value.split('.')[1]?.length || 0) + 1e-8;
const AMOUNT_UNIT = String.raw`(?:(?:RMB|Rmb|rmb|HKD|hkd|USD|usd)\s*mn|\bmn\b|十亿元|十亿|百万元|百万|千元|万元|亿元|亿|元)`;
const CAP_LABEL = String.raw`(?:总市值|市值|股权价值|股东价值|权益价值|market\s*cap(?:italization)?|equity\s*value)`;
const amountFactor = (unit) => {
  const info = unitInfo(unit);
  return Number(info.factor.n) / Number(info.factor.d);
};
function marketCapBase(context) {
  if (!context || typeof context !== 'object') return null;
  let raw = context.marketCap, unit = context.marketCapUnit;
  if (raw && typeof raw === 'object') { unit = raw.unit ?? unit; raw = raw.value ?? raw.amount; }
  if (raw != null) {
    const value = Number(String(raw).replaceAll(',', ''));
    if (!Number.isFinite(value)) return null;
    // westock returns raw currency (>= 1e6), while PE workbooks usually pass 亿元.
    const resolved = unit || (Math.abs(value) >= 1e6 ? '元' : '亿元');
    try { return value * amountFactor(resolved); } catch { return null; }
  }
  if (context.price != null && context.shares != null) {
    const price = Number(String(context.price).replaceAll(',', ''));
    const shares = Number(String(context.shares).replaceAll(',', ''));
    if (!Number.isFinite(price) || !Number.isFinite(shares)) return null;
    try { return price * shares * amountFactor(context.priceUnit || '元'); } catch { return null; }
  }
  return null;
}
export function answerStats(text) {
  return {
    processTextCount: (String(text).match(/让我|我来|让me/gi) || []).length,
    markdownTables: (String(text).match(/^\s*\|?\s*:?-{3,}:?\s*\|.*$/gm) || []).length,
  };
}
export function lintAnswer(text, context = {}) {
  const t = String(text || '').trim();
  if (!context || typeof context !== 'object') context = {};
  const findings = [];
  const add = (rule, message, excerpt, expected, severity = 'error', code = null) =>
    findings.push({ rule, severity, message, excerpt, expected, ...(code ? { code } : {}) });
  // U1: unit claims are recomputed with Decimal and judged by relative error (>0.5%).
  const unit = String.raw`(?:(?:RMB|Rmb|rmb|HKD|hkd|USD|usd)\s*mn|(?:RMB|Rmb|rmb|HKD|hkd|USD|usd)\s*million|\bmn\b|十亿元|十亿|百万元|百万|千元|万元|亿元|亿|元)`;
  const conversion = new RegExp(`(${NUMBER})\\s*(${unit})\\s*(?:≈|≃|=|约为|约|即|合|相当于|等于|折合)\\s*(${NUMBER})\\s*(${unit})`, 'gi');
  for (const m of t.matchAll(conversion)) {
    try {
      const expected = convertExact(m[1], m[2], m[4]);
      if (relativeErrorExceeds(m[3], formatDecimal(expected), '0.005')) {
        add('unit_conversion', '单位换算不一致', m[0], formatDecimal(expected), 'error', 'U1');
      }
    } catch { /* unknown unit alias: leave to other rules */ }
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
  // DT-3 R1: bare "A / B = X%" claims are recomputed with Decimal.
  // context.toolNumbers (optional) records this turn's tool results; the
  // recomputation itself never relies on the model or on binary floats.
  const ratioClaim = new RegExp(`(${NUMBER})\\s*[/÷]\\s*(${NUMBER})\\s*(?:=|≈|≃|约等于|约为)\\s*(${NUMBER})\\s*[%％]`, 'g');
  for (const m of t.matchAll(ratioClaim)) {
    try {
      const expected = ratioCalc({ numerator: m[1], denominator: m[2], op: '%' }).value;
      if (relativeErrorExceeds(m[3], expected, '0.005')) add('ratio_recompute', '占比/比率计算不一致', m[0], `${expected}%`, 'error', 'R1');
    } catch { /* denominator zero or malformed: leave to other rules */ }
  }
  // DT-3: "占…X%（A/B）" form.
  const shareClaim = new RegExp(`(${NUMBER})\\s*[%％]\\s*[（(]\\s*(${NUMBER})\\s*/\\s*(${NUMBER})\\s*[）)]`, 'g');
  for (const m of t.matchAll(shareClaim)) {
    try {
      const expected = ratioCalc({ numerator: m[2], denominator: m[3], op: '%' }).value;
      if (relativeErrorExceeds(m[1], expected, '0.005')) add('ratio_recompute', '占比计算不一致', m[0], `${expected}%`, 'error', 'R1');
    } catch { /* leave malformed ratios to other rules */ }
  }
  // DT-4: mixed pre/post-discount NAV basis within one paragraph. The brief's
  // heuristic is intentionally conservative in scope, not in wording: two
  // different percentage claims plus both basis terms in one paragraph.
  for (const paragraph of t.split(/\n{2,}/)) {
    if (!/折价前|pre[ -]?discount/i.test(paragraph) || !/折价后|post[ -]?discount/i.test(paragraph)) continue;
    const hits = [...paragraph.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*[%％]/g)];
    const values = new Set(hits.map((m) => m[1].replaceAll(',', '')));
    if (values.size < 2) continue;
    add('mixed_valuation_basis', '同一段混用折价前/折价后 NAV 口径的占比，未分别标注', paragraph.slice(0, 180), '每个占比旁注 valuation_basis（pre_discount/post_discount）', 'warning', 'B4');
  }
  // DT-6: only a caller-provided cellRoles map enables role claims; no guessing.
  const handWritten = /手填|手工输入|手工填入|硬编码|手动录入/.test(t);
  if (handWritten && context.cellRoles && typeof context.cellRoles === 'object') {
    const roles = new Map();
    if (Array.isArray(context.cellRoles)) {
      for (const item of context.cellRoles) {
        if (!item || typeof item !== 'object') continue;
        const key = item.label || item.id || item.ref;
        if (key && item.role) roles.set(String(key), { role: String(item.role), label: item.label });
      }
    } else {
      for (const [key, value] of Object.entries(context.cellRoles)) {
        const role = typeof value === 'string' ? value : value?.role;
        if (key && role) roles.set(key, { role: String(role), label: typeof value === 'object' ? value?.label : null });
      }
    }
    for (const [key, info] of roles) {
      const { role, label } = info;
      if (!['formula', 'linked', 'output'].includes(role)) continue;
      const candidates = [key, label, key.includes('!') ? key.split('!').pop() : null].filter((v) => v && v.length >= 2);
      if (!candidates.some((candidate) => t.includes(candidate))) continue;
      add('role_mismatch', `答称「手填」但 ${key} 的角色是 ${role}`, key, `说明为 ${role === 'formula' ? '公式' : role === 'linked' ? '链接' : '输出'}，或改为对应输入格`, 'warning', 'D6');
    }
  }
  // DT-9: currency display symbols. Only active when the caller knows the report currency.
  const reportCurrency = String(context.reportCurrency || '').toUpperCase();
  if (reportCurrency === 'HKD') {
    const yen = t.match(/[¥￥]\s*\d[\d,.]*/g);
    if (yen?.length) add('currency_symbol', 'HKD 报告使用人民币符号 ¥', yen[0], '使用 HK$', 'warning', 'C9');
  } else if (['RMB', 'CNY'].includes(reportCurrency)) {
    const hkd = t.match(/HK\$\s*\d[\d,.]*/g);
    if (hkd?.length && hkd.length >= 2) add('currency_symbol', 'RMB 报告大量使用 HK$', hkd[0], '确认币种或改用 ¥', 'warning', 'C9');
  }
  // DT-8: opt-in delivery checklist; empty by default, so old behavior is unchanged.
  if (Array.isArray(context.requiredSections) && context.requiredSections.length) {
    const missing = context.requiredSections.filter((section) => !t.toLowerCase().includes(String(section).toLowerCase()));
    if (missing.length) add('missing_section', `缺少必需章节：${missing.join('、')}`, t.slice(0, 120), '补齐必需章节', 'error', 'D8');
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
  // U2: order-of-magnitude gate for equity value / market cap claims. Skip when no cap.
  const capBase = marketCapBase(context);
  if (Number.isFinite(capBase) && capBase !== 0) {
    const claims = [];
    const after = new RegExp(`(${CAP_LABEL})[^。\\n]{0,40}?(${NUMBER})\\s*(${AMOUNT_UNIT})`, 'gi');
    const before = new RegExp(`(${NUMBER})\\s*(${AMOUNT_UNIT})[^。\\n]{0,12}?(${CAP_LABEL})`, 'gi');
    for (const m of t.matchAll(after)) claims.push({ index: m.index, text: m[0], value: m[2], unit: m[3] });
    for (const m of t.matchAll(before)) claims.push({ index: m.index, text: m[0], value: m[1], unit: m[2] });
    const seen = new Set();
    for (const claim of claims) {
      const key = `${claim.index}:${claim.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const claimBase = number(claim.value) * amountFactor(claim.unit);
        if (!Number.isFinite(claimBase) || claimBase === 0) continue;
        const ratio = claimBase / capBase;
        const order = Math.abs(Math.log10(ratio));
        if (Number.isFinite(order) && order >= 1) {
          add('magnitude', `市值量级与可用行情相差约 ${order.toFixed(1)} 个数量级`, claim.text, `≈ ${Number((capBase / 1e8).toFixed(2))} 亿元`, 'warning', 'U2');
        }
      } catch { /* unsupported unit in this claim */ }
    }
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
