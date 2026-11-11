/** Conservative, deterministic checks for clearly bound claims in final answers. */
import { convertExact, formatDecimal, ratioCalc, relativeErrorExceeds, unitInfo } from './calc-tool.mjs';
import { citationLookup } from './citations.mjs';
import { extractLocatorMatches, resolveLocatorToken } from './citation-locator.mjs';
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
const targetNumber = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value.replaceAll(',', '').trim());
    if (Number.isFinite(n)) return n;
  }
  return null;
};
/**
 * Best-effort model target from caller-provided context (valuations, explicit
 * target_price fields, or per-share/output citations). Never reads the answer.
 */
export function contextModelTarget(context) {
  if (!context || typeof context !== 'object') return null;
  for (const key of ['modelTargetPrice', 'targetPrice', 'target_price']) {
    const n = targetNumber(context[key]);
    if (n !== null) return n;
  }
  const lists = [];
  if (Array.isArray(context.valuations)) lists.push(context.valuations);
  if (context.valuation && typeof context.valuation === 'object') lists.push([context.valuation]);
  for (const list of lists) for (const v of list) {
    if (!v || typeof v !== 'object') continue;
    const direct = targetNumber(v.targetPrice ?? v.target_price);
    if (direct !== null) return direct;
    const output = String(v.output || v.value_type || v.valueType || '').toLowerCase();
    if (['target_price', 'per_share_value', 'targetprice', 'target price'].includes(output)) {
      const n = targetNumber(v.value);
      if (n !== null) return n;
    }
  }
  const fromCitations = (list) => {
    for (const c of Array.isArray(list) ? list : []) {
      if (!c || typeof c !== 'object') continue;
      const direct = targetNumber(c.targetPrice ?? c.target_price);
      if (direct !== null) return direct;
      const n = targetNumber(c.value);
      if (n === null) continue;
      const role = String(c.role || c.value_type || '').toLowerCase();
      const unit = String(c.display_unit || c.unit || '');
      const locator = String(c.locator || '');
      if (/target|目标价|估值输出|valuation/.test(role)) return n;
      if (/\/\s*股|per\s*share|每股/i.test(unit)) return n;
      if (/SOTP|DCF|估值|valuation/i.test(locator)) return n;
    }
    return null;
  };
  // Same-session citations are only a fallback for target detection; they never
  // relax current-turn locator verification.
  return fromCitations(context.citations) ?? fromCitations(context.priorCitations);
}
const BROKER_LABEL = /(?:券商|卖方|市场共识|一致预期|consensus|broker|彭博|Bloomberg|Wind)/i;
function numbersIn(text) {
  return [...String(text).matchAll(new RegExp(NUMBER, 'g'))].map((m) => number(m[0]));
}
function hasModelPrice(text, context) {
  const explicit = new RegExp(`(?:模型目标价|模型价|模型估值|估值目标|合理价值|SOTP\\s*目标价|DCF\\s*目标价|target\\s*price)[^。\\n]{0,24}?(${NUMBER})`, 'gi');
  if ([...text.matchAll(explicit)].some((m) => number(m[1]) > 0 && !/单元格|G\d/i.test(m[0]))) return true;
  const target = new RegExp(`目标价[^。\\n]{0,16}?(${NUMBER})`, 'gi');
  for (const m of text.matchAll(target)) {
    if (number(m[1]) <= 0) continue;
    if (/单元格|G\d/i.test(m[0])) continue; // never read a gap id such as G1 as a price
    const before = text.slice(Math.max(0, m.index - 18), m.index);
    if (BROKER_LABEL.test(before)) continue; // broker target is appendix, not the model price
    return true;
  }
  const known = contextModelTarget(context);
  if (known !== null) return numbersIn(text).some((n) => Math.abs(n - known) <= Math.max(1e-9, Math.abs(known) * 1e-9));
  return false;
}
function hasLivePrice(text, context) {
  const live = new RegExp(`(?:现价|当前价|最新价|市价|股价|收盘价|报价|current\\s*price|market\\s*price)[^。\\n]{0,24}?(${NUMBER})`, 'gi');
  if ([...text.matchAll(live)].some((m) => number(m[1]) > 0)) return true;
  const reverse = new RegExp(`(${NUMBER})\\s*(?:港元|港币|元|HKD|HK\\$|美元|USD)?[^。\\n]{0,10}?(?:现价|当前价|最新价|市价|股价)`, 'gi');
  if ([...text.matchAll(reverse)].some((m) => number(m[1]) > 0)) return true;
  if (/(?:现价|当前价|最新价|行情|股价|报价)[^。\n]{0,10}(?:未获取|未取得|获取失败|不可用|缺失|未更新)/.test(text)) return true;
  if (/(?:未获取|未取得|获取失败|不可用|缺失)[^。\n]{0,10}(?:现价|当前价|最新价|行情|股价|报价)/.test(text)) return true;
  const known = targetNumber(context?.price ?? context?.marketPrice ?? context?.market?.price);
  return known !== null && numbersIn(text).some((n) => Math.abs(n - known) <= Math.max(1e-9, Math.abs(known) * 1e-9));
}
function selfLabelsDeviation(text) {
  return /^#{1,6}[^\n]*(?:偏离|目标价[^\n]{0,8}(?:现价|股价)|(?:现价|股价)[^\n]{0,8}目标价)/m.test(text)
    || /(?:模型目标价|模型价|目标价)[^。\n]{0,16}(?:较|与|vs\.?|相对|对比)[^。\n]{0,12}(?:现价|股价|市价)[^。\n]{0,8}(?:偏离|高|低|空间)/i.test(text)
    || /(?:现价|股价)[^。\n]{0,16}(?:偏离|高于|低于)[^。\n]{0,8}(?:目标价|模型价)/i.test(text);
}
export function asksDeviationQuestion(question) {
  const q = String(question || '');
  const prices = /(?:目标价|模型价|现价|股价|估值|上行空间|upside)/i.test(q);
  const deviation = /(?:偏离|差距|空间|为什么.*(?:高|低)|为何.*(?:高|低))/i.test(q);
  return (prices && deviation) || /目标价[^。\n]{0,20}(?:现价|股价)|(?:现价|股价)[^。\n]{0,20}目标价/.test(q);
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
  // CELL-CITE L2: a locator in the answer is only allowed to stay unmarked
  // when this turn's tools returned the same citation. Soft warning; the
  // post-answer loop can ask for one bounded correction without touching numbers.
  if (Array.isArray(context.citations)) {
    const lookup = citationLookup(context.citations);
    const reported = new Set();
    for (const match of extractLocatorMatches(t)) {
      const resolved = resolveLocatorToken(match.raw, lookup);
      if (!resolved) continue;
      const key = resolved.locator.toLowerCase();
      if (lookup.has(key)) continue;
      if (reported.has(key)) continue;
      // Explicitly marking a reference as unverified is the escape hatch.
      const nearby = t.slice(Math.max(0, match.index - 20), match.index + match.raw.length + 20);
      if (/未核验|未验证|unverified/i.test(nearby)) continue;
      reported.add(key);
      add(
        'unverified_locator',
        '答文中的单元格引用没有本轮工具 citations 支撑',
        resolved.raw,
        '仅引用本轮工具返回的 citation；否则标注“未核验”或删除坐标',
        'warning',
        'L2',
      );
    }
  }
  // G1-G3: gap IDs are not cells; target/deviation answers must carry the
  // model price and live price. Conservative: status tables saying
  // "gaps: G1 tool open" stay clean because they never say 单元格.
  const gapCell = /(?:目标价)?单元格\s*[（(]\s*(G\d+(?:\s*[、,，/]\s*G\d+)*)\s*[）)]/gi;
  for (const m of t.matchAll(gapCell)) {
    add('gap_id_as_cell', `缺口 ID ${m[1]} 被写成单元格`, m[0], 'G* 是 gaps[].id 缺口编号；引用单元格请写 sheet!cell', 'error', 'G1');
  }
  const bareGapCell = /(?:目标价)?单元格\s*(G\d+)(?![\d.])/gi;
  for (const m of t.matchAll(bareGapCell)) {
    add('gap_id_as_cell', `缺口 ID ${m[1]} 被写成单元格`, m[0], 'G* 是 gaps[].id 缺口编号；引用单元格请写 sheet!cell', 'error', 'G1');
  }
  const noTarget = /(?:并?没有|并无|不存在|未(?:设置|给出|包含|提供)|找不到)\s*(?:独立的?|单独的?)?(?:模型)?目标价(?!单元格|变化|调整|上调|下调|变动)/g;
  if (noTarget.test(t)) {
    const severity = contextModelTarget(context) !== null ? 'error' : 'warning';
    add('target_missing_claim', '答文断言模型没有目标价', (t.match(noTarget) || [''])[0], '先查 valuations 的 target_price / workbook_trace 估值输出格；语义 miss ≠ 不存在', severity, 'G2');
  }
  const cannotAnswer = /无法(?:精确|准确|直接|完整)?\s*(?:回答|判断|给出|计算)[^。\n]{0,60}?(?:目标价|偏离|上行空间|空间)/g;
  if (cannotAnswer.test(t)) {
    const severity = contextModelTarget(context) !== null ? 'error' : 'warning';
    add('target_missing_claim', '答文用“无法回答”挡掉目标价/偏离问题', (t.match(cannotAnswer) || [''])[0], '首句直接给模型目标价、现价与空间；读失败写 unverified + gap', severity, 'G2');
  }
  if ((context.userAsksDeviation === true || selfLabelsDeviation(t)) && !(hasModelPrice(t, context) && hasLivePrice(t, context))) {
    add('deviation_no_model_price', '偏离问题未同时给出可解析的模型目标价与现价/“未获取”', t.slice(0, 180), '首句写“模型目标价 <值> vs 现价 <值>，空间 ≈ X%”；行情失败写“未获取”', 'warning', 'G3');
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
import { isFactExpired } from './fact-register.mjs';
const MONEY_CLAIM = new RegExp(`(${NUMBER})\\s*(${AMOUNT_UNIT}|[%％])`, 'g');
export function lintLedgerAnswer(answer, ledger, context = {}) {
  const text=String(answer||'');
  const findings=correctedValues(ledger).flatMap(c => correctionMatches(answer,c).map(m => ({
    rule:'repeats_corrected_value',severity:'error',message:'重复已更正的旧值',
    excerpt:String(answer).slice(Math.max(0,m.start-40),m.end+40),
    expected:`${c.claim} 当前值 ${c.to} ${c.unit}`,
  })));
  const facts=Array.isArray(ledger?.facts)?ledger.facts:[];
  const sources=[...facts.filter(f=>f&&(f.status==null||['current','conflict'].includes(f.status))).map(f=>({value:f.value,unit:f.unit||f.binding?.unit||f.binding?.currency||'',fact:f})),...correctedValues(ledger).map(c=>({value:c.to,unit:c.unit,correction:c})),...(context.citations||[]).filter(c=>c?.value!=null).map(c=>({value:c.value,unit:c.display_unit||'',citation:c}))];
  const equivalent=(a,b)=>{const x=Number(String(a).replaceAll(',','')),y=Number(String(b).replaceAll(',',''));return Number.isFinite(x)&&Number.isFinite(y)?Math.abs(x-y)<=Math.max(1e-8,Math.abs(y)*1e-9):String(a)===String(b);};
  for(const m of text.matchAll(MONEY_CLAIM)) {
    const val=m[1], unit=m[2];
    if(/^20\d{2}$/.test(val)||/^G\d$/i.test(val)) continue;
    const start=m.index, sentence=text.slice(Math.max(0,text.lastIndexOf('。',start)+1),(()=>{const n=text.indexOf('。',start);return n<0?text.length:n;})());
    if(/未核验|未验证|可能|例如|比如|假设|若|如果/.test(sentence)) continue;
    if(!sources.some(s=>equivalent(s.value,val)&&(!s.unit||normLintUnit(s.unit)===normLintUnit(unit)))) findings.push({rule:'unsourced_number',severity:'error',message:'主张数字没有完整登记或本轮结构化出处',excerpt:m[0],expected:'核验来源；否则删除数字或明确标注未核验'});
  }
  const locatorFindings=(context.locatorFindings||[]).filter(f=>f.rule==='unverified_locator');
  if(locatorFindings.length) for(const f of locatorFindings) {
    const at=text.indexOf(f.excerpt); if(at<0) continue;
    const sentence=text.slice(Math.max(0,text.lastIndexOf('。',at)+1),(()=>{const n=text.indexOf('。',at);return n<0?text.length:n;})());
    const numberMatches=[...sentence.matchAll(MONEY_CLAIM)];
    const orphan=numberMatches.find(m=>!sources.some(s=>equivalent(s.value,m[1])&&(!s.unit||normLintUnit(s.unit)===normLintUnit(m[2]))));
    if(orphan) findings.push({rule:'orphaned_number',severity:'error',message:'无效出处被删除后该数字会失去唯一依据',excerpt:orphan[0],expected:'同时删除或更正数字，或标注未核验'});
  }
  const live=/现价|当前价|最新价|最新|现在|市价|current\s*price|market\s*price/i.test(text);
  if(live) {
    const liveCall=(context.toolCalls||[]).some(c=>c.name==='westock_query'&&c.success===true&&(c.details?.quotes||c.result?.details?.quotes||[]).length>0);
    for(const m of text.matchAll(new RegExp(`(?:现价|当前价|最新价|市价|股价)[^。\\n]{0,20}?(${NUMBER})|(${NUMBER})\\s*(?:元|港元|美元)?[^。\\n]{0,12}?(?:现价|当前价|最新价|市价)`, 'gi'))) {
      const value=m[1]||m[2];
      const price=facts.find(f=>f?.source==='westock'&&equivalent(f.value,value));
      if(price&&(isFactExpired(price,context.now||new Date())||(/现在|最新/.test(context.question||'')&&!liveCall))) findings.push({rule:'stale_price',severity:'error',message:'跨日或非本轮行情不能作为现价/最新价',excerpt:m[0],expected:'本轮成功调用 westock_query，或标明未获取'});
    }
  }
  return findings;
}
const normLintUnit=value=>String(value||'').toLowerCase().replace(/人民币|rmb|cny/g,'元').replace(/港币|hkd/g,'港元').replace(/美元|usd/g,'美元').replace(/\s+/g,'');
