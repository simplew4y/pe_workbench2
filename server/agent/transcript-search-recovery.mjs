import { parseStreamingJson } from '@earendil-works/pi-ai';
import { citationLookup } from '../../lib/citations.mjs';
import { explicitTurns } from './answer-delivery.mjs';
import { citationFilenames, locatorKey, maskCitationIds, resolveLocatorToken } from '../../lib/citation-locator.mjs';

const SEARCH = /(?:查询|检索|搜索|查找|查(?:一下)?|\bsearch\b)(?!结果|记录|(?:命中|匹配)(?:总数|数量|数))/i;
// Keep punctuation in a quoted search term literal.
const CLAUSES = /((?:“[^”]*”|「[^」]*」|『[^』]*』|"[^"]*"|'[^']*'|[^“「『"'。！？；;，,\n])+)([。！？；;，,\n]*)/g;
const KEYWORD = /^(?:关键词|关键字|字词|短语)?\s*[:：]?\s*/;

function queryKey(query) {
  return typeof query === 'string' ? query.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

// transcript_search accepts separate keywords. A workbook and a cell can
// spell one requested [workbook]Sheet!A1 only if the actual formal hit
// contains that whole literal and resolves it to its returned citation.
export function matchesQuery(requested, call, turn) {
  const actual = queryKey(call.args?.query);
  if (requested === actual) return true;
  const token = /^\[([^\]]+)\](.+)$/.exec(requested);
  if (!token || !locatorKey(token[2]) || actual !== queryKey(token[1] + ' ' + token[2])) return false;
  return call.details?.matches?.some(hit => hit.role === 'assistant' && (!turn || hit.turn === turn) &&
    queryKey(hit.excerpt?.replaceAll('**', '')).includes(requested) &&
    resolveLocatorToken(requested, citationLookup(hit.citations ?? []))?.citation);
}

// Bind literal operands to the search that introduces them. Quoted output
// fields later in a request (e.g. 报告“完整 ID”) are not additional queries.
export function requestedSearches(question) {
  const targets = [];
  const rounds = explicitTurns(question);
  // A comma may separate literal operands, clauses or even be inside
  // the search string. Keep adjacent quoted operands with their verb.
  let listTurns;
  let enumerated;
  for (const [, clause, delimiter] of question.matchAll(CLAUSES)) {
    const continuation = listTurns && (/^\s*(?:以及|还有|和|及|与|、|and\b)?\s*[“「『"']/.test(clause) ||
      enumerated && !/说明|报告|返回|出处|完整|列出|给出|请|只看/.test(clause));
    // Find verbs outside quotes: a literal search term can contain “查询”.
    const verb = SEARCH.exec(clause.replace(/[“「『"']([^”」』"'\n]*)[”」』"']/g, m => ' '.repeat(m.length)));
    if (!continuation && !verb) {
      listTurns = undefined;
      continue;
    }
    if (verb) enumerated = /分别|(?:两|二|[三四五六七八九十\d]+)个(?:词|关键词)|以下(?:词|关键词)/.test(clause);
    const operand = (verb ? clause.slice(verb.index + verb[0].length) : clause).trim()
      .replace(/^(?:以下)?(?:两|二|[三四五六七八九十\d]+)个(?:关键词|词)\s*[:：]?\s*/, '')
      .replace(/^(?:以及|还有)\s*/, '').replace(KEYWORD, '');
    const terms = [...operand.matchAll(/[“「『"']([^”」』"'\n]+)[”」』"']/g)];
    if (!terms.length && operand && !/轮|报告|回答|答文|出处|引用/.test(operand)) {
      for (const item of (enumerated ? operand.split(/、/) : [operand])) {
        if (item.trim()) terms.push({ 1: item, index: operand.indexOf(item), 0: item });
      }
    }
    let turns = verb ? explicitTurns(clause.slice(0, verb.index)) : listTurns;
    listTurns = undefined;
    let end = 0;
    for (const term of terms) {
      const prefix = operand.slice(end, term.index);
      if (/报告|回答|输出|显示|列出|返回/.test(prefix)) break;
      const local = explicitTurns(prefix);
      if (local.size) turns = local;
      const scoped = turns.size ? turns : rounds.size === 1 ? rounds : [];
      targets.push({ query: queryKey(term[1]), turns: [...scoped] });
      end = term.index + term[0].length;
      listTurns = /^[，,]$/.test(delimiter) ? turns : undefined;
    }
  }
  return targets;
}

function turnRange(args = {}) {
  if (args.turn != null) return [args.turn, args.turn];
  return args.turnRange;
}

function coversTurn(args, turn) {
  const range = turnRange(args);
  return Array.isArray(range) && range[0] <= turn && turn <= range[1];
}

// Pi keeps malformed JSON in the diagnostic, with empty final arguments.
// Read its partial selectors only to rule out a different target.
export function retryOf(call, success, targets, rounds) {
  const raw = call.argumentsError?.split('\n\nReceived arguments:\n')[1];
  const failed = { ...(raw && parseStreamingJson(raw)), ...call.args };
  const args = success.args ?? {};
  if (Object.keys(failed).some(key => !['query', 'turn', 'turnRange', 'limit'].includes(key))) return false;
  const query = queryKey(args.query);
  if (!query) return false;
  if (failed.query) {
    if (!matchesQuery(queryKey(failed.query), success)) return false;
  } else {
    const requested = targets.length ? targets.some(target => matchesQuery(target.query, success)) :
      rounds.size === 1 && coversTurn(args, [...rounds][0]);
    if (!requested) return false;
  }

  const scope = turnRange(failed);
  if (scope) {
    const retry = turnRange(args);
    if (!Array.isArray(scope) || scope.length !== 2 || !retry || scope[0] !== retry[0] || scope[1] !== retry[1]) return false;
    if (failed.turn != null && failed.turnRange && !coversTurn({ turnRange: failed.turnRange }, failed.turn)) return false;
  } else if (turnRange(args)) {
    // A narrower retry of an unscoped call is sufficient only for the
    // round(s) actually requested for this keyword.
    const selected = targets.filter(t => matchesQuery(t.query, success)).flatMap(t => t.turns);
    if (!(selected.length ? selected : [...rounds]).some(turn => coversTurn(args, turn))) return false;
  }
  return true;
}

// Read whole filenames from the explicitly restricted list. Never select a
// source by matching the suffix of an unknown filename.
export function requestedWorkbooks(question) {
  const names = new Set();
  const restriction = /(?:只|仅)(?:需|要)?(?:看|查阅|查看|关注|考虑|分析|限于|限|报告|列出|说明|给出)[^。；;!?！？]*?(?:工作簿|文件)\s*/g;
  for (const field of question.matchAll(restriction)) {
    let text = question.slice(field.index + field[0].length);
    for (;;) {
      const file = /^\s*[「“"'\[]?([^「」“”"'\[\]，,、。；;]+?\.xls[xm])(?=$|[」”"'\]\s，,、。；;的和与及])(?:[」”"'\]])?/i.exec(text);
      if (!file) break;
      names.add(file[1].trim());
      const next = /^\s*(?:[，,、]\s*(?:以及)?|以及|和|与|及|and\b)\s*(?:工作簿|文件)?/i.exec(text.slice(file[0].length));
      if (!next) break;
      text = text.slice(file[0].length + next[0].length);
    }
  }
  return [...names];
}

function coveredTurns(call, sources, literalIds, workbook) {
  const turns = new Set();
  if (!call.success || call.details?.coverage?.truncated) return turns;
  for (const hit of call.details?.matches || []) {
    if (hit.role !== 'assistant' || !hit.citations?.length) continue;
    const required = workbook ? hit.citations.filter(cell => citationFilenames(cell).includes(workbook)) : hit.citations;
    if (required.length && required.every(cell => sources.some(({ citation, turns }) => turns.has(hit.turn) &&
      citation.id === cell.id && citation.materialId === cell.materialId && citation.version === cell.version &&
      locatorKey(citation.locator) === locatorKey(cell.locator) && (!literalIds || literalIds.has(cell.id))))) {
      turns.add(hit.turn);
    }
  }
  return turns;
}

// A successful empty search is evidence of absence only in its scanned
// rounds. An omitted tool call (or a search in a different round) is not.
const MISS = /(?:未(?:能)?(?:命中|检索到|查询到|找到|查到|匹配)|(?:没有|无)(?:任何)?(?:命中|匹配|结果|检索到|查询到|找到|查到)|(?:零|0)\s*(?:条|个)?\s*(?:匹配|命中|结果)|(?:命中|结果)(?:数|数量)?\s*(?:是|为|[:：])?\s*(?:零|0)\s*(?:条|个)?)/i;

// Bind each explicit result to its own operands. Sentence punctuation does
// not decide whether A's successful search can vouch for B's result.
export function resultReports(parts, targets, isSource) {
  const reports = [];
  for (const part of parts) {
    const notes = [];
    const unclassified = [];
    for (const [, clause] of part.matchAll(CLAUSES)) {
      const text = queryKey(clause);
      const terms = targets.filter(({ query }) => text.includes(query));
      let residue = text;
      for (const { query } of terms) residue = residue.replaceAll(query, ' ');
      const absent = MISS.test(residue);
      const predicate = absent ? MISS : /(?:已|有|成功)?(?:命中|匹配到)(?:了)?/;
      const subjects = terms.length ? terms : targets.length === 1 ? targets : [];
      // “命中所带的引用 ID” describes a source. Only interpret an
      // affirmative as a result when it has a subject and a result predicate.
      if (!predicate.test(residue) || !subjects.length) {
        unclassified.push(clause);
        continue;
      }
      const rest = residue.replace(predicate, '').replace(/第\s*[零一二三四五六七八九十百千\d]+\s*轮|(?:检索|查询|搜索)(?:结果)?|关键词|关键字|(?:助手)?正式(?:答文|回答)|记录|结果|该词|历史|均|和|与|以及|本轮|在|中|的/g, '');
      const resultOnly = !rest.replace(/[\s`*“”「」『』"'，,：:、。.!！]/g, '');
      if (!resultOnly && !absent) {
        unclassified.push(clause);
        continue;
      }
      for (const { query } of subjects) notes.push({ part, query, absent, resultOnly, turns: explicitTurns(clause) });
    }
    if (notes.length) {
      // A result does not substantiate an unrelated assertion in the
      // same sentence. Existing source checks still own any cited clauses.
      const complete = notes.every(n => n.resultOnly) && unclassified.every(clause =>
        /^\s*(?:查询|搜索|检索)?结果(?:如下|为)?\s*[：:]?\s*$/.test(clause) || isSource(clause));
      for (const note of notes) reports.push({ ...note, complete });
    }
  }
  return reports;
}

function emptySearch(call) {
  const details = call.details;
  return call.success && details?.totalMatches === 0 && details.matches?.length === 0 &&
    !details.coverage?.truncated && details.coverage?.turns?.length > 0;
}

function assessTarget(target, ordered, verified, reports, workbook, coverage) {
  const { query, turns } = target;
  const calls = ordered.map((call, i) => ({ call, hits: verified[i] })).filter(({ call }) =>
    call.success && matchesQuery(query, call) && !call.details?.coverage?.truncated);
  const label = [turns.length ? turns.map(turn => `第${turn}轮`).join('、') : '', `“${query}”`, workbook].filter(Boolean).join(' ');
  const reasons = new Set();
  const missing = (round, prefix) => reasons.add(prefix + (round && turns.length > 1 ? `第${round}轮 ` : '') + label);
  const claims = reports.filter(note => note.query === query);
  const reportedRounds = new Set([...turns, ...claims.flatMap(note => [...note.turns])]);
  for (const round of reportedRounds.size ? reportedRounds : [undefined]) {
    const scoped = calls.filter(({ call }) => !round || coversTurn(call.args, round));
    const hit = scoped.some(({ call, hits }) => [...hits].some(turn => (!round || turn === round) && matchesQuery(query, call, turn)));
    const empty = scoped.some(({ call }) => emptySearch(call) && (!round || call.details.coverage.turns.includes(round)));
    const notes = claims.filter(note => !round || !note.turns.size || note.turns.has(round));
    for (const note of notes) {
      if (!note.complete || !(note.absent ? empty && !hit : hit)) {
        coverage.unsupported.add(note.part);
        missing(round, '答文与已核实的检索结果不符：');
      } else coverage.verifiedEndings.add(note.part);
    }
    if (!hit && !(empty && notes.some(note => note.absent && note.complete))) {
      if (!scoped.length) missing(round, '未完成指定范围的检索：');
      else if (empty) missing(round, '尚未向用户报告零命中结果：');
      else missing(round, '尚未核实所请求的历史出处：');
    }
  }
  return [...reasons];
}

// Compare the requested search scopes with the actual results and formal
// answer. The UI keeps the original tool calls, including errors, intact.
export function sourceSearchGap(question, answer, scanned, events, sources = [], blocks, coverage, isSource) {
  const calls = new Map();
  for (const call of [...scanned, ...events]) {
    if (call.name !== 'transcript_search') continue;
    const prior = calls.get(call.id);
    calls.set(call.id, { ...prior, ...call, messageIndex: prior?.messageIndex ?? call.messageIndex });
  }
  const ordered = [...calls.values()].sort((a, b) => a.messageIndex - b.messageIndex);
  const workbooks = requestedWorkbooks(question);
  const targets = requestedSearches(question);
  const parts = blocks.flatMap(block => block.parts);
  if (!ordered.some(call => !call.success) && !targets.length && !workbooks.length) return '';
  let ids;
  if (/引用\s*ID|完整\s*ID|citation[ ._-]*id/i.test(question)) {
    ids = new Set();
    maskCitationIds(answer, sources.map(source => source.citation), cell => { if (cell) ids.add(cell.id); });
  }
  const rounds = explicitTurns(question);
  const reports = resultReports(parts, targets, isSource);
  const reasons = new Set();
  const supportedCalls = new Set(ordered.filter(emptySearch));
  for (const workbook of workbooks.length ? workbooks : [undefined]) {
    const verified = ordered.map(call => coveredTurns(call, sources, ids, workbook));
    for (const [i, hits] of verified.entries()) if (hits.size) supportedCalls.add(ordered[i]);
    for (const target of targets) {
      for (const reason of assessTarget(target, ordered, verified, reports, workbook, coverage)) reasons.add(reason);
    }
    if (workbook && !targets.length && !verified.some(hits => hits.size)) reasons.add('尚未核实工作簿：' + workbook);
  }
  if (reasons.size) return [...reasons].join('；');
  const unrecovered = ordered.find((call, i) => !call.success && !ordered.some((success, j) =>
    j > i && supportedCalls.has(success) && retryOf(call, success, targets, rounds)));
  if (unrecovered) {
    const args = unrecovered.args ?? {};
    const scope = turnRange(args);
    const target = [queryKey(args.query), scope?.length && `第${[...new Set(scope)].join('至')}轮`].filter(Boolean).join(' ');
    return `工具 transcript_search 执行失败，检索尚未完成${target ? '：' + target : ''}。`;
  }
  return '';
}
