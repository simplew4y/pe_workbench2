/**
 * sha256-keyed PDF parse cache + page text store.
 *
 * Mirrors WorkbookStore on purpose: the cache key is the blob sha256, parsed
 * JSON is gzipped under data/doc-cache/pdf, and SQLite only keeps the small
 * status row in document_parses. Parsing runs in a serial Python queue; a large
 * PDF can hold a few hundred MB RSS for a second, and concurrent parses on a
 * laptop are not worth it.
 *
 * Output shape is documented in services/pdf/parse_pdf.py and lib/pdf-query.mjs.
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { pdfReportIssuer } from "./fact-memory/pdf-semantic.mjs";
import {
  formatOutline,
  formatPages,
  formatSearch,
  formatTables,
  parsePageSpec,
  searchDoc,
  summarizeDoc,
} from "./pdf-query.mjs";

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const execFileAsync = promisify(execFile);
const OCR_PAGE_LIMIT = 40;

export const PDF_PARSER_VERSION = 1;
const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "services",
  "pdf",
  "parse_pdf.py",
);
const MAX_STDOUT = 96 * 1024 * 1024;
const MAX_STDERR = 16 * 1024;
const PDF_EXTS = new Set(["pdf"]);

function pdfError(message, status = 500, code = "pdf_error") {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function extOf(name) {
  return (String(name || "").split(".").pop() || "").toLowerCase();
}

function killTree(child) {
  try {
    child.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  const timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }, 2000);
  timer.unref?.();
}

export class PdfStore {
  constructor({
    store,
    pythonBin = process.env.PYTHON_BIN || "python3",
    ocrBin = process.env.PDF_OCR_BIN || "",
    cacheDir,
    timeoutMs = 120_000,
    maxLoaded = 2,
  }) {
    this.store = store;
    this.db = store.db;
    this.cacheDir = cacheDir || path.join(store.dataDir, "doc-cache", "pdf");
    this.pythonBin = pythonBin;
    this.ocrBin = ocrBin;
    this.timeoutMs = timeoutMs;
    this.maxLoaded = maxLoaded;
    this.cache = new Map();
    this.inflight = new Map();
    this.calculationPages = new Map();
    this.children = new Set();
    this.queue = Promise.resolve();
    fs.mkdirSync(this.cacheDir, { recursive: true });
    this.ensureSchema();
  }

  /* ---------- schema ---------- */

  ensureSchema() {
    this.db.exec(`
      create table if not exists document_parses (
        blob_sha256 text primary key,
        file_name text not null,
        file_type text not null,
        parser_version integer not null,
        status text not null,
        stats_json text,
        error text,
        parsed_at text,
        updated_at text not null
      );
    `);
  }

  getRecord(sha) {
    return this.db.prepare(`select * from document_parses where blob_sha256 = ?`).get(sha) || null;
  }

  putRecord({ sha, fileName, status, stats, error, parsedAt }) {
    const now = new Date().toISOString();
    this.db.prepare(
      `insert into document_parses
         (blob_sha256, file_name, file_type, parser_version, status, stats_json, error, parsed_at, updated_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)
       on conflict(blob_sha256) do update set
         file_name = excluded.file_name,
         file_type = excluded.file_type,
         parser_version = excluded.parser_version,
         status = excluded.status,
         stats_json = excluded.stats_json,
         error = excluded.error,
         parsed_at = excluded.parsed_at,
         updated_at = excluded.updated_at`,
    ).run(
      sha,
      fileName || "document.pdf",
      "pdf",
      PDF_PARSER_VERSION,
      status,
      stats ? JSON.stringify(stats) : null,
      error || null,
      parsedAt || null,
      now,
    );
  }

  /* ---------- material resolution ---------- */

  isSupportedName(name) {
    return PDF_EXTS.has(extOf(name));
  }

  resolve(materialId, versionNumber = null) {
    const row = this.store.getVersionRow(materialId, versionNumber);
    if (!row) throw pdfError("material not found", 404, "material_not_found");
    const ext = extOf(row.material.path);
    if (!PDF_EXTS.has(ext)) {
      throw pdfError(`暂不支持 .${ext || "?"} 文件；pdf_read 只能读取 .pdf。`, 422, "unsupported_type");
    }
    return {
      material: row.material,
      version: row.version,
      sha: row.version.blob_sha256,
      fileName: row.version.displayName || row.material.name,
      ext,
      blob: this.store.blobPath(row.version.blob_sha256),
    };
  }

  /* ---------- cache ---------- */

  cachePath(sha) {
    return path.join(this.cacheDir, `${sha}.json.gz`);
  }

  touch(sha, document) {
    this.cache.delete(sha);
    this.cache.set(sha, document);
    while (this.cache.size > this.maxLoaded) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
    return document;
  }

  async loadCached(sha) {
    try {
      const buffer = await fsp.readFile(this.cachePath(sha));
      const json = await gunzip(buffer);
      return this.touch(sha, JSON.parse(json.toString("utf8")));
    } catch {
      return null;
    }
  }

  async getDocument(sha, meta = {}) {
    const cached = this.cache.get(sha);
    if (cached) return this.touch(sha, cached);

    const record = this.getRecord(sha);
    if (
      record?.status === "ready" &&
      record.parser_version === PDF_PARSER_VERSION &&
      fs.existsSync(this.cachePath(sha))
    ) {
      const document = await this.loadCached(sha);
      if (document) return document;
    }

    if (record?.status === "failed" && record.parser_version === PDF_PARSER_VERSION && !meta.force) {
      throw pdfError(record.error || "该 PDF 上次解析失败，可重新上传或稍后重试。", 422, "parse_failed");
    }

    const running = this.inflight.get(sha);
    if (running) return running;

    const task = this.enqueue(() => this.parse(sha, meta));
    this.inflight.set(sha, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(sha);
    }
  }

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async parse(sha, { fileName, blob, force } = {}) {
    const source = blob || (await this.findBlob(sha));
    const name = fileName || "document.pdf";
    this.putRecord({ sha, fileName: name, status: "running" });
    try {
      const document = await this.runParser(source, []);
      await fsp.writeFile(this.cachePath(sha), await gzip(JSON.stringify(document)));
      const stats = summarizeDoc(document);
      this.putRecord({
        sha,
        fileName: name,
        status: "ready",
        stats,
        parsedAt: new Date().toISOString(),
      });
      return this.touch(sha, document);
    } catch (error) {
      this.putRecord({
        sha,
        fileName: name,
        status: "failed",
        error: error.message,
        parsedAt: new Date().toISOString(),
      });
      throw error;
    }
  }

  async findBlob(sha) {
    const candidate = this.store.blobPath(sha);
    if (fs.existsSync(candidate)) return candidate;
    throw pdfError("版本内容不存在，无法解析", 404, "blob_missing");
  }

  runParser(blob, extraArgs = []) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.pythonBin, [SCRIPT, blob, ...extraArgs], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.children.add(child);
      const stdout = [];
      let stdoutBytes = 0;
      let stderr = "";
      let settled = false;

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.children.delete(child);
        if (error) reject(error);
        else resolve(value);
      };

      const timer = setTimeout(() => {
        killTree(child);
        finish(pdfError(`PDF 解析超时（${Math.round(this.timeoutMs / 1000)} 秒）`, 504, "parse_timeout"));
      }, this.timeoutMs);
      timer.unref?.();

      child.stdout.on("data", (chunk) => {
        stdoutBytes += chunk.length;
        if (stdoutBytes > MAX_STDOUT) {
          killTree(child);
          finish(pdfError("PDF 解析输出过大", 500, "output_too_large"));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => {
        if (stderr.length < MAX_STDERR) stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        const message =
          error.code === "ENOENT"
            ? `找不到 Python（${this.pythonBin}）。PDF 解析需要 Python 3 + pdfplumber。`
            : `无法启动 PDF 解析器：${error.message}`;
        finish(pdfError(message, 500, "python_missing"));
      });
      child.on("close", (code) => {
        if (settled) return;
        if (code !== 0) {
          const reason = stderr.trim().split("\n").filter(Boolean).pop();
          finish(
            pdfError(reason || `PDF 解析失败（exit ${code}）`, code === 2 ? 422 : 500, "parse_failed"),
          );
          return;
        }
        try {
          const document = JSON.parse(Buffer.concat(stdout).toString("utf8"));
          finish(null, document);
        } catch (error) {
          finish(pdfError(`PDF 解析输出不是合法 JSON：${error.message}`, 500, "bad_output"));
        }
      });
    });
  }

  /* ---------- public reads ---------- */

  async getForMaterial(materialId, versionNumber = null) {
    const info = this.resolve(materialId, versionNumber);
    const document = await this.getDocument(info.sha, {
      fileName: info.fileName,
      blob: info.blob,
    });
    return { info, document };
  }

  async summary(materialId, versionNumber = null) {
    const { info, document } = await this.getForMaterial(materialId, versionNumber);
    const record = this.getRecord(info.sha);
    return {
      materialId,
      name: info.fileName,
      path: info.material.path,
      version: info.version.v,
      sha256: info.sha,
      status: record?.status || "ready",
      parserVersion: record?.parser_version || PDF_PARSER_VERSION,
      parsedAt: record?.parsed_at || null,
      ...summarizeDoc(document),
      headings: document.headings || [],
      outline: document.outline || [],
      pageStats: (document.pages || []).map((page) => ({
        page: page.page,
        chars: page.chars,
        images: page.images,
        scanned: !!page.scanned,
        firstLine: (page.paragraphs || []).find((item) => item.trim())?.slice(0, 80) || "",
      })),
    };
  }

  async outline(materialId, versionNumber = null) {
    const { info, document } = await this.getForMaterial(materialId, versionNumber);
    const formatted = formatOutline(document, { name: info.fileName });
    return { ...formatted, materialId, name: info.fileName, version: info.version.v, sha256: info.sha };
  }

  async readScanPages(info, document, requested) {
    if (!this.ocrBin) return document;
    const numbers = document.pages.filter(page => page.scanned && requested.includes(page.page)).map(page => page.page);
    if (!numbers.length) return document;

    const capture = await this.enqueue(async () => {
      const cachePath = number => path.join(this.cacheDir, `${info.sha}.ocr-v1.p${number}.txt`);
      const pages = new Map();
      const missing = [];
      for (const number of numbers) {
        try {
          pages.set(number, await fsp.readFile(cachePath(number), "utf8"));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          missing.push(number);
        }
      }
      if (missing.length) {
        const { stdout } = await execFileAsync(this.ocrBin, [info.blob, missing.join(",")], {
          timeout: this.timeoutMs, maxBuffer: MAX_STDOUT,
        }).catch(error => {
          const reason = String(error.stderr || error.code || error.message).trim().slice(0, 400);
          throw pdfError(`PDF 扫描页识别失败：${reason}`, 502, "ocr_failed");
        });
        const recognized = JSON.parse(stdout);
        if (missing.some(number => typeof recognized[number] !== "string")) {
          throw pdfError("OCR 响应缺少请求的页码", 502, "ocr_missing_page");
        }
        for (const number of missing) {
          const text = recognized[number].trim();
          const target = cachePath(number);
          const temp = `${target}.${randomUUID()}.tmp`;
          await fsp.writeFile(temp, text, { mode: 0o600 });
          await fsp.rename(temp, target);
          pages.set(number, text);
        }
      }
      return pages;
    });
    return {
      ...document,
      pages: document.pages.map(page => {
        const text = capture.get(page.page);
        return text ? {
          ...page, ocr: true, chars: text.replace(/\s/g, "").length, paragraphs: text.split("\n"),
        } : page;
      }),
    };
  }

  async readPages(materialId, pageSpec, { maxChars = 12000, versionNumber = null } = {}) {
    const { info, document } = await this.getForMaterial(materialId, versionNumber);
    const total = document.pages?.length || 0;
    let pages = parsePageSpec(pageSpec, total);
    if (!pages.length) {
      // No page argument: read from the first page with text.
      const first = (document.pages || []).find((page) => !page.scanned) || document.pages?.[0];
      pages = first ? [first.page] : [];
    }
    const readable = await this.readScanPages(info, document, pages);
    const formatted = formatPages(readable, pages, { name: info.fileName, maxChars });
    return {
      ...formatted,
      materialId,
      name: info.fileName,
      version: info.version.v,
      sha256: info.sha,
      issuer: pdfReportIssuer(document),
      requested: pages,
      total,
      blocks: pages.map((number) => {
        const page = (readable.pages || []).find((item) => item.page === number);
        if (!page) return { page: number, scanned: true, images: 0, paragraphs: [] };
        return {
          page: number,
          scanned: !!page.scanned,
          ocr: !!page.ocr,
          images: page.images || 0,
          chars: page.chars || 0,
          paragraphs: page.paragraphs || [],
        };
      }),
    };
  }

  async search(materialId, query, { maxSnippets = 6, versionNumber = null } = {}) {
    const { info, document } = await this.getForMaterial(materialId, versionNumber);
    const limit = Math.min(20, Math.max(1, Number(maxSnippets) || 6));
    let result = searchDoc(document, query, { maxSnippets: limit });
    let extraHint = "";
    if (!result.hits.length && this.ocrBin) {
      const scanned = document.pages.filter(page => page.scanned).map(page => page.page);
      const readable = await this.readScanPages(info, document, scanned.slice(0, OCR_PAGE_LIMIT));
      const fromScan = new Set(readable.pages.filter(page => page.ocr).map(page => page.page));
      result = searchDoc(readable, query, { maxSnippets: limit });
      for (const hit of result.hits) hit.ocr = fromScan.has(hit.page);
      if (scanned.length > OCR_PAGE_LIMIT) extraHint = `\n本次识别了前 ${OCR_PAGE_LIMIT} 张扫描页，后续页可指定页码阅读。`;
    }
    const formatted = formatSearch(result, { name: info.fileName });
    return {
      ...formatted,
      text: formatted.text + extraHint,
      materialId,
      name: info.fileName,
      version: info.version.v,
      sha256: info.sha,
      query: result.query,
      pages: result.pages,
      hits: result.hits,
    };
  }

  async calculationSources(materialId, page, version) {
    if (!Number.isSafeInteger(page) || page < 1 || page > 999999) throw new Error("需要单个 PDF 页码");
    const info = this.resolve(materialId);
    if (version != null && version !== info.version.v) throw new Error("PDF 材料版本已变化，请重新读取");
    const key = info.sha + ":" + page;
    let parsed = this.calculationPages.get(key);
    if (!parsed) {
      parsed = this.queue.then(() => this.runParser(info.blob, ["--calculation-page", String(page)]));
      this.queue = parsed.catch(() => {});
      this.calculationPages.set(key, parsed);
      if (this.calculationPages.size > 32) this.calculationPages.delete(this.calculationPages.keys().next().value);
      parsed.catch(() => { if (this.calculationPages.get(key) === parsed) this.calculationPages.delete(key); });
    }
    const {facts} = await parsed;
    if (this.resolve(materialId).version.v !== info.version.v) throw new Error("PDF 材料版本已变化，请重新读取");
    return facts.map(({row,column,value,...fact}) => {
      const locator = 'p.' + page + '/r' + row + 'c' + column;
      return {...fact, materialId, filename:info.fileName, version:info.version.v, sha256:info.sha,
        id:'cite:'+materialId+':v'+info.version.v+':'+locator, locator, role:'pdf_number',
        raw_unit:fact.display_unit, value:value.replaceAll(',', '').replace(/%$/, '').replace(/^\((.+)\)$/, '-$1')};
    });
  }

  async tables(materialId, pageSpec, { versionNumber = null } = {}) {
    const { info, document } = await this.getForMaterial(materialId, versionNumber);
    const total = document.pages?.length || 0;
    const pages = parsePageSpec(pageSpec, total);
    if (!pages.length) {
      throw pdfError("查看表格需要指定页码，例如 page=\"2-4\"。", 400, "page_required");
    }
    const args = ["--tables", "--pages", pages.join(",")];
    const parsed = await this.runParser(info.blob, args);
    const tables = parsed.tables || [];
    const formatted = formatTables(tables, { name: info.fileName, pages });
    return {
      ...formatted,
      materialId,
      name: info.fileName,
      version: info.version.v,
      sha256: info.sha,
      pages,
      tables,
      pageContexts: pages.map(number=>({page:number,text:(document.pages || []).find(p=>p.page===number)?.paragraphs?.join('\n') || ''})),
    };
  }

  async warm(materialId) {
    const { info, document } = await this.getForMaterial(materialId);
    return {
      materialId,
      sha256: info.sha,
      status: "ready",
      stats: summarizeDoc(document),
    };
  }

  async invalidate(sha) {
    this.cache.delete(sha);
    await fsp.rm(this.cachePath(sha), { force: true }).catch(() => {});
    this.db.prepare(`delete from document_parses where blob_sha256 = ?`).run(sha);
  }

  close() {
    for (const child of this.children) killTree(child);
    this.children.clear();
  }
}

export default PdfStore;
