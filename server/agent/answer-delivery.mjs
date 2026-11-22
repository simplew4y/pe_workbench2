import { isWorkbookMetricName } from '../../lib/workbook-query.mjs';
import { Lexer } from 'marked';
import { adoptedCitations, citationLookup, currentCitation, toolEvidenceState } from '../../lib/citations.mjs';
import { citationFilenames, citationIdentity, extractLocatorMatches, LOCATOR_SOURCE, locatorKey, maskCitationIds, resolveLocatorToken } from '../../lib/citation-locator.mjs';
import { answerCharCount } from '../../lib/answer-length.mjs';
import { answerDependencies } from '../../lib/answer-dependencies.mjs';
import {closeResearchDocument} from '../../lib/research-document-closure.mjs';
import {researchStatementSpans} from '../../lib/research-text-boundaries.mjs';
export { adoptedCitations };

// A search hit vouches for what an earlier answer cited. It supplies a
// versioned link in a source report, never a fresh reading of that cell.
const HISTORY = /历史|前文|此前|先前|之前|当时|原文|原答|已交付|[上首前]一?[轮次]|第\s*[一二三四五六七八九十百\d]+\s*[轮次]|那[条份次个](?:正式)?(?:回[答复]|答[文案])|\b(?:previous|prior|earlier|original|last)\b/i;
const REFERENCE = /引用|援引|出处|出自|来源|依据|定位|单元格|坐标|\b(?:cit(?:e[ds]?|ation)|refer(?:ence[ds]?|red)?|cell|source)\b/i;
// An elliptical reply to a provenance question can just name the source.
// Keep this fallback narrow: e.g. “收入有望增长，依据 …” asserts a fact.
const SOURCE_ONLY = /^[\s`*_]*(?:(?:它|其|所)?(?:引用|援引)(?:的)?(?:单元格|坐标)?|(?:该|对应的?)?(?:出处|来源|单元格|坐标))?(?:就?是|为|在)?[\s`*_。、，,：:！!.]*$/i;

// Every locator must be the object of the source report. In “the old
// answer cited A1, which proves revenue grew” a citation cannot verify growth.
const REPORTED_CELL = /(?:引用|援引|出处|出自|指向|依据|来源|坐标|单元格|cit(?:ed|ation)|refer(?:red to|enced)|source|cell)\s*(?:的|是|为|在|了|就是|写作|写为|is|was|:|：|\s)*$/i;

const VERSION_LABEL = String.raw`(?:[\da-z_-]+(?:\.[\da-z_-]+)*|[零〇一二两三四五六七八九十百千]+)`;
const SOURCE_VERSION = new RegExp(String.raw`(?:(?:材料|文件)(?:的)?\s*)?(?:版本(?:号)?|\bversion)\s*(?:为|是)?\s*[:=]?\s*v?\s*(${VERSION_LABEL})|(?:材料|文件)?第\s*(${VERSION_LABEL})\s*版|(?<!\w)@?v(\d+(?:\.\d+)*)\b`, 'gi');

const UUID = String.raw`[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}`;
const MATERIAL_FIELD = new RegExp(String.raw`(?:材料|文件|material|file)\s*(?:ID\s*(?:为|是)?\s*[:=]?\s*([\w-]+)|(?:为|是)?\s*[:=]?\s*(${UUID})(?![\w-]))`, 'gi');
const PRESENT = /当前|目前|现在|最新|现行|现为|(?:截至|截止|直至|到)?(?:今天|今日|如今)|\b(?:current(?:ly)?|today|now|latest)\b/i;
const SOURCE_CLAUSE_BREAK = new RegExp(String.raw`[；;]|[，,](?=\s*(?:而|但)?(?:同一|该|这份)?(?:材料|文件|工作簿)?(?:${PRESENT.source}))`, 'i');
// Check descriptive fields against the source of the written locator. Keep the
// original answer and its qualifiers intact for lint, delivery and linking.
function checkSourceFields(clause, refs, lookup, precedingSource, ids) {
  const resolved = refs.map(ref => resolveLocatorToken(ref.raw, lookup)?.citation);
  let conflict = '';
  let hasFields = false;
  let idConflict = '';
  let hasId = false;
  function check(segment, source) {
    // Compare to the literal ID of the written source, not a reconstructed
    // ID or a different citation that happened to match the search.
    let text = maskCitationIds(segment, ids, (cited, field) => {
      hasId = true;
      hasFields = true;
      if (!cited || cited.id !== source?.id) idConflict = field;
    }).normalize('NFKC').replace(/^\s*[-•]\s+/, '').replace(/[`*]/g, '');
    const names = citationFilenames(source);
    if (names.length) {
      const alternatives = names.map(name => name.normalize('NFKC').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length).join('|');
      const nameField = String.raw`(?:((?:实际存储|存储|存盘|落盘|实际上传|磁盘|显示|原始)(?:文件)?名(?:称)?|\bstoredFilename\b|\bfilename\b)|(?:工作簿(?:文件)?|(?:上传)?文件)(?:名(?:称)?)?)\s*(?:为|是|:)?\s*`;
      const ending = String.raw`(?![\w-]|\.[\w.-])`;
      const knownName = String.raw`(?:\[(${alternatives})\]|(${alternatives})${ending})`;
      // At a label, consume the whole written workbook name, including
      // spaces. A later word in “copy of Book.xlsx” cannot identify the file.
      const otherName = String.raw`(?:\[([^\[\]\n]+?\.xls[xm])\]|([^\[\]()，,。；;：:、\n]+?\.xls[xm])${ending})`;
      const labeled = new RegExp(nameField + `(?:${knownName}|${otherName})`, 'g');
      text = text.replace(labeled, (field, kind, bracketed, plain, otherBracketed, otherPlain) => {
        hasFields = true;
        if (otherBracketed || otherPlain) conflict = field;
        else if (kind) {
          const expected = /存储|存盘|落盘|上传|磁盘|^storedFilename$/.test(kind) ? source.storedFilename : source.filename;
          if (expected?.normalize('NFKC') !== (bracketed || plain)) conflict = field;
        }
        return ' ';
      });
      // Bare names need a delimiter. Chinese letters and filename characters
      // such as '+' must not turn an unknown name into a known suffix.
      const boundary = String.raw`(?<!\S)|(?=\[)|(?<=[(（,，。;；:：、"“'‘《])`;
      text = text.replace(new RegExp(`(?:${boundary})${knownName}`, 'g'), ' ');
    }
    text = text.replace(/(?:\bSheet|工作表)\s*(?:为|是|:)\s*([^，,;；()]+?)\s*的\s*(\$?[a-z]{1,3}\$?\d+)\s*单元格/gi, (field, sheet, cell) => {
      hasFields = true;
      if (!source || locatorKey(sheet.trim() + '!' + cell) !== locatorKey(source.locator)) conflict = field;
      return ' ';
    });
    const otherWorkbook = text.match(/[^\s()[\]，,。；;]+\.xls[xm]\b/i);
    if (otherWorkbook) conflict = otherWorkbook[0];
    text = text.replace(MATERIAL_FIELD, (field, labeled, uuid) => {
      hasFields = true;
      if (source?.materialId !== (labeled || uuid)) conflict = field;
      return ' ';
    });
    text = text.replace(SOURCE_VERSION, (field, labeled, numbered, short) => {
      hasFields = true;
      if (source?.version !== ordinal(labeled || numbered || short)) conflict = field;
      return ' ';
    });
    return text.replace(/\([\s,、]*\)/g, ' ');
  }
  let checked = '';
  let end = 0;
  for (const [i, ref] of refs.entries()) {
    const previous = resolved[i - 1];
    const source = resolved[i];
    let gap = clause.slice(end, ref.index);
    // A parenthetical immediately following the previous cell belongs to it.
    // Unattached fields between different sources have no unique owner.
    if (i && previous && source && citationIdentity(previous) !== citationIdentity(source)) {
      const note = gap.match(/^\s*[（(][^()（）]*[)）]/)?.[0] || '';
      checked += check(note, previous);
      gap = gap.slice(note.length);
      checked += check(gap, null);
    } else {
      checked += check(gap, source);
    }
    checked += ref.raw;
    end = ref.index + ref.raw.length;
  }
  const lastSource = refs.length ? resolved.at(-1) : precedingSource;
  checked += check(clause.slice(end), lastSource);
  return { checked, conflict, idConflict, hasId, hasFields, lastSource };
}

// A source-only answer can list fields, or give several spellings of one
// locator. Consume only provenance vocabulary after checking field values. Any
// remaining assertion still needs the usual direct evidence and lint checks.
const SOURCE_WORDS = new RegExp([
  '也就是说|换句话说|换言之|具体来说|也就是|亦即|因此|所以|其中|内容|包括|对应|完整|限定|带有|带',
  '当时|采用|使用|用|历史|本会话|会话|本次|此次|本轮|当轮|原始|原文|正式|已交付|交付|助手|回答|答文|回复|记录',
  '当|若|如果|可能|其他|同名|重名|避免|文件名称|文件名|工作簿|工作表|文件|材料|单元格|坐标|定位',
  '出处|来源|引用|援引|版本号|版本|格式|规范|标准|形式|约定|标识|标注|标记|表示|显示|写作|写为|记作|记为|写法|全称',
  '应当|应该|应|也可|可以|可|以及|及|与|和|且|这份|该|其|这|那|份|个|按照|依照|遵循|根据|依据|按|即|为|是|的|所|了|中|里|于|在|时',
].join('|'), 'g');
// A verified ID field can also identify the search result that supplied it.
// Interpret those words only in a clause containing a checked ID; keep every
// other assertion for the source and financial checks below.
const SEARCH_TERMS = /\bcitations?\b|transcript_search|命中项?|匹配项?|检索|搜索|查询|工具|结果|返回|提供|给出|携带|附带|随附|所附|条/gi;
const SOURCE_POINTER = /(?:这(?:条|个|一)?|该|其|此|上述|前述)(?:引用|出处|来源|记录)(?:所)?(?:指向|指的(?:是)?|对应(?:于)?)/;
function sourceFieldsOnly(part, hasId) {
  if (hasId) {
    part = part.replace(/(?:这|那|该|此)一?(?:篇|条|份|则|个)(?=\s*(?:正式|回答|答文|回复|记录|命中|引用|citation))/gi, '')
      .replace(/(?:由)?[他她它](?:所)?(?=引用|援引|提供|返回|给出|携带)/g, '').replace(SEARCH_TERMS, '');
  }
  return !part.replace(new RegExp('(?:对应的)?(?:行号|坐标)(?:也)?显示为\\s*(?=' + LOCATOR_SOURCE + ')', 'g'), '')
    .replace(new RegExp(LOCATOR_SOURCE, 'g'), ' ')
    .replace(/第\s*[零一二三四五六七八九十百千\d]+\s*[轮次]/g, '')
    .replace(new RegExp(SOURCE_POINTER.source, 'g'), '')
    .replace(SOURCE_WORDS, '')
    .replace(/[\s。，；、,.!:：;!？?()（）“”「」`*]/g, '');
}

const ALTERNATE_SPELLING = /(?:写作|写为|记作|记为|表示为)\s*[:：]?\s*$/;
const RESTATEMENT = /(?:行号|坐标)(?:也)?显示为\s*$|也就是说|也就是|换句话说|换言之|亦即|(?:写作|写为|记作|记为|表示为)\s*[:：]?\s*$/;
function reportsHistoricalSource(part, refs, question, hasId) {
  let description = part.replace(new RegExp(LOCATOR_SOURCE, 'g'), ' ');
  const historicalSubject = HISTORY.test(description);
  description = description.replace(/第\s*\d+\s*[轮次]|\bturn\s*#?\d+|\d+\s*条(?=\s*(?:命中|记录|结果|[，,。；;]|$))/gi, ' ');
  if (/\d|当前|现在|最新|现价|[零〇一二两三四五六七八九十百千万亿]+(?:元|美元|港元|%)|\b(?:current|now|latest)\b/i.test(description)) return false;
  const provenanceQuestion = HISTORY.test(question) && REFERENCE.test(question);
  if ((historicalSubject || provenanceQuestion) && sourceFieldsOnly(part, hasId)) return true;
  if (provenanceQuestion && SOURCE_ONLY.test(description.trim())) return true;
  if (!historicalSubject && !(HISTORY.test(question) && /回[答复]|答[文复案]|\b(?:reply|answer)\b/i.test(description))) return false;
  return refs.every(({ raw, index }) => {
    const prefix = part.slice(0, index).replace(/[`*_]/g, '').trimEnd();
    const suffix = part.slice(index + raw.length).replace(/[`*_]/g, '').trim();
    // Keep the link in the report itself (including a trailing source ID).
    // “The old answer cited B2, proving that …” also makes a new claim.
    const sourceTail = /^(?:(?:这[个一]|该)?(?:单元格|坐标)|cell)?[。，,；;！.!（）()\s]*$/i.test(suffix);
    const sourceFirst = /^(?:是|为|was|is).*(?:引用|援引|referenced|cited)(?:的(?:单元格|坐标|出处))?[。.!！]?$/i.test(suffix);
    // In “引用的是 Book.xlsx 的 B2 单元格” the source noun follows the
    // locator. The filename was already checked and removed from the prefix.
    const sourcePrefix = prefix.replace(/(?:工作簿|文件|workbook)?\s*(?:中的?|里的?|内的?|的)\s*$/i, '').trimEnd();
    return ((REPORTED_CELL.test(prefix) || REPORTED_CELL.test(sourcePrefix) ||
      ALTERNATE_SPELLING.test(prefix)) && sourceTail) || sourceFirst;
  });
}

function ordinal(label) {
  if (/^\d+$/.test(label)) return Number(label);
  if (!/^[零〇一二两三四五六七八九十百千]+$/.test(label)) return NaN;
  let number = 0;
  let digit = 0;
  for (const ch of label) {
    const unit = { 十: 10, 百: 100, 千: 1000 }[ch];
    if (unit) {
      number += (digit || 1) * unit;
      digit = 0;
    } else {
      digit = '零一二三四五六七八九'.indexOf(ch.replace('两', '二').replace('〇', '零'));
    }
  }
  return number + digit;
}

export function explicitTurns(text) {
  const turns = new Set();
  for (const match of text.matchAll(/第\s*([零一二三四五六七八九十百千\d]+)\s*[轮次]|\bturn\s*#?(\d+)/gi)) {
    turns.add(ordinal(match[1] || match[2]));
  }
  if (/首轮/.test(text)) turns.add(1);
  return turns;
}

function assertsCurrentVersion(description) {
  const time = PRESENT.exec(description);
  if (!time) return false;
  return [...description.matchAll(SOURCE_VERSION)].some(({ index }) => {
    const prefix = description.slice(0, index);
    if (/(?:无法|不能|尚未|未能)(?:核实|核验|确认|确定)(?:为|是)?\s*$/u.test(prefix)) return false;
    // “Today I found the first answer cited …” dates the search. The
    // historical subject between that time and the version owns the field.
    if (index >= time.index) return !HISTORY.test(description.slice(time.index + time[0].length, index));
    return !HISTORY.test(description.slice(0, time.index));
  });
}

// Resolve the subject of a current-version statement to one material and one
// version actually read this turn. Another cell in that workbook also proves
// its version. A search hit or a rehydrated ledger entry cannot do so.
function currentWorkbookEvidence(refs, implicitMaterials, reads) {
  const lookup = citationLookup(reads);
  const owners = refs.length ? refs.map(ref => resolveLocatorToken(ref.raw, lookup)?.citation?.materialId) : implicitMaterials;
  if (new Set(owners).size !== 1) return [];
  const materialReads = reads.filter(cell => cell.materialId === owners[0]);
  return new Set(materialReads.map(cell => cell.version)).size === 1 ? materialReads : [];
}

// A source description can list the workbook and version before naming its
// cell, with a field per line or per semicolon. Stop at unrelated prose.
function followingSourceLocator(restOfSentence, parts, nextPart, ids) {
  let text = restOfSentence;
  for (;;) {
    const ref = extractLocatorMatches(maskCitationIds(text, ids))[0];
    if (ref) return ref;
    if (nextPart >= parts.length || (text && !/材料|工作簿|文件|版本|引用|\.xlsx?\b|\b(?:material|version|citation)\b/i.test(text))) return null;
    text = parts[nextPart++];
  }
}

export function asksHistoricalSource(question) {
  return HISTORY.test(question) && REFERENCE.test(question);
}

export function reportedLocatorEvidence(text, question, current, matches, workbookEvidence = []) {
  const fallback = { citations: current };
  if (!matches.length && !(HISTORY.test(question) && REFERENCE.test(question))) return fallback;
  const requested = explicitTurns(question);
  const allowed = matches.filter(match => !requested.size || requested.has(match.turn));
  const used = new Map();
  const bindings = [];
  const historical = new Map();
  let hasHistoricalLink = false;
  let precedingSource;
  let lastMaterials;
  for (const { parts } of answerBlocks(text)) {
    for (const [partIndex, part] of parts.entries()) {
      const reported = explicitTurns(part);
      const selected = allowed.filter(match => !reported.size || reported.has(match.turn));
      const cells = selected.flatMap(match => match.citations);
      const historyLookup = citationLookup(cells);
      const ids = [...cells, ...current];
      const clauses = part.split(SOURCE_CLAUSE_BREAK);
      for (const [i, clause] of clauses.entries()) {
        const masked = maskCitationIds(clause, ids);
        const refs = extractLocatorMatches(masked);
        const description = masked.replace(new RegExp(LOCATOR_SOURCE, 'g'), ' ').normalize('NFKC');
        const presentVersion = assertsCurrentVersion(description);
        const scope = presentVersion
          ? currentWorkbookEvidence(refs, lastMaterials ?? cells.map(cell => cell.materialId), workbookEvidence)
          : cells;
        if (presentVersion && !scope.length) return { citations: [], conflict: clause };
        const fieldLookup = presentVersion ? citationLookup(scope) : historyLookup;
        let noteSource = presentVersion ? scope[0] : precedingSource;
        if (!refs.length && !noteSource) {
          // A standalone version or ID may also introduce the next source.
          if (!REFERENCE.test(question)) continue;
          const nextRef = followingSourceLocator(clauses.slice(i + 1).join('；'), parts, partIndex + 1, ids);
          if (nextRef) noteSource = resolveLocatorToken(nextRef.raw, historyLookup)?.citation;
          else {
            // After an intervening heading, a literal citation ID can still
            // name its source. Never infer an unlabeled version this way.
            let hasId = false;
            maskCitationIds(clause, ids, () => { hasId = true; });
            if (!hasId) continue;
            if (historical.size === 1) noteSource = historical.values().next().value.citation;
          }
        }
        const fields = checkSourceFields(clause, refs, fieldLookup, noteSource, ids);
        if (presentVersion && fields.conflict) return { citations: [], conflict: fields.conflict };
        if (!refs.length) {
          if (fields.idConflict) return { citations: [], conflict: fields.idConflict };
          // Only an adjacent source note can qualify the preceding citation.
          const noteOnly = sourceFieldsOnly(fields.checked, fields.hasId);
          const describesPresent = PRESENT.test(description) && !HISTORY.test(description);
          const sourceNote = !describesPresent && (/材料|文件|工作簿|版本|引用记录|material|file|version/i.test(clause) ||
            (fields.hasFields && (HISTORY.test(clause) || noteOnly)));
          if (fields.conflict && sourceNote) return { citations: [], conflict: fields.conflict };
          // A financial gloss can follow a source report after a full stop.
          // The historical hit cannot stand in for a direct read of that cell.
          const financial = /数值|常量|读数|期间|单位|收入|营收|利润|金额|增长|下降/.test(fields.checked);
          if (presentVersion && financial) {
            // The metadata alone does not verify an appended financial value.
            const values = fields.checked.match(/[+-]?\d+(?:,\d{3})*(?:\.\d+)?/g) || [];
            if (values.some(value => !scope.some(cell => cell.value != null &&
              Number(cell.value) === Number(value.replaceAll(',', ''))))) return { citations: [], conflict: clause };
          }
          const cellClaim = financial && /^(?:对应|其|该|这|上述|前述)/.test(clause.trim());
          if (cellClaim && precedingSource && !current.some(cell => citationIdentity(cell) === citationIdentity(precedingSource) &&
            locatorKey(cell.locator) === locatorKey(precedingSource.locator))) return { citations: [], conflict: clause };
          if (((i && !describesPresent) || (sourceNote && fields.hasFields)) && !noteOnly) {
            return { citations: [], conflict: clause };
          }
          if (!sourceNote) precedingSource = undefined;
          continue;
        }
        const checkedRefs = extractLocatorMatches(fields.checked);
        const isReport = !presentVersion && reportsHistoricalSource(fields.checked, checkedRefs, question, fields.hasId);
        // A restatement must name the same material, version and cell as its
        // antecedent, even if both locators occurred in the search results.
        let antecedent = precedingSource;
        let start = 0;
        for (const ref of checkedRefs) {
          const prefix = fields.checked.slice(start, ref.index);
          const source = resolveLocatorToken(ref.raw, historyLookup)?.citation;
          if (isReport && antecedent && (SOURCE_POINTER.test(prefix) || RESTATEMENT.test(prefix)) && (!source ||
              citationIdentity(source) !== citationIdentity(antecedent) ||
              locatorKey(source.locator) !== locatorKey(antecedent.locator))) {
            return { citations: [], conflict: ref.raw };
          }
          antecedent = source;
          start = ref.index + ref.raw.length;
        }
        // Resolve historical prose solely against the cited turn. A current
        // reading of the same coordinate can belong to a different version.
        const evidence = isReport ? cells : current;
        const lookup = isReport ? historyLookup : citationLookup(current);
        const idConflict = fields.hasId && !isReport
          ? checkSourceFields(clause, refs, lookup, undefined, ids).idConflict : fields.idConflict;
        if (idConflict) return { citations: [], conflict: idConflict };
        if (isReport && fields.conflict) return { citations: [], conflict: fields.conflict };
        lastMaterials = [];
        for (const { raw } of refs) {
          const source = resolveLocatorToken(raw, lookup)?.citation;
          if (!source) return isReport ? { citations: [], conflict: raw } : { citations: [] };
          bindings.push({ raw, identity: citationIdentity(source) });
          lastMaterials.push(source.materialId);
        }
        for (const cell of adoptedCitations(clause, evidence)) {
          used.set(cell.id, cell);
          if (isReport) {
            const source = historical.get(cell.id) ?? { citation: cell, turns: new Set() };
            const owners = new Set(selected.filter(match => match.citations.some(c => c.id === cell.id &&
              citationIdentity(c) === citationIdentity(cell) && locatorKey(c.locator) === locatorKey(cell.locator))).map(match => match.turn));
            if (reported.size || owners.size === 1) for (const turn of owners) source.turns.add(turn);
            historical.set(cell.id, source);
          }
        }
        precedingSource = isReport ? fields.lastSource : undefined;
        hasHistoricalLink ||= isReport;
      }
    }
  }
  if (!hasHistoricalLink) return fallback;
  const citations = [...used.values()];
  const delivered = citationLookup(citations);
  // The browser has one citation list for the entire answer. Each written
  // locator must still select its own source after the lists are combined.
  for (const { raw, identity } of bindings) {
    const source = resolveLocatorToken(raw, delivered)?.citation;
    if (!source || citationIdentity(source) !== identity) return { citations: [], conflict: raw };
  }
  // A fully verified source report may end in a literal ID field. An actual
  // length stop or another unfinished construct still goes through continuation.
  let endsWithIdField = false;
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  maskCitationIds(lastLine, citations, (cell, field) => {
    if (cell && lastLine.endsWith(field) && (field !== cell.id || lastLine.trim() === field)) endsWithIdField = true;
  });
  const endsWithNoGaps = /^未核验[：:]\s*无[。.]?$/.test(lastLine.trim());
  return { citations, endsWithIdField, endsWithNoGaps, historical: [...historical.values()] };
}

export function joinContinuation(prefix, delta) {
  if (!prefix || delta.startsWith(prefix)) return delta;
  const continuation = delta.trimStart();
  const original = prefix.trimStart();
  if (continuation.startsWith(original)) return prefix + continuation.slice(original.length);
  // Check the longest recent overlap first. At a clause boundary, a shorter
  // match can indicate a restart. Ignore short repeats and mid-word matches.
  const span = Math.min(512, original.length, continuation.length);
  for (let start = original.length - span; start < original.length; start++) {
    const repeated = original.slice(start);
    if (!continuation.startsWith(repeated)) continue;
    const before = original.slice(0, start);
    if (/[\p{Script=Latin}\d]$/u.test(before) && /^[\p{Script=Latin}\d]/u.test(repeated)) continue;
    const clauseStart = !before || /[。！？.!?；;，,：:\n]\s*$/u.test(before);
    const han = repeated.match(/\p{Script=Han}/gu)?.length || 0;
    const words = repeated.match(/[\p{Script=Latin}\d]+/gu)?.length || 0;
    // A short metric label can be replayed at a sentence restart. Keep
    // ordinary three-character phrases, which may be repeated for emphasis.
    const restartsShortLabel = /[。！？.!?]\s*$/u.test(before) &&
      /^(?:\p{Script=Han}{2}[率额量值价数]|净利润)$/u.test(repeated) &&
      /^(?:\p{Script=Han}|\s*[:：])/u.test(continuation.slice(repeated.length));
    if (restartsShortLabel || han >= (clauseStart ? 4 : 5) || words >= (clauseStart ? 2 : 3)) {
      return prefix + continuation.slice(repeated.length);
    }
  }
  return prefix + delta;
}

export function answerGaps(answer) {
  return [...answer.matchAll(/(?:^|[。！？\n])[ \t]*(?:[-*][ \t]+)?未核验[：:][ \t]*([^。！？\n]+)/g)]
    .map(match => match[1].trim()).filter(Boolean);
}

const PERIOD_PREFIX = /^20\d{2}\s*年\s*[，,、]?\s*/;
const NUMBER = String.raw`[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;

function requestedItems(question) {
  const request = question.trim().replace(/^(?:请问|请)?\s*(?:帮我\s*)?/, '').replace(/[？?。]$/, '');
  const numeric = request.match(/^([\p{L}\p{N} 、，,]+?)(?:各自?|分别)?\s*(?:是|为)?\s*多少$/u);
  const list = numeric || request.match(/^(?:分别\s*)?(?:给出|列出)\s*([\p{L}\p{N} 、，,]+)$/u);
  const items = list?.[1].replace(PERIOD_PREFIX, '').trim().split(/\s*(?:和|与|及|[、，,])\s*/);
  return { items: items?.length > 1 && items.every(Boolean) ? [...new Set(items)] : [], numeric: Boolean(numeric) };
}

// Keep the original Markdown for delivery. A table row is a single claim
// unit, just as a sentence is in prose. Its header belongs to the retained rows.
const sentenceParts = raw => raw.split(/(?<=[。！？])|(?<=[.!?])(?=\s|$)|\n+/).map(s => s.trim()).filter(Boolean);

export function answerBlocks(text) {
  const prose = raw => ({ raw, parts: sentenceParts(raw) });
  if (!text.includes('|')) return [prose(text)];
  return Lexer.lex(text).map(token => {
    if (token.type !== 'table') return prose(token.raw);
    const [header, separator, ...rows] = token.raw.trimEnd().split('\n');
    return { header: header + '\n' + separator, parts: rows,
      labels: token.header.map(cell => cell.text.replace(/[*`]/g, '').trim()), cells: token.rows };
  });
}

const summaryItems = [
  ['置信度', /置信度/u, /置信度|判断信心/u],
  ['最强证据', /最强证据/u, /^(?:最强|核心|主要)?证据$|^主要依据$/u],
  ['反证', /反证/u, /反证|反向证据|最强挑战/u],
  ['已修订的结论', /结论[^。]{0,14}(?:被修订|修订了)|修订了?哪些结论/u, /修订|下调与保留|调整的判断/u],
  ['三项待核', /(?:三|3)项待核/u, /待核|待验证|还需核对/u],
  ['下次行动', /下次行动|下一步行动/u, /下次行动|下一步|后续行动|复核计划/u],
];
const confidenceRating = /(?:置信度|判断信心)[\s*：:]*(?:为|是)?\s*(?:较?低|中等(?:偏[低高])?|中[低高]?|较?高)/u;

export function requestedSummaryItems(question) {
  if (!/摘要|纪要/u.test(question)) return [];
  return summaryItems.filter(([, requested]) => requested.test(question)).map(([label]) => label);
}

function summaryHeading(label, requested) {
  const clean = label.replace(/[#*：:\s]/gu, '');
  return summaryItems.find(([item, , title]) => requested.includes(item) && title.test(clean))?.[0];
}

function answerHeading(text, required) {
  const markdown = text.match(/^(#{1,6}[ \t]+[^\n]+)(?:\n([\s\S]*))?$/u) ||
    text.match(/^(\*\*[^*\n]+\*\*[ \t]*[：:]?)[ \t]*([\s\S]*)$/u);
  if (markdown) return markdown;
  const plain = text.match(/^([^：:\n]{1,22}[：:])[ \t]*([\s\S]*)$/u);
  return plain && summaryHeading(plain[1], required) ? plain : null;
}

function deliverySections(blocks, required = []) {
  const sections = [];
  for (const {header, parts} of blocks) {
    let section = {header, table: Boolean(header), parts: []};
    sections.push(section);
    for (const part of parts) {
      const heading = !header && answerHeading(part, required);
      if (!heading) {
        section.parts.push(part);
        continue;
      }
      const body = heading[2]?.trim();
      section = {header:heading[1], parts:body ? [body] : []};
      sections.push(section);
    }
  }
  return sections;
}

function reviewList(section) {
  // Sentence splitting may separate a numeric marker ("1.") from its text.
  const text = section.parts.join('\n').replace(/(^|[；;]\s*)([1-9][.．])\n(?=\S)/gmu, '$1$2 ');
  const marker = /(?:^|[。；;：:\n])\s*(?:[1-9一二三四五六七八九][、．.)）]|[-*]\s+)\s*/u;
  const marked = text.split(marker);
  const items = marked.length > 1 ? marked.slice(1) : text.split(/[、；;\n]/u);
  const substantive = items.map(part => part.trim().replace(/[。；;]+$/u, '')).filter(part => /[\p{L}]/u.test(part));
  return { text, complete:substantive.length === 3 && new Set(substantive).size === 3 };
}

export function missingSummaryItems(answer, required) {
  if (!required.length) return [];
  const included = new Set();
  for (const section of deliverySections(answerBlocks(answer), required)) {
    const label = section.header && summaryHeading(section.header, required);
    if (label === '三项待核' ? reviewList(section).complete : label && section.parts.some(part => /[\p{L}\p{N}]/u.test(part))) {
      included.add(label);
    }
  }
  if (confidenceRating.test(answer)) included.add('置信度');
  return required.filter(label => !included.has(label));
}

function budgetBlocks(blocks, required) {
  const listItem = /^(?:[-+*][ \t]+|(?:\d{1,2}[.．、)）]|[一二三四五六七八九十][、．)）])(?!\d))/u;
  return blocks.map(block => {
    if (block.header) return block;
    const parts = [];
    let paragraph = [];
    for (const raw of block.raw.split('\n')) {
      const line = raw.trim();
      if (paragraph.length && (!line || listItem.test(line) || answerHeading(line, required))) {
        parts.push(paragraph.join('\n'));
        paragraph = [];
      }
      if (line) paragraph.push(line);
    }
    if (paragraph.length) parts.push(paragraph.join('\n'));
    return { parts };
  });
}

// Preserve a prose paragraph or list item as a unit, like a table row.
// A sentence can explain the judgment just before it without restating it.
export function reviewBodyWithinBudget(answer, blocks, budget, omit, required = [], wholeSections = []) {
  if (!omit && answerCharCount(answer) <= budget) return answer;
  const content = deliverySections(budgetBlocks(blocks, required), required).map(section => {
    const label = section.header && summaryHeading(section.header, required);
    const list = label === '三项待核' ? reviewList(section) : null;
    const whole = wholeSections.includes(label);
    const units = list ? (list.complete ? [list.text] : []) :
      whole ? [section.parts.join('\n')] : section.parts;
    const allowed = part => !omit?.(section.header ? `${section.header}\n${part}` : part);
    const parts = units
      // Corrections can still remove a conflicting claim without discarding
      // independent sentences in the same paragraph. Budget selection uses
      // the remaining paragraph as one unit.
      .map(part => {
        if (allowed(part)) return part;
        return section.table || list || whole ? '' : sentenceParts(part).filter(allowed).join('\n');
      })
      .filter(Boolean)
      .map(text => ({text, size:answerCharCount(text)}));
    const rating = required.includes('置信度') && !label ? parts.find(part => confidenceRating.test(part.text)) : null;
    return {
      ...section, priority:list ? 2 : label || rating ? 1 : 0, parts, rating,
      needsLead: Boolean(section.header && !section.table),
    };
  }).filter(section => section.parts.length);
  const share = budget / content.length;
  let used = 0;
  const kept = new Set();
  function add(section, part) {
    if (kept.has(part)) return;
    const size = part.size + (section.keptHeader ? 0 : answerCharCount(section.header || ''));
    if (used + size > budget) return;
    used += size;
    kept.add(part);
    section.keptHeader = true;
  }
  const ordered = content.toSorted((a, b) => Number(b.priority) - Number(a.priority));
  for (const section of ordered) {
    const allowance = share - answerCharCount(section.header || '');
    const lead = section.parts[0];
    const first = section.rating || (section.needsLead
      ? ((section.priority || lead.size <= allowance) ? lead : null)
      : section.parts.find(part => part.size <= allowance));
    if (first) add(section, first);
  }
  for (const section of content) {
    for (const part of section.parts) {
      add(section, part);
      // A shorter footnote cannot stand in for an omitted judgment.
      if (section.needsLead && !section.keptHeader) break;
    }
  }
  return content.flatMap(section => {
    const body = section.parts.filter(part => kept.has(part)).map(part => part.text);
    return body.length ? [[section.header, ...body].filter(Boolean).join('\n')] : [];
  }).join('\n\n');
}

// Expand ordered values into named claims for verification. Delivery always
// uses the original text and Markdown cells.
function claimViews(block, row, items, orderedList) {
  const raw = block.parts[row].replace(/[*`]/g, '');
  if (block.header) {
    if (block.labels.some(label => items.includes(label))) {
      return block.cells[row].flatMap((cell, i) => items.includes(block.labels[i])
        ? [block.labels[i] + ' ' + cell.text.replace(/[*`]/g, '')] : []);
    }
    return [block.cells[row].map(cell => cell.text.replace(/[*`]/g, '')).join(' | ')];
  }
  return raw.split(/[；;]|[，,](?=\s*(?:根据|依据))/).map(clause => {
    const list = orderedList.exec(clause);
    if (!list) return clause;
    const labels = list[1].split(/\s*(?:和|与|及|、)\s*/);
    const values = clause.slice(list.index + list[0].length).split(/\s*(?:和|与|及|、|，)\s*(?=[+-]?\d)/);
    if (values.length !== labels.length) return clause;
    return clause.slice(0, list.index) + labels.map((label, i) => label + ' ' + values[i]).join('，');
  });
}

function* workbookClaims(blocks, items) {
  // Item names are restricted to letters, numbers and spaces by requestedItems.
  const names = '(?:' + items.toSorted((a, b) => b.length - a.length).join('|') + ')';
  const namedValue = new RegExp(String.raw`(${names})\s*(?:约\s*)?(?:为|是|[:：=])?\s*(${NUMBER})(?!\d|\.\d)`, 'g');
  const orderedList = new RegExp(String.raw`(${names}(?:\s*(?:和|与|及|、)\s*${names})+)\s*(?:分别|各自?)\s*(?:为|是)\s*`);
  for (const block of blocks) {
    for (const [row, part] of block.parts.entries()) {
      const plain = part.replace(/[*`]/g, '');
      for (const view of claimViews(block, row, items, orderedList)) {
        // Preserve offsets into the clause when masking sources and column separators.
        const masked = view.replace(new RegExp(LOCATOR_SOURCE, 'g'), ref => ' '.repeat(ref.length));
        const claims = [...(block.header ? masked.replaceAll('|', ' ') : masked).matchAll(namedValue)];
        for (const [i, claim] of claims.entries()) {
          const [, item, reported] = claim;
          const scope = view.slice(i === 0 ? 0 : claim.index, claims[i + 1]?.index);
          const ref = extractLocatorMatches(scope).at(-1);
          const endsWithCitation = ref && /^[)）]?$/.test(scope.slice(ref.index + ref.raw.length).trim()) && plain.endsWith(scope);
          const plainValue = plain.replace(PERIOD_PREFIX, '').replace(/[。.!！]$/, '') === claim[0];
          yield { part, item, value: Number(reported.replaceAll(',', '')), scope,
            explicitSource: Boolean(ref), complete: block.header || endsWithCitation || plainValue };
        }
      }
    }
  }
}

export function workbookItemCoverage(question, blocks, evidence, workbookTurn) {
  const { items, numeric } = requestedItems(question);
  const result = { missing: [], evidenceIds: new Set(), unsupported: new Set(), supported: new Set(), verifiedEndings: new Set() };
  const supportsItem = (cell, item) => cell.metric && typeof cell.value === 'number' &&
    (cell.metric === item || item.endsWith('表' + cell.metric));
  if (!items.length || !workbookTurn) return result;
  // An open-ended list (e.g. advantages and risks) need not contain numbers.
  if (!numeric && !items.some(isWorkbookMetricName) && !evidence.some(cell => items.some(item => supportsItem(cell, item)))) return result;

  const answered = new Set();
  const unsupportedItems = new Set();
  for (const claim of workbookClaims(blocks, items)) {
    const { item, value, part, scope, explicitSource, complete } = claim;
    const cited = explicitSource ? adoptedCitations(scope, evidence) : evidence;
    const sources = cited.filter(cell => supportsItem(cell, item) && cell.value === value);
    if (!sources.length) {
      unsupportedItems.add(item);
      result.unsupported.add(part);
      continue;
    }
    answered.add(item);
    result.supported.add(part);
    for (const cell of sources) result.evidenceIds.add(cell.id);
    if (complete) result.verifiedEndings.add(part);
  }
  result.missing = items.filter(item => !answered.has(item) || unsupportedItems.has(item));
  return result;
}

export function blockingFinding(finding) {
  return finding.severity === 'error' || finding.rule === 'unverified_locator';
}

// Metadata next to a retained historical locator may be a complete field
// without a sentence terminator. Check every value against that same cell.
function verifiedSourceNote(part, source, requireId = false) {
  if (!source || assertsCurrentVersion(part)) return false;
  const masked = maskCitationIds(part, [source]);
  if (extractLocatorMatches(masked).length) return false;
  const fields = checkSourceFields(part, [], null, source, [source]);
  return fields.hasFields && (!requireId || fields.hasId) && !fields.conflict && !fields.idConflict && sourceFieldsOnly(fields.checked, fields.hasId);
}

export function hasOcrPageSource(part, calls, versions) {
  const locators = /\bp\.\s*(\d+)\b|第\s*(\d+)\s*页/giu;
  const pages = [...part.matchAll(locators)].map(match => Number(match[1] || match[2]));
  if (!pages.length || /^\s*(?:[-*]\s*)?(?:未核验|待核实)/u.test(part)) return false;
  // OCR can support a text summary. Amounts and percentages still need
  // the numeric verification path, even if the OCR happens to contain them.
  const content = part.replace(locators, '');
  const quantities = content.replace(/^\s*\d+[.、]\s*/u, '')
    .replace(/\b20\d{2}(?:\s*年(?:\s*\d{1,2}\s*月(?:\s*\d{1,2}\s*日)?)?)?/gu, '');
  if (/\d/.test(quantities)) return false;
  const claims = [...content.matchAll(/\b20\d{2}\b/g)].map(match => match[0]);
  const materialPages = new Map();
  for (const call of calls) {
    const d = call.result?.details || call.details;
    if (call.name !== 'pdf_read' || !call.success || toolEvidenceState(call) !== 'success' ||
        !d?.materialId || !currentCitation(d, versions)) continue;
    if (/\.pdf\b/iu.test(part) && !part.includes(d.filename)) continue;
    const source = materialPages.get(d.materialId) || new Map();
    for (const page of d.evidence || []) {
      if (page.ocr && page.text.trim()) source.set(page.page, page.text);
    }
    if (source.size) materialPages.set(d.materialId, source);
  }
  if (materialPages.size !== 1) return false;
  const source = materialPages.values().next().value;
  return pages.every(page => source.has(page)) && claims.every(year => pages.some(page => source.get(page).includes(year)));
}

// On exhaustion or interruption only release complete, separately sourced
// sentences or table rows and their verified source fields.
export function verifiedPortion(answer, blocks, reportFor, findingsFor, coverage, ocrSource = () => false) {
  const verified = [];
  const anchors = [];
  let retainedAll = true;
  for (const { header, raw, parts } of blocks) {
    const eligible = part => !coverage.unsupported.has(part) && (!coverage.missing.length || coverage.supported.has(part));
    const sources = new Map();
    const kept = parts.map((part, index) => {
      if (!eligible(part)) return false;
      const report = reportFor(part);
      const sourced = coverage.verifiedEndings.has(part) ||
        (/[。！？.!?]$/.test(part) || report.endsWithIdField) &&
          (adoptedCitations(part, report.citations).length || ocrSource(part));
      if (!sourced || findingsFor(part).some(blockingFinding)) return false;
      if (report.historical?.length === 1) sources.set(index, report.historical[0].citation);
      return true;
    });
    const render = rows => [...(header ? [header] : []), ...rows].join('\n');
    const core = parts.filter((_, i) => kept[i]);
    if (core.length) anchors.push(render(core));
    if (!header) for (const [index, source] of sources) {
      for (const step of [-1, 1]) {
        let adjacent = true;
        for (let i = index + step; i >= 0 && i < parts.length && !kept[i]; i += step) {
          if (eligible(parts[i]) && verifiedSourceNote(parts[i], source, !adjacent)) {
            kept[i] = true;
            continue;
          }
          // An ID names its cell even across an omitted heading or claim.
          // Do not carry it across another source or a conflicting field.
          if (sources.size !== 1 || extractLocatorMatches(parts[i]).length ||
              checkSourceFields(parts[i], [], null, source, [source]).hasFields) break;
          adjacent = false;
        }
      }
    }
    retainedAll &&= kept.every(Boolean);
    const rows = parts.filter((_, i) => kept[i]);
    if (rows.length) {
      // Keep the Markdown between adjacent verified sentences and fields.
      // A run ends at every omitted claim so its text cannot leak back in.
      if (raw && sources.size) {
        let offset = 0;
        let start = -1;
        for (const [i, part] of parts.entries()) {
          const at = raw.indexOf(part, offset);
          if (kept[i] && start < 0) start = at;
          offset = at + part.length;
          if (kept[i] && !kept[i + 1]) {
            verified.push(raw.slice(start, offset));
            start = -1;
          }
        }
      } else verified.push(render(rows));
    }
  }
  const body = retainedAll ? answer : verified.join('\n\n');
  if (body && !findingsFor(body).some(blockingFinding)) return body;
  // Combining notes with different anchors may introduce ambiguity.
  const core = anchors.join('\n\n');
  return core && core !== body && !findingsFor(core).some(blockingFinding) ? core : '';
}


// Research delivery retains complete, independently supported paragraphs and
// conditional reasoning. Historical-source queries still use verifiedPortion.
// Never promote a dependent conclusion after removing its disputed premise.
export function researchPortion(answer, findingsFor, findings, citations = [], {maxChars=Infinity,visibleHistory,question=''}={}) {
  // Findings are bound to the complete current draft. Re-linting isolated
  // paragraphs loses issuer, period, heading and reconciled source context.
  // A missing locator in a short paragraph is not new contradictory evidence.
  const kept=[],blocking=findings.filter(blockingFinding);
  const span=f=>f.sourceText || f.excerpt;
  const plain=s=>String(s || '').replace(/[*`#]/g,'').replace(/\s+/g,' ').trim().replace(/^(?:[-+•]|\d+[.)])\s+/, '');
  const overlaps=(a,b)=>!!plain(a) && !!plain(b) && (plain(a).includes(plain(b)) || plain(b).includes(plain(a)));
  // Identify conclusions, then resolve their scope against the full draft.
  const dependent=s=>{
    const value=plain(s).replace(/^(?:更正说明|更正|订正|修正|勘误)[：:]\s*/, '');
    if(/^这是一(?:份|个|种|套|张)(?:[^。！？]{0,30})(?:模型|报告|年报|报表|工作簿|估值方法)/.test(value))return false;
    return /^(?:因此|所以|由此|据此|综上|总之|综合上述|总体(?:上|而言)|整体(?:上|而言)|结论[：:]|判断[：:]|这个|这些|上述|它(?:来自|代表|意味着|取决于)|这(?:是|说明|表明|意味着)|该项|该数值|该结果|该空间)/.test(value) ||
      /判断(?:成立|不成立|正确|错误)|结论(?:成立|不成立)|被[^。！？\n]{0,40}(?:推翻|证伪|证实|否定)|(?:推翻|证伪|否定)了|已被证伪|明显低估|明显高估|已经兑现/.test(value);
  };
  // A public correction is content. Only suppress an internal edit label when
  // the host knows no prior answer was delivered and correction wasn't asked
  // for. Even then keep its independently checked factual body.
  const correctionText=s=>Array.isArray(visibleHistory) && !visibleHistory.length && !/更正|纠正|订正|修正|勘误|校对/.test(question)
    ? s.replace(/^(\s*(?:\*\*)?)(?:更正说明|更正|订正|修正|勘误)(?:\*\*)?[：:]\s*(?:\*\*)?/, '') : s;
  const presentation=s=>((s.match(/\*\*/g) || []).length%2?s.replace(/\*\*/g,''):s).trim();
  const citationOnly=s=>{
    let value=s;
    if(/^(?:计算|复算|模型测算|模型(?:分产品收入|资本开支)测算)[。.]?$/.test(plain(value)))return true;
    // Older recorded drafts can already contain a stranded closing source
    // fragment from an upstream split inside a citation's semicolon.
    if(/^(?:公告|来源|出处)\s*(?:19|20)\d{2}[-年]/.test(plain(value)) && /[\]】][。.]?$/.test(value.trim()))return true;
    for(const r of extractLocatorMatches(value).reverse())value=value.slice(0,r.index)+value.slice(r.index+r.raw.length);
    return !value.replace(/\[[^\]]+\]|[A-Z]{1,3}\d+|模型全模型重算|模型重算|全模型重算|[\s、，；;。.*`]/g,'');
  };
  const tokens=Lexer.lex(answer), rejectedDependency=answerDependencies(tokens,blocking,dependent);
  let notice=false,contentCount=0;
  const omit=()=>{if(!notice){kept.push('> 本节部分内容尚未完成核验，相关数值及依赖结论暂不采用。');notice=true;}};
  const retain=(raw,token)=>{
    if(!raw.trim())return;
    const issues=blocking.filter(f=>span(f) && overlaps(raw,span(f)));
    const sentences=researchStatementSpans(raw);
    // The host appends actual per-file receipts. A false save-status sentence
    // is not a missing financial premise for the rest of this section.
    if(issues.length && issues.every(f=>f.rule==='artifact_status'))return;
    // A verdict paragraph carries one argument across its sentences. Do not
    // keep its unmarked continuation after removing only the opening verdict.
    if(!issues.length && rejectedDependency(raw,token)){omit();return;}
    if(!issues.length && !sentences.some(sentence=>rejectedDependency(sentence,token))) {
      if(citationOnly(raw))return;
      kept.push(presentation(correctionText(raw)));contentCount++;return;
    }
    // Preserve independent complete sentences. If an issue spans multiple
    // sentences, keep the whole span blocked; never guess its numeric target.
    const multi=sentences.length>1 && issues.every(f=>sentences.some(s=>plain(s).includes(plain(span(f)))));
    if(!multi){omit();return;}
    for(const sentence of sentences) {
      if(issues.some(f=>overlaps(sentence,span(f))) || rejectedDependency(sentence,token))omit();
      else if(!citationOnly(sentence)){kept.push(presentation(correctionText(sentence)));contentCount++;}
    }
  };
  for(const token of tokens) {
    if(token.type==='space')continue;
    if(token.type==='heading') {
      // Numeric assertions in headings need the same check as body claims.
      if(blocking.some(f=>span(f) && overlaps(token.raw,span(f)))){omit();continue;}
      // A verdict heading is itself dependent on possibly removed premises.
      if(rejectedDependency(token.raw,token)){omit();continue;}
      kept.push(token.raw.trim());notice=false;continue;
    }
    if(token.type==='list')for(const item of token.items)retain(item.raw,token);
    else if(token.type==='table') {
      const lines=token.raw.trimEnd().split(/\r?\n/),rows=lines.slice(2);
      const rejected=rows.map(row=>blocking.some(f=>span(f) && overlaps(row,span(f))));
      const keptRows=rows.filter((row,i)=>!rejected[i] && !(rejected.some(Boolean) && /合计|总计|因此|据此|结论/.test(row)));
      if(keptRows.length){kept.push([...lines.slice(0,2),...keptRows].join('\n'));contentCount++;}
      if(keptRows.length!==rows.length)omit();
    }
    else if(token.type==='code' && blocking.some(f=>span(f) && overlaps(token.raw,span(f))))omit();
    else retain(token.raw,token);
  }
  if(!contentCount)return '';
  if (!kept.length) return '';
  const labels={value:'数值',unit:'单位',currency:'币种',period:'期间',metric:'指标口径',basis_type:'实际与预测口径',dependency:'计算依据',source:'来源'};
  const gaps=[...new Set(findings.filter(blockingFinding).map(f=>
    f.claim ? `${f.claim.metric || '部分数据'}的${labels[f.field] || '证据'}` :
    f.rule==='delivery_gap' ? (f.excerpt?f.message.replaceAll(f.excerpt,'该项结论'):f.message) : f.rule==='incomplete' ? '答复完整性' : '部分结论的证据'
  ))].slice(0,6);
  // Lead with the supported answer. The partial delivery state and its reason
  // belong to the host's disclosure; specific limits still stay with the text.
  const body=closeResearchDocument(answer,kept.join('\n\n')).text+
    '\n\n**仍待核实**：'+(gaps.join('；') || '部分补充核验未完成')+'。';
  // Let the existing sentence-aware bounded fallback handle strict budgets.
  // Never truncate a number, source, table or JSON object by character slicing.
  return answerCharCount(body)<=maxChars ? body : '';
}
