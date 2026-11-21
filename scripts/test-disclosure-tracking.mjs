// node scripts/test-disclosure-tracking.mjs <original.xlsx> <official.pdf> [destination]
// Real provider, isolated Workbench HTTP service, real approvals and LibreOffice.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWorkbench } from "../server/create-app.mjs";
import { loadConfig } from "../server/config.mjs";
import { readCells } from "../lib/calc-engine.mjs";
import { reconcileActuals, normalizeActuals } from "../lib/model-actuals.mjs";

const [original, announcement, destination = os.tmpdir()] = process.argv.slice(2);
assert.ok(original && announcement, "Pass the original workbook and annual results PDF");
await fs.mkdir(destination, { recursive: true });
const root = await fs.mkdtemp(path.join(path.resolve(destination), "disclosure-"));
Object.assign(process.env, { WORKBENCH_STORAGE_ROOT: root, WORKBENCH_PROJECTS_DIR: path.join(root, "projects"),
  TRACKING_SCHEDULER: "0", MONITOR_SCHEDULER: "0", SOURCE_SCHEDULER: "0", WATCH_SCHEDULER: "0",
  PI_FAKE_AGENT: "0", WORKBENCH_SEED: "0" });
const config = await loadConfig();
assert.ok(config.calcInfo.available && !config.fakeAgent);
const app = await createWorkbench({ config });
const { url } = await app.listen(0);
const ctx = app.projectManager.get(config.defaultProjectId);
const xlsx = "uploads/TencentModel.xlsx", pdf = "uploads/Annual-results.pdf";
const sha = async file => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
const hash = await sha(original);
const report = { root, originalSha256: hash, sourceSha256: await sha(announcement), provider: config.modelId };
const save = () => fs.writeFile(path.join(root, "result.json"), JSON.stringify(report, null, 2));
console.log("Results:", root);
async function post(route, body = {}) {
  const res = await fetch(url + route, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  assert.ok(res.ok, `${res.status} ${json.error || route}`);
  return json;
}
try {
  for (const [rel, source] of [[xlsx, original], [pdf, announcement]]) {
    await fs.mkdir(path.dirname(path.join(ctx.root, rel)), { recursive: true });
    await fs.copyFile(source, path.join(ctx.root, rel));
    ctx.store.indexFile(rel, { kind: "input" });
  }
  const target = ctx.store.findMaterialByPath(xlsx);
  const tracking = ctx.store.createTracking({ targetId: target.id, templateId: "model", freq: "weekly", weekday: 1, time: "09:00" });
  const stateRel = "uploads/analysis-state.json";
  await app.writeTrackingState(ctx, stateRel, { subject: { company: "Tencent", model_file: xlsx }, model: {} });
  const route = "/api/trackings/" + tracking.id;
  const prepared = await post(route + "/model/prepare");
  const working = path.join(ctx.root, prepared.model.working_file);
  const forecastRefs = ["IS!AE198", "IS!AE199", "IS!AF198", "IS!AF199"];
  const future = await readCells(working, forecastRefs, { formulas: true });
  const oldForecast = await readCells(working, forecastRefs);
  const preview = await post(route + "/model/disclosure", { disclosureFile: pdf });
  assert.ok(preview.inventory.facts.length && preview.actuals.length);
  // Simulate the user's confirmation of Workbench's discovered mappings. No oracle input.
  await post(route + "/model/bindings", { disclosureFile: pdf, disclosureSha256: preview.inventory.sha256,
    writeEnabled: true, bindings: preview.actuals.filter(row => row.mode !== "check").map(row => ({
      sheet: row.sheet, cell: row.cell, metric: row.metric, verified: true })) });
  const run = await post(route + "/run");
  report.runId = run.runId;
  await save();
  let row;
  do {
    await new Promise(resolve => setTimeout(resolve, 2000));
    row = ctx.store.getTrackingRun(run.runId);
  } while (row.status === "running" || !row.ended_at);
  report.runStatus = row.status;
  const result = JSON.parse(row.result_json || "{}");
  report.coverage = result.writeback?.coverage;
  report.agentChanges = result.modelChanges?.length;
  const id = result.writeback?.approval?.id;
  if (id) {
    const res = await fetch(url + "/api/approvals/" + id + "/approve", { method: "POST" });
    const approved = await res.json();
    report.approval = { ok: approved.ok, status: approved.approval?.status, error: approved.error };
    const savedRun = ctx.store.getTrackingRun(run.runId);
    report.runStatus = savedRun.status;
    report.coverage = JSON.parse(savedRun.result_json || "{}").writeback?.coverage;
  }
  // Only now open the private grading fixture and re-read the actual saved file.
  const { facts } = await import("./fixtures/tencent-fy25-expected.mjs");
  const expected = normalizeActuals(facts);
  const values = await readCells(working, expected.map(f => f.sheet+"!"+f.cell));
  report.grades = reconcileActuals(expected, values);
  report.passed = report.grades.filter(r => r.matched).length;
  report.total = expected.length;
  const formulas = expected.filter(r => r.mode === "formula");
  const formulaText = await readCells(working, formulas.map(r => r.sheet + "!" + r.cell), { formulas: true });
  report.formulas = formulas.map(r => ({ ref: r.sheet+"!"+r.cell, expected: r.formula, actual: formulaText[r.sheet+"!"+r.cell] }));
  report.forecast = { before: oldForecast, after: await readCells(working, forecastRefs) };
  report.summaryOutputs = await readCells(working, ["K37","BB37","K45","BB45","K46","BB46"].map(ref => "Annual & Quarterly!"+ref));
  report.working = working;
  report.originalUnchanged = (await sha(original)) === hash && (await sha(path.join(ctx.root, xlsx))) === hash;
  assert.deepEqual(await readCells(working, forecastRefs, { formulas: true }), future);
  assert.ok(report.originalUnchanged);
  await save();
  console.log(JSON.stringify({ approval: report.approval, passed: report.passed, total: report.total, agentChanges: report.agentChanges }));
  assert.ok(report.approval?.ok, row.message || report.approval?.error);
  assert.equal(report.passed, report.total, "Held-out workbook checks");
} finally { await save(); await app.close(); }
