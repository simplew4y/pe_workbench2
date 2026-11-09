/**
 * Workbook graph retrieval.
 *
 * The graph shape is produced by services/workbook/parse_workbook.py:
 *   doc.cells = [[id, formula|null, value, row, col, rowLabel, colLabel], ...]
 *   doc.edges = [[fromId, toId], ...]
 *
 * Retrieval is deliberately explainable: keyword + bilingual synonyms, a
 * required text hit, then a bounded upstream/downstream expansion. No
 * embedding service, no silent heuristic fallback.
 */

import fs from "node:fs";

const SYNONYMS = {
  收入: ["revenue", "sales", "turnover", "营收", "营业额"],
  营收: ["revenue", "sales", "turnover", "收入"],
  营业额: ["revenue", "sales", "turnover"],
  毛利: ["gross profit", "gross margin", "毛利"],
  毛利率: ["gross margin", "gross profit margin", "margin"],
  净利: ["net profit", "net income", "净利润"],
  净利润: ["net profit", "net income"],
  利润: ["profit", "earnings", "income"],
  利润率: ["margin", "profitability"],
  现金流: ["cash flow", "cashflow"],
  自由现金流: ["free cash flow", "fcf"],
  经营现金流: ["operating cash flow", "cfo", "cash flow from operations"],
  资本开支: ["capex", "capital expenditure", "capital expenditures"],
  估值: ["valuation", "ev", "p/e", "pe"],
  市盈率: ["p/e", "pe", "price to earnings"],
  市净率: ["p/b", "pb", "price to book"],
  股息: ["dividend", "dps"],
  负债: ["debt", "liabilities", "borrowings"],
  净资产: ["net assets", "equity", "book value"],
  增长: ["growth", "cagr", "yoy"],
  销量: ["volume", "sales volume", "units"],
  单价: ["asp", "price", "average selling price"],
  成本: ["cost", "cogs", "cost of sales"],
  费用: ["expense", "opex", "sg&a"],
  税率: ["tax rate", "tax"],
  折现: ["discount", "wacc"],
  永续: ["terminal", "perpetuity"],
  回报: ["return", "roe", "roic"],
  息税前利润: ["ebit", "operating profit"],
  息税折旧摊销前利润: ["ebitda"],
};

const STOP = new Set(["the", "and", "for", "with", "what", "which", "how", "的", "是", "了", "吗", "呢", "在"]);
const CORE_SHEETS = /consolidated|summary|dcf|valuation|results|multiples|^is$|^bs$|^cf$|p&l/;
const DETAIL_SHEETS = /product|segment|quarterly|chart|old|export|raw|data|check|template/;

function isPeriod(token) {
  return /^\d{4}$/.test(token) || /^\d{1,2}q\d{2,4}$/i.test(token) || /^\d{4}e$/i.test(token);
}

function yearOf(label) {
  const text = String(label || "");
  const full = text.match(/(19|20)\d{2}/);
  if (full) return Number(full[0]);
  const short = text.match(/(?:^|\D)(\d{2})$/);
  if (short) return 2000 + Number(short[1]);
  return 0;
}

export function tokenize(query) {
  const raw =
    String(query || "")
      .toLowerCase()
      .match(/[a-z]+(?:'[a-z]+)?|\d+(?:\.\d+)?|q\d|[\u4e00-\u9fff]+/g) || [];
  const weights = new Map();

  const add = (token, weight) => {
    if (!token || STOP.has(token)) return;
    weights.set(token, Math.max(weights.get(token) || 0, weight));
  };

  for (const token of raw) {
    if (/^[\u4e00-\u9fff]+$/.test(token)) {
      if (token.length >= 2) {
        add(token, 1);
        for (let i = 0; i + 2 <= token.length; i++) add(token.slice(i, i + 2), 0.8);
      }
    } else {
      add(token, 1);
    }
    for (const alt of SYNONYMS[token] || []) add(alt.toLowerCase(), 0.7);
    if (/^[a-z]+$/.test(token) && token.length > 3) add(token.replace(/s$/, ""), 1);
  }

  return [...weights]
    .filter(([token]) => token.length > 1 || /^\d+$/.test(token))
    .map(([token, weight]) => ({ token, weight }));
}

export function indexGraph(doc) {
  if (doc && doc.cells instanceof Map) return doc;
  if (!doc || !Array.isArray(doc.cells)) throw new Error("invalid workbook graph");

  const cells = new Map();
  // contextCells (parser v3) are layout-only cells used for exact lookups and
  // section/unit metadata; graph cells come last and override them.
  const contextRows = (doc.sheets || []).flatMap((sheet) => sheet.contextCells || []);
  for (const [i, row] of [...contextRows, ...doc.cells].entries()) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const [id, formula, value, rowNo, colNo, rowLabel, colLabel] = row;
    const contextOnly = i < contextRows.length;
    const separator = String(id).lastIndexOf("!");
    const sheet = String(id).slice(0, separator);
    const coord = String(id).slice(separator + 1);
    cells.set(id, { id, sheet, coord, formula, value, row: rowNo, col: colNo, rowLabel, colLabel, ...(contextOnly ? { contextOnly: true } : {}) });
  }

  const upstream = new Map();
  const downstream = new Map();
  for (const edge of doc.edges || []) {
    if (!Array.isArray(edge) || edge.length < 2) continue;
    const [from, to] = edge;
    if (!cells.has(from) || !cells.has(to)) continue;
    if (!upstream.has(to)) upstream.set(to, []);
    upstream.get(to).push(from);
    if (!downstream.has(from)) downstream.set(from, []);
    downstream.get(from).push(to);
  }

  const dataRows = new Set([...cells.values()].filter((cell) => typeof cell.value === "number" || cell.formula).map((cell) => `${cell.sheet}!${cell.row}`));
  return { doc, cells, upstream, downstream, dataRows };
}

function hit(haystack, needle) {
  return typeof haystack === "string" && haystack.toLowerCase().includes(needle);
}

function ratioRow(label) {
  return /^(as\s*%|%\s*of|yoy|growth|diff|change|margin|as % of|as %)/i.test(label || "");
}

function sheetWeight(sheet) {
  const name = String(sheet || "").toLowerCase();
  if (DETAIL_SHEETS.test(name)) return -2;
  if (CORE_SHEETS.test(name)) return 3;
  return 0;
}

function scoreCell(cell, tokens, queryHasRatio, queryHasValuation, periodTokens, downstream) {
  let score = 0;
  let textHit = false;
  const matched = [];

  for (const { token, weight } of tokens) {
    const row = hit(cell.rowLabel, token);
    const col = hit(cell.colLabel, token);
    if (row) matched.push(`row:${token}`);
    if (col) matched.push(`col:${token}`);

    let local = 0;
    if (row) local += (cell.rowLabel.toLowerCase() === token ? 12 : 8) * weight;
    if (col) local += (cell.colLabel.toLowerCase() === token ? 8 : 5) * weight;
    if (row && col) local *= 0.6; // do not double count "Sales / Sales"
    if ((row || col) && hit(cell.sheet, token)) local += 3 * weight;
    if (cell.formula && hit(cell.formula, token)) local += 1 * weight;

    if (row || col) textHit = true;
    score += local;
  }

  if (!textHit) return null;

  if (periodTokens.some((token) => hit(cell.colLabel, token) || hit(cell.rowLabel, token))) {
    score += 6;
  } else if (cell.colLabel) {
    // No explicit year in the query: surface the most recent column.
    const year = yearOf(cell.colLabel);
    if (year) score += Math.min(8, Math.max(0, (year - 2000) * 0.3));
  }
  if (!queryHasRatio && ratioRow(cell.rowLabel)) score -= 5;
  if (!queryHasRatio && /%|yoy|growth|diff|change|ratio|gearing/i.test(cell.rowLabel || "")) score -= 5;
  if (!queryHasValuation && /\//.test(cell.rowLabel || "")) score -= 4;
  if (/^(group|total|consolidated|overall)\b/i.test(cell.rowLabel || "")) score += 3;
  score += sheetWeight(cell.sheet);
  if (cell.formula && (downstream.get(cell.id) || []).length === 0) score += 2;

  return { score: Math.max(0, score), matched };
}

export function parseQueryAddress(query) {
  const match = String(query || "").trim().match(/^(?:(.+)!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/);
  if (!match) return null;
  const sheet = (match[1] || "").replace(/^'(.*)'$/, (_, name) => name.replace(/''/g, "'"));
  const col = (letters) => [...letters.toUpperCase()].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0);
  return { sheet, rowStart: Number(match[3]), rowEnd: Number(match[5] || match[3]), colStart: col(match[2]), colEnd: col(match[4] || match[2]) };
}

function looksLikeAddress(query) {
  const text = String(query || "").trim();
  return /(?:^|[\s,，])(?:'[^']+'|[^\s!]+)!\$?[A-Za-z]{1,3}\$?\d+/.test(text) ||
    /^\$?[A-Za-z]{1,3}\$?\d+(?::\$?[A-Za-z]{1,3}\$?\d+)?$/.test(text);
}

export function cellRole(cell, graph) {
  // A non-formula cell nobody references is a constant/label, not a model output.
  if (!cell.formula) return (graph.downstream.get(cell.id) || []).length ? "hardcoded_input" : "constant";
  if (/^=\s*(?:(?:'[^']*(?:''[^']*)*'|[^!+*/()]+)!)?\$?[A-Z]{1,3}\$?\d+\s*$/i.test(cell.formula)) return "linked";
  if (!(graph.downstream.get(cell.id) || []).length && /目标价|target price|每股价值|估值|\bEV\b/i.test([cell.rowLabel, cell.colLabel].join(" "))) return "output";
  return "formula";
}

const DISPLAY_UNIT_ALIASES = new Map([
  ['百万元', '百万元'], ['百万', '百万元'], ['rmb mn', '百万元'], ['rmb million', '百万元'], ['rmb mm', '百万元'],
  ['hkd mn', '百万元'], ['hkd million', '百万元'], ['hkd mm', '百万元'],
  ['usd mn', '百万元'], ['usd million', '百万元'], ['usd mm', '百万元'],
  ['mn', '百万元'], ['million', '百万元'], ['mm', '百万元'],
  ['亿元', '亿元'], ['亿', '亿元'], ['十亿元', '十亿元'], ['十亿', '十亿'],
]);
export function normalizeDisplayUnit(unit) {
  const raw = String(unit ?? '').trim();
  if (!raw) return 'unit_unknown';
  const key = raw.toLowerCase().replace(/\s+/g, ' ');
  return DISPLAY_UNIT_ALIASES.get(key) || raw;
}
export function cellMetadata(cell, graph) {
  const sheet = (graph.doc.sheets || []).find((item) => item.name === cell.sheet) || {};
  const context = sheet.contextCells || [];
  const left = context.filter((c) => c[3] === cell.row && c[4] < cell.col && typeof c[2] === "string").sort((a,b) => b[4]-a[4]);
  const own = typeof cell.value === "string" && !cell.formula;
  const headings = context.filter((c) => c[3] < cell.row && c[4] <= cell.col && typeof c[2] === "string" && !/^=/.test(c[2]));
  // Group headings have no numerical data in their row. Keep the nearest
  // heading at each label column, so repeated HBM labels retain their section.
  const nearest = new Map();
  for (const c of headings) {
    const rowHasData = graph.dataRows?.has(`${cell.sheet}!${c[3]}`);
    if (!rowHasData && !/^(?:%|RMB|HKD|USD|(?:FY)?\d{2,4}[EA]?|[12]H\d{2})$/i.test(c[2])) {
      const previous = nearest.get(c[4]);
      if (!previous || previous[3] < c[3]) nearest.set(c[4], c);
    }
  }
  const sectionPath = [...new Set([...nearest.values()].sort((a,b) => a[4]-b[4]).map((c) => c[2]))];
  const related = [...left, ...headings.filter((c) => c[4] === cell.col || c[4] <= 2).sort((a,b) => b[3]-a[3])];
  const unitPattern = /百万元|十亿元|十亿|亿元|万元|千元|元(?:\/股)?|(?:RMB|HKD|USD)\s*(?:mn|mm|bn|million|billion)?|%/i;
  const unit = related.map((c) => String(c[2]).match(unitPattern)?.[0]).find(Boolean) || String(cell.rowLabel || "").match(unitPattern)?.[0] || "";
  const display_unit = normalizeDisplayUnit(unit);
  const periodPattern = /(?:20\d{2}[EA]?|FY\s*\d{2,4}|[12]H\s*\d{2,4}|[1-4]Q\s*\d{2,4})/i;
  const period = headings.filter((c) => c[4] === cell.col).sort((a,b) => b[3]-a[3]).map((c) => String(c[2]).match(periodPattern)?.[0]).find(Boolean) || String(cell.colLabel || "").match(periodPattern)?.[0] || "";
  return { sectionPath, unit, display_unit, period, labelSource: own ? "own" : cell.rowLabel || left.length ? "inherited" : "none", role: cellRole(cell, graph) };
}

function findSheet(graph, query) {
  const wanted = String(query || "").trim().toLowerCase();
  if (!wanted) return null;
  return (graph.doc.sheets || []).find((sheet) => sheet.name.toLowerCase() === wanted) || null;
}

export function queryGraph(input, query, options = {}) {
  const graph = indexGraph(input);
  const requestedCells = Number(options.maxCells);
  const requestedChars = Number(options.maxChars);
  const maxCells = Number.isFinite(requestedCells)
    ? Math.max(1, Math.min(requestedCells, 120))
    : 40;
  const maxChars = Number.isFinite(requestedChars)
    ? Math.max(1000, Math.min(requestedChars, 30000))
    : 9000;
  const tokens = tokenize(query);
  const periodTokens = tokens.filter(({ token }) => isPeriod(token)).map(({ token }) => token);
  const queryHasRatio = tokens.some(({ token }) => /%|yoy|growth|margin|ratio|率/.test(token));
  const queryHasValuation = tokens.some(({ token }) =>
    /^(valuation|multiple|ev|p\/e|pe|估值|市盈率)$/.test(token),
  );
  const address = parseQueryAddress(query);
  const requestedSheet = options.sheet ? findSheet(graph, options.sheet) : null;
  const availableSheets = (graph.doc.sheets || []).map((sheet) => sheet.name);
  const addressSheet = address?.sheet ? findSheet(graph, address.sheet) : null;
  const explicit = Boolean(address || options.sheet);
  const exactCells = address ? [...graph.cells.values()].filter((cell) =>
    (!address.sheet || cell.sheet === addressSheet?.name) && (!options.sheet || cell.sheet === requestedSheet?.name) && cell.row >= Math.min(address.rowStart,address.rowEnd) && cell.row <= Math.max(address.rowStart,address.rowEnd) && cell.col >= Math.min(address.colStart,address.colEnd) && cell.col <= Math.max(address.colStart,address.colEnd)) : [];
  const missingSheet = (address?.sheet && !addressSheet) ? address.sheet : options.sheet && !requestedSheet ? options.sheet : null;
  const error = missingSheet ? `未找到工作表 ${missingSheet}` : address && !exactCells.length ? `未找到单元格 ${query}` : null;
  const exactIds = new Set(exactCells.map((cell) => cell.id));
  const direct = address && !error;
  // A query that mentions an exact address but is not a pure address query
  // (e.g. "收入 Discount PE!H33") may still return keyword hits. Those are
  // degraded: never present them as a direct/exact hit. The same applies when
  // an in-sheet address misses but its labels still match keyword tokens.
  const addressHint = !address && looksLikeAddress(query);
  const fallbackAddress = Boolean(address && !direct && !missingSheet);


  const scored = [];
  for (const cell of graph.cells.values()) {
    if (error && !fallbackAddress) continue;
    if (requestedSheet && cell.sheet !== requestedSheet.name) continue;
    if (fallbackAddress && addressSheet && cell.sheet !== addressSheet.name) continue;
    if (direct && !exactIds.has(cell.id)) continue;
    // Keyword search keeps the pre-v3 candidate set (graph cells only).
    if (!direct && cell.contextOnly) continue;
    const result = direct
      ? { score: 100, matched: ["direct"] }
      : scoreCell(cell, tokens, queryHasRatio, queryHasValuation, periodTokens, graph.downstream);
    if (result) scored.push({ cell, ...result });
  }

  if (!scored.length && !explicit) {
    const sheet = findSheet(graph, query);
    if (sheet) {
      for (const cell of graph.cells.values()) {
        if (cell.sheet !== sheet.name || !cell.formula) continue;
        if ((graph.downstream.get(cell.id) || []).length > 0) continue;
        scored.push({ cell, score: 5, matched: ["sheet"] });
      }
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const seeds = scored.slice(0, Math.min(direct ? exactCells.length : 12, maxCells));
  const selected = new Map();
  const queue = [];
  for (const seed of seeds) {
    selected.set(seed.cell.id, { cell: seed.cell, score: seed.score, distance: 0, via: "seed" });
    queue.push({ id: seed.cell.id, distance: 0 });
  }

  while (queue.length && selected.size < maxCells) {
    const { id, distance } = queue.shift();
    if (distance >= 2) continue;
    const up = (graph.upstream.get(id) || []).slice(0, 3);
    const down = (graph.downstream.get(id) || []).slice(0, 2);
    for (const [via, list] of [
      ["up", up],
      ["down", down],
    ]) {
      for (const next of list) {
        if (selected.size >= maxCells) break;
        if (selected.has(next)) continue;
        const nextCell = graph.cells.get(next);
        // Skip unlabeled helper cells (date serials, flags); they add noise.
        if (!nextCell.rowLabel && !nextCell.colLabel && !nextCell.formula) continue;
        selected.set(next, {
          cell: nextCell,
          score: 0,
          distance: distance + 1,
          via,
        });
        queue.push({ id: next, distance: distance + 1 });
      }
    }
  }

  const rows = [...selected.values()]
    .sort((a, b) => b.score - a.score || a.distance - b.distance)
    .map((item) => {
      const cell = item.cell;
      const upstreamRefs = graph.upstream.get(cell.id) || [];
      const downstreamRefs = graph.downstream.get(cell.id) || [];
      return {
        ...cellMetadata(cell, graph),
        id: cell.id,
        ref: cell.id,
        label: [cell.rowLabel, cell.colLabel].filter(Boolean).join(" / "),
        displayLabel: [cell.rowLabel, cell.colLabel].filter(Boolean).join(" / "),
        rowLabel: cell.rowLabel || "",
        columnLabel: cell.colLabel || "",
        formula: cell.formula ? cell.formula.slice(0, 300) : null,
        value: cell.value,
        display: displayValue(cell.value),
        sheet: cell.sheet,
        coord: cell.coord,
        distance: item.distance,
        via: item.via,
        relation: item.distance === 0 ? "seed" : item.via === "up" ? "upstream" : "downstream",
        matchType: item.distance === 0 ? (direct ? "direct" : "keyword") : (item.via || "related"),
        exact: Boolean(direct && item.distance === 0),
        score: item.score,
        upstream: upstreamRefs.length,
        downstream: downstreamRefs.length,
        upstreamRefs,
        downstreamRefs,
      };
    });

  const kept = [];
  let chars = 0;
  for (const row of rows) {
    const size = JSON.stringify(row).length;
    if (kept.length && chars + size > maxChars) break;
    kept.push(row);
    chars += size;
  }

  const truncated = kept.length < rows.length || scored.length > seeds.length;
  const sheetsSearched = missingSheet ? [] : addressSheet ? [addressSheet.name] : requestedSheet ? [requestedSheet.name] : availableSheets;
  const namedSheet = address?.sheet || (options.sheet ? String(options.sheet) : null);
  const namedSheetsOk = !namedSheet || sheetsSearched.some((name) => name.toLowerCase() === namedSheet.toLowerCase());
  const degraded = Boolean((addressHint || fallbackAddress) && kept.length);
  const miss = Boolean(error) || kept.length === 0;
  const missReason = miss ? (error || "没有匹配到任何标签、Sheet 名或公式") : null;
  return {
    ...(error ? { isError: true, error, availableSheets } : {}),
    miss,
    missReason,
    degraded,
    direct: Boolean(direct),
    exact: Boolean(direct && !degraded),
    coverage: { sheetsSearched, namedSheetsOk, miss, missReason, degraded, truncated, matchedCount: scored.length, returnedCount: kept.length, complete: !truncated && !(graph.doc.warnings || []).length && sheetsSearched.length === availableSheets.length,
      note: "未命中只代表本次解析和检索覆盖范围；覆盖不完整时不能证明不存在。" },
    query,
    tokens: tokens.map(({ token }) => token),
    matchedCells: scored.length,
    seeds: seeds.map((seed) => seed.cell.id),
    returned: kept.length,
    truncated,
    cells: kept,
    warnings: (graph.doc.warnings || []).slice(0, 5),
    stats: graph.doc.stats,
    sheets: (graph.doc.sheets || []).map((sheet) => ({
      name: sheet.name,
      formulas: sheet.formulaCount,
      rows: sheet.rows,
      cols: sheet.cols,
    })),
  };
}

export function summarizeGraph(input) {
  const graph = indexGraph(input);
  const doc = graph.doc;
  const outputs = (doc.outputs || []).slice(0, 20).map((id) => {
    const cell = graph.cells.get(id);
    return {
      ...(cell ? cellMetadata(cell, graph) : { role: "output" }),
      id,
      label: cell ? [cell.rowLabel, cell.colLabel].filter(Boolean).join(" / ") : "",
      formula: cell?.formula || null,
      value: cell?.value ?? null,
    };
  });

  return {
    schemaVersion: doc.schemaVersion,
    parserVersion: doc.parserVersion,
    fileName: doc.fileName,
    fileSha256: doc.fileSha256,
    parsedAt: doc.parsedAt,
    stats: doc.stats,
    warnings: (doc.warnings || []).slice(0, 5),
    sheets: (doc.sheets || []).map((sheet) => ({
      name: sheet.name,
      rows: sheet.rows,
      cols: sheet.cols,
      formulas: sheet.formulaCount,
      rowLabels: Object.keys(sheet.rowLabels || {}).length,
      colLabels: Object.keys(sheet.colLabels || {}).length,
    })),
    metadataFacts: [...graph.cells.values()].filter((cell) => /cover|metadata|元数据|封面|基本信息/i.test(cell.sheet)).map((cell) => ({ ...cellMetadata(cell, graph), ref: cell.id, label: cell.rowLabel || "", value: cell.value })),
    outputs,
  };
}

export function displayValue(value) {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return Number(value.toFixed(4)).toLocaleString("en-US");
  }
  const text = String(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

export function formatResult(result, options = {}) {
  const limit = Math.max(1, Math.min(options.maxCells || result.cells.length, 120));
  const maxChars = Math.max(1000, Math.min(options.maxChars || 9000, 30000));
  const lines = [];

  if (result.miss) lines.push(`未找到：${result.missReason || result.error || "本次查询没有命中"}`);
  lines.push(`查询：${result.query}`);
  if (result.coverage) lines.push(`覆盖：${result.coverage.sheetsSearched.join("、")}；匹配 ${result.coverage.matchedCount}，返回 ${result.coverage.returnedCount}；截断=${result.coverage.truncated}。${result.coverage.note}`);
  if (result.miss) {
    lines.push(`已检索工作表：${result.coverage?.sheetsSearched?.join("、") || "无"}`);
    if (!result.cells?.length) {
      if (result.availableSheets?.length) lines.push(`可用工作表：${result.availableSheets.join("、")}`);
      return lines.join("\n");
    }
  }
  if (result.degraded) lines.push("降级：精确地址未命中，以下为关键词结果，不能当精确命中；请改用纯 Sheet!A1 查询。");
  if (!result.matchedCells) {
    lines.push("没有匹配到任何标签、Sheet 名或公式。");
    lines.push("可以换一个关键词，或直接用 Sheet!A1 指定单元格。");
    return lines.join("\n");
  }

  lines.push(
    `候选 ${result.matchedCells} 个单元格，返回相关子图 ${Math.min(result.returned, limit)} 个。` +
      "数值为工作簿缓存值，可能不是最新；以单元格引用为准。",
  );
  if (result.warnings?.length) {
    lines.push(
      `注意：${result.warnings[0]}` +
        (result.warnings.length > 1 ? `（另有 ${result.warnings.length - 1} 条降级提示）` : ""),
    );
  }

  let used = lines.join("\n").length;
  let textReturnedCount = 0;
  for (const cell of result.cells.slice(0, limit)) {
    const via = cell.distance === 0 ? "命中" : cell.via === "up" ? "上游" : "下游";
    const formula = cell.formula ? cell.formula.replace(/\s+/g, " ").slice(0, 180) : `无公式（${cell.role || "角色未定"}）`;
    const line = `- [${via}] ${cell.id} · ${cell.label || "—"} · ${formula} · ${displayValue(cell.value)} · 角色 ${cell.role || "角色未定"} · 区块 ${cell.sectionPath?.join(" / ") || "—"} · 单位 ${cell.display_unit || "unit_unknown"} · 期间 ${cell.period || "未标注"} · 标签 ${cell.labelSource}`;
    if (used + line.length > maxChars) {
      lines.push("（结果已截断，可缩小 query 或指定 Sheet!A1）");
      break;
    }
    lines.push(line);
    used += line.length + 1;
    textReturnedCount += 1;
  }

  if (result.coverage) {
    result.coverage.textReturnedCount = textReturnedCount;
    result.coverage.textTruncated = textReturnedCount < result.cells.length;
    if (result.coverage.textTruncated) {
      result.coverage.truncated = true;
      result.coverage.complete = false;
      result.truncated = true;
      if (lines[1]?.startsWith("覆盖：")) lines[1] = lines[1].replace("截断=false", "截断=true");
      lines.push(`文本仅展示 ${textReturnedCount}/${result.cells.length} 格，已截断；不能据此证明不存在。`);
    }
  }
  return lines.join("\n");
}

export function loadGraphFile(file) {
  return indexGraph(JSON.parse(fs.readFileSync(file, "utf8")));
}

function main() {
  const args = process.argv.slice(2);
  const file = args[0];
  const query = args[1];
  if (!file || !query) {
    console.error('usage: node lib/workbook-query.mjs <graph.json> "query" [--max-cells 40] [--json]');
    process.exit(1);
  }
  const maxCellsIndex = args.indexOf("--max-cells");
  const maxCells = maxCellsIndex > -1 ? Number(args[maxCellsIndex + 1]) : 40;
  const asJson = args.includes("--json");
  const graph = loadGraphFile(file);
  const result = queryGraph(graph, query, { maxCells });
  console.log(asJson ? JSON.stringify(result, null, 2) : formatResult(result));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
