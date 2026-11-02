/**
 * Local CLI preferences (~/.pe/config.json).
 *
 * Only non-secret values are stored: the default project and an optional
 * service base URL. API keys never belong in this file or in CLI output.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function configPath(env = process.env) {
  if (env.PE_CONFIG) return path.resolve(env.PE_CONFIG);
  return path.join(os.homedir(), ".pe", "config.json");
}

export async function loadLocalConfig(env = process.env) {
  const file = configPath(env);
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? { ...parsed, file } : { file };
  } catch {
    return { file };
  }
}

export async function saveLocalConfig(next, env = process.env) {
  const file = configPath(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const payload = {
    ...next,
    file: undefined,
  };
  await fs.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return file;
}

export function defaultProject(env = process.env) {
  return env.PE_PROJECT || "";
}

export function defaultBaseUrl(env = process.env) {
  if (env.PE_BASE_URL) return env.PE_BASE_URL;
  const port = Number(env.PORT);
  return `http://127.0.0.1:${Number.isFinite(port) && port > 0 ? port : 8080}`;
}
