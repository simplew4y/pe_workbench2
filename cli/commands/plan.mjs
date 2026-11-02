import { opt, requireArg } from "../args.mjs";
import { poll } from "../wait.mjs";
import { emit, keyValues, table } from "./shared.mjs";

async function listPlans(client) {
  return client.get("/api/plans");
}

async function findPlan(client, id) {
  const plans = await listPlans(client);
  const found = plans.find((plan) => plan.id === id);
  if (!found) throw new Error(`计划不存在：${id}`);
  return found;
}

async function setEnabled(client, id, enabled) {
  const plan = await findPlan(client, id);
  if (Boolean(plan.enabled) === enabled) {
    return { plan, changed: false };
  }
  const next = await client.post(`/api/plans/${encodeURIComponent(id)}/toggle`, {});
  return { plan: next, changed: true };
}

function renderPlan(plan, prefix = "") {
  return prefix + keyValues([
    ["计划", plan.id],
    ["名称", plan.name],
    ["启用", plan.enabled ? "yes" : "no"],
    ["运行中", plan.running ? "yes" : "no"],
    ["排期", plan.schedule],
    ["下次", plan.nextRun],
    ["最近", plan.lastRun ? `${plan.lastRun.at} · ${plan.lastRun.ok ? "成功" : "失败"}${plan.lastRun.version ? ` · v${plan.lastRun.version}` : ""}` : "—"],
  ]);
}

export const plan = {
  summary: "计划列表、启用/暂停、立即运行（当前无创建/编辑/删除 API）",
  children: {
    list: {
      summary: "列出计划与运行记录",
      usage: "pe plan list [--id <plan-id>] [--json]",
      options: [{ flags: "--id <plan-id>", desc: "只输出指定计划" }],
      async run({ client, options }) {
        let plans = await listPlans(client);
        const id = opt(options, "id");
        if (id) plans = plans.filter((item) => item.id === id);
        emit({}, plans, () => table(plans, [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "name", label: "名称", max: 30 },
          { label: "启用", width: 4, get: (item) => item.enabled ? "yes" : "no" },
          { label: "运行中", width: 6, get: (item) => item.running ? "yes" : "no" },
          { key: "schedule", label: "排期", max: 24 },
          { key: "nextRun", label: "下次", max: 20 },
        ]));
      },
    },
    show: {
      summary: "按 id 查看计划（由 list 结果过滤，服务端无单条 GET）",
      usage: "pe plan show <plan-id> [--json]",
      options: [],
      async run({ client, args }) {
        const plan = await findPlan(client, requireArg(args, 0, "plan-id", "pe plan show <plan-id>"));
        emit({}, plan, (item) => renderPlan(item));
      },
    },
    enable: {
      summary: "启用计划（幂等切换）",
      usage: "pe plan enable <plan-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "plan-id", "pe plan enable <plan-id>");
        const result = await setEnabled(client, id, true);
        emit({}, result, (data) => renderPlan(data.plan, data.changed ? "" : "（已是启用状态）\n"));
      },
    },
    disable: {
      summary: "暂停计划（幂等切换）",
      usage: "pe plan disable <plan-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "plan-id", "pe plan disable <plan-id>");
        const result = await setEnabled(client, id, false);
        emit({}, result, (data) => renderPlan(data.plan, data.changed ? "" : "（已是暂停状态）\n"));
      },
    },
    run: {
      summary: "立即运行计划",
      usage: "pe plan run <plan-id> [--wait[=seconds]] [--timeout <seconds>] [--json]",
      options: [
        { flags: "--wait[=seconds]", desc: "等待运行结束，默认 120 秒" },
        { flags: "--timeout <seconds>", desc: "覆盖等待超时" },
      ],
      async run({ client, args, wait }) {
        const id = requireArg(args, 0, "plan-id", "pe plan run <plan-id> [--wait]");
        const started = await client.post(`/api/plans/${encodeURIComponent(id)}/run`, {});
        if (!wait.enabled) {
          emit({}, started, (data) => keyValues([
            ["已启动", data.runId],
            ["会话", data.sessionId],
            ["计划", data.plan?.id],
          ]));
          return;
        }
        const final = await poll(async () => {
          const plans = await listPlans(client);
          return plans.find((item) => item.id === id) || null;
        }, {
          timeoutMs: wait.timeoutMs,
          label: "计划运行",
          done: (item) => item !== null && !item.running,
        });
        emit({}, { ...started, waited: true, plan: final }, (data) => keyValues([
          ["已启动", data.runId],
          ["会话", data.sessionId],
          ["状态", data.plan?.running ? "running" : "settled"],
          ["最近", data.plan?.lastRun?.at],
          ["结果", data.plan?.lastRun?.ok ? "成功" : "失败"],
        ]));
      },
    },
  },
};
