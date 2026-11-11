import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEnvApiKey, getModel, registerApiProvider } from '@earendil-works/pi-ai/compat';
import { loadConfig } from '../server/config.mjs';
import { createWorkbench } from '../server/create-app.mjs';
import { textOfContent } from '../server/agent/snapshot.mjs';
import { updateLedger } from '../lib/ledger.mjs';
import { fixtureMessages, topicLedgerFixture, topicRetrievalCases } from './fixtures/topic-retrieval.mjs';

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
  const key = getEnvApiKey('deepseek', env);
  if (!deterministic && !key) {
    result = { status: 'SKIPPED', error: { kind: 'missing_credentials', message: 'No DeepSeek API key configured' } };
  } else {
    // Pi's live SDK resolves provider credentials from the current process environment.
    if (!deterministic && !getEnvApiKey('deepseek')) process.env.DEEPSEEK_API_KEY = key;
    let locatorPrompt;
    let injectedContext;
    if (deterministic) {
      const { api } = getModel('deepseek', config.indexModelId);
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
    const historyModel = getModel('deepseek', config.modelId);
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
      const clarificationInjected = injectedContext?.includes('需要澄清：company') ?? false;
      const passed = payloadSafe && clarificationInjected
        && JSON.stringify(factIds.sort()) === JSON.stringify([...expected.factIds].sort());
      result = { status: passed ? 'PASS' : 'FAIL', payloadSafe, clarificationInjected, factIds };
    } else {
      const answer = entry.session.messages.slice(messages.length).findLast(message => message.role === 'assistant');
      if (!answer || answer.stopReason !== 'stop') {
        result = { status: 'FAIL', error: { kind: 'answer_provider_error', message: answer?.errorMessage || answer?.stopReason || 'No assistant answer' } };
      } else {
        const text = textOfContent(answer.content);
        const toolCalls = entry.turnToolCalls.map(call => call.name);
        const namesBothCompanies = /\bA\b/.test(text) && /\bB\b/.test(text);
        const asksForCompany = /哪(?:一)?家(?:公司)?/.test(text);
        const asksQuestion = /[？?]|请.{0,8}(?:确认|指明|说明|告诉)/.test(text);
        const asked = asksQuestion && (namesBothCompanies || asksForCompany);
        const calculated = /\d+(?:\.\d+)?\s*(?:亿元|万元|元|%|％)/.test(text) || toolCalls.some(name => ['calc', 'ratio'].includes(name));
        result = { status: asked && !calculated ? 'PASS' : 'FAIL', answer: text, toolCalls };
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
  const key = getEnvApiKey('deepseek');
  if (key) result.error.message = result.error.message.replaceAll(key, '[redacted]');
}
console.log(JSON.stringify({
  case: 'R03',
  stage: deterministic ? 'deterministic_chat_context' : 'live_chat_answer',
  provider: 'deepseek',
  indexModel: config?.indexModelId,
  answerModel: deterministic ? null : config?.modelId,
  latencyMs: Math.round(performance.now() - started),
  ...result,
}));
if (result.status === 'FAIL') process.exitCode = 1;
