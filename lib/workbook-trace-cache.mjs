import { TRACE_DEFAULT_DEPTH, TRACE_DEFAULT_MAX_CELLS, TRACE_MAX_CELLS, traceGraph } from "./workbook-trace.mjs";

const cacheByGraph = new WeakMap();

function rowRange(options) {
  if (options.cell || !options.sheet || ["impact", "path"].includes(options.mode)) return null;
  const match = /^\s*(\d+)(?:\s*-\s*(\d+))?\s*$/.exec(options.rows || "");
  if (options.rows && !match) return null;
  const start = match ? Number(match[1]) : Number(options.rowStart);
  const end = match ? Number(match[2] || match[1]) : Number(options.rowEnd);
  if (![start,end].every(value=>Number.isSafeInteger(value) && value > 0)) return null;
  return { sheet: String(options.sheet).trim(), rowStart: Math.min(start,end), rowEnd: Math.max(start,end) };
}

export function resolveCachedWorkbookTrace(graph, options) {
  let cache = cacheByGraph.get(graph);
  if (!cache) {
    cache = new Map();
    cacheByGraph.set(graph,cache);
  }
  const { maxChars, ...query } = options;
  const key = JSON.stringify(query,Object.keys(query).sort());
  if (cache.has(key)) return { result: cache.get(key), reuse: "exact" };
  const range = rowRange(options);
  if (range) {
    for (const prior of [...cache.values()].reverse()) {
      if (prior.mode !== "rows" || prior.sheet !== range.sheet || prior.truncated || prior.notes?.length ||
        prior.rowStart > range.rowStart || prior.rowEnd < range.rowEnd) continue;
      if ((options.depth == null ? TRACE_DEFAULT_DEPTH : Number(options.depth)) !== prior.depth) continue;
      const requested = options.maxCells == null ? TRACE_DEFAULT_MAX_CELLS : Number(options.maxCells);
      const maxCells = Math.max(1, Math.min(TRACE_MAX_CELLS, Math.trunc(requested)));
      if (!Number.isFinite(maxCells)) continue;
      const cells = prior.cells.filter(cell=>cell.row >= range.rowStart && cell.row <= range.rowEnd);
      if (cells.length > maxCells) continue;
      return { result:{...prior,...range,maxCells,returned:cells.length,cells}, reuse:"covered_rows" };
    }
  }
  const result = traceGraph(graph, options);
  cache.set(key,result);
  while (cache.size > 16) cache.delete(cache.keys().next().value);
  return { result, reuse:null };
}
