import fs from "node:fs/promises";
import path from "node:path";

import { integerOpt, opt, requireArg, requireOpt } from "../args.mjs";
import { poll } from "../wait.mjs";
import {
  emit,
  keyValues,
  requireYes,
  resolveMaterialVersion,
  table,
  uploadFiles,
} from "./shared.mjs";

function materialId(args, usage) {
  return requireArg(args, 0, "material-id", usage);
}

async function getMaterial(client, id) {
  return client.get(`/api/materials/${encodeURIComponent(id)}`);
}

function asrPath(id, version) {
  return version
    ? `/api/materials/${encodeURIComponent(id)}/versions/${version}/asr`
    : `/api/materials/${encodeURIComponent(id)}/asr`;
}

export const material = {
  summary: "资料列表、上传、下载、版本、工作簿、PDF、ASR",
  children: {
    list: {
      summary: "列出资料",
      usage: "pe material list [--json]",
      options: [],
      async run({ client }) {
        const materials = await client.get("/api/materials");
        emit({}, materials, () => table(materials, [
          { key: "id", label: "ID", width: 36, max: 36 },
          { key: "name", label: "名称", max: 34 },
          { key: "kind", label: "类型", width: 7 },
          { key: "updatedAt", label: "更新时间", max: 24 },
          { label: "版本", width: 5, get: (item) => item.versions?.[0]?.v ?? "" },
          { key: "relPath", label: "路径", max: 40 },
        ]));
      },
    },
    show: {
      summary: "读取单个资料详情",
      usage: "pe material show <material-id> [--json]",
      options: [],
      async run({ client, args }) {
        const data = await getMaterial(client, materialId(args, "pe material show <material-id>"));
        emit({}, data, (item) => keyValues([
          ["ID", item.id],
          ["名称", item.name],
          ["路径", item.relPath],
          ["类型", item.kind],
          ["来源", item.source],
          ["状态", item.status],
          ["版本", (item.versions || []).map((version) => `v${version.v}${version.note ? `(${version.note})` : ""}`).join(", ")],
          ["更新时间", item.updatedAt],
        ]));
      },
    },
    upload: {
      summary: "上传一个或多个本地文件（原始字节流，非 multipart）",
      usage: "pe material upload <path>... [--json]",
      options: [],
      async run({ client, args }) {
        if (!args.length) throw new Error("用法：pe material upload <path>...");
        const uploaded = await uploadFiles(client, args);
        emit({}, uploaded, () => uploaded.map((item) => (
          `${item.material?.id || "-"}  ${item.path}  ${item.size} bytes\n`
        )).join(""));
      },
    },
    file: {
      summary: "读取项目内任意文件（对应 /api/file，供文本/附件预览）",
      usage: "pe material file <project-relative-path> [--output <path|->] [--download] [--json]",
      options: [
        { flags: "--output <path>", desc: "输出文件；- 表示写到 stdout，默认当前目录原文件名" },
        { flags: "--download", desc: "请求 download=1 附件响应头" },
      ],
      async run({ client, options, args }) {
        const relPath = requireArg(args, 0, "path", "pe material file <project-relative-path>");
        const output = opt(options, "output") || path.basename(relPath);
        const result = await client.download("/api/file", {
          query: { path: relPath, download: options.download ? "1" : undefined },
          output,
        });
        if (output === "-") return;
        emit({}, { path: relPath, ...result }, (data) => keyValues([
          ["已写入", data.output],
          ["字节", data.bytes],
        ]));
      },
    },
    download: {
      summary: "下载资料某个版本（默认最新）",
      usage: "pe material download <material-id> [--version <n>] [--output <path|->] [--json]",
      options: [
        { flags: "--version <n>", desc: "版本号，默认最新版本" },
        { flags: "--output <path>", desc: "输出文件；- 表示写到 stdout，默认当前目录原文件名" },
      ],
      async run({ client, options, args }) {
        const id = materialId(args, "pe material download <material-id>");
        const materialData = await getMaterial(client, id);
        const version = await resolveMaterialVersion(client, id, integerOpt(options, "version", { min: 1 }));
        const output = opt(options, "output") || path.basename(materialData.name || materialData.relPath || `${id}.bin`);
        const result = await client.download(
          `/api/materials/${encodeURIComponent(id)}/versions/${version}/file`,
          { query: { download: "1" }, output },
        );
        if (output === "-") return;
        emit({}, { materialId: id, version, ...result }, (data) => keyValues([
          ["已下载", data.output],
          ["版本", `v${data.version}`],
          ["字节", data.bytes],
        ]));
      },
    },
    restore: {
      summary: "把历史版本恢复为新版本（危险，需要 --yes）",
      usage: "pe material restore <material-id> --version <n> --yes [--json]",
      options: [{ flags: "--version <n>", desc: "要恢复的版本号" }],
      async run({ client, options, args }) {
        const id = materialId(args, "pe material restore <material-id> --version <n> --yes");
        const version = integerOpt(options, "version", { min: 1 });
        if (!version) throw new Error("缺少 --version <n>");
        requireYes(options, `恢复 ${id} 到 v${version}`);
        const data = await client.post(`/api/materials/${encodeURIComponent(id)}/versions/${version}/restore`, {});
        emit({}, data, (item) => keyValues([
          ["已恢复", item.id],
          ["来源版本", `v${version}`],
          ["新版本", `v${item.versions?.[0]?.v ?? "?"}`],
        ]));
      },
    },
    delete: {
      summary: "删除资料（软删除，危险，需要 --yes）",
      usage: "pe material delete <material-id> --yes [--json]",
      options: [],
      async run({ client, options, args }) {
        const id = materialId(args, "pe material delete <material-id> --yes");
        requireYes(options, `删除资料 ${id}`);
        const data = await client.delete(`/api/materials/${encodeURIComponent(id)}`);
        emit({}, { ...data, id }, (result) => keyValues([["已删除", result.id]]));
      },
    },
    query: {
      summary: "查询工作簿子图（workbook_query 的 HTTP 对应面）",
      usage: "pe material query <material-id> --query <text> [--max-cells <n>] [--json]",
      options: [
        { flags: "--query <text>", desc: "查询语句" },
        { flags: "--max-cells <n>", desc: "最多返回单元格数" },
      ],
      async run({ client, options, args }) {
        const id = materialId(args, "pe material query <material-id> --query <text>");
        const query = requireOpt(options, "query", "pe material query <material-id> --query <text>");
        const maxCells = integerOpt(options, "max-cells", { min: 1 });
        const data = await client.post(`/api/materials/${encodeURIComponent(id)}/query`, { query, maxCells });
        emit({}, data);
      },
    },
    workbook: {
      summary: "读取工作簿摘要或某版本单表结构",
      usage: "pe material workbook <material-id> [--version <n>] [--sheet <name>] [--json]",
      options: [
        { flags: "--version <n>", desc: "版本号；带 --sheet 时用于定位版本" },
        { flags: "--sheet <name>", desc: "工作表名，输出该表结构" },
      ],
      async run({ client, options, args }) {
        const id = materialId(args, "pe material workbook <material-id> [--version <n>] [--sheet <name>]");
        const explicitVersion = integerOpt(options, "version", { min: 1 });
        const sheet = opt(options, "sheet");
        let data;
        if (explicitVersion === undefined && sheet === undefined) {
          data = await client.get(`/api/materials/${encodeURIComponent(id)}/workbook`);
        } else {
          const version = await resolveMaterialVersion(client, id, explicitVersion);
          const suffix = sheet === undefined ? "" : `/sheets/${encodeURIComponent(sheet)}`;
          data = await client.get(`/api/materials/${encodeURIComponent(id)}/versions/${version}/workbook${suffix}`);
        }
        emit({}, data);
      },
    },
    pdf: {
      summary: "读取 PDF 摘要、指定页或检索正文",
      usage: "pe material pdf <material-id> [--version <n>] [--page <range> | --query <text>] [--max-chars <n>] [--json]",
      options: [
        { flags: "--version <n>", desc: "版本号，默认最新" },
        { flags: "--page <range>", desc: "页码或范围，例如 2-4" },
        { flags: "--query <text>", desc: "正文检索关键词" },
        { flags: "--max-chars <n>", desc: "单次读取最大字符数" },
      ],
      async run({ client, options, args }) {
        const id = materialId(args, "pe material pdf <material-id> [--page <range>|--query <text>]");
        const page = opt(options, "page");
        const query = opt(options, "query");
        if (page !== undefined && query !== undefined) throw new Error("--page 与 --query 只能二选一");
        const explicitVersion = integerOpt(options, "version", { min: 1 });
        let data;
        if (explicitVersion === undefined && page === undefined && query === undefined) {
          data = await client.get(`/api/materials/${encodeURIComponent(id)}/pdf`);
        } else {
          const version = await resolveMaterialVersion(client, id, explicitVersion);
          data = await client.get(`/api/materials/${encodeURIComponent(id)}/versions/${version}/pdf`, {
            query: {
              page,
              query,
              maxChars: integerOpt(options, "max-chars", { min: 1000, max: 40000 }),
            },
          });
        }
        emit({}, data);
      },
    },
    asr: {
      summary: "查看/启动音频转写，或下载 TXT/SRT",
      usage: "pe material asr <material-id> [--version <n>] [--start] [--force] [--format txt|srt] [--output <path>] [--wait[=seconds]] [--json]",
      options: [
        { flags: "--version <n>", desc: "版本号，默认资料级状态" },
        { flags: "--start", desc: "开始或重试转写" },
        { flags: "--force", desc: "强制重新转写（配合 --start）" },
        { flags: "--format <txt|srt>", desc: "下载转写文本而不是状态" },
        { flags: "--output <path>", desc: "配合 --format 写入文件；默认 stdout" },
        { flags: "--wait[=seconds]", desc: "等待转写完成，默认 120 秒" },
        { flags: "--timeout <seconds>", desc: "覆盖等待超时" },
      ],
      async run({ client, options, args, wait }) {
        const id = materialId(args, "pe material asr <material-id> [--start|--format txt]");
        const version = integerOpt(options, "version", { min: 1 });
        const format = opt(options, "format");
        if (format !== undefined && !["txt", "srt"].includes(format)) {
          throw new Error("--format 只接受 txt 或 srt");
        }
        if (format !== undefined) {
          const resolved = await resolveMaterialVersion(client, id, version);
          const response = await client.request(
            `/api/materials/${encodeURIComponent(id)}/versions/${resolved}/asr/content`,
            { query: { format }, raw: true },
          );
          if (!response.ok) {
            const text = await response.text().catch(() => "");
            throw new Error(text || `${response.status} ${response.statusText}`);
          }
          const text = await response.text();
          const output = opt(options, "output");
          if (output && output !== "-") {
            const target = path.resolve(output);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, text);
            emit({}, { materialId: id, version: resolved, format, output: target }, (data) => keyValues([
              ["已写入", data.output],
              ["版本", `v${data.version}`],
              ["格式", data.format],
            ]));
          } else if (output === "-") {
            process.stdout.write(text);
          } else {
            emit({}, { materialId: id, version: resolved, format, text }, (data) => data.text);
          }
          return;
        }

        if (options.start) {
          await client.post(`/api/materials/${encodeURIComponent(id)}/asr`, {
            version: version ?? null,
            force: Boolean(options.force),
          });
        }

        const statusPath = asrPath(id, version);
        const readStatus = () => client.get(statusPath);
        if (wait.enabled || options.start) {
          if (!wait.enabled) {
            const current = await readStatus();
            emit({}, current);
            return;
          }
          const data = await poll(readStatus, {
            timeoutMs: wait.timeoutMs,
            label: "语音转写",
            done: (item) => item?.status === "done",
            fail: (item) => (
              ["failed", "unconfigured", "paused"].includes(item?.status)
                ? `${item.status}${item.error ? `：${item.error}` : ""}`
                : null
            ),
          });
          emit({}, data, (item) => keyValues([
            ["状态", item.status],
            ["版本", item.version],
            ["字数", item.chars ?? item.text?.length ?? ""],
          ]));
          return;
        }
        const data = await readStatus();
        emit({}, data, (item) => keyValues([
          ["状态", item.status],
          ["版本", item.version],
          ["进度", item.detail || item.error || ""],
          ["字数", item.chars ?? item.text?.length ?? ""],
        ]));
      },
    },
  },
};
