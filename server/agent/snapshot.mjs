/**
 * Conversation snapshot: Pi session messages -> the compact DTO the browser
 * renders. Tool presentations are joined from the host's durable table, never
 * parsed out of Markdown or model text.
 */

import path from "node:path";
import {readLedgerSync, pendingMerges} from "../../lib/ledger.mjs";

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

export function titleFromMessages(session) {
  const firstUser = session.messages.find((message) => message.role === "user");
  return makeTitle(firstUser ? textOfContent(firstUser.content) : "");
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

export function snapshotMessages(session, ctx, entry = null) {
  const results = new Map();
  for (const message of session.messages) {
    if (message.peInternal || /^pe_(?:turn_context|answer_)/.test(message.customType || "")) continue;
    if (message.role === "toolResult") results.set(message.toolCallId, message);
  }
  const presentations = new Map();
  if (entry) {
    for (const record of ctx.store.listToolPresentations({ threadId: entry.id })) {
      presentations.set(record.toolCallId, record);
    }
  }

  const stateContents = new Map(); // reconstructed successful writes/edits, never current disk state
  const out = [];
  let current = null;
  let turnStartedAt;
  const flush = () => {
    if (!current) return;
    const segments = current.segments || [];
    let lastTool = -1;
    segments.forEach((segment, index) => {
      if (segment.type === "tool") lastTool = index;
    });

    const processParts = [];
    const finalParts = [];
    segments.forEach((segment, index) => {
      if (segment.type !== "text") return;
      if (index > lastTool) finalParts.push(segment.text);
      else processParts.push(segment.text);
    });

    let text = finalParts.join("\n\n").trim();
    let processText = processParts.join("\n\n").trim();
    if (!text && processText) {
      // If the model ended on a tool call, keep its last paragraph as the answer.
      const parts = processText.split("\n\n");
      text = parts.pop() || "";
      processText = parts.join("\n\n").trim();
    }

    if (text || processText || current.tools.length) {
      out.push({
        role: "assistant",
        text,
        processText,
        tools: current.tools,
        ...(current.analysisState ? { analysisState: current.analysisState, analysisStatePath: current.analysisStatePath } : {}),
        time: current.time,
        turnStartedAt: current.turnStartedAt,
      });
    }
    current = null;
  };

  for (const message of session.messages) {
    if (message.peInternal || /^pe_(?:turn_context|answer_)/.test(message.customType || "")) continue;
    if (message.role === "user") {
      flush();
      turnStartedAt = message.timestamp;
      const userText = textOfContent(message.content).replace(/\n\n\[已上传资料\][\s\S]*$/, "");
      out.push({ role: "user", text: userText, time: hm(message.timestamp) });
      continue;
    }
    if (message.role !== "assistant") continue;

    if (!current) current = { role: "assistant", segments: [], tools: [], time: hm(message.timestamp), turnStartedAt: turnStartedAt ?? message.timestamp };
    const text = textOfContent(message.content);
    if (text) current.segments.push({ type: "text", text });

    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
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
      const args = block.arguments || {};
      const statePath = shortPath(ctx, args.path || "");
      if (result && !result.isError && /(?:^|\/)analysis-state\.json$/.test(statePath)) {
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
        else if (block.name === "edit") {
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
              if (parsed?.presentation) { current.analysisState = parsed; current.analysisStatePath = statePath; }
            } catch { /* malformed writes fall back to the assistant's text */ }
          }
        }
      }
      current.segments.push({ type: "tool" });
      current.tools.push({
        id: block.id,
        name: block.name,
        detail: toolDetail(ctx, block.name, block.arguments || {}),
        status: result ? (result.isError ? "error" : "done") : "done",
        output: result ? resultText(result).slice(0, 4000) : "",
        ...(presentation ? { presentation } : {}),
        ...(presentationError ? { presentationError } : {}),
      });
    }
  }
  flush();
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
    ...(entry.answerLint ? { lint: entry.answerLint } : {}),
    model: entry.modelId,
    projectId: entry.ctx.id,
    approvals: entry.ctx.store.listApprovalRequests({ threadId: entry.id, limit: 50 }),
  };
}
