import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { getEnvApiKey } from '@earendil-works/pi-ai/compat';
import { loadConfig } from '../server/config.mjs';
import { updateLedger } from '../lib/ledger.mjs';
import { retrieveAndExpand } from '../lib/topic-index.mjs';
import { locateChatTopics, recentTopicDialogue } from '../server/agent/topic-locator.mjs';
import { fixtureMessages, topicLedgerFixture, topicRetrievalCases } from './fixtures/topic-retrieval.mjs';

const { indexModel, modelPayload } = await loadConfig();
const { id: model, provider } = indexModel;
const key = getEnvApiKey(provider);
const intervalMs = Number(process.env.TOPIC_RETRIEVAL_INTERVAL_MS || 0);
if (!Number.isFinite(intervalMs) || intervalMs < 0) throw new Error('Invalid TOPIC_RETRIEVAL_INTERVAL_MS');

function sorted(items) {
  return [...items].sort();
}

function check(expected, actual) {
  const mismatches = [];
  for (const field of ['topicIds', 'company', 'periods', 'clarification', 'factIds']) {
    const normalize = Array.isArray(expected[field]) ? sorted : value => value;
    if (!isDeepStrictEqual(normalize(actual[field]), normalize(expected[field]))) {
      mismatches.push({ field, expected: expected[field], actual: actual[field] });
    }
  }
  return mismatches;
}

function hasUnexpectedOutput(selection) {
  const { parsed, clarification } = selection;
  const extraFields = Object.keys(selection).filter(key => !['topicIds', 'parsed', 'clarification'].includes(key));
  return extraFields.length > 0
    || Object.keys(parsed).some(key => !['company', 'metric', 'periods'].includes(key))
    || Object.keys(clarification).some(key => !['needed', 'missing'].includes(key))
    || /\d/.test(parsed.metric || '');
}

async function runCase({ history, question, expected }, root, sessionId) {
  if (!key) {
    return {
      status: 'SKIPPED',
      topicIds: [], selectedMetrics: [], company: null, periods: [], clarification: null, factIds: [],
      error: { kind: 'missing_credentials', message: `No ${provider} API key configured` },
    };
  }
  await updateLedger(root, sessionId, ledger => Object.assign(ledger, structuredClone(topicLedgerFixture)));
  let rawSelection;
  let locatorError;
  const result = await retrieveAndExpand({
    root,
    sessionId,
    question,
    history: recentTopicDialogue(fixtureMessages(history)),
    locator: async input => {
      try {
        rawSelection = await locateChatTopics(indexModel, input, modelPayload);
        return rawSelection;
      } catch (error) {
        locatorError = {
          kind: error.code || 'locator_error',
          message: error.message.replaceAll(key, '[redacted]'),
          ...(error.modelOutput ? { modelOutput: error.modelOutput.replaceAll(key, '[redacted]') } : {}),
        };
        throw error;
      }
    },
  });

  const actual = {
    topicIds: result.topics.map(topic => topic.id),
    selectedMetrics: [...new Set(result.topics.flatMap(topic => topic.binding.metrics))],
    company: result.parsed.company ?? null,
    periods: result.parsed.periods ?? [],
    clarification: result.clarification,
    factIds: result.facts.map(fact => fact.id),
  };
  if (locatorError) return { status: 'FAIL', ...actual, clarification: null, error: locatorError };

  const mismatches = check(expected, actual);
  if (!isDeepStrictEqual(sorted(rawSelection.topicIds), sorted(actual.topicIds))) {
    mismatches.push({ field: 'rawTopicIds', expected: expected.topicIds, actual: rawSelection.topicIds });
  }
  if (hasUnexpectedOutput(rawSelection)) mismatches.push({ field: 'locatorSchema', expected: 'locator fields only' });
  return { status: mismatches.length ? 'FAIL' : 'PASS', ...actual, mismatches };
}

const root = await mkdtemp(path.join(os.tmpdir(), 'workbench-topic-live-'));
try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    for (const testCase of topicRetrievalCases) {
      if (key && intervalMs && (attempt > 1 || testCase !== topicRetrievalCases[0])) await delay(intervalMs);
      const started = performance.now();
      let result;
      try {
        result = await runCase(testCase, root, `${testCase.id}-${attempt}`);
      } catch (error) {
        result = { status: 'FAIL', error: { kind: 'fixture_error', message: error.message } };
      }
      console.log(JSON.stringify({
        case: testCase.id,
        attempt,
        provider,
        model,
        latencyMs: Math.round(performance.now() - started),
        expected: testCase.expected,
        ...result,
      }));
      if (result.status === 'FAIL') process.exitCode = 1;
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
