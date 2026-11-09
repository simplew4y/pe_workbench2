import assert from 'node:assert/strict';
const { runWithPostAnswer } = await import('../server/agent/post-answer.mjs');
const records = [], prompts = [], events = [];
let release;
const gate = new Promise(resolve => { release = resolve; });
const session = {
  messages: [], isStreaming: false,
  sessionManager: { appendCustomEntry: (type, data) => records.push({ type, data }) },
  async prompt(text) {
    prompts.push(text);
    if (prompts.length === 2) await gate;
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '7293 百万元合 7.3 亿元，尚未' }] });
  },
};
const entry = { session };
const run = runWithPostAnswer(entry, '用户问题', {}, event => events.push(event));
await new Promise(resolve => setImmediate(resolve));
assert.equal(entry.postAnswerPending, true);
assert.equal(prompts.length, 2);
release();
await run;
assert.equal(prompts.length, 3); // one correction and one continuation, never loop
assert.equal(entry.postAnswerPending, false);
assert(records.length >= 3);
assert(records.every(x => x.type === 'pe_answer_lint'));
assert(events.some(x => x.type === 'answer.lint'));
assert.equal(records.at(-1).data.correctionCount, 1);
assert.equal(records.at(-1).data.continuationCount, 1);
const aborted = { session: { messages: [{ role: 'assistant', stopReason: 'aborted', content: '截断' }], async prompt() {} } };
await runWithPostAnswer(aborted, '用户');
assert.equal(aborted.answerLint, undefined);
console.log('post answer passed');
// Real adapter with a stub Pi session: settling an internal prompt must not end AG-UI.
const { PiAgUiAdapter } = await import('../lib/agent-protocol/pi-ag-ui-adapter.mjs');
const listeners = new Set();
let unblock;
const internalGate = new Promise(resolve => { unblock = resolve; });
let calls = 0;
const pi = {
  messages: [], isStreaming: false,
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
  async prompt() {
    calls++;
    this.isStreaming = true;
    for (const fn of listeners) fn({ type: 'agent_start' });
    if (calls === 2) await internalGate;
    const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: calls === 1 ? '100→120，增长30%。' : '100→120，增长20%。' }] };
    this.messages.push(message);
    for (const fn of listeners) fn({ type: 'message_end', message });
    this.isStreaming = false;
    for (const fn of listeners) fn({ type: 'agent_settled', aborted: false });
  },
};
const host = { session: pi };
const frames = [];
const adapter = new PiAgUiAdapter({ session: pi, threadId: 'test', workspaceId: 'test', log: { append(record) { frames.push(record.event); return record; } }, promptRunner: (text, options) => runWithPostAnswer(host, text, options) });
await adapter.runPrompt('问题');
await new Promise(resolve => setTimeout(resolve, 10));
assert(adapter.isRunning);
assert(host.postAnswerPending);
assert(!frames.some(frame => frame.type === 'RUN_FINISHED'));
unblock();
await new Promise(resolve => setTimeout(resolve, 10));
assert(!adapter.isRunning);
assert.equal(frames.filter(frame => frame.type === 'RUN_FINISHED').length, 1);
adapter.detach();
console.log('AG-UI post answer lifecycle passed');
const split = { session: {
  messages: [],
  async prompt() {
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: this.messages.length ? '完成）。' : '结论（尚未' });
  },
} };
await runWithPostAnswer(split, '问题');
assert.equal(split.session.messages.length, 2);
assert.deepEqual(split.answerLint.findings, []);
let staleCalls = 0;
const stale = { session: { messages: [{ role: 'assistant', stopReason: 'stop', content: '7293 百万元合 7.3 亿元。' }], async prompt() { staleCalls++; } } };
await runWithPostAnswer(stale, '/command');
assert.equal(staleCalls, 1);
assert.equal(stale.answerLint, undefined);
// Exercise durable SDK custom entries and the actual snapshot streaming field.
const { SessionManager } = await import('@earendil-works/pi-coding-agent');
const { serializeSession } = await import('../server/agent/snapshot.mjs');
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');
const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-post-answer-'));
try {
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: 'user', content: '问题', timestamp: Date.now() });
  let resolveCheck;
  const checkGate = new Promise(resolve => { resolveCheck = resolve; });
  let count = 0;
  const durable = {
    id: 'durable', ctx: { id: 'p', root: dir, store: { listToolPresentations: () => [], listApprovalRequests: () => [] } },
    session: { messages: [], sessionManager: manager, isStreaming: false, async prompt() {
      if (++count === 2) await checkGate;
      const m = { role: 'assistant', content: [{ type: 'text', text: count === 1 ? '100→120，增长30%。' : '100→120，增长20%。' }], stopReason: 'stop', timestamp: Date.now() };
      this.messages.push(m); manager.appendMessage(m);
    } },
  };
  const pendingCheck = runWithPostAnswer(durable, '问题');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(serializeSession(durable).streaming, true);
  resolveCheck(); await pendingCheck;
  assert.equal(serializeSession(durable).streaming, false);
  const lines = (await fs.readFile(manager.getSessionFile(), 'utf8')).trim().split('\n').map(JSON.parse);
  const lintEntries = lines.filter(x => x.type === 'custom' && x.customType === 'pe_answer_lint');
  assert.equal(lintEntries.length, 2);
  assert(lintEntries[0].data.findings.some(x => x.rule === 'percent_change'));
  assert.equal(lintEntries[1].data.correctionCount, 1);
} finally { await fs.rm(dir, { recursive: true, force: true }); }
console.log('durable lint and snapshot passed');
const { handleSessions } = await import('../server/routes/sessions.mjs');
let routeRelease;
const routeGate = new Promise(resolve => { routeRelease = resolve; });
let routeCalls = 0;
const routeEntry = { id: 'route', title: '已有会话', session: { messages: [], isStreaming: false, async prompt() {
  if (++routeCalls === 2) await routeGate;
  this.messages.push({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: routeCalls === 1 ? '7293 百万元合 7.3 亿元。' : '7293 百万元合 72.93 亿元。' }] });
} } };
const responses = [];
await handleSessions({ req: { method: 'POST' }, res: {}, url: new URL('http://local/api/sessions/route/messages'), ctx: { root: '/tmp' }, app: {
  http: { readJson: async () => ({ text: '问题' }), json: (_res, status, body) => responses.push({ status, body }) },
  sessions: { ensureEntry: async () => routeEntry }, broadcast() {}, nowIso: () => new Date().toISOString(),
} });
await new Promise(resolve => setImmediate(resolve));
assert.equal(responses[0].status, 202);
assert(routeEntry.postAnswerPending);
routeRelease();
await routeEntry.postAnswerRun;
await new Promise(resolve => setImmediate(resolve));
assert.equal(routeCalls, 2);
assert.equal(routeEntry.postAnswerPending, false);
console.log('legacy route post answer passed');
let queuedRelease;
const queuedGate = new Promise(resolve => { queuedRelease = resolve; });
const queuedRecords = [];
let correctionCalls = 0;
const queued = { session: {
  messages: [], sessionManager: { appendCustomEntry: (_type, data) => queuedRecords.push(data) },
  async prompt(text) {
    const isUser = /^user/.test(text);
    if (!isUser && ++correctionCalls === 1) await queuedGate;
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: isUser ? '100→120，增长30%。' : '100→120，增长20%。' });
  },
} };
const first = runWithPostAnswer(queued, 'user one');
const second = runWithPostAnswer(queued, 'user two');
await new Promise(resolve => setImmediate(resolve));
assert(queued.postAnswerPending);
queuedRelease(); await first;
assert(queued.postAnswerPending);
await second;
assert.equal(queued.postAnswerPending, false);
assert.equal(correctionCalls, 2);
assert.equal(new Set(queuedRecords.map(x => x.turnId)).size, 2);
assert(queuedRecords.every(x => x.correctionCount <= 1 && x.continuationCount <= 1));
console.log('queued user turn caps passed');
const finalFrames = [];
const notify = { session: { messages: [], async prompt() { this.messages.push({ role: 'assistant', stopReason: 'stop', content: '完成。' }); } } };
notify.snapshot = () => ({ type: 'snapshot', streaming: Boolean(notify.postAnswerPending) });
await runWithPostAnswer(notify, '问题', {}, event => finalFrames.push(event));
assert.deepEqual(finalFrames.at(-1), { type: 'snapshot', streaming: false });
let abortListener;
let abortCalls = 0;
const eventAborted = { session: {
  messages: [], subscribe(fn) { abortListener = fn; return () => { abortListener = null; }; },
  async prompt() {
    abortCalls++;
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: '7293 百万元合 7.3 亿元。' });
    abortListener({ type: 'agent_settled', aborted: true });
  },
} };
await runWithPostAnswer(eventAborted, '问题');
assert.equal(abortCalls, 1);
assert.equal(eventAborted.answerLint, undefined);
assert.equal(abortListener, null);
let failCalls = 0;
const failCorrection = { session: { messages: [], async prompt() {
  if (++failCalls > 1) throw new Error('correction failed');
  this.messages.push({ role: 'assistant', stopReason: 'stop', content: '7293 百万元合 7.3 亿元。' });
} } };
await assert.rejects(runWithPostAnswer(failCorrection, '问题'), /correction failed/);
assert.equal(failCorrection.postAnswerPending, false);
assert.equal(failCalls, 2);
console.log('abort and failure cleanup passed');
// SDK-shaped custom path: only the actual question becomes a user message.
const customListeners = new Set();
const customRequests = [];
let customTurns = 0;
const hidden = { id: 'hidden', ctx: {id:'p',root:'/tmp',store:{listToolPresentations:()=>[],listApprovalRequests:()=>[]}}, session: {
  messages: [],
  subscribe(fn) { customListeners.add(fn); return () => customListeners.delete(fn); },
  async prompt(text) {
    this.messages.push({role:'user',content:text});
    this.messages.push({role:'assistant',stopReason:'stop',content:'capex 不进入估值。'});
  },
  async sendCustomMessage(message, options) {
    customRequests.push({message,options});
    const custom = {role:'custom',...message};
    this.messages.push(custom);
    for (const fn of customListeners) fn({type:'message_end',message:custom});
    if (!options.triggerTurn) return;
    customTurns++;
    for (const fn of customListeners) fn({type:'tool_execution_start',toolCallId:'path',toolName:'workbook_trace',args:{mode:'path'}});
    for (const fn of customListeners) fn({type:'tool_execution_end',toolCallId:'path',isError:false,result:{}});
    this.messages.push({role:'assistant',stopReason:'stop',content:'路径已核验；仅在解析覆盖范围内不进入估值。'});
    for (const fn of customListeners) fn({type:'agent_settled',aborted:false});
  },
} };
await runWithPostAnswer(hidden, 'capex 不进入估值吗');
assert.equal(customTurns,1);
assert.equal(hidden.session.messages.filter(m=>m.role==='user').length,1);
assert.equal(customRequests[0].message.customType,'pe_turn_context');
assert.equal(customRequests[0].options.deliverAs,'nextTurn');
assert.equal(customRequests[1].message.customType,'pe_answer_correct');
assert.equal(customRequests[1].options.triggerTurn,true);
assert(customRequests.every(r=>r.message.display===false));
assert.deepEqual(hidden.answerLint.findings,[]);
assert.equal(serializeSession(hidden).messages.filter(m=>m.role==='user').length,1);
// Prior tools do not satisfy the next question; failed current-turn tools fail closed.
hidden.session.prompt = async function(text) {
  this.messages.push({role:'user',content:text});
  for (const fn of customListeners) fn({type:'tool_execution_start',toolCallId:'failed',toolName:'workbook_trace',args:{mode:'path'}});
  for (const fn of customListeners) fn({type:'tool_execution_end',toolCallId:'failed',isError:true});
  this.messages.push({role:'assistant',stopReason:'stop',content:'capex 不影响估值。'});
};
await runWithPostAnswer(hidden,'下一条依赖链路');
assert.equal(customTurns,2);
assert.equal(hidden.turnToolCalls.length,2);
// Continuations also stay custom; protocol adapter ignores custom message events.
const hiddenFrames = [];
const hiddenAdapter = new PiAgUiAdapter({session:hidden.session,threadId:'h',workspaceId:'p',log:{append(r){hiddenFrames.push(r.event);return r;}},promptRunner:(t,o)=>runWithPostAnswer(hidden,t,o)});
hidden.session.prompt = async function(text) { this.messages.push({role:'user',content:text},{role:'assistant',stopReason:'stop',content:'结论（尚未'}); };
hidden.session.sendCustomMessage = async function(message,options) {
  customRequests.push({message,options});
  this.messages.push({role:'custom',...message});
  for (const fn of customListeners) fn({type:'message_end',message:{role:'custom',...message}});
  if (options.triggerTurn) {
    const m = {role:'assistant',stopReason:'stop',content:'完成）。'};
    this.messages.push(m);
    for (const fn of customListeners) fn({type:'message_end',message:m});
    for (const fn of customListeners) fn({type:'agent_settled',aborted:false});
  }
};
await hiddenAdapter.runPrompt('继续问题');
await hidden.postAnswerRun;
await new Promise(resolve=>setImmediate(resolve));
assert(customRequests.some(r=>r.message.customType==='pe_answer_continue' && r.message.display===false));
assert(!hiddenFrames.some(f=>f.role==='user' || JSON.stringify(f).includes('<turn_context>')));
hiddenAdapter.detach();
console.log('hidden context, correction, continuation and per-turn tools passed');
// F5 reads the ledger again after tools have had a chance to write this turn.
const {mkdtemp:mkF5,rm:rmF5}=await import('node:fs/promises');
const {tmpdir:tmpF5}=await import('node:os');
const {join:joinF5}=await import('node:path');
const {appendCorrection:correctF5}=await import('../lib/ledger.mjs');
const rootF5=await mkF5(joinF5(tmpF5(),'post-ledger-'));
try {
 const nudgesF5=[];
 const sF5={messages:[],sessionManager:{appendCustomEntry(){}},
  async prompt(t){this.messages.push({role:'user',content:t});await correctF5(rootF5,'s',{claim:'期间',from:'2026H1',to:'1H27',evidence:{type:'user',ref:'turn 1'},turn:1});this.messages.push({role:'assistant',stopReason:'stop',content:'期间为2026H1。'});},
  async sendCustomMessage(m,o){if(o.triggerTurn){nudgesF5.push(m.content);this.messages.push({role:'assistant',stopReason:'stop',content:'期间为1H27。'});}},
 };
 const eF5={id:'s',ctx:{root:rootF5},session:sF5};
 await runWithPostAnswer(eF5,'更正期间');assert.equal(nudgesF5.length,1);assert.match(nudgesF5[0],/当前值 1H27/);assert.equal(eF5.answerLint.findings.length,0);
 const auditF5={messages:[],sessionManager:{appendCustomEntry(){}},async prompt(t){this.messages.push({role:'assistant',stopReason:'stop',content:'全部正确。'});},async sendCustomMessage(m,o){if(o.triggerTurn)this.messages.push({role:'assistant',stopReason:'stop',content:'待检索。'});}};
 const eaF5={id:'s',ctx:{root:rootF5},session:auditF5};await runWithPostAnswer(eaF5,'自查前文');assert.ok(eaF5.answerLint.findings.some(f=>f.rule==='missing_transcript_search'));
} finally {await rmF5(rootF5,{recursive:true,force:true});}
console.log('F5 post-answer ledger and selfaudit passed');

const bgF5={automated:true,session:{messages:[],async prompt(text){this.messages.push({role:'user',content:text});},async sendCustomMessage(){assert.fail('background session must not inject context');}}};
await runWithPostAnswer(bgF5,'后台检查');assert.equal(bgF5.session.messages.length,1);

// DT-8: opt-in checklist enables a bounded missing_section correction; default is unchanged.
const checklistRecords=[];
const checklistSession={messages:[],sessionManager:{appendCustomEntry:(_t,d)=>checklistRecords.push(d)},
  async prompt(){this.messages.push({role:'assistant',stopReason:'stop',content:this.messages.length?'# 结论\n内容。\n\n# 风险\n已列。':'# 结论\n内容。'});},
};
const checklistEntry={id:'s',ctx:{},session:checklistSession};
await runWithPostAnswer(checklistEntry,'问题',{requiredSections:['结论','风险']});
assert.equal(checklistSession.messages.length,2,'checklist enables exactly one correction');
assert.ok(checklistRecords[0].findings.some(f=>f.rule==='missing_section'));
assert.equal(checklistEntry.answerLint.correctionCount,1);
assert.equal(checklistEntry.answerLint.findings.length,0);
const noChecklist={messages:[],async prompt(){this.messages.push({role:'assistant',stopReason:'stop',content:'# 结论\n内容。'});}};
const noChecklistEntry={id:'s',ctx:{},session:noChecklist};
await runWithPostAnswer(noChecklistEntry,'问题');
assert.equal(noChecklist.messages.length,1,'no checklist keeps the old single-pass behavior');
assert.equal(noChecklistEntry.answerLint.findings.length,0);
console.log('DT-8 checklist passed');
