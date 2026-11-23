import { trackingStatePath } from "./model-location.mjs";
/**
 * Model write-back: prepare a writable working copy, apply verified input-cell
 * changes, recalculate with LibreOffice, and verify outputs before replacing
 * the working model.
 *
 * The original upload is never modified. A change is only applied when the
 * binding is explicitly verified. Replacing a forecast formula additionally
 * requires the period-specific disclosure checklist confirmed for that cell.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { baselineSnapshot, compareModel } from "./model-verification.mjs";
import { disclosureVersionIssue, sha256File } from "./model-disclosure.mjs";
import { actualHeaderIssue, actualWriteIssue, normalizeActuals, reconcileActuals } from "./model-actuals.mjs";
import {
  applyWorkbookCells,
  readCells,
} from "./calc-engine.mjs";

function inside(root, candidate) {
  const absolute = path.resolve(root, candidate);
  return absolute === root || absolute.startsWith(root + path.sep) ? absolute : null;
}

function refOf(sheet, cell) {
  return `${String(sheet || "").trim()}!${String(cell || "").trim().toUpperCase()}`;
}

function normalizeOutputs(outputs) {
  return (Array.isArray(outputs) ? outputs : [])
    .map((output) => ({
      label: String(output?.label || output?.name || "").trim(),
      sheet: String(output?.sheet || "").trim(),
      cell: String(output?.cell || "").trim().toUpperCase(),
    }))
    .filter((output) => output.sheet && output.cell);
}

function normalizeChanges(changes) {
  return (Array.isArray(changes) ? changes : [])
    .map((change) => ({
      metric: String(change?.metric || "").trim(),
      sheet: String(change?.sheet || "").trim(),
      cell: String(change?.cell || "").trim().toUpperCase(),
      value: change?.value,
      note: String(change?.note || change?.reason || "").trim(),
    }))
    .filter((change) => change.sheet && change.cell);
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

async function writeState(ctx, stateRel, state) {
  const absolute = inside(ctx.root, stateRel);
  if (!absolute) throw new Error("状态文件不在项目内");
  const temp = `${absolute}.tmp-${process.pid}`;
  await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await fsp.rename(temp, absolute);
  return ctx.store.indexFile(stateRel, {
    source: "agent",
    author: "Workbench",
    note: "模型绑定/输出更新",
    status: "draft",
    visibility: "internal",
    reason: "model metadata",
  });
}

export async function prepareWorkingModel({ ctx, tracking, state, stateRel, privateBaseline = false, targetPath = tracking?.relPath || tracking?.targetPath }) {
  if (!targetPath) throw Object.assign(new Error("目标文件路径为空"), { status: 400 });
  const sourceRel = state?.subject?.model_file
    || state?.model?.files?.[0]?.absolute_path
    || "";
  if (!sourceRel) throw Object.assign(new Error("状态文件里没有 model_file"), { status: 400 });
  const sourceAbs = inside(ctx.root, sourceRel);
  if (!sourceAbs || !fs.existsSync(sourceAbs)) {
    throw Object.assign(new Error(`原始模型不存在：${sourceRel}`), { status: 404 });
  }
  const dir = path.posix.dirname(targetPath);
  const workingRel = path.posix.join(dir, "model", "工作模型.xlsx");
  const workingAbs = path.join(ctx.root, workingRel);
  if (!fs.existsSync(workingAbs)) {
    await fsp.mkdir(path.dirname(workingAbs), { recursive: true });
    await fsp.copyFile(sourceAbs, workingAbs);
  }
  // Downloads can carry the Windows read-only attribute into the working
  // copy. Make the managed copy writable without changing the uploaded file.
  const workingStat = await fsp.lstat(workingAbs);
  if (sourceAbs !== workingAbs && workingStat.isFile() && workingStat.nlink === 1 && !(workingStat.mode & 0o200)) {
    await fsp.chmod(workingAbs, workingStat.mode | 0o200);
  }

  state.model = state.model && typeof state.model === "object" ? state.model : {};
  state.model.working_file = workingRel;
  state.model.working_from = sourceRel;
  state.model.write_enabled = state.model.write_enabled === true;
  state.model.bindings = Array.isArray(state.model.bindings) ? state.model.bindings : [];
  state.model.outputs = Array.isArray(state.model.outputs) ? state.model.outputs : [];
  await writeState(ctx, stateRel, state);
  const material = ctx.store.indexFile(workingRel, {
    source: "agent",
    author: "Workbench",
    note: "工作模型",
    ...(privateBaseline ? { visibility: "internal", reason: "model update baseline" } : {}),
    status: "draft",
  });
  return { workingFile: workingRel, material, state };
}

export async function applyModelChanges({
  ctx,
  tracking,
  state,
  changes = [],
  outputs = [],
  runId = null,
  expectedSha = null,
  expectedActuals,
} = {}) {
  const workingRel = state?.model?.working_file;
  if (!workingRel) return { ok: false, reason: "还没有准备工作模型" };
  const workingAbs = inside(ctx.root, workingRel);
  if (!workingAbs || !fs.existsSync(workingAbs)) {
    return { ok: false, reason: `工作模型不存在：${workingRel}` };
  }
  if (state?.model?.write_enabled !== true) {
    return { ok: false, reason: "模型写回未启用（model.write_enabled=false）" };
  }
  const actuals = normalizeActuals(state.model.actuals);
  if (expectedActuals && JSON.stringify(expectedActuals) !== JSON.stringify(actuals)) {
    return { ok: false, conflict: true, reason: "披露核对清单已变化" };
  }
  const baselineSha = expectedSha || (actuals.length ? await sha256File(workingAbs) : null);
  if (expectedSha && await sha256File(workingAbs) !== String(expectedSha)) {
    return { ok: false, conflict: true, code: "baseline_changed", reason: "工作模型在审批后已变化，拒绝写入" };
  }

  const normalizedChanges = normalizeChanges(changes);
  const actualByRef = new Map(actuals.map(item => [refOf(item.sheet, item.cell), item]));
  const outputMap = new Map(normalizeOutputs(outputs).map(item => [refOf(item.sheet, item.cell), item]));
  for (const [ref, { metric: label, sheet, cell }] of actualByRef) outputMap.set(ref, { label, sheet, cell });
  const normalizedOutputs = [...outputMap.values()];
  if (!normalizedChanges.length) return { ok: false, reason: "没有模型单元格变更" };
  if (!normalizedOutputs.length) return { ok: false, reason: "没有声明要校验的模型输出" };

  const bindings = Array.isArray(state?.model?.bindings) ? state.model.bindings : [];
  const verified = new Map();
  for (const binding of bindings) {
    if (binding?.verified !== true) continue;
    const ref = refOf(binding.sheet, binding.cell).toUpperCase();
    verified.set(ref, binding);
  }
  if (!verified.size) return { ok: false, reason: "没有已确认的单元格映射" };

  for (const change of normalizedChanges) {
    const ref = refOf(change.sheet, change.cell).toUpperCase();
    if (!verified.has(ref)) {
      return { ok: false, reason: `单元格 ${ref} 没有已验证的映射` };
    }
    if (change.value === undefined || change.value === null || typeof change.value === "object") {
      return { ok: false, reason: `单元格 ${ref} 的值非法` };
    }
  }

  const headers = [...new Set(actuals.map(item => refOf(item.sheet, item.header)))];
  const headerIssue = actualHeaderIssue(actuals, await readCells(workingAbs, headers), state.model.edits);
  if (headerIssue) return { ok: false, reason: headerIssue };
  const formulas = await readCells(workingAbs, normalizedChanges.map((c) => refOf(c.sheet, c.cell)), {
    formulas: true,
  });
  for (const change of normalizedChanges) {
    const ref = refOf(change.sheet, change.cell);
    const formula = formulas[ref];
    const issue = actualWriteIssue(actualByRef.get(ref), change.value, formula, actuals.length > 0, state.model.edits?.find(e => refOf(e.sheet,e.cell) === ref));
    if (issue) return { ok: false, reason: `单元格 ${ref} ${issue}` };
    if (actualByRef.has(ref) && typeof formula === "string" && formula.startsWith("=")) change.previousFormula = formula;
  }

  const outputRefs = normalizedOutputs.map((output) => refOf(output.sheet, output.cell));
  const snapshot = actuals.length ? await baselineSnapshot(workingAbs, actuals, normalizedOutputs, state.model.check_tolerances) : null;
  const before = snapshot?.values || await readCells(workingAbs, outputRefs);
  const result = await applyWorkbookCells({
    sourcePath: workingAbs,
    changes: normalizedChanges.map((change) => `${refOf(change.sheet, change.cell)}=${JSON.stringify(change.value)}`),
    outputs: snapshot?.refs || outputRefs,
  });
  const after = result.values;
  const analysis = snapshot ? compareModel(snapshot, after) : null;
  const invalidOutputs = analysis?.comparisons.filter(row => !Number.isFinite(row.after)) || [];
  if (invalidOutputs.length) {
    await fsp.rm(result.workDir, { recursive: true, force: true });
    return { ok: false, reason: "重算输出缺失或非数值：" + invalidOutputs.map(row => row.ref).join("、") };
  }
  const failedChecks = analysis?.checks.filter(check => ["failed", "unverified"].includes(check.status)) || [];
  if (failedChecks.length) {
    await fsp.rm(result.workDir, { recursive: true, force: true });
    return { ok: false, reason: failedChecks.map(row => row.ref + " 勾稽差额 " + row.before + " → " + row.after).join("；") };
  }
  const formulaRefs = actuals.filter(item => item.mode === "formula").map(item => refOf(item.sheet, item.cell));
  const formulasAfter = await readCells(result.file, formulaRefs, { formulas: true });
  const reconciliation = reconcileActuals(actuals, after, formulasAfter);
  const differences = reconciliation.filter(row => !row.matched);
  if (differences.length) {
    await fsp.rm(result.workDir, { recursive: true, force: true });
    const detail = differences.map(row => `${row.metric} (${row.ref}) 模型 ${row.actual ?? "空"}，预期 ${row.expected} ${row.unit}`).join("；");
    return { ok: false, code: "actuals_mismatch", reconciliation,
      reason: `对账通过 ${actuals.length - differences.length}/${actuals.length} 项，工作模型未发布。${detail}` };
  }

  for (const output of normalizedOutputs) {
    const ref = refOf(output.sheet, output.cell);
    const value = after[ref];
    if (value === null || value === undefined) {
      fs.rmSync(result.workDir, { recursive: true, force: true });
      return { ok: false, reason: `输出 ${ref} 没有值` };
    }
    if (numberOrNull(value) === null && typeof value !== "string") {
      fs.rmSync(result.workDir, { recursive: true, force: true });
      return { ok: false, reason: `输出 ${ref} 不是有效数值或文本` };
    }
  }



  // Re-check immediately before committing: the recalc can take minutes and an
  // out-of-band editor must not be silently overwritten.
  if (baselineSha && await sha256File(workingAbs) !== baselineSha) {
    fs.rmSync(result.workDir, { recursive: true, force: true });
    return { ok: false, conflict: true, code: "baseline_changed", reason: "工作模型在重算期间已变化，拒绝写入" };
  }

  const stateRel = trackingStatePath(ctx.root, tracking);
  const stateAbs = inside(ctx.root, stateRel);
  let currentState = null;
  let currentActuals = null;
  try {
    currentState = JSON.parse(await fsp.readFile(stateAbs, "utf8"));
    currentActuals = normalizeActuals(currentState.model?.actuals);
  } catch {
    // A missing legacy state remains supported. A changed or invalid
    // disclosure checklist cannot authorize the staged write.
  }
  if ((actuals.length && JSON.stringify(currentState?.model?.edits || []) !== JSON.stringify(state.model.edits || [])) ||
      (actuals.length && JSON.stringify(currentState?.model?.check_tolerances) !== JSON.stringify(state.model.check_tolerances)) ||
      (actuals.length && !currentState) ||
      (currentState && JSON.stringify(currentActuals) !== JSON.stringify(actuals))) {
    await fsp.rm(result.workDir, { recursive: true, force: true });
    return { ok: false, conflict: true, reason: "重算期间披露核对清单已变化" };
  }
  if (
    currentState
    && (currentState.model?.working_file !== workingRel || currentState.model?.write_enabled !== true)
  ) {
    fs.rmSync(result.workDir, { recursive: true, force: true });
    return { ok: false, conflict: true, code: "baseline_changed", reason: "分析状态在重算期间已变化，拒绝写入" };
  }
  const evidenceIssue = await disclosureVersionIssue(ctx, currentState?.model || state.model);
  if (evidenceIssue || currentState?.model?.disclosure_sha256 !== state.model?.disclosure_sha256 ||
      currentState?.model?.disclosure_file !== state.model?.disclosure_file) {
    await fsp.rm(result.workDir, { recursive: true, force: true });
    return { ok: false, conflict: true, reason: evidenceIssue || "重算期间披露来源已变化" };
  }
  if (currentState) {
    // The long recalc may overlap an agent/human edit of analysis-state.json.
    // Re-check the exact bindings and formulas against the state that will be
    // used for the write, not the snapshot validated before the recalc.
    const currentVerified = new Set(
      (Array.isArray(currentState.model?.bindings) ? currentState.model.bindings : [])
        .filter((binding) => binding?.verified === true && binding.sheet && binding.cell)
        .map((binding) => refOf(binding.sheet, binding.cell).toUpperCase()),
    );
    const stillFormulas = await readCells(
      workingAbs,
      normalizedChanges.map((change) => refOf(change.sheet, change.cell)),
      { formulas: true },
    );
    for (const change of normalizedChanges) {
      const ref = refOf(change.sheet, change.cell).toUpperCase();
      if (!currentVerified.has(ref)) {
        fs.rmSync(result.workDir, { recursive: true, force: true });
        return { ok: false, conflict: true, code: "baseline_changed", reason: `单元格 ${ref} 的绑定在重算期间失效` };
      }
      const formula = stillFormulas[ref] ?? stillFormulas[refOf(change.sheet, change.cell)];
      const cellRef = refOf(change.sheet, change.cell);
      const issue = actualWriteIssue(actualByRef.get(cellRef), change.value, formula, actuals.length > 0, currentState?.model.edits?.find(e => refOf(e.sheet,e.cell) === cellRef));
      if (issue) {
        fs.rmSync(result.workDir, { recursive: true, force: true });
        return { ok: false, conflict: true, code: "baseline_changed", reason: `单元格 ${ref} ${issue}` };
      }
    }
  }
  const finalState = currentState || state;
  const previousState = JSON.parse(JSON.stringify(finalState));
  finalState.model = finalState.model && typeof finalState.model === "object" ? finalState.model : {};
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const backupRel = path.posix.join(
    path.posix.dirname(workingRel),
    "backups",
    `${stamp}-${String(runId || "manual").slice(0, 8)}`,
    path.posix.basename(workingRel),
  );
  const backupAbs = path.join(ctx.root, backupRel);
  await fsp.mkdir(path.dirname(backupAbs), { recursive: true });
  await fsp.copyFile(workingAbs, backupAbs);

  finalState.model.reported_cells = {...finalState.model.reported_cells};
  for (const item of actuals.filter(item => item.issuer && !item.caption)) {
    finalState.model.reported_cells[refOf(item.sheet,item.cell)] = {period:item.period, scope:item.scope,
      issuer:item.issuer, expected:item.expected, source:item.source};
  }
  finalState.model.last_applied = {
    at: new Date().toISOString(),
    run_id: runId,
    changes: normalizedChanges,
    ...(actuals.length ? { reconciliation, analysis } : {}),
    outputs: normalizedOutputs.map((output) => ({
      ...output,
      before: before[refOf(output.sheet, output.cell)] ?? null,
      after: after[refOf(output.sheet, output.cell)] ?? null,
    })),
    backup: backupRel,
  };

  const tempTarget = `${workingAbs}.tmp-${process.pid}`;
  try {
    await fsp.copyFile(result.file, tempTarget);
    await fsp.rename(tempTarget, workingAbs);
    if (actuals.length) {
      const saved = await readCells(workingAbs, outputRefs);
      const savedFormulas = await readCells(workingAbs, formulaRefs, { formulas: true });
      const savedHeaders = await readCells(workingAbs, headers);
      if (actualHeaderIssue(actuals, savedHeaders)) throw new Error("保存后期间与公告不符");
      if (reconcileActuals(actuals, saved, savedFormulas).some(row => !row.matched)) {
        throw new Error("工作模型保存后读回的数值与公告不符");
      }
    }
    // Persist the bookkeeping first: if this throws, restore the workbook from
    // the backup and leave no half-applied version behind.
    await writeState(ctx, stateRel, finalState);
  } catch (error) {
    await fsp.copyFile(backupAbs, workingAbs).catch(() => {});
    await fsp.rm(tempTarget, { force: true }).catch(() => {});
    await writeState(ctx, stateRel, previousState).catch(() => {});
    fs.rmSync(result.workDir, { recursive: true, force: true });
    throw error;
  }

  let material;
  try {
    material = ctx.store.indexFile(workingRel, {
      source: "agent",
      author: "Workbench",
      note: "模型更新（LibreOffice 重算）",
      status: "draft",
      visibility: "checkpoint",
      runId,
      reason: "model update",
    });
  } catch (error) {
    await fsp.copyFile(backupAbs, workingAbs).catch(() => {});
    await writeState(ctx, stateRel, previousState).catch(() => {});
    fs.rmSync(result.workDir, { recursive: true, force: true });
    throw error;
  }

  fs.rmSync(result.workDir, { recursive: true, force: true });
  return {
    ok: true,
    workingFile: workingRel,
    backupRel,
    material,
    before,
    after,
    ...(actuals.length ? { reconciliation, analysis } : {}),
    changes: normalizedChanges,
    outputs: normalizedOutputs,
  };
}
