import { integerOpt, opt, requireArg } from "../args.mjs";
import { emit, keyValues, table } from "./shared.mjs";

export const notification = {
  summary: "通知列表与标记已读",
  children: {
    list: {
      summary: "列出通知（默认最近 30 条）",
      usage: "pe notification list [--unread] [--tracking <id>] [--limit <n>] [--json]",
      options: [
        { flags: "--unread", desc: "只显示未读" },
        { flags: "--tracking <tracking-id>", desc: "按跟踪过滤" },
        { flags: "--limit <n>", desc: "条数，默认 30" },
      ],
      async run({ client, options }) {
        const data = await client.get("/api/notifications", {
          query: {
            limit: integerOpt(options, "limit", { fallback: 30, min: 1, max: 200 }),
            unread: options.unread ? 1 : undefined,
            tracking: opt(options, "tracking"),
          },
        });
        emit({}, data, () => table(data, [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "severity", label: "级别", width: 8 },
          { key: "title", label: "标题", max: 40 },
          { label: "已读", width: 4, get: (item) => item.readAt ? "yes" : "no" },
          { key: "createdAt", label: "时间", max: 24 },
        ]));
      },
    },
    read: {
      summary: "标记通知已读（幂等）",
      usage: "pe notification read <notification-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "notification-id", "pe notification read <notification-id>");
        const data = await client.post(`/api/notifications/${encodeURIComponent(id)}/read`, {});
        emit({}, data, (item) => keyValues([
          ["通知", item.id],
          ["标题", item.title],
          ["已读", item.readAt ? "yes" : "no"],
        ]));
      },
    },
  },
};
