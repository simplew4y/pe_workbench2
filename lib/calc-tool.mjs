/** Deterministic arithmetic. Irrational functions use fixed-point BigInt approximations. */
import { Type } from "typebox";
import { CITATION_INPUT_SCHEMA } from "./contracts/citation.mjs";
import { derivedCitation, normalizeCitationInput } from "./citations.mjs";

const abs = (n) => n < 0n ? -n : n;
function gcd(a, b) { while (b) [a, b] = [b, a % b]; return abs(a); }
const MAX_BITS = 32768;
const bitLength = (n) => abs(n).toString(2).length;
function checkSize(n, d) {
  if (bitLength(n) > MAX_BITS || bitLength(d) > MAX_BITS) throw new Error("数值大小超出上限");
}
function fraction(n, d = 1n) {
  checkSize(n, d);
  if (!d) throw new Error("不能除以零");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
function decimal(text) {
  const match = String(text).match(/^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/);
  if (!match || !(match[2] || match[3])) throw new Error("无效十进制数");
  const scale = (match[3]?.length || 0) - Number(match[4] || 0);
  if (Math.abs(scale) > 1000) throw new Error("数值精度超出上限");
  const n = BigInt((match[1] || "") + ((match[2] || "0") + (match[3] || "")));
  return scale >= 0 ? fraction(n, 10n ** BigInt(scale)) : fraction(n * 10n ** BigInt(-scale));
}
const add = (a, b) => fraction(a.n * b.d + b.n * a.d, a.d * b.d);
const mul = (a, b) => fraction(a.n * b.n, a.d * b.d);
const div = (a, b) => fraction(a.n * b.d, a.d * b.n);
const neg = (a) => fraction(-a.n, a.d);
const compare = (a, b) => a.n * b.d - b.n * a.d;
function integer(a) {
  if (a.d !== 1n || abs(a.n) > 1000n) throw new Error("整数参数必须在 -1000 到 1000 之间");
  return Number(a.n);
}
function rounded(a, digits, mode = "ROUND") {
  const k = 10n ** BigInt(Math.abs(digits));
  const scaled = digits >= 0 ? mul(a, fraction(k)) : div(a, fraction(k));
  let q = abs(scaled.n) / scaled.d;
  const r = abs(scaled.n) % scaled.d;
  if ((mode === "ROUNDUP" && r) || (mode === "ROUND" && 2n * r >= scaled.d)) q++;
  if (scaled.n < 0n) q = -q;
  return digits >= 0 ? fraction(q, k) : fraction(q * k);
}
function format(a, precision) {
  let digits = precision;
  if (digits === undefined) {
    let d = a.d, twos = 0, fives = 0;
    while (d % 2n === 0n) { d /= 2n; twos++; }
    while (d % 5n === 0n) { d /= 5n; fives++; }
    digits = d === 1n ? Math.min(100, Math.max(twos, fives)) : 12;
  }
  if (!Number.isInteger(digits) || digits < 0 || digits > 100) throw new Error("precision 必须是 0 到 100 的整数");
  const value = rounded(a, digits);
  const magnitude = abs(value.n) * 10n ** BigInt(digits) / value.d;
  const raw = magnitude.toString().padStart(digits + 1, "0");
  let result = (value.n < 0n ? "-" : "") + (digits ? `${raw.slice(0, -digits)}.${raw.slice(-digits)}` : raw);
  if (precision === undefined && result.includes(".")) result = result.replace(/0+$/, "").replace(/\.$/, "");
  return result;
}

// Guard digits for the public display precision of up to 100 decimal places.
const FUNCTION_SCALE = 10n ** 112n;

function integerSquareRoot(n) {
  if (n < 2n) return n;
  let root = 1n << BigInt(Math.ceil(bitLength(n) / 2));
  let next = (root + n / root) / 2n;
  while (next < root) {
    root = next;
    next = (root + n / root) / 2n;
  }
  return root;
}

function squareRoot({ n, d }) {
  if (n < 0n) throw new Error("SQRT 参数不能为负数");
  const top = integerSquareRoot(n), bottom = integerSquareRoot(d);
  if (top * top === n && bottom * bottom === d) return fraction(top, bottom);
  return fraction(integerSquareRoot(n * FUNCTION_SCALE ** 2n / d), FUNCTION_SCALE);
}

// ln(n/d) = 2 * atanh((n-d)/(n+d)); the input ratio here is between 1 and 2.
function logSeries(n, d) {
  const z = (n - d) * FUNCTION_SCALE / (n + d);
  const squared = z * z / FUNCTION_SCALE;
  let power = z, sum = z;
  for (let term = 3n; power; term += 2n) {
    power = power * squared / FUNCTION_SCALE;
    sum += power / term;
  }
  return 2n * sum;
}

const LOG_TWO = logSeries(2n, 1n);
function naturalLog({ n, d }) {
  if (n <= 0n) throw new Error("LN 参数必须大于零");
  let shift = bitLength(n) - bitLength(d);
  if (shift >= 0) d <<= BigInt(shift);
  else n <<= BigInt(-shift);
  if (n < d) { n *= 2n; shift--; }
  return fraction(logSeries(n, d) + BigInt(shift) * LOG_TWO, FUNCTION_SCALE);
}

// Invisible typesetting controls copied from PDF/HTML text (soft hyphen,
// zero-width spaces/joiners, word joiner, BOM) and the typographic minus sign.
// Anything else stays visible so an unknown character is still rejected.
const TYPESETTING_CONTROLS = new Map([
  ["\u00AD", ""], ["\u200B", ""], ["\u200C", ""], ["\u200D", ""], ["\u2060", ""], ["\uFEFF", ""], ["\u2212", "-"],
]);
/** Conservative normalization; returns the exact characters changed for the receipt. */
export function normalizeExpressionText(expression) {
  const text = String(expression ?? "");
  let normalized = "";
  const changed = new Map();
  for (const char of text) {
    const replacement = TYPESETTING_CONTROLS.get(char);
    if (replacement === undefined) { normalized += char; continue; }
    normalized += replacement;
    const code = "U+" + char.codePointAt(0).toString(16).toUpperCase().padStart(4, "0");
    changed.set(code, (changed.get(code) || 0) + 1);
  }
  return { expression: normalized, changed: [...changed].map(([code, count]) => ({ code, count })) };
}

// Rational exponent p/q with q <= MAX_ROOT_DEGREE. Larger denominators (for
// example a long decimal exponent) are rejected instead of silently rounded.
const MAX_ROOT_DEGREE = 12n;
function integerRoot(n, k) {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(bitLength(n) / Number(k)) + 1);
  for (;;) {
    const next = ((k - 1n) * x + n / x ** (k - 1n)) / k;
    if (next >= x) break;
    x = next;
  }
  while (x ** k > n) x--;
  while ((x + 1n) ** k <= n) x++;
  return x;
}
function nthRoot({ n, d }, k) {
  if (n < 0n && k % 2n === 0n) throw new Error("偶数次方根的参数不能为负数");
  const sign = n < 0n ? -1n : 1n;
  const top = integerRoot(abs(n), k), bottom = integerRoot(d, k);
  if (top ** k === abs(n) && bottom ** k === d) return fraction(sign * top, bottom);
  return fraction(sign * integerRoot(abs(n) * FUNCTION_SCALE ** k / d, k), FUNCTION_SCALE);
}
function integerPower(base, exponent) {
  const magnitude = Math.max(bitLength(base.n), bitLength(base.d));
  // Check before exponentiation: nested powers must never allocate huge integers.
  if (Math.abs(exponent) * magnitude > MAX_BITS) throw new Error("数值大小超出上限");
  return exponent >= 0 ? fraction(base.n ** BigInt(exponent), base.d ** BigInt(exponent)) : fraction(base.d ** BigInt(-exponent), base.n ** BigInt(-exponent));
}

export function evaluateExpression(expression) {
  if (typeof expression !== "string" || !expression.trim() || expression.length > 10000) throw new Error("expression 必须是非空算式（最多 10000 字符）");
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?|[A-Za-z_]+|[+\-*/^%(),]|\S/g) || [];
  if (tokens.length > 2000) throw new Error("算式过长");
  let i = 0, nesting = 0;
  const take = (token) => tokens[i] === token && (++i, true);
  function primary() {
    if (++nesting > 100) throw new Error("括号嵌套过深");
    let result;
    if (take("(")) { result = sum(); if (!take(")")) throw new Error("缺少右括号"); }
    else if (/^[A-Za-z_]+$/.test(tokens[i] || "")) {
      const name = tokens[i++].toUpperCase();
      if (!take("(")) throw new Error("函数缺少括号");
      const args = [];
      if (!take(")")) {
        do { args.push(sum()); } while (take(","));
        if (!take(")")) throw new Error("函数缺少右括号");
      }
      if (["ROUND", "ROUNDUP", "ROUNDDOWN"].includes(name)) {
        if (args.length !== 2) throw new Error(`${name} 需要两个参数`);
        result = rounded(args[0], integer(args[1]), name);
      } else if (name === "ABS" && args.length === 1) result = fraction(abs(args[0].n), args[0].d);
      else if (name === "LN" && args.length === 1) result = naturalLog(args[0]);
      else if (name === "SQRT" && args.length === 1) result = squareRoot(args[0]);
      else if (name === "SUM") result = args.reduce(add, fraction(0n));
      else if (["MIN", "MAX"].includes(name) && args.length) result = args.reduce((a, b) => (compare(a, b) < 0n) === (name === "MIN") ? a : b);
      else throw new Error(`不支持的函数或参数：${name}`);
    } else {
      const token = tokens[i++];
      if (!/^(?:\d|\.)/.test(token || "")) throw new Error(`无效算式符号：${token || "结尾"}`);
      result = decimal(token);
    }
    nesting--;
    while (take("%")) result = div(result, fraction(100n));
    return result;
  }
  function power() {
    let result = primary();
    if (take("^")) {
      const exponentValue = unary();
      if (exponentValue.d === 2n && exponentValue.n === 1n) return squareRoot(result);
      if (exponentValue.d === 1n) return integerPower(result, integer(exponentValue));
      // Rational exponent p/q (CAGR such as ^(1/4) or ^0.25): q-th root, then
      // an integer power. Bounded degree keeps the cost and error explicit.
      if (exponentValue.d > MAX_ROOT_DEGREE) throw new Error(`分数幂的分母须不超过 ${MAX_ROOT_DEGREE}（如 ^(1/4)、^0.25）`);
      const numerator = integer(fraction(exponentValue.n));
      result = rounded(integerPower(nthRoot(result, exponentValue.d), numerator), 100);
    }
    return result;
  }
  function unary() { if (take("+")) return unary(); if (take("-")) return neg(unary()); return power(); }
  function product() { let a = unary(); while (tokens[i] === "*" || tokens[i] === "/") { const op = tokens[i++]; const b = unary(); a = op === "*" ? mul(a, b) : div(a, b); } return a; }
  function sum() { let a = product(); while (tokens[i] === "+" || tokens[i] === "-") { const op = tokens[i++]; const b = product(); a = add(a, op === "+" ? b : neg(b)); } return a; }
  const result = sum();
  if (i !== tokens.length) throw new Error(`多余算式符号：${tokens[i]}`);
  return result;
}

const amountUnits = { "元": 1n, "千元": 1000n, "万元": 10000n, "百万元": 1000000n, "亿元": 100000000n, "十亿": 1000000000n, "万亿元": 1000000000000n };
const UNIT_ALIASES = new Map([
  ["元", "元"], ["千元", "千元"], ["万元", "万元"], ["百万元", "百万元"], ["百万", "百万元"],
  ["亿元", "亿元"], ["亿", "亿元"], ["十亿元", "十亿"], ["十亿", "十亿"], ["万亿元", "万亿元"], ["万亿", "万亿元"],
  ["rmb mn", "百万元"], ["rmb million", "百万元"], ["rmb mm", "百万元"], ["rmb m", "百万元"],
  ["hkd mn", "百万元"], ["hkd million", "百万元"], ["hkd mm", "百万元"], ["hkd m", "百万元"],
  ["usd mn", "百万元"], ["usd million", "百万元"], ["usd mm", "百万元"], ["usd m", "百万元"],
  ["mn", "百万元"], ["million", "百万元"], ["mm", "百万元"],
  ["%", "%"], ["percent", "%"], ["pct", "%"], ["decimal", "decimal"], ["小数", "decimal"],
]);
export function unitInfo(unit) {
  const raw = String(unit ?? "").trim();
  if (!raw) throw new Error("单位不能为空");
  const key = raw.toLowerCase().replace(/\s+/g, " ");
  const aliasKey=key.replace(/^cny(?=\s|$)/,"rmb");
  const canonical = UNIT_ALIASES.get(aliasKey) || UNIT_ALIASES.get(aliasKey.replace(/\s+/g, ""));
  if (!canonical) throw new Error(`不支持的单位：${raw}`);
  const ratio = canonical === "%" || canonical === "decimal";
  const currency = /^(rmb|cny|hkd|usd)(?:\s|$)/i.test(key) ? key.split(/\s/)[0].toUpperCase().replace("CNY","RMB") : null;
  return {
    requested: raw,
    canonical,
    kind: ratio ? "ratio" : "amount",
    factor: ratio ? (canonical === "%" ? fraction(1n, 100n) : fraction(1n)) : fraction(amountUnits[canonical]),
    currency,
  };
}
export function calculate(params = {}) {
  const { expression, precision, fromUnit, toUnit, currency, toCurrency, rate, name } = params;
  let result = evaluateExpression(expression);
  const chain = [`${expression} = ${format(result)}`];
  let fromInfo = null, toInfo = null;
  if (fromUnit || toUnit) {
    fromInfo = unitInfo(fromUnit || toUnit);
    toInfo = unitInfo(toUnit || fromUnit);
    if (fromInfo.kind !== toInfo.kind) throw new Error("不兼容的单位类型：金额单位不能与百分比/小数互换");
    const before = format(result);
    result = mul(result, div(fromInfo.factor, toInfo.factor));
    chain.push(`${before} ${fromInfo.requested} × ${format(fromInfo.factor)}/${format(toInfo.factor)} = ${format(result, precision)} ${toInfo.canonical}`);
  }
  const inferredSource = fromInfo?.currency || null;
  const inferredTarget = toInfo?.currency || null;
  const sourceCurrency = (currency === "CNY" ? "RMB" : currency) || inferredSource || null;
  const targetCurrency = (toCurrency === "CNY" ? "RMB" : toCurrency) || (inferredTarget && inferredTarget !== sourceCurrency ? inferredTarget : null) || null;
  for (const label of [sourceCurrency, targetCurrency]) if (label && !["HKD", "RMB", "USD"].includes(label)) throw new Error("币种仅支持 HKD/CNY/RMB/USD 标签");
  if (targetCurrency && sourceCurrency !== targetCurrency) {
    if (!sourceCurrency || rate === undefined) throw new Error("跨币种换算必须提供原币种及显式汇率 rate");
    const fx = decimal(rate);
    if (fx.n <= 0n) throw new Error("汇率必须大于零");
    result = mul(result, fx);
    chain.push(`按显式汇率 1 ${sourceCurrency} = ${rate} ${targetCurrency}，结果 ${format(result, precision)} ${targetCurrency}`);
  }
  return { ...(name ? { name } : {}), expression, value: format(result, precision), unit: toInfo?.canonical || fromInfo?.canonical || null, currency: targetCurrency || sourceCurrency || null, conversionChain: chain.join(" → ") };
}

/** Exact decimal conversion used by tools and answer lint. */
export function convertExact(value, fromUnit, toUnit) {
  const from = unitInfo(fromUnit), to = unitInfo(toUnit);
  if (from.kind !== to.kind) throw new Error("不兼容的单位类型：金额单位不能与百分比/小数互换");
  const input = decimal(String(value ?? "").replaceAll(",", "").trim());
  return mul(input, div(from.factor, to.factor));
}
export function formatDecimal(value, precision) { return format(value, precision); }
/** True when |actual-expected| / |expected| is strictly greater than threshold. Decimal only. */
export function relativeErrorExceeds(actual, expected, threshold = "0.005") {
  const a = decimal(String(actual ?? "").replaceAll(",", "").trim());
  const e = decimal(String(expected ?? "").replaceAll(",", "").trim());
  const t = decimal(String(threshold));
  if (t.n <= 0n) throw new Error("阈值必须大于零");
  if (e.n === 0n) return a.n !== 0n;
  const diff = abs(a.n * e.d - e.n * a.d);
  return diff * t.d > abs(e.n) * a.d * t.n;
}
export function unitConvert(params = {}) {
  const fromUnit = params.from_unit ?? params.fromUnit;
  const toUnit = params.to_unit ?? params.toUnit;
  const expression = normalizeExpressionText(params.expression != null ? String(params.expression) : String(params.value ?? "").replaceAll(",", "").trim()).expression;
  if (!expression) throw new Error("value 或 expression 必须提供");
  const from = unitInfo(fromUnit), to = unitInfo(toUnit);
  if (from.kind !== to.kind) throw new Error("不兼容的单位类型：金额单位不能与百分比/小数互换");
  if (from.currency && to.currency && from.currency !== to.currency) throw new Error("跨币种换算必须使用 calc 的显式汇率，unit_convert 只换单位");
  const explicitCurrency = params.currency ? String(params.currency).toUpperCase().replace(/^CNY$/, 'RMB') : null;
  if (explicitCurrency && !["HKD", "RMB", "USD"].includes(explicitCurrency)) throw new Error("币种仅支持 HKD/CNY/RMB/USD 标签");
  if (explicitCurrency && from.currency && explicitCurrency !== from.currency) throw new Error("currency 与 from_unit 的币种不一致");
  const input = evaluateExpression(expression);
  const before = format(input);
  const result = mul(input, div(from.factor, to.factor));
  const value = format(result, params.precision);
  const currency = explicitCurrency || from.currency || to.currency || null;
  const conversionChain = `${expression} ${from.requested} → ${before} ${from.canonical} × (${format(from.factor)} / ${format(to.factor)}) = ${value} ${to.canonical}${currency ? ` ${currency}` : ""}`;
  return { value, inputValue: before, unit: to.canonical, currency, fromUnit: from.canonical, toUnit: to.canonical, conversionChain };
}
const RATIO_OPS = new Set(["/", "/-1", "%"]);
const VALUATION_BASIS = new Set(["pre_discount", "post_discount", "other"]);
const CITATION_INPUTS = Type.Optional(Type.Array(CITATION_INPUT_SCHEMA, {
  maxItems: 20,
  description: "上游单元格 citations（来自 workbook_query/workbook_trace）；结果会写入 derivedFrom，不得凭空编造 locator",
}));
const decimalArg = (value, field) => {
  const text = String(value ?? "").replaceAll(",", "").trim();
  if (!text) throw new Error(`${field} 必须是非空数值`);
  return decimal(text);
};

/**
 * Deterministic ratio / percent-change contract.
 * op: "/" (plain ratio), "/-1" (relative change), "%" (share, numerator/denominator*100).
 * All arithmetic stays in BigInt fractions; only display uses format().
 */
export function ratioCalc(params = {}) {
  const op = params.op || "/";
  if (!RATIO_OPS.has(op)) throw new Error("op 必须是 /、/-1 或 %");
  const numerator = decimalArg(params.numerator, "numerator");
  const denominator = decimalArg(params.denominator, "denominator");
  if (denominator.n === 0n) throw new Error("不能除以零");
  const raw = div(numerator, denominator);
  const asPercent = Boolean(params.asPercent) || op === "%";
  let result;
  let body;
  if (op === "/") {
    result = asPercent ? mul(raw, fraction(100n)) : raw;
    body = `${format(numerator)} / ${format(denominator)}`;
  } else if (op === "/-1") {
    const delta = add(raw, fraction(-1n));
    result = asPercent ? mul(delta, fraction(100n)) : delta;
    body = asPercent ? `(${format(numerator)} / ${format(denominator)} - 1) * 100` : `${format(numerator)} / ${format(denominator)} - 1`;
  } else {
    result = mul(raw, fraction(100n));
    body = `${format(numerator)} / ${format(denominator)} * 100`;
  }
  const value = format(result, params.precision);
  return {
    value,
    formula: `${body} = ${value}`,
    op,
    numerator: format(numerator),
    denominator: format(denominator),
    ...(asPercent ? { asPercent: true } : {}),
  };
}

/** Share of NAV with a mandatory, explicit valuation basis (DT-4). */
export function shareOfNav(params = {}) {
  const basis = params.valuation_basis;
  if (!basis) throw new Error("valuation_basis 必填：pre_discount / post_discount / other");
  if (!VALUATION_BASIS.has(basis)) throw new Error("valuation_basis 必须是 pre_discount / post_discount / other");
  const nav = params.nav ?? params.denominator;
  const ratio = ratioCalc({ numerator: params.numerator, denominator: nav, op: "%", precision: params.precision });
  return {
    value: ratio.value,
    formula: ratio.formula,
    valuation_basis: basis,
    numerator: ratio.numerator,
    nav: ratio.denominator,
  };
}

export function createRatioTool() {
  return {
    name: "ratio", label: "确定性比率",
    description: "精确计算占比、倍数、百分比变化（op=/, /-1, %）；占 NAV 时必须声明 valuation_basis（pre_discount/post_discount/other）。",
    promptSnippet: "ratio：确定性比率、占比、百分比变化（禁止心算）",
    promptGuidelines: [
      "报告占比/增速/倍数前必须调用 ratio（可直接用 calc 的单位换算），不得心算。",
      "以 NAV 为分母的占比必须传 valuation_basis，并在回答旁注口径。",
      "若分子/分母来自工作簿单元格，把 workbook_query/workbook_trace 返回的 citation 放进 citations；这样结果才有 derivedFrom 和可点出处。",
    ],
    parameters: Type.Object({
      numerator: Type.Union([Type.String(), Type.Number()], { description: "分子" }),
      denominator: Type.Union([Type.String(), Type.Number()], { description: "分母；占 NAV 时传 NAV" }),
      op: Type.Optional(Type.String({ enum: ["/", "/-1", "%"], description: "'/' 比率，'/-1' 相对变化，'%' 占比*100" })),
      asPercent: Type.Optional(Type.Boolean({ description: "以百分数返回（/-1 时尤为有用）" })),
      precision: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      valuation_basis: Type.Optional(Type.String({ enum: ["pre_discount", "post_discount", "other"], description: "NAV 口径；占比分母为 NAV 时必填" })),
      citations: CITATION_INPUTS,
      name: Type.Optional(Type.String()),
    }),
    execute: async (_id, params = {}) => {
      try {
        if (params.valuation_basis) {
          const result = shareOfNav({ numerator: params.numerator, nav: params.denominator, valuation_basis: params.valuation_basis, precision: params.precision });
          const citations = derivedCitation(result, params.citations, { toolCallId: _id, role: "derived_ratio" });
          return {
            content: [{ type: "text", text: `${params.name ? `${params.name}：` : ""}${result.value}%（NAV 口径：${result.valuation_basis}）\n公式：${result.formula}` }],
            details: { ...result, name: params.name || null, citations },
          };
        }
        const result = ratioCalc(params);
        const suffix = result.asPercent || result.op === "%" ? "%" : "";
        const citations = derivedCitation(result, params.citations, { toolCallId: _id, role: "derived_ratio" });
        return {
          content: [{ type: "text", text: `${params.name ? `${params.name}：` : ""}${result.value}${suffix}\n公式：${result.formula}` }],
          details: { ...result, name: params.name || null, citations },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `ratio 失败：${error.message}` }], details: { error: error.message, citations: [] }, isError: true };
      }
    },
  };
}

export function createUnitConvertTool() {
  return {
    name: "unit_convert", label: "确定性单位换算",
    description: "精确单位换算（金额：元/千元/万元/百万元/亿元/十亿，别名 Rmb mn/RMB mn/mn/HKD mn；百分比与小数）。始终返回换算链。",
    promptSnippet: "unit_convert：金额单位与百分比/小数换算，返回换算链",
    promptGuidelines: ["把百万元/Rmb mn 换算成亿元时，必须先调用 unit_convert，禁止心算除以 100/1000。", "若原值来自工作簿单元格，把该单元格 citation 放进 citations，结果会带 derivedFrom；不要手写未核验的 locator。"],
    parameters: Type.Object({
      value: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "待换算数值；与 expression 二选一" })),
      expression: Type.Optional(Type.String({ description: "待换算算式；与 value 二选一" })),
      from_unit: Type.String({ description: "例如 Rmb mn、HKD mn、百万元、亿元、元、%、decimal" }),
      to_unit: Type.String({ description: "例如 亿元、百万元、%、decimal" }),
      currency: Type.Optional(Type.String({ description: "HKD/RMB/USD 标签；别名已带币种时可省略" })),
      precision: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
      citations: CITATION_INPUTS,
    }),
    execute: async (_id, params = {}) => {
      try {
        const result = unitConvert(params);
        const citations = derivedCitation(result, params.citations, { toolCallId: _id, role: "derived_unit" });
        return { content: [{ type: "text", text: `${result.value} ${result.unit}${result.currency ? ` ${result.currency}` : ""}\n换算链：${result.conversionChain}` }], details: { ...result, citations } };
      } catch (error) { return { content: [{ type: "text", text: `unit_convert 失败：${error.message}` }], details: { error: error.message, citations: [] }, isError: true }; }
    },
  };
}

const fields = {
  expression: Type.String({ description: "算式。支持整数幂、分母不超过12的分数幂（^(1/4)、^0.25，用于CAGR）、平方根（SQRT 或 ^0.5）、自然对数 LN、百分数及 Excel ROUND/ROUNDUP/ROUNDDOWN/ABS/MIN/MAX/SUM" }),
  name: Type.Optional(Type.String()),
  bindings: Type.Optional(Type.Record(Type.String(), Type.Object({...CITATION_INPUT_SCHEMA.properties,unit:Type.Optional(Type.String())}), { description: "输入变量到来源的映射。只需materialId和locator（可选version）；由工具读取精确值，提供的value不会覆盖原值。表达式用变量名，如revenue*margin" })),
  outputUnit: Type.Optional(Type.String({ description: "算式最终结果的单位标签，如元/股、%、倍。仅标签，不执行换算；换算须用fromUnit/toUnit" })),
  ratioEncoding: Type.Optional(Type.Union([Type.Literal('fraction'), Type.Literal('percentage_points')], {description:'最终数值的比例编码：fraction 对应 decimal，percentage_points 对应 %。仅校验，不自动乘除100；换算用 fromUnit/toUnit。'})),
  precision: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  fromUnit: Type.Optional(Type.String({ description: "元/千元/万元/百万元/亿元/十亿" })),
  toUnit: Type.Optional(Type.String()),
  currency: Type.Optional(Type.String({ description: "HKD/CNY/RMB/USD；只作标签" })),
  toCurrency: Type.Optional(Type.String()),
  rate: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "显式汇率：一单位原币对应的目标币数量" })),
};
/** Labels declare semantics; magnitude and formula spelling cannot infer them. */
export function percentLabelAmbiguity(label, expression, value, encoding) {
  if (!encoding) return null;
  let info;
  try { info = unitInfo(label); } catch { info={canonical:label}; }
  const expected = encoding === 'fraction' ? 'decimal' : encoding === 'percentage_points' ? '%' : null;
  if (!expected || info.canonical !== expected)
    return `ratioEncoding=${encoding} 与结果单位 ${label} 冲突；fraction 使用 decimal，percentage_points 使用 %。单位标签不执行换算，请用 fromUnit/toUnit 明确换算。`;
  return null;
}

export function createCalcTool({resolveBinding} = {}) {
  return {
    name: "calc", label: "确定性计算",
    description: "精确十进制算式与 Excel 取整、金额单位换算；可批量计算命名算式。批量项的name仅作显示标签，不是后续项可引用的变量；每个expression必须写完整算式，或用bindings绑定实际来源。币种仅为标签，跨币种必须提供显式汇率。",
    promptSnippet: "calc：确定性算术、取整和单位换算",
    promptGuidelines: ["回答里任何派生数值（合计、比例、百分比变化、单位换算、敏感性差额）必须调用 calc 或 model_whatif 计算，不得心算。", "工作簿派生计算应使用bindings绑定已读单元格citation，expression使用输入名称，输出提供name、outputUnit和currency。name写中文业务指标（如核心业务占比），不要用程序变量名。同一比例可写作0.925 decimal或92.5%；%表示百分点数值，小于1的百分数也合法。比例计算用ratioEncoding明确最终数值是fraction还是percentage_points，单位标签不执行换算。比例和金额换算使用fromUnit/toUnit，不能只换标签。"],
    parameters: Type.Object({ ...fields, expression: Type.Optional(fields.expression), expressions: Type.Optional(Type.Array(Type.Object(fields), { maxItems: 100 })) }),
    execute: async (_id, params = {}) => {
      try {
        const inputs = params.expressions || [params];
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw new Error("批量算式必须有 1 到 100 项");
        const { expressions, ...defaults } = params;
        const resolvedSources = new Map();
        const bindingCache = new Map();
        const results = [], failures = [];
        // Each batch item is an independent calculation: one bad expression
        // must not discard the receipts of the others, nor become a success.
        for (const [index,rawItem] of inputs.entries()) try {
          const normalization = normalizeExpressionText(rawItem?.expression);
          const item = rawItem?.expression == null ? rawItem : { ...rawItem, expression: normalization.expression };
          const input = { ...defaults, ...item };
          if (Object.keys(input.bindings || {}).length > 40) throw new Error("每个算式最多绑定40个输入");
          const itemSources = new Map();
          const bindings = {};
          for (const [key,source] of Object.entries(input.bindings || {})) {
            const cacheKey=JSON.stringify([source.materialId,source.version,source.locator]);
            let observed;
            if (resolveBinding) {
              if (!bindingCache.has(cacheKey)) bindingCache.set(cacheKey,await resolveBinding(source));
              observed=bindingCache.get(cacheKey);
            } else observed={...source,display_unit:source.display_unit || source.unit};
            const normalized=normalizeCitationInput(observed);
            if (!normalized) throw new Error(`输入${key}的来源引用无效`);
            bindings[key]=normalized;
            if (resolveBinding) itemSources.set(normalized.id,normalized);
          }
          for (const [key, source] of Object.entries(bindings)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || /^(?:ROUND|ROUNDUP|ROUNDDOWN|ABS|MIN|MAX|SUM)$/i.test(key)) throw new Error("bindings名称须为字母/下划线开头的变量名，不能使用计算函数名");
            if (source?.value == null || source.value === '' || !Number.isFinite(Number(source.value))) throw new Error(`输入${key}缺少有限数值`);
          }
          const expression = String(input.expression || '').replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, key => {
            if (!Object.hasOwn(bindings,key)) return key;
            return '(' + String(bindings[key].value) + ')';
          });
          if (params.expressions && Object.keys(bindings).length && !item.outputUnit && !item.fromUnit && !item.toUnit)
            throw new Error('批量来源绑定计算须在每个expressions条目填写outputUnit或fromUnit/toUnit，不能从顶层继承单位；每股金额、倍数、占比不能共用标签。');
          if (Object.keys(bindings).length && !input.outputUnit && !input.fromUnit && !input.toUnit)
            throw new Error('来源绑定的计算必须提供outputUnit或fromUnit/toUnit；比例0.925用decimal，92.5用%。批量算式必须逐项填写单位。');
          const result = calculate({ ...input, expression });
          if (input.outputUnit && result.unit && input.outputUnit !== result.unit) throw new Error("outputUnit与换算结果单位冲突");
          const ambiguity = percentLabelAmbiguity(result.unit || input.outputUnit, input.expression, result.value, input.ratioEncoding);
          if (ambiguity) throw new Error(ambiguity);
          result.unit ||= input.outputUnit || null;
          const citations = derivedCitation(result, Object.values(bindings), {toolCallId:_id, role:'derived_calc_'+index});
          for (const [id,source] of itemSources) resolvedSources.set(id,source);
          results.push({...result, index, expression:input.expression, evaluatedExpression:expression, bindings, citations, provenance:citations.length?'bound_inputs':'arithmetic_only',
            ...(['%','decimal'].includes(result.unit) ? {ratioEncoding:result.unit === '%' ? 'percentage_points' : 'fraction'} : {}),
            ...(normalization.changed.length ? {originalExpression:rawItem.expression, normalization:normalization.changed} : {})});
        } catch (error) {
          if (!params.expressions) throw error;
          failures.push({index, ...(rawItem?.name ? {name:rawItem.name} : {}), expression:rawItem?.expression ?? null,
            ...(rawItem?.outputUnit ? {outputUnit:rawItem.outputUnit} : {}), error:error.message});
        }
        const lines = results.map((r) => `${r.name ? `${r.name}：` : ""}${r.value}${r.unit ? ` ${r.unit}` : ""}${r.currency ? ` ${r.currency}` : ""}\n换算链：${r.conversionChain}` +
          `${r.normalization ? `\n已移除算式中的排版控制符（${r.normalization.map(c => c.code).join("、")}）；原式见 originalExpression。` : ""}` +
          `${r.unitAmbiguity ? `\n${r.unitAmbiguity}` : ""}` +
          `${!r.citations.length && (r.unit || r.currency) ? "\n输入财务来源尚未绑定。若输入来自工作簿，请将读取工具返回的出处对象放入bindings，expression使用对应变量名；不要重复手抄数字。算式执行成功仅验证算术。" : ""}`);
        const failed = failures.map(f => `第 ${f.index + 1} 项${f.name ? `（${f.name}）` : ""}失败：${f.error}`);
        const citations = [...resolvedSources.values(),...results.flatMap(r=>r.citations)];
        if (!results.length) return { content: [{ type: "text", text: `calc 失败：${failed.join("；")}` }], details: { error: failures[0].error, failures, results: [] }, isError: true };
        if (failures.length) return {
          content: [{ type: "text", text: `${lines.join("\n\n")}\n\n部分算式未成功（其余结果有效）：\n${failed.join("\n")}\n只需重算失败项。` }],
          details: { results, failures, citations, partial: true },
        };
        return { content: [{ type: "text", text: lines.join("\n\n") }], details: { results, citations } };
      } catch (error) { return { content: [{ type: "text", text: `calc 失败：${error.message}` }], details: { error: error.message }, isError: true }; }
    },
  };
}
export default createCalcTool;
