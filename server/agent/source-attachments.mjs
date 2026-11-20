// Resolve an upload through this turn's attachment list and project catalogue.
// A workbook observation or a file from a preceding prompt cannot fill this item.
export function attachmentRequests(question, attachments, catalog, proposals) {
  const materials = [...new Set(attachments ?? [])]
    .map(path => catalog?.findMaterialByPath?.(path))
    .filter(file => file && file.relPath.startsWith('uploads/'));
  const items = [];
  const gaps = [];
  const handled = new Set();
  for (const match of question.matchAll(/[^。；;！？\n]+/gu)) {
    const clause = match[0];
    const proposed = proposals.filter(i => i.action === 'read' && typeof i.quote === 'string' &&
      i.quote && clause.includes(i.quote));
    if (!/读|摘录|逐字|抄录|原文|read|verbatim/i.test(clause) && !proposed.length) continue;
    // A named but unavailable file remains an obligation even if the reader
    // overlooked it. Ordinary workbook reads remain in the existing lane.
    const filename = clause.match(/(?:附件|文件)\s*[「“"]?([\p{L}\d_.-]+\.[\w]+)/u)?.[1];
    const named = materials.filter(m => filename
      ? [m.name, m.relPath, m.relPath.split('/').at(-1)].includes(filename)
      : clause.split(/[\s「」“”"：:，,、]/u).some(word => word === m.name || word === m.relPath));
    if (/\.xls[xm]$/iu.test(filename ?? named[0]?.name ?? '')) continue;
    if (!named.length && !filename) continue;
    for (const i of proposed) handled.add(i);
    const file = named.length === 1 ? named[0] : null;
    const label = file?.name ?? filename ?? named.map(m => m.name).join('、');
    const afterName = clause.slice(clause.indexOf(label) + label.length);
    const quoted = [...afterName.matchAll(/[「“"]([^」”"\n]+)[」”"]/gu)].map(m => m[1]);
    const operand = afterName.match(/^\s*(?:[」”"]\s*)?(?:(?:中|内|里)(?:的)?|的)\s*(.+?)(?=\s*(?:[，,]|并|并请|逐字|按原文|$))/u)?.[1];
    const fields = [...new Set(quoted.length ? quoted : (operand ?? '').replace(/字段$/, '').split(/[、]/u).map(x => x.trim()).filter(Boolean))];
    const resolved = file && fields.length && file.versions?.[0]?.sha256;
    if (!resolved) gaps.push('需核实附件及所求原文字段：' + clause.trim());
    items.push({
      id: 'attachment-' + (items.length + 1), action: 'readAttachment', filename: label,
      ...(resolved ? {path: file.relPath, materialId: file.id, version: file.versions[0].v, sha256: file.versions[0].sha256} : {}),
      fields: fields.length ? fields : ['原文字段'], range: [match.index, match.index + clause.length],
    });
  }
  return {items, gaps, handled};
}

// Use only the payload of the successful read of the admitted snapshot. Pi's
// research receipt is a separate text block and cannot supply a field value.
export function observedAttachmentFields(items, call, sha256) {
  if (call.args?.offset != null || call.args?.limit != null) return [];
  const parts = call.result?.content;
  if (!Array.isArray(parts) || parts[0]?.type !== 'text' || typeof parts[0].text !== 'string' ||
      !parts.slice(1).every(p => p.type === 'text' && p.text === '[research_evidence_id] ' + call.id)) return [];
  const content = parts[0].text;
  const hash = sha256(content);
  const rows = content.split(/\r?\n/u).flatMap(line => {
    const pair = line.match(/^\s*([^：:]+?)\s*[：:][ \t]*(\S(?:.*\S)?)\s*$/u);
    return pair ? [[pair[1], pair[2]]] : [];
  });
  return items.filter(i => i.path === call.args?.path && i.sha256 === hash).flatMap(item =>
    item.fields.flatMap(field => {
      const matches = rows.filter(([name]) => name === field);
      return matches.length === 1 ? [{itemId: item.id, field, value: matches[0][1]}] : [];
    }));
}

// A literal quotation is not an endorsement of the attachment's contents.
// Consume the field and its complete visible value. Any surrounding claim
// (negation, another object, a new valuation, etc.) still needs its own proof.
export function verifyAttachmentLine(visible, decisions, attempts) {
  const targets = decisions.flatMap(item => item.fields.filter(field => visible.includes(field))
    .map(field => ({item, field})));
  if (!targets.length) {
    if (decisions.some(i => visible.includes(i.filename))) return null;
    return;
  }
  const candidates = [];
  for (const {item, field} of targets) {
    for (const call of attempts) {
      if (call.state !== 'success') continue;
      for (const row of call.attachmentFields ?? []) {
        if (row.itemId !== item.id || row.field !== field) continue;
        const at = visible.indexOf(field);
        const prefix = visible.slice(0, at).trim().replace(/^[-*]\s*/u, '');
        const body = visible.slice(at + field.length).trim().replace(/^(?:字段)?\s*(?:原文)?\s*(?:为|是)?\s*[：:]?\s*/u, '');
        if (![row.value, '“' + row.value + '”', '「' + row.value + '」'].some(
          literal => body === literal || body === literal + '。' || body === literal + '.')) continue;
        const named = prefix.replace(/^(?:附件|文件)\s*/u, '').replace(/(?:中的|中|内的|的|：|:)$/u, '').trim();
        const qualified = named === item.filename || named === item.path;
        if (!qualified && (targets.length !== 1 || !/^(?:该|这份)?(?:附件|备忘录|文件|原文)?(?:中|中的|内|的)?$/u.test(prefix))) continue;
        candidates.push({item, field, callId: call.id, value: row.value});
      }
    }
  }
  return new Set(candidates.map(c => c.item.id)).size === 1 ? candidates.at(-1) : null;
}
