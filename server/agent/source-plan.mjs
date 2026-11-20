import {createHash} from 'node:crypto';
import {attachmentRequests} from './source-attachments.mjs';
import {classifyQuestion} from '../../lib/turn-context.mjs';
import {asksHistoricalSource, explicitTurns} from './answer-delivery.mjs';
import {requestedSearches, requestedWorkbooks} from './transcript-search-recovery.mjs';

export const digest = (text) => createHash('sha256').update(text).digest('hex');
const quoted = /[“「『"]([^”」』"\n]+)[”」』"]/g;
const history =
  /历史|前文|上(?:一)?轮|首轮|第\s*[一二三四五六七八九十\d]+\s*轮|正式答文|已交付回答|previous answer|earlier answer/i;
const queryVerb = /搜|查|检索|search|look up/i;
const current = /当前|现在|最新|今天|today|current/i;
const sourceId = /(?:完整(?:的)?\s*(?:引用\s*)?ID|引用\s*ID|citation[._ ]id)/i;
const workbook = /[\w.+-]+\.xls[xm]\b/gi;

function span(text, literal) {
  const start = text.indexOf(literal);
  return start < 0 ? null : [start, start + literal.length];
}

// This inventory is taken from the question only. It never sees the proposed
// searches, assistant text, tool arguments or subsequent execution results.
function inventory(question) {
  const terms = [];
  for (const field of question.matchAll(quoted)) {
    const before = question.slice(0, field.index);
    const clause = before.split(/[。；;！？\n]/).at(-1);
    if (/^(?:完整|引用|材料|单元格|citation[._ ]id)/i.test(field[1]) && !queryVerb.test(clause)) continue;
    if (
      queryVerb.test(clause) ||
      /是否引用|是否命中/.test(
        question.slice(field.index + field[0].length, field.index + field[0].length + 12),
      )
    ) {
      terms.push({query: field[1], range: [field.index + 1, field.index + 1 + field[1].length]});
    }
  }
  const books = [...question.matchAll(workbook)]
    .filter((m) => !terms.some((x) => x.range[0] <= m.index && m.index < x.range[1]))
    .map((m) => m[0]);
  const asksHistory =
    history.test(question) && (queryVerb.test(question) || /格|来源|出处|引用|回答|版本/.test(question));
  return {terms, books, asksHistory};
}

// Quoted historical search operands are data supplied to the search tool.
export function assertionQuestion(question, plan) {
  const chars = question.split('');
  for (const item of plan.items) {
    if (item.action !== 'search' || !item.query || !item.range) continue;
    const [start, end] = item.range;
    if (question.slice(start, end) === item.query) chars.fill(' ', start, end);
  }
  return chars.join('');
}

export function modelPlan(plan) {
  if (plan.route === 'ordinary') return null;
  return JSON.stringify({
    revision: plan.rev,
    items: plan.items.map((i) => ({
      id: i.id,
      action: i.action,
      ...(i.action === 'search'
        ? {
            tool: 'transcript_search',
            args: {
              ...(i.query ? {query: i.query} : {}),
              ...(i.turn != null ? {turn: i.turn} : {}),
            },
            role: 'assistant',
            material: i.book ?? undefined,
          }
        : {}),
      ...(i.action === 'readAttachment' ? {material: i.filename, ...(i.path ? {tool: 'read', args: {path: i.path}} : {})} : {}),
      fields: i.fields,
      condition: i.conditional ? i.predicate : undefined,
    })),
    unresolved: plan.gaps,
  });
}

// Use the same capabilities before Pi normalizes the tool list and when
// measuring the final provider payload. Audit and synthesis keep their
// original no-tool context; broad research retains its granted tools.
export function sourceBusinessTools(plan, options) {
  if (!plan || plan.route === 'ordinary' || options?.sourceOperation ||
      !['answer', 'research-draft', 'research-repair'].includes(options?.sourceStage ?? 'answer'))
    return;
  if (plan.research && !plan.sourceOnlyRead) return;
  const tools = new Set();
  for (const item of plan.items) {
    if (item.action === 'search') tools.add('transcript_search');
    if (item.action === 'readAttachment' && item.path) tools.add('read');
    if (item.action === 'read') {
      tools.add('workbook_query');
      tools.add('workbook_trace');
    }
  }
  return tools;
}

// Identity of the counted rows is independent of their cardinality.
export function countPopulation(text) {
  if (/出现|字串|字样|字面次数/u.test(text)) return 'textOccurrences';
  if (/(?:去重|不同|不重复)/u.test(text) && /工作簿/u.test(text)) return 'uniqueWorkbooks';
  if (/台账|账本|ledger/iu.test(text)) return 'ledgerMatches';
  if (/(?:其中|某|特定|指定)(?:的)?一?类|排除助手|不(?:含|计|包括)助手|仅(?:计|算)用户|去重|不同(?:材料|来源)|按.{0,6}(?:类别|类型)/u.test(text)) return;
  const excludesUser = /(?:排除|不含|不包括|不计入?|去掉|除去)用户/u.test(text);
  const includesUser = /全部消息|所有消息|用户消息也算/u.test(text) ||
    (!excludesUser && /(?:含|包括|计入)用户/u.test(text));
  if (includesUser && excludesUser) return;
  if (includesUser) return 'totalMatches';
  if (excludesUser || /助手|正式(?:答文|回答)|回答中/u.test(text)) return 'assistantMatches';
  if (/用户|附件|引用数/u.test(text)) return;
  return 'totalMatches';
}

const countRequest = /(?:命中|匹配)[^。？！；，,]{0,18}?(?:几|多少)\s*(?:条|处|项|个)|(?:命中|匹配)(?:的)?(?:数(?:量)?|总数)|(?:多少|几)(?:条|个)(?:消息|回答|答文).{0,8}?(?:命中|匹配)/u;

// Separate repeated predicates at their own ends, regardless of how they
// are joined. Several coordinated nouns may also share one final predicate.
function* countOperands(sentence) {
  const predicates = [...sentence.matchAll(new RegExp(countRequest, 'gu'))];
  const breaks = new Map(predicates.slice(0, -1).map(m => {
    const end = m.index + m[0].length;
    return [end, {end, shared: false}];
  }));
  const joins = /[;；、]|以及|另请|并分别|[和与及，,](?=\s*(?:助手|全部|所有))/gu;
  for (const m of sentence.matchAll(joins)) {
    breaks.set(m.index, {end: m.index + m[0].length, shared: /^(?:[，,、和与及]|以及)$/u.test(m[0])});
  }
  let begin = 0;
  for (const [end, cut] of [...breaks].sort(([a], [b]) => a - b)) {
    if (end > begin) yield {begin, end, shared: cut.shared};
    begin = Math.max(begin, cut.end);
  }
  if (begin < sentence.length) yield {begin, end: sentence.length, shared: false};
}

// Keep the identity of each named search. A quoted target is one operand;
// in unquoted text, consume a complete longer name before any substring.
export function queryReferences(text, items) {
  const terms = [...new Set(items.map(item => item.query?.toLowerCase()).filter(Boolean))];
  if (!terms.length) return [];
  const alternatives = terms.sort((a, b) => b.length - a.length)
    .map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(quoted.source + '|' + alternatives.join('|'), 'giu');
  return [...text.matchAll(pattern)].map(match => {
    const query = (match[1] ?? match[0]).toLowerCase();
    return {query, known: terms.includes(query), start: match.index, end: match.index + match[0].length};
  });
}

function admitCounts(question, plan) {
  const searches = plan.items.filter(i => i.action === 'search');
  const masked = assertionQuestion(question, plan);
  const asksCount = text => countRequest.test(text) ||
    /出现|字串|字样|去重|不重复|不同(?:材料|工作簿)/u.test(text) && /几|多少|次数|数量|总数/u.test(text);
  for (const sentence of question.matchAll(/[^。？！!?\n]+/gu)) {
    const context = sentence[0];
    if (!asksCount(masked.slice(sentence.index, sentence.index + context.length))) continue;
    const names = new Set(queryReferences(context, searches).map(ref => ref.query));
    const named = searches.filter(i => names.has(i.query?.toLowerCase()));
    const scoped = named.length ? named : searches;
    // Keep a shared subject for coordinated counts, but let an operand
    // or turn in an individual part narrow its own obligation.
    for (const {begin, end, shared} of countOperands(masked.slice(sentence.index, sentence.index + context.length))) {
      const part = context.slice(begin, end);
      const at = sentence.index + begin;
      const predicate = masked.slice(at, sentence.index + end);
      const sharedCount = shared && /(?:全部消息|所有消息|助手(?:正式)?(?:答文|回答|消息))(?:数)?\s*$/u.test(predicate);
      if (!asksCount(predicate) && !sharedCount) continue;
      const localNames = new Set(queryReferences(part, scoped).map(ref => ref.query));
      const terms = scoped.filter(i => localNames.has(i.query?.toLowerCase()));
      const rounds = explicitTurns(predicate);
      const owners = (terms.length ? terms : scoped).filter(i => !rounds.size || rounds.has(i.turn));
      const population = countPopulation(predicate);
      if (!owners.length || !population) {
        plan.gaps.push('需确定检索命中数的统计对象及范围：' + part);
        continue;
      }
      for (const item of owners) {
        if (!item.fields.includes(population)) item.fields.push(population);
        (item.countRequests ??= []).push({field: population, range: [at, sentence.index + end]});
      }
    }
  }
}

const normalize = (s) => s.trim().toLowerCase().replace(/\s+/g, ' ');
export async function prepareSourcePlan(active, entry) {
  const question = active.question;
  const audited = inventory(question);
  const proposal = requestedSearches(question);
  const scope = [...explicitTurns(question)];
  const items = [],
    gaps = [];
  const branch = entry.session.sessionManager?.getLeafId?.() ?? null;
  const plan = {
    schema: 1,
    turnId: active.turnId,
    project: entry.ctx?.id,
    session: entry.id,
    branch,
    questionDigest: digest(question),
    rev: 1,
    route: 'ordinary',
    items,
    gaps,
  };
  // Classify the object of the request independently of its search verb.
  // An ordinal by itself might name a cell; a reference to a reply plus
  // requested provenance fields refers to the conversation.
  const asksFields = /出处|来源|引用|单元格|工作簿|哪本|哪一格|citation[._ ]?id|workbook|which cell/i.test(question);
  // The location of the forthcoming output is a modifier, not its object.
  // Remove only that unqualified location; retain a past or ordinal modifier.
  const referents = question.replace(/(?:请)?在(?:本次|本轮|这次|接下来(?:的)?)?(?:回答|答复|回复|正文)(?:中|里)/gu, '');
  const replySubject = /答复|回复|答文|答过|回答(?:中|里|用|引用|所|的)|发给我|你.{0,6}(?:说过|提到过|写过)|(?:your|previous|earlier) (?:reply|answer|message)/i.test(referents);
  // A reply can be the requested output or an existing object of enquiry.
  // Only an identifiable earlier reply or a question about its provenance
  // obliges us to search. Have the independent reader resolve weaker cues.
  const earlierReply = scope.length > 0 || history.test(question) ||
    /发给我(?:的|过)|(?:说|写|答|提到)过|(?:这|那)(?:篇|条|份)(?:答复|回复|回答)|previous|earlier/i.test(question);
  const asksProvenance = /(?:用|据|引|出自).{0,8}(?:哪|什么)|(?:哪本|哪一格)|(?:出处|来源)(?:是|为|在哪)|完整.{0,8}(?:引用|citation)/i.test(question);
  const refersToAnswer = asksFields && replySubject && (earlierReply || asksProvenance);
  const sourceRequest = refersToAnswer ||
    (audited.asksHistory &&
      (audited.terms.length > 0 || /检索结果|有无|是否|出处|引用|来源|单元格/.test(question))) ||
    asksHistoricalSource(question) ||
    (/transcript_search/.test(question) && /出处|引用|单元格|工作簿|有无|是否|检索结果/.test(question));
  // A short pronoun with no qualified operand needs the independent reader.
  const ambiguous = !sourceRequest && /刚才那|之前那|earlier one|that earlier/i.test(question);
  const previousAnswer = entry.session.messages?.some((m) => m.role === 'assistant');
  const implicitSubject = previousAnswer && asksFields &&
    (sourceId.test(question) || /(?:那|上述|所用|提到的|所据|that|those)/i.test(question)) &&
    !/上传|附件|直接读|打开文件/.test(question);
  const plain =
    !sourceRequest &&
    !ambiguous &&
    !(previousAnswer && audited.terms.length && !audited.books.length) &&
    !audited.asksHistory &&
    !(proposal.length && /聊天|本会话|对话|答复|前文|记录里|transcript|conversation/i.test(question)) &&
    !implicitSubject &&
    !(asksFields && replySubject) &&
    !/以前|之前|方才|前面|当时|旧答|上文|过去|earlier|previous/i.test(question);
  plan.inventory = {rounds: scope, terms: audited.terms, books: audited.books, sourceRequest, plain};
  // An unqualified self-audit has its own coverage, ledger and correction
  // checks. A reference to earlier text alone does not change that operation.
  const selfAudit = !sourceRequest && !implicitSubject && !ambiguous && !asksFields &&
    !audited.terms.length && classifyQuestion(question).includes('selfaudit');
  if (plain || selfAudit) return plan;
  let interpretation;
  if (entry.readSourceLanguage) {
    interpretation = await entry.readSourceLanguage('request', {question}, active);
  }
  if (!sourceRequest && interpretation?.kind === 'ordinary' && !ambiguous && !audited.terms.length)
    return plan;
  if (!sourceRequest && !['history', 'mixed'].includes(interpretation?.kind))
    gaps.push('需确定所指的历史答文。');
  const literalTerms = new Map(audited.terms.map((x) => [normalize(x.query), x]));
  for (const term of proposal) {
    if (current.test(term.query) && !literalTerms.has(term.query)) continue;
    const range = span(question.toLowerCase(), term.query);
    if (range) literalTerms.set(term.query, {query: question.slice(...range), range, turns: term.turns});
  }
  const modelItems = Array.isArray(interpretation?.items) ? interpretation.items : [];
  for (const item of modelItems) {
    if (
      item.action !== 'search' ||
      !item.term ||
      typeof item.term !== 'string' ||
      !question.includes(item.term)
    )
      continue;
    const key = normalize(item.term);
    if (
      !literalTerms.has(key) &&
      (audited.terms.length === 0 || audited.terms.some((t) => normalize(t.query) === key))
    )
      literalTerms.set(key, {query: item.term, range: span(question, item.term)});
  }
  const count = question.match(/([两二三四五六七八九\d]+)个(?:关键词|词|对象)/);
  if (count) {
    const expected = Number(count[1]) || '一二三四五六七八九'.indexOf(count[1].replace('两', '二')) + 1;
    if (expected && expected !== literalTerms.size) gaps.push('请求列举的检索目标尚未全部定位。');
  }
  const restricted = requestedWorkbooks(question);
  const books = restricted.length ? restricted : audited.books;
  const hasCurrent = current.test(question) && /版本|同一格|当前值|数值|读数|值为|哪一版/.test(question);
  const conditional = /(?:仅当|只有|若|如果|如有|when |only if )/.test(question) && hasCurrent;
  const existence = /是否|有没有|有无|分别说明.{0,12}检索结果|逐项说有无/i.test(question);
  const fields = [];

  if (
    sourceId.test(question) &&
    !/(?:可(?:以)?(?:注明|省略)|不必|无需|不要)[^。，；]{0,6}(?:引用\s*ID|citation\.id)/i.test(question)
  )
    fields.push('id');
  if (/版本/.test(question) && !/有材料版本时可以注明|可(?:以)?(?:注明|列出).{0,4}版本/.test(question))
    fields.push('version');
  if (/工作簿|哪本|哪个文件/.test(question) && /报告|给出|哪本|哪个文件|出处/.test(question))
    fields.push('filename');
  const terms = literalTerms.size ? [...literalTerms.values()] : [{query: null, range: [0, question.length]}];
  for (const term of terms) {
    for (const round of term.turns?.length ? term.turns : scope.length ? scope : [null]) {
      for (const book of books.length ? [...new Set(books)] : [null]) {
        items.push({
          id: 'i' + (items.length + 1),
          action: 'search',
          query: term.query,
          turn: round,
          book,
          range: term.range,
          operation: existence ? 'exists' : 'source',
          fields: [...fields],
          needsLocator: !existence || /单元格|原格|出处|坐标|来源/.test(question),
        });
      }
    }
  }
  const requested = assertionQuestion(question, plan);
  admitCounts(question, plan);
  let predicate;
  if (conditional) {
    const start = question.search(/仅当|只有|若|如果|如有|when |only if /i);
    const conditionText = question.slice(start).split(/[，,；;。]/)[0];
    const named = items.filter((i) => i.query && conditionText.includes(i.query));
    const ordinal = conditionText.match(/第([一二三四五六七八九\d]+)项/);
    const number = ordinal && (Number(ordinal[1]) || '一二三四五六七八九'.indexOf(ordinal[1]) + 1);
    const all = /(?:都|均|两项|全部|任一|或)/.test(conditionText);
    const parents = named.length
      ? named
      : number
        ? [items[number - 1]].filter(Boolean)
        : all || items.length === 1
          ? items
          : [];
    predicate = {
      all: !/(?:任一|或)/.test(conditionText),
      negate: /未(?:命中|引用)|没有|无匹配/.test(conditionText),
      items: parents.map((i) => i.id),
      range: span(question, conditionText),
    };
    if (!parents.length) gaps.push('条件尚未对应到具体检索事项：' + conditionText);
  }
  const attachments = attachmentRequests(question, active.attachments, entry.ctx?.store, modelItems);
  items.push(...attachments.items);
  gaps.push(...attachments.gaps);
  for (const proposed of modelItems) {
    if (proposed.action !== 'read' || typeof proposed.quote !== 'string' || !proposed.quote ||
        !question.includes(proposed.quote) || attachments.handled.has(proposed)) continue;
    const quote = proposed.quote;
    if (hasCurrent && current.test(quote) && /同一|该格|原格|版本|当前值|读数/u.test(quote) &&
        !/附件|备忘录|\.[a-z0-9]{2,5}\b/iu.test(quote)) continue;
    if (sourceRequest && /(?:所|曾|当时)?引用(?:的|过的)|原出处/u.test(quote) &&
        !/读取|读回|打开|实读|核对(?:工作簿|原件)|read (?:the |from )?file/i.test(quote)) continue;
    gaps.push('原问包含尚未对齐的读取要求：' + quote);
  }
  if (interpretation?.kind === 'pending') gaps.push('独立清点尚未确定原问的范围。');
  if (hasCurrent)
    items.push({
      id: 'now',
      action: 'read',
      time: 'current',
      range: span(question, question.match(current)[0]),
      fields: /本轮.{0,12}读数|当前值|现在.{0,20}(?:读数|值)|同一格.{0,12}读数/.test(question)
        ? ['version', 'value', 'locator']
        : ['version'],
      dependsOn: items[0].id,
      conditional,
      predicate,
    });
  if (ambiguous && !literalTerms.size && !scope.length) gaps.push('需要确定所指的回合或检索对象。');
  plan.route = gaps.length ? 'pending' : hasCurrent || interpretation?.kind === 'mixed' ? 'mixed' : 'history';
  plan.research = Boolean(interpretation?.research || /研究报告|估值分析|投资建议|撰写报告/.test(question));
  if (plan.research) {
    plan.route = gaps.length ? 'pending' : 'mixed';
    items.push({
      id: 'research',
      action: 'review',
      range: [0, question.length],
      fields: ['reviewedAnswer'],
      requiresSave: /保存|写入|写成.{0,8}报告/.test(question),
    });
  }
  const review = items.find((i) => i.action === 'review');
  if (review && hasCurrent && !review.requiresSave && gaps.every(gap => attachments.gaps.includes(gap)) &&
      items.filter((i) => i.action === 'search').length === 1) {
    const read = items.find((i) => i.action === 'read');
    // Resolve the object of the interpretation and its input. A sufficiency
    // question about this read uses the same evidence regardless of how the
    // user introduces it. Additional research operations keep the full lane.
    const clauses = requested.split(/[。？！；，,;：:\n]|(?:同时|并且|并请|然后|另外|此外)/u)
      .map((part) => part.trim()).filter(Boolean);
    const sameCell = /同一(?:份|本|个)?(?:材料|文件|工作簿)|同一格/.test(requested);
    const sufficiency = clauses.find((part) =>
      /(?:这个|该|这(?:一)?(?:个|项|格)|该格|单(?:一|个)).{0,6}(?:值|读数|数据|数字)|这个读数/.test(part) &&
      /能否|是否|可否|足以|能不能|够不够/.test(part));
    const extraOperations = /联网|上网|外部|市场行情|可比公司|同业|研报|调研|审批|批准|写回|改写|修改|下载|报告文件|web_search|web_fetch/i;
    if (sameCell && sufficiency && read.fields.includes('value') &&
        !extraOperations.test(requested) &&
        clauses.every((part) => part === sufficiency ||
          attachments.items.some(i => question.slice(...i.range).includes(part)) ||
          /(?:第.{1,5}轮|来源|出处|工作簿|原格|版本|引用|只读|同一|当前值|聊天|答复|citation)/i.test(part))) {
      review.inputItemId = read.id;
      review.range = span(question, sufficiency);
      review.operation = 'assessRead';
    }
  }
  plan.sourceOnlyRead = review?.operation === 'assessRead';
  plan.inventory = {
    turns: scope, refersToAnswer,
    terms: audited.terms,
    books,
    requiredCount: count?.[1],
    proposedTerms: proposal.map((p) => p.query),
    independent: interpretation ?? null,
  };
  return plan;
}
