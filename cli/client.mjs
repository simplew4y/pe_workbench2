/**
 * HTTP client for the local Workbench service.
 *
 * The CLI only speaks the existing `/api/*` contract; it has no database or
 * business logic of its own. Project scoping mirrors `ui/api/client.js`:
 * `?project=<id>` for project-data routes, omitted for health/projects.
 */

import fs from "node:fs/promises";
import path from "node:path";

export class HttpError extends Error {
  constructor(message, { status = 0, method = "", pathname = "", data = null, code = "" } = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.method = method;
    this.pathname = pathname;
    this.data = data;
    this.code = code || data?.code || "";
  }
}

export function normalizeBaseUrl(value) {
  const raw = String(value || "").trim();
  if (!/^https?:\/\//i.test(raw)) {
    throw new Error(`--base-url 必须是 http(s) URL，收到：${raw}`);
  }
  return raw.replace(/\/+$/, "");
}

export function createClient({ baseUrl, project = "", requestTimeoutMs = 120_000 } = {}) {
  const base = normalizeBaseUrl(baseUrl);

  function scoped(pathname, scope) {
    if (!scope || !project) return pathname;
    if (pathname === "/api/health" || pathname === "/api/projects" || pathname.startsWith("/api/projects/")) {
      return pathname;
    }
    const separator = pathname.includes("?") ? "&" : "?";
    return `${pathname}${separator}project=${encodeURIComponent(project)}`;
  }

  async function request(pathname, {
    method = "GET",
    body,
    query,
    scope = true,
    headers = {},
    raw = false,
    timeoutMs = requestTimeoutMs,
  } = {}) {
    const url = new URL(`${base}${scoped(pathname, scope)}`);
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        if (Array.isArray(value)) {
          for (const item of value) url.searchParams.append(key, String(item));
        } else {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const init = { method, headers: { ...headers }, signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) {
      if (body instanceof Uint8Array || typeof body === "string") {
        init.body = body;
      } else {
        init.headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }
    }

    let response;
    try {
      response = await fetch(url, init);
    } catch (error) {
      if (error?.name === "TimeoutError" || error?.name === "AbortError") {
        throw new HttpError(`${method} ${pathname} 超时（${Math.round(timeoutMs / 1000)}s）`, {
          method,
          pathname,
        });
      }
      throw new HttpError(`无法连接服务 ${base}：${error?.message || error}`, { method, pathname });
    }

    if (raw) return response;

    const text = await response.text();
    let data = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const message = typeof data === "object" && data?.error
        ? data.error
        : `${response.status} ${response.statusText}`;
      throw new HttpError(message, {
        status: response.status,
        method,
        pathname,
        data,
        code: typeof data === "object" ? data?.code : "",
      });
    }
    return data ?? {};
  }

  async function uploadFile(filePath) {
    const absolute = path.resolve(filePath);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) throw new Error(`文件不存在或不是普通文件：${filePath}`);
    const buffer = await fs.readFile(absolute);
    return request("/api/upload", {
      method: "POST",
      body: buffer,
      timeoutMs: 15 * 60 * 1000,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(buffer.length),
        "X-File-Name": encodeURIComponent(path.basename(absolute)),
      },
    });
  }

  async function download(pathname, { query, output }) {
    const response = await request(pathname, { raw: true, query, timeoutMs: 30 * 60 * 1000 });
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let data = null;
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
      throw new HttpError(
        typeof data === "object" && data?.error ? data.error : `${response.status} ${response.statusText}`,
        { status: response.status, pathname, data },
      );
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (output === "-") {
      process.stdout.write(buffer);
      return { bytes: buffer.length, output: "-" };
    }
    const target = path.resolve(output);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, buffer);
    return { bytes: buffer.length, output: target };
  }

  return {
    baseUrl: base,
    project,
    request,
    get: (pathname, options) => request(pathname, { ...options, method: "GET" }),
    post: (pathname, body, options) => request(pathname, { ...options, method: "POST", body }),
    patch: (pathname, body, options) => request(pathname, { ...options, method: "PATCH", body }),
    delete: (pathname, options) => request(pathname, { ...options, method: "DELETE" }),
    uploadFile,
    download,
  };
}
