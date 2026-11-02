import { opt, requireArg } from "../args.mjs";
import { emit, keyValues, requireYes, table } from "./shared.mjs";

const VERDICTS = new Set(["high", "fair", "low"]);

export const trace = {
  summary: "模型追踪时间线、人工判断与待定调整确认",
  children: {
    show: {
      summary: "查看当前追踪时间线与 pending judgment",
      usage: "pe trace show [--json]",
      options: [],
      async run({ client }) {
        const data = await client.get("/api/trace/current");
        emit({}, data, (result) => {
          const entries = result.entries || [];
          return table(entries, [
            { key: "id", label: "条目", width: 36, max: 36 },
            { key: "kind", label: "类型", width: 14 },
            { key: "summary", label: "摘要", max: 60 },
            { key: "at", label: "时间", max: 24 },
            { label: "判断", width: 6, get: (item) => item.judgment?.verdict || "" },
          ]) + (result.pendingJudgment
            ? `\n待确认判断：${result.pendingJudgment.id}（${result.pendingJudgment.verdict || "?"}）\n`
            : "");
        });
      },
    },
    judge: {
      summary: "记录一次人工判断（--adopt 会触发后续调整，需要 --yes）",
      usage: "pe trace judge <entry-id> --verdict high|fair|low [--note <text>] [--adopt] [--yes] [--json]",
      options: [
        { flags: "--verdict <high|fair|low>", desc: "判断结论（必填）" },
        { flags: "--note <text>", desc: "判断说明" },
        { flags: "--adopt", desc: "采纳提案并准备后续调整（危险）" },
      ],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "entry-id", "pe trace judge <entry-id> --verdict high|fair|low");
        const verdict = opt(options, "verdict");
        if (!VERDICTS.has(verdict)) throw new Error("--verdict 只接受 high / fair / low");
        const adopt = Boolean(options.adopt);
        if (adopt) requireYes(options, `采纳追踪条目 ${id} 的判断`);
        const data = await client.post(`/api/trace/entries/${encodeURIComponent(id)}/judge`, {
          verdict,
          note: opt(options, "note", ""),
          adopt,
        });
        emit({}, data, (result) => keyValues([
          ["判断", result.judgment?.id],
          ["结论", result.judgment?.verdict || verdict],
          ["采纳", adopt ? "yes" : "no"],
          ["待确认", result.pendingJudgment?.id || result.adoption?.judgmentId || ""],
        ]));
      },
    },
    confirm: {
      summary: "确认待定调整（adjust 会触发后续写入，需要 --yes）",
      usage: "pe trace confirm <judgment-id> --action adjust|cancel [--yes] [--json]",
      options: [{ flags: "--action <adjust|cancel>", desc: "确认动作（必填）" }],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "judgment-id", "pe trace confirm <judgment-id> --action adjust|cancel");
        const action = opt(options, "action");
        if (!["adjust", "cancel"].includes(action)) throw new Error("--action 只接受 adjust 或 cancel");
        if (action === "adjust") requireYes(options, "确认调整（会触发后续写入）");
        const data = await client.post(`/api/trace/judgments/${encodeURIComponent(id)}/confirm`, { action });
        emit({}, data, (result) => keyValues([
          ["判断", result.judgment?.id || id],
          ["动作", action],
          ["状态", result.judgment?.confirmation || result.confirmed || "ok"],
        ]));
      },
    },
  },
};
