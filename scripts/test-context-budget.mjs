import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { normalizeContext } from "@earendil-works/pi-ai";
import { auditResearch } from "../lib/research-audit.mjs";
import { createWorkbench } from "../server/create-app.mjs";
import { loadConfig } from "../server/config.mjs";
import { assessContextBudget, fitContextMessages, CONTEXT_BUDGET_FAILURE, TOOL_RESULT_CONTEXT_CHARS } from "../lib/context-budget.mjs";

const root = await mkdtemp(path.join(tmpdir(), "pe-budget-replay-"));
const config = await loadConfig({ root, env: {
  ASR: "0", WATCH_SCHEDULER: "0", TRACKING_SCHEDULER: "0", MONITOR_SCHEDULER: "0", SOURCE_SCHEDULER: "0",
} });
const model = { ...config.model, contextWindow: 5_000, maxTokens: 1000, baseUrl: "http://127.0.0.1:1" };
const time = 1777777777777;
const system = { role: "system", content: "请按原始数据回答。", timestamp: time,
  sections: { accounting: "研究口径".repeat(16) },
  toolsAdded: [{ name: "workbook_query", description: "读取数据", parameters: { type: "object", properties: {} } }] };
const user = { role: "user", content: "2024 年营业利润率和营业收入是多少？", timestamp: time + 1 };
const source = { id: "source-margin", materialId: "M7", filename: "预算.xlsx", version: 3,
  metric: "营业收入", locator: "Profit!D42", period: "FY2024", display_unit: "万元", value: 827.35 };
const cost = { ...source, id: "cost", metric: "销售成本", locator: "Profit!D43", value: 462.37 };
const margin = { ...source, id: "derived-margin", metric: "营业利润率", value: "44.11",
  display_unit: "%", derivedFrom: [source.id, cost.id] };
const args = { path: "uploads/预算.xlsx", query: "2024 营业收入" };
const reason = { error: "timed out", code: "SOURCE_TIMEOUT", retry: "retry later" };
const results = [
  ["first", "workbook_query", args, reason, true],
  ["second", "workbook_query", args, reason, true],
  ["third", "workbook_query", args, { citations: [source, cost] }],
  ["copy", "workbook_query", args, { citations: [source, cost] }],
  ["calc", "ratio", { numerator: "364.98", denominator: "827.35" }, { citations: [margin] }],
  ["miss", "transcript_search", { query: "2022" }, { matches: [], totalMatches: 0,
    coverage: { turnsScanned: 2, totalTurns: 2, turns: [1, 2], truncated: false } }],
  ["err", "workbook_query", { path: "other.xlsx", query: "FX" }, { code: "FX_UNAVAILABLE", retryAfter: "60s" }, true],
];
function pair([id, name, params, data, error], length = 3700) {
  const text = JSON.stringify({ noise: "x".repeat(length), ...data });
  return [
    { role: "assistant", api: model.api, provider: model.provider, model: model.id, stopReason: "toolUse",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      timestamp: time + 2, content: [{ type: "toolCall", name, arguments: params, id }] },
    { role: "toolResult", toolCallId: id, toolName: name, isError: !!error, timestamp: time + 3,
      content: [{ type: "text", text }], details: { ...data, rawMarker: "原始执行记录" } },
  ];
}
const aggregate = [system, user, ...results.flatMap(row => pair(row))];
const long = [system, user, ...pair(results[2], 200_000)];
let payload;
let app;
try {
  // Capture the SDK's serialized OpenAI-compatible payload prior to network I/O.
  app = await createWorkbench({ config: { ...config, model, modelPayload(request) {
    payload = request;
    throw new Error("fixture captured payload");
  } }, logger: {} });
  const ctx = app.projectManager.get(config.defaultProjectId);
  async function replay(sourceMessages) {
    const entry = await app.sessions.createEntry({ ctx });
    const { sessionManager, agent } = entry.session;
    for (const m of sourceMessages) sessionManager.appendMessage(m);
    const file = sessionManager.getSessionFile();
    const before = await readFile(file);
    const replay = () => SessionManager.open(file).buildSessionProjection().messages;
    const raw = replay();
    const frozen = JSON.stringify(raw);
    const initial = assessContextBudget(raw, model);
    assert.equal(initial.ok, false);
    // Cached side-channel details (including the removable noise) do not cost input tokens.
    const fitted = fitContextMessages(raw, model);
    const budget = assessContextBudget(fitted, model);
    assert.equal(budget.ok, true, JSON.stringify(budget));
    const calls = raw.flatMap(m => m.role === "assistant" ? m.content.filter(b => b.type === "toolCall").map(b => b.id) : []);
    payload = undefined;
    const stream = await agent.streamFunction(model, { messages: raw }, { apiKey: "fixture-only" });
    const response = await stream.result();
    assert.ok(payload?.messages, "the request must reach provider serialization: " + response.errorMessage);
    assert.deepEqual(payload.messages.flatMap(m => (m.tool_calls || []).map(call => call.id)), calls);
    const toolMessages = payload.messages.filter(m => m.role === "tool");
    assert.deepEqual(toolMessages.map(m => m.tool_call_id), calls);
    assert.equal(JSON.stringify(raw), frozen);
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(replay(), raw);
    assert.ok(raw.find(m => m.role === "toolResult").details.rawMarker);
    console.log("Pi replay", { requested: initial.requested, fitted: budget.requested, window: model.contextWindow, pairs: calls.length });
    return new Map(toolMessages.map(m => [m.tool_call_id, m.content]));
  }
  assert.ok(aggregate.filter(m => m.role === "toolResult").every(m => m.content[0].text.length < TOOL_RESULT_CONTEXT_CHARS));
  const projected = await replay(aggregate);
  const visible = [...projected.values()].join("\n");
  for (const field of ["827.35", "万元", "FY2024", "M7", "Profit!D42", '"version":3', "44.11", "%", "Profit!D43", "462.37"]) {
    assert.ok(visible.includes(field), field);
  }
  assert.match(projected.get("calc"), /"derivedFrom":\["source-margin","cost"\]/);
  assert.match(projected.get("copy"), /827\.35/);
  assert.match(projected.get("third"), /重复证据见 copy/);
  assert.doesNotMatch(projected.get("first") + projected.get("second"), /SOURCE_TIMEOUT|xxxx/);
  assert.match(projected.get("first"), /成功/);
  assert.match(projected.get("err"), /FX_UNAVAILABLE/);
  assert.match(projected.get("err"), /60s/);
  for (const field of ['"totalMatches":0', '"turnsScanned":2', '"turns":[1,2]']) assert.ok(projected.get("miss").includes(field));
  const longResult = (await replay(long)).get("third");
  for (const field of ["827.35", "万元", "FY2024", "M7", "Profit!D42", '"version":3']) assert.ok(longResult.includes(field), field);

  const pastCalls = Array.from({length: 24}, (_, i) => pair([
    "old-" + i, "old_ratio", {query:"unrelated"}, {
      citations: [{ ...margin, id:"old-cite-" + i, derivedFrom:["old-source-" + i], metric:"无关项目" }],
    },
  ], 200));
  const pastAnswer = { ...aggregate[2], stopReason: "stop",
    content: [{ type: "text", text: "旧回复起点 " + "旧的无关正文".repeat(3000) + " 旧回复终点" }] };
  const withHistory = [system, {...user, content:"旧问题"}, ...pastCalls.flat(), pastAnswer, user,
    ...pair(results[2]), ...pair(results[4])];
  const historicalReplay = await replay(withHistory);
  assert.match(historicalReplay.get("third"), /827\.35/);
  assert.match(historicalReplay.get("calc"), /"derivedFrom":\["source-margin","cost"\]/);
  assert.ok([...historicalReplay].some(([call, text]) => call.startsWith("old-") && !text.includes("old-cite-")));
  assert.ok(payload.messages.some(m => m.role === "assistant" && String(m.content).includes("完整正文见该轮会话记录")));
  assert.ok(payload.messages.some(m => m.role === "user" && m.content === user.content));

  const turns = Array.from({ length: 3000 }, (_, i) => i + 1);
  const hugeStatus = [system, user, ...pair(["covered", "transcript_search", {query:"缺失指标"}, {
    matches: [], totalMatches: 0, coverage: { turnsScanned: turns.length, turns },
  }]), ...pair(["blocked", "remote", {path:"fx"}, {code:"RETRY_LATER", retryAfter:"90s", error: "long ".repeat(8000)}, true])];
  const statusReplay = await replay(hugeStatus);
  assert.match(statusReplay.get("covered"), /"turnsScanned":3000/);
  assert.match(statusReplay.get("covered"), /"first":1,"last":3000,"omitted":true/);
  assert.match(statusReplay.get("blocked"), /RETRY_LATER/);
  assert.match(statusReplay.get("blocked"), /90s/);

  // Pi folds prompt sections and tool definitions into system messages. Count
  // them along with calls, ordinary chat, and the actual reserved output.
  const entry = await app.sessions.createEntry({ ctx });
  payload = undefined;
  const bigSystem = { ...system, sections: { policy: "s".repeat(14000) } };
  const failure = await entry.session.agent.streamFunction(model, { messages: [bigSystem, user] }, { apiKey: "fixture-only" });
  assert.equal((await failure.result()).errorMessage, CONTEXT_BUDGET_FAILURE);
  assert.equal(payload, undefined);
  assert.equal(fitContextMessages([user], model)[0], user);
  // Inline audits and repairs also go through this session stream. Their SDK
  // shorthand has not been normalized by Pi's main agent loop.
  const options = { apiKey: "fixture-only" };
  const auditModel = { ...model, contextWindow: 5600 };
  let auditSizes;
  await auditResearch((m, context, opts) => {
    auditSizes = [context.messages, normalizeContext(context).messages].map(messages =>
      assessContextBudget(messages, m, opts.maxTokens).requested);
    return entry.session.agent.streamFunction(m, context, opts);
  }, auditModel, { messages: [user] }, options, "证据有限。");
  assert.ok(auditSizes[0] <= auditModel.contextWindow && auditSizes[1] > auditModel.contextWindow);
  assert.equal(payload, undefined, "the audit prompt exceeds the budget before provider I/O");

  const shorthand = { systemPrompt: "One copy of the repair instructions.", tools: system.toolsAdded, messages: [user] };
  await (await entry.session.agent.streamFunction(model, shorthand, options)).result();
  assert.equal(JSON.stringify(payload.messages).split(shorthand.systemPrompt).length - 1, 1);
  assert.deepEqual(payload.tools.map(tool => tool.function.name), ["workbook_query"]);
  payload = undefined;
  const largeTool = { ...system.toolsAdded[0], description: "long ".repeat(4000) };
  const blockedTools = await entry.session.agent.streamFunction(model, { ...shorthand, tools: [largeTool] }, options);
  assert.equal((await blockedTools.result()).errorMessage, CONTEXT_BUDGET_FAILURE);
  assert.equal(payload, undefined);

  const reportRetries = Array.from({ length: 6 }, (_, i) =>
    pair(["review-" + i, "review_research", { path: "exports/analysis.md" }, { error: "需补充证据" }, true], 0)).flat();
  const capped = await entry.session.agent.streamFunction(model, { messages: [
    system, { ...user, content: "分析模型并保存报告。" }, ...reportRetries,
  ] }, options);
  await capped.result();
  assert.ok(payload.messages.some(m => m.role === "tool" && m.tool_call_id === "review-5"));
  assert.deepEqual(payload.tools || [], [], "the serialized recovery request exposes no tools");
  payload = undefined;
  const target = { ref:"Discount PE!H29", value:129, formula:"=ROUND(H28,0)", rowLabel:"Target price", cacheStatus:"cached" };
  const sha256 = "a".repeat(64);
  const verifiedRead = pair(["trace-price","workbook_trace",{path:"uploads/model.xlsx"},
    {path:"uploads/model.xlsx",sha256,version:1,materialId:"M7",target,
      citations:[{id:"verified-target",locator:target.ref,materialId:"M7",version:1,sha256,value:129,
        filename:"model.xlsx",display_unit:"元/股"}]}],0);
  const partial = await (await entry.session.agent.streamFunction(model,{messages:[
    system,{...user,content:"复现目标价并保存投资报告。"},...verifiedRead,...reportRetries,
  ]},options)).result();
  assert.equal(payload,undefined,"verified evidence is delivered without a new request");
  assert.equal(partial.researchReportLimitEvidence?.[0]?.value,129);
  assert.match(partial.content[0].text,/129.*Discount PE!H29[\s\S]*报告未通过发布校验/);
  console.log("full request budget, immutable replay, coverage, retries and value provenance PASS");
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
