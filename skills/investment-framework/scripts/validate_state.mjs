#!/usr/bin/env node
/**
 * analysis-state.json 结构校验器（CLI）。
 *
 * 规则本体在 lib/validate-state.mjs，同一份逻辑也供 Pi 的 validate_state
 * 工具在 Node 进程内调用；这里只负责读文件、打印和退出码。
 *
 * 用法：
 *   node scripts/validate_state.mjs [analysis-state.json]
 *   node scripts/validate_state.mjs --quiet state.json
 *
 * 退出码：0 = 无 error（可有 warning）；1 = 有 error 或读不到文件。
 */

import fs from "node:fs";
import path from "node:path";

import { validateState } from "../../../lib/validate-state.mjs";

const COLORS = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (COLORS ? `\x1b[2m${s}\x1b[0m` : s);
const red = (s) => (COLORS ? `\x1b[31m${s}\x1b[0m` : s);
const yellow = (s) => (COLORS ? `\x1b[33m${s}\x1b[0m` : s);
const green = (s) => (COLORS ? `\x1b[32m${s}\x1b[0m` : s);

const args = process.argv.slice(2);
const quiet = args.includes("--quiet");
const target = args.find((arg) => !arg.startsWith("--")) || "analysis-state.json";
const file = path.resolve(process.cwd(), target);

let state;
try {
  state = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
  console.error(red(`✗ 无法读取 ${target}: ${error.message}`));
  process.exit(1);
}

if (state === null || typeof state !== "object" || Array.isArray(state)) {
  console.error(red("✗ 顶层必须是对象"));
  process.exit(1);
}

const { errors, warnings } = validateState(state);

/* ---------- 输出 ---------- */

const label = path.basename(file);
if (!quiet) {
  console.log(dim(`校验 ${label} · ${state.subject?.company || "（未命名）"} · revision ${state.revision} · ${state.stage} · schema ${state.schema_version}`));
}

for (const warning of warnings) console.log(yellow(`  warn  ${warning}`));
for (const error of errors) console.log(red(`  error ${error}`));

if (errors.length === 0) {
  console.log(green(`✓ 通过：0 error，${warnings.length} warning`));
  process.exit(0);
}
console.log(red(`✗ 未通过：${errors.length} error，${warnings.length} warning`));
process.exit(1);
