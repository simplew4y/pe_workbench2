import { cancelActiveTurn } from "../agent/turn-delivery.mjs";
import { runWithPostAnswer } from "../agent/post-answer.mjs";
import { defaultThinkingLevel, modelThinkingLevels, persistEmptySessionSettings, sessionModelSettings } from "../agent/session-model-settings.mjs";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export async function handleSessions({ req, res, url, app, ctx }) {
  const { json, readJson } = app.http;
  const { sessions, bus, broadcast, nowIso, config, makeTitle } = app;
  const pathname = url.pathname;
  if (pathname === "/api/sessions" && req.method === "GET") {
    return json(res, 200, await sessions.listSessions(ctx));
  }

  if (pathname === "/api/sessions" && req.method === "POST") {
    const entry = await sessions.createEntry({ id: crypto.randomUUID(), ctx });
    return json(res, 201, { id: entry.id, title: entry.title, messageCount: 0, updatedAt: entry.updatedAt, ...sessionModelSettings(entry) });
  }

  if (pathname === "/api/events" && req.method === "GET") {
    bus.openGlobal(req, res, ctx);
    return;
  }

  const match = pathname.match(/^\/api\/sessions\/([^/]+)\/(state|events|messages|abort|model)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const entry = await sessions.ensureEntry(id, ctx);
    if (!entry) return json(res, 404, { error: "session not found" });

    if (action === "state" && req.method === "GET") {
      return json(res, 200, entry.snapshot());
    }

    if (action === "events" && req.method === "GET") {
      bus.openSession(req, res, entry);
      return;
    }

    if (action === "messages" && req.method === "POST") {
      const body = await readJson(req);
      if (entry.modelSettingsPending) return json(res, 409, { error: "会话设置正在保存，请稍后发送" });
      // A legacy prompt must not be injected into an active AG-UI run: it would
      // be queued as a followUp and its events would leak into that run.
      if (entry.agui?.isRunning) {
        return json(res, 409, {
          error: "an AG-UI run is active on this session",
          code: "ag_ui_run_active",
          threadId: entry.id,
        });
      }
      const text = String(body.text || "").trim();
      const attachments = Array.isArray(body.attachments) ? body.attachments : [];
      if (!text && !attachments.length) return json(res, 400, { error: "empty message" });

      const safeAttachments = attachments
        .filter((item) => typeof item === "string")
        .map((item) => path.relative(ctx.root, path.resolve(ctx.root, item)))
        .filter((item) => item && !item.startsWith(".."));

      if (entry.title === "新会话" || !entry.title) {
        const title = makeTitle(text);
        entry.title = title;
        entry.session.setSessionName(title);
      }

      entry.updatedAt = nowIso();
      const streaming = Boolean(entry.session.isStreaming || entry.postAnswerPending);
      const run = runWithPostAnswer(entry, text || "看一下这几个文件。", { attachments: safeAttachments }, event => broadcast(entry, event));
      run.catch((error) => {
        broadcast(entry, { type: "run.error", message: error?.message || String(error) });
      });

      broadcast(entry, {
        type: "session.updated",
        id: entry.id,
        title: entry.title,
        messageCount: entry.session.messages.length,
        updatedAt: entry.updatedAt,
      });

      return json(res, 202, { accepted: true, queued: streaming, sessionId: entry.id, title: entry.title });
    }

    if (action === "abort" && req.method === "POST") {
      // Cancellation also applies while Pi is idle between verification attempts.
      if (entry.agui?.isRunning) await entry.agui.abort();
      else await cancelActiveTurn(entry);
      return json(res, 200, { ok: true });
    }

    if (action === "model" && req.method === "POST") {
      const body = await readJson(req);
      if (!body || typeof body !== "object" || (body.model === undefined && body.thinkingLevel === undefined))
        return json(res, 400, { error: "请指定模型或推理档位" });
      if (entry.session.isStreaming || entry.postAnswerPending || entry.agui?.isRunning || entry.modelSettingsPending)
        return json(res, 409, { error: "会话正在运行或保存设置，请稍后切换模型或推理档位" });
      const requested = body.model === undefined ? entry.modelId : body.model;
      const next = typeof requested === "string" ? config.resolveModel(requested) : null;
      if (!next) return json(res, 400, { error: "不支持的模型" });
      const levels = modelThinkingLevels(next);
      const previous = entry.session.thinkingLevel;
      const level = body.thinkingLevel === undefined ? (levels.includes(previous) ? previous : defaultThinkingLevel(next)) : body.thinkingLevel;
      if (!levels.includes(level)) return json(res, 400, { error: "此模型不支持该推理档位" });
      entry.modelSettingsPending = true;
      try {
        if (requested !== entry.modelId) await entry.session.setModel(next);
        entry.session.setThinkingLevel(level);
        entry.modelId = requested;
        persistEmptySessionSettings(entry.session);
        const settings = sessionModelSettings(entry);
        broadcast(entry, { type: "session.updated", id: entry.id, title: entry.title, messageCount: entry.session.messages.length, updatedAt: entry.updatedAt, ...settings });
        return json(res, 200, { ok: true, ...settings });
      } finally {
        entry.modelSettingsPending = false;
      }
    }
  }

  return json(res, 404, { error: "not found" });
}
