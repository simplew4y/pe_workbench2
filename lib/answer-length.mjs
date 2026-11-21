export function questionWithoutAttachments(prompt) {
  return prompt.split('\n\n[已上传资料]\n', 1)[0].trim();
}

export function requestedAnswerLength(prompt) {
  const question = questionWithoutAttachments(prompt).normalize('NFKC');
  const match = question.match(/(?:^|[\s,。!?;:])(?:请\s*)?(?:(?:正文|回答|答复|篇幅|字数)\s*)?((?:严格\s*)?(?:限(?:制在)?|不超过|最多|至多|控制在)|严格|硬上限(?:为|:)?|(?:大)?约)?\s*([1-9]\d{0,4})\s*(?:个)?(?:中文)?字\s*(以内|左右|上下)?[。!?]?$/u);
  if (!match || (!match[1] && !match[3])) return null;
  const [, prefix = '', chars, suffix] = match;
  const strict = /^(?:严格|不超过|最多|至多|硬上限)/u.test(prefix) || suffix === '以内';
  // "限/限制在/控制在 N 字" is a cap: not a hard lint limit, but the rewrite
  // budget is tight and the hint must not promise free overrun.
  const cap = !strict && /^(?:限|限制在|控制在)/u.test(prefix);
  return { chars: Number(chars), strict, ...(cap ? { cap: true } : {}) };
}

export function answerLengthHint(length, reservedChars = 0) {
  if (!length) return '';
  const remaining = length.chars - reservedChars;
  if (length.strict) {
    return `正文最多 ${length.chars} 字。你负责的部分最多 ${remaining} 字，含标题、标点和附注。逐项回答，优先删重复背景和无关数字。`;
  }
  if (length.cap) {
    const budget = reservedChars && remaining > 0 ? `系统已提供部分正文，你负责的部分约 ${remaining} 字。` : '';
    return `正文控制在 ${length.chars} 字以内。${budget}先答齐每个问项，保留具体理由、关键条件和必要出处；确需展开时只允许少量超出。优先删重复背景和无关数字。`;
  }
  const budget = reservedChars && remaining > 0 ? `系统已提供部分正文，你负责的部分约 ${remaining} 字。` : '';
  return `正文篇幅目标约 ${length.chars} 字。${budget}先答齐每个问项，保留具体理由、关键条件和必要出处；需要时可以略超。优先删重复背景和无关数字。`;
}

export function answerCharCount(text) {
  return [...text.replace(/\s/g, '')].length;
}

export function requestedCompactItems(question) {
  if (/\b(?:JSON|CSV|YAML)\b|(?:用|以|按|写成|输出)\s*(?:Markdown\s*)?表格/iu.test(question)) return null;
  const focus = question.match(/(?:^|[。；，\n])\s*重点(?:是|包括)\s*[：:]?\s*([^。！？；\n]+)/u);
  const topics = focus?.[1].split('、').map(topic => topic.trim());
  if (topics?.length > 1 && topics.every(topic => /^[\p{L}\p{N}（）()]{1,20}$/u.test(topic))) {
    return { topics, count: topics.length };
  }
  const list = question.normalize('NFKC').match(/(?:写成|列(?:出)?|给出|提出|建立?)\s*[^\d,。!?;\n]{0,14}?(?<![一二两三四五六七八九十百])(10|[2-9两二三四五六七八九十])\s*[个条项][\p{Script=Han}、]{0,10}?(问题|命题)(?=[，,。！？、；:!?;\s]|$)/u);
  if (!list || /至少|至多|最多|不超过|不少于|约/u.test(list[0])) return null;
  const count = Number(list[1]) || (list[1] === '两' ? 2 : '一二三四五六七八九十'.indexOf(list[1]) + 1);
  return { count, kind: list[2] };
}

export function missingCompactItems(answer, outline) {
  if (!outline) return [];
  const lines = answer.replace(/\*\*/g, '').split('\n').map(line => line.trim());
  if (outline.topics) {
    const headings = new Set(lines.flatMap(line => {
      const match = line.match(/^(?:#{1,6}\s+)?([^：:]+)[：:]\s*([\s\S]+)/u);
      return match && /[\p{L}\p{N}]/u.test(match[2]) ? [match[1].trim()] : [];
    }));
    return outline.topics.filter(topic => !headings.has(topic));
  }
  const numbers = new Set(lines.flatMap(line => {
    const match = line.match(/^(\d+)(?:\.[ \t]+|[．、)）][ \t]*)(.+)/u);
    return match && /\p{L}/u.test(match[2]) ? [Number(match[1])] : [];
  }));
  return Array.from({ length: outline.count }, (_, index) => index + 1)
    .filter(number => !numbers.has(number)).map(number => `第 ${number} 项`);
}
