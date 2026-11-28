import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { setTimeout as wait } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import vm from "node:vm";
import { Type } from "typebox";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { citationIdFor } from "../lib/citations.mjs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { loadConfig, REPO_ROOT } from "../server/config.mjs";
import { createWorkbench } from "../server/create-app.mjs";
import { appendCorrection, markArtifact, readLedger } from "../lib/ledger.mjs";

// Run the actual HTTP handlers, including SSE encoding, without binding a port.
async function request(app, path, body, headers = {}) {
  const req = Readable.from(body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body))]);
  req.method = body === undefined ? "GET" : "POST";
  req.headers = headers;
  const res = new EventEmitter();
  let buffer = "";
  res.writeHead = (status) => { res.status = status; };
  res.write = (chunk) => { buffer += chunk; return true; };
  res.end = (chunk) => { if (chunk) res.write(chunk); res.writableEnded = true; };
  await app.handleApi(req, res, new URL(path, "http://local.test"));
  assert.ok(res.status >= 200 && res.status < 300, `${req.method} ${path}: ${res.status} ${buffer}`);
  return {
    json: () => JSON.parse(buffer),
    frames: () => buffer.split("\n\n").filter(block => /^data: /m.test(block)).map(block => ({
      id: /^id: (.+)$/m.exec(block)?.[1],
      data: JSON.parse(/^data: (.+)$/m.exec(block)[1]),
    })),
    disconnect() { req.emit("close"); res.emit("close"); },
  };
}

const citations = ["Model!A1", "Model!B2"].map((locator, index) => ({
  id: `evidence-${index}`, materialId: "book", version: 1, locator,
}));
const source = {
  name: "fixture_evidence", label: "Fixture evidence", description: "Read the test source.",
  parameters: Type.Object({}),
  async execute() {
    return { content: [{ type: "text", text: "工具原始输出。" }], details: { citations } };
  },
};

function defer() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

async function bounded(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), 5000); }),
    ]);
  } finally { clearTimeout(timer); }
}

function scriptModel(entry, steps) {
  const awaiting = defer();
  const release = defer();
  let count = 0;
  entry.session.agent.streamFunction = async (model, _ctx, opts) => {
    const step = steps[count++];
    assert.ok(step, "unexpected extra request to the model");
    if (step.pause) {
      awaiting.resolve();
      // The abort endpoint may wait for Pi to settle before returning.
      if (!opts.signal?.aborted) {
        await Promise.race([
          release.promise,
          new Promise(resolve => opts.signal?.addEventListener("abort", resolve, { once: true })),
        ]);
      }
    }
    const stopReason = opts.signal?.aborted ? "aborted" : step.stopReason ?? "stop";
    const content = step.tool ? [{ type: "toolCall", id: step.toolId ?? `source-${count}`,
      name: step.toolName || (step.tool === true ? source.name : "workbook_query"), arguments: step.tool === true ? {} : step.tool }]
      : [{ type: "text", text: step.text || "" }];
    const output = stopReason === "length" ? model.maxTokens : 10;
    const message = {
      role: "assistant", content, stopReason, timestamp: Date.now(), api: model.api, provider: model.provider, model: model.id,
      usage: { input: 20, output, cacheRead: 0, cacheWrite: 0, totalTokens: 20 + output,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: { ...message, content: [] } });
    if (step.text) stream.push({ type: "text_delta", contentIndex: 0, delta: step.text, partial: message });
    if (stopReason === "error" || stopReason === "aborted") {
      stream.push({ type: "error", reason: stopReason, error: { ...message, errorMessage: "fixture model stopped" } });
    } else {
      stream.push({ type: "done", reason: stopReason, message });
    }
    return stream;
  };
  return { paused: awaiting.promise, resume: release.resolve, count: () => count };
}

const draft = "首稿A含无效引用 Fake!C3，旧依据 Model!A1。";
const revised = "最终稿B依据 Model!B2。";
const firstHalf = "这是前半段，";
const secondHalf = "这是后半段。";
const rewrite = { name: "rewrite", draft, expected: revised, cites: [citations[1]], steps: [
  { tool: true, stopReason: "toolUse" }, { text: draft }, { text: revised, pause: true },
] };
const continued = reason => ({ name: `continue-${reason}`, draft: firstHalf, expected: firstHalf + secondHalf, cites: [],
  steps: [{ text: firstHalf, stopReason: reason }, { text: secondHalf, pause: true }] });

function publicAnswer(item) {
  return { turnId: item.turnId, text: item.text, citations: item.citations, status: item.status, reason: item.reason };
}

await test("durable delivery through Workbench, Pi, legacy SSE and AG-UI replay", async t => {
  const root = await mkdtemp(join(tmpdir(), "pe-delivery-http-"));
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "offline-test-credential";
  let app;
  t.after(async () => {
    try { await app?.close(); } finally {
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
      await rm(root, { recursive: true, force: true });
    }
  });
  const config = await loadConfig({ root, env: {
    ASR: "0", WATCH_SCHEDULER: "0", TRACKING_SCHEDULER: "0", MONITOR_SCHEDULER: "0", SOURCE_SCHEDULER: "0",
  } });
  async function openApp() {
    const instance = await createWorkbench({ config: { ...config, toolNames: [...config.toolNames, source.name] },
      logger: { log() {}, warn() {}, error() {} } });
    instance.projectManager.get(config.defaultProjectId).tools.push(source);
    return instance;
  }
  const history = [];
  app = await openApp();

  for (const transport of ["legacy", "agui"]) {
    for (const scenario of [rewrite, continued("length"), continued("stop")]) {
      await t.test(`${transport}: ${scenario.name}, disconnect before verification completes`, async t => {
        const { id } = (await request(app, "/api/sessions", {})).json();
        const entry = app.live.get(id);
        const url = `/api/sessions/${id}`;
        const model = scriptModel(entry, scenario.steps);
        t.after(model.resume);
        const observer = await request(app, `${url}/events`);
        t.after(() => observer.disconnect());
        const question = "请回答这个问题。";
        const ag = "/api/ag-ui/agent/pi";
        const stream = transport === "agui"
          ? await request(app, `${ag}/run`, { threadId: id, prompt: question })
          : await request(app, `${url}/events`);
        if (transport === "legacy") await request(app, `${url}/messages`, { text: question });
        t.after(() => stream.disconnect());
        await bounded(model.paused, "expected the verifier to request the next model generation");
        const pending = entry.postAnswerRun;
        const inProgress = (await request(app, `${url}/state`)).json();
        assert.equal(inProgress.streaming, true);
        assert.ok(!JSON.stringify(inProgress).includes(scenario.draft), "refresh exposed the unchecked candidate");
        const prefix = stream.frames();
        assert.ok(!JSON.stringify(prefix).includes(scenario.draft), "SSE exposed the unchecked candidate");
        assert.ok(!prefix.some(({ data }) => ["turn.delivered", "run.settled", "RUN_FINISHED", "RUN_ERROR"].includes(data.type)));
        if (scenario === rewrite) {
          const toolUpdate = transport === "agui" ? "TOOL_CALL_RESULT" : "tool.completed";
          assert.ok(prefix.some(({ data }) => data.type === toolUpdate), "tool progress must arrive before delivery");
        }
        const cursor = prefix.at(-1)?.id;
        if (transport === "agui") assert.ok(cursor, "resume must use an actual persisted cursor");
        stream.disconnect();
        model.resume();
        await bounded(pending, "the user turn did not settle");
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(model.count(), scenario.steps.length);

        const deliveries = observer.frames().map(frame => frame.data).filter(event => event.type === "turn.delivered");
        assert.equal(deliveries.length, 1);
        const record = deliveries[0].record;
        assert.ok(record.turnId);
        assert.equal(record.status, "completed");
        assert.equal(record.text, scenario.expected);
        assert.deepEqual(record.citations, scenario.cites);
        const snapshot = (await request(app, `${url}/state`)).json();
        assert.equal(snapshot.streaming, false);
        const delivered = snapshot.messages.filter(m => m.role === "assistant");
        assert.equal(delivered.length, 1);
        assert.deepEqual(publicAnswer(delivered[0]), publicAnswer(record));
        history.push({ id, messages: snapshot.messages, agui: transport === "agui", record });
        if (scenario === rewrite) {
          assert.equal(delivered[0].tools.length, 1);
          assert.match(delivered[0].tools[0].output, /工具原始输出/);
        }
        // Feed actual wire and snapshot data to the reducer used by both chat UIs.
        const { receiveDelivery, applyTurnSnapshot } = await import("../ui/chat/turn-delivery.js");
        const view = { messages: [], live: { text: "", tools: [] }, streaming: false };
        applyTurnSnapshot(view, inProgress);
        receiveDelivery(view, record);
        receiveDelivery(view, record);
        applyTurnSnapshot(view, inProgress); // a stale poll returning after delivery
        assert.equal(view.streaming, false);
        assert.deepEqual(view.messages.filter(m => m.role === "assistant").map(publicAnswer), [publicAnswer(record)]);
        applyTurnSnapshot(view, snapshot);
        receiveDelivery(view, record); // replay after refresh
        assert.deepEqual(view.messages.filter(m => m.role === "assistant").map(publicAnswer), [publicAnswer(record)]);
        const search = entry.sessionTools.find(tool => tool.name === "transcript_search");
        const match = await search.execute("check-history", { query: scenario.expected });
        assert.equal(match.details.matches.filter(m => m.role === "assistant").length, 1);
        if (scenario === rewrite) assert.equal((await search.execute("no-draft", { query: "首稿A" })).details.totalMatches, 0);

        const reopened = await request(app, `${url}/events`);
        try { assert.deepEqual(reopened.frames()[0].data.messages, snapshot.messages); }
        finally { reopened.disconnect(); }
        if (transport === "agui") {
          const replay = await request(app, `${ag}/connect`, { threadId: id, afterEventId: cursor });
          const events = replay.frames().map(frame => frame.data);
          const content = events.filter(e => e.type === "TEXT_MESSAGE_CONTENT");
          assert.deepEqual(content.map(e => [e.messageId, e.delta]), [[record.turnId, scenario.expected]]);
          assert.deepEqual(events.filter(e => e.name === "pe.turn_delivery").map(e => e.value), [record]);
          assert.equal(events.filter(e => e.type === "RUN_FINISHED").length, 1);
          const replayAgain = await request(app, `${ag}/connect`, { threadId: id, afterEventId: cursor });
          assert.deepEqual(replayAgain.frames(), replay.frames(), "replayed frames retain their original identities");
          const tail = await request(app, `${ag}/connect`, { threadId: id, afterEventId: replay.frames().at(-1).id });
          assert.deepEqual(tail.frames(), []);
        }
      });
    }
  }
  for (const status of ["partial", "failed", "cancelled"]) {
    await t.test(`AG-UI and default SSE retain the ${status} result on refresh`, async t => {
      const safe = "可独立核验的部分见 Model!B2。";
      const incomplete = "其余内容尚缺出处见 Fake!C3。";
      const steps = status === "partial" ? [
        { tool: true, stopReason: "toolUse" }, { text: safe + incomplete }, { text: safe + incomplete, pause: true },
      ] : status === "cancelled" ? [
        { text: "请求重写 Fake!C3。" }, { text: "尚未核验的输出。", pause: true },
      ] : [{ text: "不可交付的错误碎片。", stopReason: "error", pause: true }];
      const { id } = (await request(app, "/api/sessions", {})).json();
      const entry = app.live.get(id);
      const model = scriptModel(entry, steps);
      t.after(model.resume);
      const observer = await request(app, `/api/sessions/${id}/events`);
      t.after(() => observer.disconnect());
      const ag = "/api/ag-ui/agent/pi";
      const stream = await request(app, `${ag}/run`, { threadId: id, prompt: "请回答这个问题。" });
      t.after(() => stream.disconnect());
      await bounded(model.paused, "expected the model gate");
      const pending = entry.postAnswerRun;
      if (status === "cancelled") {
        const stopped = await request(app, `${ag}/stop/${id}`, {});
        assert.equal(stopped.json().stopped, true);
      } else model.resume();
      await bounded(pending, "expected a terminal record");
      await new Promise(resolve => setImmediate(resolve));
      const frames = stream.frames().map(f => f.data);
      const [canonical] = frames.filter(e => e.name === "pe.turn_delivery");
      assert.ok(canonical);
      const record = canonical.value;
      assert.equal(record.status, status);
      assert.ok(record.reason);
      assert.equal(record.text, status === "partial" ? safe : "");
      assert.deepEqual(record.citations, status === "partial" ? [citations[1]] : []);
      const terminal = frames.filter(e => e.type === "RUN_FINISHED" || e.type === "RUN_ERROR");
      assert.equal(terminal.length, 1);
      assert.equal(terminal[0].type, status === "failed" ? "RUN_ERROR" : "RUN_FINISHED");
      if (status === "cancelled") assert.equal(terminal[0].result.aborted, true);
      assert.deepEqual(observer.frames().filter(f => f.data.type === "turn.delivered").map(f => f.data.record), [record]);
      const refreshed = (await request(app, `/api/sessions/${id}/state`)).json();
      assert.equal(refreshed.streaming, false);
      const assistant = refreshed.messages.filter(m => m.role === "assistant");
      assert.equal(assistant.length, 1);
      assert.deepEqual(publicAnswer(assistant[0]), publicAnswer(record));
      history.push({ id, messages: refreshed.messages, agui: true, record });
    });
  }
  await t.test("queued questions survive refresh without borrowing the active answer", async t => {
    const { id } = (await request(app, "/api/sessions", {})).json();
    const entry = app.live.get(id);
    const model = scriptModel(entry, [
      { text: draft }, { text: "前一个回答。", pause: true }, { text: "后一个回答。" },
    ]);
    t.after(model.resume);
    const url = `/api/sessions/${id}`;
    await request(app, url + "/messages", { text: "第一个问题" });
    await bounded(model.paused, "first question did not enter correction");
    const queued = (await request(app, url + "/messages", { text: "第二个问题" })).json();
    assert.equal(queued.queued, true);
    const pending = entry.postAnswerRun;
    const during = (await request(app, url + "/state")).json().messages;
    assert.deepEqual(during.map(m => [m.role, m.text]), [
      ["user", "第一个问题"], ["assistant", ""], ["user", "第二个问题"], ["assistant", ""],
    ]);
    model.resume();
    await bounded(pending, "queued turn did not complete");
    const final = (await request(app, url + "/state")).json().messages;
    assert.deepEqual(final.map(m => m.turnId), during.map(m => m.turnId));
    assert.deepEqual(final.map(m => m.text), ["第一个问题", "前一个回答。", "第二个问题", "后一个回答。"]);
    const search = entry.sessionTools.find(tool => tool.name === "transcript_search");
    const result = await search.execute("history", { query: "前一个回答", turn: 1 });
    assert.equal(result.details.totalMatches, 1);
    history.push({ id, messages: final });
  });
  await t.test("cold Workbench restores the same public history, tools and protocol records", async () => {
    // Simulate a crash after the committed JSONL decision and the AG-UI
    // content frame, but before its remaining SQLite tail was written.
    const savedRun = history.find(h => h.agui && h.record.status === "completed");
    const { ctx } = app.live.get(savedRun.id);
    const cursor = ctx.agentEvents.list({ threadId: savedRun.id, runId: savedRun.record.runId })
      .find(row => row.eventType === "TEXT_MESSAGE_CONTENT");
    assert.ok(cursor);
    ctx.store.db.prepare("DELETE FROM agent_events WHERE thread_id = ? AND run_id = ? AND sequence > ?")
      .run(savedRun.id, savedRun.record.runId, cursor.sequence);
    await app.close();
    app = await openApp();
    const tail = await request(app, "/api/ag-ui/agent/pi/connect", { threadId: savedRun.id, afterEventId: cursor.eventId });
    assert.deepEqual(tail.frames().map(f => f.data.type), ["TEXT_MESSAGE_END", "CUSTOM", "RUN_FINISHED"]);
    assert.deepEqual(tail.frames()[1].data.value, savedRun.record);
    assert.equal(history.length, 10);
    for (const saved of history) {
      const restored = (await request(app, `/api/sessions/${saved.id}/state`)).json();
      assert.equal(restored.streaming, false);
      assert.deepEqual(restored.messages, saved.messages);
      if (saved.agui) {
        const replay = await request(app, "/api/ag-ui/agent/pi/connect", { threadId: saved.id });
        const records = replay.frames().map(f => f.data).filter(e => e.name === "pe.turn_delivery").map(e => e.value);
        assert.deepEqual(records, [saved.record]);
      }
    }
  });
});

async function networkRequest(base, pathname, body, signal) {
  const response = await fetch(base + pathname, {
    method: body === undefined ? "GET" : "POST", signal,
    ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
  assert.ok(response.ok, `${pathname} returned ${response.status}`);
  return response;
}

async function networkStream(t, base, pathname, body) {
  const controller = new AbortController();
  const disconnect = () => controller.abort();
  t.after(disconnect);
  const response = await networkRequest(base, pathname, body, controller.signal);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  const frames = [];
  const done = (async () => {
    let pending = "";
    try {
      for await (const chunk of response.body.pipeThrough(new TextDecoderStream())) {
        pending += chunk;
        const blocks = pending.split("\n\n");
        pending = blocks.pop();
        for (const block of blocks) {
          const payload = /^data: (.+)$/m.exec(block)?.[1];
          if (payload) frames.push({ id: /^id: (.+)$/m.exec(block)?.[1], data: JSON.parse(payload) });
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return { frames, done, disconnect };
}

async function until(find, message) {
  const deadline = Date.now() + 5000;
  for (;;) {
    const found = find();
    if (found) return found;
    assert.ok(Date.now() < deadline, message);
    await wait(10);
  }
}

const citedContinuation = {
  name: "cited continuation", draft: "前半依据 Model!A1，", expected: "前半依据 Model!A1，后半依据 Model!B2。",
  cites: citations,
  steps: [
    { tool: true, stopReason: "toolUse" },
    { text: "前半依据 Model!A1，", stopReason: "length" },
    { text: "后半依据 Model!B2。", pause: true },
  ],
};

async function browserHistorySearch(t, { app, base, json, open, answers }) {
  const filename = "Acceptance13.xlsx";
  const workbook = value => execFileSync(process.env.PYTHON_BIN || "python3", ["-c", `
import sys
from io import BytesIO
from openpyxl import Workbook
book = Workbook()
book.active.title = "Model"
book.active["B2"] = int(sys.argv[1])
data = BytesIO()
book.save(data)
sys.stdout.buffer.write(data.getvalue())
`, String(value)]);
  const initial = workbook(317);
  const updated = workbook(942);
  const coldCases = [];
  const coldTraces = [];
  const original = `最终稿B（字段名 isError）依据 [${filename}]Model!B2。`;
  const historical = `历史检索命中。那条正式回答引用的是 [${filename}]Model!B2。`;
  const internal = "用户还没有看到这份草稿";
  const queries = ["最终稿B", "首稿A", internal];

  function createOldHistory(book) {
    const ctx = app.projectManager.get(app.config.defaultProjectId);
    const manager = SessionManager.create(ctx.root, ctx.sessionsDir);
    manager.appendModelChange(app.config.model.provider, app.config.model.id);
    manager.appendSessionInfo("带原始引用的旧会话");
    manager.appendMessage({ role: "user", content: "请核对单元格。", timestamp: Date.now() });
    const answer = text => manager.appendMessage({ role: "assistant", stopReason: "stop",
      timestamp: Date.now(), content: [{ type: "text", text }] });
    answer(draft);
    manager.appendCustomMessageEntry("pe_answer_correct", internal, false);
    answer(original);
    manager.appendCustomEntry("pe_answer_lint", { citations: [{
      id: citationIdFor(book.material.id, 1, "Model!B2"), materialId: book.material.id, version: 1, filename, locator: "Model!B2", value: 317,
    }] });
    return manager.getSessionId();
  }

  async function openOriginalCell(page, body, materialId) {
    const links = body.locator("[data-cell-cite]");
    const targets = await links.evaluateAll(nodes => nodes.map(({ dataset }) =>
      [dataset.materialId, dataset.version, dataset.locator]));
    assert.ok(targets.length > 0);
    for (const [index, target] of targets.entries()) {
      assert.deepEqual(target, [materialId, "1", "Model!B2"]);
      await links.nth(index).click();
      const cell = page.locator('#xlsxSheet .xlsx-c.is-sel[data-r="2"][data-c="2"]');
      await cell.waitFor();
      assert.equal(await cell.innerText(), "317");
      assert.equal(await page.locator('#xlsxTabs [aria-selected="true"]').innerText(), "Model");
      assert.deepEqual(await page.evaluate(() => [state.openFileId, state.selectedVersion]), [materialId, 1]);
      await page.locator("#dClose").click();
    }
  }

  async function checkReply(ui, record, index) {
    await ui.page.waitForFunction(id => state.messages.some(m =>
      m.role === "assistant" && m.turnId === id && m.status !== "pending"), record.turnId);
    const copies = await ui.page.evaluate(id => state.messages.filter(m => m.role === "assistant" && m.turnId === id), record.turnId);
    assert.deepEqual(copies.map(publicAnswer), [publicAnswer(record)]);
    const body = answers(ui.page).nth(index).locator(".msg-body");
    if (record.status === "completed") assert.equal(await body.innerText(), record.text.replace(/`([^`]+)`/g, "$1"));
    else if (record.text) assert.ok((await body.innerText()).includes(record.text));
    else assert.equal(await body.locator("[data-cell-cite]").count(), 0);
    return body;
  }

  // Check the content within each call. Its arguments, the answer body and a
  // neighbouring result can all contain the search term or the same locator.
  async function checkResults(group, calls, book, afterFirst) {
    if (!(await group.evaluate(node => node.open))) await group.locator(":scope > summary").click();
    assert.match(await group.innerText(), /Model!B2/, "expanded search must show the returned locator");
    for (const [i, { toolCallId }] of calls.entries()) {
      const card = group.locator(`[data-tool-call-id="${toolCallId}"].transcript-search-card`);
      assert.ok(await card.isVisible(), `missing visible result for ${queries[i]}`);
      const text = await card.innerText();
      if (i === 0) {
        assert.match(text, /历史问答命中\s*1\s*条/);
        assert.match(text, /第\s*1\s*轮.*正式回答/);
        assert.ok(text.replaceAll("**", "").includes(original), text);
        assert.ok(await card.locator(`[data-material-id="${book.material.id}"][data-version="1"][data-locator="Model!B2"]`).isVisible());
        if (afterFirst) await afterFirst();
      } else {
        assert.match(text, /历史问答未命中/);
        assert.ok(!text.includes("Model!B2"), text);
        assert.equal(await card.locator("[data-cell-cite]").count(), 0);
      }
    }
  }

  for (const transport of ["legacy", "agui"]) {
    for (const history of ["managed", "old Pi"]) {
      await t.test(`Chrome ${transport} ${history}: search delivered history`, async t => {
        let book, id;
        const ui = await open(t, transport);
        if (history === "old Pi") {
          const res = await fetch(base + "/api/upload", { method: "POST", body: initial,
            headers: { "x-file-name": filename, "content-type": "application/octet-stream" } });
          assert.equal(res.status, 201);
          book = await res.json();
          id = createOldHistory(book);
          await ui.reload(id);
        } else {
          ({ id } = await ui.newSession());
          const entry = app.live.get(id);
          const tool = { query: "Model!B2", sheet: "Model" };
          const model = scriptModel(entry, [
            { tool, pause: true, stopReason: "toolUse" }, { text: draft }, { text: original },
          ]);
          t.after(model.resume);
          await ui.page.locator("#fileInput").setInputFiles({ name: filename, mimeType: "application/octet-stream", buffer: initial });
          const uploaded = ui.page.waitForResponse(r => new URL(r.url()).pathname === "/api/upload" && r.request().method() === "POST");
          await ui.send("请核对单元格。");
          const res = await uploaded;
          assert.equal(res.status(), 201);
          book = await res.json();
          tool.path = book.path;
          model.resume();
          await answers(ui.page).first().locator(".msg-body").getByText(original, { exact: true }).waitFor();
          assert.ok(entry.session.sessionManager.getBranch().some(row =>
            row.customType === "pe_answer_correct" && JSON.stringify(row.content).includes(internal)));
        }
        if (history === "managed") {
          await t.test("workbook_trace resolves the exact uploaded basename and rejects an invented prefix", async t => {
            const traceUI = await open(t, transport);
            const { id: traceId, entry } = await traceUI.newSession();
            const uploadedName = book.path.split("/").at(-1);
            assert.notEqual(uploadedName, filename);
            for (const [index, name] of [uploadedName, filename, "invented-" + uploadedName].entries()) {
              const text = `[${name}]Model!B2 储存的字面常量是 317，单元格内没有公式。`;
              const model = scriptModel(entry, [
                { toolName: "workbook_trace", toolId: "trace-" + index, tool: { path: book.path, mode: "cell", cell: "Model!B2" }, stopReason: "toolUse" },
                { text, pause: true }, { text },
              ]);
              t.after(model.resume);
              await traceUI.send("请核对这份工作簿中 Model!B2 的字面常量。");
              await bounded(model.paused, "upload trace did not return");
              const result = entry.session.sessionManager.getBranch().map(row => row.message)
                .find(m => m?.role === "toolResult" && m.toolCallId === "trace-" + index);
              assert.equal(result.details.path, book.path);
              assert.ok(result.details.citations.some(c => c.materialId === book.material.id && c.version === 1 &&
                c.locator === "Model!B2" && c.value === 317));
              const pending = entry.postAnswerRun;
              model.resume();
              const record = await bounded(pending, "upload trace did not settle");
              if (index === 2) {
                assert.deepEqual([record.status, record.text, record.citations], ["failed", "", []]);
              } else {
                assert.deepEqual([record.status, record.text, record.citations.map(c => c.id)],
                  ["completed", text, [citationIdFor(book.material.id, 1, "Model!B2")]]);
              }
              if (index === 0) coldTraces.push({ transport, traceId, materialId: book.material.id, record });
              await checkReply(traceUI, record, index);
              await traceUI.reload(traceId);
              const body = await checkReply(traceUI, record, index);
              if (index < 2) await openOriginalCell(traceUI.page, body, book.material.id);
            }
          });
        }
        const snapshot = async () => (await json(`/api/sessions/${id}/state`)).messages.filter(m => m.role === "assistant");
        const [first] = await snapshot();
        assert.equal(first.text, original);
        assert.deepEqual(first.citations.map(({ materialId, version, locator }) => ({ materialId, version, locator })),
          [{ materialId: book.material.id, version: 1, locator: "Model!B2" }]);
        // The original citation must still open v1 even after the same material changes.
        const ctx = app.projectManager.get(app.config.defaultProjectId);
        await writeFile(join(ctx.root, book.path), updated);
        const changed = ctx.store.indexFile(book.path);
        assert.equal(changed.id, book.material.id);
        assert.equal(changed.versions[0].v, 2);
        for (const [version, value] of [[1, 317], [2, 942]]) {
          const grid = await json(`/api/materials/${book.material.id}/versions/${version}/workbook/sheets/Model`);
          assert.equal(grid.cells.find(([r, c]) => r === 2 && c === 2)[2], value);
        }
        await ui.reload(id);
        await ui.page.waitForFunction(id => state.files.some(f =>
          f.id === id && f.versions.some(version => version.v === 2)), book.material.id);
        const entry = app.live.get(id);
        const branch = () => entry.session.sessionManager.getBranch();
        const before = branch().length;
        const model = scriptModel(entry, [
          ...queries.map((query, i) => ({ toolId: `recall-${i}`, toolName: "transcript_search",
            tool: { query, turn: 1 }, stopReason: "toolUse" })),
          { text: historical, pause: true }, { text: historical },
        ]);
        t.after(model.resume);
        await ui.send("第一轮正式回答当时引用了哪个单元格？");
        await bounded(model.paused, "history search did not settle");
        const pending = entry.postAnswerRun;
        const calls = branch().slice(before).map(row => row.message)
          .filter(m => m?.role === "toolResult" && m.toolName === "transcript_search");
        assert.equal(calls.length, 3);
        assert.equal(new Set(calls.map(call => call.toolCallId)).size, 3);
        assert.deepEqual(calls.map(call => call.details.totalMatches), [1, 0, 0]);
        for (const call of calls) assert.deepEqual(call.details.coverage.turns, [1]);
        const [match] = calls[0].details.matches;
        assert.deepEqual([match.turn, match.role, match.excerpt.replaceAll("**", "")], [1, "assistant", original]);
        assert.deepEqual(match.citations, first.citations);

        await t.test("completed calls visible during the live turn", async () => {
          const group = ui.page.locator("#liveTools .tool-group");
          await group.locator(".tool-row.done").nth(2).waitFor({ state: "attached" });
          await checkResults(group, calls, book);
          const summary = group.locator(':scope > summary');
          const refresh = () => ui.page.evaluate(async () => {
            const { runtime } = await import('/ui/runtime.js');
            await runtime.refreshSnapshot({ watch: false, throwOnError: true });
          });
          await summary.focus();
          await refresh();
          assert.ok(await group.evaluate(g => g.open && g.querySelector('summary') === document.activeElement));
          await summary.press('Enter');
          await refresh();
          assert.equal(await group.evaluate(g => g.open), false);
          await summary.press('Enter');
          assert.ok(await group.evaluate(g => g.open));
        });
        await ui.context.setOffline(true);
        model.resume();
        const record = await bounded(pending, "disconnection prevented the history reply from settling");
        await ui.context.setOffline(false);
        const [prior, followup] = await snapshot();
        assert.deepEqual(prior.citations, first.citations);
        assert.deepEqual(publicAnswer(followup), publicAnswer(record));
        assert.deepEqual(branch().slice(before).filter(e => e.customType === "pe_turn_delivery").map(e => e.data), [record]);
        for (const [i, tool] of followup.tools.entries()) {
          assert.equal(tool.id, calls[i].toolCallId);
          assert.deepEqual(JSON.parse(tool.output).matches, calls[i].details.matches);
        }
        assert.equal(followup.tools.length, 3);
        await t.test("historical citation delivered once and opens the original cell", async () => {
          assert.deepEqual([record.status, record.text, record.citations], ["completed", historical, first.citations]);
          const rows = answers(ui.page);
          await rows.nth(1).locator(".msg-body").getByText(historical, { exact: true }).waitFor();
          await ui.ready();
          assert.deepEqual(await rows.locator(".msg-body").allInnerTexts(), [original, historical]);
          await openOriginalCell(ui.page, rows.nth(1).locator(".msg-body"), book.material.id);
        });
        for (const view of ["reconnect", "refresh", "reopen"]) {
          await t.test(`each search result after ${view}`, async () => {
            if (view === "refresh") await ui.reload(id);
            const viewer = view === "reopen" ? await open(t, transport) : ui;
            if (view === "reopen") await viewer.select(id);
            const row = answers(viewer.page).nth(1);
            await row.waitFor();
            await viewer.ready();
            await checkResults(row.locator(".tool-group"), calls, book, view === "reconnect" && (async () => {
              // A late recovery snapshot can arrive while the user reads an open group.
              await viewer.page.evaluate(async () => (await import("/ui/runtime.js")).runtime.refreshSnapshot({ watch: false }));
              await viewer.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
            }));
            assert.deepEqual(await answers(viewer.page).locator(".msg-body").allInnerTexts(), [original, historical]);
          });
        }

        const question = "请用 transcript_search 查第1轮正式回答。请说明当时引用了哪个单元格，有材料版本时可以注明，只报告历史出处。";
        const source = `已交付回答引用的单元格是 [${filename}]Model!B2`;
        const citationId = match.citations[0].id;
        const wrongId = citationId.replace(":v1:", ":v2:");
        assert.notEqual(citationId, wrongId);
        const scopedQuestion = "请查第1轮正式答文引用的是哪个单元格与材料版本，并说明同一材料当前是哪个版本；当前版本无法核实时请明示。";
        const originalSource = `第一轮正式回答引用的是 [${book.material.id}@v1]Model!B2`;
        const storageNote = match.citations[0].storedFilename ? "，存储文件名 " + match.citations[0].storedFilename : "";
        const idReport = `第 1 轮回答引用的出处：工作簿 ${filename}，单元格 Model!B2，材料 ID ${book.material.id}，材料版本 v1。\n\n完整 citation.id：${citationId}`;
        const retryQuestion = `请调用 transcript_search 在本会话第1轮历史中查询“${queries[0]}”。只报告正式回答的出处、材料版本和完整 citation.id。`;
        const cases = [
          { ending: "逗号分隔的第二词尚未查询", answer: idReport, badArgs: {}, partial: true, gap: "折旧政策",
            question: `请在第1轮分别查询两个词：“${queries[0]}”，“折旧政策”。分别说明两个词的检索结果和历史出处，列出命中的完整引用 ID。`, inspect: true },
          { ending: "只看另一本工作簿", answer: idReport, badArgs: {}, partial: true, gap: "Budget13.xlsx",
            question: `请在第1轮查询“${queries[0]}”。这次只看工作簿 Budget13.xlsx 的历史出处，请给出单元格、材料版本和完整引用 ID。`, inspect: true },
          { ending: "命中该条 citation 带的完整引用", answer: `第1轮回答引用的是 [${filename}]Model!B2，材料 ${filename}（materialId ${book.material.id}，version 1），命中该条 citation 带的完整引用 ID 为 \`${citationId}\`。`, inspect: true },
          { ending: "这篇回答命中的 citation.id", answer: `第1轮回答引用的出处是：[${filename}]Model!B2，材料 ID 为 ${book.material.id}，版本 v1；这篇回答命中的 citation.id 是 ${citationId}。`, inspect: true },
          { ending: "裸材料 UUID", answer: `第1轮回答引用的出处是 [${filename}]Model!B2（材料 ${book.material.id}，版本 v1${storageNote}），该命中记录带的完整引用 ID 为 ${citationId}。`, inspect: true },
          { ending: "单列正确 ID", answer: idReport, inspect: true },
          { ending: "补齐参数命中后单列 ID", answer: idReport, badArgs: {}, inspect: true },
          { ending: "未解决另一轮但保留正确 ID", answer: idReport, badArgs: { turn: 2 }, partial: true, inspect: true },
          { ending: "。" },
          { ending: "（材料版本 v1）。", inspect: true },
          { ending: "（材料版本 v2）。", reject: true },
          { ending: `（材料版本 v1，引用 ID：${citationId}）。`, inspect: true },
          { ending: `（材料版本 v1，引用 ID：${wrongId}）。`, invalid: wrongId },
          { ending: "。当时用的是第一版。", inspect: true },
          { ending: "。当时用的是第二版。", invalid: "第二版" },
          { ending: "（材料第二版）。", reject: true },
          { ending: "。材料版本为 v2。", invalid: "v2" },
          { ending: `（材料版本 v1，命中所带的完整引用 ID：${citationId}）。`, inspect: true },
          { ending: "真实首稿", answer: `第1轮回答引用的是 [${book.material.id}@v1]Model!B2，命中的完整 citation.id 为 \`${citationId}\`，该引用指向工作簿 Acceptance13.xlsx 的 Model!B2（材料 ID 为 ${book.material.id}，版本为 1）。`, inspect: true },
          { ending: "真实纠错稿", answer: `第1轮回答的出处是工作簿 Acceptance13.xlsx 的 Model!B2，对应材料 ID ${book.material.id}、版本 v1，完整引用写作 [Acceptance13.xlsx]Model!B2，其 citation.id 为 \`${citationId}\`。`, inspect: true },
          { ending: "。截至今天，这份材料的版本为 v2。", scoped: true, read: true, inspect: true },
          { ending: "。截至今天，这份材料的版本为 v1。", scoped: true, read: true, invalid: "这份材料的版本" },
          { ending: "。截至今天，这份材料的版本为 v1。", scoped: true, invalid: "这份材料的版本" },
          { ending: "。当前材料版本为 v1。", scoped: true, invalid: "当前材料版本为 v1" },
          { ending: "。当前材料版本为 v1。", scoped: true, read: true, invalid: "当前材料版本为 v1" },
          { ending: "。当前材料版本为 v2。", scoped: true, read: true, inspect: true },
        ];
        const coldReplies = [];
        coldCases.push({ transport, history, id, materialId: book.material.id, coldReplies });
        for (const [variant, { ending, answer, inspect, reject, invalid, scoped, read, badArgs, partial, question: searchQuestion, gap }] of cases.entries()) {
          await t.test(`reported source ${ending === "。" ? "without version" : ending}${read ? " after workbook_query" : ""}`, async t => {
            const prefix = scoped ? originalSource : source;
            const text = answer ?? prefix + ending;
            const start = branch().length;
            const model = scriptModel(entry, [
              ...(badArgs ? [{ toolId: `invalid-${variant}`, toolName: "transcript_search", tool: badArgs, stopReason: "toolUse" }] : []),
              { toolId: `version-${variant}`, toolName: "transcript_search", tool: { query: queries[0], turn: 1 }, stopReason: "toolUse" },
              ...(read ? [{ toolId: `current-version-${variant}`, tool: { path: book.path, query: "Model!B2" }, stopReason: "toolUse" }] : []),
              { text, pause: true }, { text },
            ]);
            t.after(model.resume);
            await ui.send(searchQuestion ?? (badArgs ? retryQuestion : scoped ? scopedQuestion : question));
            await bounded(model.paused, "version follow-up did not reach its answer");
            const results = branch().slice(start).map(row => row.message).filter(m => m?.role === "toolResult");
            if (badArgs) {
              const invalid = results.shift();
              assert.equal(invalid.toolName, "transcript_search");
              assert.equal(invalid.isError, true);
            }
            assert.deepEqual(results.map(m => m.toolName), read ? ["transcript_search", "workbook_query"] : ["transcript_search"]);
            assert.deepEqual(results[0].details.matches, [match]);
            if (read) assert.ok(results[1].details.citations.some(c => c.materialId === book.material.id &&
              c.version === 2 && c.locator === "Model!B2" && c.value === 942));
            const pending = entry.postAnswerRun;
            // Keep the sender connected for live delivery. A second browser loses
            // its connection with the answer still pending.
            let peer;
            if (inspect) {
              peer = await open(t, transport);
              await peer.select(id);
              await peer.page.waitForFunction(() => state.streaming && Boolean(state.live.turnId));
              await peer.context.setOffline(true);
            }
            model.resume();
            const delivered = await bounded(pending, "version follow-up did not settle");
            if (peer) await peer.context.setOffline(false);
            const index = variant + 2;
            if (invalid) {
              assert.ok(!delivered.text.includes(invalid), `unverified source was delivered: ${delivered.text}`);
            }
            if (gap) assert.ok(delivered.reason?.includes(gap), JSON.stringify(delivered));
            if (scoped && invalid) assert.equal(delivered.status, "partial");
            if (reject || (invalid && delivered.status === "failed")) {
              assert.deepEqual([delivered.status, delivered.text, delivered.citations], ["failed", "", []]);
            } else if (invalid) {
              assert.ok(["partial", "completed"].includes(delivered.status));
              assert.equal(delivered.text, prefix + "。");
              assert.deepEqual(delivered.citations, first.citations);
            } else {
              assert.deepEqual([delivered.status, delivered.text, delivered.citations], [partial ? "partial" : "completed", text, first.citations]);
            }
            if (inspect || invalid) coldReplies.push({ index, record: delivered });
            assert.deepEqual(branch().slice(start).filter(e => e.customType === "pe_turn_delivery").map(e => e.data), [delivered]);
            assert.deepEqual(publicAnswer((await snapshot())[index]), publicAnswer(delivered));
            await checkReply(ui, delivered, index);
            if (peer) {
              await openOriginalCell(peer.page, await checkReply(peer, delivered, index), book.material.id);
              await ui.reload(id);
              const body = await checkReply(ui, delivered, index);
              if (ending.startsWith("真实")) assert.equal(await body.locator("[data-cell-cite]").count(), 2);
              await openOriginalCell(ui.page, body, book.material.id);
            }
          });
        }
      });
    }
  }
  return async function checkRestartedHistory(t, origin) {
    for (const transport of ["legacy", "agui"]) {
      await t.test(`Chrome ${transport}: stored filename opens the original version after restart`, async t => {
        const ui = await open(t, transport, origin);
        const trace = coldTraces.find(item => item.transport === transport);
        assert.ok(trace, "missing original trace delivery");
        const { traceId, materialId, record } = trace;
        await ui.select(traceId);
        await openOriginalCell(ui.page, await checkReply(ui, record, 0), materialId);
      });
    }
    assert.equal(coldCases.length, 4);
    for (const { transport, history, id, materialId, coldReplies } of coldCases) {
      await t.test(`Chrome ${transport} ${history}: exact versioned source after process restart`, async t => {
        const ui = await open(t, transport, origin);
        await ui.select(id);
        assert.equal(coldReplies.length, 23);
        for (const { record, index } of coldReplies) {
          const body = await checkReply(ui, record, index);
          if (record.status === "completed") await openOriginalCell(ui.page, body, materialId);
        }
      });
    }
  };
}

async function browserDeliveryTests(t, browser, app, base, json, restart) {
  const answers = page => page.locator("#thread .msg.assistant:not(#liveMsg)");
  const open = async (t, transport, origin = base) => {
    const context = await browser.newContext();
    t.after(() => context.close());
    const page = await context.newPage();
    const suffix = transport === "agui" ? "/?agentTransport=copilotkit" : "/";
    await page.goto(origin + suffix);
    await page.waitForFunction(expected => window.state?.agentTransport === expected && Boolean(window.state?.activeSession),
      transport === "agui" ? "copilotkit" : "legacy");
    const ready = () => page.waitForFunction(() => !window.state.streaming && !document.querySelector("#liveMsg"));
    async function select(id) {
      await page.locator(`[data-session="${id}"]`).click();
      await page.waitForFunction(id => window.state.activeSession === id, id);
    }
    async function newSession() {
      const previous = await page.evaluate(() => window.state.activeSession);
      await page.locator("#newSession").click();
      await page.waitForFunction(id => window.state.activeSession !== id, previous);
      const id = await page.evaluate(() => window.state.activeSession);
      return { id, entry: app.live.get(id) };
    }
    async function send(text) {
      await page.locator("#input").fill(text);
      await page.locator("#sendBtn").click();
    }
    async function reload(id) {
      await page.reload({ waitUntil: "domcontentloaded" });
      const selector = `[data-session="${id}"]`;
      await page.locator(selector).waitFor();
      if (await page.evaluate(() => window.state.activeSession) !== id) await select(id);
    }
    return { context, page, ready, select, newSession, send, reload };
  };

  let coldServer;
  const restartForColdChecks = () => coldServer ??= restart(t);
  const checkHistoryAfterRestart = await browserHistorySearch(t, { app, base, json, open, answers });

  for (const transport of ["legacy", "agui"]) {
    for (const scenario of [rewrite, citedContinuation]) {
      await t.test(`Chrome ${transport}: ${scenario.name} across disconnect, refresh and reopen`, async t => {
        const ui = await open(t, transport);
        const { id, entry } = await ui.newSession();
        const model = scriptModel(entry, scenario.steps);
        t.after(model.resume);
        await ui.send("请回答这个问题。");
        await bounded(model.paused, "browser send did not start verification");
        const liveGroup = ui.page.locator("#liveTools .tool-group");
        await liveGroup.locator("summary").click();
        assert.equal(await liveGroup.evaluate(node => node.open), true);
        assert.equal(await answers(ui.page).count(), 0);
        assert.ok(!(await ui.page.locator("#thread").innerText()).includes(scenario.draft));
        assert.equal(await ui.page.evaluate(() => window.state.streaming), true);

        const pending = entry.postAnswerRun;
        await ui.context.setOffline(true);
        model.resume();
        const record = await bounded(pending, "browser disconnection prevented settlement");
        await ui.context.setOffline(false);
        async function verifyAnswer() {
          const body = answers(ui.page).locator(".msg-body");
          await body.getByText(scenario.expected, { exact: true }).waitFor();
          await ui.ready();
          assert.equal(await answers(ui.page).count(), 1);
          assert.equal(await body.innerText(), scenario.expected);
          const refs = await body.locator("[data-locator]").evaluateAll(links => links.map(link => link.dataset.locator));
          assert.deepEqual(refs, scenario.cites.map(c => c.locator));
          const row = await ui.page.evaluate(id => window.state.messages.find(m => m.role === "assistant" && m.turnId === id), record.turnId);
          assert.deepEqual(publicAnswer(row), publicAnswer(record));
        }
        await verifyAnswer();
        const finishedGroup = answers(ui.page).locator("details.tool-group");
        assert.equal(await finishedGroup.evaluate(node => node.open), false);
        const timing = await finishedGroup.locator("summary").innerText();
        assert.match(timing, /用时 .*秒/);
        if (transport === "legacy") {
          await ui.page.evaluate(record => {
            const stream = window.state.es;
            const data = JSON.stringify({ type: "turn.delivered", record });
            stream.dispatchEvent(new MessageEvent("message", { data }));
            stream.dispatchEvent(new MessageEvent("message", { data }));
          }, record);
          await verifyAnswer();
        }
        await ui.reload(id);
        await verifyAnswer();
        assert.equal(await finishedGroup.locator("summary").innerText(), timing);
        await ui.newSession();
        await ui.select(id);
        await verifyAnswer();
        const process = answers(ui.page).locator("details.tool-group");
        await process.locator("summary").click();
        assert.equal(await process.evaluate(node => node.open), true);
        const restored = await json(`/api/sessions/${id}/state`);
        assert.match(restored.messages[1].tools[0].output, /工具原始输出/);
      });
    }
  }

  await t.test("Chrome AG-UI retries initial history recovery and ignores a late response after switching", async t => {
    const ui = await open(t, "agui");
    const { id, entry } = await ui.newSession();
    const expected = "历史的正式回答见 Model!B2。";
    scriptModel(entry, [{ tool: true, stopReason: "toolUse" }, { text: expected }]);
    await ui.send("保存带引用的回答");
    await answers(ui.page).locator(".msg-body").getByText(expected, { exact: true }).waitFor();
    const record = (await json(`/api/sessions/${id}/state`)).messages[1];
    const { id: otherId, entry: otherEntry } = await ui.newSession();
    scriptModel(otherEntry, [{ text: "另一会话的回答。" }]);
    await ui.send("另一会话的问题");
    await answers(ui.page).locator(".msg-body").getByText("另一会话的回答。", { exact: true }).waitFor();
    const pattern = `**/api/sessions/${id}/state?*`;
    const failFirst = async () => {
      await ui.page.route(pattern, route => route.abort("internetdisconnected"), { times: 1 });
      const failed = ui.page.waitForEvent("requestfailed", { predicate: req => req.url().includes(`/${id}/state?`), timeout: 5000 });
      await ui.select(id);
      await failed;
    };
    const body = answers(ui.page).locator(".msg-body");
    async function verifyRecovered() {
      await ui.page.evaluate(() => window.dispatchEvent(new Event("online")));
      await body.getByText(expected, { exact: true }).waitFor({ timeout: 5000 });
      assert.equal(await answers(ui.page).count(), 1);
      assert.deepEqual(await body.locator("[data-locator]").evaluateAll(nodes => nodes.map(n => n.dataset.locator)), ["Model!B2"]);
      assert.deepEqual(publicAnswer(await ui.page.evaluate(() => window.state.messages.find(m => m.role === "assistant"))), publicAnswer(record));
    }
    await failFirst();
    await verifyRecovered();

    await ui.select(otherId);
    await ui.page.route(pattern, route => route.fulfill({ status: 200, contentType: "application/json",
      body: '{"sessionId":' }), { times: 1 });
    await ui.select(id);
    await verifyRecovered();

    await ui.select(otherId);
    const retry = defer();
    const release = defer();
    t.after(release.resolve);
    await ui.page.route(pattern, async route => {
      const response = await route.fetch();
      retry.resolve();
      await release.promise;
      await route.fulfill({ response });
    }, { times: 1 });
    await failFirst();
    // The retry timer also works without an online event.
    await bounded(retry.promise, "initial snapshot was not retried");
    await ui.select(otherId);
    await body.getByText("另一会话的回答。", { exact: true }).waitFor();
    const oldRequest = ui.page.waitForEvent("requestfinished", { predicate: req => req.url().includes(`/${id}/state?`) });
    release.resolve();
    await oldRequest;
    assert.deepEqual(await body.allInnerTexts(), ["另一会话的回答。"]);
  });

  await t.test("Chrome framework cards follow each successful write and persist after refresh", async t => {
    const ui = await open(t, "legacy");
    const { id, entry } = await ui.newSession();
    const statePath = "exports/analysis-state.json";
    for (const [index, verdict] of ["早先框架判断", null, "更新框架判断"].entries()) {
      const text = ["框架正文。", "普通聊天正文。", "更新框架正文。"][index];
      const steps = [{ text }];
      if (index === 0) steps.unshift({ toolName: "write", stopReason: "toolUse", tool: { path: statePath,
        content: JSON.stringify({ presentation: { verdict: { text: verdict, status: "初始状态" } } }) } });
      if (index === 2) steps.unshift({ toolName: "edit", stopReason: "toolUse", tool: { path: statePath, edits: [
        { oldText: "早先框架判断", newText: verdict },
        { oldText: "初始状态", newText: "更新状态" },
      ] } });
      scriptModel(entry, steps);
      await ui.send(["摘要一", "普通问题", "摘要二"][index]);
      const row = answers(ui.page).nth(index);
      await row.locator(".msg-body").getByText(text, { exact: true }).waitFor();
      await ui.ready();
      const card = row.locator(".framework-presentation");
      if (verdict) assert.equal(await card.locator(".framework-verdict").innerText(), verdict);
      else assert.equal(await card.count(), 0);
    }
    const checkCards = async () => {
      await answers(ui.page).nth(2).locator(".framework-verdict").waitFor();
      assert.deepEqual(await answers(ui.page).locator(".framework-verdict").allTextContents(), ["早先框架判断", "更新框架判断"]);
      assert.equal(await answers(ui.page).nth(1).locator(".framework-presentation").count(), 0);
    };
    await checkCards();
    await ui.reload(id);
    await checkCards();
  });

  await t.test("Chrome shows real Pi paginated edits and per-card correction state across refresh and reopen", async t => {
    const ui = await open(t, "agui");
    const { id, entry } = await ui.newSession();
    const statePath = "exports/analysis-state.json";
    const otherPath = "exports/other/analysis-state.json";
    const sample = JSON.parse(await readFile(new URL("../skills/investment-framework/assets/analysis-state.example.json", import.meta.url)));
    const content = text => JSON.stringify({
      ...sample, presentation: { ...sample.presentation, verdict: { ...sample.presentation.verdict, text } },
    }, null, 2);
    await writeFile(join(entry.ctx.root, statePath), content("原判断"));
    const correction = await appendCorrection(entry.ctx.root, id, {
      claim: "核对框架数据", evidence: { type: "user", ref: "测试" }, turn: 0, from: 2, to: 3,
    });
    const mark = (path, status) => markArtifact(entry.ctx.root, id, correction.id, { path, status });
    await mark(statePath, "pending_merge");
    const read = { toolName: "read", stopReason: "toolUse", tool: { path: statePath, offset: 1, limit: 20 } };
    const edit = (oldText, newText) => ({
      toolName: "edit", stopReason: "toolUse", tool: { path: statePath, edits: [{ oldText, newText }] },
    });
    const turns = [
      { text: "框架正文。", verdict: "新判断", pending: true, steps: [read, edit("原判断", "新判断")] },
      { text: "另一框架正文。", verdict: "另一份框架", pending: false, steps: [
        { toolName: "write", stopReason: "toolUse", tool: { path: otherPath, content: content("另一份框架") } },
      ] },
      { text: "更新框架正文。", verdict: "第三版判断", pending: false, steps: [edit("新判断", "第三版判断")] },
      { text: "普通聊天正文。", steps: [] },
    ];
    async function checkCard(index) {
      const { text, verdict, pending } = turns[index];
      const row = answers(ui.page).nth(index);
      await row.locator(".msg-body").getByText(text, { exact: true }).waitFor();
      const card = row.locator(".msg-body + .framework-presentation");
      if (verdict) {
        const shown = await card.locator(".framework-verdict").innerText({ timeout: 2500 });
        assert.equal(shown.replace(/^关键判断：/, ""), verdict);
        assert.equal(await card.getByText("待并入", { exact: true }).count(), pending ? 1 : 0);
      } else assert.equal(await card.count(), 0);
    }
    for (const [index, {text, steps}] of turns.entries()) {
      if (index === 2) {
        await mark(statePath, "merged");
        await mark(otherPath, "pending_merge");
      }
      const model = scriptModel(entry, [...steps, { text, pause: index === 2 }]);
      t.after(model.resume);
      await ui.send(`请完成第${index + 1}轮工作。`);
      if (index === 2) {
        await bounded(model.paused, "framework edit did not reach the answer");
        const pending = entry.postAnswerRun;
        await ui.context.setOffline(true);
        model.resume();
        await bounded(pending, "framework delivery did not settle offline");
        await ui.context.setOffline(false);
      }
      await checkCard(index);
      await ui.ready();
    }
    const snapshot = await json(`/api/sessions/${id}/state`);
    const [first, second] = snapshot.messages.filter(m => m.role === "assistant");
    assert.match(first.tools.find(tool => tool.name === "read").output, /Use offset=/);
    assert.equal(first.analysisStatePendingMerge, true);
    assert.equal(second.analysisStatePendingMerge, false);
    await ui.reload(id);
    for (const index of turns.keys()) await checkCard(index);
    await ui.newSession();
    await ui.select(id);
    for (const index of turns.keys()) await checkCard(index);
  });

  await t.test("Chrome opens both cancelled legacy Pi histories", async t => {
    const context = app.projectManager.get(app.config.defaultProjectId);
    const fixtures = [];
    for (const fragment of ["", "取消前留下半句"]) {
      const manager = SessionManager.create(context.root, context.sessionsDir);
      manager.appendModelChange(app.config.model.provider, app.config.model.id);
      manager.appendThinkingLevelChange("off");
      manager.appendSessionInfo(fragment ? "旧取消半句" : "旧取消空回答");
      manager.appendMessage({ role: "user", content: "取消的问题", timestamp: Date.now() });
      manager.appendMessage({ role: "assistant", stopReason: "aborted",
        content: fragment ? [{ type: "text", text: fragment }] : [], timestamp: Date.now() });
      fixtures.push({ id: manager.getSessionId(), file: manager.getSessionFile(), fragment, original: await readFile(manager.getSessionFile()) });
    }
    const ui = await open(t, "legacy");
    for (const { id, file, fragment, original } of fixtures) {
      await ui.select(id);
      const body = answers(ui.page).locator(".msg-body");
      await body.getByRole("status").getByText("已取消", { exact: true }).waitFor();
      assert.equal((await body.innerText()).replace(/\s*已取消$/, "").trim(), fragment);
      assert.equal(await answers(ui.page).count(), 1);
      assert.deepEqual(await readFile(file), original);
    }
  });

  await t.test("Chrome opens a legacy Pi correction with its original tool process and a new managed reply", async t => {
    const context = app.projectManager.get(app.config.defaultProjectId);
    const manager = SessionManager.create(context.root, context.sessionsDir);
    const append = message => manager.appendMessage({ timestamp: Date.now(), ...message });
    const assistant = text => append({ role: "assistant", stopReason: "stop", content: [{ type: "text", text }] });
    manager.appendModelChange(app.config.model.provider, app.config.model.id);
    manager.appendThinkingLevelChange("off");
    manager.appendSessionInfo("旧会话回归");
    append({ role: "user", content: "旧问题" });
    append({ role: "assistant", stopReason: "toolUse", content: [
      { type: "toolCall", id: "legacy-read", name: "read", arguments: { path: "旧模型.xlsx" } },
    ] });
    append({ role: "toolResult", toolCallId: "legacy-read", toolName: "read", isError: false,
      content: [{ type: "text", text: "旧工具输出" }], details: { citations } });
    assistant(draft);
    manager.appendCustomMessageEntry("pe_answer_correct", "内部纠错提示", false);
    assistant(revised);
    manager.appendCustomEntry("pe_answer_lint", { citations });
    const id = manager.getSessionId();
    const file = manager.getSessionFile();
    const original = await readFile(file);
    const ui = await open(t, "legacy");
    await ui.select(id);
    const old = answers(ui.page).first();
    await old.locator(".msg-body").getByText(revised, { exact: true }).waitFor();
    assert.deepEqual(await old.locator(".msg-body [data-locator]").evaluateAll(nodes => nodes.map(n => n.dataset.locator)), ["Model!B2"]);
    await old.locator("summary.tool-summary").click();
    await old.locator(".tool-detail").getByText("旧模型.xlsx", { exact: true }).waitFor();
    await old.locator(".process-text").getByText(draft, { exact: true }).waitFor();
    assert.deepEqual(await readFile(file), original);
    scriptModel(app.live.get(id), [{ text: "新回合正式正文。" }]);
    await ui.send("新问题");
    await answers(ui.page).nth(1).locator(".msg-body").getByText("新回合正式正文。", { exact: true }).waitFor();
    await ui.reload(id);
    await answers(ui.page).nth(1).waitFor();
    assert.deepEqual(await answers(ui.page).locator(".msg-body").allInnerTexts(), [revised, "新回合正式正文。"]);
  });

  for (const transport of ["legacy", "agui"]) await t.test(`Chrome ${transport}: partial, failed and cancelled reasons`, async t => {
    const ui = await open(t, transport);
    for (const [status, label] of [["partial", "部分完成"], ["failed", "回答失败"], ["cancelled", "已取消"]]) {
      const { id, entry } = await ui.newSession();
      const text = "已核验见 Model!B2。其他见 Fake!C3。";
      const steps = status === "partial" ? [{ tool: true, stopReason: "toolUse" }, { text }, { text, pause: true }]
        : [{ text: "错误片段。", stopReason: "error", pause: true }];
      const model = scriptModel(entry, steps);
      t.after(model.resume);
      await ui.send("请回答。");
      await bounded(model.paused, "fixture did not reach terminal gate");
      const pending = entry.postAnswerRun;
      if (status === "cancelled") await ui.page.locator("#stopBtn").click();
      else model.resume();
      const record = await bounded(pending, "terminal turn did not settle");
      assert.equal(record.status, status);
      const verify = async () => {
        const badge = answers(ui.page).locator('[role="status"]');
        await badge.waitFor();
        assert.equal(await badge.innerText(), `${label} · ${record.reason}`);
        assert.equal(await answers(ui.page).count(), 1);
      };
      await verify();
      await ui.reload(id);
      await verify();
    }
  });

  await t.test("Chrome interleaved framework edits keep each session's verdict through process restart", async t => {
    const a = await open(t, "legacy");
    const b = await open(t, "agui");
    const sessionA = await a.newSession();
    const sessionB = await b.newSession();
    const root = sessionA.entry.ctx.root;
    const statePath = "exports/analysis-state.json";
    const file = join(root, statePath);
    const framework = JSON.parse(await readFile(new URL("../skills/investment-framework/assets/analysis-state.example.json", import.meta.url)));
    framework.revision = 2;
    framework.presentation.verdict.text = "原判断";
    await writeFile(file, JSON.stringify(framework, null, 2));
    const disk = async () => JSON.parse(await readFile(file, "utf8"));
    const verdict = state => state?.presentation.verdict.text;
    const read = (path) => ({ toolName: "read", stopReason: "toolUse", tool: { path, offset: 1, limit: 20 } });
    const edit = (path, oldText, newText) => ({
      toolName: "edit", stopReason: "toolUse", tool: { path, edits: [{ oldText, newText }] },
    });
    const modelA = scriptModel(sessionA.entry, [
      read("@" + statePath), edit("@" + statePath, "原判断", "判断甲版"), { text: "判断甲版。", pause: true },
    ]);
    t.after(modelA.resume);
    scriptModel(sessionB.entry, [
      read(statePath), edit(statePath, "判断甲版", "判断乙版"), { text: "判断乙版。" },
    ]);

    function checkRecord(record, expected, pending) {
      assert.equal(record.status, "completed", record.reason);
      assert.equal(record.text, expected + "。");
      assert.equal(verdict(record.analysisState), expected, "delivered framework verdict");
      assert.equal(record.analysisState.revision, 2);
      assert.equal(record.analysisStatePath, statePath);
      assert.equal(record.analysisStatePendingMerge, pending);
    }
    async function checkBrowser(ui, expected, pending) {
      const messages = answers(ui.page);
      await messages.locator(".msg-body").getByText(expected + "。", { exact: true }).waitFor();
      assert.equal(await messages.count(), 1);
      const card = messages.locator(".msg-body + .framework-presentation");
      assert.equal((await card.locator(".framework-verdict").innerText()).replace(/^关键判断：/, ""), expected);
      assert.equal(await card.getByText("待并入", { exact: true }).count(), pending ? 1 : 0);
    }
    await a.send("更新甲版");
    await bounded(modelA.paused, "A did not reach final generation after editing");
    assert.equal(verdict(await disk()), "判断甲版");
    const pendingA = sessionA.entry.postAnswerRun;
    const stateA = await json(`/api/sessions/${sessionA.id}/state`);
    assert.equal(stateA.streaming, true);
    assert.match(stateA.messages[1].tools.find(tool => tool.name === "read").output, /Use offset=/);
    const correction = await appendCorrection(root, sessionA.id, {
      claim: "核对框架数据", evidence: { type: "user", ref: "测试" }, turn: 0, from: 2, to: 3,
    });
    await markArtifact(root, sessionA.id, correction.id, { path: statePath, status: "pending_merge" });

    await b.send("更新乙版");
    await checkBrowser(b, "判断乙版", false);
    assert.equal(verdict(await disk()), "判断乙版");
    assert.equal((await json(`/api/sessions/${sessionA.id}/state`)).streaming, true);
    const stored = entry => entry.session.sessionManager.getBranch().findLast(row => row.customType === "pe_turn_delivery")?.data;
    checkRecord(stored(sessionB.entry), "判断乙版", false);
    modelA.resume();
    await bounded(pendingA, "A did not finish after B was delivered");
    checkRecord(stored(sessionA.entry), "判断甲版", true);
    await checkBrowser(a, "判断甲版", true);

    for (const [ui, id, expected, pending] of [
      [a, sessionA.id, "判断甲版", true], [b, sessionB.id, "判断乙版", false],
    ]) {
      await ui.reload(id);
      await checkBrowser(ui, expected, pending);
      await ui.newSession();
      await ui.select(id);
      await checkBrowser(ui, expected, pending);
    }

    await Promise.all([a.context.close(), b.context.close()]);
    const childBase = await restartForColdChecks();
    for (const [transport, id, expected, pending] of [
      ["legacy", sessionA.id, "判断甲版", true], ["agui", sessionB.id, "判断乙版", false],
    ]) {
      const restored = await (await networkRequest(childBase, `/api/sessions/${id}/state`)).json();
      checkRecord(restored.messages[1], expected, pending);
      const ui = await open(t, transport, childBase);
      try {
        await ui.select(id);
        await checkBrowser(ui, expected, pending);
      } finally {
        await ui.context.close();
      }
    }
  });
  await t.test("historical sources restored by the new service", async t => checkHistoryAfterRestart(t, await restartForColdChecks()));
}

await test("real TCP SSE and browser turn delivery", async t => {
  const root = await mkdtemp(join(tmpdir(), "pe-delivery-tcp-"));
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "offline-test-credential";
  let app;
  let base;
  t.after(async () => {
    try { await app?.close(); } finally {
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
      await rm(root, { recursive: true, force: true });
    }
  });
  const config = await loadConfig({ root, env: {
    ASR: "0", WATCH_SCHEDULER: "0", TRACKING_SCHEDULER: "0", MONITOR_SCHEDULER: "0", SOURCE_SCHEDULER: "0",
  } });
  async function startServer(port = 0) {
    app = await createWorkbench({ config: { ...config, root: REPO_ROOT, toolNames: [...config.toolNames, source.name] },
      logger: { log() {}, warn() {}, error() {} } });
    app.projectManager.get(config.defaultProjectId).tools.push(source);
    ({ url: base } = await app.listen(port, "127.0.0.1"));
  }
  await startServer();
  const ag = "/api/ag-ui/agent/pi";
  const json = async (pathname, body) => (await networkRequest(base, pathname, body)).json();
  const saved = [];

  for (const transport of ["legacy", "agui"]) {
    for (const scenario of [rewrite, citedContinuation]) {
      await t.test(`TCP ${transport}: ${scenario.name}`, async t => {
        const { id } = await json("/api/sessions", {});
        const entry = app.live.get(id);
        const url = `/api/sessions/${id}`;
        const model = scriptModel(entry, scenario.steps);
        t.after(model.resume);
        const question = "请回答这个问题。";
        const stream = transport === "legacy"
          ? await networkStream(t, base, url + "/events")
          : await networkStream(t, base, ag + "/run", { threadId: id, prompt: question });
        if (transport === "legacy") await json(url + "/messages", { text: question });

        await bounded(model.paused, "Pi never entered verification");
        const progress = transport === "legacy" ? "tool.completed" : "TOOL_CALL_RESULT";
        await until(() => stream.frames.some(({ data }) => data.type === progress), "tool progress did not arrive over TCP");
        assert.ok(!JSON.stringify(stream.frames).includes(scenario.draft));
        const execution = entry.session.sessionManager.getBranch();
        assert.ok(execution.some(item => item.type === "message" && item.message.role === "assistant" &&
          item.message.content.some(block => block.type === "text" && block.text === scenario.draft)));
        assert.ok(execution.some(item => item.type === "custom_message" &&
          item.customType === (scenario === rewrite ? "pe_answer_correct" : "pe_answer_continue")));
        assert.ok(!stream.frames.some(({ data }) =>
          ["turn.delivered", "run.settled", "RUN_FINISHED", "RUN_ERROR"].includes(data.type)));
        const cursor = stream.frames.at(-1).id;
        stream.disconnect();
        await bounded(stream.done, "disconnected reader did not close");

        const pending = await json(url + "/state");
        assert.equal(pending.messages.find(m => m.role === "assistant").status, "pending");
        assert.equal(pending.streaming, true);
        const resumed = transport === "legacy"
          ? await networkStream(t, base, url + "/events")
          : await networkStream(t, base, ag + "/connect", { threadId: id, afterEventId: cursor });
        model.resume();
        const delivery = await until(() => resumed.frames.map(f => f.data)
          .find(e => e.type === "turn.delivered" || e.name === "pe.turn_delivery"), "reconnected socket did not receive delivery");
        const record = delivery.value ?? delivery.record;
        assert.equal(record.status, "completed");
        assert.equal(record.text, scenario.expected);
        assert.deepEqual(record.citations, scenario.cites);
        assert.equal(record.turnId, pending.activeTurnId);
        assert.deepEqual(publicAnswer((await json(url + "/state")).messages[1]), publicAnswer(record));
        if (transport === "agui") {
          await bounded(resumed.done, "AG-UI stream did not close after terminal event");
          const replay = await networkStream(t, base, ag + "/connect", { threadId: id, afterEventId: cursor });
          await bounded(replay.done, "terminal replay did not close");
          assert.deepEqual(replay.frames, resumed.frames);
        }
        resumed.disconnect();
        saved.push({ url, record });
      });
    }
  }
  async function restart(t) {
    await app.close();
    app = null;
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import { loadConfig, REPO_ROOT } from "./server/config.mjs";
      import { createWorkbench } from "./server/create-app.mjs";
      const config = await loadConfig({ root: process.argv[1], env: {
        ASR: "0", WATCH_SCHEDULER: "0", TRACKING_SCHEDULER: "0", MONITOR_SCHEDULER: "0", SOURCE_SCHEDULER: "0",
      } });
      const app = await createWorkbench({ config: { ...config, root: REPO_ROOT }, logger: { log() {}, warn() {}, error() {} } });
      const { url } = await app.listen(0, "127.0.0.1");
      process.send(url);
      process.on("SIGTERM", async () => { await app.close(); process.exit(0); });
    `, root], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
    const exit = once(child, "exit");
    t.after(async () => {
      child.kill();
      await bounded(exit, "restart fixture did not exit");
    });
    const [childBase] = await bounded(once(child, "message"), "new service process did not start");
    return childBase;
  }
  await t.test("a new server process reloads delivered turn records over TCP", async t => {
    const childBase = await restart(t);
    for (const { url, record } of saved) {
      const fresh = await (await networkRequest(childBase, url + "/state")).json();
      assert.deepEqual(publicAnswer(fresh.messages[1]), publicAnswer(record));
      assert.equal(fresh.streaming, false);
      if (record.runId) {
        const replay = await networkStream(t, childBase, ag + "/connect", { threadId: fresh.sessionId });
        await bounded(replay.done, "persisted AG-UI replay did not close after restart");
        assert.deepEqual(replay.frames.filter(f => f.data.name === "pe.turn_delivery").map(f => f.data.value), [record]);
      }
    }
  });

  const playwrightPath = process.env.PE_BROWSER_PLAYWRIGHT;
  if (playwrightPath) {
    await startServer();
    const { chromium } = await import(pathToFileURL(playwrightPath).href);
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    t.after(() => browser.close());
    await browserDeliveryTests(t, browser, app, base, json, restart);
  }
});

await test("Issue #10 regressions through uploads, Pi chat, delivery and refresh", async t => {
  const root = await mkdtemp(join(tmpdir(), "pe-delivery-xlsx-"));
  const oldKey = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "offline-test-credential";
  let app;
  t.after(async () => {
    try { await app?.close(); } finally {
      if (oldKey === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = oldKey;
      await rm(root, { recursive: true, force: true });
    }
  });
  const config = await loadConfig({ root, env: {
    ASR: "0", WATCH_SCHEDULER: "0", TRACKING_SCHEDULER: "0", MONITOR_SCHEDULER: "0", SOURCE_SCHEDULER: "0",
  } });
  // New sessions must create source-linked topics without extra model requests on delivery.
  const topicIndex = registerFauxProvider();
  t.after(() => topicIndex.unregister());
  const topicSummary = "已核验的工作簿指标";
  let topicProposalCalls = 0;
  const proposeSummary = () => {
    topicProposalCalls++;
    topicIndex.appendResponses([proposeSummary]);
    return fauxAssistantMessage(JSON.stringify({ summary: topicSummary }));
  };
  topicIndex.setResponses([proposeSummary]);
  app = await createWorkbench({ config: { ...config, indexModel: topicIndex.getModel() } });
  execFileSync(process.env.PYTHON_BIN || "python3", ["-c", `
from openpyxl import Workbook
from pathlib import Path
import sys
for filename, value in [('A.xlsx', 111), ('B.xlsx', 222)]:
    book = Workbook()
    book.active.title = 'Model'
    book.active['B1'] = '2025年'
    book.active['A2'] = '收入'
    book.active['B2'] = value
    if filename == 'A.xlsx':
        book.active['C2'] = 112
        book.active['A3'] = '净利润'
        book.active['B3'] = 33
    book.save(Path(sys.argv[1]) / filename)
`, root]);
  const [a, b] = await Promise.all(["A.xlsx", "B.xlsx"].map(async name =>
    (await request(app, "/api/upload", await readFile(join(root, name)), {
      "x-file-name": name, "content-type": "application/octet-stream",
    })).json()));
  const query = (book, sheet = "Model", coord = "B2") => ({
    tool: { path: book.path, query: `${sheet}!${coord}`, sheet }, stopReason: "toolUse",
  });
  const aRef = "A.xlsx 的收入为 111（见 [A.xlsx]Model!B2）。";
  const bRef = "B.xlsx 的收入为 222（见 [B.xlsx]Model!B2）。";

  async function turn(question, steps, { attachments = [], transport = "legacy" } = {}) {
    const { id } = (await request(app, "/api/sessions", {})).json();
    const entry = app.live.get(id);
    const model = scriptModel(entry, steps);
    const url = `/api/sessions/${id}`;
    if (transport === "agui") {
      const stream = await request(app, "/api/ag-ui/agent/pi/run", { threadId: id, prompt: question, attachments });
      stream.disconnect();
    } else {
      await request(app, url + "/messages", { text: question, attachments });
    }
    const record = await bounded(entry.postAnswerRun, "turn did not settle");
    const messages = (await request(app, url + "/state")).json().messages;
    const assistant = messages.find(m => m.role === "assistant");
    assert.deepEqual(publicAnswer(assistant), publicAnswer(record), "refresh must use the persisted delivery");
    const entries = entry.session.sessionManager.getBranch();
    assert.deepEqual(entries.filter(e => e.customType === "pe_turn_delivery").map(e => e.data), [record]);
    assert.equal(model.count(), steps.length);
    assert.equal(messages.find(m => m.role === "user").text, question);
    return { record, assistant, entries, entry, modelQuestion: entry.session.messages.find(m => m.role === "user").content };
  }

  globalThis.document = { querySelector: () => null };
  globalThis.window = {};
  const { messageHTML } = await import("../ui/chat/renderer.js");
  const bootstrap = await readFile(new URL("../ui/bootstrap.js", import.meta.url), "utf8");
  const clickHandler = bootstrap.match(/threadEl\.addEventListener\('click', (e => \{[\s\S]*?\n  \})\);/)[1];
  async function openedCells(message) {
    const body = messageHTML({ ...message, tools: [] });
    const opened = [];
    const click = vm.runInNewContext(clickHandler, {
      openFile: (materialId, version, locator) => opened.push({ materialId, version, locator }),
    });
    for (const [button] of body.matchAll(/<button[^>]+data-cell-cite[^>]+>/g)) {
      const dataset = Object.fromEntries([...button.matchAll(/data-([\w-]+)="([^"]*)"/g)]
        .map(([, key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
      click({ target: { closest: selector => selector === "[data-cell-cite]" ? { dataset } : null } });
    }
    return Promise.all(opened.map(async ({ materialId, version, locator }) => {
      const [sheet, coord] = locator.split("!");
      const base = `/api/materials/${materialId}/versions/${version}/workbook`;
      const manifest = (await request(app, base)).json();
      const grid = (await request(app, `${base}/sheets/${sheet}`)).json();
      const [, column, row] = /^([A-Z])(\d+)$/.exec(coord);
      return { materialId, version, locator, filename: manifest.fileName,
        value: grid.cells.find(([r, c]) => r === Number(row) && c === column.charCodeAt(0) - 64)?.[2] };
    }));
  }
  const destination = (book, value, coord = "B2") => ({
    materialId: book.material.id, version: 1, locator: `Model!${coord}`, filename: book.name, value,
  });
  for (const reads of [[a, b], [b, a]]) {
    for (const [asked, response, expected] of [
      ["A.xlsx", aRef, [destination(a, 111)]],
      ["B.xlsx", bRef, [destination(b, 222)]],
      ["A.xlsx 和 B.xlsx", aRef + bRef, [destination(a, 111), destination(b, 222)]],
    ]) {
      await t.test(`references for ${asked}, reading ${reads.map(book => book.name).join(" then ")}`, async () => {
        const { record, assistant, entry } = await turn(`${asked} 的收入是多少？`, [...reads.map(book => query(book)), { text: response }]);
        assert.deepEqual(await openedCells(assistant), expected);
        assert.equal(record.status, "completed");
        assert.equal(record.text, response);
        const ledger = await readLedger(entry.ctx.root, entry.id);
        assert.ok(ledger.topics.some(topic => topic.summary && topic.factIds.length &&
          topic.factIds.every(id => ledger.facts.some(fact => fact.id === id))));
        assert.equal(topicProposalCalls, 0, 'navigation summaries must not make paid model calls during delivery');
      });
    }
  }
  await t.test("an ambiguous bare reference requests correction", async () => {
    const draft = "收入为 111，见 Model!B2。";
    const { record, assistant, entries } = await turn("A.xlsx 的收入是多少？",
      [query(a), query(b), { text: draft }, { text: aRef }]);
    assert.ok(entries.some(e => e.customType === "pe_answer_correct"));
    assert.equal(record.text, aRef);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });
  await t.test("an explicitly unverified bare reference stays unlinked after refresh", async () => {
    const response = aRef + "另一个出处 Model!B2（未核验）。";
    const { record, assistant } = await turn("说明 A.xlsx 的收入。", [query(a), query(b), { text: response }]);
    assert.equal(record.text, response);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });

  for (const stopReason of ["length", "stop"]) {
    for (const [name, prefix, delta, expected] of [
      ["local echo", "第一项已核实。第二项取决于", "第二项取决于交付日期。", "第一项已核实。第二项取决于交付日期。"],
      ["suffix echo within a clause", "第一项已核实。第二项主要取决于交付", "取决于交付日期。", "第一项已核实。第二项主要取决于交付日期。"],
      ["no overlap", "第一项已核实。第二项取决于", "交付日期。", "第一项已核实。第二项取决于交付日期。"],
      ["whole prefix", "第一项已核实。第二项取决于", "第一项已核实。第二项取决于交付日期。", "第一项已核实。第二项取决于交付日期。"],
      ["natural repetition", "这件事还要再", "再考虑一下。", "这件事还要再再考虑一下。"],
      ["short restarted metric", "第一项已核实。毛利率", "毛利率略有下降。", "第一项已核实。毛利率略有下降。"],
      ["restarted metric before a colon", "第一项已核实。毛利率", "毛利率：维持原先水平。", "第一项已核实。毛利率：维持原先水平。"],
      ["short repetition inside a clause", "第一项已核实。这个结论很重要", "很重要，需要记录。", "第一项已核实。这个结论很重要很重要，需要记录。"],
      ["natural three-character repetition at the sentence start", "终于通过了。太好了", "太好了终于能交付了。", "终于通过了。太好了太好了终于能交付了。"],
    ]) {
      await t.test(`continuation ${stopReason}: ${name}`, async () => {
        const { record, entries } = await turn("请说明结论。", [{ text: prefix, stopReason }, { text: delta }]);
        assert.equal(record.text, expected);
        assert.equal(record.status, "completed");
        assert.ok(entries.some(e => e.customType === "pe_answer_continue"));
      });
    }
  }
  await t.test("continuation length: replay of a complete sentence", async () => {
    const { record } = await turn("请说明结论。", [
      { text: "第一项已核实。第二项也已核实。", stopReason: "length" },
      { text: "第二项也已核实。交付日期待定。" },
    ]);
    assert.equal(record.text, "第一项已核实。第二项也已核实。交付日期待定。");
    assert.equal(record.status, "completed");
  });
  for (const [name, question, suffix, status] of [
    ["single metric recovered", "收入是多少？", "", "completed"],
    ["second metric declared missing", "收入和净利润各是多少？", "\n\n未核验：净利润。", "partial"],
    ["second metric left unanswered", "收入和净利润各是多少？", "", "partial"],
  ]) {
    await t.test(`workbook retry delivery: ${name}`, async () => {
      const revenue = "收入为 111，见 Model!B2。";
      const { record, assistant } = await turn(question, [
        query(a, "WrongSheet"), query(a), { text: revenue + suffix },
      ]);
      assert.deepEqual(assistant.tools.map(tool => tool.status), ["error", "done"]);
      assert.equal(record.status, status);
      assert.equal(record.text, revenue);
      if (status === "partial") assert.match(record.reason, /净利润/);
    });
  }
  await t.test("workbook retry delivery: both requested values recovered", async () => {
    const response = "A表收入为 111，见 [A.xlsx]Model!B2。B表收入为 222，见 [B.xlsx]Model!B2。";
    const { record, assistant } = await turn("A表收入和B表收入各是多少？", [
      query(a, "WrongSheet"), query(a), query(b), { text: response },
    ]);
    assert.equal(record.status, "completed");
    assert.equal(record.text, response);
    assert.deepEqual(assistant.tools.map(tool => tool.status), ["error", "done", "done"]);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(b, 222)]);
  });
  for (const question of ["2025年净利润是多少？", "请给出2025年净利润", "What was net income?"]) {
    await t.test(`a revenue answer requires correction for ${question}`, async () => {
      const revenue = "收入为 111，见 Model!B2。";
      const corrected = "净利为 33，见 Model!B3。" + revenue;
      const { record, entries } = await turn(question, [
        query(a), { text: revenue }, query(a, "Model", "B3"), { text: corrected },
      ]);
      assert.ok(entries.some(e => e.customType === "pe_answer_correct"));
      assert.equal(record.status, "completed");
      assert.equal(record.text, corrected);
    });
  }
  await t.test("an unrelated caveat permits a checked amount and triggers correction for an unsupported one", async () => {
    const corrected = "其他假设未核验，营业收入为 111，见 Model!B2。";
    const { record, entries } = await turn("收入是多少？", [
      query(a), { text: "其他假设未核验，收入为 789 亿元。" }, { text: corrected },
    ]);
    assert.ok(entries.some(e => e.customType === "pe_answer_correct"));
    assert.equal(record.status, "completed");
    assert.equal(record.text, corrected);
  });
  for (const question of ["收入和净利润各是多少？", "请分别给出收入和净利润", "列出收入和净利润"]) {
    for (const [transport, attachments] of [["legacy", []], ["legacy", [a.path]], ["agui", [a.path]]]) {
      await t.test(`missing profit: ${question} (${transport}, ${attachments.length ? "attached" : "unattached"})`, async () => {
        const response = "收入为 111";
        const { record, assistant, entries, modelQuestion } = await turn(question, [
          query(a, "WrongSheet"), query(a), { text: response },
        ], { transport, attachments });
        assert.equal(record.status, "partial");
        assert.match(record.reason, /净利润/);
        assert.equal(record.text, response);
        assert.deepEqual(assistant.tools.map(tool => tool.status), ["error", "done"]);
        assert.equal(entries.find(e => e.customType === "pe_turn_started").data.question, question);
        if (attachments.length) assert.ok(JSON.stringify(modelQuestion).includes(a.path));
      });
    }
  }
  await t.test("a cited income answer still has a profit gap with the workbook attached", async () => {
    const response = "收入为 111，见 Model!B2。";
    const { record, assistant } = await turn("收入和净利润各是多少？", [
      query(a, "WrongSheet"), query(a), { text: response },
    ], { attachments: [a.path] });
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });
  for (const phrasing of ["为", "约为"]) {
    await t.test(`an income citation cannot substantiate 净利润${phrasing} 111`, async () => {
      const revenue = "收入为 111，见 Model!B2。";
      const { record, assistant } = await turn("列出收入和净利润", [
        query(a, "WrongSheet"), query(a), { text: revenue + `净利润${phrasing} 111，见 Model!B2。` },
      ]);
      assert.equal(record.status, "partial");
      assert.match(record.reason, /净利润/);
      assert.equal(record.text, revenue);
      assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
    });
  }
  const metrics = [
    { name: "收入", value: 111, coord: "B2" },
    { name: "净利润", value: 33, coord: "B3" },
  ];
  async function checkMetricAnswer(question, layout, reads, answers) {
    const reported = metrics.slice(0, answers);
    const response = layout === "table"
      ? ["| 指标 | 数值 | 出处 |", "| --- | --- | --- |",
        ...reported.map(m => `| ${m.name} | ${m.value} | Model!${m.coord} |`)].join("\n")
      : reported.map(m => `${m.name}为${m.value}，见 Model!${m.coord}。`).join("");
    const { record, assistant } = await turn(question, [
      ...metrics.slice(0, reads).map(m => query(a, "Model", m.coord)), { text: response },
    ], { attachments: [a.path] });
    assert.equal(record.status, answers === 2 ? "completed" : "partial", JSON.stringify(record));
    if (answers === 1) assert.match(record.reason, /净利润/);
    assert.equal(record.text, response);
    assert.deepEqual(record.citations.map(c => c.locator), reported.map(m => "Model!" + m.coord));
    const targets = reported.map(m => destination(a, m.value, m.coord));
    assert.deepEqual(await openedCells({ role: "assistant", ...record }), targets);
    assert.deepEqual(await openedCells(assistant), targets);
  }
  for (const question of ["2025年收入和净利润各是多少？", "2025年收入和净利润是多少？"]) {
    for (const layout of ["paragraph", "table"]) {
      for (const count of [2, 1]) {
        await t.test(`metric coverage: ${question} (${layout}, ${count} answered)`,
          () => checkMetricAnswer(question, layout, count, count));
      }
    }
  }
  await t.test("metric coverage: polite list request", () =>
    checkMetricAnswer("请帮我列出收入和净利润", "paragraph", 1, 1));
  await t.test("metric coverage: profit read but omitted from answer", () =>
    checkMetricAnswer("2025年收入和净利润是多少？", "paragraph", 2, 1));
  await t.test("metric coverage: a table row must cite its own value even when both cells were read", async () => {
    const verified = "| 指标 | 数值 | 出处 |\n| --- | --- | --- |\n| 收入 | 111 | Model!B2 |";
    const { record, assistant } = await turn("2025年收入和净利润是多少？", [
      query(a), query(a, "Model", "B3"), { text: verified + "\n| 净利润 | 33 | Model!B2 |" },
    ], { attachments: [a.path] });
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.equal(record.text, verified);
    assert.deepEqual(record.citations.map(c => c.locator), ["Model!B2"]);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111)]);
  });
  for (const [opening, closing] of [["（", "）"], [" —— ", ""]]) {
    await t.test(`an explicit gap keeps verified list items ending in ${opening}source${closing}`, async () => {
      const body = metrics.map(m => `- 2025年${m.name}：${m.value}${opening}[A.xlsx]Model!${m.coord}${closing}`).join("\n");
      const { record, assistant } = await turn("2025年收入和净利润是多少？", [
        query(a), query(a, "Model", "B3"), { text: body + "\n\n未核验：单位。" },
      ], { attachments: [a.path] });
      assert.equal(record.status, "partial");
      assert.match(record.reason, /未核验：单位/);
      assert.equal(record.text, body);
      assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
    });
  }
  for (const [name, reads, response] of [
    ["swapped references before the claims", ["B2", "B3"], "根据 Model!B3，收入为111；根据 Model!B2，净利润为33。"],
    ["only the year was read", ["B1"], "年份为2025年，见 Model!B1。"],
    ["no workbook read", [], "已查阅完毕。"],
  ]) {
    await t.test(`metric coverage: ${name}`, async () => {
      const { record } = await turn("请帮我列出收入和净利润", [
        ...reads.map(coord => query(a, "Model", coord)), { text: response },
      ], { attachments: [a.path] });
      if (name === "swapped references before the claims") {
        // Reconstruct from the two independent cell reads. Do not keep the
        // draft's switched references or mark the original claims verified.
        assert.equal(record.status, "partial");
        assert.match(record.text, /净利润 33（\[A\.xlsx\]Model!B3）/);
        assert.match(record.text, /收入 111（\[A\.xlsx\]Model!B2）/);
        assert.ok(!record.text.includes(response));
        assert.deepEqual(new Set(record.citations.map(c=>c.locator)),new Set(["Model!B2","Model!B3"]));
        return;
      }
      assert.equal(record.status, "failed", JSON.stringify(record));
      assert.equal(record.text, "");
      assert.deepEqual(record.citations, []);
      assert.match(record.reason, /收入/);
      assert.match(record.reason, /净利润/);
    });
  }
  for (const [name, response] of [
    ["coordinated claims", "收入和净利润分别为111（Model!B2）和33（Model!B3）。"],
    ["metrics in column headings", "| 指标 | 收入 | 净利润 |\n| --- | --- | --- |\n| 数值 | 111（Model!B2） | 33（Model!B3） |"],
  ]) {
    await t.test(`metric coverage: ${name}`, async () => {
      const { record, assistant } = await turn("2025年收入和净利润是多少？", [
        query(a), query(a, "Model", "B3"), { text: response },
      ], { attachments: [a.path] });
      assert.equal(record.status, "completed", JSON.stringify(record));
      assert.equal(record.text, response);
      assert.deepEqual(record.citations.map(c => c.locator), ["Model!B2", "Model!B3"]);
      assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
    });
  }
  await t.test("a period and bold label do not drop a verified plain income value", async () => {
    const response = "2025年，**收入：** 111";
    const { record } = await turn("2025年收入和净利润各是多少？", [
      query(a, "WrongSheet"), query(a), { text: response },
    ]);
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.equal(record.text, response);
  });
  await t.test("period and punctuation do not hide an answered metric", async () => {
    const response = "2025年，收入为111，见 Model!B2。净利润为33，见 Model!B3。";
    const { record, assistant } = await turn("2025年收入和净利润各是多少？", [
      query(a, "WrongSheet"), query(a), query(a, "Model", "B3"), { text: response },
    ]);
    assert.equal(record.status, "completed");
    assert.equal(record.text, response);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
  });
  await t.test("a verified value does not substantiate a second unsupported value for the same metric", async () => {
    const revenue = "收入为111，见 Model!B2。";
    const profit = "净利润为33，见 Model!B3。";
    const { record, assistant } = await turn("2025年收入和净利润各是多少？", [
      query(a), query(a, "Model", "B3"),
      { text: revenue + profit + "净利润约为99，见 Model!B3。" },
    ]);
    assert.equal(record.status, "partial");
    assert.match(record.reason, /净利润/);
    assert.equal(record.text, revenue + "\n" + profit);
    assert.deepEqual(await openedCells(assistant), [destination(a, 111), destination(a, 33, "B3")]);
  });
  for (const [layout, response] of [
    ["on one line", "见 `[A.xlsx]Model!B2`、`C2`。"],
    ["across a Markdown soft break", "见 `[A.xlsx]Model!B2`、\n`C2`。"],
  ]) {
    await t.test(`code-formatted shorthand ${layout} opens both cells after refresh`, async () => {
      const { record, assistant } = await turn("请给出两个单元格的出处。", [
        query(a), query(a, "Model", "C2"), { text: response },
      ]);
      assert.equal(record.status, "completed");
      assert.equal(record.text, response);
      const targets = [destination(a, 111), destination(a, 112, "C2")];
      assert.deepEqual(await openedCells({ role: "assistant", ...record }), targets);
      assert.deepEqual(await openedCells(assistant), targets);
    });
  }
});
