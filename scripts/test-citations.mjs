import assert from "node:assert/strict";

import {
  CITATION,
  validateCitation,
  validateCitations,
} from "../lib/contracts/citation.mjs";
import { citationLookup, citationsFromTrace, collectCitationsFromToolCalls, rehydrateCitations } from "../lib/citations.mjs";
import { formatResult, indexGraph, queryGraph } from "../lib/workbook-query.mjs";
import { traceGraph } from "../lib/workbook-trace.mjs";
import { createWorkbookTool } from "../lib/workbook-tool.mjs";
import { createWorkbookTraceTool } from "../lib/workbook-trace-tool.mjs";
import { createRatioTool, createUnitConvertTool } from "../lib/calc-tool.mjs";

const doc = {
  sheets: [{ name: "Model" }],
  cells: [
    ["Model!A1", null, 100, 1, 1, "收入", "2024"],
    ["Model!B1", null, 110, 1, 2, "收入", "2025"],
    ["Model!A2", "=B1-A1", 10, 2, 1, "增长", ""],
    ["Model!C2", "=B1/A1", 1.1, 2, 3, "增速", ""],
  ],
  edges: [
    ["Model!A1", "Model!A2"],
    ["Model!B1", "Model!A2"],
    ["Model!A1", "Model!C2"],
    ["Model!B1", "Model!C2"],
  ],
};
const graph = indexGraph(doc);
const hit = queryGraph(graph, "Model!A1");
assert.equal(hit.miss, false, "fixture hit must not be a miss");
const hitResult = { ...hit, text: formatResult(hit), path: "model.xlsx", sha256: "sha-1" };
const material = { id: "mat-1", path: "model.xlsx", versions: [{ v: 3 }], sha256: "sha-1" };
const store = {
  findMaterialByPath: () => material,
  indexFile: () => material,
};
const workbooks = {
  queryMaterial: async () => hitResult,
  traceMaterial: async () => ({ ...traceGraph(graph, { cell: "Model!A2" }), text: "trace text" }),
};
const queryTool = createWorkbookTool({ store, workbooks, workspace: "/tmp" });
const traceTool = createWorkbookTraceTool({ store, workbooks, workspace: "/tmp" });

/* C1: every returned hit cell has a real citation. */
const queryOut = await queryTool.execute("tc-query", { path: "model.xlsx", query: "Model!A1" });
assert.equal(queryOut.isError, undefined);
assert.equal(queryOut.details.citations.length, queryOut.details.cells.length);
const hitCitation = queryOut.details.citations.find((citation) => citation.locator === "Model!A1");
assert.ok(hitCitation, "the direct hit must have a citation");
assert.equal(hitCitation.materialId, "mat-1");
assert.equal(hitCitation.version, 3);
assert.equal(hitCitation.locator, "Model!A1");
assert.equal(hitCitation.value, 100);
assert.equal(hitCitation.toolCallId, "tc-query");
assert.ok(validateCitation(hitCitation).ok, "produced citation must satisfy the contract");
assert.equal(citationLookup(queryOut.details.citations).get("model!a1")?.id, hitCitation.id);
console.log("C1 hit cell citation passed");

/* C1b: trace returns citations for the target and its real dependencies, never for empty cells. */
const traceOut = await traceTool.execute("tc-trace", { path: "model.xlsx", cell: "Model!A2" });
assert.equal(traceOut.isError, undefined);
const traceLocators = new Set(traceOut.details.citations.map((citation) => citation.locator));
for (const locator of ["Model!A2", "Model!A1", "Model!B1"]) assert.ok(traceLocators.has(locator), locator);
assert.equal(traceOut.details.citations.every((citation) => citation.materialId === "mat-1"), true);
assert.equal(traceOut.details.citations.every((citation) => citation.toolCallId === "tc-trace"), true);
console.log("C1b trace citations passed");

/* C1c: a scanned blank in a range is a locator-only citation, so the rectangle can be verified. */
{
  const rangeDoc = {
    sheets: [{ name: "Model" }],
    cells: [
      ["Model!B2", null, 1, 2, 2, "a", ""],
      ["Model!C2", null, 2, 2, 3, "b", ""],
      ["Model!C3", null, 4, 3, 3, "d", ""],
    ],
    edges: [],
  };
  const ranged = traceGraph(rangeDoc, { cell: "Model!B2:C3" });
  const rangeCitations = citationsFromTrace(ranged, { id: "mat-1", version: 3 }, { toolCallId: "tc-range" });
  const blank = rangeCitations.find((citation) => citation.locator === "Model!B3");
  assert.ok(blank, "a scanned empty cell must keep its locator");
  assert.equal(blank.value ?? null, null);
  assert.equal(blank.materialId, "mat-1");
  assert.ok(validateCitation(blank).ok, "an empty-cell citation must satisfy the contract");
  for (const locator of ["Model!B2", "Model!C2", "Model!C3"]) {
    assert.ok(rangeCitations.some((citation) => citation.locator === locator), locator);
  }
  console.log("C1c range empty citation passed");
}

/* C2: a miss has no clickable citation and never invents a locator. */
const missWorkbooks = { queryMaterial: async () => ({ ...queryGraph(graph, "Model!Z9"), text: "未找到" }) };
const missTool = createWorkbookTool({ store, workbooks: missWorkbooks, workspace: "/tmp" });
const missOut = await missTool.execute("tc-miss", { path: "model.xlsx", query: "Model!Z9" });
assert.equal(missOut.isError, true);
assert.deepEqual(missOut.details.citations || [], []);
const keywordMiss = queryGraph(graph, "完全不存在的关键词");
assert.equal(keywordMiss.miss, true);
const keywordTool = createWorkbookTool({
  store,
  workbooks: { queryMaterial: async () => ({ ...keywordMiss, text: formatResult(keywordMiss) }) },
  workspace: "/tmp",
});
const keywordOut = await keywordTool.execute("tc-keyword-miss", { path: "model.xlsx", query: "完全不存在的关键词" });
assert.deepEqual(keywordOut.details.citations || [], []);
console.log("C2 miss citations passed");

/* C3: unit_convert / ratio carry the result citation and derivedFrom. */
const source = { id: "src-unit", materialId: "mat-1", version: 3, locator: "Model!D4", value: 7053443, role: "input" };
const unitTool = createUnitConvertTool();
const unitOut = await unitTool.execute("tc-unit", {
  value: "7053443",
  from_unit: "Rmb mn",
  to_unit: "亿元",
  citations: [source],
});
assert.equal(unitOut.isError, undefined);
assert.equal(unitOut.details.citations.length, 1);
assert.deepEqual(unitOut.details.citations[0].derivedFrom, ["src-unit"]);
assert.equal(unitOut.details.citations[0].materialId, "mat-1");
assert.equal(unitOut.details.citations[0].locator, "Model!D4");
assert.equal(unitOut.details.citations[0].role, "derived_unit");
assert.equal(unitOut.details.citations[0].value, "70534.43");
assert.ok(validateCitation(unitOut.details.citations[0]).ok);

const ratioTool = createRatioTool();
const ratioOut = await ratioTool.execute("tc-ratio", {
  numerator: 110,
  denominator: 100,
  op: "/-1",
  asPercent: true,
  citations: [
    { id: "src-a", materialId: "mat-1", version: 3, locator: "Model!B1", value: 110 },
    { id: "src-b", materialId: "mat-1", version: 3, locator: "Model!A1", value: 100 },
  ],
});
assert.equal(ratioOut.details.citations.length, 1);
assert.deepEqual(ratioOut.details.citations[0].derivedFrom, ["src-a", "src-b"]);
assert.equal(ratioOut.details.citations[0].role, "derived_ratio");
assert.equal(ratioOut.details.citations[0].value, "10");
// No source citation => no invented locator.
const bareUnit = await unitTool.execute("tc-unit-bare", { value: "1", from_unit: "万元", to_unit: "元" });
assert.deepEqual(bareUnit.details.citations, []);
const badSource = await unitTool.execute("tc-unit-bad", {
  value: "1",
  from_unit: "万元",
  to_unit: "元",
  citations: [{ id: "bad", materialId: "", locator: "not-a-locator" }],
});
assert.deepEqual(badSource.details.citations, []);
console.log("C3 derived citations passed");

/* C4: schema rejects missing materialId / locator and accepts the full shape. */
assert.equal(CITATION.validate({ id: "x", locator: "Model!A1" }).ok, false);
assert.equal(CITATION.validate({ id: "x", materialId: "mat-1", locator: "" }).ok, false);
assert.equal(CITATION.validate({ id: "x", materialId: "mat-1", locator: "not-a-locator" }).ok, false);
const valid = { id: "x", materialId: "mat-1", version: 1, locator: "Model!A1", value: 1, derivedFrom: [] };
assert.equal(CITATION.validate(valid).ok, true);
const partiallyValid = validateCitations([valid, { id: "broken", locator: "Model!A2" }]);
assert.equal(partiallyValid.ok, false);
assert.equal(partiallyValid.value.length, 1);
console.log("C4 citation schema passed");

/* Session aggregation keeps only validated citations from this turn's tools. */
const collected = collectCitationsFromToolCalls([
  { details: { citations: queryOut.details.citations } },
  { details: { citations: [{ id: "bad", locator: "Model!B1" }] } },
  { details: { citations: unitOut.details.citations } },
]);
assert.equal(collected.length, queryOut.details.citations.length + 1);
assert.equal(collected.some((citation) => citation.id === hitCitation.id), true);
assert.equal(collected.some((citation) => citation.role === "derived_unit"), true);
console.log("session citation aggregation passed");
const locked={materialId:'mat-1',version:3,locator:'Model!A1',value:100,display_unit:'亿元'};
const restored=rehydrateCitations({register:{facts:[{status:'current',citation:locked}]},answer:'收入为100亿元。',thisTurnCitations:[]});
assert.equal(restored.length,1);
assert.equal(rehydrateCitations({register:{facts:[{status:'stale_source',citation:locked}]},answer:'收入为100亿元。'}).length,0);
assert.equal(rehydrateCitations({register:{facts:[{status:'current',citation:locked}]},answer:'收入为101亿元。'}).length,0);
assert.equal(rehydrateCitations({register:{facts:[{status:'current',citation:locked}]},answer:'收入为100亿元。',currentVersions:{'mat-1':4}}).length,0);
assert.equal(rehydrateCitations({register:{facts:[{status:'current',citation:{value:100}}]},answer:'收入为100亿元。'}).length,0);
console.log('citation rehydration R11-R13 passed');
console.log("citations: passed");
