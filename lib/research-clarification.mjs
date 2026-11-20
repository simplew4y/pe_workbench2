const QUESTION = '你想先弄清哪件事？';

// Only interpret letters after the assistant's dedicated clarification form.
export function researchChoices(answer) {
  const lines = String(answer ?? '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines[0] !== QUESTION || lines.length < 3 || lines.length > 4) return null;
  const choices = lines.slice(1).map((line, index) => {
    const match = line.match(/^([A-C])[.、．]\s+(.+)$/);
    return match?.[1] === 'ABC'[index] ? match[2] : null;
  });
  return choices.every(Boolean) ? choices : null;
}

export function resolveResearchChoice(question, previousAnswer) {
  const letter = String(question).trim().match(/^(?:我)?(?:选\s*)?([a-c])[.。]?$/i)?.[1];
  if (!letter) return null;
  return researchChoices(previousAnswer)?.['ABC'.indexOf(letter.toUpperCase())] ?? null;
}
