import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { validateState } from "../lib/validate-state.mjs";
import { createValidateStateTool } from "../lib/validate-state-tool.mjs";

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
    falsifiers: [{ id: "F1", thesis_id: "T1", statement: "条件", metric: "收入", operator: "<", threshold: "10", source: "模型", warning: "观察", action: "复核", status: "armed", frequency: "quarterly" }],
    gaps: [], changes: [], market: { price: null }, tracking: {}, review: { status: "draft" },
  };
}
const codes = (result) => result.warnings.join("\n");
let state = fixture();
assert.equal(validateState(state).ok, true);
assert.match(codes(validateState(state)), /THRESHOLD_BASIS_MISSING/);
state.falsifiers[0].threshold = "";
assert.equal(validateState(state).ok, false, "legacy empty threshold remains invalid");
state.falsifiers[0].threshold_basis = "pending";
state.falsifiers[0].status = "unknown";
state.falsifiers[0].calibration_plan = "用三年历史分布校准";
assert.equal(validateState(state).ok, true, "pending is allowed without threshold or armed status");
delete state.falsifiers[0].calibration_plan;
assert.match(codes(validateState(state)), /CALIBRATION_PLAN_MISSING/);
assert.equal(validateState(state).ok, true);
state.falsifiers[0].status = "armed";
assert.match(codes(validateState(state)), /PENDING_FALSIFIER_ARMED/);
assert.equal(validateState(state).ok, true, "new constraints are warnings");
state = fixture();
state.falsifiers[0].threshold = "待校准";
state.falsifiers[0].status = "unknown";
assert.equal(validateState(state).ok, true);
assert.match(codes(validateState(state)), /CALIBRATION_PLAN_MISSING/);
state = fixture();
state.falsifiers[0].threshold_basis = "made_up";
assert.equal(validateState(state).ok, true);
assert.match(codes(validateState(state)), /THRESHOLD_BASIS_INVALID/);
state.valuations = [{ id: "V1", scenario: "base", method: "PE", unit: "元", formula: "10*10", value: 100 }];
assert.match(codes(validateState(state)), /VALUATION_SCENARIOS_MISSING.*bear.*bull/);
state.valuations.push(...["bear", "bull"].map((scenario, i) => ({ ...state.valuations[0], id: `V${i+2}`, scenario })));
assert.doesNotMatch(codes(validateState(state)), /VALUATION_SCENARIOS_MISSING/);
state.sensitivities = [{ id: "N1", method: "model_input", assumption_ids: ["A1"], baseline: "10", perturbation: "1", result: "11" }];
assert.match(codes(validateState(state)), /ASSUMPTION_ROLE_MISSING/);
for (const role of ["formula", "derived_from_formula", "linked", "output"]) {
  state.assumptions[0].role = role;
  assert.match(codes(validateState(state)), /DERIVED_MODEL_INPUT/);
  assert.equal(validateState(state).ok, true);
}
state.assumptions[0].role = "hardcoded_input";
assert.doesNotMatch(codes(validateState(state)), /DERIVED_MODEL_INPUT|ASSUMPTION_ROLE_MISSING/);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pe-state-warnings-"));
try {
  state.assumptions[0].role = "formula";
  fs.writeFileSync(path.join(tmp, "analysis-state.json"), JSON.stringify(state));
  const result = await createValidateStateTool({ workspace: tmp }).execute("t", { path: "analysis-state.json" });
  assert.equal(result.details.ok, true);
  assert.ok(Array.isArray(result.details.warnings));
  assert.match(result.content[0].text, /warning：[\s\S]*DERIVED_MODEL_INPUT/);
  assert.deepEqual(result.details.errors, []);
  assert.deepEqual(result.details.verifiedFacts,[]);
  const example=JSON.parse(fs.readFileSync(new URL('../skills/investment-framework/assets/analysis-state.example.json',import.meta.url),'utf8'));
  fs.writeFileSync(path.join(tmp, "analysis-state.json"),JSON.stringify(example));
  const projected=await createValidateStateTool({workspace:tmp}).execute('project',{path:'analysis-state.json'});
  assert.equal(projected.details.ok,true);
  assert.deepEqual(projected.details.verifiedFacts,[]);
  assert.equal(projected.details.factVerification,'not_performed');
  assert.equal(projected.details.candidateFacts.find(f=>f.claim==='base target_price').value,92);
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }
console.log("validate-state warnings: passed");
// Pending only relaxes the threshold/pairing case, never unrelated invalid fields.
state = fixture();
state.falsifiers[0].threshold_basis = "pending";
state.falsifiers[0].threshold = "";
state.falsifiers[0].status = "unknown";
state.falsifiers[0].source = "";
assert.equal(validateState(state).ok, false);
assert.ok(validateState(state).errors.some((message) => message.includes(".source 不能为空")));
state = fixture();
state.falsifiers[0].threshold_basis = "history";
state.falsifiers[0].status = "unknown";
assert.equal(validateState(state).ok, false, "ordinary unknown falsifier does not relax legacy pairing");
for (const basis of ["history", "model_breakpoint", "operating_constraint"]) {
  state = fixture();
  state.falsifiers[0].threshold_basis = basis;
  assert.equal(validateState(state).ok, true);
  assert.doesNotMatch(codes(validateState(state)), /THRESHOLD_BASIS_(?:MISSING|INVALID)/);
}
// DT-7 F1: explicit pending still requires a calibration plan.
state = fixture();
state.falsifiers[0].threshold_status = "pending";
state.falsifiers[0].threshold_basis = "pending";
state.falsifiers[0].status = "unknown";
assert.match(codes(validateState(state)), /CALIBRATION_PLAN_MISSING/);
// Missing status is normalized (and warned about), never silently ignored.
state = fixture();
state.falsifiers[0].threshold_basis = "history";
assert.match(codes(validateState(state)), /THRESHOLD_STATUS_MISSING/);
assert.equal(state.falsifiers[0].threshold_status, undefined, "validator does not mutate caller state");
state = fixture();
state.falsifiers[0].threshold_status = "made_up";
assert.match(codes(validateState(state)), /THRESHOLD_STATUS_INVALID/);
// DT-7 F2: a threshold justified only by this model's forecast growth is flagged.
state = fixture();
state.falsifiers[0].threshold_status = "pending";
state.falsifiers[0].threshold_basis = "model_breakpoint";
state.falsifiers[0].threshold = "仅依据本模型预测增速";
state.falsifiers[0].calibration_plan = "待校准";
state.falsifiers[0].status = "unknown";
assert.match(codes(validateState(state)), /THRESHOLD_MODEL_ONLY/);
// DT-7 F3: calibrated + history basis does not trigger the new warning.
state = fixture();
state.falsifiers[0].threshold_status = "calibrated";
state.falsifiers[0].threshold_basis = "history";
assert.doesNotMatch(codes(validateState(state)), /THRESHOLD_MODEL_ONLY|THRESHOLD_STATUS_(?:MISSING|INVALID)/);
console.log("validate-state DT-7: passed");
