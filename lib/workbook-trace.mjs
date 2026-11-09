/**
 * Workbook formula-chain tracing (read-only).
 *
 * `workbook_query` is a semantic/keyword lookup and can miss a synthetic target
 * price cell. This module works on the parsed formula graph instead:
 *
 * - inspect one `Sheet!A1` cell or an explicit rectangle;
 * - walk upstream from an output cell for N layers;
 * - enumerate a sheet's row range for a human-style SOTP scan.
 *
 * Values are the cached values stored in the workbook. They may be stale; call
 * out that Excel/LibreOffice must recalculate before relying on them.
 */

import { displayValue, indexGraph, cellRole, cellMetadata } from "./workbook-query.mjs";

export const TRACE_DEFAULT_DEPTH = 5;
export const TRACE_MAX_DEPTH = 15;
export const TRACE_DEFAULT_MAX_CELLS = 200;
export const TRACE_MAX_CELLS = 500;
export const TRACE_MAX_ROWS = 1000;
export const TRACE_MAX_CHILDREN = 20;
export const TRACE_MAX_CHARS = 16000;

const A1_RE = /^(?:(.+?)!)?\$?([A-Za-z]{1,3})\$?(\d+)(?::\$?([A-Za-z]{1,3})\$?(\d+))?$/;

export function columnToNumber(letters) {
  let value = 0;
  for (const char of String(letters || "").toUpperCase()) {
    const code = char.charCodeAt(0) - 64;
    if (code < 1 || code > 26) throw new Error(`列名不合法：${letters}`);
    value = value * 26 + code;
  }
  return value;
}

export function numberToColumn(value) {
  let number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`列号不合法：${value}`);
  let out = "";
  while (number > 0) {
    const remainder = (number - 1) % 26;
    out = String.fromCharCode(65 + remainder) + out;
    number = Math.floor((number - 1) / 26);
  }
  return out;
}

function unquoteSheet(value) {
  const text = String(value || "").trim();
  if (text.startsWith("'") && text.endsWith("'") && text.length >= 2) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

/** Parse `Sheet!A1` or `Sheet!B2:D10` (sheet is optional). */
export function parseCellRef(input) {
  const text = String(input || "").trim();
  const match = text.match(A1_RE);
  if (!match) return null;
  const sheet = match[1] ? unquoteSheet(match[1]) : "";
  const startCol = columnToNumber(match[2]);
  const startRow = Number(match[3]);
  const endCol = match[4] ? columnToNumber(match[4]) : startCol;
  const endRow = match[5] ? Number(match[5]) : startRow;
  if (!Number.isInteger(startRow) || startRow < 1 || !Number.isInteger(endRow) || endRow < 1) {
    return null;
  }
  return {
    sheet,
    start: { row: startRow, col: startCol, coord: `${numberToColumn(startCol)}${startRow}` },
    end: { row: endRow, col: endCol, coord: `${numberToColumn(endCol)}${endRow}` },
    range: startRow !== endRow || startCol !== endCol,
  };
}

function graphSheets(graph) {
  return new Set([...graph.cells.values()].map((cell) => cell.sheet));
}

export function resolveCell(graph, input) {
  const parsed = typeof input === "string" ? parseCellRef(input) : input;
  if (!parsed) return { cell: null, parsed: null, reason: `无法解析单元格引用：${input || "（空）"}` };
  if (parsed.range) return { cell: null, parsed, reason: "这是区域引用，请使用区域枚举" };

  if (parsed.sheet) {
    const cell = graph.cells.get(`${parsed.sheet}!${parsed.start.coord}`);
    if (cell) return { cell, parsed, reason: "" };
    if (!graphSheets(graph).has(parsed.sheet)) {
      return { cell: null, parsed, reason: `工作表不存在：${parsed.sheet}` };
    }
    return {
      cell: null,
      parsed,
      reason: `${parsed.sheet}!${parsed.start.coord} 不在解析图中：可能为空单元格，或没有被任何公式引用`,
    };
  }

  const matches = [];
  for (const cell of graph.cells.values()) {
    if (cell.coord === parsed.start.coord) matches.push(cell);
  }
  if (matches.length === 1) return { cell: matches[0], parsed, reason: "" };
  if (matches.length === 0) {
    return {
      cell: null,
      parsed,
      reason: `${parsed.start.coord} 在解析图中不存在：可能为空单元格，或被引用的工作表里没有该位置`,
    };
  }
  return {
    cell: null,
    parsed,
    reason: `${parsed.start.coord} 在多个工作表中存在（${matches.map((cell) => cell.sheet).join("、")}），请写成 Sheet!A1`,
  };
}

function cacheStatus(cell) {
  if (!cell.formula) return "input";
  if (cell.value === null || cell.value === undefined) return "missing";
  if (typeof cell.value === "string" && cell.value.startsWith("=")) return "missing";
  return "cached";
}

export function summarizeCell(cell, graph, { dependencies = true } = {}) {
  const upstreamAll = dependencies ? [...(graph.upstream.get(cell.id) || [])] : [];
  const downstreamAll = dependencies ? [...(graph.downstream.get(cell.id) || [])] : [];
  return {
    ...cellMetadata(cell, graph),
    ref: cell.id,
    sheet: cell.sheet,
    coord: cell.coord,
    row: cell.row,
    col: cell.col,
    rowLabel: cell.rowLabel || "",
    columnLabel: cell.colLabel || "",
    label: [cell.rowLabel, cell.colLabel].filter(Boolean).join(" / "),
    formula: cell.formula || null,
    value: cell.value ?? null,
    display: displayValue(cell.value),
    cacheStatus: cacheStatus(cell),
    upstreamRefs: upstreamAll.slice(0, 100),
    upstreamCount: upstreamAll.length,
    downstreamRefs: downstreamAll.slice(0, 100),
    downstreamCount: downstreamAll.length,
  };
}

function emptyCell(sheet, row, col) {
  const coord = `${numberToColumn(col)}${row}`;
  return {
    ref: `${sheet}!${coord}`,
    sheet,
    coord,
    row,
    col,
    rowLabel: "",
    columnLabel: "",
    label: "",
    formula: null,
    value: null,
    display: "—",
    cacheStatus: "empty",
    role: "output",
    upstreamRefs: [],
    upstreamCount: 0,
    downstreamRefs: [],
    downstreamCount: 0,
    empty: true,
  };
}

function clampDepth(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return TRACE_DEFAULT_DEPTH;
  return Math.max(0, Math.min(Math.trunc(number), TRACE_MAX_DEPTH));
}

function clampMaxCells(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return TRACE_DEFAULT_MAX_CELLS;
  return Math.max(1, Math.min(Math.trunc(number), TRACE_MAX_CELLS));
}

export function buildUpstreamTree(graph, cell, options = {}) {
  const depth = clampDepth(options.depth);
  const maxNodes = clampMaxCells(options.maxNodes ?? TRACE_DEFAULT_MAX_CELLS);
  const expanded = new Set();
  let nodes = 0;
  let truncated = false;

  const walk = (current, level, pathSet) => {
    nodes += 1;
    const summary = summarizeCell(current, graph, { dependencies: true });
    const node = { ...summary, depth: level, children: [], truncated: false };

    if (level >= depth) {
      if ((graph.upstream.get(current.id) || []).length > 0) {
        node.truncated = true;
        node.omitted = "达到 depth 上限，未继续展开";
      }
      return node;
    }
    if (pathSet.has(current.id)) {
      node.cycle = true;
      node.omitted = "检测到循环引用，停止展开";
      return node;
    }
    if (expanded.has(current.id)) {
      node.repeated = true;
      node.omitted = "该节点已在其他分支展开，避免重复";
      return node;
    }
    expanded.add(current.id);

    const upstream = [...(graph.upstream.get(current.id) || [])];
    const children = upstream.slice(0, TRACE_MAX_CHILDREN);
    if (children.length < upstream.length) {
      node.childrenTruncated = true;
      node.omittedChildren = upstream.length - children.length;
    }
    const nextPath = new Set(pathSet);
    nextPath.add(current.id);
    for (const id of children) {
      if (nodes >= maxNodes) {
        truncated = true;
        node.truncated = true;
        node.omitted = "达到返回单元格上限，未继续展开";
        break;
      }
      const dependency = graph.cells.get(id);
      if (!dependency) continue;
      node.children.push(walk(dependency, level + 1, nextPath));
    }
    return node;
  };

  const tree = walk(cell, 0, new Set());
  return { tree, depth, nodes, truncated };
}

function rangeResult(graph, parsed, maxCells) {
  const sheet = parsed.sheet;
  if (!sheet) throw new Error("区域引用必须带工作表名，例如 Model!B2:D10");
  if (!graphSheets(graph).has(sheet)) throw new Error(`工作表不存在：${sheet}`);

  const rowStart = Math.min(parsed.start.row, parsed.end.row);
  const rowEnd = Math.max(parsed.start.row, parsed.end.row);
  const colStart = Math.min(parsed.start.col, parsed.end.col);
  const colEnd = Math.max(parsed.start.col, parsed.end.col);
  const requested = (rowEnd - rowStart + 1) * (colEnd - colStart + 1);
  const cells = [];
  let truncated = false;

  for (let row = rowStart; row <= rowEnd && !truncated; row += 1) {
    for (let col = colStart; col <= colEnd; col += 1) {
      if (cells.length >= maxCells) {
        truncated = true;
        break;
      }
      const cell = graph.cells.get(`${sheet}!${numberToColumn(col)}${row}`);
      cells.push(cell ? summarizeCell(cell, graph) : emptyCell(sheet, row, col));
    }
  }

  return {
    mode: "range",
    sheet,
    range: `${sheet}!${numberToColumn(colStart)}${rowStart}:${numberToColumn(colEnd)}${rowEnd}`,
    rowStart,
    rowEnd,
    colStart,
    colEnd,
    requested,
    returned: cells.length,
    truncated,
    cells,
  };
}

function rowsResult(graph, options, maxCells) {
  const sheet = String(options.sheet || "").trim();
  if (!sheet) throw new Error("按行枚举需要 sheet，例如 sheet=\"Model\", rows=\"5-40\"");
  const meta = (graph.doc.sheets || []).find((item) => item.name === sheet);
  if (!meta && !graphSheets(graph).has(sheet)) throw new Error(`工作表不存在：${sheet}`);

  let rowStart = Number(options.rowStart);
  let rowEnd = Number(options.rowEnd);
  const rowsSpec = String(options.rows || "").trim();
  if (rowsSpec) {
    const match = rowsSpec.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error(`rows 格式应为 "5" 或 "5-40"（收到 ${rowsSpec}）`);
    rowStart = Number(match[1]);
    rowEnd = match[2] ? Number(match[2]) : Number(match[1]);
  }
  if (!Number.isFinite(rowStart) || !Number.isFinite(rowEnd)) {
    throw new Error("按行枚举需要 rows 或 rowStart/rowEnd，例如 rows=\"5-40\"");
  }
  if (!Number.isInteger(rowStart) || !Number.isInteger(rowEnd) || rowStart < 1 || rowEnd < 1) {
    throw new Error("行号必须是 ≥1 的整数");
  }

  const notes = [];
  if (rowStart > rowEnd) [rowStart, rowEnd] = [rowEnd, rowStart];
  if (meta?.rows && rowEnd > meta.rows) {
    notes.push(`请求到第 ${rowEnd} 行，工作表只有 ${meta.rows} 行；已按实际范围处理`);
    rowEnd = meta.rows;
  }
  if (rowEnd - rowStart + 1 > TRACE_MAX_ROWS) {
    const requestedEnd = rowEnd;
    rowEnd = rowStart + TRACE_MAX_ROWS - 1;
    notes.push(`行范围超过硬上限 ${TRACE_MAX_ROWS} 行（请求到 ${requestedEnd}），已截断`);
  }
  if (rowStart > rowEnd) {
    return {
      mode: "rows",
      sheet,
      rowStart,
      rowEnd,
      returned: 0,
      truncated: false,
      cells: [],
      notes,
    };
  }

  const cells = [];
  let truncated = false;
  for (let row = rowStart; row <= rowEnd && !truncated; row += 1) {
    const rowCells = [...graph.cells.values()]
      .filter((cell) => cell.sheet === sheet && cell.row === row)
      .sort((a, b) => a.col - b.col);
    for (const cell of rowCells) {
      if (cells.length >= maxCells) {
        truncated = true;
        break;
      }
      cells.push(summarizeCell(cell, graph));
    }
  }
  if (truncated) notes.push(`返回单元格达到上限 ${maxCells}，后面的行未展开`);

  return {
    mode: "rows",
    sheet,
    rowStart,
    rowEnd,
    returned: cells.length,
    truncated,
    cells,
    notes,
  };
}

function graphCoverage(graph) {
  return { formulaCount: [...graph.cells.values()].filter((cell) => cell.formula).length,
    cellCount: graph.cells.size, edgeCount: (graph.doc.edges || []).length,
    sheets: (graph.doc.sheets || []).map((sheet) => sheet.name),
    warnings: graph.doc.warnings || [], note: "可达性仅覆盖已解析公式；未解析公式、外部链接和动态引用可能造成断链。" };
}

function downstreamResult(graph, options, maxCells) {
  const from = resolveCell(graph, options.mode === "path" ? options.from : options.cell);
  const to = options.mode === "path" ? resolveCell(graph, options.to) : null;
  if (!from.cell || (to && !to.cell)) throw new Error(from.reason || to.reason);
  const coverage = graphCoverage(graph);
  // Traverse the entire parsed graph for honest counts, then limit the payload.
  const queue = [from.cell.id], distance = new Map([[from.cell.id, 0]]), previous = new Map();
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    for (const next of graph.downstream.get(id) || []) {
      if (distance.has(next)) continue;
      distance.set(next, distance.get(id) + 1); previous.set(next, id); queue.push(next);
    }
  }
  if (to) {
    const reachable = distance.has(to.cell.id);
    const ids = [];
    if (reachable) { for (let id = to.cell.id; id; id = previous.get(id)) { ids.push(id); if (id === from.cell.id) break; } ids.reverse(); }
    const truncated = ids.length > maxCells;
    return { mode: "path", from: from.cell.id, to: to.cell.id, reachable, coverage, shortestLength: reachable ? ids.length - 1 : null,
      paths: reachable ? [ids.slice(0,maxCells).map((id) => summarizeCell(graph.cells.get(id),graph))] : [], truncated,
      notes: reachable ? truncated ? ["最短路径超过返回上限，已截断；请提高 maxCells。"] : [] : [`不可达（在已解析的 ${coverage.formulaCount} 个公式内）`] };
  }
  const depth = options.depth === undefined ? Infinity : clampDepth(options.depth);
  const all = queue.slice(1), eligible = all.filter((id) => distance.get(id) <= depth), kept = eligible.slice(0,maxCells);
  const cells = kept.map((id) => ({ ...summarizeCell(graph.cells.get(id),graph), depth: distance.get(id) }));
  const outputIds = all.filter((id) => { const cell = graph.cells.get(id); return !(graph.downstream.get(id) || []).length || /目标价|target price|每股价值|估值|\bEV\b/i.test([cell.rowLabel,cell.colLabel].join(" ")); });
  return { mode: "impact", ref: from.cell.id, coverage, totalDownstream: all.length, withinDepth: eligible.length, returned: cells.length,
    truncated: kept.length < all.length, depth: Number.isFinite(depth) ? depth : null, cells,
    outputs: outputIds.filter((id) => kept.includes(id)).map((id) => summarizeCell(graph.cells.get(id),graph)), reachedOutputCount: outputIds.length,
    notes: ["影响集表示公式依赖可达，不保证数值变化；数值敏感性请用 model_whatif。"] };
}

/**
 * Main entry. Options:
 *   cell                  Sheet!A1 or Sheet!B2:D10
 *   sheet/rows            e.g. sheet="Model", rows="5-40"
 *   depth                 default 5, hard max 15
 *   maxCells              default 200, hard max 500
 *   includeDirect         default true (single-cell mode)
 */
export function traceGraph(input, options = {}) {
  const graph = indexGraph(input);
  const depth = clampDepth(options.depth);
  const maxCells = clampMaxCells(options.maxCells);
  if (["path", "impact"].includes(options.mode)) return downstreamResult(graph, options, maxCells);
  const cellInput = String(options.cell || "").trim();
  const notes = [];

  if (cellInput) {
    const parsed = parseCellRef(cellInput);
    if (!parsed) throw new Error(`无法解析单元格引用：${cellInput}`);
    if (parsed.range) {
      return { ...rangeResult(graph, parsed, maxCells), depth, maxCells, notes };
    }
    const resolved = resolveCell(graph, parsed);
    if (!resolved.cell) {
      return {
        mode: "cell",
        ref: parsed.sheet ? `${parsed.sheet}!${parsed.start.coord}` : parsed.start.coord,
        target: null,
        direct: [],
        tree: null,
        depth,
        maxCells,
        notes: [resolved.reason],
        truncated: false,
      };
    }
    const treeResult = buildUpstreamTree(graph, resolved.cell, { depth, maxNodes: maxCells });
    const allDirect = (graph.upstream.get(resolved.cell.id) || [])
      .map((id) => graph.cells.get(id))
      .filter(Boolean);
    const direct = allDirect.slice(0, maxCells).map((cell) => summarizeCell(cell, graph));
    if (treeResult.truncated) notes.push("上游树达到返回单元格上限，已截断");
    if (allDirect.length > direct.length) {
      notes.push(`直接上游共 ${allDirect.length} 个，只返回前 ${direct.length} 个`);
    }
    return {
      mode: "cell",
      ref: resolved.cell.id,
      target: summarizeCell(resolved.cell, graph),
      direct,
      tree: treeResult.tree,
      depth,
      maxCells,
      nodes: treeResult.nodes,
      truncated: treeResult.truncated,
      notes,
    };
  }

  if (options.sheet) {
    const result = rowsResult(graph, options, maxCells);
    return { ...result, depth, maxCells, notes: [...result.notes, ...notes] };
  }

  throw new Error("需要 cell=\"Sheet!A1\"，或 sheet + rows=\"起-止\" 来枚举行范围");
}

function formulaText(cell) {
  if (!cell.formula) return `无公式（${cell.role || "角色未定"}）`;
  return cell.formula.replace(/\s+/g, " ").slice(0, 220);
}

function cacheText(cell) {
  if (cell.cacheStatus === "input") return `常量值 ${cell.display}`;
  if (cell.cacheStatus === "missing") return `缓存值缺失（当前显示公式文本）`;
  if (cell.cacheStatus === "empty") return "空 / 未在解析图中";
  return `缓存值 ${cell.display}`;
}

function lineFor(cell, prefix = "-") {
  const label = cell.label ? ` · ${cell.label}` : "";
  const deps = cell.upstreamRefs?.length
    ? ` · ↑ ${cell.upstreamRefs.slice(0, 6).join("、")}${(cell.upstreamCount || cell.upstreamRefs.length) > 6 ? ` 等 ${cell.upstreamCount || cell.upstreamRefs.length} 个` : ""}`
    : "";
  return `${prefix} ${cell.ref}${label} · 角色 ${cell.role || "角色未定"} · ${formulaText(cell)} · ${cacheText(cell)}${deps}`;
}

function treeLines(node, level, lines) {
  const indent = "  ".repeat(level);
  let marker = level === 0 ? "●" : "└";
  if (node.cycle) marker = "↺";
  lines.push(`${indent}${marker} ${lineFor(node, "").trim()}`);
  if (node.omitted) lines.push(`${indent}  （${node.omitted}）`);
  for (const child of node.children || []) treeLines(child, level + 1, lines);
}

export function formatTrace(result, options = {}) {
  const maxChars = Math.max(1000, Math.min(Number(options.maxChars) || TRACE_MAX_CHARS, TRACE_MAX_CHARS));
  const lines = [];
  const pathLabel = result.path ? ` ${result.path}` : "";
  lines.push(`追踪${pathLabel}`);
  lines.push("数值为工作簿缓存值，可能不是最新；以 Excel/LibreOffice 重算为准。");

  if (result.warnings?.length) {
    lines.push(`注意：${result.warnings[0]}` + (result.warnings.length > 1 ? `（另有 ${result.warnings.length - 1} 条解析提示）` : ""));
  }

  if (result.mode === "path") {
    lines.push(`路径：${result.from} → ${result.to}`);
    lines.push(`覆盖 ${result.coverage.formulaCount} 个公式、${result.coverage.edgeCount} 条边。${result.coverage.note}`);
    if (result.reachable) for (const cell of result.paths[0]) lines.push(lineFor(cell));
  } else if (result.mode === "impact") {
    lines.push(`影响集：${result.ref}；下游共 ${result.totalDownstream} 格，返回 ${result.returned} 格；截断=${result.truncated}`);
    lines.push(`触达估值/终端输出 ${result.reachedOutputCount} 格；本次展示：${result.outputs.map((cell) => cell.ref).join("、")}`);
    lines.push(result.coverage.note);
    for (const cell of result.cells) lines.push(lineFor(cell));
  } else if (result.mode === "cell") {
    if (!result.target) {
      lines.push(`目标：${result.ref} —— 未找到`);
      for (const note of result.notes || []) lines.push(`- ${note}`);
    } else {
      lines.push(`目标：${result.target.ref} · ${result.target.label || "—"}`);
      lines.push(`公式：${formulaText(result.target)}`);
      lines.push(cacheText(result.target));
      if (result.target.cacheStatus === "missing") {
        lines.push("（该格没有缓存计算结果；value/display 是公式文本，需要重算后才能核对数字。）");
      }
      lines.push(`直接上游（${result.direct.length}）：`);
      if (!result.direct.length) {
        lines.push("- 无直接依赖（输入值或断链）");
      } else {
        for (const cell of result.direct) lines.push(`- ${cell.ref} · ${cell.label || "—"} · ${formulaText(cell)} · ${cacheText(cell)}`);
      }
      lines.push(`上游树（depth=${result.depth}，节点 ${result.nodes ?? "?"}）：`);
      if (result.tree) treeLines(result.tree, 0, lines);
      if (result.truncated) lines.push("（上游树已截断；可减小 depth 或指定更靠近输出的格。）");
    }
  } else if (result.mode === "range") {
    lines.push(`区域：${result.range}（请求 ${result.requested} 格，返回 ${result.returned} 格，上限 ${result.maxCells}）`);
    for (const cell of result.cells) lines.push(lineFor(cell));
    if (result.truncated) lines.push("（区域超过返回上限，已截断；请缩小范围。）");
  } else if (result.mode === "rows") {
    lines.push(`行枚举：${result.sheet} 第 ${result.rowStart}-${result.rowEnd} 行（返回 ${result.returned} 格，上限 ${result.maxCells}）`);
    for (const cell of result.cells) lines.push(lineFor(cell));
    for (const note of result.notes || []) lines.push(`- ${note}`);
    if (result.truncated) lines.push("（返回单元格达到上限，已截断；请缩小行范围。）");
  }

  for (const note of result.notes || []) {
    const line = `- ${note}`;
    if (!lines.includes(line)) lines.push(line);
  }

  const text = lines.join("\n");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 30)}\n…（输出已截断，请缩小范围）`;
}

export default traceGraph;
