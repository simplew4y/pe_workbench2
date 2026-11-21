// Usage: node scripts/test-tencent-actuals.mjs <original Tencent workbook> [results directory]
// Exercises real Workbench storage, approvals, workbook writer and LibreOffice.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../store.mjs";
import { createApprovalService } from "../lib/approvals/service.mjs";
import { applyModelChanges, prepareWorkingModel } from "../lib/model-writer.mjs";
import { normalizeActuals } from "../lib/model-actuals.mjs";
import { normalizeTrackingResult } from "../lib/tracking.mjs";
import { readCells, sofficeInfo } from "../lib/calc-engine.mjs";
import { createTrackingService } from "../server/tracking/service.mjs";
import { handleTracking } from "../server/routes/tracking.mjs";
import { TRACKING_RESULT } from "../lib/contracts/tracking-result.mjs";

const [source, destination = os.tmpdir()] = process.argv.slice(2);
assert.ok(source && fs.existsSync(source), "Pass the original Tencent model workbook");
fs.mkdirSync(destination, { recursive: true });
const root = fs.mkdtempSync(path.join(path.resolve(destination), "tencent-"));
const workspace = path.join(root, "project");
const inpath = "uploads/model.xlsx";
const targetPath = "exports/test/report.md";
const stateRel = "exports/test/analysis-state.json";
fs.mkdirSync(path.join(workspace, "uploads"), { recursive: true });
fs.mkdirSync(path.join(workspace, "exports/test"), { recursive: true });
fs.copyFileSync(source, path.join(workspace, inpath));
fs.writeFileSync(path.join(workspace, targetPath), "# 腾讯 FY2025 与第四季度模型核对");

const { facts } = await import("./fixtures/tencent-fy25-expected.mjs");

const actuals = normalizeActuals(facts);
const changes = actuals.filter(row => row.mode !== "check").map(row => ({
  sheet: row.sheet, cell: row.cell, metric: row.metric, value: row.formula ?? row.expected,
}));
const engine = await sofficeInfo();
assert.equal(engine.available, true, "Requires LibreOffice");
const store = await openStore({ root, workspace, projectId: "test", seed: false });
const ctx = { id: "test", root: workspace, store, name: "腾讯回归测试" };
const service = createApprovalService({ store, broadcast() {}, applyModelChanges, libreOfficeAvailable: engine.available });
store.indexFile(inpath, { kind: "input" });
const target = store.indexFile(targetPath, { source: "agent", status: "draft" });
const tracking = store.createTracking({ targetId: target.id, templateId: "model", freq: "weekly", weekday: 1, time: "09:00" });
fs.writeFileSync(path.join(workspace, stateRel), JSON.stringify({ schema_version: "2.0",
  subject: { company: "腾讯", model_file: inpath }, model: {} }));
const trackingService = createTrackingService({ config: {}, bus: { broadcastGlobal() {} },
  projectManager: { list: () => [ctx] }, sessions: {}, broadcastMaterial() {}, broadcastTracking() {} });
const app = { ...trackingService, prepareWorkingModel, broadcastMaterial() {},
  http: { json: (_res, status, payload) => ({ status, payload }), readJson: req => req.body } };
async function postModel(action, body = {}) {
  return handleTracking({ app, ctx, req: { method: "POST", body },
    url: new URL("/api/trackings/" + tracking.id + "/model/" + action, "http://localhost") });
}
const prepared = await postModel("prepare");
assert.equal(prepared.status, 200, prepared.payload.error);
const working = path.join(workspace, prepared.payload.model.working_file);
const configuration = { writeEnabled: true, actuals, outputs: [],
  bindings: changes.map(({ sheet, cell, metric }) => ({ sheet, cell, metric, verified: true })) };
const bound = await postModel("bindings", configuration);
assert.equal(bound.status, 200, bound.payload.error);
assert.deepEqual(bound.payload.model.actuals, actuals);
fs.writeFileSync(path.join(root, "bindings.json"), JSON.stringify(configuration, null, 2));
const { state } = await trackingService.readTrackingState(ctx, store.getTracking(tracking.id));
const sha = file => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const originalSha = sha(source);
assert.equal(sha(working), originalSha);
const futureRefs = ["IS!AE198", "IS!AE199", "IS!AE207", "IS!AF198", "IS!AF199"];
const future = await readCells(working, futureRefs, { formulas: true });
const report = { source: path.basename(source), originalSha, engine: engine.version, working, scenarios: [] };
const save = () => fs.writeFileSync(path.join(root, "test-result.json"), JSON.stringify(report, null, 2));
console.log("Test project", root);
for (const [name, omit, expectedMismatch] of [
  ["漏填 SSV", "AD137", "IS!AD139"], ["保留旧摊薄 EPS 公式", "AD188", "IS!AD188"], ["全部修正", null, null],
]) {
  const selected = changes.filter(c => c.cell !== omit);
  const run = store.startTrackingRun(tracking.id, { trigger: "manual", baseVersion: target.versions[0].v });
  const metadata = { trackingId: tracking.id, targetId: target.id, targetPath, templateId: "model",
    baseVersion: target.versions[0].v, resultVersion: null, nowLabel: "", duration: "", fallbackConclusion: "",
    fallbackSummary: "", status: "needs_review", runId: run.id, trigger: "manual",
    startedAt: new Date().toISOString(), endedAt: new Date().toISOString() };
  const result = normalizeTrackingResult({ status: "updated", headline: name, conclusion: name, summary: name,
    modelChanges: selected, modelOutputs: [], sources: [{ label: "腾讯 FY2025 年度业绩公告", date: "2026-03-18" }] }, metadata);
  store.finishTrackingRun(tracking.id, run.id, { status: "needs_review", message: name, result });
  const proposal = await service.propose({ ctx, tracking: store.getTracking(tracking.id), trackingRunId: run.id,
    threadId: "test", result, state, stateRel });
  assert.ok(proposal.ok, proposal.reason);
  assert.equal(proposal.proposal.actuals.length, facts.length);
  const inputSha = sha(working);
  const approved = await service.approve({ ctx, id: proposal.approval.id });
  const rows = approved.approval?.decision?.reconciliation || [];
  const mismatches = rows.filter(row => !row.matched);
  const scenario = { name, code: approved.code, status: approved.approval?.status, reason: approved.error,
    passed: rows.length - mismatches.length, total: rows.length, workingFileChanged: inputSha !== sha(working), rows };
  report.scenarios.push(scenario);
  save();
  console.log(name, JSON.stringify({ status: scenario.status, reason: scenario.reason, passed: scenario.passed, total: rows.length }));
  assert.equal(rows.length, facts.length, approved.error);
  const stored = JSON.parse(store.getTrackingRun(run.id).result_json);
  const validated = TRACKING_RESULT.validate(stored);
  assert.ok(validated.ok, JSON.stringify(validated.errors));
  assert.deepEqual(stored.writeback.reconciliation, rows);
  assert.equal(scenario.workingFileChanged, !omit);
  if (omit) {
    assert.equal(approved.code, "actuals_mismatch", approved.error);
    assert.ok(mismatches.some(row => row.ref === expectedMismatch), expectedMismatch);
    assert.equal(sha(working), originalSha);
  } else {
    assert.equal(approved.ok, true, approved.error);
    assert.equal(mismatches.length, 0);
  }
}
const summaryRefs = ["K37", "BB37", "K45", "BB45", "K46", "BB46"].map(cell => "Annual & Quarterly!" + cell);
const summary = await readCells(working, summaryRefs);
for (const [index, expected] of [280656, 69518, 24.153 * 7.8 / 7.3, 6.276 * 7.8 / 7.1, 27.877, 6.966].entries()) {
  assert.ok(Math.abs(summary[summaryRefs[index]] - expected) < 0.0001, summaryRefs[index]);
}
assert.deepEqual(await readCells(working, futureRefs, { formulas: true }), future);
assert.equal(sha(source), originalSha);
report.summary = summary;
report.futureFormulas = future;
report.originalUnchanged = true;
save();
console.log("Verified summary links, forecast formulas and original file:", path.join(root, "test-result.json"));
