import { opt, requireArg, requireOpt } from "../args.mjs";
import { loadLocalConfig, saveLocalConfig } from "../config.mjs";
import { emit, keyValues, table } from "./shared.mjs";

export const project = {
  summary: "项目列表、默认项目、创建与更新",
  children: {
    list: {
      summary: "列出项目",
      usage: "pe project list [--json]",
      options: [],
      async run({ client }) {
        const projects = await client.get("/api/projects", { scope: false });
        emit({}, projects, () => table(projects, [
          { key: "id", label: "ID", width: 14 },
          { key: "name", label: "名称" },
          { key: "note", label: "备注", max: 40 },
        ]));
      },
    },
    use: {
      summary: "把项目设为本地默认项目（写入 ~/.pe/config.json，不修改服务端）",
      usage: "pe project use <project-id> [--json]",
      options: [],
      async run({ client, args }) {
        const id = requireArg(args, 0, "project-id", "pe project use <project-id>");
        const projects = await client.get("/api/projects", { scope: false });
        const found = projects.find((item) => item.id === id);
        if (!found) throw new Error(`项目不存在：${id}`);
        const current = await loadLocalConfig();
        const file = await saveLocalConfig({ ...current, project: id });
        emit({}, { project: id, name: found.name, config: file }, (data) => keyValues([
          ["默认项目", `${data.project} (${data.name})`],
          ["配置文件", data.config],
        ]));
      },
    },
    create: {
      summary: "新建项目",
      usage: "pe project create --name <name> [--note <note>] [--json]",
      options: [
        { flags: "--name <name>", desc: "项目名称（必填，最多 40 字）" },
        { flags: "--note <note>", desc: "备注（最多 60 字）" },
      ],
      async run({ client, options }) {
        const name = requireOpt(options, "name", "pe project create --name <name>");
        const body = { name };
        const note = opt(options, "note");
        if (note !== undefined) body.note = note;
        const created = await client.post("/api/projects", body, { scope: false });
        emit({}, created, (data) => keyValues([
          ["已创建", data.id],
          ["名称", data.name],
          ["备注", data.note],
        ]));
      },
    },
    update: {
      summary: "更新项目名称、备注或主题色（API-only 管理动作）",
      usage: "pe project update <project-id> [--name <name>] [--note <note>] [--accent <color>] [--json]",
      options: [
        { flags: "--name <name>", desc: "新名称" },
        { flags: "--note <note>", desc: "新备注" },
        { flags: "--accent <color>", desc: "主题色" },
      ],
      async run({ client, options, args }) {
        const id = requireArg(args, 0, "project-id", "pe project update <project-id> [--name ...]");
        const body = {};
        for (const key of ["name", "note", "accent"]) {
          const value = opt(options, key);
          if (value !== undefined) body[key] = value;
        }
        if (!Object.keys(body).length) {
          throw new Error("至少提供 --name、--note、--accent 之一");
        }
        const updated = await client.patch(`/api/projects/${encodeURIComponent(id)}`, body, { scope: false });
        emit({}, updated, (data) => keyValues([
          ["项目", data.id],
          ["名称", data.name],
          ["备注", data.note],
          ["主题色", data.accent],
        ]));
      },
    },
  },
};
