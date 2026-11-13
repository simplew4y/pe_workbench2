/**
 * Pure citation linkifier for chat HTML.
 *
 * The clickable set is exactly the citations supplied by this message's tools.
 * A locator that merely looks like `Sheet!A1` is never promoted to a button;
 * it is either left as plain text or marked `cell-ref-unverified`.
 *
 * A bare cell after a full locator (`Discount PE!N35、N36`) becomes a button
 * only when `Discount PE!N36` is already in the index. A miss stays plain text.
 */

import {
  LOCATOR_SOURCE,
  normalizeLocator,
  resolveLocatorToken,
} from "./citation-locator.js";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
const LOCATOR_RE = new RegExp(LOCATOR_SOURCE, "g");
const BARE_CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const SEP_THEN_BARE = new RegExp(String.raw`^(\s*[、,，]\s*)(${BARE_CELL})(?![A-Za-z0-9_:])`);
const LEADING_BARE = new RegExp(String.raw`^(\s*)(${BARE_CELL})(?![A-Za-z0-9_:])`);
const ONLY_GAP = /^[\s、,，]*$/;
const HAS_SEPARATOR = /[、,，]/;
const INLINE_TAG = /^<\s*\/?\s*(?:code|span|strong|em|b|i|s|del|mark|sub|sup|kbd)\b/i;

function sheetOf(locator) {
  const bang = String(locator || "").lastIndexOf("!");
  return bang > 0 ? locator.slice(0, bang) : null;
}

function bareButton(sheet, rawCell, lookup) {
  const coord = rawCell.replace(/\$/g, "").toUpperCase();
  const citation = lookup.get(`${sheet}!${coord}`.toLowerCase());
  return citation ? citationButton(citation, rawCell) : null;
}

function citationLookup(citations) {
  const lookup = new Map();
  for (const citation of Array.isArray(citations) ? citations : []) {
    if (!citation || typeof citation !== "object") continue;
    if (!citation.materialId || !citation.locator) continue;
    const locator = normalizeLocator(citation.locator);
    if (!locator) continue;
    const key = locator.toLowerCase();
    if (!lookup.has(key)) lookup.set(key, citation);
  }
  return lookup;
}

function citationTitle(citation) {
  const parts = [normalizeLocator(citation.locator) || citation.locator];
  if (citation.value !== undefined && citation.value !== null && citation.value !== "") {
    parts.push(`= ${citation.value}${citation.display_unit ? ` ${citation.display_unit}` : ""}`);
  }
  if (citation.role) parts.push(String(citation.role));
  return `打开 ${parts.join(" · ")}`;
}

function citationButton(citation, label) {
  const version = Number(citation.version);
  const locator = normalizeLocator(citation.locator) || String(citation.locator);
  const attrs = [
    'type="button"',
    'class="cell-cite"',
    "data-cell-cite",
    `data-material-id="${escapeHTML(citation.materialId)}"`,
    `data-locator="${escapeHTML(locator)}"`,
    `title="${escapeHTML(citationTitle(citation))}"`,
  ];
  if (Number.isInteger(version) && version >= 1) attrs.splice(4, 0, `data-version="${version}"`);
  return `<button ${attrs.join(" ")}>${escapeHTML(label)}</button>`;
}

function unverifiedSpan(label) {
  return `<span class="cell-ref-unverified" title="未核验：本轮工具未返回这个单元格">${escapeHTML(label)}</span>`;
}

function linkText(text, lookup, state) {
  if (!text) return "";
  let output = "";
  let index = 0;

  const finishTail = (tail) => {
    output += tail;
    if (!tail) return;
    if (ONLY_GAP.test(tail)) {
      if (HAS_SEPARATOR.test(tail)) state.sep = true;
      return;
    }
    state.sheet = null;
    state.sep = false;
  };

  if (state.sep && state.sheet) {
    const leading = text.match(LEADING_BARE);
    if (leading) {
      const button = bareButton(state.sheet, leading[2], lookup);
      output += leading[1] + (button || leading[2]);
      index = leading[0].length;
      state.sep = false;
    } else if (ONLY_GAP.test(text)) {
      output += text;
      if (HAS_SEPARATOR.test(text)) state.sep = true;
      return output;
    } else {
      state.sheet = null;
      state.sep = false;
    }
  } else if (state.sheet && ONLY_GAP.test(text)) {
    output += text;
    if (HAS_SEPARATOR.test(text)) state.sep = true;
    return output;
  }

  while (index < text.length) {
    if (state.sheet && !state.sep) {
      const run = text.slice(index).match(SEP_THEN_BARE);
      if (run) {
        const button = bareButton(state.sheet, run[2], lookup);
        output += run[1] + (button || run[2]);
        index += run[0].length;
        continue;
      }
      const dangling = text.slice(index).match(/^(\s*[、,，]\s*)$/);
      if (dangling) {
        output += dangling[1];
        state.sep = true;
        return output;
      }
    }

    const regex = new RegExp(LOCATOR_RE.source, "g");
    regex.lastIndex = index;
    const match = regex.exec(text);
    if (!match) {
      finishTail(text.slice(index));
      break;
    }
    const start = match.index ?? 0;
    const between = text.slice(index, start);
    if (between) {
      output += between;
      if (!(state.sheet && ONLY_GAP.test(between))) {
        state.sheet = null;
        state.sep = false;
      } else if (HAS_SEPARATOR.test(between)) {
        state.sep = true;
      }
    }
    const resolved = resolveLocatorToken(match[0], lookup);
    if (!resolved) {
      output += match[0];
      index = start + match[0].length;
      state.sheet = null;
      state.sep = false;
      continue;
    }
    const raw = match[0];
    // The resolver may trim a prose prefix; keep it outside the chip.
    const offset = raw.lastIndexOf(resolved.raw);
    const prefix = offset > 0 ? raw.slice(0, offset) : "";
    output += prefix;
    output += resolved.citation
      ? citationButton(resolved.citation, resolved.raw)
      : unverifiedSpan(resolved.raw);
    state.sheet = sheetOf(resolved.locator);
    state.sep = false;
    index = start + prefix.length + resolved.raw.length;
  }
  return output;
}

/**
 * @param {string} textHtml already-escaped/sanitized message HTML
 * @param {Array<object>} citations this message's verified citations
 */
export function linkCitations(textHtml, citations) {
  const html = String(textHtml ?? "");
  const lookup = citationLookup(citations);
  if (!lookup.size || !html) return html;

  const state = { sheet: null, sep: false };
  const reset = () => {
    state.sheet = null;
    state.sep = false;
  };
  let output = "";
  let cursor = 0;
  let skipDepth = 0;
  const tag = /<[^>]*>/g;
  for (const match of html.matchAll(tag)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const text = html.slice(cursor, start);
      output += skipDepth > 0 ? text : linkText(text, lookup, state);
    }
    const token = match[0];
    output += token;
    if (/^<\s*(?:a|button)\b/i.test(token)) {
      skipDepth += 1;
      reset();
    } else if (/^<\s*\/\s*(?:a|button)\s*>/i.test(token)) {
      skipDepth = Math.max(0, skipDepth - 1);
      reset();
    } else if (!INLINE_TAG.test(token)) {
      reset();
    }
    cursor = start + token.length;
  }
  if (cursor < html.length) {
    const text = html.slice(cursor);
    output += skipDepth > 0 ? text : linkText(text, lookup, state);
  }
  return output;
}

export { citationLookup };
export default linkCitations;
