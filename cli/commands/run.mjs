import { requireArg } from "../args.mjs";
import { emit, keyValues, requireYes } from "./shared.mjs";

export const run = {
  summary: "运行记录操作（撤销）",
  children: {
    undo: {
      summary: "撤销一次跟踪运行的文件变更（危险，需要 --yes）",
      usage: "pe run undo <run-id> --yes [--json]",
      options: [],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "run-id", "pe run undo <run-id> --yes");
        requireYes(options, `撤销运行 ${id}`);
        const data = await client.post(`/api/runs/${encodeURIComponent(id)}/undo`, {});
        emit({}, data, (result) => keyValues([
          ["已撤销", result.ok ? "yes" : "no"],
          ["恢复文件", (result.reverted || []).map((item) => `${item.objectId}→v${item.version}`).join(", ") || "无"],
          ["通知", result.notification?.id],
        ]));
      },
    },
  },
};
