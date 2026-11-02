import { integerOpt, opt, optList, requireArg, requireOpt } from "../args.mjs";
import { poll } from "../wait.mjs";
import {
  emit,
  keyValues,
  readJsonFile,
  requireYes,
  table,
} from "./shared.mjs";

const USAGE = "pe track <command>";

async function listTrackings(client) {
  return client.get("/api/trackings");
}

async function findTracking(client, id) {
  const tracking = await client.get(`/api/trackings/${encodeURIComponent(id)}`);
  if (!tracking) throw new Error(`跟踪不存在：${id}`);
  return tracking;
}

async function setEnabled(client, id, enabled) {
  const tracking = await findTracking(client, id);
  if (Boolean(tracking.enabled) === enabled) return { tracking, changed: false };
  const next = await client.post(`/api/trackings/${encodeURIComponent(id)}/toggle`, {});
  return { tracking: next, changed: true };
}

async function startRun(client, id) {
  return client.post(`/api/trackings/${encodeURIComponent(id)}/run`, {});
}

async function waitTracking(client, id, wait, label = "跟踪运行") {
  return poll(() => findTracking(client, id), {
    timeoutMs: wait.timeoutMs,
    label,
    done: (item) => !item.running,
  });
}

function renderTracking(tracking) {
  return keyValues([
    ["跟踪", tracking.id],
    ["目标", `${tracking.targetName || "?"} (${tracking.relPath || "?"})`],
    ["模板", tracking.template],
    ["启用", tracking.enabled ? "yes" : "no"],
    ["运行中", tracking.running ? "yes" : "no"],
    ["排期", tracking.scheduleLabel || tracking.scheduleShort],
    ["下次", tracking.nextRunLabel],
    ["模式", tracking.mode],
  ]);
}

const events = {
  summary: "查看来源事件与绑定",
  usage: "pe track events <tracking-id> [--json]",
  options: [],
  async run({ client, args }) {
    const id = requireArg(args, 0, "tracking-id", "pe track events <tracking-id>");
    const data = await client.get(`/api/trackings/${encodeURIComponent(id)}/events`);
    emit({}, data, (result) => table(result.events || [], [
      { key: "id", label: "ID", width: 36, max: 36 },
      { key: "title", label: "标题", max: 46 },
      { key: "sourceTier", label: "层级", width: 4 },
      { key: "triageStatus", label: "分诊", width: 10 },
      { key: "publishedAt", label: "时间", max: 24 },
    ]));
  },
  children: {
    add: {
      summary: "手动添加来源事件（无 UI，API-only）",
      usage: "pe track events add <tracking-id> --title <text> [--url <url>] [--snippet <text>] [--content <text>] [--tier <n>] [--json]",
      options: [
        { flags: "--title <text>", desc: "事件标题（必填）" },
        { flags: "--url <url>", desc: "来源链接" },
        { flags: "--snippet <text>", desc: "摘要" },
        { flags: "--content <text>", desc: "正文" },
        { flags: "--tier <n>", desc: "来源层级，默认 3" },
      ],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track events add <tracking-id> --title <text>");
        const title = requireOpt(options, "title", "pe track events add <tracking-id> --title <text>");
        const data = await client.post(`/api/trackings/${encodeURIComponent(id)}/events`, {
          title,
          url: opt(options, "url", ""),
          snippet: opt(options, "snippet", ""),
          content: opt(options, "content", ""),
          sourceTier: integerOpt(options, "tier", { fallback: 3, min: 1 }),
        });
        emit({}, data, (item) => keyValues([
          ["已添加", item.id],
          ["标题", item.title],
          ["分诊", item.triageStatus],
        ]));
      },
    },
    refresh: {
      summary: "刷新来源绑定（服务端同步轮询，耗时不定）",
      usage: "pe track events refresh <tracking-id> [--wait] [--json]",
      options: [{ flags: "--wait", desc: "兼容全局约定；该接口本身同步返回" }],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track events refresh <tracking-id>");
        const data = await client.post(`/api/trackings/${encodeURIComponent(id)}/events/refresh`, {});
        emit({}, data, (result) => table(result.results || [], [
          { key: "id", label: "绑定", width: 36, max: 36 },
          { label: "事件", width: 5, get: (item) => item.events?.length ?? "" },
          { key: "error", label: "错误", max: 50 },
        ]));
      },
    },
  },
};

const model = {
  summary: "模型写回状态、准备工作模型、保存绑定",
  children: {
    show: {
      summary: "查看模型写回状态",
      usage: "pe track model show <tracking-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track model show <tracking-id>");
        const data = await client.get(`/api/trackings/${encodeURIComponent(id)}/model`);
        emit({}, data, (item) => keyValues([
          ["状态文件", item.statePath],
          ["可用", item.available ? "yes" : "no"],
          ["工作文件", item.model?.working_file],
          ["写回", item.model?.write_enabled ? "enabled" : "disabled"],
          ["绑定数", (item.model?.bindings || []).length],
          ["输出数", (item.model?.outputs || []).length],
        ]));
      },
    },
    prepare: {
      summary: "准备工作模型（生成工作副本）",
      usage: "pe track model prepare <tracking-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track model prepare <tracking-id>");
        const data = await client.post(`/api/trackings/${encodeURIComponent(id)}/model/prepare`, {});
        emit({}, data, (item) => keyValues([
          ["工作文件", item.model?.working_file],
          ["资料", item.material?.id],
          ["路径", item.material?.relPath],
        ]));
      },
    },
    bind: {
      summary: "保存模型绑定（高风险写回配置，需要 --yes）",
      usage: "pe track model bind <tracking-id> --file <json> --yes [--json]",
      options: [{ flags: "--file <json>", desc: "包含 bindings / outputs / writeEnabled 的 JSON 文件" }],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track model bind <tracking-id> --file <json> --yes");
        const file = requireOpt(options, "file", "pe track model bind <tracking-id> --file <json> --yes");
        const parsed = await readJsonFile(file, "模型绑定 JSON");
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("模型绑定 JSON 必须是对象");
        }
        requireYes(options, `保存 ${id} 的模型绑定`);
        const data = await client.post(`/api/trackings/${encodeURIComponent(id)}/model/bindings`, {
          bindings: Array.isArray(parsed.bindings) ? parsed.bindings : [],
          outputs: Array.isArray(parsed.outputs) ? parsed.outputs : [],
          writeEnabled: parsed.writeEnabled === true || parsed.write_enabled === true,
        });
        emit({}, data, (item) => keyValues([
          ["绑定数", (item.model?.bindings || []).length],
          ["输出数", (item.model?.outputs || []).length],
          ["写回", item.model?.write_enabled ? "enabled" : "disabled"],
        ]));
      },
    },
  },
};

const monitor = {
  summary: "监测项列表、方案、同步、检查与更新",
  children: {
    list: {
      summary: "列出监测项",
      usage: "pe track monitor list <tracking-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track monitor list <tracking-id>");
        const data = await client.get(`/api/trackings/${encodeURIComponent(id)}/monitors`);
        emit({}, data, (result) => table(result.items || [], [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "title", label: "标题", max: 40 },
          { key: "frequency", label: "频率", max: 12 },
          { key: "status", label: "状态", width: 10 },
          { key: "nextCheckAt", label: "下次", max: 24 },
        ]));
      },
    },
    plan: {
      summary: "从 analysis-state 派生监测方案（不落库）",
      usage: "pe track monitor plan <tracking-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track monitor plan <tracking-id>");
        const data = await client.post(`/api/trackings/${encodeURIComponent(id)}/monitors/plan`, {});
        emit({}, data);
      },
    },
    sync: {
      summary: "同步/激活监测项；省略 --file 时从状态派生",
      usage: "pe track monitor sync <tracking-id> [--file <json>] [--json]",
      options: [{ flags: "--file <json>", desc: "items 数组或 { items: [...] }" }],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track monitor sync <tracking-id>");
        const file = opt(options, "file");
        let body = {};
        if (file) {
          const parsed = await readJsonFile(file, "监测方案 JSON");
          body = Array.isArray(parsed) ? { items: parsed } : parsed;
        }
        const data = await client.post(`/api/trackings/${encodeURIComponent(id)}/monitors/activate`, body);
        emit({}, data, (result) => table(result.items || [], [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "title", label: "标题", max: 40 },
          { key: "frequency", label: "频率", max: 12 },
        ]));
      },
    },
    check: {
      summary: "检查监测项（异步；--wait 等待跟踪运行结束）",
      usage: "pe track monitor check <tracking-id> [--item <id> ...] [--wait[=seconds]] [--timeout <seconds>] [--json]",
      options: [
        { flags: "--item <id>", desc: "只检查指定监测项，可重复" },
        { flags: "--wait[=seconds]", desc: "等待运行结束，默认 120 秒" },
        { flags: "--timeout <seconds>", desc: "覆盖等待超时" },
      ],
      async run({ client, options, args, wait }) {
        const id = requireArg(args, 0, "tracking-id", "pe track monitor check <tracking-id>");
        const itemIds = optList(options, "item");
        const started = await client.post(`/api/trackings/${encodeURIComponent(id)}/monitors/check`, { itemIds });
        if (!wait.enabled) {
          emit({}, started, (data) => keyValues([
            ["已启动", data.runId],
            ["会话", data.sessionId],
          ]));
          return;
        }
        const final = await waitTracking(client, id, wait, "监测检查");
        emit({}, { ...started, waited: true, tracking: final }, (data) => renderTracking(data.tracking));
      },
    },
    update: {
      summary: "更新监测项频率/状态等字段（API-only）",
      usage: "pe track monitor update <monitor-id> [--tracking <id>] [--frequency <f>] [--status <s>] [--next-check-at <iso>] [--file <json>] [--json]",
      options: [
        { flags: "--tracking <tracking-id>", desc: "所属跟踪 id（可选，用于消歧）" },
        { flags: "--frequency <f>", desc: "新频率" },
        { flags: "--status <s>", desc: "新状态" },
        { flags: "--next-check-at <iso>", desc: "下次检查时间" },
        { flags: "--file <json>", desc: "额外字段 JSON 对象" },
      ],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "monitor-id", "pe track monitor update <monitor-id> [--frequency ...]");
        const body = {};
        for (const key of ["frequency", "status"]) {
          const value = opt(options, key);
          if (value !== undefined) body[key] = value;
        }
        const nextCheckAt = opt(options, "next-check-at");
        if (nextCheckAt !== undefined) body.nextCheckAt = nextCheckAt;
        const file = opt(options, "file");
        if (file) Object.assign(body, await readJsonFile(file, "监测项 JSON"));
        if (!Object.keys(body).length) throw new Error("至少提供一个更新字段");
        const tracking = opt(options, "tracking");
        const data = await client.patch(`/api/monitors/${encodeURIComponent(id)}`, body, {
          query: tracking ? { tracking } : undefined,
        });
        emit({}, data);
      },
    },
  },
};

export const track = {
  summary: "跟踪任务、来源事件、模型写回与监测项",
  children: {
    list: {
      summary: "列出跟踪任务",
      usage: "pe track list [--json]",
      options: [],
      async run({ client }) {
        const trackings = await listTrackings(client);
        emit({}, trackings, () => table(trackings, [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "targetName", label: "目标", max: 30 },
          { key: "scheduleShort", label: "排期", max: 18 },
          { label: "启用", width: 4, get: (item) => item.enabled ? "yes" : "no" },
          { label: "运行中", width: 6, get: (item) => item.running ? "yes" : "no" },
          { key: "template", label: "模板", max: 16 },
        ]));
      },
    },
    show: {
      summary: "查看跟踪详情",
      usage: "pe track show <tracking-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track show <tracking-id>");
        const data = await findTracking(client, id);
        emit({}, data, (item) => renderTracking(item));
      },
    },
    create: {
      summary: "新建跟踪",
      usage: "pe track create --target <material-id> [--template <id>] [--freq daily|weekly|monthly] [--weekday <1-7>] [--day <1-28>] [--time HH:MM] [--run-now] [--json]",
      options: [
        { flags: "--target <material-id>", desc: "目标资料 id（必填）" },
        { flags: "--template <id>", desc: "跟踪模板" },
        { flags: "--freq <daily|weekly|monthly>", desc: "频率" },
        { flags: "--weekday <1-7>", desc: "每周几" },
        { flags: "--day <1-28>", desc: "每月几号" },
        { flags: "--time <HH:MM>", desc: "运行时间" },
        { flags: "--run-now", desc: "创建后立即运行" },
      ],
      async run({ client, options }) {
        const targetId = requireOpt(options, "target", "pe track create --target <material-id>");
        const body = { targetId };
        for (const key of ["template", "freq", "time"]) {
          const value = opt(options, key);
          if (value !== undefined) body[key === "template" ? "templateId" : key] = value;
        }
        const weekday = integerOpt(options, "weekday", { min: 1, max: 7 });
        const day = integerOpt(options, "day", { min: 1, max: 28 });
        if (weekday !== undefined) body.weekday = weekday;
        if (day !== undefined) body.day = day;
        const tracking = await client.post("/api/trackings", body);
        let run = null;
        if (options["run-now"]) {
          run = await startRun(client, tracking.id);
        }
        emit({}, { tracking, run }, (data) => renderTracking(data.tracking) + (data.run ? `\n已启动运行：${data.run.runId || ""}\n` : ""));
      },
    },
    enable: {
      summary: "启用跟踪（幂等切换）",
      usage: "pe track enable <tracking-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track enable <tracking-id>");
        const result = await setEnabled(client, id, true);
        emit({}, result, (data) => renderTracking(data.tracking));
      },
    },
    disable: {
      summary: "暂停跟踪（幂等切换）",
      usage: "pe track disable <tracking-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track disable <tracking-id>");
        const result = await setEnabled(client, id, false);
        emit({}, result, (data) => renderTracking(data.tracking));
      },
    },
    schedule: {
      summary: "调整跟踪排期",
      usage: "pe track schedule <tracking-id> --freq <daily|weekly|monthly> --time <HH:MM> [--weekday <1-7>] [--day <1-28>] [--json]",
      options: [
        { flags: "--freq <daily|weekly|monthly>", desc: "频率（必填）" },
        { flags: "--time <HH:MM>", desc: "运行时间（必填）" },
        { flags: "--weekday <1-7>", desc: "每周几" },
        { flags: "--day <1-28>", desc: "每月几号" },
      ],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track schedule <tracking-id> --freq ... --time ...");
        const body = {
          freq: requireOpt(options, "freq", "pe track schedule <tracking-id> --freq ... --time ..."),
          time: requireOpt(options, "time", "pe track schedule <tracking-id> --freq ... --time ..."),
        };
        const weekday = integerOpt(options, "weekday", { min: 1, max: 7 });
        const day = integerOpt(options, "day", { min: 1, max: 28 });
        if (weekday !== undefined) body.weekday = weekday;
        if (day !== undefined) body.day = day;
        const data = await client.patch(`/api/trackings/${encodeURIComponent(id)}/schedule`, body);
        emit({}, data, (item) => renderTracking(item));
      },
    },
    run: {
      summary: "立即运行跟踪",
      usage: "pe track run <tracking-id> [--wait[=seconds]] [--timeout <seconds>] [--json]",
      options: [
        { flags: "--wait[=seconds]", desc: "等待运行结束，默认 120 秒" },
        { flags: "--timeout <seconds>", desc: "覆盖等待超时" },
      ],
      async run({ client, args, wait }) {
        const id = requireArg(args, 0, "tracking-id", "pe track run <tracking-id> [--wait]");
        const started = await startRun(client, id);
        if (!wait.enabled) {
          emit({}, started, (data) => keyValues([
            ["已启动", data.runId],
            ["会话", data.sessionId],
            ["目标", data.tracking?.targetName],
          ]));
          return;
        }
        const final = await waitTracking(client, id, wait);
        emit({}, { ...started, waited: true, tracking: final }, (data) => renderTracking(data.tracking));
      },
    },
    delete: {
      summary: "删除跟踪（危险，需要 --yes；会级联清理事件/通知）",
      usage: "pe track delete <tracking-id> --yes [--json]",
      options: [],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "tracking-id", "pe track delete <tracking-id> --yes");
        requireYes(options, `删除跟踪 ${id}`);
        const data = await client.delete(`/api/trackings/${encodeURIComponent(id)}`);
        emit({}, { ...data, id }, (result) => keyValues([["已删除", result.id]]));
      },
    },
    events,
    model,
    monitor,
  },
};

export { USAGE };
