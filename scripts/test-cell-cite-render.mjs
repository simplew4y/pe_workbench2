import assert from "node:assert/strict";

import { linkCitations } from "../ui/chat/cell-citations.js";
import { snapshotMessages } from "../server/agent/snapshot.mjs";

const cite = (locator, overrides = {}) => ({
  id: `c:${locator}`,
  materialId: "mat-1",
  version: 3,
  locator,
  value: 100,
  display_unit: "百万元",
  role: "input",
  ...overrides,
});

const buttonCount = (html) => (html.match(/data-cell-cite/g) || []).length;
const unverifiedCount = (html) => (html.match(/cell-ref-unverified/g) || []).length;

/* U1: a verified locator becomes a button with material/version/locator. */
{
  const html = linkCitations("<p>收入见 Model!A1，成本见 Model!Z99。</p>", [cite("Model!A1")]);
  assert.equal(buttonCount(html), 1);
  assert.equal(unverifiedCount(html), 1);
  assert.match(html, /data-material-id="mat-1"/);
  assert.match(html, /data-version="3"/);
  assert.match(html, /data-locator="Model!A1"/);
  assert.match(html, />Model!A1<\/button>/);
  assert.match(html, /<span class="cell-ref-unverified"[^>]*>Model!Z99<\/span>/);
  assert.ok(!/<button[^>]*>Model!Z99/.test(html), "an unverified locator must not become clickable");
}

/* U1b: partial cell tokens are not locators. */
{
  const partial = linkCitations("<p>Model!A1B2 与 Model!A1:B2C3。</p>", [cite("Model!A1"), cite("Model!A1:B2")]);
  assert.equal(buttonCount(partial), 0);
}

/* U2: no citations means no clickable links and no invented chips. */
{
  const source = "<p>收入见 Model!A1。</p>";
  assert.equal(linkCitations(source, []), source);
  assert.equal(buttonCount(linkCitations(source, null)), 0);
}

/* U3: quoted sheets, absolute markers and ranges normalise to the citation. */
{
  const quoted = linkCitations("<p>见 'Discount PE'!H33。</p>", [cite("Discount PE!H33")]);
  assert.equal(buttonCount(quoted), 1);
  assert.match(quoted, /data-locator="Discount PE!H33"/);
  const absolute = linkCitations("<p>见 Model!$B$2。</p>", [cite("Model!B2")]);
  assert.equal(buttonCount(absolute), 1);
  const range = linkCitations("<p>区域 Model!B2:D4。</p>", [cite("Model!B2:D4")]);
  assert.equal(buttonCount(range), 1);
}

/* U4: only the cited half of a mixed answer is clickable; links are idempotent. */
{
  const citations = [cite("Model!A1"), cite("Model!C3")];
  const mixed = linkCitations("<p>Model!A1 有，Model!H99 无，Model!C3 有。</p>", citations);
  assert.equal(buttonCount(mixed), 2);
  assert.equal(unverifiedCount(mixed), 1);
  assert.match(mixed, /Model!H99<\/span>/);
  const twice = linkCitations(mixed, citations);
  assert.equal(buttonCount(twice), 2, "already-linked chips must not be re-linked");
  const insideLink = linkCitations('<a href="https://example.com">Model!A1</a>', citations);
  assert.equal(buttonCount(insideLink), 0);
}

/* U5: citation strings are escaped before entering attributes/text. */
{
  const hostile = linkCitations("<p>见 Model!A1。</p>", [
    cite("Model!A1", { materialId: '"><script>alert(1)</script>', role: "<b>x</b>" }),
  ]);
  assert.ok(!hostile.includes("<script>"));
  assert.match(hostile, /data-material-id="&quot;&gt;&lt;script&gt;/);
  assert.match(hostile, />Model!A1<\/button>/);
}

/* U6: a refreshed snapshot exposes citations from the durable side channel. */
{
  const session = {
    messages: [
      { role: "user", content: "问题" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "收入见 Model!A1。" },
          { type: "toolCall", id: "t1", name: "workbook_query", arguments: { path: "model.xlsx", query: "Model!A1" } },
        ],
      },
      { role: "toolResult", toolCallId: "t1", isError: false, content: [{ type: "text", text: "ok" }] },
    ],
  };
  const stored = [cite("Model!A1")];
  const ctx = {
    root: "/tmp/project",
    store: {
      listToolPresentations: () => [],
      listToolCitations: () => [{ toolCallId: "t1", citations: stored }],
    },
  };
  const message = snapshotMessages(session, ctx, { id: "thread-1" }).find((item) => item.role === "assistant");
  assert.ok(message);
  assert.deepEqual(message.tools[0].citations, stored);
  const rendered = linkCitations("<p>收入见 Model!A1。</p>", message.tools[0].citations);
  assert.equal(buttonCount(rendered), 1);
}
console.log("cell cite render U1-U6 passed");

/* U7: the durable bridge validates and stores citations even without a card. */
{
  const { attachSessionEvents } = await import("../server/agent/event-bridge.mjs");
  let listener = null;
  const saved = [];
  const broadcast = [];
  const entry = {
    id: "thread-bridge",
    session: { subscribe(fn) { listener = fn; return () => { listener = null; }; } },
    ctx: {
      root: "/tmp/project",
      store: {
        saveToolPresentation() { throw new Error("no presentation expected"); },
        saveToolCitations(record) { saved.push(record); },
      },
    },
    toolArgs: new Map(),
  };
  attachSessionEvents(entry, { bus: { broadcast: (_entry, event) => broadcast.push(event) } });
  entry.toolArgs.set("t-bridge", {});
  listener({ type: "tool_execution_start", toolCallId: "t-bridge", toolName: "workbook_trace", args: {} });
  listener({
    type: "tool_execution_end",
    toolCallId: "t-bridge",
    toolName: "workbook_trace",
    isError: false,
    result: { details: { citations: [cite("Model!A1"), { id: "bad", locator: "Model!B2" }] } },
  });
  assert.equal(saved.length, 1);
  assert.equal(saved[0].citations.length, 1);
  assert.equal(saved[0].citations[0].locator, "Model!A1");
  const completed = broadcast.find((event) => event.type === "tool.completed");
  assert.ok(completed);
  assert.equal(completed.citations.length, 1);
}
console.log("cell cite durable bridge U7 passed");
