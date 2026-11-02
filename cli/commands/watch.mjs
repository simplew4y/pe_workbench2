import { integerOpt, opt, requireArg } from "../args.mjs";
import { poll } from "../wait.mjs";
import { emit, keyValues, requireYes, table } from "./shared.mjs";

async function getWatch(client, id) {
  return client.get(`/api/watch/${encodeURIComponent(id)}`);
}

function renderWatch(watch) {
  if (!watch) return "（尚无盯盘）\n";
  return keyValues([
    ["盯盘", watch.id],
    ["名称", watch.name],
    ["启用", watch.enabled ? "yes" : "no"],
    ["状态", watch.status],
    ["间隔", `${watch.intervalMinutes} 分钟`],
    ["深度复核", watch.deepCheckTime],
    ["下次巡检", watch.nextScanAt],
    ["未读发现", watch.counts?.unread ?? 0],
    ["上次检查", watch.lastCheck ? `${watch.lastCheck.status} · ${watch.lastCheck.finishedAt || watch.lastCheck.startedAt}` : "—"],
  ]);
}

const check = {
  summary: "立即检查（异步；--wait 等待检查结束）",
  usage: "pe watch check <watch-id> [--deep] [--wait[=seconds]] [--timeout <seconds>] [--json]",
  options: [
    { flags: "--deep", desc: "深度复核（消耗模型/搜索额度）" },
    { flags: "--wait[=seconds]", desc: "等待检查结束，默认 120 秒" },
    { flags: "--timeout <seconds>", desc: "覆盖等待超时" },
  ],
  async run({ client, options, args, wait }) {
    const id = requireArg(args, 0, "watch-id", "pe watch check <watch-id> [--deep] [--wait]");
    const initial = await getWatch(client, id);
    const beforeCheckId = initial.checks?.[0]?.id || null;
    const started = await client.post(`/api/watch/${encodeURIComponent(id)}/check`, {
      deep: Boolean(options.deep),
    });
    if (!wait.enabled) {
      emit({}, started, (data) => keyValues([
        ["已接受", data.accepted ? "yes" : "no"],
        ["触发", data.trigger],
      ]));
      return;
    }
    let sawNewCheck = false;
    const startedAt = Date.now();
    const final = await poll(() => getWatch(client, id), {
      timeoutMs: wait.timeoutMs,
      label: "盯盘检查",
      done: (view) => {
        const latest = view.checks?.[0];
        if (latest && latest.id !== beforeCheckId) {
          sawNewCheck = true;
          return latest.status !== "running";
        }
        if (!latest && view.watch?.status === "quiet" && Date.now() - startedAt > 1500) {
          return true;
        }
        return sawNewCheck && view.watch?.status !== "checking";
      },
    });
    emit({}, { ...started, waited: true, view: final }, (data) => {
      const latest = data.view.checks?.[0];
      return renderWatch(data.view.watch) + (latest
        ? keyValues([
            ["检查", latest.id],
            ["检查状态", latest.status],
            ["候选", latest.candidates],
            ["发现", latest.findingCount],
          ])
        : "");
    });
  },
};

export const watch = {
  summary: "盯盘总览、创建、更新、检查、问答、日志与重建",
  children: {
    status: {
      summary: "盯盘总览（无 watch 时显示识别结果）",
      usage: "pe watch status [--json]",
      options: [],
      async run({ client }) {
        const data = await client.get("/api/watch");
        emit({}, data, (overview) => {
          if (!overview.watch) {
            return keyValues([
              ["盯盘", "未开启"],
              ["识别", overview.detection?.found ? "找到目标" : "未找到"],
              ["说明", overview.detection?.error || overview.detection?.reportPath || ""],
            ]);
          }
          return renderWatch(overview.watch) + table(overview.checks || [], [
            { key: "id", label: "检查", width: 36, max: 36 },
            { key: "status", label: "状态", width: 10 },
            { key: "trigger", label: "触发", width: 8 },
            { key: "startedAt", label: "开始", max: 24 },
          ]);
        });
      },
    },
    start: {
      summary: "开始盯住（服务端自动识别报告/状态/模型）",
      usage: "pe watch start [--interval-minutes <n>] [--deep-check-time HH:MM] [--json]",
      options: [
        { flags: "--interval-minutes <n>", desc: "巡检间隔（5–240 分钟，运维参数）" },
        { flags: "--deep-check-time <HH:MM>", desc: "每日深度复核时间" },
      ],
      async run({ client, options }) {
        const body = {};
        const interval = integerOpt(options, "interval-minutes", { min: 5, max: 240 });
        if (interval !== undefined) body.intervalMinutes = interval;
        const deep = opt(options, "deep-check-time");
        if (deep !== undefined) body.deepCheckTime = deep;
        const data = await client.post("/api/watch", body);
        emit({}, data, (result) => (result.created ? "已创建盯盘\n" : "已存在盯盘，未重复创建\n") + renderWatch(result.watch));
      },
    },
    show: {
      summary: "查看单个盯盘",
      usage: "pe watch show <watch-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "watch-id", "pe watch show <watch-id>");
        const data = await getWatch(client, id);
        emit({}, data, (view) => renderWatch(view.watch));
      },
    },
    update: {
      summary: "启用/暂停或调整节奏（运维参数，会消耗搜索/模型额度）",
      usage: "pe watch update <watch-id> [--enable|--disable] [--interval-minutes <n>] [--deep-check-time HH:MM] [--json]",
      options: [
        { flags: "--enable", desc: "启用" },
        { flags: "--disable", desc: "暂停" },
        { flags: "--interval-minutes <n>", desc: "巡检间隔（5–240 分钟）" },
        { flags: "--deep-check-time <HH:MM>", desc: "每日深度复核时间" },
      ],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "watch-id", "pe watch update <watch-id> [--enable|--disable]");
        if (options.enable && options.disable) throw new Error("--enable 与 --disable 只能二选一");
        const body = {};
        if (options.enable) body.enabled = true;
        if (options.disable) body.enabled = false;
        const interval = integerOpt(options, "interval-minutes", { min: 5, max: 240 });
        if (interval !== undefined) body.intervalMinutes = interval;
        const deep = opt(options, "deep-check-time");
        if (deep !== undefined) body.deepCheckTime = deep;
        if (!Object.keys(body).length) throw new Error("至少提供一个更新字段");
        const data = await client.patch(`/api/watch/${encodeURIComponent(id)}`, body);
        emit({}, data, (result) => renderWatch(result.watch));
      },
    },
    delete: {
      summary: "删除盯盘（危险，需要 --yes；级联清理消息/检查/日志）",
      usage: "pe watch delete <watch-id> --yes [--json]",
      options: [],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "watch-id", "pe watch delete <watch-id> --yes");
        requireYes(options, `删除盯盘 ${id}`);
        const data = await client.delete(`/api/watch/${encodeURIComponent(id)}`);
        emit({}, { ...data, id }, (result) => keyValues([["已删除", result.removed ? result.id : `未找到 ${result.id}`]]));
      },
    },
    check,
    ask: {
      summary: "向盯盘助手提问（--wait 等待回答）",
      usage: "pe watch ask <watch-id> --text <text> [--wait[=seconds]] [--timeout <seconds>] [--json]",
      options: [
        { flags: "--text <text>", desc: "问题（必填）" },
        { flags: "--wait[=seconds]", desc: "等待回答，默认 120 秒" },
        { flags: "--timeout <seconds>", desc: "覆盖等待超时" },
      ],
      async run({ client, options, args, wait }) {
        const id = requireArg(args, 0, "watch-id", "pe watch ask <watch-id> --text <text>");
        const text = opt(options, "text");
        if (!String(text || "").trim()) throw new Error("缺少 --text <text>");
        const started = await client.post(`/api/watch/${encodeURIComponent(id)}/messages`, { text });
        if (!wait.enabled) {
          emit({}, started, (data) => keyValues([
            ["已提问", data.message?.id],
            ["排队", data.queued ? "yes" : "no"],
          ]));
          return;
        }
        const question = started.message;
        const final = await poll(() => getWatch(client, id), {
          timeoutMs: wait.timeoutMs,
          label: "盯盘回答",
          done: (view) => (view.messages || []).some((message) => (
            message.role === "assistant"
            && message.id !== question?.id
            && String(message.createdAt || "") >= String(question?.createdAt || "")
          )),
        });
        const messages = final.messages || [];
        const index = messages.findIndex((message) => message.id === question?.id);
        const reply = index >= 0
          ? messages.slice(index + 1).find((message) => message.role === "assistant")
          : [...messages].reverse().find((message) => message.role === "assistant");
        emit({}, { ...started, waited: true, reply }, (data) => (
          data.reply?.title ? `${data.reply.title}\n` : ""
        ) + `${data.reply?.body || "（未收到回答）"}\n`);
      },
    },
    logs: {
      summary: "查看检查日志",
      usage: "pe watch logs <watch-id> [--run <run-id>] [--limit <n>] [--json]",
      options: [
        { flags: "--run <run-id>", desc: "只看某次检查" },
        { flags: "--limit <n>", desc: "条数，默认 600" },
      ],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "watch-id", "pe watch logs <watch-id> [--run <run-id>]");
        const data = await client.get(`/api/watch/${encodeURIComponent(id)}/logs`, {
          query: {
            run: opt(options, "run"),
            limit: integerOpt(options, "limit", { fallback: 600, min: 1, max: 2000 }),
          },
        });
        emit({}, data, (result) => table(result.logs || [], [
          { key: "at", label: "时间", max: 24 },
          { key: "kind", label: "类型", width: 12 },
          { key: "runKind", label: "运行", width: 8 },
          { label: "内容", max: 80, get: (item) => JSON.stringify(item.payload || {}) },
        ]));
      },
    },
    read: {
      summary: "标记盯盘消息已读",
      usage: "pe watch read <watch-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "watch-id", "pe watch read <watch-id>");
        const data = await client.post(`/api/watch/${encodeURIComponent(id)}/read`, {});
        emit({}, data, (result) => keyValues([
          ["已读消息", result.changed],
          ["未读发现", result.watch?.counts?.unread ?? 0],
        ]));
      },
    },
    rebuild: {
      summary: "按最新报告/状态重建关注点",
      usage: "pe watch rebuild <watch-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "watch-id", "pe watch rebuild <watch-id>");
        const data = await client.post(`/api/watch/${encodeURIComponent(id)}/refresh`, {});
        emit({}, data, (result) => renderWatch(result.watch));
      },
    },
  },
};
