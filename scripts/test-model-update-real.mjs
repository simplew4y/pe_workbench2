// node scripts/test-model-update-real.mjs original.xlsx delivery.xlsx FY2025=annual.pdf 1H26=interim.pdf
// Prefix a period with '?' to assert that a preliminary disclosure produces gaps only.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "../store.mjs";
import { applyModelChanges } from "../lib/model-writer.mjs";
import { createApprovalService } from "../lib/approvals/service.mjs";
import { sha256File } from "../lib/model-disclosure.mjs";
import { createUpdateModelTool } from "../lib/tracking-tool.mjs";
import { createTrackingService } from "../server/tracking/service.mjs";

const [source, delivery, ...filings] = process.argv.slice(2);
assert.ok(source && delivery && filings.length, "Supply an input model, a new output .xlsx and PERIOD=filing.pdf");
assert.notEqual(path.resolve(source), path.resolve(delivery));
const root = await fs.mkdtemp(path.join(os.tmpdir(), "pe-live-filing-"));
const workspace = path.join(root, "project");
await fs.mkdir(path.join(workspace, "uploads"), { recursive: true });
const store = await openStore({ root, workspace, projectId: "test", seed: false });
const ctx = { id: "test", root: workspace, store };
const tracking = createTrackingService({ config: { webFetch: true }, bus: { broadcastGlobal() {} },
  projectManager: {}, sessions: {}, broadcastMaterial() {}, broadcastTracking() {} });
ctx.approvals = createApprovalService({ store, applyModelChanges, libreOfficeAvailable: true, broadcast() {} });
const tool = createUpdateModelTool(args => tracking.updateModel(ctx, args));
async function upload(file) {
  const rel = path.posix.join("uploads", path.basename(file));
  await fs.copyFile(file, path.join(workspace, rel), fs.constants.COPYFILE_EXCL);
  store.indexFile(rel, { kind: "input" });
  return rel;
}
try {
  const original = await sha256File(source);
  const modelPath = await upload(source);
  const runs = [];
  let latest;
  for (const spec of filings) {
    const match = /^(\??)(FY20\d{2}|[1-4]Q\d{2}|[12]H\d{2})=(.+)$/.exec(spec);
    assert.ok(match, "Invalid period or filing path");
    const [, gapOnly, period, pdf] = match;
    const remote = /^https?:\/\//i.test(pdf);
    const disclosureFile = remote ? pdf : await upload(pdf);
    const args = { modelPath, disclosureFile, period };
    const preview = (await tool.execute("preview", args)).details;
    if (remote) {
      assert.ok(preview.sourceUrl && preview.sha256);
      assert.equal(await sha256File(path.join(workspace, preview.source)), preview.sha256);
      args.disclosureFile = preview.source;
    }
    if (gapOnly) {
      assert.equal(preview.rows.length, 0);
      assert.ok(preview.gaps.length);
      runs.push({ period, disclosureFile, preview });
      continue;
    }
    assert.ok(preview.rows.length, JSON.stringify(preview.issues));
    const network = globalThis.fetch;
    let proposal;
    try {
      if (remote) globalThis.fetch = () => { throw new Error("Approval must use the archived PDF"); };
      proposal = (await tool.execute("submit", { ...args, disclosureFile, previewId: preview.previewId })).details;
    } finally {
      globalThis.fetch = network;
    }
    assert.ok(proposal.result.writeback.approval, proposal.result.summary);
    const approved = await ctx.approvals.approve({ ctx, id: proposal.result.writeback.approval.id });
    assert.equal(approved.ok, true, approved.error);
    const result = JSON.parse(store.getTrackingRun(proposal.runId).result_json);
    if (remote) assert.equal(result.writeback.coverage.sourceUrl, preview.sourceUrl);
    const model = result.writeback.model;
    assert.ok(model.analysis.checks.length && model.analysis.checks.every(c => ["pass","existing"].includes(c.status)));
    assert.equal(result.writeback.coverage.matched, preview.rows.length);
    latest = path.join(workspace, model.file);
    const sha = await sha256File(latest);
    const repeated = (await tool.execute("preview", args)).details;
    const settled = (await tool.execute("submit", { ...args, previewId: repeated.previewId })).details;
    assert.equal(settled.result.modelChanges.length, 0, "The same filing produced additional changes");
    assert.ok(!settled.result.writeback.approval);
    assert.equal(store.findMaterialByPath(model.file).versions[0].v, model.version);
    assert.equal(await sha256File(latest), sha);
    runs.push({ period, disclosureFile, preview, result, repeatedStatus: settled.result.status,
      repeatedCoverage: settled.result.writeback.coverage.complete, sha256: sha });
    console.log(period, preview.rows.length, "rows verified, repeat produced zero changes");
  }
  assert.equal(await sha256File(source), original);
  assert.equal(await sha256File(path.join(workspace, modelPath)), original);
  assert.ok(latest, "No workbook was published");
  await fs.mkdir(path.dirname(delivery), { recursive: true });
  await fs.copyFile(latest, delivery, fs.constants.COPYFILE_EXCL);
  await fs.writeFile(delivery + ".json", JSON.stringify({ modelPath, original, runs }, null, 2), { flag: "wx" });
} finally {
  store.close?.();
  await fs.rm(root, { recursive: true, force: true });
}
