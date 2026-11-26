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
  let calculations = new Map();
  const receipts = new Map();
  const clear = () => { scope = undefined; calculations = new Map(); receipts.clear(); };
  return { clear, prepare(identity, content, lineNumbers, unresolved, currentCalculations = new Map()) {
    if (scope !== identity || [...calculations].some(([id, digest]) => currentCalculations.get(id) !== digest)) {
      clear();
      scope = identity;
    }
    calculations = currentCalculations;
    const lines = content.split(/\r?\n/);
    const candidates = unresolved.map((_, index) => identity && lineKey(lines, lineNumbers[index]));
    const reused = new Set(), pending = [], requiredCalculationIds = new Set();
    unresolved.forEach((text, index) => {
      const receipt = receipts.get(candidates[index]?.key);
      if (!receipt) pending.push({ index, text });
      else {
        reused.add(index);
        for (const id of currentCalculations.keys()) if (!receipt.calculations.has(id)) requiredCalculationIds.add(id);
      }
    });
    return {
      unresolved: pending.map(item => item.text),
      reusedCount: reused.size,
      requiredCalculationIds: [...requiredCalculationIds],
      merge(verdict) {
        const fellBack = verdict.numericReuseFallback === true;
        const coverageValidated = fellBack ? [...(verdict.coverageValidated || [])] :
          (verdict.coverageValidated || []).flatMap(index => pending[index] ? [pending[index].index] : []);
        let reusedCount = 0;
        if (scope === identity && verdict.status === "reviewed" && !verdict.inputCoverageGaps?.length &&
          !verdict.issues?.some(issue => issue.check === "audit")) {
          const conflicts = candidate => (verdict.issues || []).some(({ excerpt }) =>
            !excerpt || candidate.line.includes(excerpt) || excerpt.includes(candidate.line));
          for (const candidate of candidates.filter(Boolean)) if (conflicts(candidate)) receipts.delete(candidate.key);
          for (const { index, evidenceIds } of verdict.reusableNumericCoverage || []) {
            const candidate = candidates[fellBack ? index : pending[index]?.index];
            if (candidate && evidenceIds?.length && !conflicts(candidate)) receipts.set(candidate.key, {
              evidenceIds: [...evidenceIds], calculations: new Set(currentCalculations.keys()),
            });
          }
          for (const index of fellBack ? [] : reused) {
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
