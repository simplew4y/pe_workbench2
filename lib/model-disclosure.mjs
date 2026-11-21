import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readCells, recalculateXlsx } from "./calc-engine.mjs";
import { actualHeaderIssue, normalizeActuals, reconcileActuals } from "./model-actuals.mjs";

export function disclosureProposalIssues(changes, actuals) {
  const allowed = new Map(actuals.filter(r => r.mode !== "check").map(r => [r.sheet + "!" + r.cell, r]));
  const issues = [];
  for (const change of changes) {
    const ref = String(change?.sheet) + "!" + String(change?.cell).trim().toUpperCase();
    const row = allowed.get(ref);
    if (!row) issues.push(ref + " 不在已确认的可写清单中");
    else if (change.value !== (row.formula ?? row.expected)) issues.push(ref + " 与确认值或公式不符");
  }
  return issues;
}

async function projectFile(ctx, relative) {
  if (!relative || path.isAbsolute(relative)) throw new Error("需要项目内的文件路径");
  const root = await fs.realpath(ctx.root);
  const absolute = await fs.realpath(path.resolve(root, relative));
  if (!absolute.startsWith(root + path.sep)) throw new Error("文件不在当前项目中");
  return absolute;
}

function python(script, file, data) {
  const tool = fileURLToPath(new URL("../services/workbook/" + script, import.meta.url));
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.PYTHON_BIN || "python3", [tool, file],
      { timeout: 100_000, maxBuffer: 16 * 1024 * 1024 }, (error, out) => {
        if (error) return reject(error);
        try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
      });
    child.stdin.on("error", error => { if (error.code !== "EPIPE") reject(error); });
    child.stdin.end(data ? JSON.stringify(data) : undefined);
  });
}

export async function disclosureInventory(ctx, selected) {
  const documents = ctx.store.listMaterials().filter(m => m.kind === "input" && /\.pdf$/i.test(m.relPath));
  const picked = selected ? documents.find(m => m.relPath === selected) : documents.length === 1 && documents[0];
  const inventory = { source: picked?.relPath || "", candidates: documents.map(m => m.relPath), sha256: "", facts: [], issues: [] };
  if (!picked) {
    inventory.issues.push(selected ? "指定公告不在项目输入中" : "请选定一份披露公告 PDF");
    return inventory;
  }
  try {
    const file = await projectFile(ctx, picked.relPath);
    const digest = async () => crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
    inventory.sha256 = await digest();
    const parsed = await python("disclosure_inventory.py", file);
    if (await digest() !== inventory.sha256) throw new Error("公告在提取期间发生变化");
    inventory.facts = parsed.facts.map(row => ({ ...row, source: picked.relPath }));
    inventory.issues = parsed.issues;
    inventory.sourceGaps = parsed.sourceGaps;
    if (!inventory.facts.length) inventory.issues.push("没有可核对的披露数值");
  } catch (error) { inventory.issues.push("公告提取失败 · " + error.message); }
  return inventory;
}

export async function disclosureVersionIssue(ctx, model) {
  if (!model?.disclosure_file) return "";
  try {
    const file = await projectFile(ctx, model.disclosure_file);
    const sha = crypto.createHash("sha256").update(await fs.readFile(file)).digest("hex");
    if (sha === model.disclosure_sha256) return "";
  } catch { /* A removed input also invalidates its confirmation. */ }
  return "已确认的公告文件已变化或不可读，请重新确认公告映射";
}

export async function mapDisclosure(ctx, inventory, modelFile, confirmed = []) {
  if (!inventory.facts.length) return { actuals: [], gaps: [] };
  try {
    const file = await projectFile(ctx, modelFile);
    const mapping = await python("map_disclosure.py", file, inventory.facts);
    // Confirmed mappings can supply a row name the automatic matcher does not
    // know. Amount, unit, period, precision and page still come from the PDF.
    const key = item => JSON.stringify([item.period, item.metric]);
    const rows = new Map(mapping.actuals.map(item => [key(item), item]));
    const facts = new Map(inventory.facts.map(item => [key(item), item]));
    const rates = await readCells(file, mapping.conversions.map(c => c.base.sheet + "!" + c.rate));
    const derivedRefs = [];
    for (const { base, cell, rate, multiplier } of mapping.conversions) {
      const ref = base.sheet + "!" + rate;
      if (!Number.isFinite(rates[ref]) || rates[ref] <= 0) continue;
      const derived = { ...base, cell, mode: "formula", metric: base.metric + " (HKD)",
        expected: base.expected * Number(multiplier) / rates[ref], decimals: 2, unit: "HKD/share",
        formula: "=" + base.cell + "*" + multiplier + "/" + rate, source: base.source + " · model FX " + ref };
      rows.set(key(derived), derived);
      derivedRefs.push(base.sheet + "!" + cell);
    }
    for (const item of normalizeActuals(confirmed)) {
      if (derivedRefs.includes(item.sheet + "!" + item.cell)) {
        const current = rows.get(key(item));
        if (current && item.formula === current.formula && item.expected === current.expected) continue;
        throw new Error("已确认的模型汇率或折算公式发生变化");
      }
      const fact = facts.get(key(item));
      if (!fact || item.expected !== fact.expected || item.unit !== fact.unit ||
          item.decimals !== fact.decimals || item.source !== fact.source + "#page=" + fact.page) {
        throw new Error("已确认映射与本次公告不符 · " + item.period + " " + item.metric);
      }
      rows.set(key(item), item);
    }
    return { gaps: mapping.gaps.filter(item => !rows.has(key(item))), actuals: normalizeActuals([...rows.values()]), derivedRefs };
  } catch (error) {
    return { actuals: [], gaps: inventory.facts.map(f => ({ ...f, reason: "无法映射工作簿 · " + error.message })) };
  }
}

// A zero-change result is a statement about the workbook. Recalculate and read
// a temporary copy so an old Excel formula cache cannot certify "no change".
export async function auditDisclosure(ctx, inventory, mapping, modelFile, recalculate) {
  const issues = [...inventory.issues];
  let rows = [], temp;
  try {
    if (!mapping.actuals.length) throw new Error("没有可验证的期间和单元格映射");
    let file = await projectFile(ctx, modelFile);
    const original = file;
    const checksum = async () => crypto.createHash("sha256").update(await fs.readFile(original)).digest("hex");
    const baseline = recalculate ? await checksum() : null;
    if (recalculate) {
      temp = await fs.mkdtemp(path.join(os.tmpdir(), "pe-disclosure-audit-"));
      file = await recalculateXlsx(file, { outDir: temp });
    }
    const refs = mapping.actuals.flatMap(item => [item.sheet + "!" + item.cell, item.sheet + "!" + item.header]);
    const values = await readCells(file, [...new Set(refs)]);
    if (baseline && baseline !== await checksum()) throw new Error("只读核对期间模型已变化，请重跑");
    const issue = actualHeaderIssue(mapping.actuals, values);
    if (issue) throw new Error(issue);
    rows = reconcileActuals(mapping.actuals, values);
  } catch (error) { issues.push(error.message); }
  finally { if (temp) await fs.rm(temp, { recursive: true, force: true }); }
  const derived = new Set(mapping.derivedRefs || []);
  const matched = rows.filter(row => row.matched && !derived.has(row.ref)).length;
  const derivedMatched = rows.filter(row => row.matched && derived.has(row.ref)).length;
  const complete = !issues.length && !inventory.sourceGaps?.length && !mapping.gaps.length && matched === inventory.facts.length &&
    matched > 0 && derivedMatched === derived.size;
  return { source: inventory.source, sha256: inventory.sha256, total: inventory.facts.length,
    mapped: mapping.actuals.length - derived.size, matched, derivedMatched, derivedRefs: [...derived], complete,
    gaps: mapping.gaps, issues, rows };
}
