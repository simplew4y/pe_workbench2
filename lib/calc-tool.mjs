/** Deterministic decimal arithmetic. Values remain BigInt fractions until display. */
import { Type } from "typebox";

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

const units = { "元": 1n, "千元": 1000n, "万元": 10000n, "百万元": 1000000n, "亿元": 100000000n, "十亿": 1000000000n };
export function calculate(params = {}) {
  const { expression, precision, fromUnit, toUnit, currency, toCurrency, rate, name } = params;
  let result = evaluateExpression(expression);
  const chain = [`${expression} = ${format(result)}`];
  if (fromUnit || toUnit) {
    const from = fromUnit || toUnit, to = toUnit || fromUnit;
    if (!units[from] || !units[to]) throw new Error("不支持的金额单位");
    const before = format(result);
    result = mul(result, fraction(units[from], units[to]));
    chain.push(`${before} ${from} × ${units[from]}/${units[to]} = ${format(result, precision)} ${to}`);
  }
  for (const label of [currency, toCurrency]) if (label && !["HKD", "RMB", "USD"].includes(label)) throw new Error("币种仅支持 HKD/RMB/USD 标签");
  if (toCurrency && currency !== toCurrency) {
    if (!currency || rate === undefined) throw new Error("跨币种换算必须提供原币种及显式汇率 rate");
    const fx = decimal(rate);
    if (fx.n <= 0n) throw new Error("汇率必须大于零");
    result = mul(result, fx);
    chain.push(`按显式汇率 1 ${currency} = ${rate} ${toCurrency}，结果 ${format(result, precision)} ${toCurrency}`);
  }
  return { ...(name ? { name } : {}), expression, value: format(result, precision), unit: toUnit || fromUnit || null, currency: toCurrency || currency || null, conversionChain: chain.join(" → ") };
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
