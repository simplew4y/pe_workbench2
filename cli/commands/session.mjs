import { opt, optList, requireArg, requireOpt } from "../args.mjs";
import { poll } from "../wait.mjs";
import { emit, keyValues, table, uploadFiles } from "./shared.mjs";

async function state(client, id) {
  return client.get(`/api/sessions/${encodeURIComponent(id)}/state`);
}

export const session = {
  summary: "会话列表、创建、读取、发送、停止与模型切换",
  children: {
    list: {
      summary: "列出当前项目的会话",
      usage: "pe session list [--json]",
      options: [],
      async run({ client }) {
        const sessions = await client.get("/api/sessions");
        emit({}, sessions, () => table(sessions, [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "title", label: "标题", max: 36 },
          { key: "messageCount", label: "消息", width: 5 },
          { key: "updatedAt", label: "更新时间", max: 24 },
        ]));
      },
    },
    new: {
      summary: "新建会话",
      usage: "pe session new [--json]",
      options: [],
      async run({ client }) {
        const created = await client.post("/api/sessions", {});
        emit({}, created, (data) => keyValues([
          ["会话", data.id],
          ["标题", data.title],
        ]));
      },
    },
    show: {
      summary: "读取会话快照（消息、模型、流式状态、审批）",
      usage: "pe session show <session-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "session-id", "pe session show <session-id>");
        const snapshot = await state(client, id);
        emit({}, snapshot, (data) => {
          const head = keyValues([
            ["会话", data.sessionId],
            ["标题", data.title],
            ["模型", data.model],
            ["流式", data.streaming ? "yes" : "no"],
          ]);
          return head + table(data.messages || [], [
            { key: "role", label: "角色", width: 9 },
            { key: "text", label: "内容", max: 100 },
          ]);
        });
      },
    },
    send: {
      summary: "发送消息；--file 会先上传并作为附件（旧版 messages 传输）",
      usage: "pe session send <session-id> --text <text> [--file <path> ...] [--wait[=seconds]] [--timeout <seconds>] [--json]",
      options: [
        { flags: "--text <text>", desc: "消息文本（与 --file 至少提供一个）" },
        { flags: "--file <path>", desc: "本地文件，可重复；先上传再作为项目内附件" },
        { flags: "--wait[=seconds]", desc: "等待本轮流式结束，默认 120 秒" },
        { flags: "--timeout <seconds>", desc: "覆盖等待超时" },
      ],
      async run({ client, options, args, wait }) {
        const id = requireArg(args, 0, "session-id", "pe session send <session-id> --text <text>");
        const text = opt(options, "text", "");
        const files = optList(options, "file");
        if (!String(text).trim() && !files.length) {
          throw new Error("--text 与 --file 至少提供一个");
        }
        const before = wait.enabled ? await state(client, id) : null;
        const uploaded = files.length ? await uploadFiles(client, files) : [];
        const attachments = uploaded.map((item) => item.path).filter(Boolean);
        const accepted = await client.post(`/api/sessions/${encodeURIComponent(id)}/messages`, {
          text: String(text || ""),
          attachments,
        });
        if (!wait.enabled) {
          emit({}, accepted, (data) => keyValues([
            ["已接受", data.accepted ? "yes" : "no"],
            ["会话", data.sessionId],
            ["标题", data.title],
            ["排队", data.queued ? "yes" : "no"],
          ]));
          return;
        }
        const baseline = before?.messages?.length ?? 0;
        const final = await poll(() => state(client, id), {
          timeoutMs: wait.timeoutMs,
          label: "会话回复",
          done: (data) => !data.streaming && (data.messages?.length ?? 0) > baseline,
        });
        emit({}, { ...accepted, waited: true, state: final }, (data) => {
          const messages = data.state?.messages || [];
          const last = [...messages].reverse().find((message) => message.role === "assistant");
          return keyValues([
            ["已接受", data.accepted ? "yes" : "no"],
            ["会话", data.state?.sessionId || data.sessionId],
            ["流式", data.state?.streaming ? "yes" : "no"],
          ]) + (last ? `\n${last.text || ""}\n` : "");
        });
      },
    },
    stop: {
      summary: "停止当前生成",
      usage: "pe session stop <session-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "session-id", "pe session stop <session-id>");
        const result = await client.post(`/api/sessions/${encodeURIComponent(id)}/abort`, {});
        emit({}, result, (data) => keyValues([["已停止", data.ok ? "yes" : "no"]]));
      },
    },
    model: {
      summary: "切换会话模型（默认 deepseek-flash，可选 deepseek-v4-pro）",
      usage: "pe session model <session-id> --model <deepseek-flash|deepseek-v4-pro> [--json]",
      options: [{ flags: "--model <model>", desc: "目标模型（默认 deepseek-flash）" }],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "session-id", "pe session model <session-id> --model <model>");
        const model = requireOpt(options, "model", "pe session model <session-id> --model <model>");
        if (!["deepseek-flash", "deepseek-v4-pro"].includes(model)) {
          throw new Error("--model 只接受 deepseek-flash 或 deepseek-v4-pro");
        }
        const result = await client.post(`/api/sessions/${encodeURIComponent(id)}/model`, { model });
        emit({}, result, (data) => keyValues([["模型", data.model]]));
      },
    },
  },
};
