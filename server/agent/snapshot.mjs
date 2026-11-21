/**
 * Conversation snapshot: Pi session messages -> the compact DTO the browser
 * renders. Tool presentations are joined from the host's durable table, never
 * parsed out of Markdown or model text.
 */

import path from "node:path";
import {toolDisplayOutput} from "../../lib/tool-display-output.mjs";
import {applyPatch} from "diff";
import {turnTimeline} from "./turn-delivery.mjs";
import {adoptedCitations, explicitTurns, joinContinuation} from "./answer-delivery.mjs";
import { TRANSCRIPT_SEARCH_CONTEXT_CHARS } from "../../lib/transcript-search-tool.mjs";
import {readLedgerSync, pendingMerges} from "../../lib/ledger.mjs";
import {CONTEXT_BUDGET_FAILURE, isContextBudgetError} from "../../lib/context-budget.mjs";
import {presentUserAnswer} from "../../ui/chat/user-facing-answer.js";

export function textOfContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n\n");
}

export function shortPath(ctx, value) {
  if (typeof value !== "string") return "";
  const rel = path.relative(ctx.root, path.resolve(ctx.root, value));
  if (rel && !rel.startsWith("..")) return rel.split(path.sep).join("/");
  return value;
}

export function toolDetail(ctx, name, args = {}) {
  switch (name) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return shortPath(ctx, args.path || ".");
    case "grep":
      return args.pattern || "";
    case "find":
      return args.pattern || "";
    case "bash":
      return args.command || "";
    case "workbook_query":
      return `${shortPath(ctx, args.path || "")} · ${args.query || ""}`.trim();
    case "workbook_trace":
      return [
        shortPath(ctx, args.path || ""),
        args.cell || (args.sheet ? `${args.sheet}${args.rows ? ` 行 ${args.rows}` : ""}` : ""),
      ].filter(Boolean).join(" · ").slice(0, 160);
    case "validate_state":
      return shortPath(ctx, args.path || "");
    case "asr_read":
      return shortPath(ctx, args.path || "");
    case "westock_query":
      return Array.isArray(args.args) ? args.args.join(" ").slice(0, 120) : "";
    case "anysearch_search":
      return String(args.query || "").slice(0, 120);
    case "web_fetch":
      return String(args.url || "").slice(0, 200);
    default:
      return JSON.stringify(args || {}).slice(0, 80);
  }
}

export function resultText(result) {
  if (!result) return "";
  if (typeof result === "string") return result;
  if (Array.isArray(result.content)) return textOfContent(result.content);
  try {
    return JSON.stringify(result).slice(0, 2000);
  } catch {
    return "";
  }
}

export function hm(timestamp) {
  const d = timestamp ? new Date(timestamp) : new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function makeTitle(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (!clean) return "新会话";
  const first = clean.split(/[，。！？；,.!?;\n]/)[0].trim() || clean;
  return first.length > 28 ? `${first.slice(0, 28)}…` : first;
}

// Pi may compact its model context. History walks the active session branch
// (including custom lifecycle entries) instead of indexing session.messages.
function conversationTurns(session, {beforeTurnId, legacyBoundary} = {}) {
  const timeline = turnTimeline(session);
  const boundary = legacyBoundary != null && !timeline.some(item => item.kind === "start") ? legacyBoundary : Infinity;
  let rawIndex = 0;
  const turns = [];
  const managed = new Map();
  let current;
  for (const item of timeline) {
    if (item.kind === "start") {
      if (managed.has(item.turn.turnId)) continue;
      const turn = { start: item.turn, messages: [] };
      turns.push(turn);
      managed.set(item.turn.turnId, turn);
      if (!item.turn.queued) current = turn;
    } else if (item.kind === "active") {
      current = managed.get(item.turnId);
    } else if (item.kind === "delivery") {
      const turn = managed.get(item.record.turnId);
      if (turn && !turn.delivery) turn.delivery = item.record;
    } else if (item.kind === "lint") {
      if (current && !current.start) current.lint = item.data;
    } else if (item.kind === "message") {
      if (rawIndex++ >= boundary) break;
      const { message } = item;
      if (current && !current.start && ["pe_answer_continue", "pe_answer_correct"].includes(message.customType)) {
        (current.revisions ??= []).push({ index: current.messages.length, type: message.customType });
      }
      if (message.peInternal || message.customType || message.role === "custom") continue;
      if (message.role === "user") {
        if (!current?.start || current.user || current.delivery) {
          current = { messages: [] };
          turns.push(current);
        }
        current.user = message;
      } else if (message.role === "assistant" || message.role === "toolResult") {
        if (!current) {
          current = { messages: [] };
          turns.push(current);
        }
        current.messages.push(message);
      }
    }
  }
  const before = managed.get(beforeTurnId);
  return before ? turns.slice(0, turns.indexOf(before)) : turns;
}

function userMessage(turn) {
  if (!turn.user && !turn.start) return null;
  const text = String(turn.start?.question ?? textOfContent(turn.user?.content))
    .replace(/\n\n\[已上传资料\][\s\S]*$/, "");
  return {
    role: "user", text, timestamp: turn.start?.startedAt ?? turn.user?.timestamp,
    ...(turn.start ? { turnId: turn.start.turnId } : {}),
  };
}

export function titleFromMessages(session) {
  const first = conversationTurns(session).find(turn => turn.start || turn.user);
  return makeTitle(first && userMessage(first).text);
}

export function lastAssistantText(session) {
  const messages = session?.messages || [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const text = textOfContent(message.content).trim();
    if (text) return text;
  }
  return "";
}

// Sessions predating delivery records retain their last stopped answer and
// result cards. Their lint metadata, when present, includes citation identities
// that may have come from a prior verified fact rather than this turn's tools.
function legacySegment(messages, allowProcessFallback) {
  let answer = "";
  let final = [];
  const process = [];
  const errors = [];
  const lastAssistant = messages.findLast(message => message.role === "assistant");
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    const text = textOfContent(message.content);
    if (message === lastAssistant && message.stopReason === "aborted") {
      return { text, processText: process.join("\n\n").trim(), status: "cancelled" };
    }
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      if (text.trim()) process.push(text);
      if (message.stopReason === "error") errors.push(message.errorMessage || "");
      continue;
    }
    if (text.trim() && message.stopReason === "stop") answer = text;
    else if (text.trim()) final.push(text);
    if (Array.isArray(message.content) && message.content.some(block => block.type === "toolCall")) {
      process.push(...final);
      final = [];
    }
  }
  let text = answer || final.join("\n\n");
  let processText = process.join("\n\n").trim();
  if (!text.trim() && processText && allowProcessFallback && !errors.length) {
    const parts = processText.split("\n\n");
    text = parts.pop() || "";
    processText = parts.join("\n\n").trim();
  }
  if (!answer && !text && errors.length) {
    const budget = errors.some(isContextBudgetError);
    const detail = budget ? CONTEXT_BUDGET_FAILURE : "没有生成回答。";
    return { text: detail, processText, failure: { code: budget ? "context_budget" : "request_failed", detail } };
  }
  return { text, processText };
}

function legacyAnswer(turn, allowProcessFallback) {
  if (!turn.revisions?.length) {
    const answer = legacySegment(turn.messages, allowProcessFallback);
    return answer.status === "cancelled" ? answer : { ...answer, text: presentUserAnswer(answer.text) };
  }
  let text = "";
  const process = [];
  const phases = [{ index: 0 }, ...turn.revisions];
  let segment;
  for (const [i, phase] of phases.entries()) {
    segment = legacySegment(turn.messages.slice(phase.index, phases[i + 1]?.index));
    if (phase.type === "pe_answer_correct") {
      if (text) process.push(text);
      text = "";
    }
    if (segment.processText) process.push(segment.processText);
    if (!segment.failure && segment.text) text = joinContinuation(text, segment.text);
  }
  const processText = process.join("\n\n").trim();
  if (segment.status === "cancelled") return { text, processText, status: segment.status };
  if (!text && segment.failure) return { ...segment, processText };
  return { text: presentUserAnswer(text), processText };
}

function answerMessage(turn, { allowProcessFallback = true } = {}) {
  const { start, delivery } = turn;
  if (!start) return legacyAnswer(turn, allowProcessFallback);
  return {
    turnId: start.turnId,
    text: delivery?.text ?? "",
    citations: delivery?.citations ?? [],
    status: delivery?.status ?? "pending",
    ...(delivery?.reason ? { reason: delivery.reason } : {}),
    ...(delivery ? { finishedAt: delivery.finishedAt } : {}),
  };
}

// Only the answer actually shown on this branch can establish a prior position.
export function referencedJudgments(session, question, beforeTurnId) {
  if (!/保留|修订|修正|撤回|重写|更新.{0,8}(?:判断|命题|框架)/u.test(question)) return [];
  const requested = explicitTurns(question);
  const previous = /上一轮|上轮/u.test(question);
  if (!requested.size && !previous) return [];
  const turns = conversationTurns(session, { beforeTurnId }).filter(turn => turn.start || turn.user);
  if (previous && turns.length) requested.add(turns.length);
  const budget = Math.floor(TRANSCRIPT_SEARCH_CONTEXT_CHARS / (requested.size || 1));
  return [...requested].sort((a, b) => a - b).map(number => {
    const source = turns[number - 1];
    const answer = source && answerMessage(source, { allowProcessFallback: false });
    if (!answer?.text || answer.failure || ['failed', 'cancelled', 'pending'].includes(answer.status)) return { turn: number, text: null };
    return { turn: number, text: answer.text.slice(0, budget), ...(answer.text.length > budget ? { truncated: true } : {}) };
  });
}

function toolCitationIndex(ctx, threadId) {
  return new Map((threadId ? ctx?.store?.listToolCitations?.({ threadId }) || [] : [])
    .filter(record => Array.isArray(record.citations) && record.citations.length)
    .map(record => [record.toolCallId, record.citations]));
}

function legacyAnswerCitations(turn, text, tools, onlyAdopted = turn.revisions?.length) {
  const byId = new Map();
  for (const cite of [...(turn.lint?.citations || []), ...tools]) {
    if (!byId.has(cite.id)) byId.set(cite.id, cite);
  }
  const candidates = [...byId.values()];
  return onlyAdopted ? adoptedCitations(text, candidates) : candidates;
}

// Shape expected by transcript_search. Do not expose tool output or internal
// prompts through that tool, including when called during verification.
export function transcriptMessages(session, ctx, options = {}) {
  const out = [];
  let citationsByCall;
  for (const turn of conversationTurns(session, options)) {
    if (turn.start && !turn.delivery) continue;
    const user = userMessage(turn);
    if (user) out.push({ role: "user", content: user.text, timestamp: user.timestamp });
    const answer = answerMessage(turn, { allowProcessFallback: false });
    if (!answer.text || answer.failure || (!turn.start && answer.status === "cancelled")) continue;
    if (!turn.start) {
      citationsByCall ??= toolCitationIndex(ctx, session.sessionId);
      answer.citations = legacyAnswerCitations(turn, answer.text, turn.messages.flatMap(m =>
        m.role === "toolResult" && !m.isError ? citationsByCall.get(m.toolCallId) ?? m.details?.citations ?? [] : []), true);
    }
    out.push({
      role: "assistant", content: answer.text,
      timestamp: turn.delivery?.finishedAt ?? turn.messages.findLast(m => m.role === "assistant")?.timestamp,
      ...(answer.citations?.length ? { citations: answer.citations } : {}),
    });
  }
  return out;
}

export function frameworkStatePath(ctx, value) {
  if (typeof value !== "string") return "";
  // Pi accepts an @ prefix on file tool paths.
  const normalized = shortPath(ctx, value.replace(/^@/, ""));
  return /(?:^|\/)analysis-state\.json$/.test(normalized) ? normalized : "";
}

// Replay the file as it was in the turn. A read can seed edits, but only
// successful writes and edits attach a card to the answer.
function replayFrameworkTool(ctx, block, result, stateContents, current, capturedEdit) {
  if (!result || result.isError || !["read", "write", "edit"].includes(block.name)) return;
  const args = block.arguments || {};
  const statePath = frameworkStatePath(ctx, args.path);
  if (statePath) {
    if (block.name === "read") {
      // Successful full reads provide an immutable baseline in a new session.
      // Partial/truncated reads must not be mistaken for a complete state.
      const readContent = resultText(result);
      try {
        const parsed = JSON.parse(readContent);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) stateContents.set(statePath, readContent);
      } catch { /* no usable baseline */ }
    }
    let content = stateContents.get(statePath);
    if (block.name === "write" && typeof args.content === "string") content = args.content;
    else if (block.name === "edit" && capturedEdit !== undefined) content = capturedEdit.replace(/^\uFEFF/, "");
    else if (block.name === "edit" && typeof result.details?.patch === "string") {
      try {
        // Pi's patch encodes the actual edits, including fuzzy matches and
        // replacements that were all resolved against the original text.
        content = typeof content === "string" ? applyPatch(content, result.details.patch) : undefined;
      } catch { content = undefined; }
    } else if (block.name === "edit") {
      if (typeof content === "string") {
        const patches = Array.isArray(args.edits)
          ? args.edits
          : (typeof args.oldText === "string"
            ? [{ oldText: args.oldText, newText: args.newText ?? "" }]
            : null);
        if (patches?.length) {
          let next = content;
          let ok = true;
          for (const patch of patches) {
            if (!patch || typeof patch.oldText !== "string" || next.split(patch.oldText).length !== 2) {
              ok = false;
              break;
            }
            next = next.replace(patch.oldText, () => patch.newText ?? "");
          }
          content = ok ? next : undefined;
        } else content = undefined;
      } else content = undefined;
    }
    if (["write", "edit"].includes(block.name)) {
      stateContents.delete(statePath);
      delete current.analysisState;
      if (typeof content === "string") {
        stateContents.set(statePath, content);
        try {
          const parsed = JSON.parse(content);
          if (typeof parsed?.presentation?.verdict?.text === "string" && parsed.presentation.verdict.text.trim()) {
            current.analysisState = parsed;
            current.analysisStatePath = statePath;
          }
        } catch { /* malformed writes fall back to the assistant's text */ }
      }
    }
  }
}

function toolMessages(turn) {
  return {
    results: new Map(turn.messages.filter(m => m.role === "toolResult").map(m => [m.toolCallId, m])),
    calls: turn.messages.flatMap(m => m.role === "assistant" && Array.isArray(m.content)
      ? m.content.filter(block => block.type === "toolCall") : []),
  };
}

export function frameworkForTurn(session, ctx, turnId, frameworkEdits) {
  const stateContents = new Map();
  for (const turn of conversationTurns(session)) {
    const current = {};
    const { results, calls } = toolMessages(turn);
    const delivering = turn.start?.turnId === turnId;
    for (const call of calls) {
      const captured = delivering ? frameworkEdits?.get(call.id) : undefined;
      replayFrameworkTool(ctx, call, results.get(call.id), stateContents, current, captured);
    }
    if (delivering) return current.analysisState ? current : null;
  }
  return null;
}

export function snapshotMessages(session, ctx, entry = null) {
  const turns = conversationTurns(session);
  const presentations = new Map();
  const citationsByCall = entry ? toolCitationIndex(ctx, entry.id) : new Map();
  if (entry) {
    for (const record of ctx.store.listToolPresentations({ threadId: entry.id })) {
      presentations.set(record.toolCallId, record);
    }
  }
  const stateContents = new Map(); // reconstructed successful writes/edits, never current disk state
  const out = [];
  for (const turn of turns) {
    const user = userMessage(turn);
    if (user) {
      const {timestamp, ...message} = user;
      out.push({ ...message, time: hm(timestamp) });
    }
    const current = { tools: [] };
    const { results, calls } = toolMessages(turn);
    for (const block of calls) {
      const result = results.get(block.id);
      const record = presentations.get(block.id);
      const presentation = record && !record.corrupt && record.payload
        && record.schemaName !== "presentation.error"
        ? {
            schema: { name: record.schemaName, version: record.schemaVersion },
            payload: record.payload,
          }
        : null;
      const presentationError = record?.corrupt
        ? "工具结果展示数据损坏"
        : record?.schemaName === "presentation.error"
          ? String(record.payload?.error || "工具结果展示数据不可用")
          : "";
      replayFrameworkTool(ctx, block, result, stateContents, current);
      const citations = citationsByCall.get(block.id) ?? result?.details?.citations ?? [];
      current.tools.push({
        id: block.id,
        name: block.name,
        detail: toolDetail(ctx, block.name, block.arguments || {}),
        status: result ? (result.isError ? "error" : "done") : !turn.start ? "done" : turn.delivery ? "error" : "running",
        output: result ? toolDisplayOutput(block.name, result, resultText(result)) : "",
        ...(citations.length ? { citations } : {}),
        ...(presentation ? { presentation } : {}),
        ...(presentationError ? { presentationError } : {}),
      });
    }
    const answer = answerMessage(turn);
    // A captured edit may have no valid verdict. Only older records without
    // a saved decision about the card should fall back to tool replay.
    if (turn.delivery?.analysisState === null) {
      delete current.analysisState;
      delete current.analysisStatePath;
    }
    if (turn.start || answer.text || answer.status || answer.processText || current.tools.length || current.analysisState) {
      const firstAssistant = turn.messages.find(m => m.role === "assistant");
      const legacyCitations = turn.start ? [] : legacyAnswerCitations(turn, answer.text, current.tools.flatMap(tool => tool.citations || []));
      out.push({
        role: "assistant", ...current, ...answer,
        ...(turn.delivery?.analysisState ? {
          analysisState: turn.delivery.analysisState, analysisStatePath: turn.delivery.analysisStatePath,
          analysisStatePendingMerge: turn.delivery.analysisStatePendingMerge === true,
        } : {}),
        ...(turn.revisions?.length || legacyCitations.length ? { citations: legacyCitations } : {}),
        time: hm(turn.delivery?.finishedAt ?? firstAssistant?.timestamp ?? user?.timestamp),
        turnStartedAt: user?.timestamp ?? firstAssistant?.timestamp,
      });
    }
  }
  return out;
}

export function serializeSession(entry) {
  return {
    type: "snapshot",
    pendingMerges: entry.automated ? [] : pendingMerges(readLedgerSync(entry.ctx.root, entry.id)),
    sessionId: entry.id,
    title: entry.title,
    messages: snapshotMessages(entry.session, entry.ctx, entry),
    streaming: Boolean(entry.session.isStreaming || entry.postAnswerPending),
    activeTurnId: entry.activeTurn?.turnId ?? null,
    model: entry.modelId,
    projectId: entry.ctx.id,
    approvals: entry.ctx.store.listApprovalRequests({ threadId: entry.id, limit: 50 }),
  };
}
