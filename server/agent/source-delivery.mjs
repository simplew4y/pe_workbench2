import {Lexer} from 'marked';
import {
  citationFilenames,
  citationLookup,
  extractLocatorMatches,
  maskCitationIds,
  resolveLocatorToken,
} from '../../lib/citation-locator.mjs';
import {
  adoptedCitations,
  answerBlocks,
  blockingFinding,
  checkSourceFields,
  explicitTurns,
  turnMentions,
  reportedLocatorEvidence,
  sourceFieldsOnly,
} from './answer-delivery.mjs';
import {resultReports} from './transcript-search-recovery.mjs';
import {conditionValue} from './source-observations.mjs';
import {countPopulation, digest, queryReferences} from './source-plan.mjs';
import {attachmentParts, verifyAttachmentLine} from './source-attachments.mjs';

const absent =
  /(?:未(?:命中|匹配|引用|找到|检索到|查到)|没有(?:命中|匹配|引用|找到)|无(?:匹配|命中)|零命中|0\s*条|no matches)/i;
const negative = /并非|并不|不是|绝非|不曾|并未|没有引用|未曾引用|\bnot\b|\bnever\b/i;
const now = /当前|截至今天|至今|迄今|如今|仍然|现行|现为|目前|今天|现在|最新|本次读取|本轮(?:直接读取|实读)|\bcurrent(?:ly)?\b|\btoday\b/i;
const amount = /(?:利润|收入|增长|营收|财务|常量|读数|金额|数值|值为|余额|同比|环比|元\/股|万元|亿元|百万元)/;
const version =
  /(?:\bv|@v)\d+\b|第[一二三四五六七八九十\d]+版|(?:版本|\bversion)\s*(?:为|是|[:：])?\s*v?\d+/i;
const unsafeMarkdown = /<[^>]+>|!?\[[^\]\n]*\]\s*\([^)\n]*\)|^\s*\[[^\]\n]+\]:/;

// Only tokens which actually render as text can satisfy an explicit field.
function visibleMarkdown(markdown) {
  function leaves(tokens, separator = '\n') {
    return tokens
      .map((t) => {
        if (['html', 'image', 'def', 'space'].includes(t.type)) return '';
        if (t.type === 'table')
          return leaves([...t.header, ...t.rows.flat()].map((c) => ({tokens: c.tokens})));
        if (t.items) return leaves(t.items);
        return t.tokens ? leaves(t.tokens, '') : (t.text ?? '');
      })
      .join(separator);
  }
  return leaves(Lexer.lex(markdown));
}

// Split only at the start of a separately identifiable assertion. Preserve
// the original Markdown (including separators) so accepted neighbors retain
// their exact spelling and all durable spans address the signed version.
function* countParts(part, decisions) {
  let start = 0;
  if (decisions.length > 1) {
    const queries = queryReferences(part, decisions);
    const turns = [...turnMentions(part)].filter(t => !queries.some(q => t.start < q.end && q.start < t.end));
    const refs = [...queries.filter(q => q.known), ...turns].sort((a, b) => a.start - b.start);
    for (let i = 1; i < refs.length; i++) {
      // The two operands bound the intervening predicate. Split after its
      // last quantity, preserving Markdown closers and original punctuation.
      const previous = refs[i - 1], next = refs[i];
      const between = part.slice(previous.end, next.start);
      const count = visibleMatchCounts(between).at(-1);
      if (!count || !visibleMatchCounts(part.slice(next.end)).length) continue;
      const end = previous.end + count.visibleRange[1];
      const gap = part.slice(end, next.start);
      const punctuation = /[，,；;、](?![\s\S]*[，,；;、])/u.exec(gap);
      // Leave modifiers after the number ("两条以上") with that number.
      // Otherwise the sign-off would turn a qualified count into an exact one.
      const nextIntro = /\s*(?:(?:而|同时|并且|以及|另|和|与)\s*)?(?:第\s*[零一二两三四五六七八九十百千\d]+\s*轮\s*)?$/u.exec(gap);
      const cut = end + (punctuation ? punctuation.index + 1 : nextIntro.index);
      yield {value: part.slice(start, cut), parent: part};
      start = cut;
    }
  }
  yield {value: part.slice(start), parent: start ? part : undefined};
}

function* units(text, attachments, decisions, attempts) {
  let end = 0;
  for (const part of answerBlocks(text).flatMap(block => block.parts)) {
    const isAttachment = attachments.some(item => part.includes(item.filename) || (item.path && part.includes(item.path)));
    const parentStart = text.indexOf(part, end);
    const fragments = isAttachment ? attachmentParts(part, attachments, attempts, visibleMarkdown) : countParts(part, decisions);
    for (const fragment of fragments) {
      const value = fragment.value.trim();
      const start = text.indexOf(value, end);
      if (start < 0) continue;
      end = start + value.length;
      yield {...fragment, parentStart, value, start, end};
    }
  }
}

// A blind reader can align several field labels to a list of values. Verify
// each literal against the same witness before trusting that alignment. The
// remaining text cannot contain a second identity, number, version or cell.
function alignedFieldList(unit, claim, source, conflict) {
  if (
    !conflict ||
    !source ||
    claim?.relation !== 'historical' ||
    claim.polarity !== 'positive' ||
    !claim.fields?.length ||
    /(?:第[^，。；：\s]{1,8}版|\bnot\b|否定|作废)/iu.test(unit)
  )
    return false;
  let residue = unit.normalize('NFKC');
  const values = {
    filename: citationFilenames(source),
    storedFilename: [source.storedFilename],
    displayFilename: [source.filename],
    materialId: [source.materialId],
    version: ['v' + source.version, String(source.version)],
    id: [source.id],
    locator: [source.locator],
  };
  const ordered = [...claim.fields].sort((a, b) => String(b.literal).length - String(a.literal).length);
  const overlap = ordered.some((f) => typeof f.literal === 'string' && conflict.includes(f.literal));
  if (!overlap) return false;
  for (const f of ordered) {
    if (typeof f.literal !== 'string' || !values[f.name]?.includes(f.literal)) return false;
    const pos = residue.indexOf(f.literal);
    if (pos < 0) return false;
    if (
      ['filename', 'displayFilename', 'storedFilename', 'materialId', 'version', 'id'].includes(f.name) &&
      pos &&
      /[\w.\-]/.test(residue[pos - 1])
    )
      return false;
    residue = residue.slice(0, pos) + ' '.repeat(f.literal.length) + residue.slice(pos + f.literal.length);
  }
  if (
    /存储|磁盘|storedFilename/i.test(unit) &&
    !ordered.some((f) => f.name === 'storedFilename' && f.literal === source.storedFilename)
  )
    return false;
  if (
    /显示名|原始名|displayFilename/i.test(unit) &&
    !ordered.some((f) => f.name === 'displayFilename' && f.literal === source.filename)
  )
    return false;
  if (
    /(?:版本|version)\s*[:=]\s*[\da-f]{8}-/i.test(conflict) &&
    !(
      ordered.some((f) => f.name === 'materialId') &&
      ordered.some((f) => f.name === 'version') &&
      /材料|material/i.test(unit)
    )
  )
    return false;
  return !/[\d!@]|\.xls[xm]|cite:|第[^，。；]{1,8}版/i.test(residue);
}

// Inherit a heading's time only for a presentation of known fields. The
// values come from the selected evidence, not from the language receipt.
// Text left over after the labels and values is a separate assertion.
function neutralSourceRow(text, witnesses) {
  const values = new Set();
  for (const {citation: c} of witnesses) {
    for (const value of [c.id, c.materialId, c.locator, ...citationFilenames(c), 'v' + c.version])
      if (value) values.add(value);
  }
  let rest = text;
  for (const value of [...values].sort((a, b) => b.length - a.length))
    rest = rest.replaceAll(value, ' ');
  if (rest === text) return false;
  // Numbered versions are checked again by checkSourceFields, including
  // a second spelling of the same version in a parenthetical.
  rest = rest.replace(/第\s*[一二两三四五六七八九十\d]+\s*版/g, ' ');
  return !rest.replace(/(?:实际|原始|显示|存储|存放|完整|该|即|工作簿|工作表|文件名?|材料|版本号?|单元格|原格|坐标|引用|citation\.id|materialId|ID|是|为|的)|[\s\p{P}*_]/giu, '');
}

function quantity(token) {
  if (/^\d+$/.test(token)) return Number(token);
  const digits = '零一二三四五六七八九';
  const [tens, ones, extra] = token.replaceAll('两', '二').split('十');
  if (ones === undefined) return tens.length === 1 ? digits.indexOf(tens) : NaN;
  if (extra !== undefined || tens.length > 1 || ones.length > 1) return NaN;
  return (tens ? digits.indexOf(tens) : 1) * 10 + (ones ? digits.indexOf(ones) : 0);
}

// Read match counts from the visible clause before consuming *any* reader
// spans. A receipt about a turn, or a receipt containing the entire clause,
// cannot discharge a separate count. Do not conflate cells or ledger rows
// with transcript matches.
function visibleMatchCounts(text) {
  const fields = [];
  for (const sentenceMatch of text.matchAll(/[^。；;！？\n]+/gu)) {
    const sentence = sentenceMatch[0];
    // In an introduction an unqualified number of results refers to the
    // scan. A named noun (e.g. number of citations) has its own evidence.
    const searchHeading = /(?:出处|来源|引用)如下/u.test(sentence);
    let subject;
    for (const clauseMatch of sentence.matchAll(/[^，,：:]+/gu)) {
      const clause = clauseMatch[0];
      // UTF-16 offsets in the visible Markdown of this signed claim, even
      // when two populations use exactly the same number and literal.
      const fieldRange = m => {
        const start = sentenceMatch.index + clauseMatch.index + m.index;
        return [start, start + m[0].length];
      };
      const separate = countPopulation(clause);
      if (separate === 'uniqueWorkbooks' || separate === 'textOccurrences') {
        const quantified = separate === 'uniqueWorkbooks' ? /([零一二两三四五六七八九十百千万\d]+)\s*本/gu :
          /([零一二两三四五六七八九十百千万\d]+)\s*次/gu;
        for (const m of clause.matchAll(quantified)) fields.push({name: separate, value: quantity(m[1]), literal: m[0], visibleRange: fieldRange(m),
          qualified: /不止|至少|至多|不超过|并非|不是|约|多于|少于/u.test(clause)});
      }
      const search = /命中|匹配|检索结果|搜索结果|查到|查得|查出|找到/u.test(clause);
      const counts = [...clause.matchAll(/([零一二两三四五六七八九十百千万\d]+)\s*(?:处|条|项|个)(?!\s*(?:单元格|坐标|工作簿|引用|字段|条件|词))/gu)];
      const category = /助手|正式(?:答文|回答)|回答中|所有消息|全部消息|用户消息|台账|账本|ledger|出现|字串|字样|字面次数/iu;
      if (!counts.length) {
        if (category.test(clause) || search) subject = countPopulation(clause) ?? 'unknownCount';
        else if (!/^\s*(?:共|合计|一共|总计|计有|仅|只|有|结[果论])/u.test(clause)) subject = undefined;
        continue;
      }
      let previousEnd = 0;
      for (const m of counts) {
        const prefix = clause.slice(previousEnd, m.index);
        const suffix = clause.slice(m.index + m[0].length).match(/^\s*(助手(?:正式)?(?:回答|答文|消息)|用户消息|台账记录)/u)?.[0] ?? '';
        if (category.test(prefix + suffix)) subject = countPopulation(prefix + suffix) ?? 'unknownCount';
        else if (search && !subject) subject = 'totalMatches';
        previousEnd = m.index + m[0].length;
        if (!subject && !searchHeading) continue;
        const qualified = /^(?:以上|以下|左右|以内|以外|起)/u.test(clause.slice(previousEnd).trimStart()) ||
          /并非|并不|不是|没有|不止|不只|不足|至少|至多|超过|少于|多于|大约|大概|约有|不到|不超过|不低于/.test(prefix);
        fields.push({name: subject ?? 'totalMatches', literal: m[0], value: quantity(m[1]), visibleRange: fieldRange(m), ...(qualified ? {qualified: true} : {})});
      }
    }
  }
  return fields;
}

function* scopedScans(owners, observations) {
  if (!owners.length) return;
  const attempts = observations.attempts.filter(
    (a) =>
      a.state === 'success' &&
      a.name === 'transcript_search' &&
      owners.every((i) => i.attemptIds.includes(a.id)),
  );
  for (const attempt of attempts) {
    const d = attempt.details,
      coverage = d?.coverage;
    if (
      (coverage ? coverage.truncated !== false : !(d?.totalMatches > 0)) ||
      !Array.isArray(d?.matches) ||
      d.totalMatches !== d.matches.length
    )
      continue;
    const hits = d.matches.filter((m) => m.role === 'assistant');
    // A whole-scan count and a count for one workbook or turn are equal
    // only when all returned rows lie in the selected scope.
    if (
      d.matches.some((m) =>
        owners.some(
          (i) =>
            (i.turn && i.turn !== m.turn) ||
            (i.book && !(m.citations ?? []).length) ||
            (i.book && m.citations.some((c) => !citationFilenames(c).includes(i.book))),
        ),
      )
    )
      continue;
    yield {attempt, hits};
  }
}

function scanCounts(attempt, hits, observations) {
  const details = attempt.details;
  const counts = {totalMatches: details.totalMatches, assistantMatches: hits.length, ledgerMatches: details.ledgerTotalMatches};
  // A projection of cited excerpts may omit other sources in the same
  // formal answer. Only count distinct workbooks of complete source rows.
  if (details.coverage?.truncated === false && hits.every(hit => !hit.sourceDigest && hit.citations?.length &&
      hit.citations.every(c => c.materialId && observations.witnesses.some(w => w.callId === attempt.id && w.citation.id === c.id)))) {
    counts.uniqueWorkbooks = new Set(hits.flatMap(hit => hit.citations.map(c => c.materialId))).size;
  }
  return counts;
}

// Counts concern the successful scan in the requested scope. An omitted
// model projection, an unrestricted query or an incomplete scan proves none.
function executionReport(claim, text, owners, observations) {
  if (
    claim?.relation !== 'execution' ||
    !claim.fields?.length ||
    extractLocatorMatches(text).length ||
    /cite:|\.xls[xm]|@v\d|\bv\d/i.test(text)
  )
    return;
  for (const {attempt, hits} of scopedScans(owners, observations)) {
    const d = attempt.details, coverage = d.coverage ?? {};
    // Old results may attest to their own positive row count. Only explicit
    // coverage attests to the turns scanned or to an exhaustive empty result.
    if (coverage.truncated !== false && /未截断|无遗漏|没有遗漏|全部(?:回答|回合)|完整扫描/.test(text)) continue;
    const ids = hits.flatMap((h) => (h.citations ?? []).map((c) => c.id));
    const values = {
      ...scanCounts(attempt, hits, observations),
      totalTurns: coverage.totalTurns,
      turnsScanned: coverage.turnsScanned,
      scannedTurn: coverage.turns?.length === 1 ? coverage.turns[0] : undefined,
      truncated: coverage.truncated,
    };
    if (observations.historyToolsOnly) values.directReadCount = 0;
    if (hits.length === 1) {
      const h = hits[0];
      values.sourceStatus = h.sourceStatus;
      values.sourceTurnId = h.sourceTurnId;
      if (h.sourceTurnId && Array.isArray(h.sourceLimits)) values.limitCount = h.sourceLimits.length;
      if (
        h.sourceTurnId &&
        !h.sourceDigest &&
        ids.length &&
        ids.every((id) => observations.witnesses.some((w) => w.callId === attempt.id && w.citation.id === id))
      )
        values.citationCount = new Set(ids).size;
    }
    // Bind a count to the noun in the visible report. A generic search
    // match is not a ledger match, even if the blind reader labeled it so.
    const fields = claim.fields.map(f => {
      if (f.name === 'ledgerMatches' && !/台账|账本|ledger/i.test(text) &&
          /命中|匹配/.test(text) && /^(?:\d+|[一二两三四五六七八九十]+)\s*(?:处|条|项|个)$/.test(f.literal))
        return {...f, name:'totalMatches'};
      return f;
    });
    const corroborated = (f) => {
      if (
        typeof f.literal !== 'string' ||
        !f.literal.trim() ||
        !text.includes(f.literal) ||
        !Object.hasOwn(values, f.name) ||
        values[f.name] === undefined
      )
        return false;
      const expected = values[f.name];
      const statusNames = {
        completed: '已完成',
        partial: '部分完成',
        failed: '失败',
        cancelled: '已取消',
        unknown: '未知',
      };
      const literal = f.literal;
      // The JSON reader can serialize a scalar as text. Compare it using
      // the type of the durable observation and verify its visible spelling.
      const value = String(f.value);
      if (value !== String(expected) && !(f.name === 'sourceStatus' && value === statusNames[expected]))
        return false;
      if (typeof expected === 'number') {
        const digits = f.literal.match(/\d+/g) ?? [];
        if (digits.length) return digits.every((n) => Number(n) === expected);
        if (expected === 0) return /未|没有|无|零|未曾/.test(f.literal);
        const numbers = f.literal.match(/[零一二两三四五六七八九十百千万]+/g);
        return numbers?.length && numbers.every((token) => quantity(token) === expected);
      }
      if (typeof expected === 'boolean')
        return (
          f.literal.includes(String(expected)) || (expected === false && /未截断|没有截断|没有遗漏|无遗漏/.test(f.literal))
        );
      return (
        typeof expected === 'string' &&
        (literal.includes(expected) || (f.name === 'sourceStatus' && literal.includes(statusNames[expected])))
      );
    };
    if (!fields.every(corroborated)) continue;
    let unchecked = text;
    for (const field of [...claim.fields].sort((a, b) => b.literal.length - a.literal.length)) {
      unchecked = unchecked.replace(field.literal, ' ');
    }
    unchecked = unchecked.replace(/第\s*(\d+)\s*轮/g, (token, n) =>
      coverage.turns?.length === 1 && coverage.turns[0] === Number(n) ? ' ' : token,
    );
    for (const field of visibleMatchCounts(text)) unchecked = unchecked.replace(field.literal, ' ');
    if (!/[\da-f]{8}-[\da-f-]{27}|\d|\.xlsx|cite:/i.test(unchecked)) return attempt;
  }
}

function distinctWitnesses(witnesses) {
  return [...new Map(witnesses.map((w) => [w.citation.id, w])).values()];
}

// A budget stop can precede the first printable draft even though the
// requested source was retrieved. Recover only a fully enumerated, unique
// source and submit the resulting text to the ordinary field verifier.
function recoveredItemText(item, observations, currentVersions, includeRead) {
  if (!item.item.turn) return;
  if (item.empty && item.item.operation === 'exists' && !item.hits.length &&
      /^[\p{L}\p{N}_ .!-]{1,100}$/u.test(item.item.query)) {
    return '第' + item.item.turn + '轮“' + item.item.query + '”未命中。';
  }
  const sources = distinctWitnesses(item.hits);
  if (sources.length !== 1) return;
  const w = sources[0],
    c = w.citation;
  const attempt = observations.attempts.find((a) => a.id === w.callId);
  const d = attempt?.details;
  if (
    !w.sourceTurnId ||
    !d?.coverage ||
    d.coverage.truncated !== false ||
    !d.coverage.turns?.includes(item.item.turn) ||
    d.matches?.length !== d.totalMatches ||
    d.matches.filter((m) => m.role === 'assistant').length !== 1
  )
    return;
  // Use plain representable identifiers. The workbook and cell stay on the
  // original version even when the catalogue now has a newer head.
  if (
    !/^[\p{L}\p{N}_. -]+\.xls[xm]$/u.test(c.filename ?? '') ||
    !/^[\p{L}\p{N}_ -]+!\$?[A-Z]{1,3}\$?\d+$/u.test(c.locator ?? '') ||
    !/^[\da-f-]{36}$/i.test(c.materialId ?? '') ||
    c.id !== 'cite:' + c.materialId + ':v' + c.version + ':' + c.locator
  )
    return;
  const historyText = (
    '第' +
    w.turn +
    '轮正式回答引用的是 [' +
    c.filename +
    ']' +
    c.locator +
    '（材料 ID ' +
    c.materialId +
    '，版本 v' +
    c.version +
    '）。\n\n完整引用 ID：' +
    c.id
  );
  if (!includeRead) return historyText;
  const direct = distinctWitnesses(observations.witnesses.filter((row) =>
    row.relation === 'read' && row.selection === 'head' &&
    row.citation.materialId === c.materialId && row.citation.locator === c.locator &&
    currentVersions[c.materialId] === row.citation.version));
  if (direct.length !== 1) return historyText;
  const cell = direct[0].citation;
  if (!Number.isFinite(cell.value)) return historyText;
  return historyText + '\n\n当前同一材料的 [' + c.materialId + '@v' + cell.version + ']' +
    cell.locator + ' 读数为 ' + cell.value + '，版本为 v' + cell.version + '。';

}

export function recoverSourceFields(plan, observations, currentVersions = {}, allowPartial = false) {
  const scopedMixed = plan.route === 'mixed' && plan.sourceOnlyRead;
  if ((!scopedMixed && (plan.route !== 'history' || plan.research)) || observations.badIds.length) return;
  if (!allowPartial && (plan.gaps.length || observations.recoveryGaps.length || observations.items.length !== 1)) return;
  // Recovery is per admitted search. A successful X can provide a printable
  // source while Y stays unresolved in the very same verification pass.
  const reports = observations.items.map((item) =>
    recoveredItemText(item, observations, currentVersions, scopedMixed)).filter(Boolean);
  return [...new Set(reports)].join('\n\n') || undefined;
}

export function evaluateSourceDraft({
  text,
  question,
  plan,
  observations,
  currentVersions,
  meaning,
  lint,
  review,
  repairId = true,
  retainedBindings,
}) {
  const {items: observed, witnesses, badIds} = observations;
  const decisions = observed.map(({item, hits, related, empty, attemptIds}) => ({
    ...item,
    hits,
    related,
    empty,
    attemptIds,
    state: 'unresolved',
    delivered: new Set(),
  }));
  const readItem = plan.items.find((i) => i.action === 'read');
  const currentDecision = readItem && {
    ...readItem,
    state: 'unresolved',
    attemptIds: [],
    delivered: new Set(),
  };
  if (currentDecision) {
    if (readItem.conditional) {
      const value = conditionValue(readItem.predicate, observed);
      currentDecision.condition = value ?? 'unknown';
      if (value === false) currentDecision.state = 'notApplicable';
    }
  }
  const allHist = distinctWitnesses(decisions.flatMap((i) => i.hits));
  const ids = new Set(allHist.map((w) => w.citation.materialId));
  const direct = distinctWitnesses(
    witnesses.filter(
      (w) =>
        w.relation === 'read' &&
        w.selection === 'head' &&
        ids.has(w.citation.materialId) &&
        currentVersions[w.citation.materialId] === w.citation.version,
    ),
  );
  const reviewItem = plan.items.find((i) => i.action === 'review');
  const reviewed = reviewItem && {...reviewItem, state: 'unresolved', delivered: new Set(), attemptIds: []};
  const attachments = plan.items.filter(i => i.action === 'readAttachment').map(i => ({...i,
    state: 'unresolved', delivered: new Set(), attemptIds: observations.attempts.filter(a => a.name === 'read' && a.args.path === i.path).map(a => a.id)}));
  const optionalRead = {
    id: 'observed-read',
    action: 'read',
    fields: [],
    delivered: new Set(),
    attemptIds: [],
    state: 'answered',
  };
  const claims = [],
    occurrences = [],
    rejected = [],
    optionalNotes = [],
    statedLimits = [],
    rejectedChecks = [],
    citations = new Map();
  let antecedent;
  let historyFieldGroup = false;
  const accepted = [];
  const accept = (unit, refs, owners, ws, relation) => {
    if (unit.countProof) {
      ws = [...ws, {callId: unit.countProof.callId}];
      owners = [...new Set([...owners, ...unit.countOwners])];
      for (const item of unit.countOwners) {
        for (const {name} of unit.countProof.fields) item.delivered.add(name);
      }
    }
    accepted.push({unit, refs, owners, ws, relation});
  };
  const retainedHistory = new Map();
  if (retainedBindings && retainedBindings.textDigest === digest(text)) {
    for (const claim of retainedBindings.claims) {
      if (claim.relation === 'historical') retainedHistory.set(claim.start, claim);
    }
  }
  const gaps = [...plan.gaps, ...observations.recoveryGaps];
  for (const unit of units(text, attachments, decisions, observations.attempts)) {
    const s = unit.value,
      visible = visibleMarkdown((unit.open ?? '') + s + (unit.close ?? ''));
    const attachment = verifyAttachmentLine(visible.trim(), unit.attachmentOwners ?? attachments, observations.attempts);
    if (attachment !== undefined) {
      const disputed = review?.openFindings?.some(f => f.excerpt && s.includes(f.excerpt));
      if (attachment && !disputed && !unsafeMarkdown.test(s)) {
        for (const {item, field} of attachment) item.delivered.add(field);
        unit.attachmentField = attachment[0].field;
        unit.attachmentProofs = attachment.map(({item, field, callId}) => ({itemId: item.id, field, callId}));
        accept(unit, [], attachment.map(p => p.item), attachment, 'attachmentQuote');
      } else rejected.push(s);
      continue;
    }
    const refsInText = queryReferences(visible, decisions);
    const namesHere = new Set(refsInText.map(ref => ref.query));
    const named = decisions.filter(i => namesHere.has(i.query?.toLowerCase()));
    let selected = named.length ? named : decisions;
    const countText = refsInText.filter(ref => ref.known).reduceRight((part, ref) => part.slice(0, ref.start) +
      ' '.repeat(ref.end - ref.start) + part.slice(ref.end), visible);
    const matchCounts = visibleMatchCounts(countText);
    if (matchCounts.length) {
      const rounds = explicitTurns(countText);
      if (rounds.size) selected = selected.filter(item => !item.turn || (rounds.size === 1 && rounds.has(item.turn)));
      if (refsInText.some(ref => !ref.known && /^(?:的)?(?:全部消息|助手|匹配|命中)/u.test(visible.slice(ref.end).trimStart())) || unsafeMarkdown.test(s))
        selected = [];
    }
    // A positive legacy hit may still establish its historical citation.
    // A requested population count needs evidence that this scope was scanned.
    const requiredCount = selected.some(i => matchCounts.some(f => i.fields.includes(f.name)));
    const scans = matchCounts.length ? [...scopedScans(selected, observations)].filter(({attempt}) =>
      !requiredCount || (attempt.details.coverage?.truncated === false &&
        selected.every(i => !i.turn || attempt.details.coverage.turns?.includes(i.turn)))).map(({attempt, hits}) => ({
      callId: attempt.id,
      ...scanCounts(attempt, hits, observations),
    })) : [];
    const countScan = scans.find((scan) => matchCounts.every(({name, value, qualified}) => !qualified && scan[name] === value));
    if (countScan) {
      unit.countProof = {callId: countScan.callId, fields: matchCounts};
      const coverage = observations.attempts.find(a => a.id === countScan.callId)?.details?.coverage;
      unit.countOwners = coverage?.truncated === false ? selected.filter(i => !i.turn || coverage.turns?.includes(i.turn)) : [];
    }
    const listHeading = /(?:出处|来源|引用)(?:如(?:下|上)|如下所示)\s*[：:。.]?\s*$/u.test(s);
    const introducesFields = listHeading && selected.length && selected.every((i) => i.hits.length) &&
      [...explicitTurns(s)].every((round) => selected.every((i) => i.hits.some((w) => w.turn === round)));
    if (matchCounts.length && !countScan) {
      // A wrong count is not publishable. The heading still identifies
      // the subject of the list; every following field needs its own proof.
      historyFieldGroup = Boolean(introducesFields);
      // If the last predicate is unproved, the shared list may still give
      // the source of a proved sibling. Bind neutral rows only to that scan.
      if (!historyFieldGroup && listHeading && !now.test(s) && !negative.test(s)) {
        const siblings = accepted.filter(({unit: prior}) => prior.countProof && unit.parent && prior.parentStart === unit.parentStart);
        if (siblings.length) historyFieldGroup = [...new Set(siblings.flatMap(({unit: prior}) => prior.countOwners))];
      }
      rejectedChecks.push({start: unit.start, end: unit.end, relation: 'execution', fields: matchCounts, scans});
      rejected.push(s);
      continue;
    }
    const ledgerCount = s.match(/台账.*?(?:记录|命中).*?(\d+)\s*条/);
    if (ledgerCount) {
      const proof = [...scopedScans(selected, observations)].find(({attempt}) =>
        attempt.details.ledgerTotalMatches === Number(ledgerCount[1]))?.attempt;
      if (proof && !amount.test(s.replace('字面常量', '')))
        accept(unit, [], [], [{callId: proof.id}], 'ledgerCount');
      else rejected.push(s);
      continue;
    }
    if (/^(?:[-*] )?未核验[：:]/.test(s) && !/^未核验[：:]\s*无[。.]?$/.test(s)) {
      statedLimits.push(s);
      gaps.push(s);
      continue;
    }
    if (/^未核验[：:]\s*无[。.]?$/.test(visible.trim())) {
      accept(unit, [], [], [], 'qualification');
      continue;
    }
    const visibleUnit = visible.trim();
    // A reader may describe this predicate or its entire enclosing sentence.
    // Restrict a sentence receipt to the literals at this occurrence. Only
    // the locally selected tool result may corroborate those literals.
    let semantics = (meaning?.claims ?? []).flatMap(claim => {
      if (typeof claim.quote !== 'string' || !claim.quote.trim()) return [];
      const quote = visibleMarkdown(claim.quote).trim();
      if (s.includes(claim.quote) || (quote && visibleUnit.includes(quote))) return [claim];
      if (unit.parent && claim.relation === 'execution' && claim.polarity !== 'negative' &&
          unit.parent.includes(claim.quote) && quote.includes(visibleUnit))
        return [{...claim, quote: s, fields: (claim.fields ?? []).filter(f =>
          typeof f.literal === 'string' && visibleUnit.includes(f.literal))}];
      return [];
    });
    // A field/value row inherits the subject of its verified introducer.
    // Preserve explicit switches of time, negation and additional assertions.
    const sourceFields = semantics.length > 0 && semantics.every((claim) =>
      ['current', 'historical'].includes(claim.relation) && claim.polarity === 'positive' &&
      claim.fields?.length && claim.fields.every((field) =>
        ['materialId', 'version', 'locator', 'filename', 'displayFilename', 'storedFilename', 'id'].includes(field.name) &&
        typeof field.literal === 'string' && visibleUnit.includes(field.literal)));
    // A row-specific predicate does not change the subject of its siblings.
    // Close the group at a new prose unit, not at an independently dated row.
    if (!sourceFields && !/^\s*[-*]\s/.test(s)) historyFieldGroup = false;
    // A suppressed introduction may have established the historical
    // subject. On recheck, use only the exact retained span and a witness
    // that still has the same identity; the row itself must remain neutral.
    const previous = retainedHistory.get(unit.start);
    if (sourceFields && Array.isArray(historyFieldGroup) && !now.test(s)) {
      selected = selected.filter(i => historyFieldGroup.includes(i));
    }
    const witnessesHere = selected.flatMap((i) => i.hits);
    const previouslyBound = previous?.end === unit.end &&
      witnessesHere.some((w) => previous.citationIds.includes(w.citation.id) && previous.callIds.includes(w.callId));
    const inheritedRow = (historyFieldGroup || previouslyBound) && sourceFields &&
      neutralSourceRow(visibleUnit, witnessesHere);
    if (inheritedRow) semantics = semantics.map((claim) => ({...claim, relation: 'historical'}));
    const whole = semantics.find((c) => c.quote === s || visibleMarkdown(c.quote).trim() === visibleUnit);
    const executionClaims = semantics.filter((c) => c.relation === 'execution');
    const completeExecution =
      executionClaims.length &&
      executionClaims.length === semantics.length &&
      (whole ||
        !executionClaims
          .reduce((rest, c) => rest.replace(c.quote, ''), s)
          .replace(/[\s。，、；;,.：:]/g, ''));
    if (completeExecution || (countScan && introducesFields)) {
      const fields = completeExecution ? executionClaims.flatMap((c) => c.fields ?? []) : semantics.flatMap((c) => c.fields ?? []);
      const evidence = {relation: 'execution', fields: [...fields, ...matchCounts]};
      const attempt = executionReport(evidence, visibleUnit, selected, observations);
      if (attempt) {
        accept(unit, [], selected, [{callId: attempt.id}], 'execution');
        historyFieldGroup = Boolean(introducesFields && !now.test(s) && !negative.test(s));
      }
      else if (
        plan.route === 'history' &&
        decisions.every((i) => i.operation === 'source') &&
        !/覆盖|扫描|台账|是否截断|工具过程|检索过程/.test(question) &&
        !extractLocatorMatches(s).length &&
        !/\.xls[xm]|cite:|@v\d|\bv\d/i.test(s)
      )
        optionalNotes.push(s);
      else rejected.push(s);
      continue;
    }
    if (
      whole?.relation === 'scope' && !(reviewed && /估值|valuation/i.test(s)) &&
      !extractLocatorMatches(s).length &&
      !version.test(s) &&
      !/[\d%]/.test(s.replace(/第\s*\d+\s*轮/g, '')) &&
      !(whole.fields ?? []).length
    ) {
      accept(unit, [], [], [], 'scope');
      continue;
    }
    const heading = named.reduce((part, item) => part.replaceAll(item.query, ''), s);
    const count = heading.match(/([一二两三四五六七八九十\d]+)\s*(?:个|处|条|本)\s*(工作簿位置|单元格|坐标|来源|工作簿)/);
    const countValue = count && quantity(count[1]);
    const signedPositions = distinctWitnesses(selected.flatMap((i) => i.hits));
    const headingCount = count?.[2] === '工作簿'
      ? new Set(signedPositions.map((w) => w.citation.materialId)).size : signedPositions.length;
    if (
      selected.some((i) => i.hits.length) &&
      /出处|来源|引用/.test(s) &&
      whole?.relation === 'historical' &&
      whole.polarity === 'positive' &&
      !extractLocatorMatches(s).length && !version.test(heading) && !amount.test(heading) &&
      !now.test(heading) && !negative.test(heading) && !/\.xls[xm]/i.test(heading) &&
      (!count || countValue === headingCount) && text.slice(unit.end).trim() &&
      [...explicitTurns(s)].every((round) => selected.some((i) => i.hits.some((w) => w.turn === round))) &&
      selected.every((i) => i.hits.length) &&
      !s.includes('cite:') &&
      !(whole.fields ?? []).some((f) => !['turn', 'query'].includes(f.name))
    ) {
      historyFieldGroup = !now.test(s) && !negative.test(s);
      accept(unit, [], selected, [], 'introduction');
      continue;
    }
    const notes = resultReports(
      [s],
      decisions.map((i) => ({query: i.query || '\u0000'})),
      () => false,
    );
    const provesAbsence = item => {
      if (!item?.empty || item.hits.length) return false;
      const scan = observations.attempts.find(a => a.id === item.empty);
      return scan?.details?.totalMatches === 0 || item.book && !/(?:所有|全部)消息/u.test(countText) ||
        countPopulation(countText) === 'assistantMatches';
    };
    if (notes.length && !extractLocatorMatches(s).length) {
      const owners = notes.map((n) =>
        decisions.find((i) => (i.query || '\u0000') === n.query && (!n.turns.size || n.turns.has(i.turn))),
      );
      const proven = notes.every(
        (n, k) =>
          n.complete &&
          owners[k] &&
          (n.absent ? provesAbsence(owners[k]) : owners[k].hits.length),
      );
      if (!proven) {
        rejected.push(s);
        continue;
      }
      for (const [k, n] of notes.entries()) {
        if (n.absent) owners[k].state = 'confirmedEmpty';
        owners[k].delivered.add(n.absent ? 'absence' : 'presence');
      }
      accept(
        unit,
        [],
        owners,
        owners.flatMap((i) => (i.empty ? [{callId: i.empty}] : i.hits)),
        'searchResult',
      );
      continue;
    }
    if (absent.test(s) && !extractLocatorMatches(s).length) {
      const emptyOwners = selected.filter(provesAbsence);
      if (
        emptyOwners.length &&
        emptyOwners.length === selected.length &&
        (named.length || selected.length === 1)
      ) {
        emptyOwners.forEach((i) => {
          i.state = 'confirmedEmpty';
          i.delivered.add('absence');
        });
        accept(
          unit,
          [],
          emptyOwners,
          emptyOwners.map((i) => ({callId: i.empty})),
          'absent',
        );
      } else rejected.push(s);
      continue;
    }
    // A list introduction has no independent fact. Carry it with the
    // following list only when the list supplies an admissible witness.
    if (
      selected.some((i) => i.hits.length) &&
      /^[-*] /m.test(text.slice(unit.end).trimStart()) &&
      sourceFieldsOnly(s.replace(/如下[：:。.]?$/, ''), false)
    ) {
      historyFieldGroup = !now.test(s) && !negative.test(s);
      accept(unit, [], selected, [], 'introduction');
      continue;
    }
    const isRead =
      semantics.some((c) => c.relation === 'current') || (now.test(s) && !/今天(?:检索|查[询到])/.test(s));
    if (
      isRead &&
      currentDecision &&
      !direct.length &&
      /^(?:当前|目前)(?:材料)?版本(?:尚)?(?:无法|不能|未能)(?:核实|确认)(?:为\s*v?\d+)?[。.]?$/i.test(s)
    ) {
      currentDecision.delivered.add('limitation');
      accept(unit, [], [currentDecision], [], 'limitation');
      continue;
    }
    const rounds = explicitTurns(s);
    const sourcesFor = (i) => (named.length ? i.hits : [...i.hits, ...i.related]);
    const inScope = isRead ? direct :
      selected.flatMap(i => sourcesFor(i).filter(w => !rounds.size || rounds.has(w.turn)));
    // Resolve the link once per citation identity. Keep the distinct tool
    // observations establishing its use by each requested source turn.
    const eligible = distinctWitnesses(inScope);
    const available = eligible.map((w) => w.citation);
    const explicitIds = [];
    maskCitationIds(s, available, (c) => {
      if (c) explicitIds.push(c.id);
    });
    // A literal returned ID can resolve one otherwise ambiguous spelling in
    // this assertion. A second written locator still needs its own witness.
    const allNames = citationLookup(available);
    const hasAmbiguous = extractLocatorMatches(maskCitationIds(s, available)).some(
      (ref) => !resolveLocatorToken(ref.raw, allNames)?.citation && allNames.isAmbiguous(ref.key),
    );
    const pool =
      explicitIds.length === 1 && hasAmbiguous ? available.filter((c) => c.id === explicitIds[0]) : available;
    const lookup = citationLookup(pool);
    const literals = [];
    let invalidId = false;
    const masked = maskCitationIds(s, pool, (c) => {
      if (c) literals.push(c.id);
      else invalidId = true;
    });
    // A CJK field label can touch an unquoted sheet name. If the whole
    // token already names a real sheet it wins. Otherwise use the independently
    // aligned, witnessed literal only after an unambiguous field predicate.
    let locatorInput = masked;
    if (inheritedRow) {
      for (const ref of extractLocatorMatches(masked)) {
        if (resolveLocatorToken(ref.raw, lookup)?.citation || lookup.isAmbiguous(ref.key)) continue;
        const literal = whole?.fields?.find((f) => f.name === 'locator' && typeof f.literal === 'string' &&
          ref.raw.endsWith(f.literal) && resolveLocatorToken(f.literal, lookup)?.citation)?.literal;
        if (!literal) continue;
        const prefix = ref.raw.slice(0, -literal.length);
        if (!/^(?:单元格|坐标|原格)(?:为|是)$/.test(prefix)) continue;
        const start = ref.index;
        locatorInput = locatorInput.slice(0, start) + ' '.repeat(prefix.length) +
          locatorInput.slice(start + prefix.length);
      }
    }
    const rawRefs = extractLocatorMatches(locatorInput);
    const adopted = adoptedCitations(s, pool);
    const refs = rawRefs.map((r) => {
      const citation = resolveLocatorToken(r.raw, lookup)?.citation;
      return {...r, citation: adopted.find((c) => c.id === citation?.id) ?? citation};
    });
    const names = pool.filter((c) => citationFilenames(c).some((f) => visible.includes(f)));
    let fieldOwner =
      refs.at(-1)?.citation ||
      pool.find((c) => literals.includes(c.id)) ||
      (pool.some((c) => c.id === antecedent?.id) ? antecedent : undefined) ||
      (pool.length === 1 ? pool[0] : undefined);
    let wrongQualifier = false;
    const fieldText = s.replace(/\[([^\]\n]+)@v(\d+)\](?![\w'$])/gi, (token, name, v) => {
      const sources = pool.filter(
        (c) => c.version === Number(v) && [c.materialId, ...citationFilenames(c)].includes(name),
      );
      if (!sources.length || !sources.some((c) => c.id === fieldOwner?.id)) wrongQualifier = true;
      return ' '.repeat(token.length);
    });
    const fields = checkSourceFields(fieldText, rawRefs, lookup, fieldOwner, pool);
    const exact = refs.every((r) => r.citation && visible.includes(r.raw));
    const reviewedUnit =
      reviewed && review?.digest === digest(text) && !review.reviewUnavailable &&
      !review.openFindings?.some((f) => !f.excerpt || s.includes(f.excerpt)) &&
      (!reviewed.requiresSave || (review.written && !review.pending?.length));
    // A reviewed statement of insufficiency explains the requested read.
    // Its support is the direct observation of the scoped cell. It makes no
    // quantitative assertion and need not print the coordinate a second time.
    if (reviewedUnit && plan.sourceOnlyRead && direct.length === 1 && whole &&
        ['scope', 'financial'].includes(whole.relation) && !(whole.fields ?? []).length &&
        /估值|valuation/i.test(s) && /不足以|不能|无法|不够|不能够|cannot|insufficient/i.test(s) &&
        !/[\d%％!@]/.test(visible) && !amount.test(s.replace(/读数|数值/g, '')) &&
        !(lint?.(s, direct.map((w) => w.citation)) ?? []).some(blockingFinding)) {
      reviewed.state = 'answered';
      reviewed.delivered.add('reviewedAnswer');
      reviewed.attemptIds = direct.map((w) => w.callId);
      accept(unit, [], [reviewed], direct, 'reviewedRead');
      continue;
    }
    const reviewedAssertion = reviewedUnit && whole?.relation === 'financial' && whole.polarity === 'positive';
    if (reviewedAssertion) {
      const support = witnesses.filter(
        (w) =>
          w.relation === 'read' &&
          rawRefs.some((r) => resolveLocatorToken(r.raw, citationLookup([w.citation]))?.citation),
      );
      const receipts = distinctWitnesses(support).map((w) => w.citation);
      const typed = checkSourceFields(s, rawRefs, citationLookup(receipts), receipts[0], receipts);
      const targets = rawRefs.map((r) => ({
        ...r,
        citation: resolveLocatorToken(r.raw, citationLookup(receipts))?.citation,
      }));
      if (
        targets.length &&
        targets.every((r) => r.citation && visible.includes(r.raw)) &&
        !typed.conflict &&
        !typed.idConflict &&
        !(lint?.(s, receipts) ?? []).some(blockingFinding)
      ) {
        reviewed.state = 'answered';
        reviewed.delivered.add('reviewedAnswer');
        reviewed.attemptIds = support.map((w) => w.callId);
        accept(unit, targets, [reviewed], support, 'reviewedRead');
        continue;
      }
    }
    const contradicted =
      negative.test(masked) ||
      semantics.some((c) => c.polarity !== 'positive' || !['historical', 'current'].includes(c.relation)) ||
      badIds.some((id) => s.includes(id)) ||
      wrongQualifier ||
      invalidId ||
      (fields.conflict && !alignedFieldList(s, whole, fieldOwner, fields.conflict)) ||
      fields.idConflict;
    const legacy = reportedLocatorEvidence(
      s,
      question,
      direct.map((w) => w.citation),
      (isRead ? allHist : eligible)
        .filter((w) => w.relation === 'historical' && (isRead || pool.some((c) => c.id === w.citation.id)))
        .map((w) => ({turn: w.turn, citations: [w.citation]})),
      direct.map((w) => w.citation),
    );
    const semanticSource =
      semantics.length &&
      semantics.every(
        (c) => c.relation === (isRead ? 'current' : 'historical') && c.polarity === 'positive',
      ) &&
      semantics.some((c) => c.quote === s || visibleMarkdown(c.quote).trim() === visibleUnit);
    const literalProof = literals.length && literals.every((id) => visible.includes(id));
    const proof = !!fieldOwner && (refs.length || fields.hasFields || literalProof || names.length);
    const factualText = named.reduce((part, item) => part.replaceAll(item.query, ''), masked);
    const financial = amount.test(factualText);
    const positiveScope =
      semantics.length &&
      semantics.every((c) => c.relation === (isRead ? 'current' : 'historical') && c.polarity === 'positive');
    const checkedBody = fields.checked.replace(/^\s*[-*]\s+/gm, '');
    const qualifiedOnly = sourceFieldsOnly(checkedBody, fields.hasId);
    const described = meaning
      ? semanticSource || (positiveScope && !legacy.conflict) || qualifiedOnly
      : (literalProof && !refs.length && qualifiedOnly) ||
        (!legacy.conflict &&
          (qualifiedOnly ||
            legacy.historical?.length ||
            (isRead && (legacy.citations?.length || (fields.hasFields && !financial)))));
    let valid = proof && exact && !contradicted && !unsafeMarkdown.test(s) && described;
    if (
      [...visible.matchAll(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi)].some(
        (m) => !pool.some((c) => c.materialId === m[0]) && !eligible.some((w) => w.sourceTurnId === m[0]),
      )
    )
      valid = false;
    if (
      financial &&
      !isRead &&
      /[\d%]|涨|降/.test(
        extractLocatorMatches(fields.checked).reduceRight(
          (part, ref) => part.slice(0, ref.index) + part.slice(ref.index + ref.raw.length),
          fields.checked,
        ),
      )
    )
      valid = false;
    const writtenValue = visible
      .match(/(?:读数|数值|原始值|值)\s*(?:为|是|[:：])?\s*([-+\d,.]+)/)?.[1]
      ?.replaceAll(',', '');
    if (
      isRead &&
      financial &&
      !eligible.some((w) => w.citation.value != null && writtenValue === String(w.citation.value))
    )
      valid = false;
    if (
      isRead &&
      (!eligible.length ||
        (currentDecision?.conditional && currentDecision.condition !== true) ||
        (!currentDecision && /不重报读数|只问历史出处/.test(question)))
    )
      valid = false;
    // Separate the same verified boundary for the general linter. Preserve
    // the original text and its offsets for persistence and browser clicks.
    const lintText = locatorInput === masked ? s : rawRefs.reduceRight((out, ref) =>
      out.slice(0, ref.index) + ' ' + out.slice(ref.index), s);
    const findings = lint?.(lintText, pool) ?? [];
    if (findings.some((f) => blockingFinding(f) && f.rule !== 'incomplete')) valid = false;
    if (!valid) {
      rejectedChecks.push({
        start: unit.start,
        end: unit.end,
        claims: semantics.map((c) => c.relation),
        relation: isRead ? 'current' : 'historical',
        ...(isRead && !readItem && now.test(s) && version.test(s) && !financial && !refs.length &&
          !/[，,；;]/.test(s) && !/(?:当时|当初|曾经|历史)/.test(s)
          ? {unrequestedCurrentVersion: true} : {}),
        eligible: eligible.map((w) => [w.callId, w.citation.id]),
        condition: currentDecision?.condition,
        proof: Boolean(proof),
        exact,
        contradicted,
        described: Boolean(described),
        findings: findings.filter(blockingFinding).map(({rule, code, message}) => ({rule, code, message})),
      });
      rejected.push(s);
      antecedent = undefined;
      continue;
    }
    const touched = new Set([...refs.map((r) => r.citation.id), ...literals]);
    if (!touched.size) touched.add(fieldOwner.id);
    const matches = inScope.filter(w => touched.has(w.citation.id));
    const answering = selected.filter(i => i.hits.some(w => matches.includes(w)));
    const owners = isRead
      ? [currentDecision ?? optionalRead]
      : answering.length
        ? answering
        : selected.filter(i => sourcesFor(i).some(w => matches.includes(w)));
    if (!owners.length) {
      rejected.push(s);
      continue;
    }
    for (const i of owners) {
      if (refs.length) i.delivered.add('locator');
      if (version.test(masked)) i.delivered.add('version');
      if (names.length) i.delivered.add('filename');
      if (literalProof) i.delivered.add('id');
      if (isRead) {
        i.attemptIds = [...new Set([...i.attemptIds, ...matches.map((w) => w.callId)])];
        if (writtenValue !== undefined && matches.some((w) => writtenValue === String(w.citation.value)))
          i.delivered.add('value');
      }
      if (refs.length || literalProof) i.delivered.add('presence');
    }
    antecedent = fieldOwner;
    accept(unit, refs, owners, matches, isRead ? 'current' : 'historical');
  }
  const hostRepair = optionalNotes.length > 0;
  for (const i of decisions) {
    if (i.state === 'confirmedEmpty') {
      const missingCount = i.fields.some(f => ['totalMatches', 'assistantMatches', 'ledgerMatches', 'textOccurrences', 'uniqueWorkbooks'].includes(f) && !i.delivered.has(f));
      if (missingCount) i.state = 'unresolved';
      continue;
    }
    const unique = distinctWitnesses(i.hits);
    if (
      i.fields.includes('id') &&
      !i.delivered.has('id') &&
      i.delivered.has('locator') &&
      unique.length === 1 &&
      !rejected.length &&
      repairId &&
      !text.includes('cite:')
    ) {
      const amended = text.trimEnd() + '\n\n完整 citation.id：' + unique[0].citation.id;
      const outcome = evaluateSourceDraft({
        text: amended,
        question,
        plan,
        observations,
        currentVersions,
        meaning,
        lint,
        review,
        repairId: false,
      });
      return {...outcome, hostRepair: true};
    }
    if (
      i.hits.length &&
      i.delivered.has('presence') &&
      (!i.needsLocator || i.delivered.has('locator')) &&
      i.fields.every((f) => i.delivered.has(f))
    )
      i.state = 'answered';
  }
  if (
    currentDecision &&
    currentDecision.state !== 'notApplicable' &&
    currentDecision.fields.every((f) => currentDecision.delivered.has(f))
  )
    currentDecision.state = 'answered';
  for (const item of attachments) if (item.fields.every(f => item.delivered.has(f))) item.state = 'answered';
  const fieldLabels = {
    id: '完整引用 ID', filename: '工作簿名', version: '材料版本', locator: '单元格',
    value: '当前读数', totalMatches: '全部消息的检索命中数', assistantMatches: '助手正式答文的检索命中数',
    ledgerMatches: '台账命中数', textOccurrences: '原文字串出现次数', uniqueWorkbooks: '去重后的工作簿数', reviewedAnswer: '经审校的说明',
  };
  const items = [
    ...decisions,
    ...(currentDecision ? [currentDecision] : optionalRead.attemptIds.length ? [optionalRead] : []),
    ...attachments,
    ...(reviewed ? [reviewed] : []),
  ].map(({hits, related, empty, delivered, ...i}) => {
    if (i.state === 'unresolved') {
      const label = [
        i.turn ? '第' + i.turn + '轮' : '',
        i.query,
        i.book,
        i.action === 'readAttachment' ? '附件 ' + i.filename :
          i.action === 'review' ? '研究审校与直接取证' : i.action === 'read' ? '同一材料当前状态' : '历史出处',
      ]
        .filter(Boolean)
        .join(' ');
      const required = new Set(i.fields);
      if (i.needsLocator) required.add('locator');
      const missing = [...required].filter((field) => !delivered.has(field));
      const detail = missing.map((field) => fieldLabels[field] ?? field).join('、');
      i.reason = '未核实或未完整交付：' + label + (detail ? '（缺少' + detail + '）' : '');
      gaps.push(i.reason);
    }
    return {...i, fieldsDelivered: [...delivered], ...(empty ? {emptyCallId: empty} : {})};
  });
  if (rejected.length) gaps.push('有可见陈述缺少相符的来源或超出本轮证据。');
  // Final coverage decides whether "nothing unverified" is true. Render
  // the selected units once so that all offsets refer to this exact text.
  let body = '', priorEnd = 0;
  const adjacent = (a, b) => a && b && a.parentStart === b.parentStart && !text.slice(a.end, b.start).trim();
  for (const [index, {unit, refs, owners, ws, relation}] of accepted.entries()) {
    if (relation === 'qualification' && gaps.length) continue;
    if (body) {
      const separator = text.slice(priorEnd, unit.start);
      body += /^\s*$/.test(separator) ? separator : '\n';
    }
    const offset = body.length;
    const prev = accepted[index - 1]?.unit;
    const next = accepted[index + 1]?.unit;
    // Copy a shared emphasis marker only when its original partner belongs
    // to omitted text. With both fields retained the Markdown is byte-exact.
    const open = unit.open && !adjacent(prev, unit) ? unit.open : '';
    const close = unit.close && !adjacent(unit, next) ? unit.close : '';
    body += open + unit.value + close;
    priorEnd = unit.end;
    const itemIds = owners.map((item) => item.id);
    claims.push({
      start: offset,
      end: body.length,
      relation,
      itemIds,
      ...(unit.countProof ? {searchCounts: unit.countProof} : {}),
      ...(unit.attachmentField ? {field: unit.attachmentField, attachmentQuotes: unit.attachmentProofs} : {}),
      citationIds: [...new Set(ws.map((w) => w.citation?.id).filter(Boolean))],
      callIds: [...new Set(ws.map((w) => w.callId))],
      sourceTurns: [...new Set(ws.map((w) => w.sourceTurnId ?? w.legacyAnchor).filter(Boolean))],
    });
    for (const {raw, index, citation} of refs) {
      citations.set(citation.id, citation);
      occurrences.push({
        start: offset + index,
        end: offset + index + raw.length,
        text: raw,
        citationId: citation.id,
      });
    }
  }
  if (!gaps.length && !rejected.length && body.trim() === text.trim()) {
    const shift = text.indexOf(body);
    for (const r of [...claims, ...occurrences]) {
      r.start += shift;
      r.end += shift;
    }
    body = text;
  }
  if (
    !claims.some(
      (c) =>
        c.callIds.length &&
        ((!['execution', 'ledgerCount'].includes(c.relation) &&
          (c.relation !== 'searchResult' || decisions.some((i) => i.operation === 'exists'))) ||
          c.searchCounts?.fields.some(f => decisions.some(i => c.itemIds.includes(i.id) && i.fields.includes(f.name)))),
    )
  ) {
    body = '';
    claims.length = 0;
    occurrences.length = 0;
    citations.clear();
  }
  const status = body ? (gaps.length ? 'partial' : 'completed') : 'failed';
  return {
    status,
    text: body,
    citations: [...citations.values()],
    ...(gaps.length ? {reason: gaps.join('；')} : {}),
    hostRepair,
    sourceDelivery: {schema: 1, planRev: plan.rev, textDigest: digest(body), items, claims, occurrences},
    rejected,
    rejectedChecks,
    optionalNotes,
    statedLimits,
  };
}
