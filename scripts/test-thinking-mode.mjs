// Exercise the actual Pi serializer against a loopback provider, including queued turns.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadConfig } from '../server/config.mjs';
import { createWorkbench } from '../server/create-app.mjs';
import { runWithPostAnswer } from '../server/agent/post-answer.mjs';
import { normalizeRunInput } from '../lib/agent-protocol/ag-ui-endpoint.mjs';

const root = await mkdtemp(path.join(tmpdir(), 'pe-thinking-'));
process.env.DEEPSEEK_API_KEY = 'loopback-fixture';
const requests = [];
const provider = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const data = JSON.parse(body);
  requests.push(data);
  // Short but complete transport responses. Checking payloads does not require
  // a successful research verdict, and an incomplete verdict also exercises repairs.
  const chunk = {id:'fixture', model:data.model, object:'chat.completion.chunk',
    choices:[{index:0,delta:{role:'assistant',content:'需要明确可比公司的业务范围和利润口径。'},finish_reason:'stop'}]};
  res.writeHead(200, {'Content-Type':'text/event-stream'});
  res.end('data: ' + JSON.stringify(chunk) + '\n\ndata: [DONE]\n\n');
});
let app;
try {
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const config = await loadConfig({root, env:{}});
  const model = {...config.model, baseUrl:'http://127.0.0.1:' + provider.address().port};
  app = await createWorkbench({config:{...config, model, indexModel:model}, logger:{}});
  const ctx = app.projectManager.get(config.defaultProjectId);
  const entry = await app.sessions.createEntry({ctx});
  const question = '请分析选择可比公司时需要考虑哪些经营假设。';
  const ranges = [];
  function settled(event) {
    if (event.type === 'turn.delivered') ranges.push(requests.length);
  }
  entry.session.setThinkingLevel('max');
  const normal = runWithPostAnswer(entry, question, {thinkingMode:'normal'}, settled);
  const deep = runWithPostAnswer(entry, question, {}, settled);
  await Promise.all([normal, deep]);
  const ordinary = requests.slice(0, ranges[0]);
  const reasoning = requests.slice(ranges[0], ranges[1]);
  assert.ok(ordinary.some(r => r.tools?.length), 'ordinary primary');
  assert.ok(ordinary.some(r => !r.tools?.length), 'ordinary review');
  assert.ok(ordinary.every(r => r.thinking?.type === 'disabled' && !r.reasoning_effort));
  assert.ok(reasoning.some(r => r.tools?.length && r.thinking?.type === 'enabled' && r.reasoning_effort === 'max'));
  assert.ok(reasoning.some(r => !r.tools?.length && r.thinking?.type === 'enabled' && r.reasoning_effort === 'low'));
  assert.equal(entry.session.thinkingLevel, 'max');
  const input = {messages:[{role:'user',content:question}], forwardedProps:{thinkingMode:'normal'}};
  assert.equal(normalizeRunInput(input, ctx).thinkingMode, 'normal');
  input.forwardedProps.thinkingMode = 'oops';
  assert.equal(normalizeRunInput(input, ctx).status, 400);
  console.log('PASS normal and queued default, main answer and audit, SDK wire payloads:', ordinary.length, reasoning.length);
} finally {
  await app?.close();
  await new Promise(resolve => provider.close(resolve));
  await rm(root, {recursive:true, force:true});
}
