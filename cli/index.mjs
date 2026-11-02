#!/usr/bin/env node
/**
 * `pe` command dispatcher.
 *
 * The CLI is intentionally a thin wrapper over the existing local HTTP API.
 * Every command is a leaf in the tree below; groups only provide help and
 * routing. See docs/cli.md for the command/UI mapping and known gaps.
 */

import fs from "node:fs";

import { UsageError, opt, parseArgv, waitOptions } from "./args.mjs";
import { createClient, HttpError } from "./client.mjs";
import { defaultBaseUrl, loadLocalConfig } from "./config.mjs";
import { approval } from "./commands/approval.mjs";
import { dashboard } from "./commands/dashboard.mjs";
import { doctor } from "./commands/doctor.mjs";
import { events } from "./commands/events.mjs";
import { material } from "./commands/material.mjs";
import { notification } from "./commands/notification.mjs";
import { plan } from "./commands/plan.mjs";
import { project } from "./commands/project.mjs";
import { run } from "./commands/run.mjs";
import { session } from "./commands/session.mjs";
import { trace } from "./commands/trace.mjs";
import { track } from "./commands/track.mjs";
import { watch } from "./commands/watch.mjs";
import { setOutputContext } from "./commands/shared.mjs";

const commands = {
  doctor,
  project,
  session,
  material,
  plan,
  track,
  notification,
  watch,
  approval,
  trace,
  dashboard,
  run,
  events,
};

const GLOBAL_OPTIONS = [
  { flags: "--base-url <url>", desc: "服务地址，默认 http://127.0.0.1:8080（也可用 PE_BASE_URL）" },
  { flags: "--project <id>", desc: "项目 id，默认取 ~/.pe/config.json 的 project（也可用 PE_PROJECT）" },
  { flags: "--json", desc: "机器可读 JSON 输出（事件流为 NDJSON）" },
  { flags: "--yes", desc: "确认危险写操作（delete/restore/approve/reject/undo 等）" },
  { flags: "--wait[=seconds]", desc: "等待长任务结束，默认 120 秒；超时非零退出" },
  { flags: "--timeout <seconds>", desc: "覆盖 --wait 的超时秒数" },
  { flags: "-h, --help", desc: "显示帮助" },
  { flags: "--cli-version", desc: "显示 CLI 版本（资料命令的 --version 用于版本号）" },
];

function resolveNode(tree, positionals) {
  let node;
  const root = { children: tree };
  node = root;
  const path = [];
  let index = 0;
  while (index < positionals.length) {
    const token = positionals[index];
    const children = node.children || {};
    if (Object.hasOwn(children, token)) {
      node = children[token];
      path.push(token);
      index += 1;
      continue;
    }
    break;
  }
  return { node, path, args: positionals.slice(index) };
}

function optionLines(options) {
  return options.map((item) => `  ${item.flags.padEnd(26)} ${item.desc}`).join("\n");
}

function renderHelp(node, path) {
  const name = path.length ? `pe ${path.join(" ")}` : "pe";
  const lines = [];
  lines.push(`${name} — ${node.summary || "pe Workbench CLI"}`);
  if (node.usage) lines.push(`\n用法：${node.usage}`);
  if (node.children) {
    lines.push("\n子命令：");
    for (const [key, child] of Object.entries(node.children)) {
      lines.push(`  ${key.padEnd(12)} ${child.summary || ""}`);
    }
  }
  const localOptions = Array.isArray(node.options) ? node.options : [];
  if (localOptions.length) {
    lines.push("\n命令参数：");
    lines.push(optionLines(localOptions));
  }
  lines.push("\n全局参数：");
  lines.push(optionLines(GLOBAL_OPTIONS));
  if (path.length === 0) {
    lines.push("\n示例：");
    lines.push("  pe doctor --json");
    lines.push("  pe material list");
    lines.push("  pe track run <tracking-id> --wait");
    lines.push("  pe watch status");
    lines.push("\n完整说明：docs/cli.md");
  }
  return `${lines.join("\n")}\n`;
}

function packageVersion() {
  try {
    const raw = fs.readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return JSON.parse(raw).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgv(argv);
  } catch (error) {
    process.stderr.write(`错误：${error.message}\n`);
    return error.exitCode || 2;
  }

  const { options } = parsed;
  let positionals = parsed.positionals;

  if (options["cli-version"]) {
    process.stdout.write(`pe ${packageVersion()}\n`);
    return 0;
  }

  let forcedHelp = false;
  if (positionals[0] === "help") {
    forcedHelp = true;
    positionals = positionals.slice(1);
  }

  const { node, path, args } = resolveNode(commands, positionals);
  const wantsHelp = forcedHelp || options.help === true || options.help === "true";
  if (!path.length && (wantsHelp || argv.length === 0)) {
    process.stdout.write(renderHelp({ summary: "通过本地 HTTP API 操作 pe_workbench2", children: commands }, []));
    return 0;
  }
  if (wantsHelp) {
    process.stdout.write(renderHelp(node, path));
    return 0;
  }
  if (typeof node.run !== "function") {
    if (path.length && args.length === 0) {
      process.stdout.write(renderHelp(node, path));
      return 0;
    }
    const unknown = args[0] || "";
    process.stderr.write(`错误：未知命令 ${["pe", ...path, unknown].filter(Boolean).join(" ")}\n`);
    process.stderr.write("运行 pe --help 查看命令。\n");
    return 2;
  }

  const localConfig = await loadLocalConfig();
  const baseUrl = opt(options, "base-url")
    || process.env.PE_BASE_URL
    || localConfig.baseUrl
    || defaultBaseUrl();
  const project = opt(options, "project")
    || process.env.PE_PROJECT
    || localConfig.project
    || "";
  const wait = waitOptions(options);
  const client = createClient({ baseUrl, project });
  const ctx = {
    client,
    options,
    args,
    json: options.json === true || options.json === "true",
    wait,
    command: ["pe", ...path].join(" "),
    baseUrl: client.baseUrl,
    project,
  };

  try {
    setOutputContext(ctx);
    await node.run(ctx);
    return 0;
  } catch (error) {
    if (error instanceof UsageError || error?.exitCode === 2) {
      process.stderr.write(`错误：${error.message}\n`);
      return 2;
    }
    if (error instanceof HttpError) {
      const status = error.status ? `HTTP ${error.status}` : "请求失败";
      const where = [error.method, error.pathname].filter(Boolean).join(" ");
      const code = error.code ? ` [${error.code}]` : "";
      process.stderr.write(`错误：${status}${code}${where ? ` · ${where}` : ""} — ${error.message}\n`);
      if (process.env.PE_DEBUG) process.stderr.write(`${error.stack}\n`);
      return 1;
    }
    process.stderr.write(`错误：${error?.message || error}\n`);
    if (process.env.PE_DEBUG) process.stderr.write(`${error?.stack || ""}\n`);
    return 1;
  }
}

export default main;
