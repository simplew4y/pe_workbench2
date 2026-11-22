/**
 * Citation producers and session-level aggregation.
 *
 * The invariant enforced here: a citation only exists when a tool actually
 * returned a material id and a real locator. A miss returns an empty list; a
 * regex match in the answer can never create a citation.
 */

import { basename } from "node:path";
import { validateCitation, validCitations } from "./contracts/citation.mjs";
import { citationLookup as indexCitations, citationIdentity, citationQualifiers, extractLocatorMatches, locatorKey, maskCitationIds, normalizeLocator, resolveLocatorToken } from "./citation-locator.mjs";

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
    ...(input.storedFilename ? { storedFilename: String(input.storedFilename) } : {}),
    ...(input.filename ? { filename: String(input.filename) } : {}),
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
  const storedFilename = material?.path && basename(material.path);
  return citationFromObject({
    materialId: material?.id,
    storedFilename,
    version: material?.version ?? material?.v,
    locator,
    filename: material?.name,
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
function unitCurrency(unit) {
  return /港元|港币|HKD|HK\$/i.test(unit || '') ? 'HKD' : /美元|USD|US\$/i.test(unit || '') ? 'USD' : /人民币|RMB|CNY/i.test(unit || '') ? 'CNY' : undefined;
}
function outputCurrency(result, fallback) {
  if (/^(?:%|％|decimal|倍|x|个百分点)$/.test(result?.unit || '')) return undefined;
  return result?.currency || unitCurrency(result?.unit) || fallback;
}
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
    filename: primary.filename,
    value: result?.value,
    display_unit: result?.unit || (role === 'derived_ratio' ? result.asPercent || result.op === '%' || result.valuation_basis ? '%' : '倍' : undefined),
    ...Object.fromEntries(['company','period','basis_type','scope','scenario'].filter(key => primary[key] &&
      normalized.every(c => c[key] === primary[key])).map(key => [key, primary[key]])),
    metric: result?.name || primary.metric,
    currency: role === 'derived_unit' || role.startsWith('derived_calc_') ? outputCurrency(result,primary.currency) : undefined,
    role,
    toolCallId,
    derivedFrom: normalized.map((source) => source.id),
  });
  return citation ? [citation] : [];
}

/** Older snapshots keep details alone. An explicit failure anywhere in the
 * live event/result takes precedence over any copy of the presentation. */
/** Tools whose partial result lists only individually successful items. */
export function capturesPartialResult(call) {
  return toolEvidenceState(call) === 'partial' && (call.name.startsWith('workbook_') || call.name === 'calc');
}

export function toolEvidenceState(call) {
  const envelopes = [call, call?.result, call?.details, call?.result?.details].filter(Boolean);
  if (!envelopes.length || envelopes.some(x => x.success === false || x.isError === true ||
    /^(?:error|failed|failure|cancelled|aborted|running|pending)$/i.test(x.status))) return 'failed';
  const partial = envelopes.some(x => x.partial === true || x.status === 'partial');
  if (!partial && envelopes.some(x => x.error)) return 'failed';
  if (envelopes.some(x => x.miss === true || x.coverage?.miss === true || x.status === 'miss')) return 'miss';
  return partial ? 'partial' : 'success';
}

function verifiedPartialCell(citation, details) {
  if (details.materialId !== citation.materialId || details.version !== citation.version ||
      !Array.isArray(details.successfulCitationIds) || !details.successfulCitationIds.includes(citation.id) ||
      !Array.isArray(details.cells)) return null;
  for (const cell of details.cells) {
    if (!cell || toolEvidenceState(cell) !== 'success') continue;
    const locator = locatorKey(cell.locator || cell.ref || cell.id);
    if (!locator || locator !== locatorKey(citation.locator) || cell.value !== citation.value) continue;
    const fields = { ...cell, metric: cell.metric || cell.rowLabel, raw_unit: cell.unit || cell.display_unit };
    const dimensions = ['metric','company','period','display_unit','raw_unit','currency','scope','basis_type','scenario','formula'];
    if (dimensions.some(k => fields[k] != null && fields[k] !== citation[k])) continue;
    const verified = {id:citation.id, materialId:details.materialId, version:details.version, locator:citation.locator,
      value:cell.value, ...Object.fromEntries(dimensions.filter(k => fields[k] != null).map(k => [k, fields[k]]))};
    if (citation.toolCallId) verified.toolCallId = citation.toolCallId;
    return verified;
  }
  return null;
}

/** Includes the calculation and the raw cell when both share a coordinate.
 * Their IDs refer to different evidence and both are needed for provenance. */
export function collectCitationsFromToolCalls(toolCalls, { legacyIds = false } = {}) {
  const accepted = new Map();
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const state = toolEvidenceState(call);
    if (state === 'failed' || state === 'miss') continue;
    const details = call.result?.details || call.details;
    if (!details) continue;
    for (const list of [details.citations, details.presentation?.payload?.citations]) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const citation = legacyIds && raw && !raw.id ? normalizeCitationInput(raw) : raw;
        if (!validateCitation(citation).ok) continue;
        // A partial calc batch only lists citations of its successful items.
        let verified = state === 'partial' && call.name !== 'calc' ? verifiedPartialCell(citation, details) : citation;
        // Older receipts inherited the first operand's currency even when the
        // successful output explicitly said HKD/USD. Repair only from that
        // same result, never from the prose claim or an unrelated calculation.
        const result=call.name==='calc' && details.results?.find(r=>r.citations?.some(c=>c.id===citation.id));
        if(verified && result && String(result.value)===String(citation.value))
          verified={...verified,currency:outputCurrency(result,verified.currency)};
        if (verified) {
          const earlier=accepted.get(verified.id);
          if(!earlier)accepted.set(verified.id,verified);
          else if(earlier.materialId===verified.materialId && earlier.version===verified.version &&
              earlier.locator===verified.locator && String(earlier.value)===String(verified.value)) {
            const merged={...earlier};
            for(const field of ['raw_unit','display_unit','currency','period','metric','scope','basis_type'])
              if((!merged[field] || ['unknown','unit_unknown'].includes(merged[field])) && verified[field] && !['unknown','unit_unknown'].includes(verified[field]))merged[field]=verified[field];
            accepted.set(verified.id,merged);
          }
        }
      }
    }
  }
  return [...accepted.values()];
}

export function currentCitation(citation, currentVersions) {
  const version = currentVersions?.[citation?.materialId];
  return version == null || (citation.version != null && Number(citation.version) === Number(version));
}

export function citationLookup(citations) {
  return indexCitations(validCitations(citations));
}

// A calculation result authenticates arithmetic. The operands still need
// independent, current source observations, even when their IDs look valid.
export function derivedEvidenceIssue(citation, sources, calls, visiting = new Set()) {
  if (!citation.derivedFrom && !citation.role?.startsWith('derived')) return null;
  if (visiting.has(citation.id)) return '派生依赖循环';
  const call = calls?.find(call => call.id === citation.toolCallId &&
    (toolEvidenceState(call) === 'success' || (call.name === 'calc' && toolEvidenceState(call) === 'partial')) && ['ratio','unit_convert','calc'].includes(call.name) &&
    collectCitationsFromToolCalls([call]).some(c => c.id === citation.id));
  if (!call) return '缺少成功的计算结果';
  const d = call.result?.details || call.details;
  const parents = (citation.derivedFrom || []).map(id => sources.get(id));
  if (!parents.length || parents.some(p => !p)) return '缺少上游引用';
  const next = new Set(visiting).add(citation.id);
  for (const parent of parents) {
    const issue = derivedEvidenceIssue(parent, sources, calls, next);
    if (issue) return issue;
  }
  const sameNumber = (a, b) => a != null && b != null && a !== '' && b !== '' &&
    Number.isFinite(Number(a)) && Number(a) === Number(b);
  const calculation = call.name === 'calc' ? d.results?.find(r => r.citations?.some(c => c.id === citation.id)) : d;
  if (!calculation || !sameNumber(calculation.value, citation.value)) return '计算结果数值不匹配';
  const outputUnitCurrency=unitCurrency(calculation.unit);
  if(outputUnitCurrency && calculation.currency && outputUnitCurrency!==String(calculation.currency).toUpperCase().replace('RMB','CNY'))
    return '计算结果币种与输出单位冲突';
  if (call.name === 'calc') {
    const bindings = Object.values(calculation.bindings || {});
    if (bindings.length !== parents.length || bindings.some((b,i) => b.id !== parents[i].id || !sameNumber(b.value, parents[i].value))) return '计算输入与上游引用不匹配';
  }
  if (call.name === 'ratio' && (parents.length !== 2 ||
      !sameNumber(d.numerator, parents[0].value) || !sameNumber(d.denominator, parents[1].value))) return '分子或分母与上游引用不匹配';
  if (call.name === 'unit_convert' && (parents.length !== 1 ||
      !sameNumber(d.inputValue ?? call.args?.value, parents[0].value))) return '换算输入与上游引用不匹配';
  return null;
}

// Keep exactly the source cells an explicit reference resolves to, including
// a covered range and the UI's "Sheet!A1、A2" shorthand.
const SHORTHAND_CELL = /\s*[、,，]\s*(`*)(\$?[a-z]{1,3}\$?\d{1,7})(?![\w!:])\1/iy;

export function adoptedCitations(text, available) {
  const lookup = citationLookup(available);
  const used = new Map();
  const adopt = cell => {
    // Removing unused evidence must not make an ambiguous reference clickable
    // on refresh. Preserve that ambiguity on the remaining cell.
    const ambiguousQualifiers = citationQualifiers(cell).filter(source => lookup.isAmbiguous(locatorKey(cell.locator), source));
    used.set(cell.id, ambiguousQualifiers.length ? { ...cell, ambiguousQualifiers } : cell);
  };
  const idSources = new Set();
  const searchable = maskCitationIds(text, available, cell => { if (cell) idSources.add(cell); });
  for (const match of extractLocatorMatches(searchable)) {
    const cells = [];
    const resolved = resolveLocatorToken(match.raw, { get(key, source) {
      const cell = lookup.get(key, source);
      if (cell) cells.push(cell);
      return cell;
    } });
    if (!resolved?.citation) continue;
    const source = citationIdentity(resolved.citation);
    const sheet = resolved.locator.split('!')[0];
    for (const cell of cells) if (citationIdentity(cell) === source && cell.locator.split('!')[0].toLowerCase() === sheet.toLowerCase()) adopt(cell);
    const tail = text.slice(match.index + match.raw.length).replace(/^`+/, '');
    const adjacentCell = new RegExp(SHORTHAND_CELL);
    for (let next; (next = adjacentCell.exec(tail));) {
      const coord = next[2];
      const cell = lookup.get((sheet + '!' + coord.replaceAll('$', '')).toLowerCase(), source);
      if (cell) adopt(cell);
    }
  }
  for (const cell of idSources) if (!used.has(cell.id)) adopt(cell);
  return [...used.values()];
}

/** Reuse only complete current ledger identities whose literal value is in the answer. */
export function rehydrateCitations({ register, answer = '', thisTurnCitations = [], currentVersions = {}, toolCalls } = {}) {
  const out=validCitations(thisTurnCitations).filter(c => currentCitation(c, currentVersions));
  const ids=new Set(out.map(c=>c.id));
  const text=String(answer);
  for(const fact of Array.isArray(register?.facts)?register.facts:[]) {
    const c=fact?.citation;
    if(fact?.status!=='current'||!c?.materialId||!Number.isInteger(Number(c.version))||!c.locator||c.value==null) continue;
    if(!currentCitation(c, currentVersions)) continue;
    const normalized=normalizeCitationInput(c);
    if(!normalized||normalized.value==null) continue;
    const value=String(normalized.value);
    const escaped=value.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    if(!new RegExp(`(?<![\\d.,])${escaped}(?![\\d.,])`).test(text)) continue;
    if(ids.has(normalized.id)) continue;
    ids.add(normalized.id); out.push(normalized);
  }
  if (!toolCalls) return out;
  const sources = new Map(out.map(c => [c.id, c]));
  return out.filter(c => !derivedEvidenceIssue(c, sources, toolCalls));
}

export default citationsFromCells;

/** Visible, bounded inputs: provider prompts receive content, not tool details. */
export function calculationSourceText(citations) {
  const selected=validCitations(citations).filter(c => typeof c.value === 'number' && Number.isFinite(c.value)).slice(0,8);
  if (!selected.length) return '';
  const fields=['id','materialId','version','locator','value','display_unit','currency','metric'];
  const inputs=selected.map(c=>Object.fromEntries(fields.filter(k=>c[k]!=null && c[k]!=='').map(k=>[k,c[k]])));
  return '\n计算输入出处（可直接复制到calc.bindings；最多8格，其余请按单格读取）：'+JSON.stringify(inputs);
}
