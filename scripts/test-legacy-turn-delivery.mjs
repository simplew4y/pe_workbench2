import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createTranscriptSearchTool } from "../lib/transcript-search-tool.mjs";
import { referencedJudgments, snapshotMessages, transcriptMessages } from "../server/agent/snapshot.mjs";
import { startTurn, saveTurnDelivery } from "../server/agent/turn-delivery.mjs";

const [citeA, citeB] = [1, 2].map(n => ({ id: "cite-" + n, materialId: "book", version: 1, locator: "Model!A" + n }));
const draft = "首稿使用 Model!A1。";
const revision = "改稿使用 Model!A2。";
const prefix = "此前依据 Model!A1，";
const suffix = "此后依据 Model!A2。";

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pe-legacy-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root);
  const ctx = { root };
  const user = content => manager.appendMessage({ role: "user", timestamp: Date.now(), content });
  const assistant = (text, stopReason = "stop") => manager.appendMessage({
    role: "assistant", timestamp: Date.now(), stopReason, content: text ? [{type: "text", text}] : [],
  });
  const lint = citations => manager.appendCustomEntry("pe_answer_lint", { citations });
  const tool = (id, citation) => {
    manager.appendMessage({ role: "assistant", timestamp: Date.now(), stopReason: "toolUse",
      content: [{ type: "toolCall", id, name: "read", arguments: { path: "model.xlsx" } }] });
    manager.appendMessage({ role: "toolResult", toolCallId: id, toolName: "read", timestamp: Date.now(),
      content: [{ type: "text", text: "旧工具原始输出" }], details: { citations: [citation] }, isError: false });
  };
  async function restore() {
    const file = manager.getSessionFile();
    const before = await readFile(file);
    const reopened = SessionManager.open(file, root);
    const session = { sessionManager: reopened, messages: reopened.buildSessionContext().messages };
    const messages = snapshotMessages(session, ctx);
    const search = createTranscriptSearchTool({ getMessages: () => transcriptMessages(session, ctx) });
    const query = async (query, turn) => (await search.execute("search", { query, turn })).details.matches;
    assert.deepEqual(await readFile(file), before, "reading history must leave the Pi JSONL intact");
    return { answers: messages.filter(item => item.role === "assistant"), query, session };
  }
  return {
    manager, user, assistant, lint, tool, restore,
    continuation() {
      user("续写问题");
      tool("old-source-a", citeA);
      assistant(prefix, "length");
      lint([citeA]);
      manager.appendCustomMessageEntry("pe_answer_continue", "内部续写提示", false);
      tool("old-source-b", citeB);
      assistant(suffix);
      lint([citeA, citeB]);
    },
    correction() {
      user("纠错问题");
      tool("old-draft-source", citeA);
      assistant(draft);
      lint([citeA]);
      manager.appendCustomMessageEntry("pe_answer_correct", "内部纠错提示", false);
      tool("old-revision-source", citeB);
      assistant(revision);
      lint([citeA, citeB]);
    },
  };
}

await test("Pi legacy continuation restores and searches both halves", async t => {
  const f = await fixture(t);
  f.continuation();
  const { answers: [answer], query, session } = await f.restore();
  assert.equal(answer.text, prefix + suffix);
  assert.deepEqual(answer.citations, [citeA, citeB]);
  assert.deepEqual((await query("此前依据 此后依据"))[0]?.citations, [citeA, citeB]);
  assert.deepEqual(await query("内部续写提示"), []);
  const boundary = session.messages.length;
  session.sessionManager.appendMessage({ role: "user", content: "当前问题", timestamp: Date.now() });
  assert.ok(transcriptMessages(session, null, { legacyBoundary: boundary }).some(m => m.content === prefix + suffix));
  assert.ok(!transcriptMessages(session, null, { legacyBoundary: boundary }).some(m => m.content === "当前问题"));
});

await test("Pi legacy correction restores only the replacement and its citations", async t => {
  const f = await fixture(t);
  f.correction();
  const { answers: [answer], query } = await f.restore();
  assert.equal(answer.text, revision);
  assert.deepEqual(answer.citations, [citeB]);
  assert.match(answer.processText, /首稿/);
  assert.deepEqual(await query("首稿"), []);
  assert.deepEqual((await query("改稿"))[0]?.citations, [citeB]);
});

await test("revisions compare against the answer shown on the active branch", async t => {
  const f = await fixture(t);
  f.correction();
  const session = { sessionManager: f.manager, messages: [] };
  const entry = { session };
  startTurn(entry, { turnId: 'second', question: 'Q2' });
  f.user('Q2');
  f.assistant('内部候选，不应送给复盘');
  saveTurnDelivery(entry, { turnId: 'second', status: 'partial', text: '实际交付的现金流判断' });
  startTurn(entry, { turnId: 'third', question: 'Q3' });
  saveTurnDelivery(entry, { turnId: 'third', status: 'cancelled', text: '已经取消的内容' });
  startTurn(entry, { turnId: 'fourth', question: 'Q4' });
  assert.deepEqual(referencedJudgments(session, '相较首轮和第二轮，标出保留或撤回的判断', 'fourth'),
    [{ turn: 1, text: revision }, { turn: 2, text: '实际交付的现金流判断' }]);
  assert.deepEqual(referencedJudgments(session, '修订上轮的结论', 'fourth'), [{ turn: 3, text: null }]);
  assert.deepEqual(referencedJudgments(session, '第一轮引用了哪个单元格', 'fourth'), []);
});

await test("a legacy transcript hit carries only sources used by the final answer", async t => {
  const f = await fixture(t);
  f.user("核对两格。");
  f.tool("unused", citeA);
  f.tool("used", citeB);
  f.assistant(revision);
  f.lint([citeA, citeB]);
  const { query } = await f.restore();
  assert.deepEqual((await query("改稿"))[0].citations, [citeB]);
});

for (const fragment of ["", "取消前留下半句"]) {
  await test(`Pi legacy cancellation restores ${fragment ? "the fragment" : "an empty answer"}`, async t => {
    const f = await fixture(t);
    f.user("后来取消的问题");
    f.assistant(fragment, "aborted");
    const { answers, query } = await f.restore();
    assert.deepEqual(answers.map(a => [a.text, a.status]), [[fragment, "cancelled"]]);
    if (fragment) assert.deepEqual(await query(fragment), []);
  });
}

await test("mixed Pi history uses durable delivery for the new turn and keeps legacy tools", async t => {
  const f = await fixture(t);
  f.continuation();
  f.correction();
  const entry = { session: { sessionManager: f.manager } };
  startTurn(entry, { turnId: "new", question: "新问题", startedAt: new Date().toISOString() });
  f.user("新问题");
  f.assistant("未交付的模型输出。");
  saveTurnDelivery(entry, { version: 1, turnId: "new", status: "completed",
    text: "已交付正文 Model!A1。", citations: [citeA], finishedAt: new Date().toISOString() });
  const { answers, query } = await f.restore();
  assert.deepEqual(answers.map(a => [a.text, a.citations]), [
    [prefix + suffix, [citeA, citeB]], [revision, [citeB]], ["已交付正文 Model!A1。", [citeA]],
  ]);
  assert.equal(answers[1].tools[0].output, "旧工具原始输出");
  assert.deepEqual(answers[1].tools[0].citations, [citeA]);
  assert.deepEqual((await query("已交付正文", 3))[0]?.citations, [citeA]);
  assert.deepEqual(await query("未交付的模型输出"), []);
});
