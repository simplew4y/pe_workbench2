import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { getModel } from "@earendil-works/pi-ai/compat";
import { stream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js";
import { assessContextBudget, fitContextMessages } from "../lib/context-budget.mjs";
import { createTraceReplayTool } from "../lib/trace-replay.mjs";

const model = { contextWindow: 1_000_000, maxTokens: 384_000 };
const fit = messages => fitContextMessages(messages, model, undefined, undefined, { traceReplay: true });
const question = { role: "user", content: "目标价和折现公式是多少？" };
const assistant = { role: "assistant", content: [{ type: "text", text: "下一步核验" }] };
const target = { ref: "Discount PE!H29", formula: "=H27*H28", value: 129.017, display_unit: "元",
  role: "computed", cacheStatus: "cached", upstreamRefs: ["Discount PE!H27", "Discount PE!H28"] };
const citation = { locator: target.ref, materialId: "model", version: 1, value: target.value };
const lines = Array.from({ length: 100 }, (_, index) =>
  `- Discount PE!B${index + 1} · 假设 · 角色 constant · 无公式（constant） · 常量值 ${index}`);
const full = ["追踪 模型.xlsx", "行枚举：Discount PE 第 1-100 行", ...lines,
  "- Discount PE!H29 · 目标价 · 角色 computed · =H27*H28 · 缓存值 129.017 · ↑ Discount PE!H27、Discount PE!H28",
  "（输出已截断，请缩小范围）", "计算输入出处：Discount PE!H29"].join("\n");
const trace = { role: "toolResult", toolName: "workbook_trace", toolCallId: "original", content: [{ type: "text", text: full }],
  details: { mode: "rows", status: "ready", version: 1, sha256: "old-sha", path: "模型.xlsx",
    cells: [target], citations: [citation], truncated: true } };
const whatif = { ...trace, toolName: "model_whatif", toolCallId: "scenario" };
const path = { ...trace, toolCallId: "path", details: { ...trace.details, mode: "path" } };
const before = JSON.stringify(trace);
const next = [question, assistant, trace, whatif, path];
const batch={...trace,toolCallId:"batch",details:{...trace.details,mode:"batch",subtraces:[
  {mode:"cell",target,direct:[]},{mode:"rows",sheet:"Assumption",rowStart:1,rowEnd:100,returned:100,truncated:true},
  {error:"工作表不存在"},
]}};
assert.equal(fit([question,assistant,batch])[2],batch);
const batchCard=fit([question,assistant,batch,assistant])[2];
assert.match(batchCard.content[0].text,/H29[\s\S]*129\.017[\s\S]*Assumption[\s\S]*原图截断=true[\s\S]*工作表不存在/);
assert.ok(batchCard.content[0].text.length < full.length/2);
assert.equal(batchCard.details,batch.details);
assert.equal(fit(next)[2], trace);
assert.equal(fit([...next, { ...assistant, stopReason: "error" }])[2], trace);
const projected = fit([...next, assistant]);
assert.match(projected[2].content[0].text, /old-sha[\s\S]*H29[\s\S]*=H27\*H28[\s\S]*129\.017[\s\S]*已截断/);
assert.match(projected[2].content[0].text, /workbook_trace_replay/);
assert.ok(projected[2].content[0].text.length < full.length / 2);
assert.equal(projected[2].details, trace.details);
assert.equal(projected[3], whatif);
assert.equal(projected[4], path);
assert.equal(JSON.stringify(trace), before);

const replay = createTraceReplayTool({ getMessages: () => next });
assert.equal((await replay.execute("new", { callId: "outside" })).isError, true);
const lookup = await replay.execute("new", { callId: "original", ref: target.ref });
const decoded = JSON.parse(lookup.content[0].text);
assert.deepEqual(decoded.cell, target);
assert.deepEqual(decoded.citations, [citation]);
assert.equal(decoded.sha256, "old-sha");
const page = await replay.execute("new", { callId: "original" });
const end = await replay.execute("new", { callId: "original", offset: page.details.traceReplayPage.nextOffset });
assert.equal([page, end].map(result => result.content[0].text.split("\n").slice(1).join("\n")).join(""), full);
const pageMessage = { ...page, role: "toolResult", toolName: replay.name };
assert.equal(fit([...next, assistant, pageMessage]).at(-1), pageMessage);
assert.match(fit([...next, assistant, pageMessage, assistant]).at(-2).content[0].text, /按 callId 和 offset 回读/);
const providerModel = getModel("deepseek", "deepseek-flash");
const call = { ...assistant, api: providerModel.api, provider: providerModel.provider, model: providerModel.id,
  stopReason: "toolUse", content: [{ type: "toolCall", id: trace.toolCallId, name: trace.toolName, arguments: { path: trace.details.path } }] };
async function wire(messages) {
  let payload;
  await stream(providerModel, { messages: fit(messages) }, { apiKey: "offline-fixture", onPayload(request) {
    payload = request;
    throw new Error("stop before network");
  } }).result();
  return payload.messages.find(message => message.tool_call_id === trace.toolCallId)?.content;
}
assert.equal(await wire([question, call, trace]), full);
assert.match(await wire([question, call, trace, question]), /workbook_trace_replay/);
console.log("trace replay: first delivery, later projection, evidence, scenario, path, transcript and pagination PASS");

for (const file of process.argv.slice(2)) {
  const messages = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line).message).filter(Boolean);
  let baseline = 0;
  let optimized = 0;
  let requests = 0;
  let baselineTrace = 0;
  let optimizedTrace = 0;
  const traceBytes = items => items.filter(message => message.toolName === "workbook_trace")
    .reduce((sum, message) => sum + Buffer.byteLength(message.content.map(block => block.text || "").join("\n")), 0);
  const restored = createTraceReplayTool({ getMessages: () => messages });
  let verified = 0;
  const finalProjection = fit([...messages, assistant]);
  for (const [index, message] of messages.entries()) {
    if (finalProjection[index] === message || message.toolName !== "workbook_trace") continue;
    assert.equal(finalProjection[index].details, message.details);
    let cursor = 0;
    let content = "";
    do {
      const result = await restored.execute("offline", { callId: message.toolCallId, offset: cursor });
      const delimiter = result.content[0].text.indexOf("\n");
      content += result.content[0].text.slice(delimiter + 1);
      cursor = result.details.traceReplayPage.nextOffset;
    } while (cursor != null);
    assert.equal(content, message.content.filter(block => block.type === "text").map(block => block.text).join("\n"));
    verified++;
  }
  for (const [index, message] of messages.entries()) {
    if (message.role !== "assistant" || !(message.researchUsage || message.usage)?.totalTokens) continue;
    const prefix = messages.slice(0, index);
    const after = fit(prefix);
    baseline += assessContextBudget(prefix, model).inputTokens;
    optimized += assessContextBudget(after, model).inputTokens;
    baselineTrace += traceBytes(prefix);
    optimizedTrace += traceBytes(after);
    requests++;
  }
  console.log({ file, requests, verified, baseline, optimized, baselineTrace, optimizedTrace,
    estimatedInputReductionPct: +(100 * (1 - optimized / baseline)).toFixed(2) });
}
