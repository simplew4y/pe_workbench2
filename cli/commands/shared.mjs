/** Small helpers shared by command modules. */

import fs from "node:fs/promises";
import path from "node:path";

import { UsageError, opt } from "../args.mjs";
import { emit as writeEmit, keyValues, table } from "../output.mjs";
import { firstVersion } from "../wait.mjs";

export { keyValues, table, firstVersion };

/**
 * Commands pass `{}` as the output context when they do not need any other
 * field. The dispatcher installs the real context here so `--json` still wins.
 */
let activeOutputContext = null;

export function setOutputContext(ctx) {
  activeOutputContext = ctx;
}

export function emit(ctx, data, render = null) {
  const effective = ctx && Object.hasOwn(ctx, "json") ? ctx : (activeOutputContext || ctx || {});
  return writeEmit(effective, data, render);
}

export function requireYes(options, action) {
  if (options.yes !== true && options.yes !== "true") {
    throw new UsageError(`危险操作需要确认：${action}。确认后加 --yes 重试。`);
  }
}

export async function readJsonFile(file, label = "JSON 文件") {
  let raw;
  try {
    raw = await fs.readFile(path.resolve(file), "utf8");
  } catch (error) {
    throw new UsageError(`无法读取${label} ${file}：${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new UsageError(`${label}不是合法 JSON：${error.message}`);
  }
}

export async function uploadFiles(client, files) {
  const uploaded = [];
  for (const file of files) {
    uploaded.push(await client.uploadFile(file));
  }
  return uploaded;
}

export async function resolveMaterialVersion(client, materialId, explicit) {
  if (explicit !== undefined && explicit !== null) return Number(explicit);
  const material = await client.get(`/api/materials/${encodeURIComponent(materialId)}`);
  const version = firstVersion(material);
  if (!version) throw new Error(`资料 ${materialId} 没有可用版本`);
  return version;
}

export function parseJsonOption(options, name, label) {
  const value = opt(options, name);
  if (value === undefined || value === "") return undefined;
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new UsageError(`--${name} 必须是合法 JSON：${error.message}`);
  }
}

export function summarizeError(error) {
  return error?.message || String(error);
}
