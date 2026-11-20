import { asLegacyFact, lintFactIdentity } from '../../lib/fact-memory/context.mjs';
/** Shared user-turn lifecycle. Automated watch/tracking prompts never use this wrapper. */
import { buildTurnContext, checkTurnTools } from '../../lib/turn-context.mjs';
import { pendingMerges, readLedger, readLedgerSync } from '../../lib/ledger.mjs';
import { recordUserClaims } from '../../lib/claim-detect.mjs';
import { randomUUID } from 'node:crypto';
import { lintAnswer, lintLedgerAnswer, answerStats, asksDeviationQuestion, contextModelTarget } from '../../lib/answer-lint.mjs';
import { collectCitationsFromToolCalls, currentCitation, rehydrateCitations, toolEvidenceState } from '../../lib/citations.mjs';
import { validCitations } from '../../lib/contracts/citation.mjs';
import { markStaleVersions, registerToolResult } from '../../lib/fact-register.mjs';
import { frameworkForTurn, textOfContent } from './snapshot.mjs';
import { indexJson, locateChatTopics, recentTopicDialogue } from './topic-locator.mjs';
import { updateTopicsFromFacts } from '../../lib/topic-index.mjs';

import { activateQueuedTurn, startTurn, saveTurnDelivery } from './turn-delivery.mjs';
import { sourceSearchGap } from './transcript-search-recovery.mjs';
import { adoptedCitations, asksHistoricalSource, answerBlocks, answerGaps, blockingFinding, reportedLocatorEvidence, joinContinuation, verifiedPortion, workbookItemCoverage } from './answer-delivery.mjs';
import { CONTEXT_BUDGET_FAILURE, isContextBudgetError } from '../../lib/context-budget.mjs';

export function runWithPostAnswer(entry, text, options = {}, broadcast = () => {}) {
  const { runId, attachments, ...promptOptions } = options;
  const prompt = attachments?.length
    ? `${text}\n\n[已上传资料]\n${attachments.map(path => `- ${path}`).join('\n')}`
    : text;
  if (entry.automated) return entry.session.prompt(prompt, promptOptions);
  const previous = entry.postAnswerRun;
  const turn = { turnId: randomUUID(), question: text, startedAt: new Date().toISOString() };
  if (runId) turn.runId = runId;
  if (previous) turn.queued = true;
  startTurn(entry, turn);
  entry.postAnswerPending = true;
  const execute = async () => {
    if (turn.queued) activateQueuedTurn(entry, turn.turnId);
    entry.managedChat = true;
    const active = entry.activeTurn = { ...turn, attachments, cancelled: false };
    broadcast({ type: 'turn.started', turnId: turn.turnId, question: text, startedAt: turn.startedAt });
    let outcome;
    try {
      outcome = await generateAnswer(entry, prompt, promptOptions, active);
    } catch (error) {
      outcome = { status: 'failed', text: '', citations: [], reason: failureReason(error) };
    }
    if (active.cancelled) outcome = { ...outcome, status: 'cancelled', reason: '用户已取消本次回答。' };
    try {
      const framework = outcome.status === 'completed' || outcome.status === 'partial'
        ? frameworkForTurn(entry.session, entry.ctx, turn.turnId, active.frameworkEdits)
        : null;
      const presentation = framework ? {
        ...framework,
        turnStartedAt: turn.startedAt,
        analysisStatePendingMerge: pendingMerges(readLedgerSync(entry.ctx.root, entry.id))
          .some(item => item.path === framework.analysisStatePath),
      } : {};
      if (!framework && active.frameworkEdits?.size) presentation.analysisState = null;
      const record = saveTurnDelivery(entry, { version: 1, turnId: turn.turnId, ...(turn.runId ? { runId: turn.runId } : {}), finishedAt: new Date().toISOString(), ...outcome, ...presentation });
      try {
        broadcast({ type: 'turn.delivered', record });
        entry.onTurnDelivered?.(record);
      } catch (error) {
        console.warn('[chat] Turn delivery notification failed:', error.message);
      }
      return record;
    } finally {
      entry.activeTurn = null;
    }
  };
  const run = previous ? previous.catch(() => {}).then(execute) : execute();
  entry.postAnswerRun = run;
  return run.finally(() => {
    if (entry.postAnswerRun === run) {
      entry.postAnswerPending = false;
      entry.postAnswerRun = null;
      // Snapshot joins (e.g. an unavailable tool-card table) cannot change
      // the already persisted decision returned to the other transport.
      try {
        if (entry.snapshot) broadcast(entry.snapshot());
      } catch (error) {
        console.warn('[chat] Could not refresh the session snapshot:', error.message);
      }
    }
  });
}

function failureReason(error) {
  const reason = String(error?.message || error || '没有生成可交付的回答。');
  return isContextBudgetError(reason) ? CONTEXT_BUDGET_FAILURE : reason;
}

async function generateAnswer(entry, promptText, options, active) {
  const { turnId, question: text } = active;
  entry.ctx?.factMemory?.recover();
  let correctionCount = 0;
  let continuationCount = 0;
  let safeText = '';
  let safeCitations = [];
  const interrupted = reason => ({
    status: active.cancelled ? 'cancelled' : safeText ? 'partial' : 'failed',
    text: safeText, citations: safeCitations, reason: failureReason(reason),
  });
  let latestMessage;
  let continuationPrefix = null;
  const toolCalls = entry.turnToolCalls = [];
  const registrationJobs = [];
  const turnBoundary = entry.session.messages.length;
  let candidateCallStart = 0;
  let candidateMessageStart = turnBoundary;
  entry.transcriptBoundary = turnBoundary;
  // Explicit user corrections become append-only claims before the model responds.
  const turn = entry.session.messages.filter(m => m.role === 'user' && !m.peInternal && !m.customType).length + 1;
  try { await recordUserClaims(entry.ctx?.root, entry.id, text, { turn }); } catch { /* never block the turn */ }
  const priorDialogue = recentTopicDialogue(entry.session.messages.slice(0, turnBoundary));
  const ledgerBefore=await readLedger(entry.ctx?.root,entry.id);
  const correctionIds=(ledgerBefore?.facts||[]).filter(f=>f.source==='user_correction'&&f.turn===turn&&f.status==='current').map(f=>f.id);
  if(correctionIds.length) await updateTopicsFromFacts(entry.ctx?.root,entry.id,{factIds:correctionIds}).catch(()=>[]);
  const locator = input => locateChatTopics(entry.indexModel, input, entry.modelPayload);
  const context = await buildTurnContext({ question: text, history:priorDialogue, root: entry.ctx?.root, sessionId: entry.id, factMemory:entry.ctx?.factMemory, locator:ledgerBefore?.topics?.length?locator:undefined });
  // DT-8: opt-in delivery checklist only. Empty/absent keeps old behavior.
  const requiredSections = Array.isArray(options.requiredSections)
    ? options.requiredSections
    : Array.isArray(entry.requiredSections) ? entry.requiredSections : null;
  const injectedLintContext = { ...(entry.answerLintContext || {}), ...(options.answerLintContext || {}) };
  const asksDeviation = injectedLintContext.userAsksDeviation ?? asksDeviationQuestion(text);
  const baseLintContext = {
    ...injectedLintContext,
    ...(asksDeviation ? { userAsksDeviation: true } : {}),
    ...(requiredSections?.length ? { requiredSections } : {}),
  };
  const unsubscribe = entry.session.subscribe?.(event => {
    if (event.type === 'message_end' && event.message?.role === 'assistant') latestMessage = event.message;
    if (event.type === 'tool_execution_start') toolCalls.push({ id: event.toolCallId, name: event.toolName, args: event.args, messageIndex: entry.session.messages.length, success: false });
    if (event.type === 'tool_execution_end') {
      const call = toolCalls.findLast(c => c.id === event.toolCallId);
      if (call) {
        call.details = event.result?.details; call.result=event.result;
        call.success = event.isError === false && toolEvidenceState(event.result) !== 'failed';
        if(call.success) registrationJobs.push(registerToolResult(entry.ctx?.root,entry.id,call,{turn}).catch(()=>[]));
      }
    }
    if (event.type === 'agent_settled' && event.aborted) active.cancelled = true;
  });
  try {
    const priorCitations = Array.isArray(entry.citationIndex) ? entry.citationIndex : [];
    let boundary = entry.session.messages.length;
    if (active.cancelled) return interrupted('用户已取消本次回答。');
    // Older fake sessions may omit custom messages: context injection is skipped there.
    if (entry.session.sendCustomMessage) await entry.session.sendCustomMessage({ customType: 'pe_turn_context', content: context.content, display: false, details: { turnId, routes: context.routes } }, { deliverAs: 'nextTurn' });
    if (active.cancelled) return interrupted('用户已取消本次回答。');
    await entry.session.prompt(promptText, options);
    for (;;) {
      const message = latestMessage || entry.session.messages.slice(boundary).findLast(item => item.role === 'assistant');
      if (message?.stopReason === 'aborted') active.cancelled = true;
      if (active.cancelled) return interrupted('用户已取消本次回答。');
      if (!['length', 'stop'].includes(message?.stopReason)) {
        const failedTool = toolCalls.findLast(call => !call.success);
        return interrupted(message?.errorMessage || (failedTool && `工具 ${failedTool.name} 执行失败。`));
      }
      const delta = textOfContent(message.content);
      const prefix = continuationPrefix ?? '';
      const joined = message.researchContinuation ? delta : joinContinuation(prefix, delta);
      const noProgress = continuationPrefix !== null && joined.trimEnd() === prefix.trimEnd();
      const answer = joined.trim();
      // Also support restored/minimal sessions that expose tool messages but no events.
      const scanned = [];
      const messages = entry.session.messages.slice(turnBoundary);
      for (const [index, m] of messages.entries()) for (const c of Array.isArray(m.content) ? m.content : []) {
        if (c.type !== 'toolCall') continue;
        const result = messages.find(r => r.role === 'toolResult' && r.toolCallId === c.id);
        scanned.push({ messageIndex: turnBoundary + index, id:c.id, name: c.name, args: c.arguments, argumentsError: c.argumentsError, success: Boolean(result) && result.isError === false && toolEvidenceState(result) !== 'failed', details:result?.details, result });
      }
      for(const call of scanned) if(call.success) registrationJobs.push(registerToolResult(entry.ctx?.root,entry.id,call,{turn}).catch(()=>[]));
      const registered= (await Promise.all(registrationJobs)).flat().filter(Boolean);
      // Deduplicate restored and live copies by execution ID. The live terminal
      // event is authoritative, including a failure with a valid-looking payload.
      const calls = [...new Map([...scanned, ...toolCalls].map(call => [call.id, call])).values()];
      const thisTurnCitations = collectCitationsFromToolCalls(calls.toReversed());
      const historical = calls.filter(call => call.success && call.name === 'transcript_search')
        .flatMap(call => call.details?.matches || [])
        .filter(match => match?.role === 'assistant' && Number.isInteger(match.turn))
        .map(match => ({ turn: match.turn, citations: validCitations(match.citations).filter(cite => cite.version) }));
      const currentVersions = { ...entry.materialVersions };
      let refreshedLedger = await readLedger(entry.ctx?.root, entry.id);
      if(entry.ctx?.factMemory) {const project=entry.ctx.factMemory.query({limit:100}); refreshedLedger={...(refreshedLedger || {}),corrections:[],facts:project.facts.map(asLegacyFact)};}
      const materialIds = new Set([...thisTurnCitations, ...(refreshedLedger?.facts || []).map(f => f.citation)]
        .map(c => c?.materialId).filter(Boolean));
      for (const id of materialIds) {
        const latest = entry.ctx?.store?.getLatestMaterialVersion?.(id)?.v;
        if (latest != null) currentVersions[id] = latest;
      }
      // Minimal sessions may have no material catalogue. Use the newest
      // observed version in that case, independent of tool completion order.
      const observedVersions = new Map();
      for (const {materialId, version} of thisTurnCitations) if (version) {
        observedVersions.set(materialId, Math.max(version, observedVersions.get(materialId) || 0));
      }
      for (const [id, version] of observedVersions) currentVersions[id] ??= version;
      await markStaleVersions(entry.ctx?.root,entry.id,currentVersions).catch(()=>0);
      if(registered.length) await updateTopicsFromFacts(entry.ctx?.root,entry.id,{factIds:registered.map(f=>f.id),proposer:async({topic,facts})=>indexJson(entry.indexModel,`根据已核事实提出一个用于检索的主题标题、摘要和 binding。摘要不得添加事实数字，只描述指标和期间。严格 JSON 输出 {"title":"...","summary":"...","binding":{...}}。候选主题:${JSON.stringify(topic)}\n已核事实:${JSON.stringify(facts.map(f=>({id:f.id,claim:f.claim,binding:f.binding,period:f.period})))}`,entry.modelPayload)}).catch(()=>[]);
      const turnCitations = rehydrateCitations({register:refreshedLedger,answer,thisTurnCitations,currentVersions,toolCalls:calls});
      entry.citationIndex = turnCitations;
      const lintContext = { ...baseLintContext, question:text, citations: turnCitations, toolCalls: calls, currentVersions, ...(priorCitations.length ? { priorCitations } : {}) };
      const workbookReads = calls.filter(call => call.name === 'workbook_query' || call.name === 'workbook_trace');
      const workbookEvidence = collectCitationsFromToolCalls(workbookReads).filter(c => currentCitation(c, currentVersions));
      const blocks = answerBlocks(answer);
      const workbookTurn = active.attachments?.some(path => /\.xls[xm]$/i.test(path)) || workbookReads.length > 0;
      const coverage = workbookItemCoverage(text, blocks, workbookEvidence, workbookTurn);
      const locatorEvidence = candidate => reportedLocatorEvidence(candidate, text, turnCitations, historical, workbookEvidence);
      const sourceReport = locatorEvidence(answer);
      const available = sourceReport.citations;
      const findingsFor = (candidate, checkContext = lintContext) => {
        const lastLine = candidate.slice(candidate.lastIndexOf('\n') + 1);
        const report = candidate === answer ? sourceReport : locatorEvidence(candidate);
        const verifiedEnding = coverage.verifiedEndings.has(lastLine) || report.endsWithIdField || report.endsWithNoGaps;
        const lint = lintAnswer(candidate, { ...checkContext, locatorCitations: report.citations }).filter(finding =>
          finding.rule !== 'incomplete' || finding.message !== '句末可能截断' || !verifiedEnding);
        if (report.conflict) lint.push({
          rule: 'unverified_locator', severity: 'error', message: '出处所述材料、版本或引用缺少对应证据',
          excerpt: report.conflict, expected: '历史出处须与命中的正式答文一致，当前版本须由本轮读取同一材料核实',
        });
        return [
          ...lintFactIdentity(candidate, entry.ctx?.factMemory, { question: text }),
          ...lint,
          ...lintLedgerAnswer(candidate, refreshedLedger, {
            ...checkContext, locatorCitations: report.citations, locatorFindings: lint.filter(f => f.rule === 'unverified_locator'), toolCalls: calls,
          }),
          ...checkTurnTools({ answer: candidate, routes: context.routes, toolCalls: calls }),
        ];
      };
      const findings = findingsFor(answer);
      const adopted = adoptedCitations(answer, available);
      const adoptedIds = new Set([...adopted.map(citation => citation.id), ...coverage.evidenceIds]);
      const candidateCalls = [...scanned.filter(call => call.messageIndex >= candidateMessageStart), ...toolCalls.slice(candidateCallStart)];
      const lastVerifiedRead = candidateCalls.findLastIndex(call => call.name === 'workbook_query' && call.success &&
        collectCitationsFromToolCalls([call]).some(citation => adoptedIds.has(citation.id)));
      for (const gap of new Set([...answerGaps(answer), ...coverage.missing])) {
        if (gap === '无' && sourceReport.endsWithNoGaps) continue;
        findings.push({ rule: 'delivery_gap', severity: 'error', message: `未核验：${gap}`, excerpt: gap });
      }
      if (message.stopReason === 'length' && !findings.some(f => f.rule === 'incomplete')) {
        findings.push({ rule: 'incomplete', severity: 'error', message: '模型达到输出长度上限', expected: '从断点补完回答' });
      }
      if (noProgress) findings.push({ rule: 'incomplete', severity: 'error', message: '续写没有补充缺失内容。' });
      const data = {
        version: 1, turnId, timestamp: new Date().toISOString(),
        findings, stats: answerStats(answer), correctionCount, continuationCount,
        citations: available,
        messageIndex: entry.session.messages.lastIndexOf(message),
      };
      // Custom entries are durable metadata, never model-visible chat messages.
      entry.session.sessionManager?.appendCustomEntry('pe_answer_lint', data);
      entry.answerLint = data;
      // A requested item already classified as a delivery gap follows the
      // established partial-delivery path. Other identity errors get one retry.
      const errors = findings.filter(item => item.severity === 'error' && !['incomplete', 'delivery_gap'].includes(item.rule) &&
        !(item.rule === 'evidence_identity_mismatch' && [...coverage.unsupported].some(part => part.includes(item.excerpt))));
      const incomplete = findings.some(item => item.rule === 'incomplete');
      const unverified = findings.filter(item => item.rule === 'unverified_locator' || item.rule === 'orphaned_number');
      const blocking = findings.filter(blockingFinding);
      // A retry may change the sheet or path. Only count a successful read
      // toward recovery if the final answer actually cites its evidence.
      const latestTools = new Map();
      for (const call of candidateCalls) latestTools.set(call.name + JSON.stringify(call.args || {}), call);
      const sourceQuestion = asksHistoricalSource(text);
      const searchGap = sourceQuestion && sourceSearchGap(text, answer, scanned, toolCalls, sourceReport.historical, blocks, coverage,
        clause => Boolean(locatorEvidence(clause).historical?.length) && !findingsFor(clause).some(blockingFinding));
      const failedTool = [...latestTools.values()].find(call => !call.success &&
        !(sourceQuestion && call.name === 'transcript_search') &&
        (call.name !== 'workbook_query' || candidateCalls.lastIndexOf(call) >= lastVerifiedRead));
      const toolGap = [searchGap, failedTool && `工具 ${failedTool.name} 执行失败。`].filter(Boolean).join('；');
      if (blocking.length || !answer || toolGap) {
        safeText = verifiedPortion(answer, blocks, locatorEvidence,
          part => findingsFor(part, { ...lintContext, requiredSections: [] }), coverage);
        safeCitations = adoptedCitations(safeText, locatorEvidence(safeText).citations);
      } else {
        return { status: 'completed', text: answer, citations: adopted };
      }
      const facingAnswer = '直接回答用户原问题，交付一份独立、完整的回答，保留已有依据的结论与解释。若用户主动要求复核旧答，请说明改了什么以及依据。出处写在句子里，工作簿坐标采用 [文件名]Sheet!A1。用户要求的具体事项若仍缺证据，请另起一行写“未核验：具体事项”。';
      let prompt;
      let customType = 'pe_answer_correct';
      const targetErrors = errors.filter(item => item.code === 'G1' || item.code === 'G2');
      if (message.stopReason === 'length' && continuationCount < 1) {
        customType = 'pe_answer_continue';
      } else if (targetErrors.length && correctionCount < 1) {
        correctionCount++;
        continuationPrefix = null;
        const knownTarget = contextModelTarget(lintContext);
        const targetHint = knownTarget !== null ? `本会话/状态已有模型目标价 ${knownTarget}；` : '';
        prompt = `目标价/偏离答文不合格：${targetErrors.map(item => `${item.message}：${item.excerpt}`).join('；')}。\n${targetHint}请用本轮工具或会话状态中的模型目标价（valuations 的 V*.output=target_price、workbook_trace 估值输出格或明确 target_price locator）与 westock_query 现价重写首句，格式“模型目标价 <值> vs 现价 <值>，空间 ≈ <X>%”；G1/G2 只是缺口 ID，禁止写成单元格，禁止用“没有独立目标价单元格/先纠正前提/无法精确回答”挡掉；券商目标价只作对照。${facingAnswer}`;
      } else if (unverified.length && correctionCount < 1) {
        correctionCount++;
        continuationPrefix = null;
        prompt = `以下单元格引用缺少唯一可核验的出处：\n${unverified.map(item => item.excerpt).join('\n')}\n同名坐标必须补上文件名，文件同名时使用 [材料ID@v版本]Sheet!A1。没有依据的坐标应删除或注明“未核验”。若数字也没有其他出处，同时删除/替换该数字，或标明未核验。\n${facingAnswer}`;
      } else if (errors.length && correctionCount < 1) {
        correctionCount++;
        continuationPrefix = null;
        prompt = `这些数字缺少本轮结构化出处。先用工具核对：能对上的保留并写上出处，对不上的删除或标明未核验，然后写出用户会看到的回答。\n${errors.map(item => `${item.message}：${item.excerpt}；应为 ${item.expected}`).join('\n')}\n${facingAnswer}`;
      } else if (incomplete && continuationCount < 1) {
        customType = 'pe_answer_continue';
      } else {
        const gaps = [...new Set(blocking.map(item => item.message))].join('；');
        return interrupted([gaps, toolGap].filter(Boolean).join('；') || '没有生成可交付的回答。');
      }
      if (customType === 'pe_answer_continue') {
        continuationCount++;
        continuationPrefix = joined;
        prompt = '上一条回答在句中截断，请从断点继续补完，不要重复已写内容';
      }
      if (active.cancelled) return interrupted('用户已取消本次回答。');
      active.continueResearchAnswer = continuationPrefix === null ? null : delta => joinContinuation(continuationPrefix, delta);
      latestMessage = null;
      boundary = entry.session.messages.length;
      if (customType === 'pe_answer_correct') {
        candidateCallStart = toolCalls.length;
        candidateMessageStart = boundary;
      }
      if (entry.session.sendCustomMessage) {
        // SDK resolves after the triggered run settles (agent_settled), as prompt does.
        await entry.session.sendCustomMessage({ customType, content: prompt, display: false, details: { turnId, correctionCount, continuationCount } }, { triggerTurn: true });
      } else {
        // Fake/test-only compatibility. Production Pi supports sendCustomMessage.
        // Fakes that append user messages must retain peInternal (snapshot hides it).
        await entry.session.prompt(prompt, { peInternal: true });
      }
    }
  } catch (error) {
    return interrupted(error);
  } finally {
    await Promise.allSettled(registrationJobs);
    unsubscribe?.();
  }
}
