// An actual PDF, forecast formulas, model-native checks and the real approval pipeline.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { openStore } from "../store.mjs";
import { createTrackingService } from "../server/tracking/service.mjs";
import { createApprovalService } from "../lib/approvals/service.mjs";
import { applyModelChanges, prepareWorkingModel } from "../lib/model-writer.mjs";
import { sha256File } from "../lib/model-disclosure.mjs";
import { createUpdateModelTool } from "../lib/tracking-tool.mjs";
import { handleTracking } from "../server/routes/tracking.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pe-update-e2e-"));
const workspace = path.join(root, "project");
await fs.mkdir(path.join(workspace, "uploads"), { recursive: true });
const store = await openStore({ root, workspace, projectId: "test", seed: false });
const ctx = { id: "test", root: workspace, store };
try {
  execFileSync(process.env.PYTHON_BIN || "python3", [
    path.join(import.meta.dirname, "fixtures/make-model-update.py"), path.join(workspace, "uploads")
  ]);
  store.indexFile("uploads/model.xlsx", { kind:"input" });
  store.indexFile("uploads/results.pdf", { kind:"input" });
  const source = path.join(workspace, "uploads/model.xlsx");
  const original = await sha256File(source);
  const broadcasts = [];
  const service = createTrackingService({ config:{}, bus:{broadcastGlobal(){}}, projectManager:{}, sessions:{},
    broadcastMaterial(material){ broadcasts.push(material); }, broadcastTracking(){} });
  ctx.approvals = createApprovalService({store, applyModelChanges, libreOfficeAvailable:true, broadcast(){}});
  const tool = createUpdateModelTool(args => service.updateModel(ctx,args));
  const args = {modelPath:"uploads/model.xlsx", disclosureFile:"uploads/results.pdf", period:"2Q26",
    outputs:[{label:"Target",sheet:"Model",cell:"E3"}], tolerances:{"Model!D4":0.005}};
  await fs.copyFile(source, path.join(workspace, "uploads/legacy.xlsx"));
  const legacy = store.indexFile("uploads/legacy.xlsx", { kind: "input" });
  const legacyTracking = store.createTracking({ targetId: legacy.id, templateId: "model", freq: "weekly", time: "09:00" });
  async function modelRequest(suffix, body) {
    return handleTracking({
      req: { method: body ? "POST" : "GET" },
      res: {},
      url: new URL(`http://localhost/api/trackings/${legacyTracking.id}/model${suffix}`),
      ctx,
      app: {
        ...service, prepareWorkingModel, broadcastMaterial() {},
        http: { json: (_, status, data) => ({ status, ...data }), readJson: async () => body },
      },
    });
  }
  assert.equal((await modelRequest("")).available, false);
  const legacySetup = await modelRequest("/prepare", {});
  assert.equal(legacySetup.status, 200, legacySetup.error);
  assert.equal(legacySetup.model.working_from, legacy.relPath);
  assert.equal(await sha256File(path.join(workspace, legacySetup.model.working_file)), original);
  const bindings = { outputs: args.outputs, writeEnabled: true };
  const bind = cell => modelRequest("/bindings", { ...bindings, bindings: [{ sheet: "Model", cell, verified: true }] });
  assert.equal((await bind("E2")).status, 400);
  assert.equal((await bind("D2")).status, 200);
  const preview = (await tool.execute("preview",args)).details;
  assert.equal(preview.rows[0]?.expected,104,JSON.stringify(preview));
  assert.equal(preview.checks[0].status,"pass");
  assert.equal(preview.checks[1].status,"pass");
  assert.equal(preview.rows[1].disclosedValue,21);
  assert.equal(preview.rows[1].expected,0.21);
  assert.equal(preview.rows[2].expected,22);
  const frozen = { ...args, outputs: [{ sheet: "Model", cell: "D2", label: "Static target" }] };
  const frozenPreview = (await tool.execute("preview", frozen)).details;
  assert.ok(frozenPreview.issues.some(issue => issue.includes("Model!D2 是静态值")));
  await assert.rejects(tool.execute("submit", { ...frozen, previewId: frozenPreview.previewId }), /静态值/);
  store.indexFile("uploads/annual.pdf",{kind:"input"});
  const annual = (await tool.execute("annual",{...args,period:"FY2026",disclosureFile:"uploads/annual.pdf"})).details;
  assert.equal(annual.rows[0].ref,"Annual!D3");
  store.indexFile("uploads/status-code.xlsx",{kind:"input"});
  const codes = (await tool.execute("status",{...args,modelPath:"uploads/status-code.xlsx"})).details;
  assert.equal(codes.checks[0].status,"unverified");
  const submitted = (await tool.execute("propose",{...args,previewId:preview.previewId})).details;
  assert.equal(store.getTracking(submitted.trackingId).enabled,false);
  assert.ok(!store.listMaterials().some(m => m.relPath.endsWith("工作模型.xlsx") &&
    m.relPath !== legacySetup.model.working_file));
  assert.ok(!broadcasts.some(m => m.relPath.endsWith("工作模型.xlsx")));
  const approved = await ctx.approvals.approve({ctx,id:submitted.result.writeback.approval.id});
  assert.equal(approved.ok,true,approved.error);
  const result = JSON.parse(store.getTrackingRun(submitted.runId).result_json);
  const model = result.writeback.model;
  assert.ok(store.listMaterials().some(m => m.id === model.materialId));
  assert.equal(model.analysis.checks[0].status,"pass");
  const actual = model.analysis.comparisons.find(row=>row.kind==="actual");
  assert.deepEqual([actual.before,actual.after,actual.sameDirection],[110,104,true]);
  assert.equal(model.analysis.comparisons.find(row=>row.ref==="Model!D5").after,21);
  assert.equal(model.analysis.comparisons.find(row=>row.period==="FY2026E").kind,"forecast");
  const forecast = model.analysis.comparisons.find(row=>row.kind==="forecast");
  assert.ok(Math.abs(forecast.after-114.4)<1e-8);
  assert.ok(Math.abs(model.analysis.comparisons.find(row=>row.kind==="output").after-11.44)<1e-8);
  assert.equal(await sha256File(source),original);
  const again = (await tool.execute("preview",args)).details;
  const settled = (await tool.execute("submit",{...args,previewId:again.previewId})).details;
  assert.equal(settled.result.status,"no_change");
  assert.equal(store.findMaterialByPath(model.file).versions[0].v,model.version);
  const unavailable = {...args, outputs:[{sheet:"Model",cell:"Z99",label:"未定位目标价"}]};
  const missing = (await tool.execute("missing",unavailable)).details;
  assert.ok(missing.issues.some(issue=>issue.includes("Z99")));
  const incomplete = (await tool.execute("submit",{...unavailable,previewId:missing.previewId})).details;
  assert.equal(incomplete.result.status,"needs_review");
  await assert.rejects(tool.execute("stale",{...args,previewId:preview.previewId}), /重新预览/);
  store.indexFile("uploads/unbalanced.xlsx",{kind:"input"});
  store.indexFile("uploads/other-unit.pdf",{kind:"input"});
  const wrongUnit = (await tool.execute("currency",{...args,disclosureFile:"uploads/other-unit.pdf"})).details;
  assert.equal(wrongUnit.rows.length,0);
  assert.equal(wrongUnit.gaps[0].metric,"Sales");
  const unbalanced = {...args,modelPath:"uploads/unbalanced.xlsx"};
  const badPreview = (await tool.execute("preview",unbalanced)).details;
  const badRun = (await tool.execute("submit",{...unbalanced,previewId:badPreview.previewId})).details;
  const badApproval = await ctx.approvals.approve({ctx,id:badRun.result.writeback.approval.id});
  assert.equal(badApproval.ok,false);
  assert.match(badApproval.error,/Model!D4/);
  assert.equal(store.findMaterialByPath(badApproval.approval.payload.workingModel.path).versions[0].v,1);
  if (process.env.MODEL_TEST_FILE) {
    // The PDF values below are synthetic; the source workbook is a read-only local fixture.
    await fs.copyFile(process.env.MODEL_TEST_FILE,path.join(workspace,"uploads/cxmt.xlsx"));
    store.indexFile("uploads/cxmt.xlsx",{kind:"input"});
    store.indexFile("uploads/cxmt.pdf",{kind:"input"});
    const real = {modelPath:"uploads/cxmt.xlsx",disclosureFile:"uploads/cxmt.pdf",period:"3Q26",
      outputs:[{sheet:"PL",cell:"Y25",label:"本季度净利润"}]};
    const review = (await tool.execute("preview",real)).details;
    assert.equal(review.rows[0]?.ref,"PL!Y15",JSON.stringify(review));
    assert.equal(review.checks.length,56);
    const proposal = (await tool.execute("submit",{...real,previewId:review.previewId})).details;
    const decision = await ctx.approvals.approve({ctx,id:proposal.result.writeback.approval.id});
    assert.equal(decision.ok,true,decision.error);
    assert.equal(decision.approval.decision.analysis.checks.length,56);
    console.log("PASS 长鑫模型副本 + 合成季度披露：56 个 Check，审批后回读");
  }
  console.log("PASS PDF → preview → manual proposal → approval → workbook, trend, checks and idempotent no-change");
} finally {
  store.close?.();
  await fs.rm(root,{recursive:true,force:true});
}
