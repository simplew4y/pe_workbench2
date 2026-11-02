import { integerOpt, opt, requireArg } from "../args.mjs";
import { emit, keyValues, requireYes, table } from "./shared.mjs";

export const approval = {
  summary: "审批列表、详情、批准与拒绝（高风险，写操作需要 --yes）",
  children: {
    list: {
      summary: "列出审批",
      usage: "pe approval list [--status <status>] [--tracking <id>] [--thread <id>] [--limit <n>] [--json]",
      options: [
        { flags: "--status <status>", desc: "pending / approved / rejected 等" },
        { flags: "--tracking <tracking-id>", desc: "按跟踪过滤" },
        { flags: "--thread <session-id>", desc: "按会话过滤" },
        { flags: "--limit <n>", desc: "条数，默认 100" },
      ],
      async run({ client, options }) {
        const data = await client.get("/api/approvals", {
          query: {
            status: opt(options, "status"),
            trackingId: opt(options, "tracking"),
            threadId: opt(options, "thread"),
            limit: integerOpt(options, "limit", { fallback: 100, min: 1, max: 500 }),
          },
        });
        emit({}, data, () => table(data, [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "status", label: "状态", width: 10 },
          { key: "kind", label: "类型", width: 16 },
          { key: "title", label: "标题", max: 38 },
          { key: "createdAt", label: "时间", max: 24 },
        ]));
      },
    },
    show: {
      summary: "查看单个审批详情",
      usage: "pe approval show <approval-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "approval-id", "pe approval show <approval-id>");
        const data = await client.get(`/api/approvals/${encodeURIComponent(id)}`);
        emit({}, data, (item) => keyValues([
          ["审批", item.id],
          ["状态", item.status],
          ["类型", item.kind],
          ["标题", item.title],
          ["跟踪", item.trackingId],
          ["会话", item.threadId],
          ["创建", item.createdAt],
        ]));
      },
    },
    approve: {
      summary: "批准模型写回（会真实写文件，需要 --yes）",
      usage: "pe approval approve <approval-id> --yes [--json]",
      options: [],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "approval-id", "pe approval approve <approval-id> --yes");
        requireYes(options, `批准写回 ${id}`);
        const data = await client.post(`/api/approvals/${encodeURIComponent(id)}/approve`, {});
        emit({}, data, (result) => keyValues([
          ["结果", result.ok ? "approved" : "failed"],
          ["审批", result.approval?.id || id],
          ["状态", result.approval?.status],
          ["已处理", result.already ? "已是终态" : "yes"],
          ["等待中", result.pending ? "yes" : "no"],
        ]));
      },
    },
    reject: {
      summary: "拒绝模型写回（需要 --reason 与 --yes）",
      usage: "pe approval reject <approval-id> --reason <text> --yes [--json]",
      options: [{ flags: "--reason <text>", desc: "拒绝原因（必填）" }],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "approval-id", "pe approval reject <approval-id> --reason <text> --yes");
        const reason = opt(options, "reason");
        if (!String(reason || "").trim()) throw new Error("拒绝必须提供 --reason <text>");
        requireYes(options, `拒绝写回 ${id}`);
        const data = await client.post(`/api/approvals/${encodeURIComponent(id)}/reject`, { reason });
        emit({}, data, (result) => keyValues([
          ["结果", result.ok ? "rejected" : "failed"],
          ["审批", result.approval?.id || id],
          ["状态", result.approval?.status],
          ["已处理", result.already ? "已是终态" : "yes"],
        ]));
      },
    },
  },
};
