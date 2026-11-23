// Inspect the author's model on a freshly calculated baseline. All comparisons
// refer to exactly the same coordinates on the staged workbook.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readCells, recalculateXlsx, runModelReader } from "./calc-engine.mjs";

export async function baselineSnapshot(file, actuals, outputs = [], tolerances = {}) {
  const layout = await runModelReader("workbook/model_layout.py", file, actuals);
  const rows = new Map(layout.comparisons.map(row => [row.ref, row]));
  for (const actual of actuals) {
    const ref = actual.sheet + "!" + actual.cell;
    rows.set(ref, { ...rows.get(ref), forecastRef:actual.forecastRef, priorReported:actual.priorReported, scope:actual.scope, supplemental:Boolean(actual.caption), ref, metric: actual.metric, period: actual.period, unit: actual.unit, kind: "actual", storageScale: actual.storageScale || 1 });
  }
  for (const output of outputs) {
    const ref = output.sheet + "!" + output.cell;
    if (!rows.has(ref)) rows.set(ref, { ref, metric: output.label || ref, kind: "output" });
  }
  const refs = [...new Set([...rows.keys(), ...layout.checks, ...Array.from(rows.values(), row => row.prior).filter(Boolean), ...Array.from(rows.values(), row => row.forecastRef).filter(Boolean)])];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pe-model-baseline-"));
  try {
    const calculated = await recalculateXlsx(file, { outDir: temp });
    const values = await readCells(calculated, refs);
    return { refs, checks: layout.checks, rules: layout.rules, formatTolerances: layout.formatTolerances, comparisons: [...rows.values()], values, tolerances };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export function compareModel(snapshot, after) {
  const checks = snapshot.checks.map(ref => {
    const before = snapshot.values[ref], value = after[ref];
    const tolerance = snapshot.tolerances[ref] ?? snapshot.formatTolerances?.[ref] ?? 1e-8;
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error(ref + " 容差无效");
    if (typeof value === "boolean" || typeof before === "boolean") {
      return { ref, before, after: value, tolerance, status: value === true ? "pass" : before === false && value === false ? "existing" : "failed" };
    }
    if (!snapshot.rules?.[ref]) {
      return { ref, before, after: value, tolerance, status: "unverified" };
    }
    const pass = Number.isFinite(value) && Math.abs(value) <= tolerance;
    const existing = Number.isFinite(before) && Number.isFinite(value)
      ? Math.abs(before) > tolerance && Math.abs(value) <= Math.abs(before) + Math.min(tolerance, 1e-10)
      : typeof before === "string" && before.startsWith("#") && before === value;
    return { ref, before, after: value, tolerance, status: pass ? "pass" : existing ? "existing" : "failed" };
  });
  const comparisons = snapshot.comparisons.map(row => {
    const scale = row.storageScale || 1;
    const displayed = value => Number.isFinite(value) ? value / scale : value;
    const before = row.supplemental && !row.forecastRef ? null : displayed(snapshot.values[row.forecastRef || row.ref]);
    const value = displayed(after[row.ref]), prior = displayed(snapshot.values[row.prior]);
    const nativeAfter = row.forecastRef ? displayed(after[row.forecastRef]) : null;
    const comparable = Number.isFinite(before) && Number.isFinite(value);
    return { ...row, before, after: value, nativeAfter, priorValue: Number.isFinite(prior) ? prior : null, delta: comparable ? value - before : null,
      relative: comparable && before !== 0 ? (value - before) / Math.abs(before) : null,
      sameDirection: comparable && Number.isFinite(prior)
        ? Math.sign(before - prior) === Math.sign(value - prior) : null };
  });
  const fmt = x => new Intl.NumberFormat("zh-CN", {maximumFractionDigits: 3}).format(x);
  const lines = [];
  for (const row of comparisons) {
    if (row.kind === "actual") {
      const scope = row.scope ? row.scope + " " : "";
      let line = `${row.period} ${scope}${row.metric} 实际 ${fmt(row.after)} ${row.unit}。`;
      if (row.relative != null) {
        line += `相对更新前同期间模型值${row.delta >= 0 ? "增加" : "减少"} ${fmt(Math.abs(row.delta))}（基准绝对值的 ${fmt(Math.abs(row.relative)*100)}%）。`;
      }
      if (row.sameDirection != null) {
        const direction = amount => amount > row.priorValue ? "上升" : amount < row.priorValue ? "下降" : "持平";
        line += `以上期 ${fmt(row.priorValue)} 为基准，原预计${direction(row.before)}，实际${direction(row.after)}。`;
      }
      if (row.before && Number.isFinite(row.after) && Math.sign(row.before) === Math.sign(row.after)) {
        const multiple = Math.abs(row.after / row.before);
        if (multiple >= 2 || multiple <= 0.5) line += `实际绝对金额为原模型的 ${fmt(multiple)} 倍。`;
      }
      if (row.supplemental && Number.isFinite(row.priorReported)) {
        line += `上年同期披露 ${fmt(row.priorReported)}，同比变动 ${fmt(row.after-row.priorReported)} ${row.unit}。`;
      }
      if (Number.isFinite(row.nativeAfter) && Math.abs(row.after - row.nativeAfter) > 1e-8) {
        line += `更新后主表 ${row.forecastRef} 为 ${fmt(row.nativeAfter)}，披露值与主表差额 ${fmt(row.after - row.nativeAfter)} ${row.unit}。`;
      }
      if (row.supplemental) line += "单列披露，原预测公式未接入该列。";
      lines.push(line);
    } else if (row.kind === "output" || (row.kind === "forecast" && row.delta !== null && Math.abs(row.delta)>1e-8)) {
      lines.push(`${row.period || ""} ${row.metric}（${row.ref}）由 ${fmt(row.before)} 变为 ${fmt(row.after)}${row.unit ? " "+row.unit : ""}。`.trim());
    }
  }
  return { checks, comparisons, observations: lines };
}
