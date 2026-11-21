// Exercise the same settlement code as the live agent with a controlled empty
// change list. The workbook formula intentionally starts without a cached value.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { openStore } from "../store.mjs";
import { createTrackingService } from "../server/tracking/service.mjs";
import { readCells } from "../lib/calc-engine.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "pe-zero-disclosure-"));
const workspace = path.join(root, "project");
await fs.mkdir(workspace);
const book = "results.xlsx";
const absolute = path.join(workspace, book);
execFileSync(process.env.PYTHON_BIN || "python3", ["-c", `import sys,openpyxl
w=openpyxl.Workbook()
s=w.active
s.title="IS"
s["B1"]="2025E"
s["B2"]="=2+3"
w.save(sys.argv[1])`, absolute]);
const before = await fs.readFile(absolute);
assert.equal((await readCells(absolute, ["IS!B2"]))["IS!B2"], null);
const store = await openStore({ root, workspace, projectId: "test", seed: false });
const ctx = { id: "test", root: workspace, store };
const service = createTrackingService({ config: {}, bus: { broadcastGlobal() {} }, projectManager: {}, sessions: {},
  broadcastMaterial() {}, broadcastTracking() {} });
const target = store.indexFile(book, { kind: "input" });
const track = store.createTracking({ targetId: target.id, templateId: "model", freq: "daily", time: "09:00" });
const base = { period: "FY2025", metric: "Profit", unit: "RMB mn", decimals: 0, source: "results.pdf#page=1",
  sheet: "IS", cell: "B2", header: "B1", mode: "check", expected: 5 };
try {
  for (const [name, items, gaps, issues, expectedStatus, matched, sourceGaps = []] of [
    ["match after recalculation", [base], [], [], "no_change", 1],
    ["old forecast differs", [{ ...base, expected: 6 }], [], [], "needs_review", 0],
    ["period has no model column", [base], [{ period: "3Q26", metric: "Profit", page: 2, reason: "Missing period" }], [], "needs_review", 1],
    ["wrong period binding", [{ ...base, period: "FY2026" }], [], [], "needs_review", 0],
    ["no source", [], [], ["Source unavailable"], "needs_review", 0],
    ["absent disclosure section", [base], [], [], "needs_review", 1,
      [{ period: "FY2025", metric: "EPS note", reason: "Section not located" }]],
  ]) {
    const run = store.startTrackingRun(track.id, { trigger: "manual", baseVersion: 1 });
    const resultAbs = path.join(workspace, run.id + ".json");
    await fs.writeFile(resultAbs, JSON.stringify({ status: "no_change", conclusion: "No change", modelChanges: [] }));
    await service.settleTrackingRun({ ctx, trackingId: track.id, runId: run.id, run, targetId: target.id,
      baseVersion: 1, resultAbs, disclosure: { book, inventoryPath: "", mapping: { actuals: items, gaps },
        inventory: { facts: [...items, ...gaps], source: items.length ? "results.pdf" : "", sha256: "", issues, sourceGaps } } });
    const row = store.getTrackingRun(run.id), result = JSON.parse(row.result_json);
    assert.equal(row.status, expectedStatus, name);
    assert.equal(result.writeback.coverage.matched, matched, name);
    assert.equal(result.writeback.coverage.gaps.length, gaps.length);
    assert.ok(!result.writeback.approval);
    assert.deepEqual(await fs.readFile(absolute), before);
    console.log("ok", name);
  }
} finally { store.close?.(); }
