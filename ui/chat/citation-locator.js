/**
 * Pure A1 locator parsing shared by the answer linter, the browser linkifier
 * and the citation builders.
 *
 * This module deliberately has no Node or DOM dependency. It only recognises
 * the textual shape of a locator; whether a locator is allowed to become a
 * clickable citation is decided by the citation index, never by this regex.
 *
 * The implementation lives under `ui/` because that is the only tree the
 * browser can fetch (`/ui/*.js`). Node code imports the same source through
 * the thin wrapper at `lib/citation-locator.mjs`, so both sides stay in sync.
 */

const QUOTED_SHEET = String.raw`'(?:[^'\n]|'')+'`;
// Unquoted sheet names may contain spaces ("Discount PE"). Cap the run at four
// words so a sentence ending in a cell reference is not swallowed wholesale.
const WORD = String.raw`[A-Za-z0-9_.&()\-]+`;
const MULTI_WORD_SHEET = String.raw`(?:${WORD} ){0,3}${WORD}`;
const SIMPLE_SHEET = String.raw`[A-Za-z0-9_\u4e00-\u9fff]+`;
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const QUALIFIED_PUNCTUATED_SHEET = String.raw`(?<=\])[A-Za-z0-9_.&()+\-]+(?: [A-Za-z0-9_.&()+\-]+){0,3}`;
const SHEET = `(?:${QUALIFIED_PUNCTUATED_SHEET}|${QUOTED_SHEET}|${MULTI_WORD_SHEET}|${SIMPLE_SHEET})`;

const QUALIFIER = String.raw`\[([^\[\]\r\n]+)\]`;
export const LOCATOR_SOURCE = `(?:${QUALIFIER})?${SHEET}!${CELL}(?::${CELL})?(?![A-Za-z0-9_:])`;

function locatorRegExp(flags = "g") {
  return new RegExp(LOCATOR_SOURCE, flags);
}

const CELL_PART = new RegExp(`^(${CELL})(?::(${CELL}))?$`);
const COORD_PART = /^([A-Z]{1,3})(\d{1,7})$/;
// A traced area stops at 200 cells. A larger rectangle cannot have been fully returned.
const RANGE_CELL_CAP = 200;

function columnIndex(letters) {
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index;
}

function columnLetters(index) {
  let current = index;
  let letters = "";
  while (current > 0) {
    const remainder = (current - 1) % 26;
    letters = String.fromCharCode(65 + remainder) + letters;
    current = Math.floor((current - 1) / 26);
  }
  return letters;
}

function parseCoord(coord) {
  const match = String(coord || "").match(COORD_PART);
  if (!match) return null;
  return { col: columnIndex(match[1]), row: Number(match[2]), coord: match[1] + match[2] };
}

/**
 * A range token is verified when this turn already cited every cell inside it.
 * The returned citation keeps the anchor cell's material and version, but its
 * locator stays the range so the preview opens the written start cell.
 */
function coveredRangeCitation(locator, lookup, source) {
  if (!lookup?.get) return null;
  const bang = locator.indexOf("!");
  if (bang <= 0) return null;
  const sheet = locator.slice(0, bang);
  const body = locator.slice(bang + 1);
  const colon = body.indexOf(":");
  if (colon <= 0) return null;
  const start = parseCoord(body.slice(0, colon));
  const end = parseCoord(body.slice(colon + 1));
  if (!start || !end) return null;
  const rowLo = Math.min(start.row, end.row);
  const rowHi = Math.max(start.row, end.row);
  const colLo = Math.min(start.col, end.col);
  const colHi = Math.max(start.col, end.col);
  const count = (rowHi - rowLo + 1) * (colHi - colLo + 1);
  if (count < 2 || count > RANGE_CELL_CAP) return null;
  const anchor = lookup.get(`${sheet}!${start.coord}`.toLowerCase(), source);
  if (!anchor?.materialId) return null;
  for (let row = rowLo; row <= rowHi; row += 1) {
    for (let col = colLo; col <= colHi; col += 1) {
      const key = `${sheet}!${columnLetters(col)}${row}`.toLowerCase();
      const cell = lookup.get(key, source);
      if (!cell || citationIdentity(cell) !== citationIdentity(anchor)) return null;
    }
  }
  const version = Number(anchor.version);
  return {
    materialId: anchor.materialId,
    ...(Number.isInteger(version) && version >= 1 ? { version } : {}),
    locator,
  };
}

function resolveNormalized(token, normalized, lookup, source) {
  const citation = lookup?.get?.(normalized.toLowerCase(), source) || coveredRangeCitation(normalized, lookup, source);
  if (citation) return { raw: token, locator: normalized, source, citation };
  return null;
}

/** Strip quotes and absolute markers; return a canonical display locator. */
export function normalizeLocator(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const bang = text.lastIndexOf("!");
  if (bang <= 0 || bang === text.length - 1) return null;
  let sheet = text.slice(0, bang).trim();
  if (!sheet) return null;
  if (sheet.startsWith("'") && sheet.endsWith("'") && sheet.length >= 2) {
    sheet = sheet.slice(1, -1).replace(/''/g, "'");
  }
  sheet = sheet.trim();
  if (!sheet || sheet.includes("!")) return null;
  const cells = text.slice(bang + 1).trim();
  const cellMatch = cells.match(CELL_PART);
  if (!cellMatch) return null;
  const coord = (value) => value.replace(/\$/g, "").toUpperCase();
  const start = coord(cellMatch[1]);
  const end = cellMatch[2] ? coord(cellMatch[2]) : null;
  return `${sheet}!${start}${end ? `:${end}` : ""}`;
}

export function locatorKey(raw) {
  const normalized = normalizeLocator(raw);
  return normalized ? normalized.toLowerCase() : null;
}

export function citationIdentity(citation) {
  return `${citation.materialId}@v${citation.version ?? 0}`;
}

export function citationFilenames(citation) {
  return [...new Set([citation?.filename, citation?.storedFilename].filter(Boolean))];
}

export function citationQualifiers(citation) {
  const names = citationFilenames(citation);
  return ['', citation.materialId, citationIdentity(citation), ...names.flatMap(name =>
    [name, `${name}@v${citation.version}`])].map(alias => alias.toLowerCase());
}

export function citationLookup(citations) {
  const byLocator = new Map();
  for (const citation of Array.isArray(citations) ? citations : []) {
    const key = locatorKey(citation?.locator);
    if (!key || !citation.materialId) continue;
    if (!byLocator.has(key)) byLocator.set(key, new Map());
    const matches = byLocator.get(key);
    const identity = citationIdentity(citation);
    if (!matches.has(identity)) matches.set(identity, citation);
  }
  const matchesFor = (key, qualifier) => {
    const matches = byLocator.get(key);
    if (!matches) return [];
    const cells = [...matches.values()];
    return qualifier ? cells.filter(cell => citationQualifiers(cell).includes(qualifier)) : cells;
  };
  const isBlocked = (cell, qualifier) => cell.ambiguousQualifiers?.includes(qualifier);
  return {
    size: byLocator.size,
    isAmbiguous(key, source = '') {
      const qualifier = source.toLowerCase();
      const matches = matchesFor(key, qualifier);
      return matches.length > 1 || matches.some(cell => isBlocked(cell, qualifier));
    },
    get(key, source = '') {
      const qualifier = source.toLowerCase();
      const matches = matchesFor(key, qualifier);
      return matches.length === 1 && !isBlocked(matches[0], qualifier) ? matches[0] : undefined;
    },
  };
}

// The Chinese display label and the tool field name can be given together.
// Both name the same field; only its value is compared to a returned ID.
const idLabel = String.raw`(?:引用\s*ID|\bcitation[ ._-]*id)`;
const labelStyle = '[`*\\s]*';
const alias = `(?:[（(]${labelStyle}${idLabel}${labelStyle}[)）]${labelStyle})?`;
const parenthesizedLabel = `(?:引用)?[（(]${labelStyle}${idLabel}${labelStyle}[)）]`;
const idMarker = `(?:${parenthesizedLabel}|${idLabel}${labelStyle}${alias})` + labelStyle +
  '(?:字段)?(?:完整(?:值|形式)?)?(?:为|是)?\\s*[:：=]?\\s*[`*]*';

// A citation ID is opaque metadata. Its embedded Sheet!A1 is not a
// second, unqualified locator. Keep offsets stable for lint and HTML rendering.
export function maskCitationIds(text, citations = [], onField) {
  const marker = new RegExp(idMarker + String.raw`|\b(?:cite|derived):`, 'gi');
  let masked = '';
  let end = 0;
  for (let match; (match = marker.exec(text));) {
    const bare = /^(?:cite|derived):$/i.test(match[0]);
    const start = bare ? match.index : marker.lastIndex;
    const cited = citations.find(cell => cell.id && text.startsWith(cell.id, start) &&
      /^(?:$|[\s。，、；！？,!)）\]】”"’'`*;]|[.?](?![\w.-]))/.test(text.slice(start + cell.id.length)));
    if (!cited) {
      const token = text.slice(start).match(/^[^\s，。；）)`]*/)[0];
      onField?.(undefined, text.slice(match.index, start) + token);
      continue;
    }
    const fieldEnd = start + cited.id.length;
    onField?.(cited, text.slice(match.index, fieldEnd));
    masked += text.slice(end, match.index) + ' '.repeat(fieldEnd - match.index);
    end = fieldEnd;
    marker.lastIndex = end;
  }
  return masked + text.slice(end);
}

/** Return every locator-shaped token, including duplicates, with positions. */
export function extractLocatorMatches(text) {
  const source = String(text ?? "");
  if (!source.includes("!")) return [];
  const matches = [];
  const regex = locatorRegExp("g");
  for (const match of source.matchAll(regex)) {
    const normalized = normalizeLocator(match[1] ? match[0].slice(match[1].length + 2) : match[0]);
    if (!normalized) continue;
    matches.push({
      raw: match[0],
      locator: normalized,
      key: normalized.toLowerCase(),
      index: match.index ?? 0,
    });
  }
  return matches;
}

/** Resolve one matched token to the canonical locator the UI should show. */
export function resolveLocatorToken(raw, lookup = null) {
  const match = String(raw ?? "").match(locatorRegExp("i"));
  if (!match) return null;
  const token = match[0];
  const source = match[1];
  const normalized = normalizeLocator(source ? token.slice(source.length + 2) : token);
  if (!normalized) return null;
  const exact = resolveNormalized(token, normalized, lookup, source);
  if (exact) return exact;
  if (source) return { raw: token, locator: normalized, source, citation: null };
  // A long prose prefix ("revenue in Discount PE!H33") is not part of the
  // sheet name. Retry with the trailing two words when the full key is
  // unknown; this keeps the unverified marker tight without guessing a cell.
  const bang = normalized.indexOf("!");
  const sheet = normalized.slice(0, bang);
  const words = sheet.split(/\s+/).filter(Boolean);
  if (words.length > 2) {
    const shortSheet = words.slice(-2).join(" ");
    const shortLocator = `${shortSheet}${normalized.slice(bang)}`;
    const shortRaw = `${shortSheet}${token.slice(token.indexOf("!"))}`;
    return resolveNormalized(shortRaw, shortLocator, lookup)
      || { raw: shortRaw, locator: shortLocator, citation: null };
  }
  return { raw: token, locator: normalized, citation: null };
}

export default extractLocatorMatches;
