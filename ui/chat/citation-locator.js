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
const SHEET = `(?:${QUOTED_SHEET}|${MULTI_WORD_SHEET}|${SIMPLE_SHEET})`;

export const LOCATOR_SOURCE = `${SHEET}!${CELL}(?::${CELL})?(?![A-Za-z0-9_:])`;

function locatorRegExp(flags = "g") {
  return new RegExp(LOCATOR_SOURCE, flags);
}

const CELL_PART = new RegExp(`^(${CELL})(?::(${CELL}))?$`);

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

/** Return every locator-shaped token, including duplicates, with positions. */
export function extractLocatorMatches(text) {
  const source = String(text ?? "");
  if (!source.includes("!")) return [];
  const matches = [];
  const regex = locatorRegExp("g");
  for (const match of source.matchAll(regex)) {
    const normalized = normalizeLocator(match[0]);
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
  let normalized = normalizeLocator(token);
  if (!normalized) return null;
  if (lookup?.has?.(normalized.toLowerCase())) {
    return { raw: token, locator: normalized, citation: lookup.get(normalized.toLowerCase()) };
  }
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
    if (lookup?.has?.(shortLocator.toLowerCase())) {
      return { raw: shortRaw, locator: shortLocator, citation: lookup.get(shortLocator.toLowerCase()) };
    }
    return { raw: shortRaw, locator: shortLocator, citation: null };
  }
  return { raw: token, locator: normalized, citation: null };
}

export default extractLocatorMatches;
