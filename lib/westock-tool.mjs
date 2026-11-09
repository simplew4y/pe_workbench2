/**
 * Pi custom tool: westock_query.
 *
 * Wraps the WeStock CLI with execFile (no shell, no string interpolation) so
 * the agent can query market data from the sandboxed Workbench runtime. The
 * CLI returns Markdown tables; this tool passes that text through unchanged.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 120_000;

function resolveBinary(explicit) {
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`WESTOCK_BIN 指向的文件不存在：${explicit}`);
    }
    return explicit;
  }
  const home = process.env.HOME || os.homedir();
  const candidates = [
    process.env.WESTOCK_BIN,
    path.join(home, ".local", "bin", "westock"),
    "/opt/homebrew/bin/westock",
    "/usr/local/bin/westock",
  ].filter(Boolean);
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "未找到 westock CLI。请先安装（scripts/setup.sh、setup.ps1 或 setup.cjs），或用 WESTOCK_BIN 指定路径。",
    );
  }
  return found;
}

export function normalizeWestockTicker(raw) {
  const clean = String(raw).replace(/（[^）]*）|\([^)]*\)|【[^】]*】|\[[^\]]*\]/g, '').replace(/[\u3400-\u9fff]+\s*$/u, '').replace(/\s+/g, '');
  const match = clean.match(/^([A-Za-z0-9.-]+)\.(HK|US|SH|SZ|BJ)$/i);
  const ticker = match ? `${match[2].toLowerCase()}${match[1]}` : clean;
  const prefixed = ticker.match(/^(hk|sh|sz|bj|us)([A-Za-z0-9.-]+)$/i);
  return prefixed ? `${prefixed[1].toLowerCase()}${prefixed[1].toLowerCase() === 'us' ? prefixed[2].toUpperCase() : prefixed[2]}` : ticker;
}

export function normalizedArgs(raw) {
  const args = (Array.isArray(raw) ? raw : [])
    .map((value) => String(value))
    .filter((value) => value.length > 0);
  if (args.length === 0) {
    throw new Error("args 不能为空；第一个元素是 westock 子命令，例如 [\"quote\",\"sh600519\"]");
  }
  if (args.length > 24) {
    throw new Error("args 最多 24 项");
  }
  if (args.some((value) => value.includes("\u0000"))) {
    throw new Error("args 含非法字符");
  }
  // Allow callers that accidentally include the program name.
  if (args[0] === "westock") args.shift();
  const helpLike = new Set(["--help", "-h", "--version", "-v"]);
  if (args.length === 0 || (args[0].startsWith("-") && !helpLike.has(args[0]))) {
    throw new Error("args 第一项必须是 westock 子命令（或 --help/--version），不能是其它选项");
  }
  // Normalize only ticker-shaped positional arguments; preserve search text/options.
  for (let i = 1; i < args.length; i++) {
    if (args[i - 1].startsWith('-')) continue;
    const parts = args[i].split(',').map(normalizeWestockTicker);
    if (parts.every(part => /^(?:(?:sh|sz|bj|hk)\d+|us[A-Za-z0-9.-]+)$/i.test(part))) {
      args[i] = parts.join(',');
    }
  }
  return args;
}

export function verifyQuoteIdentity(raw, expectedName, requestedArgs) {
  if (!String(expectedName || "").trim()) throw new Error("quote 必须提供 expectedName，先核实查询对象名称；不能仅猜证券代码。");
  const codes = requestedArgs.slice(1).filter(arg => !arg.startsWith("--"));
  if (codes.length !== 1 || codes[0].includes(",")) throw new Error("带身份核验的 quote 请逐个证券查询，分别提供 expectedName。");
  const lines = raw.split(/\r?\n/).filter(line => line.trim().startsWith("|"));
  const cells = line => line.split("|").slice(1,-1).map(item => item.trim());
  const hi = lines.findIndex(line => cells(line).includes("name") && (cells(line).includes("code") || cells(line).includes("symbol")));
  if (hi < 0) throw new Error("行情结果缺少名称/代码列，无法确认主体。");
  const headers = cells(lines[hi]);
  const data = lines.slice(hi+1).map(cells).filter(row => !row.every(value => /^[: -]*$/.test(value)));
  const codeIndex = headers.includes("code") ? headers.indexOf("code") : headers.indexOf("symbol");
  const expectedCode = normalizeWestockTicker(codes[0]);
  const row = data.find(row => normalizeWestockTicker(row[codeIndex]).toLowerCase() === expectedCode.toLowerCase());
  if (!row) throw new Error(`行情回传代码与请求 ${expectedCode} 不符。`);
  const actualName = row[headers.indexOf("name")];
  const normalize = value => String(value || "").normalize("NFKC").replace(/\s+/g, "").toLowerCase();
  if (normalize(actualName) !== normalize(expectedName)) throw new Error(`证券主体不匹配：预期「${expectedName}」，实际「${actualName}」（${expectedCode}）。不得用于目标公司的行情或估值。`);
  return { code: expectedCode, name: actualName, verified: true };
}

function clipped(text) {
  if (text.length <= MAX_OUTPUT_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n[输出已截断：原长 ${text.length} 字符，仅保留前 ${MAX_OUTPUT_CHARS} 字符]`,
    truncated: true,
  };
}

export function createWestockTool({ workspace, bin } = {}) {
  let binary;
  let binaryError;
  try {
    binary = resolveBinary(bin);
  } catch (error) {
    binaryError = error.message;
  }

  return {
    name: "westock_query",
    label: "查询金融市场数据",
    description:
      "调用 WeStock CLI 查询结构化金融数据：A/港/美/日韩股行情、K 线、财报、研报、新闻、公告、股东、分红、ETF、指数、板块、期货、外汇、可转债、资金流、龙虎榜和宏观数据。" +
      "args 直接传给 westock 子命令，不经过 shell；返回 CLI 的 Markdown 表格原文。",
    promptSnippet: "westock_query：查询行情、财报、研报、公告、资金和宏观数据",
    promptGuidelines: [
      "查询金融数据时优先使用 westock_query，不要用 web_search、HTTP 直连或训练数据替代。",
      "args 是字符串数组，第一项为子命令：[\"quote\",\"sh600519\"]、[\"finance\",\"sh600519,sz000651\",\"--limit\",\"4\"]。",
      "股票代码必须带市场前缀（sh/sz/bj/hk/us/t/ks/kq/fu/fx/pt）；多股批量把代码用逗号放在同一个参数里。",
      "工具返回的是 Markdown 表格原文；聊天回复遵守工作台格式（不使用表格），需要完整表格时写入 exports/。",
    ],
    parameters: Type.Object({
      args: Type.Array(Type.String(), {
        minItems: 1,
        maxItems: 24,
        description:
          "westock 子命令及参数，例如 [\"quote\",\"sh600519\"] 或 [\"finance\",\"sh600519,sz000651\",\"--limit\",\"4\"]",
      }),
      expectedName: Type.Optional(Type.String({ description: "quote 必填：查询对象名称，必须与回传 name 一致；比较公司也需单独注明其真实名称。" })),
      timeoutMs: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: MAX_TIMEOUT_MS,
          description: "超时毫秒，默认 30000，最大 60000",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const started = Date.now();
      let args;
      try {
        if (!binary) throw new Error(binaryError || "westock CLI 不可用");
        args = normalizedArgs(params?.args);
        if (args[0] === "quote" && !String(params.expectedName || "").trim()) throw new Error("quote 必须提供 expectedName；请先核实查询对象名称。");
      } catch (error) {
        return {
          content: [{ type: "text", text: `westock_query 失败：${error.message}` }],
          details: { error: error.message },
          isError: true,
        };
      }

      const timeoutMs = Math.min(
        Math.max(Number(params?.timeoutMs) || DEFAULT_TIMEOUT_MS, 1000),
        MAX_TIMEOUT_MS,
      );

      try {
        const { stdout = "", stderr = "" } = await execFileAsync(binary, args, {
          cwd: workspace,
          timeout: timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            PATH: `${path.dirname(binary)}:${process.env.PATH || ""}`,
            NO_COLOR: "1",
          },
        });
        const raw = stdout.trim();
        const err = stderr.trim();
        const identity = args[0] === "quote" ? verifyQuoteIdentity(raw, params.expectedName, args) : null;
        const fetchedAt = new Date().toISOString();
        const { text, truncated } = clipped(
          [raw || "westock 返回空结果。", err ? `\n\n[stderr]\n${err}` : "", `\n\n[meta]\nfetched_at=${fetchedAt}`].join(""),
        );
        return {
          content: [{ type: "text", text }],
          details: {
            args,
            bin: binary,
            durationMs: Date.now() - started,
            truncated,
            fetched_at: fetchedAt,
            identity,
          },
        };
      } catch (error) {
        const stdout = typeof error?.stdout === "string" ? error.stdout.trim() : "";
        const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
        const reason = error?.killed
          ? `westock 执行超时（${timeoutMs}ms）`
          : stderr || error?.message || String(error);
        const { text } = clipped(
          [`westock_query 失败：${reason}`, stdout ? `\n\n[stdout]\n${stdout}` : ""].join(""),
        );
        return {
          content: [{ type: "text", text }],
          details: {
            args,
            bin: binary,
            durationMs: Date.now() - started,
            code: error?.code,
            signal: error?.signal,
            killed: Boolean(error?.killed),
          },
          isError: true,
        };
      }
    },
  };
}

export default createWestockTool;
