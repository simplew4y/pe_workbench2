import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createReadTool, createWriteTool } from '@earendil-works/pi-coding-agent';
import { createFrameworkEditTool } from '../server/agent/framework-edit.mjs';
import { appendCorrection, markArtifact } from '../lib/ledger.mjs';
import { validateState } from '../lib/validate-state.mjs';
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
assert.equal(records.filter(x => x.type === 'pe_answer_lint').length, 3);
assert.equal(records.filter(x => x.type === 'pe_turn_delivery').length, 1);
assert(!events.some(x => x.type === 'answer.lint'));
assert.equal(records.filter(x => x.type === 'pe_answer_lint').at(-1).data.correctionCount, 1);
assert.equal(records.filter(x => x.type === 'pe_answer_lint').at(-1).data.continuationCount, 1);
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
    const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: calls === 1 ? '100→120，增长30%。' : '复核完成。' }] };
    this.messages.push(message);
    for (const fn of listeners) fn({ type: 'message_end', message });
    this.isStreaming = false;
    for (const fn of listeners) fn({ type: 'agent_settled', aborted: false });
  },
};
const host = { session: pi, snapshot() { throw new Error('fixture: tool-card store unavailable'); } };
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
assert.deepEqual(frames.filter(frame => frame.type === 'TEXT_MESSAGE_CONTENT').map(f => f.delta), ['复核完成。']);
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
assert(queuedRecords.filter(x => x.findings).every(x => x.correctionCount <= 1 && x.continuationCount <= 1));
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
const correctionFailure = await runWithPostAnswer(failCorrection, '问题');
assert.equal(correctionFailure.status, 'failed');
assert.match(correctionFailure.reason, /correction failed/);
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
assert.match(customRequests[1].message.content, /保留已有依据的结论与解释/);
assert.equal(customRequests[1].message.content.includes('给出修正后的完整回答'), false);
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
const {readLedger:readF5}=await import('../lib/ledger.mjs');
const rootF5=await mkF5(joinF5(tmpF5(),'post-ledger-'));
try {
 const answerOnly={id:'answer-only',ctx:{root:rootF5},session:{messages:[],sessionManager:{appendCustomEntry(){}},async prompt(){this.messages.push({role:'assistant',stopReason:'stop',content:'收入为90亿元。'});}}};
 await runWithPostAnswer(answerOnly,'收入情况');
 const answerOnlyLedger=await readF5(rootF5,'answer-only');
 assert.equal(answerOnlyLedger.facts.length,0,'R3 answer text alone never creates verified facts');
 assert.ok(answerOnly.answerLint.findings.some(f=>f.rule==='unsourced_number'));
 const nudgesF5=[];
 const sF5={messages:[],sessionManager:{appendCustomEntry(){}},
  async prompt(t){this.messages.push({role:'user',content:t});await correctF5(rootF5,'s',{claim:'期间',from:'2026H1',to:'1H27',evidence:{type:'user',ref:'turn 1'},turn:1});this.messages.push({role:'assistant',stopReason:'stop',content:'期间为2026H1。'});},
  async sendCustomMessage(m,o){if(o.triggerTurn){nudgesF5.push(m.content);this.messages.push({role:'assistant',stopReason:'stop',content:'期间为1H27。'});}},
 };
 const eF5={id:'s',ctx:{root:rootF5},session:sF5};
 await runWithPostAnswer(eF5,'更正期间');assert.equal(nudgesF5.length,1);assert.match(nudgesF5[0],/当前值 1H27/);assert.equal(eF5.answerLint.findings.length,0);
 const auditF5={messages:[],sessionManager:{appendCustomEntry(){}},async prompt(t){this.messages.push({role:'assistant',stopReason:'stop',content:'全部正确。'});},async sendCustomMessage(m,o){if(o.triggerTurn)this.messages.push({role:'assistant',stopReason:'stop',content:'待检索。'});}};
 const eaF5={id:'s',ctx:{root:rootF5},session:auditF5};await runWithPostAnswer(eaF5,'自查前文');assert.ok(eaF5.answerLint.findings.some(f=>f.rule==='missing_transcript_search'));
 const autoListeners=new Set();
 const autoSession={messages:[],sessionManager:{appendCustomEntry(){}},subscribe(fn){autoListeners.add(fn);return()=>autoListeners.delete(fn);},async prompt(){for(const fn of autoListeners)fn({type:'tool_execution_start',toolCallId:'auto1',toolName:'workbook_query',args:{}});for(const fn of autoListeners)fn({type:'tool_execution_end',toolCallId:'auto1',isError:false,result:{details:{citations:[{id:'auto-cite',materialId:'mat-auto',version:1,locator:'Model!A1',value:90,display_unit:'亿元',role:'revenue'}]}}});this.messages.push({role:'assistant',stopReason:'stop',content:'收入为90亿元。'});}};
 const autoEntry={id:'auto',ctx:{root:rootF5},session:autoSession};await runWithPostAnswer(autoEntry,'收入是多少');
 const autoLedger=await readF5(rootF5,'auto');assert.equal(autoLedger.facts.length,1);assert.equal(autoLedger.facts[0].status,'current');assert.equal(autoLedger.facts[0].citation.locator,'Model!A1');
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
assert.ok(checklistRecords.find(r => r.findings).findings.some(f=>f.rule==='missing_section'));
assert.equal(checklistEntry.answerLint.correctionCount,1);
assert.equal(checklistEntry.answerLint.findings.length,0);
const noChecklist={messages:[],async prompt(){this.messages.push({role:'assistant',stopReason:'stop',content:'# 结论\n内容。'});}};
const noChecklistEntry={id:'s',ctx:{},session:noChecklist};
await runWithPostAnswer(noChecklistEntry,'问题');
assert.equal(noChecklist.messages.length,1,'no checklist keeps the old single-pass behavior');
assert.equal(noChecklistEntry.answerLint.findings.length,0);
console.log('DT-8 checklist passed');

// CELL-CITE L3: locator repair must deal with any number orphaned by deletion.
let locatorCalls = 0;
const locatorPrompts = [];
const locatorSession = {
  messages: [], sessionManager: { appendCustomEntry() {} },
  async prompt(text) {
    locatorPrompts.push(text);
    locatorCalls++;
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: '收入为90亿元，见 Fake!B2。' });
  },
};
const locatorEntry = { id: 'locator', ctx: {}, session: locatorSession };
await runWithPostAnswer(locatorEntry, '问题');
assert.equal(locatorCalls, 2, 'one correction, never a loop');
assert.equal(locatorEntry.answerLint.correctionCount, 1);
assert.equal(locatorEntry.answerLint.findings.filter((item) => item.rule === 'unverified_locator').length, 1);
assert.equal(locatorEntry.answerLint.findings.filter((item) => item.rule === 'orphaned_number').length, 1);
assert.equal(locatorEntry.answerLint.correctionCount, 1, 'orphaned numeric answer auto-corrects at most once');
assert.match(locatorPrompts[1], /未核验/);
assert.match(locatorPrompts[1], /同时删除\/替换该数字/);
assert.match(locatorPrompts[1], /交付一份独立、完整的回答/);
assert.match(locatorPrompts[1], /直接回答用户原问题/);
assert(!locatorPrompts[1].includes('不要改动任何数字'));
// A verified locator is not corrected.
let verifiedCalls = 0;
const verifiedSession = {
  messages: [], listeners: new Set(), sessionManager: { appendCustomEntry() {} },
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  async prompt() {
    verifiedCalls++;
    for (const fn of this.listeners) fn({ type: 'tool_execution_start', toolCallId: 'q1', toolName: 'workbook_query', args: {} });
    for (const fn of this.listeners) fn({
      type: 'tool_execution_end', toolCallId: 'q1', isError: false,
      result: { details: { citations: [{ id: 'c1', materialId: 'mat-1', version: 1, locator: 'Model!A1' }] } },
    });
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: '收入见 Model!A1。' });
  },
};
const verifiedEntry = { id: 'verified', ctx: {}, session: verifiedSession };
await runWithPostAnswer(verifiedEntry, '问题');
assert.equal(verifiedCalls, 1);
assert.equal(verifiedEntry.answerLint.citations.length, 1);
assert.equal(verifiedEntry.answerLint.findings.some((item) => item.rule === 'unverified_locator'), false);
console.log('cell citation post-answer L3 passed');

// G1/G2: a gap-id shield gets exactly one correction that rewrites the first
// sentence with the known model target and forbids treating G1 as a cell.
let targetCalls = 0;
const targetPrompts = [];
const targetSession = {
  messages: [], sessionManager: { appendCustomEntry() {} },
  async prompt(text) {
    targetPrompts.push(text);
    targetCalls++;
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: targetCalls === 1
      ? '先纠正前提：模型底层没有独立目标价单元格（G1），无法精确回答目标价较现价偏离这么多。'
      : '模型目标价 752 港元 vs 现价 418.4 港元，空间约 +79.7%；驱动来自 SOTP 分部重估。' });
  },
};
const targetEntry = { id: 'target', ctx: {}, session: targetSession };
await runWithPostAnswer(targetEntry, '目标价较现价偏离这么多', {
  answerLintContext: { valuations: [{ id: 'V1', output: 'target_price', value: 752 }] },
});
assert.equal(targetCalls, 2, 'exactly one target correction');
assert.equal(targetEntry.answerLint.correctionCount, 1);
assert.match(targetPrompts[1], /模型目标价/);
assert.match(targetPrompts[1], /752/);
assert.match(targetPrompts[1], /首句/);
assert.match(targetPrompts[1], /G1/);
assert.match(targetPrompts[1], /禁止/);
assert.equal(targetEntry.answerLint.findings.filter(f => ['gap_id_as_cell', 'target_missing_claim'].includes(f.rule)).length, 0);
// An earlier turn already read SOTP!J134=752: the correction must reuse that
// session target instead of pretending the model has no target price.
let priorCalls = 0;
const priorPrompts = [];
const priorSession = {
  messages: [], sessionManager: { appendCustomEntry() {} },
  async prompt(text) {
    priorPrompts.push(text);
    priorCalls++;
    this.messages.push({ role: 'assistant', stopReason: 'stop', content: priorCalls === 1
      ? '模型底层没有独立目标价单元格（G1），无法精确回答目标价较现价偏离这么多。'
      : '模型目标价 752 港元 vs 现价 418.4 港元，空间约 +79.7%；驱动来自 SOTP 分部重估。' });
  },
};
const priorEntry = {
  id: 'prior', ctx: {}, session: priorSession,
  citationIndex: [{ materialId: 'm1', version: 1, locator: 'SOTP!J134', value: 752, role: 'output' }],
};
await runWithPostAnswer(priorEntry, '目标价较现价偏离这么多');
assert.equal(priorCalls, 2);
assert.match(priorPrompts[1], /SOTP!J134|752/);
assert.match(priorPrompts[1], /752/);
assert.equal(priorEntry.answerLint.citations.length, 0, 'prior citations must not satisfy current-turn locator checks');
console.log('target deviation post-answer correction passed');

// A real Pi JSONL branch with deterministic model attempts. Only the provider is simulated.
{
  const { execFileSync } = await import('node:child_process');
  const { saveTurnDelivery } = await import('../server/agent/turn-delivery.mjs');
  const suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-delivery-'));

  async function runScript(steps, question = '请回答问题。') {
    const manager = SessionManager.create(suiteRoot, suiteRoot);
    const messages = [];
    const listeners = new Set();
    const requests = [];
    let attempts = 0;
    function emit(event) { for (const fn of listeners) fn(event); }
    function append(message) {
      message.timestamp = Date.now();
      messages.push(message);
      manager.appendMessage(message);
      emit({ type: 'message_end', message });
    }
    function generate() {
      const step = steps[attempts++];
      assert.ok(step, 'model received an unexpected retry');
      emit({ type: 'agent_start' });
      try {
        if (step.error) throw new Error(step.error);
        const calls = step.tools ?? (step.citations || step.search || step.toolError ? [step] : []);
        for (const [i, call] of calls.entries()) {
          const toolCallId = 'tool-' + attempts + '-' + i;
          const toolName = call.name ?? (call.search ? 'transcript_search' : 'workbook_query');
          const args = call.args ?? {};
          append({ role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: toolCallId, name: toolName, arguments: args, argumentsError: call.argumentsError }] });
          emit({ type: 'tool_execution_start', toolCallId, toolName, args });
          const result = {
            role: 'toolResult', toolName, toolCallId, isError: Boolean(call.toolError),
            content: [{ type: 'text', text: call.toolError || 'ok' }], details: call.search || { citations: call.citations || [] },
          };
          append(result);
          emit({ type: 'tool_execution_end', toolCallId, toolName, result, isError: result.isError });
        }
        if (step.text !== undefined) append({
          role: 'assistant', stopReason: step.stopReason || 'stop', errorMessage: step.errorMessage,
          content: [{ type: 'text', text: step.text }],
        });
      } finally {
        emit({ type: 'agent_settled', aborted: step.stopReason === 'aborted' });
      }
    }

    const session = {
      messages, sessionManager: manager,
      subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      async prompt(text) {
        append({ role: 'user', content: text });
        generate();
      },
      async sendCustomMessage(message, options) {
        requests.push(message);
        messages.push({ role: 'custom', ...message });
        manager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
        if (options.triggerTurn) generate();
      },
    };
    const entry = { id: manager.getSessionId(), ctx: { root: suiteRoot }, session };
    const record = await runWithPostAnswer(entry, question);
    assert.equal(attempts, steps.length, 'bounded attempts');
    const metadata = type => manager.getBranch().filter(item => item.type === 'custom' && item.customType === type).map(item => item.data);
    assert.deepEqual(metadata('pe_turn_delivery'), [record]);
    assert.deepEqual(metadata('pe_turn_started').map(item => item.turnId), [record.turnId]);
    assert.ok(record.turnId);
    assert.ok(requests.every(message => message.details.turnId === record.turnId));
    assert.ok(metadata('pe_answer_lint').every(item => item.turnId === record.turnId));
    return { record, metadata, requests, entry, manager };
  }

  try {
    // A first question interrupted before Pi appends a model-visible user
    // message already has a recoverable JSONL and one stable terminal result.
    const { startTurn, recoverInterruptedTurns, turnTimeline } = await import('../server/agent/turn-delivery.mjs');
    const preparing = SessionManager.create(suiteRoot, suiteRoot);
    startTurn({ session: { sessionManager: preparing } }, { turnId: 'early', question: '首个问题。', startedAt: new Date().toISOString() });
    const restoredManager = SessionManager.open(preparing.getSessionFile());
    const interruptedEntry = { session: { sessionManager: restoredManager } };
    recoverInterruptedTurns(interruptedEntry);
    recoverInterruptedTurns(interruptedEntry);
    const decisions = turnTimeline(interruptedEntry.session).filter(item => item.kind === 'delivery');
    assert.deepEqual(decisions.map(item => item.record.status), ['failed']);

    // Pi adds entries to its branch before the filesystem append. A failed
    // append followed by a retry must not turn an in-memory draft into truth.
    const shaky = SessionManager.create(suiteRoot, suiteRoot);
    const shakyEntry = { session: { sessionManager: shaky } };
    startTurn(shakyEntry, { turnId: 'disk', question: '写入重试', startedAt: new Date().toISOString() });
    const persist = shaky._persist.bind(shaky);
    let failWrite = true;
    shaky._persist = item => {
      if (failWrite && item.customType === 'pe_turn_delivery') { failWrite = false; throw new Error('temporary disk error'); }
      persist(item);
    };
    const diskRecord = { turnId: 'disk', status: 'completed', text: '已保存。', citations: [] };
    saveTurnDelivery(shakyEntry, diskRecord);
    assert.deepEqual(turnTimeline({ sessionManager: SessionManager.open(shaky.getSessionFile()) })
      .filter(item => item.kind === 'delivery').map(item => item.record), [diskRecord]);

    const oldCite = { id: 'old', materialId: 'm', version: 1, locator: 'Model!A1' };
    const newCite = { id: 'new', materialId: 'm', version: 1, locator: 'Model!B2', value: 35, display_unit: '亿元' };
    const historicalText = '上一轮正式回答引用的是 [m]Model!B2。';
    const hit = { turn: 1, role: 'assistant', excerpt: '最终稿使用 [m]Model!B2。', citations: [newCite] };
    const search = { matches: [hit], totalMatches: 1 };
    const recalled = await runScript([{ search, text: historicalText }]);
    assert.equal(recalled.record.status, 'completed');
    assert.deepEqual(recalled.record.citations, [newCite]);
    assert.deepEqual(recalled.entry.citationIndex, [], 'previous versions must stay out of the current evidence index');

    const sourceQuestion = '第一轮正式回答当时引用了哪个单元格？';
    const liveSource = { ...newCite, filename: 'Acceptance13.xlsx', materialId: '02cdf096-6b1f-40ea-8d69-6ee87fec0537' };
    const liveSearch = { matches: [{ ...hit, citations: [liveSource] }], totalMatches: 1 };
    const liveAnswer = '命中 1 条，在第 1 轮由助手给出的回答中：该回答引用的单元格是 [Acceptance13.xlsx]Model!B2，材料 ID 为 '
      + liveSource.materialId + '@v1。台账中与“字面常量”这条查询相关的记录为 0 条。';
    for (const text of [liveAnswer, '引用的是 [Acceptance13.xlsx]Model!B2。',
      '第一轮正式回答引用的是 Acceptance13.xlsx 的 [Acceptance13.xlsx]Model!B2。',
      '[Acceptance13.xlsx]Model!B2 是第一轮回答引用的单元格。']) {
      const { record } = await runScript([{ search: liveSearch, text }], sourceQuestion);
      assert.equal(record.status, 'completed');
      assert.deepEqual(record.citations, [liveSource]);
    }

    const sourceReport = '已交付回答引用的单元格是 [Acceptance13.xlsx]Model!B2';
    // Field values are opaque IDs returned by this search, including IDs from older tools.
    const canonicalId = 'cite:' + liveSource.materialId + ':v1:Model!B2';
    const another = { ...liveSource, id: 'cite:second:v1:Model!B2', materialId: 'second', filename: 'Other.xlsx' };
    for (const id of [canonicalId, 'legacy-source-93']) {
      const cited = { ...liveSource, id };
      const matches = { matches: [{ ...hit, citations: [cited, another] }] };
      const phrase = sourceReport + '（材料版本 v1，引用 ID：' + id + '）。';
      const { record } = await runScript([{ search: matches, text: phrase }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', phrase, [{ ...cited, ambiguousQualifiers: [''] }]]);
      const named = phrase.replace('引用 ID：', '本次检索返回的 citation.id：');
      const labeled = await runScript([{ search: matches, text: named }], sourceQuestion);
      assert.deepEqual([labeled.record.status, labeled.record.text, labeled.record.citations],
        ['completed', named, record.citations]);
      for (const wrong of [another.id, canonicalId.replace(':v1:', ':v2:'), canonicalId.replace('!B2', '!B3'), id + 'extra', id + '.v1']) {
        const text = phrase.replace('引用 ID：' + id, '引用 ID：' + wrong);
        const { record } = await runScript([{ search: matches, text }, { text }], sourceQuestion);
        assert.deepEqual([record.status, record.text, record.citations], ['failed', '', []], text);
      }
    }
    const returned = { ...liveSource, id: canonicalId };
    const idSearch = { matches: [{ ...hit, citations: [returned] }] };
    const originalDraft = `第1轮回答引用的是 [${returned.materialId}@v1]Model!B2，命中的完整 citation.id 为 \`${canonicalId}\`，该引用指向工作簿 Acceptance13.xlsx 的 Model!B2（材料 ID 为 ${returned.materialId}，版本为 1）。`;
    const alternateCell = { ...returned, id: canonicalId.replace('!B2', '!C3'), locator: 'Model!C3' };
    const bothCells = { matches: [{ ...hit, citations: [returned, alternateCell] }] };
    for (const text of [
      originalDraft.replace('的 Model!B2（', '的 Model!C3（'),
      originalDraft.replace(canonicalId, alternateCell.id),
      originalDraft.replace('指向工作簿 Acceptance13.xlsx', '指向工作簿 FakeAcceptance13.xlsx'),
      originalDraft.replace('版本为 1', '版本为 2'),
    ]) {
      const { record } = await runScript([{ search: bothCells, text }, { text }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['failed', '', []], text);
    }
    const stored = { ...returned, storedFilename: '1795056222659-Acceptance13.xlsx' };
    const storedSearch = { matches: [{ ...hit, citations: [stored] }] };
    // A second, genuine locator must not validate a different workbook
    // named in prose. Chinese letters and '+' can belong to a filename.
    for (const prefix of ['', '假', 'copy+', 'copy of ', '假工作簿']) {
      const text = `第1轮正式答文在工作簿 ${prefix}${stored.storedFilename} 中引用了 [Acceptance13.xlsx]Model!B2。`;
      const steps = [{ search: storedSearch, text }, ...(prefix ? [{ text }] : [])];
      const { record } = await runScript(steps, sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations],
        prefix ? ['failed', '', []] : ['completed', text, [stored]]);
    }
    const bareSource = `第1轮回答引用的出处是 [Acceptance13.xlsx]Model!B2（材料 ${stored.materialId}，版本 v1，存储文件名 ${stored.storedFilename}），该命中记录带的完整引用 ID 为 ${canonicalId}。`;
    const otherUuid = '8a4d70d1-012b-4f68-a409-58229df21e15';
    for (const material of [`材料 ${stored.materialId}`, `材料 ID ${stored.materialId}`,
      `材料 ${stored.materialId}，材料 ID ${stored.materialId}`]) {
      const text = bareSource.replace('材料 ' + stored.materialId, material);
      const { record } = await runScript([{ search: storedSearch, text }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', text, [stored]]);
    }
    for (const material of [`材料 ${otherUuid}`, `材料 ${stored.materialId}，材料 ID ${otherUuid}`,
      `材料 ID ${stored.materialId}，材料 ${otherUuid}`]) {
      const text = bareSource.replace('材料 ' + stored.materialId, material);
      const { record } = await runScript([{ search: storedSearch, text }, { text }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['failed', '', []]);
    }

    const query = '字面常量';
    const request = '请调用 transcript_search 在本会话第1轮历史中查询“字面常量”。只报告第1轮已交付回答所引用的工作簿、单元格、材料版本和命中所带的完整引用 ID（citation.id）。只问历史出处，不重报读数、期间或财务事实。';
    const locatorLine = `第 1 轮回答引用的出处：工作簿 Acceptance13.xlsx（存储名 ${stored.storedFilename}），单元格 Model!B2，材料 ID ${stored.materialId}，材料版本 v1。`;
    const idLine = '完整 citation.id：' + canonicalId;
    const separate = locatorLine + '\n\n' + idLine;
    const success = { args: { query, turn: 1 }, search: storedSearch };
    const failed = { name: 'transcript_search', toolError: 'invalid arguments' };
    for (const [tools, expected] of [
      [[success], 'completed'],
      [[failed, success], 'completed'],
      [[{ ...failed, args: { query, turnRange: [1, 1] } }, success], 'completed'],
      [[{ ...failed, args: { query: '另一目标', turn: 1 } }, success], 'partial'],
      [[{ ...failed, args: { query, turn: 2 } }, success], 'partial'],
      [[{ ...failed, args: { query, turnRange: [1, 2] } }, success], 'partial'],
      [[failed, { ...success, args: { query: '其他命中词', turn: 1 } }], 'partial'],
      [[{ ...failed, argumentsError: 'Invalid JSON\n\nReceived arguments:\n{"query":"另一目标","turn"' }, success], 'partial'],
      [[success, failed], 'partial'],
    ]) {
      const { record } = await runScript([{ tools, text: separate }], request);
      assert.deepEqual([record.status, record.text, record.citations], [expected, separate, [stored]]);
    }
    const secondSource = { ...stored, id: 'cite:second:v1:Model!A1', materialId: 'second', locator: 'Model!A1', filename: 'Other.xlsx' };
    const secondHit = { ...hit, turn: 2, citations: [secondSource] };
    const secondSearch = { args: { query: '复核范围', turn: 2 }, search: { matches: [secondHit] } };
    const twoRequests = '请在第1轮查询“字面常量”，再在第2轮查询“复核范围”，分别报告两份正式答文的出处。';
    const secondAnswer = '第2轮正式回答引用的是 [Other.xlsx]Model!A1。';
    for (const [question, tools, text, expected] of [
      [request.replace('完整引用 ID', '“完整引用 ID”'), [failed, success], separate, 'completed'],
      [request.replace('“字面常量”', '字面常量'), [failed, success], separate, 'completed'],
      [twoRequests, [failed, success, secondSearch], separate + '\n\n' + secondAnswer, 'completed'],
      [twoRequests, [{ ...failed, args: { query } }, { ...success, args: { query } }], separate, 'partial'],
      [twoRequests, [failed, success, secondSearch], separate, 'partial'],
    ]) {
      const { record } = await runScript([{ tools, text }], question);
      assert.deepEqual([record.status, record.text], [expected, text], question);
    }
    const twoTerms = '请在第1轮分别查询两个词：“字面常量”，“折旧政策”。分别说明两个词的检索结果和历史出处，列出命中的完整引用 ID。';
    const zeroTerm = '折旧政策';
    const noHits = { args: { query: zeroTerm, turn: 1 }, search: {
      matches: [], totalMatches: 0, coverage: { turns: [1], turnsScanned: 1, truncated: false },
    } };
    const withZero = separate + '\n\n“折旧政策”在第1轮未命中。';
    for (const separator of ['，', '、', '，以及', ', ', '，再查询']) {
      const question = twoTerms.replace('”，“', '”' + separator + '“');
      for (const tools of [[failed, success], [success]]) {
        const { record } = await runScript([{ tools, text: separate }], question);
        assert.deepEqual([record.status, record.text, record.citations], ['partial', separate, [stored]], question);
        assert.ok(record.reason.includes(zeroTerm), record.reason);
      }
    }
    for (const tools of [[failed, success, noHits], [failed, noHits, success]]) {
      const { record } = await runScript([{ tools, text: withZero }], twoTerms);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', withZero, [stored]]);
    }
    for (const [statement, expected] of [
      ['“字面常量”命中，“折旧政策”未命中。', 'completed'],
      ['“字面常量”未命中，“折旧政策”命中。', 'partial'],
    ]) {
      const text = separate + '\n\n' + statement;
      const { record } = await runScript([{ tools: [failed, success, noHits], text }], twoTerms);
      assert.equal(record.status, expected, record.reason);
      if (expected === 'completed') assert.equal(record.text, text);
      else assert.equal(record.text, separate);
    }
    for (const wrong of ['“折旧政策”已命中。', '说明应收账款已严重违反折旧政策。']) {
      const text = separate + '\n\n“折旧政策”未命中' + (wrong.startsWith('说明') ? '，' : '。') + wrong;
      const { record } = await runScript([{ tools: [failed, success, noHits], text }], twoTerms);
      assert.equal(record.status, 'partial');
      assert.ok(!record.text.includes(wrong) && record.text.includes(canonicalId));
    }
    const plainTerms = twoTerms.replaceAll('“', '').replaceAll('”', '');
    const plainGap = await runScript([{ tools: [failed, success], text: separate }], plainTerms);
    assert.ok(plainGap.record.reason.includes(zeroTerm), plainGap.record.reason);
    const missingZero = await runScript([{ tools: [failed, success, noHits], text: separate }], twoTerms);
    assert.equal(missingZero.record.status, 'partial');
    assert.ok(missingZero.record.reason.includes(zeroTerm));
    const falseZero = await runScript([{ tools: [failed, success], text: withZero }], twoTerms);
    assert.equal(falseZero.record.status, 'partial');
    assert.equal(falseZero.record.text, separate);
    for (const [name, expected] of [[stored.filename, 'completed'], ['Budget13.xlsx', 'partial']]) {
      for (const label of ['这次只看工作簿', '只报告工作簿']) {
        const question = `请在第1轮查询“字面常量”。${label} ${name} 的历史出处，请给出单元格、材料版本和完整引用 ID。`;
        const { record } = await runScript([{ tools: [failed, success], text: separate }], question);
        assert.deepEqual([record.status, record.text], [expected, separate], question);
        if (expected === 'partial') assert.ok(record.reason.includes(name), record.reason);
      }
    }
    const field = `\`${canonicalId}\``;
    const naturalDrafts = [
      `第1轮回答引用的是 [Acceptance13.xlsx]Model!B2，材料 Acceptance13.xlsx（materialId ${stored.materialId}，version 1），命中该条 citation 带的完整引用 ID 为 ${field}。`,
      `第1轮回答所引用的工作簿是 Acceptance13.xlsx（材料 ${stored.materialId}，版本 1），对应单元格为 [Acceptance13.xlsx]Model!B2；该命中项的完整引用 ID 是 ${field}。\n\n未核验：无`,
      `第1轮回答引用的出处是：[Acceptance13.xlsx]Model!B2，材料 ID 为 ${stored.materialId}，版本 v1；这篇回答命中的 citation.id 是 ${canonicalId}。`,
      `第1轮回答引用的出处是：[Acceptance13.xlsx]Model!B2，材料 ID 为 ${stored.materialId}，版本 v1，对应的行号也显示为 [Acceptance13.xlsx]Model!B2；这条引用命中的 citation.id 是 ${canonicalId}。`,
      `第1轮回答引用的出处是文件 Acceptance13.xlsx（storedFilename 为 ${stored.storedFilename}，materialId 为 ${stored.materialId}，版本为 1）、工作表与单元格 Model!B2，命中该引用时随附的完整引用 ID 是 ${canonicalId}。`,
      `第1轮回答引用的出处是文件 Acceptance13.xlsx（storedFilename ${stored.storedFilename}，materialId ${stored.materialId}，版本 1）中的 [Acceptance13.xlsx]Model!B2，且该出处所附的完整引用 ID 为 ${canonicalId}。`,
    ];
    const coordinateQuestion = request.replace('字面常量', '[Acceptance13.xlsx]Model!B2');
    const coordinateHit = { ...storedSearch.matches[0], excerpt: '[**Acceptance13.xlsx**]**Model!B2** 储存的是常量。' };
    const spaced = { args: { query: 'Acceptance13.xlsx Model!B2', turnRange: [1, 1] }, search: { matches: [coordinateHit] } };
    for (const tools of [[spaced], [failed, spaced]]) {
      const { record } = await runScript([{ tools, text: naturalDrafts[2] }], coordinateQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', naturalDrafts[2], [stored]]);
    }
    const broad = { ...spaced, args: { query: 'Model!B2', turn: 1 } };
    const notLiteral = { ...spaced, search: { matches: [{ ...coordinateHit, excerpt: 'Model!B2，旁注提到 Acceptance13.xlsx。' }] } };
    for (const call of [broad, notLiteral]) {
      const { record } = await runScript([{ tools: [failed, call], text: separate }], coordinateQuestion);
      assert.equal(record.status, 'partial');
    }
    for (const text of naturalDrafts) {
      const { record } = await runScript([{ tools: [success], text }], request);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', text, [stored]]);
    }
    // Labels from the tool schema bind the specific file field to the hit.
    // Both names belong to this material, but they are not interchangeable.
    for (const text of [
      naturalDrafts.at(-1).replace(stored.storedFilename, stored.filename),
      naturalDrafts.at(-1).replace(stored.storedFilename, 'other-' + stored.storedFilename),
      naturalDrafts.at(-1).replace(stored.materialId, '00000000-0000-0000-0000-000000000000'),
      naturalDrafts.at(-1).replace('版本 1', '版本 2'),
    ]) {
      const { record } = await runScript([{ tools: [success], text }, { text }], request);
      assert.notEqual(record.status, 'completed', text);
      assert.notEqual(record.text, text);
    }
    // An explicitly requested workbook restricts the fields due from a hit.
    const multiBookSearch = { ...success, search: { matches: [{ ...hit, citations: [stored, secondSource] }] } };
    for (const [name, expected] of [[stored.filename, 'completed'], ['copy+' + stored.filename, 'partial']]) {
      const question = `请在第1轮查询“字面常量”，只报告第1轮正式回答中工作簿 ${name} 的单元格、版本和完整引用 ID。`;
      const { record } = await runScript([{ tools: [failed, multiBookSearch], text: separate }], question);
      assert.deepEqual([record.status, record.text], [expected, separate]);
    }
    for (const names of [[stored.filename, 'Budget13.xlsx'], ['Budget13.xlsx', stored.filename]]) {
      const question = `请在第1轮查询“字面常量”。这次只看工作簿 ${names.join(' 和 ')} 的历史出处，请分别列出引用 ID。`;
      const { record } = await runScript([{ tools: [failed, success], text: separate }], question);
      assert.deepEqual([record.status, record.text], ['partial', separate]);
      assert.ok(record.reason.includes('Budget13.xlsx'));
    }
    // Verified metadata survives a real remaining gap even when written on
    // separate lines. An ID note must stay attached to the cell that owns it.
    const otherFailure = { name: 'workbook_trace', toolError: 'other file is unavailable' };
    const listed = `工作簿：Acceptance13.xlsx\n材料 ${stored.materialId}，版本 v1\n第一轮正式回答引用的是 Model!B2。\n${idLine}`;
    const incompleteReport = await runScript([{ tools: [otherFailure, success], text: listed }], request);
    assert.deepEqual([incompleteReport.record.status, incompleteReport.record.text, incompleteReport.record.citations],
      ['partial', listed, [stored]]);
    for (const aside of ['出处详情', '当前值为 999 万元。']) {
      const text = locatorLine + '\n\n' + aside + '\n\n' + idLine;
      const steps = [{ tools: [otherFailure, success], text }];
      if (aside.includes('999')) steps.push({ text }); // repeat the unsupported claim on correction
      const { record } = await runScript(steps, request);
      assert.equal(record.status, 'partial');
      assert.ok(record.text.includes(locatorLine) && record.text.includes(idLine), record.text);
      assert.ok(!record.text.includes('999'));
    }
    for (const bad of [idLine.replace(':v1:', ':v2:'), idLine + '，该值为 999 万元。']) {
      const text = locatorLine + '\n\n' + bad;
      const steps = [{ tools: [otherFailure, success], text }, { text }];
      if (!bad.endsWith('。')) steps.push({ text }); // incorrect unterminated ID also triggers continuation
      const { record } = await runScript(steps, request);
      assert.ok(!record.text.includes(bad), record.text);
    }
    const reportedId = `第1轮回答引用了工作簿 Acceptance13.xlsx（存盘文件名 ${stored.storedFilename}）、单元格 Model!B2、材料 ID ${stored.materialId}、材料版本 v1，命中的引用（citation.id）完整为：${canonicalId}。`;
    const reportsWithFilename = [
      `第1轮已交付回答引用的出处是 [Acceptance13.xlsx]Model!B2（材料 ID：${stored.materialId}，版本 1；存储文件名：${stored.storedFilename}），命中的完整引用 ID 为 ${canonicalId}。`,
      `第1轮已交付回答引用的出处是 [Acceptance13.xlsx]Model!B2，材料 ID 为 ${stored.materialId}（版本 1），存储文件名是 ${stored.storedFilename}，命中的完整引用 ID 为 ${canonicalId}。`,
    ];
    for (const text of [reportedId, reportedId.replace('（citation.id）完整为', ' ID 为'),
      reportedId.replace('存盘文件名', '存储文件名')]) {
      const { record } = await runScript([{ ...success, text }], request);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', text, [stored]]);
    }
    for (const text of [reportedId.replace(canonicalId, 'unrelated-ID'), reportedId.replace(stored.storedFilename, stored.filename)]) {
      const { record } = await runScript([{ ...success, text }, { text }], request);
      assert.deepEqual([record.status, record.text, record.citations], ['failed', '', []]);
    }
    for (const text of reportsWithFilename) {
      const { record } = await runScript([{ search: storedSearch, text }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', text, [stored]]);
      for (const wrongName of ['unknown-' + stored.storedFilename, stored.filename]) {
        const wrong = text.replace(stored.storedFilename, wrongName);
        const { record } = await runScript([{ search: storedSearch, text: wrong }, { text: wrong }], sourceQuestion);
        assert.ok(!record.text.includes('存储文件名'), record.text);
      }
    }
    const providerReports = [
      originalDraft,
      '今天检索到的第1轮回答引用的是 [Acceptance13.xlsx]Model!B2（材料版本 v1）。',
      `第1轮回答的出处是工作簿 Acceptance13.xlsx 的 Model!B2，对应材料 ID ${returned.materialId}、版本 v1，完整引用写作 [Acceptance13.xlsx]Model!B2，其 citation.id 为 \`${canonicalId}\`。`,
      `在第1轮回答中，所引用的出处是工作簿文件 Acceptance13.xlsx，材料 ID 为 ${liveSource.materialId}、版本为 v1，单元格为 Model!B2；按引用格式写作 [Acceptance13.xlsx]Model!B2（引用 ID：cite:${liveSource.materialId}:v1:Model!B2）。`,
      `第1轮回答中引用的出处是工作簿 Acceptance13.xlsx（材料 ID ${liveSource.materialId}、版本 v1）的 [Acceptance13.xlsx]Model!B2，引用 ID 为 cite:${liveSource.materialId}:v1:Model!B2。`,
      `第 1 轮中的回答引用了工作簿 Acceptance13.xlsx，材料版本为 v1（材料 ID：${liveSource.materialId}），单元格是 Model!B2，也就是 Sheet 为 Model 的 B2 单元格；对应的完整引用 ID 是 cite:${liveSource.materialId}:v1:Model!B2。`,
      `第 1 轮回答引用的工作簿是 [Acceptance13.xlsx]（材料 ID ${liveSource.materialId}，版本 v1），单元格为 Model!B2，完整引用 ID 是 cite:${liveSource.materialId}:v1:Model!B2。`,
      `第1轮回答引用的内容包括：工作簿为 Acceptance13.xlsx，材料 ID 为 ${liveSource.materialId}，版本为 v1；单元格为 Model!B2；完整引用 ID 为 cite:${liveSource.materialId}:v1:Model!B2。`,
      `第1轮回答引用的出处是 [Acceptance13.xlsx@v1]Model!B2，对应的材料 ID 是 ${liveSource.materialId}，版本为 v1，完整引用 ID 是 cite:${liveSource.materialId}:v1:Model!B2。`,
      `第1轮回答引用了 Acceptance13.xlsx、单元格 Model!B2、材料版本 v1（materialId ${liveSource.materialId}），命中的完整引用 ID 为 ${canonicalId}。`,
      `第1轮回答引用的出处是 [Acceptance13.xlsx]Model!B2（材料 ID 为 ${liveSource.materialId}，版本为 v1），命中所带的完整引用 ID 为 \`${canonicalId}\`。`,
      sourceReport + '（材料版本 v1，检索结果中返回的引用 ID：' + canonicalId + '）。',
      `第1轮回答引用的是 [Acceptance13.xlsx]Model!B2，材料 ID 为 ${liveSource.materialId}，材料版本 v1；该命中项带的完整引用 ID 是 \`${canonicalId}\`。`,
      `第 1 轮回答引用的工作簿是 [Acceptance13.xlsx]Model!B2，其材料 ID 为 ${liveSource.materialId}，材料版本为 v1；该命中项所带的完整引用 ID 是 \`${canonicalId}\`。`,
      `第1轮回答引用的是工作簿 Acceptance13.xlsx，单元格 Model!B2，材料 ID 为 ${liveSource.materialId}，版本为 v1。\n\n完整引用 ID：${canonicalId}`,
      `第1轮回答引用的是 Acceptance13.xlsx（材料 ID ${liveSource.materialId}，版本 v1）中的 Model!B2 单元格，对应的完整引用 ID 为：${canonicalId}`,
      sourceReport + '（材料版本 v1）；**本次检索返回的引用 ID**：' + canonicalId,
      sourceReport + '（材料 ID 为：' + liveSource.materialId + '，版本为：1，引用 ID 为：' + canonicalId + '）。',
      `第1轮回答引用的是工作簿 Acceptance13.xlsx（材料 ID ${liveSource.materialId}，版本 v1）的单元格 Model!B2，他引用的完整 citation.id 为 ${canonicalId}。`,
      `第1轮已交付回答引用的工作簿是 Acceptance13.xlsx；材料 ID 为 ${liveSource.materialId}，版本为 v1；引用的单元格是 Model!B2。命中的完整引用 ID（citation.id）为 ${canonicalId}。`,
      `第1轮已交付回答中引用的工作簿是 [Acceptance13.xlsx]Model!B2（材料 ID 为 ${liveSource.materialId}，版本为 v1）。其中命中的完整引用 ID（citation.id）为 ${canonicalId}。`,
    ];
    for (const text of providerReports) {
      const { record } = await runScript([{ search: idSearch, text }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', text, [returned]]);
    }
    for (const field of ['引用 ID（citation.id）', 'citation.id (引用 ID)', '引用 ID（\`citation.id\`）']) {
      const legacy = { ...returned, id: 'old-source:04' };
      const search = { matches: [{ ...hit, citations: [legacy] }] };
      const answer = sourceReport + '（材料版本 v1，' + field + ' 为：';
      for (const [value, expected] of [[legacy.id, 'completed'], ['wrong-source', 'failed']]) {
        const text = answer + value + '）。';
        const steps = expected === 'completed' ? [{ search, text }] : [{ search, text }, { text }];
        const { record } = await runScript(steps, sourceQuestion);
        assert.deepEqual([record.status, record.text, record.citations],
          [expected, expected === 'completed' ? text : '', expected === 'completed' ? [legacy] : []]);
      }
    }
    const wrongFile = providerReports.at(-2).replace('Acceptance13.xlsx', 'Other.xlsx');
    const mismatch = await runScript([{ search: idSearch, text: wrongFile }, { text: wrongFile }], sourceQuestion);
    assert.ok(!mismatch.record.text.includes('Other.xlsx'));
    const wrongSheet = providerReports.find(text => text.includes('Sheet 为 Model')).replace('Sheet 为 Model 的 B2', 'Sheet 为 Other 的 B2');
    const wrongReport = await runScript([{ search: idSearch, text: wrongSheet }, { text: wrongSheet }], sourceQuestion);
    assert.equal(wrongReport.record.status, 'failed');
    for (const [note, expected] of [['当时用的是第一版。', 'completed'], ['当时用的是第二版。', 'partial'], ['当时用的是第二版，现在文件已更新。', 'partial']]) {
      const sourced = sourceReport + '。';
      const text = sourced + note;
      const steps = [{ search: liveSearch, text }];
      if (expected === 'partial') steps.push({ text });
      const { record } = await runScript(steps, sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations],
        [expected, expected === 'completed' ? text : sourced, [liveSource]]);
    }

    const sourceOnly = '第 1 轮已交付回答引用的出处为：工作簿 Acceptance13.xlsx（材料 ID 为 '
      + liveSource.materialId + '，材料版本 v1），对应单元格 Model!B2；该回答中的引用写作 ['
      + liveSource.materialId + '@v1]Model!B2。';
    const appendedVersion = '第 1 轮已交付回答所引用的出处是工作簿 Acceptance13.xlsx 的单元格 [Acceptance13.xlsx]Model!B2；'
      + '该回答的引用记录中，这份材料的版本为 v1（材料 ID ' + liveSource.materialId + '）。';
    // Verbatim structures from the provider's source-only follow-up, using
    // this fixture's material ID. The second gives a fully qualified spelling.
    const cellThenNoun = '第1轮回答引用的是 Acceptance13.xlsx 的 Model!B2 单元格（材料 ID ' + liveSource.materialId + '，版本 v1）。';
    const fullSpelling = '在本会话第1轮历史里，回答所引用的是 [Acceptance13.xlsx]Model!B2；'
      + '当文件名可能与其他文件重名时，应写作 [' + liveSource.materialId + '@v1]Model!B2，材料版本为 v1。';
    const restated = '第1轮的交付回答引用的是 Acceptance13.xlsx，材料版本为 v1（材料 ID：' + liveSource.materialId
      + '），单元格为 Model!B2；也就是说，本次引用为 [' + liveSource.materialId + '@v1]Model!B2。';
    const prefixedVersion = '第 1 轮交付回答引用的工作簿是 Acceptance13.xlsx（材料 ID ' + liveSource.materialId
      + '），材料版本为 v1；引用的坐标是 [Acceptance13.xlsx]Model!B2，因此带版本写作 [' + liveSource.materialId + '@v1]Model!B2。';
    const canonical = '第 1 轮回答引用的是工作簿 Acceptance13.xlsx（材料 ID ' + liveSource.materialId
      + '，版本 v1）中的 Model!B2 单元格；按来源规范记为 [' + liveSource.materialId + '@v1]Model!B2。';
    const canonicalCorrection = '[Acceptance13.xlsx]Model!B2 在本会话第 1 轮回答中显示的出处是 Acceptance13.xlsx（材料 ID '
      + liveSource.materialId + '，版本 v1）的 Model!B2 单元格，按来源规范记为 [' + liveSource.materialId + '@v1]Model!B2。';
    const listedSource = '第1轮回答的出处如下。\n- 文件名：Acceptance13.xlsx\n- 单元格：Model!B2\n- 材料版本：v1。';
    const namedFields = '第1轮回答引用的单元格为 Model!B2，工作簿名为 Acceptance13.xlsx，材料版本为 v1。';
    for (const text of [canonical, canonicalCorrection, restated, prefixedVersion, cellThenNoun, fullSpelling, listedSource, namedFields, sourceReport + '。', sourceReport + '（材料版本 v1）。', sourceReport + '（材料第一版）。',
      sourceReport + '（材料版本 ｖ１）。', sourceOnly, appendedVersion]) {
      const { record } = await runScript([{ search: liveSearch, text }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['completed', text, [liveSource]]);
    }
    const otherVersion = { ...oldCite, version: 2, filename: 'Other.xlsx' };
    const twoVersions = { matches: [{ ...hit, citations: [liveSource, otherVersion] }] };
    for (const text of [
      prefixedVersion.replace('材料版本为 v1', '材料版本为 v2'),
      restated.replace('也就是说，本次引用为', '这证明了收入增长，引用为'),
      prefixedVersion.replace(liveSource.materialId + '@v1]Model!B2', otherVersion.materialId + '@v2]Model!A1'),
      cellThenNoun.replace('版本 v1', '版本 v2'),
      cellThenNoun.replace('单元格（', '单元格，证明营收增长（'),
      fullSpelling.replace(liveSource.materialId + '@v1]Model!B2', otherVersion.materialId + '@v2]Model!A1').replace('材料版本为 v1', '材料版本为 v2'),
      sourceReport + '（材料版本 v2）。',
      sourceReport + '（材料版本为：2）。',
      sourceReport + '（材料第二版）。',
      sourceReport + '（材料版本二）。',
      sourceReport + '（材料版本 v２）。',
      sourceReport + '（材料版本 v1.2）。',
      sourceReport + '（材料版本 v1，这说明收入增长）。',
      sourceReport + '（材料版本 v1）；对应营业收入 2025A、常量值 317、单位百万元。',
      sourceReport.replace('单元格是', '是 Other.xlsx 的单元格') + '。',
      sourceReport + '（材料 ID ' + otherVersion.materialId + '，版本 v1）。',
      sourceOnly.replace('材料版本 v1', '材料版本 v2'),
      appendedVersion.replace('版本为 v1', '版本为 v2'),
      sourceReport + '（材料版本 v1），值为 317 百万元、期间 2025A、营业收入。',
    ]) {
      const { record } = await runScript([{ search: twoVersions, text }, { text }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['failed', '', []], text);
    }
    // A live read of v2 cannot replace (or override) the historical link to v1.
    const directV2 = { ...liveSource, id: 'direct-v2', version: 2, value: 942 };
    for (const [report, expectedStatus] of [
      [sourceReport + '（材料版本 v1）。', 'completed'],
      [sourceReport.replace('.xlsx]', '.xlsx@v2]') + '。', 'failed'],
    ]) {
      const { record } = await runScript([
        { citations: [directV2], text: '出处是 Missing!A9。' }, { search: liveSearch, text: report },
      ], sourceQuestion);
      assert.equal(record.status, expectedStatus);
      assert.deepEqual(record.citations, expectedStatus === 'completed' ? [liveSource] : []);
    }
    for (const wrongNote of [sourceReport + '。该材料版本为 v2。', '该材料版本为二。' + sourceReport + '。']) {
      const { record } = await runScript([{ search: liveSearch, text: wrongNote }, { text: wrongNote }], sourceQuestion);
      assert.deepEqual([record.status, record.text, record.citations], ['partial', sourceReport + '。', [liveSource]]);
    }
    const financialNote = sourceReport + '（材料版本 v1）。对应营业收入 2025A、常量值 317、单位百万元。';
    const mixedNote = await runScript([{ search: liveSearch, text: financialNote }, { text: financialNote }], sourceQuestion);
    assert.deepEqual([mixedNote.record.status, mixedNote.record.text, mixedNote.record.citations],
      ['partial', sourceReport + '（材料版本 v1）。', [liveSource]]);
    const direct = { ...liveSource, id: 'cite:' + liveSource.materialId + ':v2:Model!B2', version: 2, value: 942 };
    const historicalSource = '第一轮正式回答引用的是 [' + liveSource.materialId + '@v1]Model!B2。';
    const versionQuestion = '请查第1轮正式答文引用的是哪个单元格与材料版本，并说明同一材料当前是哪个版本。';
    for (const [note, read, accepted] of [
      ['截至今天，这份材料的版本为 v2。', [direct], true], ['截至今天，这份材料的版本为 v1。', [direct], false],
      ['截至今天，这份材料的版本为 v1。', [], false], ['截至今天，这份材料的版本为 v2。', [], false],
      ['当前材料版本为 v1。', [], false], ['当前材料版本为 v2。', [], false],
      ['当前材料版本为 v1。', [direct], false], ['当前材料版本为 v2。', [direct], true],
      ['当前材料版本为 v2。', [{ ...direct, materialId: 'other' }], false],
      ['同一材料目前是第二版。', [direct], true], ['同一材料目前是第一版。', [direct], false],
      ['v1 仍是同一材料的当前版本。', [direct], false], ['v2 是该材料的当前版本。', [direct], true],
      ['当前材料版本为 v2，旧版营业收入 317 仍是本轮最新营收。', [direct], false],
      ['当前材料版本无法核实。', [], true], ['当前版本不能核实为 v1。', [], true],
    ]) {
      const text = historicalSource + note;
      const steps = read.length ? [{ citations: read, text: '依据 Missing!A9。' }, { search: idSearch, text }] :
        [{ search: idSearch, text }, ...(!accepted ? [{ text }] : [])];
      const { record } = await runScript(steps, versionQuestion);
      assert.deepEqual([record.status, record.text, record.citations],
        [accepted ? 'completed' : 'partial', accepted ? text : historicalSource, [returned]], note);
    }
    for (const [currentVersion, accepted] of [['v2', true], ['v1', false]]) {
      const text = '截至今天，这份材料的版本为 ' + currentVersion + '。' + historicalSource;
      const { record } = await runScript([{ citations: [direct], text: '依据 Missing!A9。' },
        { search: idSearch, text }], versionQuestion);
      assert.deepEqual([record.status, record.text, record.citations],
        [accepted ? 'completed' : 'partial', accepted ? text : historicalSource, [returned]]);
    }
    const directNote = '本轮直接读取的数值为 942，依据 [' + liveSource.materialId + '@v2]Model!B2（引用 ID：' + direct.id + '）。';
    const both = '第一轮正式回答引用的是 [' + liveSource.materialId + '@v1]Model!B2。' + directNote;
    const combined = await runScript([
      { citations: [direct], text: '出处是 Missing!A9。' }, { search: idSearch, text: both },
    ], sourceQuestion);
    assert.equal(combined.record.status, 'completed');
    assert.deepEqual(combined.record.citations.map(cell => cell.id), [canonicalId, direct.id]);
    const withGap = appendedVersion + '\n\n未核验：说话时该文件在项目中的实际存放路径及磁盘上的版本副本。';
    const withGapResult = await runScript([{ search: liveSearch, text: withGap }], sourceQuestion);
    assert.deepEqual([withGapResult.record.status, withGapResult.record.text, withGapResult.record.citations],
      ['partial', appendedVersion, [liveSource]]);

    // Same coordinate, value and material as the positive case. Only the
    // original delivered assistant match can support reporting its source.
    for (const [details, text] of [
      [{ matches: [], ledgerMatches: [hit] }, historicalText],
      [{ matches: [{ ...hit, role: 'user' }] }, historicalText],
      [{ matches: [{ ...hit, turn: 2 }] }, '第一轮正式回答引用的是 [m]Model!B2。'],
      [{ matches: [{ ...hit, citations: [oldCite] }] }, historicalText],
      [{ matches: [{ ...hit, citations: [{ ...newCite, version: undefined }] }] }, historicalText],
      [search, '当前收入是35亿元，依据 [m]Model!B2。'],
      [search, '根据历史检索命中的出处，这个单元格的值是三十五（[m]Model!B2）。'],
      [search, '上一轮引用的 [m]Model!B2 显示收入持续增长。'],
      [search, '上一轮引用的 [m]Model!B2，显示收入持续增长。'],
      [search, '该值为三十五元，沿用之前引用的 [m]Model!B2。'],
      [search, '收入有望增长，依据 [m]Model!B2。'],
      [search, '历史检索命中。该值为三十五元，依据 [m]Model!B2。'],
      [search, '现在该单元格的值为35，依据 [m]Model!B2。'],
      [search, '第一轮正式回答引用的是 [m@v2]Model!B2。'],
    ]) {
      const { record } = await runScript([{ search: details, text }, { text }], sourceQuestion);
      assert.equal(record.status, 'failed', text);
      assert.deepEqual(record.citations, []);
    }
    const mixedReport = historicalText + '\n当前收入是35亿元，依据 [m]Model!B2。';
    const partialReport = await runScript([{ search, text: mixedReport }, { text: mixedReport }]);
    assert.equal(partialReport.record.status, 'partial');
    assert.equal(partialReport.record.text, historicalText);
    assert.deepEqual(partialReport.record.citations, [newCite]);

    const corrected = await runScript([
      { text: '初稿 A：见 Model!A1 和 Fake!C9。', citations: [oldCite] },
      { text: '新稿 B：收入为35亿元，见 Model!B2。', citations: [newCite] },
    ]);
    assert.equal(corrected.record.text, '新稿 B：收入为35亿元，见 Model!B2。');
    assert.equal(corrected.record.status, 'completed');
    assert.deepEqual(corrected.record.citations.map(c => c.id), ['new']);
    assert.equal(corrected.requests.at(-1).customType, 'pe_answer_correct');

    const sameLocator = await runScript([
      { text: '旧稿引用 Fake!C9。', citations: [{ ...newCite, id: 'old-b2', materialId: 'old-book' }] },
      { text: '新版依据 [m]Model!B2。', citations: [newCite] },
    ]);
    assert.deepEqual(sameLocator.record.citations.map(c => c.id), ['new']);
    const withRange = await runScript([{ text: '采用 Model!B2:B3、B4。', citations: [oldCite, newCite,
      {...newCite, id: 'b3', locator: 'Model!B3'}, {...newCite, id: 'b4', locator: 'Model!B4'},
    ] }]);
    assert.deepEqual(withRange.record.citations.map(c => c.id), ['new', 'b3', 'b4']);

    // A normal stop requires the same continuation path as a provider's hard length stop.
    for (const stopReason of ['length', 'stop']) {
      const split = await runScript([{ text: '这是前半段，', stopReason }, { text: '这是后半段。' }]);
      assert.equal(split.record.text, '这是前半段，这是后半段。');
      assert.equal(split.record.status, 'completed');
      assert.deepEqual(split.record.citations, []);
      assert.deepEqual(split.metadata('pe_answer_lint').at(-1).findings, []);
      assert.equal(split.requests.at(-1).customType, 'pe_answer_continue');
    }
    const spaces = await runScript([{ text: 'The first ', stopReason: 'length' }, { text: 'half.' }]);
    assert.equal(spaces.record.text, 'The first half.');
    const echoed = await runScript([{ text: '前文，', stopReason: 'length' }, { text: '前文，结论。' }]);
    assert.equal(echoed.record.text, '前文，结论。');
    // The incorrect conversion exists only across the boundary; checking just the tail misses it.
    const joined = await runScript([
      { text: '100→120，', stopReason: 'length' }, { text: '增长30%。' },
      { text: '增长幅度已更正。' },
    ]);
    assert.equal(joined.record.text, '增长幅度已更正。');
    assert.deepEqual(joined.requests.slice(-2).map(request => request.customType), ['pe_answer_continue', 'pe_answer_correct']);
    assert.ok(joined.metadata('pe_answer_lint').some(item => item.findings.some(f => f.rule === 'percent_change')));

    const good = '收入为35亿元，见 Model!B2。';
    const bad = '第二项为909亿元，见 Fake!C9。';
    const mixed = await runScript([{ text: good + '\n\n' + bad, citations: [newCite] }, { text: good + '\n\n' + bad }]);
    assert.equal(mixed.record.status, 'partial');
    assert.ok(mixed.record.text.includes(good));
    assert.doesNotMatch(mixed.record.text, /909|Fake!C9/);
    assert.deepEqual(mixed.record.citations.map(c => c.id), ['new']);
    assert.ok(mixed.record.reason, 'partial results identify the outstanding gap');

    const recoveredLookup = await runScript([
      { toolError: 'missing workbook', text: '旧稿引用 Fake!C9。' },
      { citations: [newCite], text: good },
    ]);
    assert.equal(recoveredLookup.record.status, 'completed');
    assert.deepEqual(recoveredLookup.record.citations.map(c => c.id), ['new']);

    const failures = [
      [{ text: bad }, { text: bad }],
      [{ text: '未核验的模型片段', stopReason: 'error', errorMessage: 'provider disconnected' }],
      [{ error: 'provider unavailable' }],
      [{ toolError: 'workbook not found' }],
      [{ toolError: 'workbook not found', text: '查询顺利完成。' }],
    ];
    for (const steps of failures) {
      const { record } = await runScript(steps);
      assert.equal(record.status, 'failed');
      assert.deepEqual(record.citations, []);
      assert.ok(record.reason);
      assert.doesNotMatch(record.text, /909|Fake!C9|未核验的模型片段/);
    }
    const emptyContinuation = await runScript([{ text: good, stopReason: 'length', citations: [newCite] }, { text: '' }]);
    assert.equal(emptyContinuation.record.status, 'partial');
    assert.equal(emptyContinuation.record.text, good);
    const cancelled = await runScript([{ text: '取消前未校验文字', stopReason: 'aborted' }]);
    assert.equal(cancelled.record.status, 'cancelled');
    assert.doesNotMatch(cancelled.record.text, /取消前未校验文字/);

    await saveTurnDelivery(corrected.entry, { ...corrected.record, text: '迟到的另一稿。' });
    assert.deepEqual(corrected.metadata('pe_turn_delivery'), [corrected.record], 'first committed result wins');
    const restored = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { SessionManager } from '@earendil-works/pi-coding-agent';
      const branch = SessionManager.open(process.argv[1]).getBranch();
      process.stdout.write(JSON.stringify(branch.filter(e => e.customType === 'pe_turn_delivery').map(e => e.data)));
    `, corrected.manager.getSessionFile()], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8' });
    assert.deepEqual(JSON.parse(restored), [corrected.record], 'new process observes identical delivery');
  } finally {
    await fs.rm(suiteRoot, { recursive: true, force: true });
  }
  console.log('durable turn delivery, corrections, bounded continuations and terminal states passed');
}

async function frameworkFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pe-framework-delivery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, root);
  const state = JSON.parse(await fs.readFile(new URL('../skills/investment-framework/assets/analysis-state.example.json', import.meta.url), 'utf8'));
  const content = verdict => JSON.stringify({
    ...state, presentation: { ...state.presentation, verdict: { ...state.presentation.verdict, text: verdict } },
  }, null, 2);
  const tools = { read: createReadTool(root), edit: createFrameworkEditTool(root, () => entry.activeTurn), write: createWriteTool(root) };
  let calls = [];
  let sequence = 0;
  function append(message) {
    const stamped = { ...message, timestamp: Date.now() };
    session.messages.push(stamped);
    manager.appendMessage(stamped);
  }
  const session = {
    sessionManager: manager, messages: [],
    async prompt(question) {
      append({ role: 'user', content: question });
      for (const [name, args] of calls) {
        const id = 'framework-' + ++sequence;
        append({ role: 'assistant', stopReason: 'toolUse',
          content: [{ type: 'toolCall', id, name, arguments: args }] });
        const result = await tools[name].execute(id, args);
        if (name === 'read') assert.match(result.content[0].text, /Use offset=/);
        if (name === 'edit') assert.ok(result.details.patch);
        append({ ...result, role: 'toolResult', toolName: name, toolCallId: id, isError: false });
      }
      append({ role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: '正式回答。' }] });
    },
  };
  const ctx = { root, store: { listToolPresentations: () => [], listApprovalRequests: () => [] } };
  const id = manager.getSessionId();
  const entry = { id, ctx, session };
  async function deliver(toolCalls) {
    calls = toolCalls;
    const events = [];
    const record = await runWithPostAnswer(entry, '请完成本轮工作。', {}, event => events.push(event));
    assert.equal(record.status, 'completed', record.reason);
    assert.equal(record.text, '正式回答。');
    assert.deepEqual(events.find(event => event.type === 'turn.delivered')?.record, record);
    return record;
  }
  function answers(reopen = false) {
    const restored = reopen ? { ...entry, session: { sessionManager: SessionManager.open(manager.getSessionFile()) } } : entry;
    return serializeSession(restored).messages.filter(m => m.role === 'assistant');
  }
  return { root, id, content, deliver, answers };
}

await test('real Pi paginated read and edit preserve successive framework versions in delivery', async t => {
  const f = await frameworkFixture(t);
  const artifact = 'exports/analysis-state.json';
  const original = f.content('原判断');
  assert.equal(validateState(JSON.parse(original)).ok, true);
  await fs.mkdir(path.join(f.root, 'exports'));
  await fs.writeFile(path.join(f.root, artifact), original);
  const edit = (before, after, path = artifact) => ['edit', { path, edits: [{ oldText: before, newText: after }] }];
  const piPath = '@' + artifact;
  const first = await f.deliver([['read', { path: piPath, offset: 1, limit: 20 }], edit('原判断', '新判断', piPath)]);
  const verdict = m => m.analysisState?.presentation.verdict.text;
  assert.equal(JSON.parse(await fs.readFile(path.join(f.root, artifact), 'utf8')).presentation.verdict.text, '新判断');
  assert.equal(verdict(first), '新判断');
  assert.equal(first.analysisStatePath, artifact);
  assert.equal(verdict(f.answers()[0]), '新判断');
  assert.equal(verdict(f.answers(true)[0]), '新判断');
  await f.deliver([edit('新判断', '第三版判断')]);
  await f.deliver([]);
  assert.deepEqual(f.answers().map(verdict), ['新判断', '第三版判断', undefined]);
  assert.deepEqual(f.answers(true).map(verdict), ['新判断', '第三版判断', undefined]);
});

await test('a paginated edit keeps file revisions outside the patch context', async t => {
  const f = await frameworkFixture(t);
  const artifact = 'exports/analysis-state.json';
  await f.deliver([['write', { path: artifact, content: f.content('原判断') }]]);
  const updated = { ...JSON.parse(f.content('原判断')), revision: 2 };
  await fs.writeFile(path.join(f.root, artifact), JSON.stringify(updated, null, 2));
  const record = await f.deliver([
    ['read', { path: artifact, offset: 1, limit: 20 }],
    ['edit', { path: artifact, edits: [{ oldText: '原判断', newText: '新判断' }] }],
  ]);
  assert.equal(record.analysisState?.presentation.verdict.text, '新判断');
  assert.equal(record.analysisState?.revision, 2);
  assert.deepEqual(f.answers(true).map(m => m.analysisState?.revision), [1, 2]);
});

await test('history keeps a captured edit without a verdict card', async t => {
  const f = await frameworkFixture(t);
  const artifact = 'exports/analysis-state.json';
  const original = f.content('原判断');
  await f.deliver([['write', { path: artifact, content: original }]]);
  const current = JSON.parse(original);
  delete current.presentation.verdict;
  await fs.writeFile(path.join(f.root, artifact), JSON.stringify(current, null, 2));
  const record = await f.deliver([
    ['read', { path: artifact, offset: 1, limit: 20 }],
    ['edit', { path: artifact, edits: [{ oldText: '"revision": 1', newText: '"revision": 2' }] }],
  ]);
  assert.equal(Boolean(record.analysisState), false);
  assert.deepEqual(f.answers(true).map(m => m.analysisState?.presentation.verdict?.text), ['原判断', undefined]);
});

await test('two framework cards keep their own pending corrections as of delivery', async t => {
  const f = await frameworkFixture(t);
  const a = 'exports/first/analysis-state.json';
  const b = 'exports/second/analysis-state.json';
  const correction = await appendCorrection(f.root, f.id, {
    claim: '核对框架数据', evidence: { type: 'user', ref: '测试' }, turn: 0, from: 2, to: 3,
  });
  const mark = (path, status) => markArtifact(f.root, f.id, correction.id, { path, status });
  await mark(a, 'pending_merge');
  const write = (path, text) => [['write', { path, content: f.content(text) }]];
  assert.equal((await f.deliver(write(a, '第一份框架。'))).analysisStatePath, a);
  assert.equal((await f.deliver(write(b, '第二份框架。'))).analysisStatePath, b);
  const flags = () => f.answers(true).map(m => [m.analysisStatePath, m.analysisStatePendingMerge]);
  assert.deepEqual(flags(), [[a, true], [b, false]]);
  await mark(a, 'merged');
  await mark(b, 'pending_merge');
  assert.deepEqual(flags(), [[a, true], [b, false]]);
  await f.deliver(write(b, '第二份框架更新。'));
  assert.deepEqual(flags(), [[a, true], [b, false], [b, true]]);
});

const correction = '结论保留。此前说法有误，正确的口径是合并收入。后续仍沿用原假设。';
const correctionSession = { messages: [], async prompt() {
  this.messages.push({ role: 'assistant', stopReason: 'stop', content: correction });
} };
const deliveredCorrection = await runWithPostAnswer({ session: correctionSession }, '请复核上一轮回答');
assert.equal(deliveredCorrection.text, correction);
