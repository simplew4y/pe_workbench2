import { integerOpt, opt, requireOpt } from "../args.mjs";
import { emit } from "./shared.mjs";

export const dashboard = {
  summary: "读取投资 Dashboard JSON",
  children: {
    get: {
      summary: "读取最新或指定运行/版本的 Dashboard",
      usage: "pe dashboard get --tracking <tracking-id> [--run <run-id>] [--material-version <v>] [--json]",
      options: [
        { flags: "--tracking <tracking-id>", desc: "跟踪 id（必填）" },
        { flags: "--run <run-id>", desc: "指定一次运行" },
        { flags: "--material-version <v>", desc: "指定资料版本" },
      ],
      async run({ client, options }) {
        const trackingId = requireOpt(options, "tracking", "pe dashboard get --tracking <tracking-id>");
        const runId = opt(options, "run");
        const version = integerOpt(options, "material-version", { min: 1 });
        const pathname = runId
          ? `/api/trackings/${encodeURIComponent(trackingId)}/runs/${encodeURIComponent(runId)}/dashboard`
          : `/api/trackings/${encodeURIComponent(trackingId)}/dashboard`;
        const data = await client.get(pathname, { query: { materialVersion: version } });
        emit({}, data);
      },
    },
  },
};
