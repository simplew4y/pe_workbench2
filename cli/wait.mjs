/** Shared polling helpers for `--wait`. Timeout is always a non-zero exit. */

import { HttpError } from "./client.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function poll(fn, {
  timeoutMs,
  intervalMs = 1000,
  label = "操作",
  done,
  fail = null,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  while (Date.now() <= deadline) {
    try {
      last = await fn();
      lastError = null;
      if (done(last)) return last;
      if (fail) {
        const failure = fail(last);
        if (failure) {
          throw new Error(`${label}失败：${failure}`);
        }
      }
    } catch (error) {
      if (error instanceof HttpError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        throw error;
      }
      lastError = error;
    }
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  const seconds = Math.round(timeoutMs / 1000);
  const detail = lastError ? `；最后一次错误：${lastError.message}` : "";
  const hint = last ? `；最后状态：${JSON.stringify(last).slice(0, 300)}` : "";
  throw new Error(`${label}等待超时（${seconds}s）${detail}${hint}`);
}

export function firstVersion(material) {
  return material?.versions?.[0]?.v ?? null;
}
