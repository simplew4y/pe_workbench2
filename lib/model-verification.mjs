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
    rows.set(ref, { ...rows.get(ref), ref, metric: actual.metric, period: actual.period, unit: actual.unit, kind: "actual", storageScale: actual.storageScale || 1 });
  }
  for (const output of outputs) {
    const ref = output.sheet + "!" + output.cell;
    if (!rows.has(ref)) rows.set(ref, { ref, metric: output.label || ref, kind: "output" });
  }
  const refs = [...new Set([...rows.keys(), ...layout.checks, ...Array.from(rows.values(), row => row.prior).filter(Boolean)])];
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "pe-model-baseline-"));
  try {
    const calculated = await recalculateXlsx(file, { outDir: temp });
    const values = await readCells(calculated, refs);
    return { refs, checks: layout.checks, rules: layout.rules, comparisons: [...rows.values()], values, tolerances };
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}

export function compareModel(snapshot, after) {
  const checks = snapshot.checks.map(ref => {
    const before = snapshot.values[ref], value = after[ref];
    const tolerance = snapshot.tolerances[ref] ?? 1e-8;
    if (!Number.isFinite(tolerance) || tolerance < 0) throw new Error(ref + " 容差无效");
    if (typeof value === "boolean" || typeof before === "boolean") {
      return { ref, before, after: value, tolerance, status: value === true ? "pass" : before === false && value === false ? "existing" : "failed" };
    }
    if (!snapshot.rules?.[ref]) {
      return { ref, before, after: value, tolerance, status: "unverified" };
    }
    const pass = Number.isFinite(value) && Math.abs(value) <= tolerance;
    const existing = Number.isFinite(before) && Number.isFinite(value)
      ? Math.abs(before) > tolerance && Math.abs(value) <= Math.abs(before)
      : typeof before === "string" && before.startsWith("#") && before === value;
    return { ref, before, after: value, tolerance, status: pass ? "pass" : existing ? "existing" : "failed" };
  });
  const comparisons = snapshot.comparisons.map(row => {
    const scale = row.storageScale || 1;
    const displayed = value => Number.isFinite(value) ? value / scale : value;
    const before = displayed(snapshot.values[row.ref]), value = displayed(after[row.ref]), prior = displayed(snapshot.values[row.prior]);
    const comparable = Number.isFinite(before) && Number.isFinite(value);
    return { ...row, before, after: value, priorValue: Number.isFinite(prior) ? prior : null, delta: comparable ? value - before : null,
      relative: comparable && before !== 0 ? (value - before) / Math.abs(before) : null,
      sameDirection: comparable && Number.isFinite(prior)
        ? Math.sign(before - prior) === Math.sign(value - prior) : null };
  });
  return { checks, comparisons };
}
