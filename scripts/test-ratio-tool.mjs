import assert from "node:assert/strict";
import { createRatioTool, ratioCalc, shareOfNav, unitConvert } from "../lib/calc-tool.mjs";
import { lintAnswer } from "../lib/answer-lint.mjs";

/* DT-3 R1: percent share. */
const r1 = ratioCalc({ numerator: 12, denominator: 48, op: "%" });
assert.equal(r1.value, "25");
assert.equal(Number(r1.value), 25);
assert.match(r1.formula, /12 \/ 48/);
assert.equal(r1.op, "%");

/* DT-3 R2: relative change, decimal and percent forms. */
const r2 = ratioCalc({ numerator: 110, denominator: 100, op: "/-1" });
assert.equal(r2.value, "0.1");
assert.match(r2.formula, /110 \/ 100 - 1 = 0\.1/);
assert.equal(ratioCalc({ numerator: 110, denominator: 100, op: "/-1", asPercent: true }).value, "10");
assert.throws(() => ratioCalc({ numerator: 1, denominator: 0, op: "%" }), /零/);

/* DT-3 R3/R4: bare ratio claims are recomputed with Decimal. */
const wrong = lintAnswer("12/48=30%。");
const ratioFinding = wrong.find((item) => item.rule === "ratio_recompute" || item.rule === "percent_change");
assert.ok(ratioFinding, "12/48=30% must be flagged");
assert.equal(ratioFinding.rule, "ratio_recompute");
assert.equal(ratioFinding.code, "R1");
assert.equal(ratioFinding.severity, "error");
assert.equal(lintAnswer("12/48=25%。").length, 0, "12/48=25% is correct");
const shareWrong = lintAnswer("收入占比 20%（12/48）。").find((item) => item.rule === "ratio_recompute");
assert.ok(shareWrong);
assert.equal(lintAnswer("收入占比 25%（12/48）。").length, 0);

/* DT-3 R5: DT-1 gold must not regress. */
const gold = unitConvert({ value: "7053443", from_unit: "Rmb mn", to_unit: "亿元" });
assert.equal(gold.value, "70534.43");
assert.equal(gold.unit, "亿元");

/* DT-4 B1/B2: basis is mandatory and explicit. */
assert.throws(() => shareOfNav({ numerator: 12, nav: 48 }), /valuation_basis/);
assert.throws(() => shareOfNav({ numerator: 12, nav: 48, valuation_basis: "made_up" }), /valuation_basis/);
const pre = shareOfNav({ numerator: 12, nav: 48, valuation_basis: "pre_discount" });
assert.equal(pre.value, "25");
assert.equal(pre.valuation_basis, "pre_discount");
assert.match(pre.formula, /12 \/ 48/);

/* DT-4 B3: mixed pre/post basis in one paragraph warns (soft). */
const mixed = lintAnswer("折价前占比 25%，折价后占比 30%，两个口径混在一起。");
const mixedFinding = mixed.find((item) => item.rule === "mixed_valuation_basis");
assert.ok(mixedFinding);
assert.equal(mixedFinding.severity, "warning");
assert.equal(lintAnswer("折价前占比 25%。\n\n折价后占比 30%。").some((item) => item.rule === "mixed_valuation_basis"), false);

/* Tool contract: ratio is registered as a first-class deterministic tool. */
const tool = createRatioTool();
assert.equal(tool.name, "ratio");
const out = await tool.execute("test", { numerator: 12, denominator: 48, op: "%" });
assert.equal(out.details.value, "25");
assert.match(out.content[0].text, /公式/);
const navOut = await tool.execute("test", { numerator: 12, denominator: 48, valuation_basis: "post_discount" });
assert.equal(navOut.details.valuation_basis, "post_discount");
assert.match(navOut.content[0].text, /post_discount/);
assert.equal((await tool.execute("test", { numerator: 1, denominator: 0, op: "%" })).isError, true);

console.log("ratio tool: passed");
