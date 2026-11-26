const localChecks = new Set(["metric_meaning", "numeric_units", "threshold_provenance",
  "comparison_basis", "source_quality", "conclusion_strength"]);

const blocks = content => content.trim().split(/\r?\n(?:[ \t]*\r?\n)+/).map(text=>text.trim());

export function planReportDelta(previous, content) {
  const verdict = previous?.verdict;
  if (verdict?.status !== "reviewed" || verdict.ok || verdict.inputCoverageGaps?.length ||
    !verdict.issues?.length || verdict.issues.some(issue=>!localChecks.has(issue.check) || !issue.excerpt)) return null;
  const before = blocks(previous.content), after = blocks(content);
  if (before.length !== after.length) return null;
  const positions = new Set();
  for (const issue of verdict.issues) {
    const matches = before.flatMap((block,index)=>block.includes(issue.excerpt) ? [index] : []);
    if (matches.length !== 1) return null;
    positions.add(matches[0]);
  }
  for (const [index,block] of before.entries()) {
    if (block !== after[index]) positions.add(index);
  }
  if (!positions.size || [...positions].some(index=>/^\s*#|^\s*`{3}|^\s*~{3}/m.test(before[index]) ||
    /^\s*#|^\s*`{3}|^\s*~{3}/m.test(after[index]))) return null;
  const selected = new Set(positions);
  for (const index of positions) {
    for (let heading = index - 1; heading >= 0; heading--) {
      if (!/^#{1,6}\s/.test(after[heading])) continue;
      selected.add(heading);
      break;
    }
  }
  const text = after.filter((_block,index)=>selected.has(index)).join("\n\n");
  if (Buffer.byteLength(text) > Math.min(10_000, Buffer.byteLength(content) * 0.65)) return null;
  return { text };
}

export function isDeltaRejection(verdict) {
  return verdict?.status === "reviewed" && !verdict.ok && !verdict.inputCoverageGaps?.length &&
    verdict.verifiedEvidenceCount > 0 && verdict.issues?.length > 0 &&
    verdict.issues.every(issue=>localChecks.has(issue.check) && issue.excerpt);
}
