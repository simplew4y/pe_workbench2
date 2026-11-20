import {existsSync} from 'node:fs';
import {validCitations} from '../../lib/contracts/citation.mjs';
import {collectCitationsFromToolCalls, toolEvidenceState} from '../../lib/citations.mjs';
import {citationFilenames, locatorKey} from '../../lib/citation-locator.mjs';
import {matchesQuery, retryOf} from './transcript-search-recovery.mjs';
import {observedAttachmentFields} from './source-attachments.mjs';
import {digest} from './source-plan.mjs';

function scoped(args, turn) {
  if (!turn) return true;
  if (args?.turn != null) return args.turn === turn;
  return args?.turnRange?.[0] <= turn && args.turnRange[1] >= turn;
}
function identity(c) {
  return [c.materialId, c.version, locatorKey(c.locator)].join('\u0000');
}

export function conditionValue(predicate, items) {
  if (!predicate?.items.length) return undefined;
  const values = predicate.items.map((id) => {
    const o = items.find((row) => row.item.id === id);
    return o?.hits.length ? true : o?.empty ? false : undefined;
  });
  const decisive = predicate.all ? false : true;
  const value = values.includes(decisive)
    ? decisive
    : values.every((v) => v !== undefined)
      ? !decisive
      : undefined;
  return value === undefined ? undefined : predicate.negate ? !value : value;
}

export function sourceObservations(plan, scanned, live, catalog) {
  const attachmentItems = plan.items.filter(i => i.action === 'readAttachment');
  const byId = new Map(),
    conflicts = new Set(),
    rawIdentities = new Map(),
    badIds = new Set();
  for (const [origin, copies] of [
    ['pi', scanned],
    ['live', live],
  ]) {
    for (const call of copies) {
      const attachmentRead = call.name === 'read' && attachmentItems.some(i => i.path === call.args?.path);
      if (!call.id || (!attachmentRead && !['transcript_search', 'workbook_query', 'workbook_trace'].includes(call.name)))
        continue;
      const prior = byId.get(call.id);
      const state =
        call.success === true && call.result && call.result.isError !== true
          ? toolEvidenceState(call)
          : 'failed';
      const details = call.result?.details ?? call.details;
      const attachmentFields = attachmentRead && state === 'success' ? observedAttachmentFields(attachmentItems, call, digest) : [];
      const fingerprint = digest(JSON.stringify([call.name, call.args, state, details ?? null, attachmentFields]));
      const observation = {
        startedAt: call.startedAt ?? null,
        finishedAt: call.finishedAt ?? call.result?.timestamp ?? null,
        id: call.id,
        name: call.name,
        args: call.args ?? {},
        origin,
        state,
        details,
        fingerprint,
        ...(attachmentRead ? {attachmentFields} : {}),
        argumentsError: call.argumentsError ?? prior?.argumentsError,
      };
      if (state === 'success' || state === 'partial') {
        const rows =
          call.name === 'transcript_search'
            ? (details?.matches ?? [])
                .filter((h) => h.role === 'assistant')
                .flatMap((h) => validCitations(h.citations))
            : [details?.citations, details?.presentation?.payload?.citations].flatMap((list) =>
                validCitations(list),
              );
        for (const c of rows) {
          const previous = rawIdentities.get(c.id);
          if (
            previous &&
            (identity(previous) !== identity(c) ||
              (previous.sha256 && c.sha256 && previous.sha256 !== c.sha256))
          )
            badIds.add(c.id);
          else rawIdentities.set(c.id, c);
        }
      }
      if (prior?.origin === origin && prior.fingerprint !== fingerprint) conflicts.add(call.id);
      if (prior && prior.origin !== origin && prior.fingerprint !== fingerprint)
        observation.priorDigest = prior.fingerprint;
      byId.set(call.id, observation);
    }
  }
  const attempts = [...byId.values()];
  const witnesses = [];
  for (const call of attempts) {
    if (conflicts.has(call.id)) call.state = 'conflict';
    if (!['success', 'partial'].includes(call.state) || !call.details) continue;
    if (call.name === 'read') continue;
    if (call.name === 'transcript_search') {
      if (call.state !== 'success') continue;
      for (const [matchIndex, hit] of (call.details.matches ?? []).entries()) {
        if (hit.role !== 'assistant' || !Number.isInteger(hit.turn)) continue;
        for (const citation of validCitations(hit.citations)) {
          if (!citation.version) continue;
          witnesses.push({
            relation: 'historical',
            citation,
            callId: call.id,
            matchIndex,
            turn: hit.turn,
            sourceTurnId: hit.sourceTurnId ?? null,
            legacyAnchor: hit.legacyAnchor ?? null,
            sourceStatus: hit.sourceStatus ?? 'unknown',
            limits: hit.sourceLimits ?? [],
            sourceClaims: hit.sourceClaims ?? [],
          });
        }
      }
    } else {
      // Inspect both original lists before collectCitationsFromToolCalls deduplicates.
      for (const list of [call.details.citations, call.details.presentation?.payload?.citations]) {
        for (const c of validCitations(list)) {
          const details = {...call.details, citations: [c], presentation: undefined};
          const [citation] = collectCitationsFromToolCalls([{success: true, status: call.state, details}]);
          if (citation?.version)
            witnesses.push({
              relation: 'read',
              citation,
              callId: call.id,
              readAt: call.finishedAt,
              selection: call.args.version == null && call.args.versionId == null ? 'head' : 'version',
            });
        }
      }
    }
  }
  const identities = new Map();
  for (const {citation: c} of witnesses) {
    const prior = identities.get(c.id);
    if (
      prior &&
      (identity(prior) !== identity(c) ||
        (prior.sha256 && c.sha256 && prior.sha256 !== c.sha256) ||
        (prior.value != null && c.value != null && prior.value !== c.value))
    )
      badIds.add(c.id);
    else identities.set(c.id, c);
  }
  const eligible = witnesses.filter((w) => {
    if (badIds.has(w.citation.id)) return false;
    if (!catalog?.getVersionRow) return true;
    const c = w.citation,
      row = catalog.getVersionRow(c.materialId, c.version)?.version;
    return (
      row?.v === c.version &&
      (!c.sha256 || row.blob_sha256 === c.sha256) &&
      (!catalog.blobPath || existsSync(catalog.blobPath(row.blob_sha256)))
    );
  });
  const items = [];
  for (const item of plan.items.filter((i) => i.action === 'search')) {
    const attemptsInScope = attempts.filter(
      (c) =>
        c.name === 'transcript_search' &&
        c.state === 'success' &&
        c.details &&
        scoped(c.args, item.turn) &&
        (!item.query || matchesQuery(item.query.toLowerCase(), c, item.turn)),
    );
    const hits = eligible.filter(
      (w) =>
        w.relation === 'historical' &&
        (!item.turn || item.turn === w.turn) &&
        (!item.book || citationFilenames(w.citation).includes(item.book)) &&
        attemptsInScope.some((c) => c.id === w.callId),
    );
    const empty = attemptsInScope.find((c) => {
      const d = c.details;
      if (
        !item.query ||
        item.operation !== 'exists' ||
        !d.coverage ||
        d.coverage.truncated !== false ||
        !Array.isArray(d.matches) ||
        d.matches.length !== d.totalMatches ||
        d.coverage.turnsScanned < 1 ||
        (item.turn && !d.coverage.turns?.includes(item.turn)) ||
        c.args.query?.trim().split(/\s+/).length > 20
      )
        return false;
      return !d.matches.some(
        (h) =>
          h.role === 'assistant' &&
          (!item.turn || h.turn === item.turn) &&
          (!item.book ||
            !h.citations?.length ||
            h.citations.some(
              (c) =>
                !c.version ||
                badIds.has(c.id) ||
                citationFilenames(c).includes(item.book) ||
                !citationFilenames(c).length,
            )),
      );
    });
    // A different query can independently establish the source of the named
    // formal turn, but cannot discharge the requested search or prove absence.
    const related =
      item.turn && item.needsLocator
        ? eligible.filter(
            (w) =>
              w.relation === 'historical' &&
              w.turn === item.turn &&
              (!item.book || citationFilenames(w.citation).includes(item.book)),
          )
        : [];
    items.push({item, hits, related, empty: empty?.id, attemptIds: attemptsInScope.map((c) => c.id)});
  }
  const searches = plan.items.filter((i) => i.action === 'search');
  const targets = searches
    .filter((i) => i.query)
    .map((i) => ({query: i.query.toLowerCase(), turns: i.turn ? [i.turn] : []}));
  const rounds = new Set(searches.map((i) => i.turn).filter(Boolean));
  const recoveryGaps = [];
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.name !== 'transcript_search' || attempt.state !== 'failed') continue;
    const recovered = attempts
      .slice(index + 1)
      .some(
        (next) =>
          next.name === 'transcript_search' &&
          items.some((i) => (i.hits.length || i.empty) && i.attemptIds.includes(next.id)) &&
          retryOf(attempt, next, targets, rounds),
      );
    if (!recovered)
      recoveryGaps.push(
        '检索尝试尚未恢复：' +
          [attempt.args.query, attempt.args.turn ? '第' + attempt.args.turn + '轮' : '', attempt.id]
            .filter(Boolean)
            .join(' '),
      );
  }
  // A failed independent material read is still an execution gap. A search
  // for a source in Pi cannot attest to the inaccessible workbook.
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.name === 'transcript_search' || attempt.state !== 'failed') continue;
    const recovered = attempts
      .slice(index + 1)
      .some(
        (c) =>
          c.name === attempt.name &&
          c.state === 'success' &&
          JSON.stringify(c.args) === JSON.stringify(attempt.args),
      );
    if (!recovered)
      recoveryGaps.push('未能核实工具读取：' + attempt.name + ' ' + (attempt.args.path ?? attempt.id));
  }
  const historyToolsOnly=[...scanned,...live].every(c=>c.name==='transcript_search');
  return {attempts, witnesses: eligible, items, badIds: [...badIds], recoveryGaps, historyToolsOnly};
}
