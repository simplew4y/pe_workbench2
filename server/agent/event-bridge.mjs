/**
 * Pi session events -> browser SSE + durable tool presentations.
 *
 * The bridge is the only place that turns a tool result into a UI payload. It
 * persists the validated payload before broadcasting it, so a refresh sees the
 * same card even when Pi's JSONL never stored `details`.
 */

import path from "node:path";
import { toolDisplayOutput,toolValidation } from "../../lib/tool-display-output.mjs";

import { newRunId } from "../../lib/agent-protocol/ids.mjs";
import { extractPresentation } from "../../lib/contracts/index.mjs";
import { validCitations } from "../../lib/contracts/citation.mjs";
import { resultText, toolDetail } from "./snapshot.mjs";

export function attachSessionEvents(entry, { bus, onMaterialSaved = () => {}, onRunSettled = () => {}, onRunStarted = () => {} }) {
  function settle(aborted, record) {
    entry.updatedAt = record?.finishedAt || new Date().toISOString();
    entry.title = entry.session.sessionName || entry.title;
    const changedFiles = entry.traceChangedFiles || [];
    entry.traceChangedFiles = [];
    bus.broadcast(entry, {
      type: "session.updated", id: entry.id, title: entry.title,
      messageCount: entry.session.messages.length, updatedAt: entry.updatedAt,
    });
    void Promise.resolve(onRunSettled(entry, {
      changedFiles, aborted, text: record?.text, startedAt: entry.traceRunStartedAt,
      runId: entry.agui?.activeRunId || entry.localRunId || null,
    })).catch(() => {});
  }
  entry.onTurnDelivered = record => settle(record.status === "cancelled", record);
  entry.unsubscribe = entry.session.subscribe((event) => {
    const turnId = entry.activeTurn?.turnId;
    const publish = payload => bus.broadcast(entry, turnId ? { ...payload, turnId } : payload);
    switch (event.type) {
      case "agent_start":
        if (turnId && entry.localRunId === turnId) break;
        onRunStarted(entry);
        entry.localRunId = turnId || newRunId();
        entry.traceChangedFiles = [];
        entry.traceRunStartedAt = new Date().toISOString();
        if (!entry.managedChat) publish({ type: "run.started" });
        break;
      case "message_update":
        if (!entry.managedChat && event.assistantMessageEvent?.type === "text_delta") {
          publish({ type: "assistant.delta", delta: event.assistantMessageEvent.delta });
        }
        break;
      case "tool_execution_start": {
        entry.toolArgs.set(event.toolCallId, event.args || {});
        publish({
          type: "tool.started",
          id: event.toolCallId,
          name: event.toolName,
          detail: toolDetail(entry.ctx, event.toolName, event.args || {}),
        });
        break;
      }
      case "tool_execution_update":
        publish({
          type: "tool.updated",
          id: event.toolCallId,
          output: resultText(event.partialResult).slice(0, 800),
        });
        break;
      case "tool_execution_end": {
        const failed = Boolean(event.isError || event.result?.isError);
        const args = entry.toolArgs.get(event.toolCallId) || {};
        entry.toolArgs.delete(event.toolCallId);
        const extracted = extractPresentation(event.result);
        let presentation = null;
        let presentationError = "";
        if (extracted.ok) {
          try {
            entry.ctx.store.saveToolPresentation({
              toolCallId: event.toolCallId,
              threadId: entry.id,
              runId: entry.agui?.activeRunId || entry.localRunId || "",
              toolName: event.toolName,
              schemaName: extracted.schemaName,
              schemaVersion: extracted.schemaVersion,
              payload: extracted.payload,
            });
            presentation = {
              schema: { name: extracted.schemaName, version: extracted.schemaVersion },
              payload: extracted.payload,
            };
          } catch (error) {
            presentationError = `工具结果持久化失败：${error.message}`;
          }
        } else if (!extracted.absent) {
          presentationError = extracted.error || "工具结果展示数据不可用";
          // Persist the failure too: after a refresh the card must still show
          // an error placeholder rather than silently degrading to a plain row.
          try {
            entry.ctx.store.saveToolPresentation({
              toolCallId: event.toolCallId,
              threadId: entry.id,
              runId: entry.agui?.activeRunId || entry.localRunId || "",
              toolName: event.toolName,
              schemaName: "presentation.error",
              schemaVersion: 0,
              payload: { error: presentationError },
            });
          } catch {
            /* live error placeholder still works */
          }
        }
        // Citations are separate from the rich presentation: trace/calc tools
        // have no card schema but their cell references must survive refresh.
        const rawCitations = event.result?.details?.citations;
        const citations = Array.isArray(rawCitations) ? validCitations(rawCitations) : [];
        if (Array.isArray(rawCitations)) {
          try {
            entry.ctx.store.saveToolCitations?.({
              toolCallId: event.toolCallId,
              threadId: entry.id,
              citations,
            });
          } catch {
            /* live message still renders; a refresh will fall back to plain text */
          }
        }
        publish({
          type: "tool.completed",
          id: event.toolCallId,
          name: event.toolName,
          status: failed ? "error" : "done",
          detail: toolDetail(entry.ctx, event.toolName, args),
          output: toolDisplayOutput(event.toolName, event.result, resultText(event.result)),
          ...(toolValidation(event.toolName,event.result)?{validation:toolValidation(event.toolName,event.result)}:{}),
          ...(citations.length ? { citations } : {}),
          ...(presentation ? { presentation } : {}),
          ...(presentationError ? { presentationError } : {}),
        });
        if (!failed) onMaterialSaved(entry, event.toolName, args);
        if (!failed && ["write", "edit"].includes(event.toolName) && typeof args.path === "string") {
          const root = path.resolve(entry.ctx.root);
          const absolute = path.resolve(root, args.path);
          if (absolute.startsWith(root + path.sep)) {
            const rel = path.relative(root, absolute).split(path.sep).join("/");
            if (
              rel
              && !rel.startsWith(".tracking/")
              && !rel.includes("/backups/")
              && Array.isArray(entry.traceChangedFiles)
              && !entry.traceChangedFiles.includes(rel)
            ) {
              entry.traceChangedFiles.push(rel);
            }
          }
        }
        break;
      }
      case "agent_settled": {
        if (!entry.managedChat) {
          publish({ type: "run.settled", aborted: event.aborted });
          settle(event.aborted);
        }
        break;
      }
    }
  });
  return () => {
    try {
      entry.unsubscribe?.();
    } catch {
      /* ignored */
    }
  };
}
