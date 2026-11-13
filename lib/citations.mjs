/**
 * Citation producers and session-level aggregation.
 *
 * The invariant enforced here: a citation only exists when a tool actually
 * returned a material id and a real locator. A miss returns an empty list; a
 * regex match in the answer can never create a citation.
 */

import { validateCitation, validCitations } from "./contracts/citation.mjs";
import { locatorKey, normalizeLocator } from "./citation-locator.mjs";

function scalar(value) {
  if (value === null || typeof value === "number" || typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return undefined;
}

export function citationIdFor(materialId, version, locator) {
  const normalized = normalizeLocator(locator) || String(locator || "");
  return `cite:${String(materialId)}:v${Number(version) || 0}:${normalized}`;
}

function citationFromObject(input, { toolCallId = null } = {}) {
  if (!input || typeof input !== "object") return null;
  const materialId = String(input.materialId ?? input.material_id ?? "").trim();
  const locator = normalizeLocator(input.locator);
  if (!materialId || !locator) return null;
  const version = Number(input.version);
  const citation = {
    id: String(input.id || citationIdFor(materialId, version, locator)),
    materialId,
    ...(Number.isInteger(version) && version >= 1 ? { version } : {}),
    locator,
    ...(scalar(input.value) !== undefined ? { value: scalar(input.value) } : {}),
    ...(input.display_unit ? { display_unit: String(input.display_unit) } : {}),
    ...Object.fromEntries(['company','metric','period','scope','basis_type','scenario','currency','raw_unit','sha256','excerpt','formula'].filter(k => input[k] != null && input[k] !== '').map(k => [k, String(input[k])])),
    ...(input.role ? { role: String(input.role) } : {}),
    ...(input.toolCallId || toolCallId ? { toolCallId: String(input.toolCallId || toolCallId) } : {}),
    ...(Array.isArray(input.derivedFrom) && input.derivedFrom.length
      ? { derivedFrom: input.derivedFrom.map(String).filter(Boolean).slice(0, 40) }
      : {}),
  };
  const checked = validateCitation(citation);
  return checked.ok ? checked.value : null;
}

export function citationFromCell(cell, material, { toolCallId = null } = {}) {
  if (!cell || typeof cell !== "object") return null;
  const locator = normalizeLocator(cell.locator || cell.ref || (cell.sheet && cell.coord ? `${cell.sheet}!${cell.coord}` : null));
  if (!locator) return null;
  return citationFromObject({
    materialId: material?.id,
    version: material?.version ?? material?.v,
    locator,
    value: cell.value,
    display_unit: cell.display_unit,
    role: cell.role,
    ...Object.fromEntries(['company','period','scope','basis_type','scenario','currency','formula'].filter(k=>cell[k]!=null).map(k=>[k,cell[k]])),
    raw_unit: cell.unit || cell.display_unit || '',
    metric: cell.metric || cell.rowLabel || '',
    sha256: material?.sha256 || '',
    excerpt: cell.excerpt || [cell.company,cell.rowLabel,cell.columnLabel,...(cell.sectionPath || []),cell.value,cell.display_unit].filter(v=>v!=null).join(' | '),
    toolCallId,
  });
}

export function citationsFromCells(cells, material, { toolCallId = null } = {}) {
  const seen = new Set();
  const out = [];
  for (const cell of Array.isArray(cells) ? cells : []) {
    const citation = citationFromCell(cell, material, { toolCallId });
    if (!citation) continue;
    if (seen.has(citation.locator.toLowerCase())) continue;
    seen.add(citation.locator.toLowerCase());
    out.push(citation);
  }
  return out;
}

function traceCells(result) {
  const out = [];
  const seen = new Set();
  const add = (cell) => {
    // Scanned blanks stay in the index as locator-only citations. A range mention
    // is verified only when every cell inside it, including empties, was returned.
    if (!cell || typeof cell !== "object") return;
    const locator = normalizeLocator(cell.locator || cell.ref || (cell.sheet && cell.coord ? `${cell.sheet}!${cell.coord}` : null));
    if (!locator || seen.has(locator.toLowerCase())) return;
    seen.add(locator.toLowerCase());
    out.push({ ...cell, locator });
  };
  const addRef = (ref) => {
    const locator = normalizeLocator(ref);
    if (!locator || seen.has(locator.toLowerCase())) return;
    seen.add(locator.toLowerCase());
    out.push({ locator });
  };
  add(result?.target);
  for (const cell of result?.direct || []) add(cell);
  for (const cell of result?.cells || []) add(cell);
  for (const path of result?.paths || []) for (const cell of path || []) add(cell);
  for (const cell of result?.outputs || []) add(cell);
  const walk = (node) => {
    if (!node || typeof node !== "object") return;
    add(node);
    for (const child of node.children || []) walk(child);
  };
  if (result?.tree) walk(result.tree);
  // Path/impact results expose resolved endpoints as plain refs.
  if (result?.mode === "path") {
    addRef(result.from);
    addRef(result.to);
  }
  if (result?.mode === "impact") addRef(result.ref);
  return out;
}

export function citationsFromTrace(result, material, { toolCallId = null } = {}) {
  return citationsFromCells(traceCells(result), material, { toolCallId });
}

export function normalizeCitationInput(input, { toolCallId = null } = {}) {
  return citationFromObject(input, { toolCallId });
}

/**
 * A derived value points at the cell that supplied its input and records the
 * exact upstream citation ids. It never invents a locator when no source cell
 * citation was supplied.
 */
export function derivedCitation(result, sources, { toolCallId = null, role = "derived" } = {}) {
  const normalized = (Array.isArray(sources) ? sources : [])
    .map((source) => normalizeCitationInput(source, { toolCallId }))
    .filter(Boolean);
  if (!normalized.length) return [];
  const primary = normalized[0];
  const citation = citationFromObject({
    id: `derived:${toolCallId || "tool"}:${role}:${primary.id}`,
    materialId: primary.materialId,
    version: primary.version,
    locator: primary.locator,
    value: result?.value,
    display_unit: result?.unit,
    role,
    toolCallId,
    derivedFrom: normalized.map((source) => source.id),
  });
  return citation ? [citation] : [];
}

/** Collect validated citations from live tool events or a refreshed snapshot. */
export function collectCitationsFromToolCalls(toolCalls) {
  const out = [];
  const ids = new Set();
  const locators = new Set();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const candidates = [
      call?.details?.citations,
      call?.details?.presentation?.payload?.citations,
      call?.result?.details?.citations,
      call?.result?.details?.presentation?.payload?.citations,
    ];
    for (const list of candidates) {
      if (!Array.isArray(list)) continue;
      for (const citation of validCitations(list)) {
        if (ids.has(citation.id)) continue;
        const key = `${citation.materialId}|${citation.version || 0}|${locatorKey(citation.locator) || ""}`;
        if (locators.has(key)) continue;
        ids.add(citation.id);
        locators.add(key);
        out.push(citation);
      }
    }
  }
  return out;
}

export function citationLookup(citations) {
  const lookup = new Map();
  for (const citation of validCitations(citations)) {
    const key = locatorKey(citation.locator);
    if (key && !lookup.has(key)) lookup.set(key, citation);
  }
  return lookup;
}

/** Reuse only complete current ledger identities whose literal value is in the answer. */
export function rehydrateCitations({ register, answer = '', thisTurnCitations = [], currentVersions = {} } = {}) {
  const out=[...validCitations(thisTurnCitations)];
  const ids=new Set(out.map(c=>c.id));
  const text=String(answer);
  for(const fact of Array.isArray(register?.facts)?register.facts:[]) {
    const c=fact?.citation;
    if(fact?.status!=='current'||!c?.materialId||!Number.isInteger(Number(c.version))||!c.locator||c.value==null) continue;
    if(currentVersions[c.materialId]!=null&&Number(currentVersions[c.materialId])!==Number(c.version)) continue;
    const normalized=normalizeCitationInput(c);
    if(!normalized||normalized.value==null) continue;
    const value=String(normalized.value);
    const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(!new RegExp(`(?<![\\d.,])${escaped}(?![\\d.,])`).test(text)) continue;
    if(ids.has(normalized.id)) continue;
    ids.add(normalized.id); out.push(normalized);
  }
  return out;
}

export default citationsFromCells;
