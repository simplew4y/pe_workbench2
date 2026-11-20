import {Lexer} from 'marked';
import {ordinal} from './answer-delivery.mjs';

// Read the whole filename between the naming operation (or list separator)
// and its extension. A suffix inside a different upload never grants access.
function fileMentions(text, byName) {
  const names = [];
  let end = 0;
  for (const ext of text.matchAll(/\.[A-Za-z][A-Za-z0-9]{0,11}(?![A-Za-z0-9_.-])/gu)) {
    const stop = ext.index + ext[0].length;
    const prefix = text.slice(end, stop);
    const quoted = prefix.match(/[「“‘"'`]([^「」“”‘’"'`\n]+)$/u);
    const join = names.length && prefix.match(/^\s*[」”’"'`]?\s*(?:(?:以及|并列|[和与及、，,])\s*)+(?:附件|文件)?\s*/u);
    const read = prefix.match(/(?:读取|读|摘录|抄录|read\s+|附件|文件)\s*(?:附件|文件)?\s*/iu);
    const intro = join || read;
    const name = quoted?.[1] ?? (intro ? prefix.slice(intro.index + intro[0].length) : prefix).trim();
    if (name.length <= ext[0].length || (!byName.has(name) && !intro && !quoted)) continue;
    names.push({name, start: stop - name.length, end: stop});
    end = stop;
  }
  return names;
}

function requestedFields(tail) {
  const operand = tail.match(/^\s*[」”’"']?\s*(?:(?:中|内|里)(?:的)?|的)\s*(.+)/u)?.[1];
  if (!operand) return [];
  const fields = new Set();
  let rest = operand.trimStart();
  while (rest && !/^(?:请|并|按文件|按原文|分别|逐字|再读|同时读)/u.test(rest)) {
    // Quoting protects a label's internal separators. A quoted label and a
    // bare label use the same list grammar and carry the same obligation.
    const quoted = /^[「“‘"'`]([^」”’"'`\n]+)[」”’"'`]/u.exec(rest);
    const bare = /^[\s\S]+?(?=以及|[和与及、，,]|并|逐字|按原文|$)/u;
    const token = quoted ?? bare.exec(rest);
    if (!token) break;
    const field = quoted ? quoted[1] : token[0].trim().replace(/(?:这?[两二三四五六七八九\d]+个)?字段$/u, '').trimEnd();
    if (field) fields.add(field);
    const separator = /^\s*(?:以及|[和与及、，,])\s*/u.exec(rest.slice(token[0].length));
    if (!separator) break;
    rest = rest.slice(token[0].length + separator[0].length);
  }
  return [...fields];
}

// Resolve each named file through this turn's attachments and catalogue. A
// coordinated list shares the field that follows the list, never a read.
export function attachmentRequests(question, attachments, catalog, proposals) {
  const byName = new Map();
  for (const path of new Set(attachments ?? [])) {
    const file = catalog?.findMaterialByPath?.(path);
    if (!file || file.relPath !== path || !path.startsWith('uploads/')) continue;
    for (const alias of new Set([file.name, path, path.split('/').at(-1)])) {
      if (!byName.has(alias)) byName.set(alias, []);
      byName.get(alias).push(file);
    }
  }
  const items = [];
  const gaps = [];
  const handled = new Set();
  for (const match of question.matchAll(/[^。；;！？\n]+/gu)) {
    const clause = match[0];
    const proposed = proposals.filter(i => i.action === 'read' && typeof i.quote === 'string' &&
      i.quote && clause.includes(i.quote));
    if (!/读|摘录|逐字|抄录|原文|read|verbatim/i.test(clause) && !proposed.length) continue;
    const mentions = fileMentions(clause, byName);
    const admitted = [];
    let group = [];
    for (const [index, mention] of mentions.entries()) {
      group.push(mention);
      const next = mentions[index + 1];
      const tail = clause.slice(mention.end, next?.start);
      if (next && /^[\s和与及以、，,「」“”‘’"']*$/u.test(tail)) continue;
      const fields = requestedFields(tail);
      if (group.length === mentions.length) {
        const expected = tail.match(/(?:给出|列出|报告|提供)\s*(?:这|以上|上述)?([零一二两三四五六七八九十百千\d]+)个字段/u);
        if (expected && ordinal(expected[1]) !== fields.length)
          gaps.push('需确定附件 ' + group.map(f => f.name).join('、') + ' 的所求字段：' + expected[0] +
            '，已对应' + fields.length + '个。');
      }
      for (const operand of group) {
        if (/\.xls[xm]$/iu.test(operand.name)) continue;
        const candidates = byName.get(operand.name) ?? [];
        const file = candidates.length === 1 ? candidates[0] : null;
        const resolved = file?.versions?.[0]?.sha256 && fields.length;
        if (!resolved) gaps.push('需核实附件及所求原文字段：' + operand.name + ' ' + (fields.join('、') || clause.trim()));
        const range = [match.index, match.index + clause.length];
        let item = items.find(i => resolved ? i.path === file.relPath : !i.path && i.filename === operand.name);
        if (!item) {
          item = {id: 'attachment-' + (items.length + 1), action: 'readAttachment', filename: file?.name ?? operand.name,
            ...(resolved ? {path: file.relPath, materialId: file.id, version: file.versions[0].v, sha256: file.versions[0].sha256} : {}),
            fields: [], range, requests: []};
          items.push(item);
        }
        const required = fields.length ? fields : ['原文字段'];
        item.fields = [...new Set([...item.fields, ...required])];
        item.requests.push({range, nameRange: [match.index + operand.start, match.index + operand.end], fields: required});
        admitted.push({operand, item});
      }
      group = [];
    }
    for (const proposal of proposed) {
      const named = admitted.filter(({operand, item}) => proposal.quote.includes(operand.name) &&
        (!proposal.material || [operand.name, item.filename, item.path].includes(proposal.material)));
      // Model schemas can also carry generic field types such as "verbatim
      // source". Reconcile the literal labels present in the user's request
      // for each proposed file. An unmatched label remains an open request.
      const labels = Array.isArray(proposal.fields) ? proposal.fields.filter(f =>
        typeof f === 'string' && f.trim() && clause.includes(f)) : [];
      if (named.length && named.every(({item}) => labels.every(f => item.fields.includes(f)))) handled.add(proposal);
      else if (named.length) for (const {item} of named) {
        const missing = labels.filter(f => !item.fields.includes(f));
        if (missing.length) gaps.push('需确定附件 ' + item.filename + ' 的字段范围：' + missing.join('、'));
      }
    }
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
function attachmentAssertion(visible, decisions) {
  const targets = decisions.flatMap(item => item.fields.filter(field => visible.includes(field))
    .map(field => ({item, field})));
  if (!targets.length) {
    if (decisions.some(i => visible.includes(i.filename))) return null;
    return;
  }
  for (const field of [...new Set(targets.map(t => t.field))].sort((a, b) => b.length - a.length)) {
    const at = visible.indexOf(field);
    const prefix = visible.slice(0, at).trim().replace(/^[-*]\s*/u, '');
    const body = visible.slice(at + field.length).trim()
      .replace(/^(?:字段)?\s*(?:原文)?\s*(?:均|都)?(?:为|是)?\s*[：:]?\s*/u, '');
    const names = prefix.replace(/^(?:附件|文件)\s*/u, '').replace(/(?:中的|中|内的|的|：|:)$/u, '').trim();
    const eligible = decisions.filter(i => i.fields.includes(field));
    let owners = eligible.filter(i => names === i.filename || names === i.path);
    if (owners.length > 1) return null;
    if (!owners.length) {
      if (/^(?:该|这份)?(?:附件|备忘录|文件|原文)?(?:中|中的|内|的)?$/u.test(prefix) && eligible.length === 1) owners = eligible;
      else {
        // Consume the complete subject, including every coordinated name.
        // An extra name, a negation or ambiguous display name invalidates it.
        const aliases = eligible.flatMap(item => [item.filename, item.path].filter(Boolean).map(name => ({name, item})))
          .sort((a,b) => b.name.length - a.name.length);
        let rest = names;
        while (rest) {
          const match = aliases.find(a => rest.startsWith(a.name));
          if (!match || aliases.some(a => a.name === match.name && a.item !== match.item)) break;
          owners.push(match.item);
          rest = rest.slice(match.name.length).trimStart();
          if (!rest) break;
          const separator = /^(?:以及|[和与及、，,])\s*(?:附件|文件)?\s*/u.exec(rest);
          if (!separator) break;
          rest = rest.slice(separator[0].length);
          if (!rest) return null;
        }
        if (rest) continue;
      }
    }
    if (!owners.length) continue;
    return {field, body, owners: [...new Set(owners)]};
  }
  return null;
}

export function verifyAttachmentLine(visible, decisions, attempts) {
  const assertion = attachmentAssertion(visible, decisions);
  if (!assertion) return assertion;
  const {field, body, owners} = assertion;
  const proofs = [];
  for (const item of owners) {
    const proof = attempts.findLast(call => call.state === 'success' && call.attachmentFields?.some(row =>
      row.itemId === item.id && row.field === field &&
      [row.value, '“' + row.value + '”', '「' + row.value + '」'].some(literal =>
        [body, body.replace(/[。.；;，,]$/u, '')].includes(literal))));
    if (!proof) return null;
    proofs.push({item, field, callId: proof.id});
  }
  return proofs;
}

// Walk the rendered inline structure but keep positions in the raw Markdown.
// Only emphasis can span a cut. Preserve its delimiters so that a surviving
// field can still be rendered independently if its neighbour is rejected.
function* attachmentSeparators(tokens, offset = 0, style = '') {
  for (const token of tokens) {
    if (token.type === 'html') return;
    if (token.type === 'strong' || token.type === 'em') {
      const marker = token.raw.slice(0, token.type === 'strong' ? 2 : 1);
      yield* attachmentSeparators(token.tokens, offset + marker.length, style + marker);
    } else if (token.type === 'text') {
      for (const match of token.raw.matchAll(/[，,；;]/gu)) yield {index: offset + match.index, style};
    }
    offset += token.raw.length;
  }
}

// Preserve a full verbatim value containing a separator. If there are two
// assertions, the first may identify the subject even when its value is wrong.
// Its sibling still has to match a successful read of that exact file.
export function* attachmentParts(part, attachments, attempts, visibleMarkdown) {
  const names = attachments.flatMap(i => [i.filename, i.path].filter(Boolean));
  const fields = attachments.flatMap(i => i.fields);
  let start = 0, open = '';
  let attachmentOwners;
  const closing = style => [...style].reverse().join('');
  const rendered = (from, to, opening, ending) =>
    visibleMarkdown(opening + part.slice(from, to).trim() + closing(ending)).trim();
  for (const {index, style} of attachmentSeparators(Lexer.lexInline(part))) {
    const end = index + 1;
    const next = rendered(end, part.length, style, '');
    const nextFile = names.some(name => next.startsWith(name));
    if (!nextFile && !fields.some(field => next.startsWith(field))) continue;
    const scope = attachmentOwners ?? attachments;
    if (verifyAttachmentLine(rendered(start, part.length, open, ''), scope, attempts)?.length) break;
    const subject = attachmentAssertion(rendered(start, index, open, style), scope);
    if (!subject && !nextFile) continue;
    yield {value: part.slice(start, end), attachmentOwners, open, close: closing(style)};
    start = end;
    open = style;
    attachmentOwners = nextFile ? undefined : subject.owners;
  }
  yield {value: part.slice(start), attachmentOwners, open, close: ''};
}
