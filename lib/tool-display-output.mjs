// Both transports and the restored snapshot must keep complete match identities
// inside the snapshot's 4,000-character display limit. The model retains its
// own result text, and Pi keeps the full details.
const SEARCH_LIMIT = 4000;

export function toolValidation(name,result) {
  const value=name==='validate_state'?result?.details:result?.details?.stateValidation;
  return typeof value?.ok==='boolean'?{passed:value.ok}:null;
}

export function toolDisplayOutput(name, result, text, limit = SEARCH_LIMIT) {
  if (name !== 'transcript_search') return text.slice(0, limit);
  if (text.length <= SEARCH_LIMIT && !text.includes('"citationDetailsOmitted":true')) return text;

  let details = result?.details;
  if (!Array.isArray(details?.matches)) {
    try { details = JSON.parse(text); } catch { return text.slice(0, SEARCH_LIMIT); }
  }
  if (!Array.isArray(details?.matches)) return text.slice(0, SEARCH_LIMIT);

  const view = {
    matches: [], totalMatches: details.totalMatches,
    ledgerTotalMatches: details.ledgerTotalMatches, displayTruncated: true,
  };
  for (const match of details.matches) {
    if (!match) continue;
    const row = {
      turn: match.turn, role: match.role, excerpt: String(match.excerpt ?? '').slice(0, 600),
      citations: [],
    };
    view.matches.push(row);
    if (JSON.stringify(view).length > SEARCH_LIMIT) {
      view.matches.pop();
      break;
    }
    for (const cite of Array.isArray(match.citations) ? match.citations : []) {
      if (!cite) continue;
      const { id, materialId, version, locator, filename } = cite;
      row.citations.push({ id, materialId, version, locator, filename });
      if (JSON.stringify(view).length > SEARCH_LIMIT) {
        row.citations.pop();
        break;
      }
    }
  }
  return JSON.stringify(view);
}
