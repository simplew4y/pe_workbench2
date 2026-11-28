import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { applyTurnSnapshot, receiveDelivery, startTurn, wasDelivered } from '../ui/chat/turn-delivery.js';

globalThis.document = { querySelector: () => null };
globalThis.window = {};
const { messageHTML } = await import('../ui/chat/renderer.js');
const bootstrap = readFileSync(new URL('../ui/bootstrap.js', import.meta.url), 'utf8');
const handlerSource = bootstrap.slice(bootstrap.indexOf('function handleServerEvent('), bootstrap.indexOf('async function refreshSnapshot('));
const citation = { id: 'b', materialId: 'workbook-b', version: 1, locator: 'Model!B2' };
const unused = { id: 'a', materialId: 'workbook-a', version: 1, locator: 'Model!A1' };
const tool = { id: 'c', name: 'read', status: 'done', citations: [unused, citation] };

// Legacy host notices stay hidden while substantive caveats remain visible.
{
  const banner='本次尚未完成全部核验。以下保留有依据的分析与成立条件；存在争议的数值及其确定性结论暂不采用。';
  const text=banner+'\n\n核心驱动是销量和利润率。分部利润口径仍需核对。';
  const record={role:'assistant',turnId:'legacy-note',status:'partial',text,reason:'指标待核 <script>'};
  const html=messageHTML(record);
  assert.doesNotMatch(html,/本次尚未完成全部核验|answer-note|answer-diagnostics|指标待核/);
  assert.match(html,/核心驱动是销量和利润率/);assert.match(html,/分部利润口径仍需核对/);
  assert.equal(record.text,text);assert.equal(record.status,'partial');
  assert.match(messageHTML({role:'user',text}),/本次尚未完成全部核验/);
  assert.match(messageHTML({...record,text:'引用：'+text}),/本次尚未完成全部核验/);
  assert.match(messageHTML({...record,text:banner}),/本次分析尚未形成可交付答复/);
  const section='本节部分内容尚未完成核验，相关数值及依赖结论暂不采用。';
  const sectionHTML=messageHTML({...record,text:'核心驱动是销量。\n\n> '+section+'\n\n利润口径仍需核对。'});
  assert.doesNotMatch(sectionHTML,/本节部分内容/);
  assert.match(sectionHTML,/利润口径仍需核对/);
  const quoted=messageHTML({...record,text:'示例：\n```text\n> '+section+'\n```'});
  assert.match(quoted,/本节部分内容/);
}

// Host diagnostics are persisted verbatim. Near-matching financial caveats,
// quoted examples and source amounts with ambiguous identity remain untouched.
{
  const footer='**仍待核实**：部分结论的证据；cogs的单位；客户续约与回款的实际结果。';
  const boundary='**证据边界**：部分引用的指标口径、单位、情景、期间尚未完整识别，仍需对照原表确认。以上分析保留这一不确定性，不应视为这些数据已完成独立核验。';
  const m={role:'assistant',status:'partial',text:['客户：续约降价会改变客户质量判断。','估值：其余假设沿用原表。',footer,boundary].join('\n\n')};
  const html=messageHTML(m);
  assert.match(html,/续约降价会改变客户质量判断。 尚缺客户续约与回款的实际结果。[\s\S]*估值/);
  assert.doesNotMatch(html,/cogs的单位|部分引用的指标口径/);
  assert.ok(m.text.endsWith(boundary));
  assert.doesNotMatch(messageHTML({...m,status:'completed',text:boundary}),/尚未完整识别/);
  for(const text of ['**证据边界**：分部收入缺同口径成本，不能据此推断分部利润。',
    '**仍待核实**：客户是否已在次期退货。','\x60\x60\x60text\n'+boundary+'\n\x60\x60\x60','> '+boundary]){
    assert.match(messageHTML({...m,text}),/分部利润|次期退货|尚未完整识别/);
  }
  assert.match(messageHTML({...m,role:'user',text:boundary}),/尚未完整识别/);
  const raw='- 2024 Revenue 125（[Example.xlsx]Sheet1!D3），原式 \x60=D5+D6\x60。';
  const c={filename:'Example.xlsx',locator:'Sheet1!D3',value:125,metric:'Revenue'};
  assert.match(messageHTML({...m,text:raw,citations:[c]}),/单凭该格无法换算成亿元/);
  for(const cs of [[{...c,value:12}],[c,c],[{...c,raw_unit:'CNY mn'}],[]]) {
    assert.doesNotMatch(messageHTML({...m,text:raw,citations:cs}),/无法换算成亿元/);
  }
}

function page() {
  const state = { messages: [], streaming: false, live: { text: '', tools: [] } };
  const noop = () => {};
  const handle = vm.runInNewContext(handlerSource + '\nhandleServerEvent', {
    state, applyTurnSnapshot, receiveDelivery, startTurn, wasDelivered, window: {}, runtime: {},
    renderThread: noop, syncStop: noop, scheduleThread: noop, renderSessions: noop,
    renderAllChrome: noop, scheduleSnapshotPoll: noop, updateSessionItem: noop,
  });
  return { state, handle };
}

for (const [status, body, label] of [
  ['completed', 'B，见 Model!B2。', ''],
  ['completed', '这是前半段，这是后半段。', ''],
  ['partial', '已核验 Model!B2。', '部分完成'],
  ['failed', '', '回答失败'],
  ['cancelled', '', '已取消'],
]) {
  const turnId = 'turn-1';
  const user = { role: 'user', text: '问题', turnId };
  const record = { turnId, status, text: body, citations: body.includes('B2') ? [citation] : [], reason: label ? '原因' : '' };
  const snapshot = { type: 'snapshot', activeTurnId: turnId, streaming: true,
    messages: [user, { role: 'assistant', turnId, status: 'pending', text: '', citations: [], tools: [tool] }] };
  const final = { type: 'snapshot', activeTurnId: null, streaming: false,
    messages: [user, { role: 'assistant', tools: [tool], ...record }] };
  const { handle, state } = page();
  handle({ type: 'turn.started', turnId, question: user.text });
  handle({ type: 'assistant.delta', turnId, delta: '初稿 A' });
  handle({ type: 'run.settled', turnId });
  assert.equal(state.streaming, true);
  assert.equal(state.live.text, '');
  handle({ type: 'tool.started', turnId, ...tool });
  handle({ type: 'tool.started', turnId, ...tool });
  handle({ type: 'tool.completed', turnId, ...tool });
  assert.equal(state.live.tools.length, 1);
  assert.equal(state.live.tools[0].status, 'done');
  const reconnect = page();
  reconnect.handle(snapshot);
  assert.equal(reconnect.state.messages.length, 1);
  assert.equal(reconnect.state.live.tools[0].status, 'done');

  for (const client of [{ handle, state }, reconnect]) {
    client.handle({ type: 'turn.delivered', record });
    client.handle({ type: 'turn.delivered', record });
    client.handle({ type: 'turn.started', turnId });
    client.handle({ type: 'assistant.delta', turnId, delta: '迟到 A' });
    client.handle(snapshot); // A poll requested before delivery resolved late.
    const rows = client.state.messages.filter(item => item.role === 'assistant');
    assert.equal(client.state.streaming, false);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].text, body);
    const html = messageHTML(rows[0]);
    assert.doesNotMatch(html, /初稿 A|迟到 A|data-material-id="workbook-a"/);
    if (body.includes('B2')) assert.match(html, /data-material-id="workbook-b"/);
    assert.match(html, /<details class="tool-group">/);
    if (status==='partial') {
      assert.doesNotMatch(html,/部分结论仍待核实|查看核验详情|answer-note|answer-diagnostics/);
      assert.match(html,/tool-summary-meta">已结束/);
    } else if (label) assert.ok(html.includes(label + ' · 原因'));
    client.handle(final);
    assert.equal(messageHTML(client.state.messages[1]), html);
    const fresh = page();
    fresh.handle(final);
    assert.equal(messageHTML(fresh.state.messages[1]), html);
  }
}
{
  const record = { role: 'assistant', turnId: 'timed', status: 'completed', text: '最终答文',
    turnStartedAt: '2026-11-24T01:00:00Z', finishedAt: '2026-11-24T01:03:05Z' };
  const withTools = messageHTML({ ...record, tools: [tool] });
  assert.match(withTools, /<details class="tool-group">[\s\S]*用时 3 分 5 秒[\s\S]*最终答文/);
  const plain = messageHTML(record);
  assert.match(plain, /用时 3 分 5 秒/);
  assert.doesNotMatch(plain, /<details/);
  assert.doesNotMatch(messageHTML({ ...record, finishedAt: null }), /用时/);
}
const legacy = messageHTML({ role: 'assistant', text: '旧答 Model!A1。', tools: [tool] });
assert.match(messageHTML({role:'assistant',status:'partial',text:'',reason:'<script>bad()</script>'}),/尚未形成可交付答复/);
assert.doesNotMatch(messageHTML({role:'assistant',status:'partial',text:'',reason:'<script>bad()</script>'}),/<script>/);
assert.match(legacy, /旧答/);
assert.match(legacy, /data-material-id="workbook-a"/);
console.log('turn delivery UI: rewrite, continuation, all terminal states, replay, refresh, tools and legacy citations passed');

{
  const { state, handle } = page();
  const framework = text => ({ presentation: { verdict: { text } } });
  for (const [turnId, summary] of [['framework-v1', '早先摘要'], ['plain', null], ['framework-v2', '更新摘要']]) {
    handle({ type: 'turn.started', turnId, question: turnId });
    handle({ type: 'turn.delivered', record: { turnId, text: '正式正文', status: 'completed',
      ...(summary ? { analysisState: framework(summary) } : {}) } });
  }
  const answers = state.messages.filter(m => m.role === 'assistant').map(messageHTML);
  assert.match(answers[0], /正式正文[\s\S]*framework-presentation[\s\S]*早先摘要/);
  assert.doesNotMatch(answers[1], /framework-presentation/);
  assert.match(answers[2], /正式正文[\s\S]*framework-presentation[\s\S]*更新摘要/);
}

// Drive the shipping Copilot subscriber and client. Replace its remote SDK and
// the DOM scheduler only; the normal connect, send and finalize paths run.
const { registerHooks } = await import('node:module');
const { state } = await import('../ui/state/store.js');
const { runtime } = await import('../ui/runtime.js');
const sdk = {
  callbacks: null, play: null,
  agent: {
    setMessages() {}, async detachActiveRun() {},
    subscribe(callbacks) { sdk.callbacks = callbacks; return { unsubscribe() {} }; },
  },
};
globalThis.copilotFixture = sdk;
const stub = (code) => 'data:text/javascript,' + encodeURIComponent(code);
const coreStub = stub(`
export class CopilotKitCore {
  subscribe(callbacks) { this.callbacks = callbacks; return { unsubscribe() {} }; }
  connect() { this.callbacks.onAgentsChanged({ agents: { pi: globalThis.copilotFixture.agent } }); }
  subscribeToAgentWithOptions() { return { unsubscribe() {} }; }
  setProperties() {}
  async runAgent({ runId }) { await globalThis.copilotFixture.play(runId); }
}
`);
const rendererStub = stub('export function renderThread(){} export function retainLiveUntilSnapshot(){} export function scheduleThread(){}');
const hook = registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/ui/copilot-pilot/client.js')) {
      if (specifier === '@copilotkit/core') return { shortCircuit: true, url: coreStub };
      if (specifier === '../chat/renderer.js') return { shortCircuit: true, url: rendererStub };
    }
    return next(specifier, context);
  },
});
let CopilotPilotClient;
try {
  ({ CopilotPilotClient } = await import('../ui/copilot-pilot/client.js'));
} finally {
  hook.deregister();
}
state.activeSession = 's';
state.agentTransport = 'copilotkit';
state.streaming = false;
state.messages = [];
runtime.refreshSnapshot = async () => {
  if (state.messages.some(m => m.role === 'assistant')) throw new Error('snapshot temporarily unavailable');
};
const client = new CopilotPilotClient();
for (const [turnId, text] of [['turn-b', 'B，见 Model!B2。'], ['turn-full', '这是前半段，这是后半段。']]) {
  state.messages.push({ role: 'user', text: '问题', turnId });
  sdk.play = async runId => {
    const fire = (name, event) => sdk.callbacks[name]({ event });
    fire('onRunStartedEvent', { runId });
    fire('onToolCallStartEvent', { toolCallId: 'lookup', toolCallName: 'read' });
    fire('onToolCallEndEvent', { toolCallId: 'lookup' });
    const content = { messageId: turnId, delta: text };
    fire('onTextMessageContentEvent', content);
    fire('onTextMessageContentEvent', content);
    assert.equal(state.live.text, '');
    assert.equal(wasDelivered(state.messages, turnId), false);
    const record = { turnId, text, status: 'completed', citations: text.includes('B2') ? [citation] : [] };
    fire('onCustomEvent', { name: 'pe.turn_delivery', value: record });
    fire('onCustomEvent', { name: 'pe.turn_delivery', value: record });
    fire('onTextMessageContentEvent', content);
    fire('onRunFinishedEvent', { runId });
  };
  await client.send({ text: '问题' });
  const rows = state.messages.filter(m => m.role === 'assistant' && m.turnId === turnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].text, text);
  assert.equal(rows[0].tools.length, 1);
  assert.equal(rows[0].citations.length, text.includes('B2') ? 1 : 0);
  assert.equal(state.streaming, false);
}
console.log('Copilot client: atomic delivery survives replay and a failed final snapshot');

{
  const {readableArchivedLine,formulaStep}=await import('../ui/chat/workbook-formulas.js');
  const fields={filename:'Peer.xlsx',sha256:'abc',materialId:'peer',version:3};
  const cell=(ref,metric,value,unit,formula)=>({...fields,locator:'Case!'+ref,metric,value,raw_unit:unit,display_unit:unit,formula});
  const eps=cell('B3','EPS (USD, diluted)',2,'USD/sh');
  const pe=cell('B4','2034E target P/E',8,'倍');pe.period='2034E';
  const base=cell('B5','Target multiple x EPS',16,'USD/sh','=B3*$B$4');
  const rate=cell('B6','COE',0.25,'decimal');rate.display_unit='%';
  const term=cell('B7',null,2,'unit_unknown');
  const target=cell('B8','Discounted back to 2032; TP (USD)',10,'USD','=ROUND(B5/(1+B6)^B7,0)');
  const cells=[eps,pe,base,rate,term,target];
  const old='Target multiple x EPS 16 USD/sh [Peer.xlsx]Case!B5、COE 25% [Peer.xlsx]Case!B6、2 [Peer.xlsx]Case!B7。目标价按 \x60ROUND(16/(1+0.25)^2,0)\x60 计算约为 10 美元 [Peer.xlsx]Case!B8。';
  // The old formatter used the raw USD/sh unit. Only convert the exact template.
  const line='- Target multiple x EPS 16 USD/sh（[Peer.xlsx]Case!B5），原式 \x60=B3*$B$4\x60。';
  assert.match(readableArchivedLine(line,cells),/摊薄每股收益 2 美元\/股[\s\S]* × 2034 年预计目标市盈率 8 倍/);
  const rendered=formulaStep(target,[base,rate,term],'ROUND(16/(1+0.25)^2,0)',true,cells);
  assert.match(rendered,/股权成本 25%.*折现 2 年/);
  assert.match(rendered,/16 ÷ \(1 \+ 25%\)² ≈ \*\*10 美元\*\*/);
  assert.equal(readableArchivedLine(old,cells),rendered);
  assert.equal(readableArchivedLine(old.replace('25%','30%'),cells),old.replace('25%','30%'));
  assert.equal(readableArchivedLine(line,[...cells,{...base,version:2}]),line);
}
