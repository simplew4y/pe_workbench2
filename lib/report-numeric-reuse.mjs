import { createHash } from "node:crypto";

const hash = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function lineKey(lines, number) {
  const index = number - 1;
  const line = lines[index];
  if (!line || line.length > 180 || lines.indexOf(line) !== lines.lastIndexOf(line)) return null;
  const headings = [];
  for (const text of lines.slice(0, index)) {
    const heading = text.match(/^(#{1,6})\s+(.+)/);
    if (!heading) continue;
    headings.length = heading[1].length;
    headings[heading[1].length - 1] = heading[2];
  }
  let start = index, end = index + 1;
  const body = text => text?.trim() && !/^#{1,6}\s/.test(text);
  while (body(lines[start - 1])) start--;
  while (body(lines[end])) end++;
  return { line, key: hash([headings, lines.slice(start, end), index - start]) };
}

export function createNumericReviewReuse() {
  let scope;
  const receipts = new Map();
  const clear = () => { scope = undefined; receipts.clear(); };
  return { clear, prepare(identity, content, lineNumbers, unresolved) {
    if (scope !== identity) { clear(); scope = identity; }
    const lines = content.split(/\r?\n/);
    const candidates = unresolved.map((_, index) => identity && lineKey(lines, lineNumbers[index]));
    const reused = new Set(), pending = [];
    unresolved.forEach((text, index) => {
      if (receipts.has(candidates[index]?.key)) reused.add(index);
      else pending.push({ index, text });
    });
    return {
      unresolved: pending.map(item => item.text),
      reusedCount: reused.size,
      merge(verdict) {
        const coverageValidated = (verdict.coverageValidated || []).flatMap(index => pending[index] ? [pending[index].index] : []);
        let reusedCount = 0;
        if (scope === identity && verdict.status === "reviewed" && !verdict.inputCoverageGaps?.length &&
          !verdict.issues?.some(issue => issue.check === "audit")) {
          const conflicts = candidate => (verdict.issues || []).some(({ excerpt }) =>
            !excerpt || candidate.line.includes(excerpt) || excerpt.includes(candidate.line));
          for (const candidate of candidates.filter(Boolean)) if (conflicts(candidate)) receipts.delete(candidate.key);
          for (const { index, evidenceIds } of verdict.reusableNumericCoverage || []) {
            const candidate = candidates[pending[index]?.index];
            if (candidate && evidenceIds?.length && !conflicts(candidate)) receipts.set(candidate.key, [...evidenceIds]);
          }
          for (const index of reused) {
            if (!receipts.has(candidates[index].key)) continue;
            coverageValidated.push(index);
            reusedCount++;
          }
          while (receipts.size > 200) receipts.delete(receipts.keys().next().value);
        }
        return { ...verdict, coverageValidated, reusedNumericCoverageCount: reusedCount };
      },
    };
  } };
}
