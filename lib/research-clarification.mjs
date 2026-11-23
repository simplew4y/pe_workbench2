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

export function initialWorkbookClarification(question, attachments = []) {
  if (!attachments.some(file => /\.xls[xm]$/i.test(file))) return null;
  if (!/^(?:(?:请|帮我)\s*)?(?:这个|这份|该)?(?:财务|估值|财务和估值)?模型\s*(?:怎么看|怎么理解|怎么分析)[？?。!！]*$/.test(String(question).trim())) return null;
  return [
    QUESTION,
    '',
    'A. 复现原表估值，解释每股盈利、倍数和折现是怎么算的。',
    'B. 找出最影响估值的经营假设，说明它如何传到盈利和估值。',
    'C. 核对已有实际数据，判断哪些模型输入需要调整、哪些还缺依据。',
  ].join('\n');
}
