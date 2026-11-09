/** Deterministic decimal arithmetic. Values remain BigInt fractions until display. */
import { Type } from "typebox";
import { CITATION_INPUT_SCHEMA } from "./contracts/citation.mjs";
import { derivedCitation } from "./citations.mjs";

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
      const exponent = integer(unary());
      // Check before exponentiation: nested powers must never allocate huge integers.
      const magnitude = Math.max(bitLength(result.n), bitLength(result.d));
      if (Math.abs(exponent) * magnitude > MAX_BITS) throw new Error("数值大小超出上限");
      result = exponent >= 0 ? fraction(result.n ** BigInt(exponent), result.d ** BigInt(exponent)) : fraction(result.d ** BigInt(-exponent), result.n ** BigInt(-exponent));
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

const amountUnits = { "元": 1n, "千元": 1000n, "万元": 10000n, "百万元": 1000000n, "亿元": 100000000n, "十亿": 1000000000n };
const UNIT_ALIASES = new Map([
  ["元", "元"], ["千元", "千元"], ["万元", "万元"], ["百万元", "百万元"], ["百万", "百万元"],
  ["亿元", "亿元"], ["亿", "亿元"], ["十亿元", "十亿"], ["十亿", "十亿"],
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
  const canonical = UNIT_ALIASES.get(key) || UNIT_ALIASES.get(key.replace(/\s+/g, ""));
  if (!canonical) throw new Error(`不支持的单位：${raw}`);
  const ratio = canonical === "%" || canonical === "decimal";
  const currency = /^(rmb|hkd|usd)(?:\s|$)/i.test(key) ? key.split(/\s/)[0].toUpperCase() : null;
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
  const sourceCurrency = currency || inferredSource || null;
  const targetCurrency = toCurrency || (inferredTarget && inferredTarget !== sourceCurrency ? inferredTarget : null) || null;
  for (const label of [sourceCurrency, targetCurrency]) if (label && !["HKD", "RMB", "USD"].includes(label)) throw new Error("币种仅支持 HKD/RMB/USD 标签");
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
  const expression = params.expression != null ? String(params.expression) : String(params.value ?? "").replaceAll(",", "").trim();
  if (!expression) throw new Error("value 或 expression 必须提供");
  const from = unitInfo(fromUnit), to = unitInfo(toUnit);
  if (from.kind !== to.kind) throw new Error("不兼容的单位类型：金额单位不能与百分比/小数互换");
  if (from.currency && to.currency && from.currency !== to.currency) throw new Error("跨币种换算必须使用 calc 的显式汇率，unit_convert 只换单位");
  const explicitCurrency = params.currency ? String(params.currency).toUpperCase() : null;
  if (explicitCurrency && !["HKD", "RMB", "USD"].includes(explicitCurrency)) throw new Error("币种仅支持 HKD/RMB/USD 标签");
  if (explicitCurrency && from.currency && explicitCurrency !== from.currency) throw new Error("currency 与 from_unit 的币种不一致");
  const input = evaluateExpression(expression);
  const before = format(input);
  const result = mul(input, div(from.factor, to.factor));
  const value = format(result, params.precision);
  const currency = explicitCurrency || from.currency || to.currency || null;
  const conversionChain = `${expression} ${from.requested} → ${before} ${from.canonical} × (${format(from.factor)} / ${format(to.factor)}) = ${value} ${to.canonical}${currency ? ` ${currency}` : ""}`;
  return { value, unit: to.canonical, currency, fromUnit: from.canonical, toUnit: to.canonical, conversionChain };
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
  expression: Type.String({ description: "算式；支持 + - * / ^、括号、百分数及 Excel ROUND/ROUNDUP/ROUNDDOWN/ABS/MIN/MAX/SUM" }),
  name: Type.Optional(Type.String()),
  precision: Type.Optional(Type.Integer({ minimum: 0, maximum: 100 })),
  fromUnit: Type.Optional(Type.String({ description: "元/千元/万元/百万元/亿元/十亿" })),
  toUnit: Type.Optional(Type.String()),
  currency: Type.Optional(Type.String({ description: "HKD/RMB/USD；只作标签" })),
  toCurrency: Type.Optional(Type.String()),
  rate: Type.Optional(Type.Union([Type.String(), Type.Number()], { description: "显式汇率：一单位原币对应的目标币数量" })),
};
export function createCalcTool() {
  return {
    name: "calc", label: "确定性计算",
    description: "精确十进制算式与 Excel 取整、金额单位换算；可批量计算命名算式。币种仅为标签，跨币种必须提供显式汇率。",
    promptSnippet: "calc：确定性算术、取整和单位换算",
    promptGuidelines: ["回答里任何派生数值（合计、比例、百分比变化、单位换算、敏感性差额）必须调用 calc 或 model_whatif 计算，不得心算。"],
    parameters: Type.Object({ ...fields, expression: Type.Optional(fields.expression), expressions: Type.Optional(Type.Array(Type.Object(fields), { maxItems: 100 })) }),
    execute: async (_id, params = {}) => {
      try {
        const inputs = params.expressions || [params];
        if (!Array.isArray(inputs) || !inputs.length || inputs.length > 100) throw new Error("批量算式必须有 1 到 100 项");
        const { expressions, ...defaults } = params;
        const results = inputs.map((item) => calculate({ ...defaults, ...item }));
        return { content: [{ type: "text", text: results.map((r) => `${r.name ? `${r.name}：` : ""}${r.value}${r.unit ? ` ${r.unit}` : ""}${r.currency ? ` ${r.currency}` : ""}\n换算链：${r.conversionChain}`).join("\n\n") }], details: { results } };
      } catch (error) { return { content: [{ type: "text", text: `calc 失败：${error.message}` }], details: { error: error.message }, isError: true }; }
    },
  };
}
export default createCalcTool;
