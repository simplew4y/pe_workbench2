import {createHash} from 'node:crypto';
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
      fields: i.fields,
      condition: i.conditional ? i.predicate : undefined,
    })),
    unresolved: plan.gaps,
  });
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
  const replySubject = /答复|回复|答文|答过|回答(?:中|里|用|引用|所|的)|发给我|你.{0,6}(?:说过|提到过|写过)|(?:your|previous|earlier) (?:reply|answer|message)/i.test(question);
  const refersToAnswer = asksFields && replySubject;
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
  const unresolvedRead = modelItems.some(
    (i) =>
      i.action === 'read' &&
      typeof i.quote === 'string' &&
      i.quote &&
      question.includes(i.quote) &&
      !hasCurrent &&
      // A request for fields of the cited source is already covered by the
      // historical item. Keep an independently proposed file inspection open.
      !(
        sourceRequest &&
        /(?:所|曾|当时)?引用(?:的|过的)|原出处/.test(i.quote) &&
        !/读取|读回|打开|实读|核对(?:工作簿|原件)|read (?:the |from )?file/i.test(i.quote)
      ),
  );
  if (unresolvedRead) gaps.push('原问包含尚未对齐的读取要求。');
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
  plan.sourceOnlyRead = Boolean(plan.research && hasCurrent &&
    /同一(?:份|本|个)?(?:材料|文件|工作簿)|同一格/.test(question) &&
    /(?:仅凭|只凭|只据|仅依据|仅根据)[^。！？]{0,20}(?:格|读数|值)/.test(question) &&
    !items.some((i) => i.requiresSave));
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
