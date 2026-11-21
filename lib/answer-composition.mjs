/** Assemble the same visible sections for review and delivery. */
export function composeResearchAnswer(editable, { calculatedAnswer, verifiedPdfDisclosure } = {}) {
  const calculationAndDraft = [calculatedAnswer, editable].filter(Boolean).join('\n\n');
  if (!verifiedPdfDisclosure) return calculationAndDraft;
  const review = calculationAndDraft.match(/^> \*\*待复核\*\*\s*/u)?.[0] || '';
  const rest = calculationAndDraft.slice(review.length);
  const { kind, body } = verifiedPdfDisclosure;
  const sections = kind === 'segment_margins' ? [body, rest] : [rest, body];
  return (review ? '> **待复核**\n\n' : '') + sections.filter(Boolean).join('\n\n');
}

export const requestsEvidenceLimits = question => /(?:指出|列(?:出)?|说明|区分|给出|明确)[^。！？!?]{0,65}(?:缺口|哪些.{0,6}(?:未知|待核)|待核(?:问题|事项)|不可判断)|还缺(?:什么|哪些)|哪些[^。！？!?]{0,12}(?:仍不能判断|无法排除)/u.test(question);

export function distinctEditableText(editable, supplied) {
  if (!supplied) return editable;
  const signature = part => part.replace(/\*\*|\s/gu,'');
  const paragraphs = editable.split(/\n\s*\n/u);
  const evidence = new Set(supplied.split(/\n\s*\n/u).map(signature));
  const distinct = paragraphs.filter(part=>!evidence.has(signature(part)));
  return distinct.length === paragraphs.length ? editable : distinct.join('\n\n');
}
