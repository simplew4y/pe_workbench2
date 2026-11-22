// The confirmed disclosure checklist belongs to the model, independently of
// the cells that a particular tracking run proposes to change.
const address = /^([A-Z]{1,3})[1-9]\d*$/;
function isArithmeticFormula(formula) {
  if (typeof formula !== "string" || !formula.startsWith("=") || formula.length > 8192) return false;
  let operandNeeded = true;
  let depth = 0;
  for (const [token] of formula.slice(1).matchAll(/\s+|\$?[A-Z]{1,3}\$?[1-9]\d*|\d+(?:\.\d+)?|./gs)) {
    if (!token.trim()) continue;
    if (operandNeeded) {
      if (token === "+" || token === "-") continue;
      if (token === "(") depth++;
      else if (/^[\dA-Z$]/.test(token) && /\d$/.test(token)) operandNeeded = false;
      else return false;
    } else if (token === ")" && depth > 0) depth--;
    else if (["+", "-", "*", "/"].includes(token)) operandNeeded = true;
    else return false;
  }
  return !operandNeeded && depth === 0;
}

function periodKey(value, header = false) {
  let label = String(value ?? "").trim().toUpperCase().replace(/\s+/g, "");
  if (header) label = label.replace(/[AE]$/, "");
  const year = /^(?:FY)?(20\d\d)年?$/.exec(label);
  if (year) return year[1];
  const quarter = /^([1-4])Q(\d{2}|20\d{2})$/.exec(label);
  if (quarter) return quarter[2].slice(-2) + "Q" + quarter[1];
  return null;
}

export function normalizeActuals(items = []) {
  if (!Array.isArray(items)) throw new Error("披露核对清单必须是数组");
  const refs = new Set();
  return items.map(item => {
    const { sheet, metric, period, unit, source, expected, decimals, formula } = item || {};
    const cell = String(item?.cell || "").trim().toUpperCase();
    const header = String(item?.header || "").trim().toUpperCase();
    const mode = item?.mode ?? "check";
    const ref = String(sheet ?? "").trim() + "!" + cell;
    if (![sheet, metric, period, unit, source].every(s => typeof s === "string" && s.trim()) ||
        !periodKey(period) || !address.test(cell) || !address.test(header) ||
        cell.match(address)[1] !== header.match(address)[1] || cell === header ||
        (item.storageScale !== undefined && (item.storageScale !== 0.01 || !["%", "％"].includes(unit))) ||
        !Number.isFinite(expected) || !Number.isInteger(decimals) || decimals < 0 || decimals > 12 ||
        !["check", "actual", "formula"].includes(mode) || refs.has(ref.toUpperCase())) {
      throw new Error("无效或重复的披露核对项 " + ref);
    }
    if (mode === "formula" ? !isArithmeticFormula(formula) : formula !== undefined) {
      throw new Error("核对公式须为明确确认的单元格算术表达式 " + ref);
    }
    refs.add(ref.toUpperCase());
    return { sheet: sheet.trim(), cell, header, metric: metric.trim(), period: period.trim(),
      unit: unit.trim(), source: source.trim(), expected, decimals, mode,
      ...(item.storageScale ? { storageScale: item.storageScale } : {}),
      ...(mode === "formula" ? { formula } : {}) };
  });
}

export function actualWriteIssue(item, value, previous, actualization = false) {
  if (item?.mode === "actual" && value === item.expected) return "";
  if (item?.mode === "formula" && value === item.formula) return "";
  if (item) return "变更与已确认的披露值、公式或只读核对项不符";
  if (actualization) return "不在本次已确认的披露清单中";
  if (typeof previous === "string" && previous.trim().startsWith("=")) return "是公式，不能直接覆盖";
  if (typeof value === "string" && value.startsWith("=")) return "写入公式需要已确认的公式映射";
  return "";
}

export function actualHeaderIssue(items, values) {
  for (const item of items) {
    const headerRef = item.sheet + "!" + item.header;
    if (periodKey(values[headerRef], true) !== periodKey(item.period)) {
      return headerRef + " 的表头与披露期间 " + item.period + " 不符";
    }
  }
  return "";
}

export function reconcileActuals(items, values, formulas = {}) {
  return items.map(item => {
    const ref = item.sheet + "!" + item.cell;
    const actual = values[ref] ?? null;
    const format = new Intl.NumberFormat("en-US", { useGrouping: false, maximumFractionDigits: item.decimals });
    const matched = Number.isFinite(actual) && Number(format.format(actual)) === Number(format.format(item.expected));
    return { ...item, ref, actual, matched: matched && (item.mode !== "formula" || formulas[ref] === item.formula) };
  });
}
