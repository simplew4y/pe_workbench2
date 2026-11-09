/**
 * Pure citation linkifier for chat HTML.
 *
 * The clickable set is exactly the citations supplied by this message's tools.
 * A locator that merely looks like `Sheet!A1` is never promoted to a button;
 * it is either left as plain text or marked `cell-ref-unverified`.
 */

import {
  LOCATOR_SOURCE,
  normalizeLocator,
  resolveLocatorToken,
} from "../../lib/citation-locator.mjs";

const HTML_ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
const LOCATOR_RE = new RegExp(LOCATOR_SOURCE, "g");

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

function linkText(text, lookup) {
  if (!text || !text.includes("!")) return text;
  const regex = new RegExp(LOCATOR_RE.source, "g");
  let output = "";
  let cursor = 0;
  for (const match of text.matchAll(regex)) {
    const resolved = resolveLocatorToken(match[0], lookup);
    if (!resolved) continue;
    const raw = match[0];
    const start = match.index ?? 0;
    // The resolver may trim a prose prefix; keep it outside the chip.
    const offset = raw.lastIndexOf(resolved.raw);
    const prefix = offset > 0 ? raw.slice(0, offset) : "";
    output += text.slice(cursor, start) + prefix;
    output += resolved.citation
      ? citationButton(resolved.citation, resolved.raw)
      : unverifiedSpan(resolved.raw);
    cursor = start + prefix.length + resolved.raw.length;
  }
  if (!cursor) return text;
  return output + text.slice(cursor);
}

/**
 * @param {string} textHtml already-escaped/sanitized message HTML
 * @param {Array<object>} citations this message's verified citations
 */
export function linkCitations(textHtml, citations) {
  const html = String(textHtml ?? "");
  const lookup = citationLookup(citations);
  if (!lookup.size || !html) return html;

  let output = "";
  let cursor = 0;
  let skipDepth = 0;
  const tag = /<[^>]*>/g;
  for (const match of html.matchAll(tag)) {
    const start = match.index ?? 0;
    if (start > cursor) {
      const text = html.slice(cursor, start);
      output += skipDepth > 0 ? text : linkText(text, lookup);
    }
    const token = match[0];
    output += token;
    if (/^<\s*(?:a|button)\b/i.test(token)) skipDepth += 1;
    else if (/^<\s*\/\s*(?:a|button)\s*>/i.test(token)) skipDepth = Math.max(0, skipDepth - 1);
    cursor = start + token.length;
  }
  if (cursor < html.length) {
    const text = html.slice(cursor);
    output += skipDepth > 0 ? text : linkText(text, lookup);
  }
  return output;
}

export { citationLookup };
export default linkCitations;
