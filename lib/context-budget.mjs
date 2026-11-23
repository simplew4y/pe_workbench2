// The agent stream receives Pi's normalized transcript, including system prompt
// sections and tool declarations. Only the request copy may be shortened.
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

export const CONTEXT_BUDGET_FAILURE = "上下文超限，没有生成回答。";
export const TOOL_RESULT_CONTEXT_CHARS = 12_000;
const OMITTED = "context_evidence_omitted";
const evidenceFields = [
  "id", "fact_id", "fact_version", "source_id", "materialId", "version", "sha256", "filename",
  "path", "url", "locator", "ref", "sheet", "coord", "page", "turn", "role", "kind", "type",
  "metric", "rowLabel", "columnLabel", "name", "company", "entity", "period", "scope",
  "basis_type", "scenario", "value", "raw_value", "canonical_value", "unit", "raw_unit",
  "display_unit", "canonical_unit", "currency", "expected", "status", "formula", "expression",
  "derivedFrom", "evidence_ids", "inputs",
];
const evidenceLists = ["citations", "cells", "results", "matches", "ledgerMatches", "evidence", "facts", "hits"];
const summaryFields = [
  "miss", "missReason", "coverage", "ledgerCoverage", "ledgerSummary", "totalMatches",
  "ledgerTotalMatches", "matchedCells", "returned", "hits", "mode", "pages", "truncated",
  "code", "status", "error", "retry", "retryAfter", "retryAfterMs", "retryable", "retry_after",
];

export function isContextBudgetError(errorMessage) {
  const text = String(errorMessage || "");
  return text.includes(CONTEXT_BUDGET_FAILURE) ||
    /maximum context length|reduce the length of the messages|exceeds the context window/i.test(text);
}

function messageText({ content }) {
  return typeof content === "string" ? content :
    (content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
}

// A conservative estimate, not the provider's tokenizer. UTF-8 bytes account
// for Chinese text; 2.5 chars/token was observed with large ASCII ledger JSON.
// Pi estimates an image at 1,200 tokens. details/usage never reach the model.
function inputCost(message) {
  const { role, content, sections, toolsAdded, toolsRemoved, toolCallId, toolName, isError } = message;
  let imageTokens = 0;
  const visible = Array.isArray(content) ? content.map(block => {
    if (block.type !== "image") return block;
    imageTokens += 1200;
    return { type: "image" };
  }) : content;
  return imageTokens + Math.ceil(Buffer.byteLength(JSON.stringify({
    role, content: visible, sections, toolsAdded, toolsRemoved, toolCallId, toolName, isError,
  })) / 2.5);
}

export function assessContextBudget(messages, model, maxTokens = model?.maxTokens) {
  const contextWindow = Number(model?.contextWindow) || 0;
  const reservedOutput = Number(maxTokens) || 0;
  const inputTokens = messages.reduce((sum, message) => sum + inputCost(message), 0);
  const requested = inputTokens + reservedOutput;
  return { ok: !contextWindow || requested <= contextWindow, requested, inputTokens, reservedOutput, contextWindow };
}

function wordTerms(question) {
  return [...new Set([...new Intl.Segmenter("zh", { granularity: "word" }).segment(question.toLowerCase())]
    .filter(part => part.isWordLike && part.segment.length > 1).map(part => part.segment))];
}

function relevance(text, terms) {
  const lower = text.toLowerCase();
  return terms.reduce((score, term) => score + Number(lower.includes(term)), 0);
}

// Include both sides of a long plain-text result and windows around query terms.
// An incomplete excerpt is always labelled as such by the result envelope.
function excerpts(text, terms) {
  if (!text) return [];
  if (text.length <= 640) return [text];
  const lower = text.toLowerCase();
  const locations = new Set();
  for (const term of terms) {
    for (const i of [lower.indexOf(term), lower.lastIndexOf(term)]) if (i >= 0) locations.add(i);
  }
  // Numeric evidence or a cell address can occur in the middle of a long
  // unstructured line. Keep its surrounding units and source, even for a follow-up
  // question that only says “continue”. Limit matches independently of body size.
  const numeric = /[\p{L}\w.]{1,60}![A-Z]{1,3}\d+|[+-]?\d[\d,.]*\s*(?:%|亿元|万元|元|USD|RMB)?/giu;
  const tail = [];
  let count = 0;
  for (const match of text.matchAll(numeric)) {
    if (count++ < 4) locations.add(match.index);
    tail[count % 4] = match.index;
  }
  for (const i of tail) if (i != null) locations.add(i);
  const snippets = [...locations].map(i => text.slice(Math.max(0, i - 120), i + 320));
  return [...new Set([...snippets, text.slice(0, 320), text.slice(-320)])];
}

function select(source, keys) {
  return Object.fromEntries(keys.filter(k => source[k] != null).map(k => [k, source[k]]));
}

// A coverage field may enumerate every scanned turn or sheet. Keep the
// counts and endpoints while explicitly marking any unlisted members.
function boundedStatus(value) {
  if (typeof value === "string" && value.length > 320) return value.slice(0, 220) + "…" + value.slice(-80);
  if (Array.isArray(value)) {
    if (JSON.stringify(value).length <= 640) return value;
    return { count: value.length, first: boundedStatus(value[0]), last: boundedStatus(value.at(-1)), omitted: true };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, boundedStatus(v)]));
  }
  return value;
}

function parseBody(text) {
  if (!/^\s*[[{]/.test(text)) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// Comparing tool names alone could mark a different failed lookup as resolved.
function callKey(name, args, turn) {
  return JSON.stringify([turn, name, args], (_key, value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  });
}

function withText(message, text) {
  const { details, ...copy } = message;
  return { ...copy, content: [{ type: "text", text }] };
}

function isQuestion(message) {
  return message.role === "user" && !message.peInternal && !message.customType &&
    !/^\s*<turn_context>|界面把最后一次工具调用之后的文字当作回答|上一条回答在句中截断/.test(messageText(message));
}

function collectResults(messages) {
  const latest = messages.findLastIndex(isQuestion);
  const terms = latest >= 0 ? wordTerms(messageText(messages[latest])) : [];
  const calls = new Map();
  const results = [];
  let turn = -1;
  messages.forEach((message, index) => {
    if (isQuestion(message)) turn = index;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "toolCall") calls.set(block.id, block);
    }
    if (message.role !== "toolResult") return;
    const call = calls.get(message.toolCallId);
    const key = call ? callKey(call.name, call.arguments, turn) : index;
    results.push({ message, index, key, current: turn === latest, rows: [] });
  });
  const success = new Map();
  const errors = new Map();
  for (const item of results.toReversed()) {
    const { message, key } = item;
    const text = messageText(message);
    const parsed = parseBody(text);
    const data = { ...(!Array.isArray(parsed) && parsed), ...message.details };
    const summary = select(data, summaryFields);
    if (Array.isArray(summary.hits)) summary.hits = summary.hits.length;
    if (message.isError) {
      const errorKey = JSON.stringify([key, boundedStatus(summary), summary.error || summary.code ? null : text.slice(0, 640)]);
      const repeated = errors.get(errorKey);
      if (success.has(key) || repeated) {
        item.base = success.has(key) ? `此前失败；相同调用随后成功 ${success.get(key)}` : `重复失败，见 ${repeated}`;
        item.duplicate = true;
        continue;
      }
      errors.set(errorKey, message.toolCallId);
      if (!summary.error && !summary.code) summary.error = text.slice(0, 640);
    } else {
      success.set(key, message.toolCallId);
    }
    const summaryText = JSON.stringify(boundedStatus(summary));
    item.base = `${OMITTED} #${message.toolCallId}` + (summaryText === "{}" ? "" : "\n" + summaryText);
    const rows = Array.isArray(parsed) ? [...parsed] : [];
    for (const k of evidenceLists) if (Array.isArray(data[k])) for (const row of data[k]) rows.push(row);
    if (data.value != null || data.fact_id) rows.push(data);
    if (data.result && typeof data.result === "object") rows.push(data.result);
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const identity = select(row, evidenceFields);
      const passage = row.excerpt || row.text;
      if (typeof passage === "string" && passage) {
        const [snippet] = excerpts(passage, terms);
        if (snippet) identity.excerpt = snippet;
      }
      if (!Object.keys(identity).length) continue;
      const line = JSON.stringify(identity);
      const locator = select(identity, ["id", "fact_id", "fact_version", "materialId", "version", "path", "filename",
        "locator", "ref", "sheet", "coord", "page", "turn", "url", "value", "period", "display_unit", "unit", "derivedFrom"]);
      item.rows.push({ line, locator: Object.keys(locator).length ? JSON.stringify(locator) : null, id: row.id, depends: Array.isArray(row.derivedFrom) ? row.derivedFrom : [],
        score: 8 + relevance(line, terms) * 2 });
    }
    if (!parsed && !message.isError) {
      for (const line of excerpts(text, terms)) item.rows.push({ line, score: relevance(line, terms) * 2 });
    }
  }
  return results;
}

export function fitContextMessages(messages, model, limit = TOOL_RESULT_CONTEXT_CHARS, maxTokens = model?.maxTokens) {
  if (assessContextBudget(messages, model, maxTokens).ok) return messages;
  // Keep newly returned page bodies intact for the next model call. Older reads can be
  // shortened once the agent has had a turn to inspect them. The caller rejects an
  // oversized protected batch before dispatch rather than silently certifying an excerpt.
  const lastRequest = messages.findLastIndex(m => m.role === "assistant" || isQuestion(m));
  const pageCalls = new Set((Array.isArray(messages[lastRequest]?.content) ? messages[lastRequest].content : [])
    .filter(c => c.type === "toolCall" && c.name === "pdf_read" &&
      (c.arguments?.mode === "pages" || (!c.arguments?.query && c.arguments?.page && ["auto", undefined].includes(c.arguments?.mode))))
    .map(c => c.id));
  const items = collectResults(messages).filter(item => !(item.index > lastRequest &&
    !item.message.isError && (pageCalls.has(item.message.toolCallId) || item.message.details?.fullPageBatch)));
  const latest = messages.findLastIndex(isQuestion);
  const history = [];
  const fitted = messages.map((message, i) => {
    if (i >= latest || message.role !== "assistant") return message;
    const shorten = text => text.length <= 400 ? text :
      text.slice(0, 100) + "\n[较早的回答已节选；完整正文见该轮会话记录]\n" + text.slice(-100);
    if (!Array.isArray(message.content)) return { ...message, content: shorten(message.content || "") };
    // Signed reasoning/text and all call arguments must round-trip intact.
    const content = message.content.map(b => b.type === "text" && !b.textSignature && b.text.length > 400 ?
      { ...b, text: shorten(b.text) } : b);
    if (content.every((b, j) => b === message.content[j])) return message;
    history.push(i);
    return { ...message, content };
  });
  const depends = new Set();
  const candidates = [];
  for (const item of items) {
    fitted[item.index] = withText(item.message, item.base);
    item.text = item.base;
    item.cost = inputCost(fitted[item.index]);
    for (const row of item.rows) {
      if (item.current) for (const id of row.depends || []) depends.add(id);
      candidates.push({ item, row });
    }
  }
  let remaining = model.contextWindow - assessContextBudget(fitted, model, maxTokens).requested;
  if (remaining < 0) return fitted; // Fixed transcript and protected error/coverage statuses alone exceed the window.

  const priority = ({ item, row }) => (depends.has(row.id) ? 100 : 0) +
    (item.current ? 40 : 0) + (item.current && row.depends?.length ? 50 : 0) + row.score;
  candidates.sort((a, b) => priority(b) - priority(a) || b.item.index - a.item.index);
  const owners = new Map();
  function replace(item, message) {
    const cost = inputCost(message);
    if (cost - item.cost > remaining) return false;
    remaining -= cost - item.cost;
    item.cost = cost;
    fitted[item.index] = message;
    return true;
  }
  for (const { item, row } of candidates) {
    // Plain text from different tools or arguments can have different provenance.
    const key = row.id ? row.line : JSON.stringify([item.key, row.line]);
    if (owners.has(key)) {
      const owner = owners.get(key);
      if (owner !== item) {
        item.duplicate = true;
        const note = `\n重复证据见 ${owner.message.toolCallId}`;
        if (!item.text.includes(note) && replace(item, withText(item.message, item.text + note))) item.text += note;
      }
      continue;
    }
    for (const line of new Set([row.line, row.locator].filter(Boolean))) {
      const next = item.text + "\n" + line;
      if (next.length > limit || !replace(item, withText(item.message, next))) continue;
      item.text = next;
      owners.set(key, item);
      break;
    }
  }
  // Spend leftover capacity on intact bodies, newest first. Preserve recorded
  // duplicate/retry links. A body may only replace a summary if all evidence we
  // promoted from Pi's structured side channel is actually visible in that body.
  for (const item of items.toReversed()) {
    if (item.duplicate) continue;
    const raw = messageText(item.message);
    if (raw.length > limit || item.rows.some(row => row.id || row.depends?.length || row.score >= 8)) continue;
    if (item.base.includes("\n") && !raw.includes(item.base.split("\n").slice(1).join("\n"))) continue;
    replace(item, item.message);
  }
  for (const i of history.toReversed()) {
    const extra = inputCost(messages[i]) - inputCost(fitted[i]);
    if (extra <= remaining) {
      fitted[i] = messages[i];
      remaining -= extra;
    }
  }
  return fitted;
}

export function contextBudgetFailureStream(model) {
  const stream = createAssistantMessageEventStream();
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  stream.push({ type: "error", reason: "error", error: {
    role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: { ...zero, totalTokens: 0, cost: zero }, stopReason: "error",
    errorMessage: CONTEXT_BUDGET_FAILURE, timestamp: Date.now(),
  } });
  return stream;
}
