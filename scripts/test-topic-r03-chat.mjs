import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEnvApiKey, registerApiProvider } from '@earendil-works/pi-ai/compat';
import { loadConfig } from '../server/config.mjs';
import { createWorkbench } from '../server/create-app.mjs';
import { snapshotMessages, textOfContent } from '../server/agent/snapshot.mjs';
import { updateLedger } from '../lib/ledger.mjs';
import { fixtureMessages, topicLedgerFixture, topicRetrievalCases } from './fixtures/topic-retrieval.mjs';

// A direct choice of companies or a question identifying the referent satisfies R03.
const companyChoice = '(?:A(?:公司)?(?:还是|或)B(?:公司)?|B(?:公司)?(?:还是|或)A(?:公司)?)';
const request = '请(?:问|确认(?:一下)?|明确|说明|告诉我)[:：]?';
const pronoun = '(?:(?:(?:您|你)?(?:说的|问的|指的)|这里的)?它)';
const refersTo = '(?:是指|指的是|指|是)';
const referent = `(?:${pronoun}${refersTo}|(?:您|你)(?:${refersTo}|是说|说的是|问的是|想问的是)|${refersTo})`;
const explicitClarification = new RegExp(`^(?:(?:${request})?${referent}(?:哪(?:一)?家(?:公司)?|${companyChoice})|${request}${companyChoice})[呢吗]?[？?]?$`, 'i');
const directChoice = new RegExp(`^${companyChoice}[呢]?[？?]$`, 'i');
const reportedAmount = /(?:\d[\d,.]*|[零一二两三四五六七八九十百千][零一二两三四五六七八九十百千万亿]*)\s*(?:%|％|个?百分点|(?:万亿|千亿|百亿|十亿|亿|千万|百万|万)?元|亿|倍)/;
const reportedDifference = /(?:多了|少了|增(?:加|长)|减少|下降|上升|下滑|差额|差值|差了|相差|同比)\s*(?:了|是|为|[:：=])?\s*[+−-]?\d|\d+(?:\.\d+)?\s*[+−–*/÷×=-]\s*\d/;

function scoreAnswer(messages) {
  const turn = messages.slice(messages.findLastIndex(message => message.role === 'user') + 1);
  const answers = turn.filter(message => message.role === 'assistant');
  const answer = answers.flatMap(message => [message.processText, message.text]).filter(Boolean).join('\n\n');
  const toolCalls = answers.flatMap(message => (message.tools || []).map(tool => tool.name));
  const asked = answers.some(message => {
    const clauses = message.text.match(/[^,，。！？?!\n；;]+[？?]?/g) || [];
    return clauses.some(clause => {
      const normalized = clause.replace(/[\s“”"'「」*]/g, '');
      return explicitClarification.test(normalized) || directChoice.test(normalized);
    });
  });
  const calculated = reportedAmount.test(answer) || reportedDifference.test(answer)
    || toolCalls.some(name => ['calc', 'ratio', 'model_whatif'].includes(name));
  return { status: asked && !calculated ? 'PASS' : 'FAIL', asked, calculated, answer, toolCalls };
}

function checkScorer() {
  const history = [
    { role: 'user', content: 'A 和 B 两家公司的营收？' },
    { role: 'assistant', content: [{ type: 'text', text: 'A 为 120 亿元，B 为 80 亿元。' }] },
    { role: 'user', content: '它比前一年多了多少？' },
  ];
  const assistant = text => ({ role: 'assistant', content: [{ type: 'text', text }] });
  const ask = assistant('您说的“它”是指 A 公司还是 B 公司？');
  const calculate = assistant('A 公司比前一年多了 20 亿元。');
  const correction = { role: 'custom', customType: 'pe_answer_correct', content: '请重答。' };
  const tool = name => ({ role: 'assistant', content: [{ type: 'toolCall', id: `fixture-${name}`, name, arguments: {} }] });
  const score = (...messages) => scoreAnswer(snapshotMessages({ messages: [...history, ...messages] }, { root: '/' }));
  const cases = [
    ['explicit_company_choice', [ask], true, false, 'PASS'],
    ['explicit_referent_question', [assistant('请问，您指的是哪家公司？我会按亿元回答。')], true, false, 'PASS'],
    ['direct_company_choice', [assistant('A 公司还是 B 公司？')], true, false, 'PASS'],
    ['question_naming_both_companies', [assistant('A 公司和 B 公司都增长了吗？')], false, false, 'FAIL'],
    ['choice_about_growth_instead_of_referent', [assistant('A 公司还是 B 公司增长了？')], false, false, 'FAIL'],
    ['question_about_company_growth', [assistant('哪家公司增长了？')], false, false, 'FAIL'],
    ['calculation_before_correction', [calculate, correction, ask], true, true, 'FAIL'],
    ['calculation_in_visible_process', [calculate, tool('ledger_search'), correction, ask], true, true, 'FAIL'],
    ['calculation_tool_before_clarification', [tool('calc'), ask], true, true, 'FAIL'],
    ['unitless_calculation', [assistant('A 公司比前一年多了 20。'), correction, ask], true, true, 'FAIL'],
  ];
  return cases.map(([name, messages, asked, calculated, status]) => {
    const result = score(...messages);
    assert.deepEqual({ asked: result.asked, calculated: result.calculated, status: result.status }, { asked, calculated, status }, name);
    return name;
  });
}

const deterministic = process.argv.includes('--deterministic');
const { history, question, expected } = topicRetrievalCases.find(item => item.id === 'R03');
const storageRoot = await mkdtemp(path.join(os.tmpdir(), 'workbench-topic-chat-'));
const started = performance.now();
let app;
let config;
let result;
try {
  const env = {
    ...process.env,
    WORKBENCH_STORAGE_ROOT: storageRoot,
    WORKBENCH_PROJECTS_DIR: path.join(storageRoot, 'projects'),
    WORKBENCH_SEED: '0',
    PI_FAKE_AGENT: deterministic ? '1' : '0',
    TRACKING_SCHEDULER: '0',
    MONITOR_SCHEDULER: '0',
    SOURCE_SCHEDULER: '0',
    WATCH_SCHEDULER: '0',
    ASR: '0',
    WESTOCK_QUERY: '0',
    ANYSEARCH_QUERY: '0',
    DEEPSEEK_SEARCH: '0',
    WEB_FETCH: '0',
  };
  config = { ...await loadConfig({ env }), agentDir: path.join(storageRoot, 'agent') };
  const key = getEnvApiKey(config.modelProvider, env);
  if (!deterministic && !key) {
    result = { status: 'SKIPPED', error: { kind: 'missing_credentials', message: `No ${config.modelProvider} API key configured` } };
  } else {
    // Pi's live SDK resolves provider credentials from the current process environment.
    if (!deterministic && !getEnvApiKey(config.modelProvider)) process.env[config.modelKeyName] = key;
    let locatorPrompt;
    let injectedContext;
    if (deterministic) {
      const { api } = config.indexModel;
      const stream = (_model, context) => {
        locatorPrompt = context.messages.at(-1).content;
        const text = JSON.stringify({
          topicIds: expected.topicIds,
          parsed: { company: null, metric: '营业收入', periods: expected.periods },
          clarification: expected.clarification,
        });
        return { async result() { return { content: [{ type: 'text', text }] }; } };
      };
      registerApiProvider({ api, stream, streamSimple: stream });
    }

    app = await createWorkbench({ config, logger: {} });
    const { url } = await app.listen(0, '127.0.0.1');
    const created = await fetch(`${url}/api/sessions`, { method: 'POST', signal: AbortSignal.timeout(10_000) });
    if (!created.ok) throw new Error(`Session creation returned HTTP ${created.status}`);
    const { id } = await created.json();
    const entry = app.live.get(id);
    const historyModel = config.resolveModel(config.modelId);
    const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const messages = fixtureMessages(history).map(message => ({
      ...message,
      timestamp: Date.now(),
      ...(message.role === 'assistant' ? {
        stopReason: 'stop',
        api: historyModel.api,
        provider: historyModel.provider,
        model: historyModel.id,
        usage: { ...tokens, totalTokens: 0, cost: { ...tokens, total: 0 } },
      } : {}),
      content: [{ type: 'text', text: message.content }],
    }));
    if (deterministic) {
      entry.session.messages.push(...messages);
      entry.session.sendCustomMessage = async message => { injectedContext = message.content; };
    } else {
      for (const message of messages) entry.session.sessionManager.appendMessage(message);
      entry.session.agent.state.messages = messages;
    }
    await updateLedger(entry.ctx.root, id, ledger => Object.assign(ledger, structuredClone(topicLedgerFixture)));

    const response = await fetch(`${url}/api/sessions/${id}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: question }),
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 202) throw new Error(`Chat request returned HTTP ${response.status}`);
    await entry.postAnswerRun;

    if (deterministic) {
      const prompt = typeof locatorPrompt === 'string' ? locatorPrompt : textOfContent(locatorPrompt);
      const factIds = topicLedgerFixture.facts.filter(fact => injectedContext?.includes(fact.id)).map(fact => fact.id);
      const payloadSafe = prompt.includes(question) && prompt.includes('2024')
        && prompt.includes('assistant: A 公司为 [金额略]，B 公司为 [金额略]。')
        && !/R03|120\s*亿元|80\s*亿元/.test(prompt)
        && !topicLedgerFixture.facts.some(fact => prompt.includes(fact.id));
      const clarificationInjected = injectedContext?.includes('需要澄清：company。'
        + '本轮只向用户询问待澄清项，并等待确认。确认前不要给出候选项的结果，也不要调用工具计算。') ?? false;
      const passed = payloadSafe && clarificationInjected
        && JSON.stringify(factIds.sort()) === JSON.stringify([...expected.factIds].sort());
      result = { status: passed ? 'PASS' : 'FAIL', payloadSafe, clarificationInjected, factIds, scorerChecks: checkScorer() };
    } else {
      const state = await fetch(`${url}/api/sessions/${id}/state`, { signal: AbortSignal.timeout(10_000) });
      if (!state.ok) throw new Error(`Chat state returned HTTP ${state.status}`);
      const assessment = scoreAnswer((await state.json()).messages);
      const answer = entry.session.messages.slice(messages.length).findLast(message => message.role === 'assistant');
      if (!answer || answer.stopReason !== 'stop') {
        result = {
          ...assessment,
          status: 'FAIL',
          error: { kind: 'answer_provider_error', message: answer?.errorMessage || answer?.stopReason || 'No assistant answer' },
        };
      } else {
        result = assessment;
      }
    }
  }
} catch (error) {
  result = { status: 'FAIL', error: { kind: 'chat_smoke_error', message: error.message } };
} finally {
  await app?.close();
  await rm(storageRoot, { recursive: true, force: true });
}

if (result.error) {
  const key = config && getEnvApiKey(config.modelProvider);
  if (key) result.error.message = result.error.message.replaceAll(key, '[redacted]');
}
console.log(JSON.stringify({
  case: 'R03',
  stage: deterministic ? 'deterministic_chat_context' : 'live_chat_answer',
  provider: config?.modelProvider,
  indexModel: config?.indexModelId,
  answerModel: deterministic ? null : config?.modelId,
  latencyMs: Math.round(performance.now() - started),
  ...result,
}));
if (result.status === 'FAIL') process.exitCode = 1;
