import assert from "node:assert/strict";
import { ratioCalc, shareOfNav, unitConvert } from "../lib/calc-tool.mjs";
import { lintAnswer } from "../lib/answer-lint.mjs";
import { formatResult, indexGraph, queryGraph } from "../lib/workbook-query.mjs";
import { summarizeLedger } from "../lib/ledger.mjs";
import { checkTurnTools } from "../lib/turn-context.mjs";
import { validateState } from "../lib/validate-state.mjs";

/* DT-1 gold: 7,053,443 Rmb mn = 70,534.43 亿元. */
const gold = unitConvert({ value: "7053443", from_unit: "Rmb mn", to_unit: "亿元" });
assert.equal(gold.value, "70534.43");
assert.equal(gold.unit, "亿元");
assert.equal(unitConvert({ value: "7053443", from_unit: "百万元", to_unit: "亿元" }).value, "70534.43");

/* DT-2 T1: ledger summary only shows the current value, never the superseded one. */
const ledger = {
  version: 1, sessionId: "s", facts: [], open: [], claims: [],
  corrections: [{ id: "C1", claim: "金额", from: 7.3, to: 72.93, unit: "亿元" }],
};
const summary = summarizeLedger(ledger);
assert.match(summary, /72\.93/);
assert.ok(!/(?:^|[^\d.])7\.3(?!\d)/.test(summary), "superseded 7.3 must not come back in the summary");
assert.ok(!summary.includes("全部正确"));

/* DT-3: ratio and percent-change are deterministic. */
assert.equal(ratioCalc({ numerator: 12, denominator: 48, op: "%" }).value, "25");
assert.equal(ratioCalc({ numerator: 110, denominator: 100, op: "/-1" }).value, "0.1");
assert.equal(ratioCalc({ numerator: 110, denominator: 100, op: "/-1", asPercent: true }).value, "10");
assert.match(ratioCalc({ numerator: 12, denominator: 48, op: "%" }).formula, /12 \/ 48/);

/* DT-4: NAV basis is mandatory. */
assert.throws(() => shareOfNav({ numerator: 1, nav: 2 }), /valuation_basis/);
assert.equal(shareOfNav({ numerator: 12, nav: 48, valuation_basis: "pre_discount" }).value, "25");

/* DT-5 M1-M3: miss flag, reason, and coverage. */
const graph = indexGraph({
  sheets: [{ name: "Model" }],
  cells: [
    ["Model!A1", "=1+1", 2, 1, 1, "收入", "2025E"],
    ["Model!B1", null, 3, 1, 2, "成本", "2025E"],
  ],
  edges: [],
});
const missingSheet = queryGraph(graph, "Missing!A1");
assert.equal(missingSheet.miss, true);
assert.match(missingSheet.missReason, /未找到工作表/);
assert.equal(missingSheet.coverage.namedSheetsOk, false);
assert.match(formatResult(missingSheet), /未找到/);
const missingCell = queryGraph(graph, "Model!Z9");
assert.equal(missingCell.miss, true);
assert.ok(missingCell.coverage.note.length > 0);
assert.match(formatResult(missingCell), /未找到/);
const hit = queryGraph(graph, "Model!A1");
assert.notEqual(hit.miss, true);
assert.equal(hit.exact, true);
assert.equal(hit.coverage.namedSheetsOk, true);

/* DT-6/8/9: role, checklist, currency lint. */
assert.equal(lintAnswer("A1 是手填的。", { cellRoles: { "A1": "formula" } }).find((x) => x.rule === "role_mismatch")?.code, "D6");
assert.equal(lintAnswer("A1 是手填的。", { cellRoles: { "A1": "hardcoded_input" } }).some((x) => x.rule === "role_mismatch"), false);
assert.equal(lintAnswer("# 结论\n内容。", { requiredSections: ["结论", "风险"] }).find((x) => x.rule === "missing_section")?.severity, "error");
assert.equal(lintAnswer("完成。", { requiredSections: [] }).some((x) => x.rule === "missing_section"), false);
assert.equal(lintAnswer("估值 ¥100。", { reportCurrency: "HKD" }).find((x) => x.rule === "currency_symbol")?.code, "C9");
assert.equal(lintAnswer("估值 HK$100。", { reportCurrency: "HKD" }).some((x) => x.rule === "currency_symbol"), false);

/* DT-5 negative lookup proof gate (soft warning). */
const noProof = checkTurnTools({ answer: "未找到该工作表的数据。", routes: ["ticker"], toolCalls: [] });
assert.equal(noProof.find((x) => x.rule === "missing_miss_proof")?.severity, "warning");
const proved = checkTurnTools({ answer: "未找到该工作表的数据。", routes: ["ticker"], toolCalls: [{ name: "workbook_query", success: true, details: { miss: true } }] });
assert.equal(proved.some((x) => x.rule === "missing_miss_proof"), false);

/* DT-7: threshold_status normalization + model-only warning. */
function fixture() {
  return {
    schema_version: "2.0", revision: 1, stage: "draft", framework_id: "test",
    subject: { company: "测试", currency: "RMB", units: "百万元", data_cutoff: null },
    model: { understanding: { revenue: "", costs_profit: "", cash_flow: "", valuation: "" }, checks: [] },
    sources: [{ id: "S1", name: "模型", locator: "model.xlsx" }],
    evidence: [{ id: "E1", statement: "事实", source_ids: ["S1"], kind: "model_input", locator: "A1" }],
    assumptions: [{ id: "A1", statement: "假设", kind: "model_input" }],
    theses: [{ id: "T1", statement: "观点", mechanism: "机制", horizon: "一年", alternatives: "其他", confidence_reason: "证据", status: "active", confidence: "medium", assumption_ids: ["A1"], support_ids: ["E1"], counter_ids: [] }],
    sensitivities: [], valuations: [],
    falsifiers: [{ id: "F1", thesis_id: "T1", statement: "条件", metric: "收入", operator: "<", threshold: "仅依据本模型预测增速", source: "模型", warning: "观察", action: "复核", status: "unknown", frequency: "quarterly", threshold_basis: "pending", threshold_status: "pending", calibration_plan: "待校准" }],
    gaps: [], changes: [], market: { price: null }, tracking: {}, review: { status: "draft" },
  };
}
const pending = validateState(fixture());
assert.match(pending.warnings.join("\n"), /THRESHOLD_MODEL_ONLY/);
const calibrated = fixture();
calibrated.falsifiers[0].threshold_status = "calibrated";
calibrated.falsifiers[0].threshold_basis = "history";
calibrated.falsifiers[0].threshold = "10";
const calibratedWarnings = validateState(calibrated).warnings.join("\n");
assert.doesNotMatch(calibratedWarnings, /THRESHOLD_MODEL_ONLY|THRESHOLD_STATUS_(?:MISSING|INVALID)/);

console.log("dt regression: passed");
