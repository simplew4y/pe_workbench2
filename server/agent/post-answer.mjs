/** Shared user-turn lifecycle. Automated watch/tracking prompts never use this wrapper. */
import { buildTurnContext, checkTurnTools } from '../../lib/turn-context.mjs';
import { readLedger } from '../../lib/ledger.mjs';
import { recordUserClaims } from '../../lib/claim-detect.mjs';
import { randomUUID } from 'node:crypto';
import { lintAnswer, lintLedgerAnswer, answerStats } from '../../lib/answer-lint.mjs';
import { textOfContent } from './snapshot.mjs';

export function runWithPostAnswer(entry, text, options = {}, broadcast = () => {}) {
  if (entry.automated) return entry.session.prompt(text, options);
  const previous = entry.postAnswerRun;
  entry.postAnswerPending = true;
  const execute = async () => {
    const turnId = randomUUID();
    let correctionCount = 0;
    let continuationCount = 0;
    let aborted = false;
    let continuationPrefix = "";
    const toolCalls = entry.turnToolCalls = [];
    const turnBoundary = entry.session.messages.length;
    entry.transcriptBoundary = turnBoundary;
    // Explicit user corrections become append-only claims before the model responds.
    const turn = entry.session.messages.filter(m => m.role === 'user' && !m.peInternal && !m.customType).length + 1;
    try { await recordUserClaims(entry.ctx?.root, entry.id, text, { turn }); } catch { /* never block the turn */ }
    const context = await buildTurnContext({ question: text, root: entry.ctx?.root, sessionId: entry.id });
    // DT-8: opt-in delivery checklist only. Empty/absent keeps old behavior.
    const requiredSections = Array.isArray(options.requiredSections)
      ? options.requiredSections
      : Array.isArray(entry.requiredSections) ? entry.requiredSections : null;
    const lintContext = requiredSections?.length
      ? { ...(entry.answerLintContext || {}), requiredSections }
      : entry.answerLintContext;
    const unsubscribe = entry.session.subscribe?.(event => {
      if (event.type === 'tool_execution_start') toolCalls.push({ id: event.toolCallId, name: event.toolName, args: event.args, success: false });
      if (event.type === 'tool_execution_end') {
        const call = toolCalls.findLast(c => c.id === event.toolCallId);
        if (call) { call.success = event.isError === false && event.result?.isError !== true; call.details = event.result?.details; }
      }
      if (event.type === 'agent_settled' && event.aborted) aborted = true;
    });
    try {
      let boundary = entry.session.messages.length;
      // Older fake sessions may omit custom messages: context injection is skipped there.
      if (entry.session.sendCustomMessage) await entry.session.sendCustomMessage({ customType: 'pe_turn_context', content: context.content, display: false, details: { turnId, routes: context.routes } }, { deliverAs: 'nextTurn' });
      await entry.session.prompt(text, options);
      for (;;) {
        const message = entry.session.messages.slice(boundary).findLast(item => item.role === 'assistant');
        if (aborted || message?.stopReason !== 'stop') break;
        const answer = continuationPrefix + textOfContent(message.content);
        // Also support restored/minimal sessions that expose tool messages but no events.
        const scanned = [];
        const messages = entry.session.messages.slice(turnBoundary);
        for (const m of messages) for (const c of Array.isArray(m.content) ? m.content : []) {
          if (c.type !== 'toolCall') continue;
          const result = messages.find(r => r.role === 'toolResult' && r.toolCallId === c.id);
          scanned.push({ name: c.name, args: c.arguments, success: Boolean(result) && result.isError === false });
        }
        const findings = [...lintAnswer(answer, lintContext), ...lintLedgerAnswer(answer, await readLedger(entry.ctx?.root, entry.id)), ...checkTurnTools({ answer, routes: context.routes, toolCalls: [...toolCalls, ...scanned] })];
        const data = {
          version: 1, turnId, timestamp: new Date().toISOString(),
          findings, stats: answerStats(answer), correctionCount, continuationCount,
          messageIndex: entry.session.messages.lastIndexOf(message),
        };
        // Custom entries are durable metadata, never model-visible chat messages.
        entry.session.sessionManager?.appendCustomEntry('pe_answer_lint', data);
        entry.answerLint = data;
        const nonIncomplete = findings.filter(item => item.rule !== 'incomplete');
        const numericRules = new Set(['unit_conversion', 'magnitude', 'percent_change', 'inconsistent_value', 'repeats_corrected_value']);
        const label = nonIncomplete.some(item => numericRules.has(item.rule)) && nonIncomplete.every(item => numericRules.has(item.rule))
          ? '数值待核'
          : nonIncomplete.length ? '待核'
          : findings.length ? '回答不完整' : '';
        broadcast({ type: 'answer.lint', ...data, label });
        const errors = findings.filter(item => item.severity === 'error' && item.rule !== 'incomplete');
        const incomplete = findings.some(item => item.rule === 'incomplete');
        let prompt;
        if (errors.length && correctionCount < 1) {
          correctionCount++;
          continuationPrefix = "";
          prompt = `请调用所需工具（数值用 calc，单位换算用 unit_convert，负向依赖用 workbook_trace mode=path，自查先 transcript_search 并读台账）核验以下问题，并给出修正后的完整回答，不要说明修正过程：\n${errors.map(item => `${item.message}：${item.excerpt}；应为 ${item.expected}`).join('\n')}`;
        } else if (incomplete && continuationCount < 1) {
          continuationCount++;
          continuationPrefix = answer;
          prompt = '上一条回答在句中截断，请从断点继续补完，不要重复已写内容';
        } else break;
        if (aborted) break;
        boundary = entry.session.messages.length;
        const customType = continuationPrefix ? 'pe_answer_continue' : 'pe_answer_correct';
        if (entry.session.sendCustomMessage) {
          // SDK resolves after the triggered run settles (agent_settled), as prompt does.
          await entry.session.sendCustomMessage({ customType, content: prompt, display: false, details: { turnId, correctionCount, continuationCount } }, { triggerTurn: true });
        } else {
          // Fake/test-only compatibility. Production Pi supports sendCustomMessage.
          // Fakes that append user messages must retain peInternal (snapshot hides it).
          await entry.session.prompt(prompt, { peInternal: true });
        }
      }
    } finally {
      unsubscribe?.();
    }
  };
  const run = previous ? previous.catch(() => {}).then(execute) : execute();
  entry.postAnswerRun = run;
  return run.finally(() => {
    if (entry.postAnswerRun === run) {
      entry.postAnswerPending = false;
      entry.postAnswerRun = null;
      broadcast({ type: 'answer.checked' });
      if (entry.snapshot) broadcast(entry.snapshot());
    }
  });
}
