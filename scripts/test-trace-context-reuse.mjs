import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { assessContextBudget, fitContextMessages, reuseWorkbookTraceEvidence } from "../lib/context-budget.mjs";

const user = { role: "user", content: "复核模型目标价" };
const detail = "- Discount PE!H29 · 目标价 · 角色 computed · =H27*H28 · 缓存值 129.017 · ↑ Discount PE!H27、Discount PE!H28";
const distinct = "- Discount PE!H28 · 折现系数 · 角色 computed · =1/H26 · 缓存值 0.70";
const trace = (id, overrides = {}, lines = [detail, distinct]) => ({
  role: "toolResult", toolName: "workbook_trace", toolCallId: id,
  details: { mode: "rows", status: "ready", materialId: "M1", version: 1, sha256: "hash1",
    cells: [{ ref: "Discount PE!H29" }, { ref: "Discount PE!H28" }], ...overrides },
  content: [{ type: "text", text: ["行枚举：Discount PE 第 27-29 行", ...lines,
    "（返回单元格达到上限，已截断；请缩小行范围。）", "计算输入出处：Discount PE!H29"].join("\n") }],
});
const model = { contextWindow: 1_000_000, maxTokens: 1000 };
const first = trace("first");
const repeat = trace("repeat");
const factReceipt = { type: "text", text: "项目事实保存结果：已保存" };
repeat.content.push(factReceipt);
const before = JSON.stringify([user, first, repeat]);
const fitted = fitContextMessages([user, first, repeat], model);
assert.equal(fitted[1], first);
assert.equal(fitted[2].details, repeat.details);
assert.equal(fitted[2].content[1], factReceipt);
assert.match(fitted[2].content[0].text, /2 条逐格明细.*first/);
assert.ok(!fitted[2].content[0].text.includes(detail));
assert.match(fitted[2].content[0].text, /第 27-29 行[\s\S]*已截断[\s\S]*计算输入出处/);
assert.equal(JSON.stringify([user, first, repeat]), before);

const changed = detail.replace("129.017", "199.14");
const different = [trace("version", { version: 2 }), trace("hash", { sha256: "hash2" }),
  trace("file", { materialId: "M2" }), trace("targeted", { mode: "cell" }),
  { ...trace("error"), isError: true }, { ...trace("whatif"), toolName: "model_whatif" }];
const next = trace("next");
const candidate = trace("changed", {}, [changed, distinct]);
const input = [user, first, ...different, candidate, user, next];
const output = reuseWorkbookTraceEvidence(input);
assert.ok(different.every(message => output.includes(message)));
assert.ok(output.at(-3).content[0].text.includes(changed));
assert.equal(output.at(-1), next);
const cells = Array.from({ length: 12 }, (_, index) => ({ ref: `Discount PE!H${index + 29}` }));
const compacted = reuseWorkbookTraceEvidence([user, trace("compact", { sheet: "Discount PE", cells },
  cells.map(cell => detail.replace("Discount PE!H29", cell.ref)))])[1].content[0].text;
assert.match(compacted, /属于工作表 Discount PE/);
assert.ok(compacted.includes("H29 · 目标价 | computed | =H27*H28 | 129.017 · ↑ Discount PE!H27、Discount PE!H28"));
console.log("trace context reuse: version, scope, distinct values, provenance and transcript checks passed");

for (const file of process.argv.slice(2)) {
  const messages = readFileSync(file, "utf8").trim().split("\n")
    .map(line => JSON.parse(line).message).filter(Boolean);
  let baseline = 0;
  let optimized = 0;
  let requests = 0;
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || !(message.usage?.totalTokens > 0 || message.researchUsage?.totalTokens > 0)) continue;
    const prefix = messages.slice(0, index);
    baseline += assessContextBudget(prefix, model).inputTokens;
    optimized += assessContextBudget(reuseWorkbookTraceEvidence(prefix), model).inputTokens;
    requests++;
  }
  const replayed = reuseWorkbookTraceEvidence(messages);
  const changedResults = replayed.filter((message, index) => message !== messages[index]).length;
  const visibleLines = new Set(replayed.filter(m => m.toolName === "workbook_trace").flatMap(message =>
    message.content[0].text.split("\n").flatMap(line => {
      const parts = line.split(" | ");
      if (!message.content[0].text.startsWith("简写行") || parts.length !== 4 || !/^[A-Z]{1,3}\d+(?: · |$)/u.test(parts[0])) return [line];
      const [location, role, formula, value] = parts;
      const ref = `- ${message.details.sheet}!${location}`;
      return [line, formula === "-" ? `${ref} · 角色 ${role} · 无公式（${role}） · 常量值 ${value}`
        : `${ref} · 角色 ${role} · ${formula} · 缓存值 ${value}`];
    })));
  for (const [index, message] of messages.entries()) {
    if (replayed[index] === message) continue;
    assert.equal(replayed[index].details, message.details);
    assert.deepEqual(replayed[index].content.slice(1), message.content.slice(1));
    for (const line of message.content[0].text.split("\n")) assert.ok(visibleLines.has(line), line);
  }
  console.log({ file, assistantRecords: requests, changedResults, baseline, optimized,
    estimatedInputReductionPct: baseline ? +(100 * (baseline - optimized) / baseline).toFixed(2) : null });
}
