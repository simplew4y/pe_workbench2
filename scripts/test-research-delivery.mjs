import assert from "node:assert/strict";
import {createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, normalizeContext} from "@earendil-works/pi-ai";
import {answerIssues,guardResearchDelivery} from "../lib/research-delivery.mjs";

const path = "exports/analysis.md";
const user = {role:"user", content:"请解读估值模型"};
function call(name, id) {
  return {role:"assistant",content:[{type:"toolCall",name,id,arguments:{path}}]};
}
const failure = {role:"toolResult",toolCallId:"r",toolName:"review_research",isError:true,
  content:[{type:"text",text:"期间不匹配"}]};
const pending = [user, call("review_research","r"), failure];
const text = {type:"text",text:"已交付草稿，预计收益 999%"};
async function run(messages, second, first = text) {
  let requests = 0;
  const provider = async () => {
    const content = ++requests === 2 && second ? second : [first];
    const message = {role:"assistant",timestamp:Date.now(),content,
      stopReason:content.some(p=>p.type==="toolCall")?"toolUse":"stop"};
    const stream = createAssistantMessageEventStream();
    stream.push({type:"text_delta",delta:text.text,partial:message,contentIndex:0});
    stream.push({type:"done",reason:message.stopReason,message});
    stream.end();
    return stream;
  };
  const result = await guardResearchDelivery(provider,{audit:async()=>({ok:true,issues:[]})})({}, {messages}, {});
  const events = [];
  for await (const e of result) events.push(e);
  return {requests,events,final:await result.result()};
}
const rejected = await run(pending);
assert.equal(rejected.requests,3);
assert.doesNotMatch(JSON.stringify(rejected.events),/999%/);
assert.match(rejected.final.content[0].text,/尚未保存/);
const repair = await run(pending,[text,...call("review_research","retry").content]);
assert.equal(repair.final.content[0].id,"retry");
assert.doesNotMatch(JSON.stringify(repair.events),/999%/);
const receipt = {role:"toolResult",toolCallId:"w",isError:false,
  content:[{type:"text",text:"[research_write_verified] exports/analysis.md sha256=test"}]};
for (const messages of [[...pending,user],[...pending,call("write","w"),receipt]]) {
  const normal = await run(messages,undefined,{type:"text",text:"模型假设仍需核验。"});
  assert.equal(normal.requests,1);
  assert.equal(normal.events[0].type,"start");
}
const commitCall = {role:'assistant',content:[{type:'toolCall',name:'framework_commit',id:'framework',
  arguments:{framework_id:'main',expected_revision:1}}]};
const published = {role:'toolResult',toolCallId:'framework',toolName:'framework_commit',isError:false,content:[],
  details:{framework_id:'main',revision:2,status:'pending',framework:{framework_id:'main',revision:2,status:'published'}}};
const deliveredReport={type:'text',text:'报告已保存。核心判断仍依赖毛利率假设。'};
assert.equal((await run([user,commitCall,published],undefined,deliveredReport)).requests,1);
const olderRevision={...published,details:{...published.details,framework:{framework_id:'main',revision:1,status:'published'}}};
assert.doesNotMatch((await run([user,commitCall,olderRevision],undefined,deliveredReport)).final.content[0].text,/报告已保存/);
console.log("PASS failed research delivery: no rejected draft in stream/history, bounded recovery attempts, tool calls preserved, turn reset and successful receipt");

const state = {written:false,previousPartial:new Map([["exports/analysis.md","该文件为部分核验记录"]])};
assert.ok(answerIssues("模型用 66,881 百万股。模型是 66.9 亿股，差了约 10 倍。",state).some(x=>x.includes("668.81")));
assert.deepEqual(answerIssues("66,881 百万股折合 668.81 亿股。",state),[]);
assert.deepEqual(answerIssues("甲有10000百万股，乙有10亿股。",state),[]);
assert.ok(answerIssues("84% 毛利率已兑现：上半年毛利率 84.84%。",state).length);
assert.deepEqual(answerIssues("上半年收入目标已兑现。",state),[]);
assert.ok(answerIssues("我把完整的假设验证报告写入文件。",state).length);
assert.ok(answerIssues("完整报告在 exports/analysis.md。",state).length);
console.log("PASS checks for unit restatement, report receipts, partial-period evidence");

// A failed file save must not erase a valid answer; the retry cap still forbids tools.
const capped=[user];
for(let i=0;i<6;i++) capped.push(call('review_research','r'+i),{...failure,toolCallId:'r'+i});
async function answerCase(messages,{draft='模型预测尚待验证，应观察售价、成本和量产进展，具体失效门槛缺少推导依据。',bad=false,tool=false}={}) {
 let requests=0,audits=0;
 const provider=async(_model,ctx)=>{
  requests++;
  if(messages===capped) assert.deepEqual(ctx.tools,[]);
  const message={role:'assistant',content:tool?call('write','w').content:[{type:'text',text:draft}],stopReason:tool?'toolUse':'stop',usage:{input:2,output:3,totalTokens:5}};
  const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:message.stopReason,message});stream.end();return stream;
 };
 const stream=await guardResearchDelivery(provider,{audit:async()=>{audits++;return {ok:!bad,issues:bad?[{check:'conclusion_strength',excerpt:draft,reason:'虚构已证实结论'}]:[],usage:{input:1,output:1,totalTokens:2}};}})({}, {messages,tools:[{name:'write'}]}, {});
 const events=[];for await(const e of stream)events.push(e);
 return {message:await stream.result(),requests,audits,events};
}
for(const messages of [pending,capped]) {
 const result=await answerCase(messages);
 const text=result.message.content.map(p=>p.text).join('\n');
 assert.match(text,/尚未保存/);assert.match(text,/应观察售价/);
 assert.equal(result.requests,1);assert.equal(result.audits,1);
 assert.equal(result.message.usage.input,2,'audit tokens must not inflate SDK context usage');
 assert.equal(result.message.researchUsage.input,3,'billing remains recorded separately');
 assert.equal(result.message.usage.totalTokens,5,'SDK context size is the last writer request, not cumulative billing');
 assert.equal(result.message.researchUsage.totalTokens,7);
}
const unsafe=await answerCase(capped,{draft:'无依据的结论已经完全证实',bad:true});
assert.equal(unsafe.requests,3);assert.doesNotMatch(JSON.stringify(unsafe.events),/无依据的结论已经完全证实/);
assert.match(unsafe.message.content[0].text,/证据不足/);
const stillCalls=await answerCase(capped,{tool:true});
assert.equal(stillCalls.requests,2);assert.equal(stillCalls.message.stopReason,'error','noncompliant provider cannot be marked complete');
for(const draft of ['已保存报告','已交付草稿','报告已保存到文件']) {
 assert.ok(answerIssues(draft,{written:false,previousPartial:new Map()}).length);
}
console.log('PASS report/answer separation: verified answer retained, cap disables tools, unsafe drafts hidden, bounded repairs and usage preserved');

// Exercise the normalized context supplied by the Pi agent loop, including a
// tool declaration added after the leading system message.
const tool = name => ({ name, description: name, parameters: { type: 'object', properties: {} } });
const firstSystem = { role: 'system', content: '初始说明', sections: { limits: '原始口径' }, toolsAdded: [tool('read')], timestamp: 0 };
const toolsUpdate = { role: 'system', content: '新的说明', toolsAdded: [tool('write')], timestamp: 1 };
for (const initial of [[user], capped]) {
  const messages = [firstSystem, toolsUpdate, ...initial];
  const original = JSON.stringify(messages);
  const requestTools = [];
  const provider = async (_model, context) => {
    const transcript = normalizeContext(context).messages;
    requestTools.push(getCurrentTools(transcript).map(t => t.name));
    const prompt = getCurrentSystemPrompt(transcript);
    if (transcript.some(m => m.sections?.limits)) {
      for (const section of ['初始说明', '原始口径', '新的说明']) assert.ok(prompt.includes(section));
    }
    const text = requestTools.at(-1).length ? '我先重新梳理' : '应观察售价与成本，尚需核实已有资料。';
    const message = { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text }], usage: {} };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
    return stream;
  };
  const guarded = guardResearchDelivery(provider, { audit: async () => ({ ok: true, issues: [] }) });
  const message = await (await guarded({}, { messages }, {})).result();
  assert.equal(message.stopReason, 'stop');
  assert.match(message.content[0].text, /应观察售价/);
  if (initial === capped) assert.ok(requestTools.every(names => !names.length), 'capped report must never request tools');
  else assert.deepEqual(requestTools[0], ['read', 'write'], 'normal research keeps the declared tools');
  assert.deepEqual(requestTools.at(-1), [], 'final answer-only recovery advertises no tools');
  assert.equal(JSON.stringify(messages), original);
}

async function scenario(drafts,verdicts,question=user) {
 let calls=0,audits=0;
 const provider=async()=>{
  const text=drafts[Math.min(calls++,drafts.length-1)];
  const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop'};
  const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end();return stream;
 };
 const stream=await guardResearchDelivery(provider,{audit:async()=>verdicts[Math.min(audits++,verdicts.length-1)]})({}, {messages:[question]},{});
 for await(const e of stream){}
 return {calls,audits,result:await stream.result()};
}
const valid='模型利润率取决于售价、产品组合与成本。若售价下跌而单位成本未同步下降，利润率假设会承压；应观察成交价、成本与产品结构，现有资料不足以确定具体阈值。';
const outage={ok:false,status:'unavailable',issues:[{check:'audit',reason:'后台证据核验结果不完整，不能据此认定通过'}]};
const preserved=await scenario([valid],[outage]);
assert.equal(preserved.calls,1);assert.match(preserved.result.content[0].text,/模型利润率取决于售价/);
assert.doesNotMatch(preserved.result.content[0].text,/核验结果不完整|本轮分析未完成/);
const progress=await scenario(['我先重新梳理',valid],[{ok:true,issues:[]}]);
assert.equal(progress.calls,2);assert.equal(progress.audits,1);assert.match(progress.result.content[0].text,/应观察成交价/);
const clarification = '你倾向哪个方向？\n\nA. 复现原表目标价。\nB. 追踪最影响估值的经营假设。';
const clarify = await scenario([clarification], [{ok:true,issues:[]}], {role:'user',content:'这个模型怎么看？'});
assert.equal(clarify.calls, 1);
assert.equal(clarify.result.content[0].text, clarification);
const handoff = await scenario(['如果你希望，我可以再分析。', valid], [{ok:true,issues:[]}]);
assert.equal(handoff.calls, 2);
assert.equal(handoff.result.content[0].text, valid);
const badSentence='良率低于62%必然失效。';
const scoped=await scenario([valid+'\n\n'+badSentence],[{ok:false,issues:[{check:'threshold_provenance',excerpt:badSentence,reason:'缺少阈值推导依据，具体失效门槛无法确定。'}]}]);
assert.equal(scoped.calls,3);assert.match(scoped.result.content[0].text,/应观察成交价/);assert.doesNotMatch(scoped.result.content[0].text,/62%必然/);
const saved=await scenario(['报告已保存。\n\n'+valid],[outage]);
assert.match(saved.result.content[0].text,/应观察成交价/);assert.doesNotMatch(saved.result.content[0].text,/报告已保存/);
for(const sentence of ['报告没有成功保存。','我将把报告保存到文件。','不能声称报告已保存。','报告未保存，下面直接回答。']) assert.deepEqual(answerIssues(sentence,{written:false,previousPartial:new Map()}),[],sentence);
const carried=await scenario([badSentence+'\n\n'+valid],[{ok:false,issues:[{check:'threshold_provenance',excerpt:badSentence,reason:'缺少阈值推导依据。'}]},outage]);
assert.doesNotMatch(carried.result.content[0].text,/62%必然/);assert.match(carried.result.content[0].text,/应观察成交价/);
console.log('PASS usable delivery: audit outage keeps answer, specific errors stay local, progress-only repaired, known errors survive reviewer outage');

const adjacent=await scenario([badSentence+valid],[{ok:false,issues:[{check:'threshold_provenance',excerpt:badSentence,reason:'具体阈值缺少依据。'}]}]);
assert.match(adjacent.result.content[0].text,/模型利润率取决于售价/,'a complete bad sentence must not erase the following good sentence');
assert.doesNotMatch(adjacent.result.content[0].text,/62%必然/);

// Exercise the same research stream and turn finalizer used by a managed chat.
// Pi converts custom instructions to role=user in its provider-facing copy.
const { runWithPostAnswer } = await import('../server/agent/post-answer.mjs');
function scriptedProvider(replies) {
  let index = 0;
  return () => {
    const reply = replies[index++];
    assert.ok(reply, 'unexpected model request');
    const message = { role: 'assistant', timestamp: index, content: [], ...reply };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: 'done', reason: message.stopReason, message });
    stream.end();
    return stream;
  };
}
const reply = (stopReason, text) => ({ stopReason, content: [{ type: 'text', text }] });
const allowed = { ok: true, issues: [] };
const denied = excerpt => ({ ok: false, issues: [{ check: 'threshold_provenance', excerpt, reason: '缺少证据。' }] });
async function managedResearch(replies, verdict = () => allowed, initial = []) {
  const auditDrafts = [], requests = [], messages = [...initial];
  const session = {
    messages, sessionManager: { appendCustomEntry() {} },
    async prompt(text) { messages.push({ role: 'user', content: text }); await generate(); },
    async sendCustomMessage(message, options) {
      messages.push({ role: 'custom', ...message });
      if (options.triggerTurn) { requests.push(message.customType); await generate(); }
    },
  };
  const entry = { session };
  const guarded = guardResearchDelivery(scriptedProvider(replies), {
    getSessionMessages: () => messages,
    getContinuation: () => entry.activeTurn?.continueResearchAnswer,
    audit: async (_source, _model, context, _options, draft) => {
      assert.equal(context.messages.filter(m => m.role === 'user').at(-1).content, '请解释模型假设。');
      auditDrafts.push(draft);
      return verdict(draft, auditDrafts.length);
    },
  });
  async function generate() {
    const providerMessages = messages.map(m => m.role === 'custom' ? { role: 'user', content: m.content } : m);
    const stream = await guarded({}, { messages: providerMessages }, {});
    messages.push(await stream.result());
  }
  const record = await runWithPostAnswer(entry, '请解释模型假设。');
  return { record, auditDrafts, requests, messages: messages.filter(m => m.role === 'assistant') };
}
const first = '该假设依赖交付节奏。', second = '若订单推迟，确认收入也会推迟。';
for (const prefix of [first, '']) {
  const turn = await managedResearch([reply('length', prefix), reply('stop', second)]);
  assert.deepEqual(turn.requests, ['pe_answer_continue']);
  assert.deepEqual([turn.record.status, turn.record.text], ['completed', prefix + second]);
  assert.equal(turn.auditDrafts.at(-1), prefix + second);
  assert.equal(turn.messages[0].stopReason, 'length');
}
const interruptedCall = await guardResearchDelivery(scriptedProvider([{
  stopReason: 'length', content: [{ type: 'toolCall', name: 'write', id: 'broken', arguments: {} }],
}]))({}, { messages: [user] }, {});
assert.deepEqual([(await interruptedCall.result()).stopReason, (await interruptedCall.result()).content], ['length', []]);
const rejectedPrefix = await managedResearch([reply('length', badSentence), reply('stop', second)],
  draft => draft.includes(badSentence) ? denied(badSentence) : allowed);
assert.deepEqual(rejectedPrefix.messages[0].content, []);
assert.equal(rejectedPrefix.record.text, second);
const crossBoundary = await managedResearch([
  reply('length', '该假设的风险是'), reply('stop', '必然失效。'), reply('stop', first),
], draft => draft.includes('风险是必然失效') ? denied(draft) : allowed);
assert.ok(crossBoundary.auditDrafts.includes('该假设的风险是必然失效。'));
assert.equal(crossBoundary.record.text, first, 'a corrected combined draft must replace its prefix');
const repairLength = await managedResearch([
  reply('stop', badSentence), reply('length', badSentence), reply('stop', second),
], (draft, index) => index === 1 ? denied(draft) : allowed);
assert.deepEqual(repairLength.messages[0].content, [], 'a truncating repair cannot leak a known rejected passage');
assert.deepEqual([repairLength.record.text, repairLength.requests], [second, ['pe_answer_continue']]);
const tooShort = await managedResearch([reply('length', ''), reply('length', '')]);
assert.deepEqual([tooShort.record.status, tooShort.record.text, tooShort.requests], ['failed', '', ['pe_answer_continue']]);
const shortAnswer = '我先分析结果：原模型每股129元，情景每股142元。本轮维持原预测。';
const short = await scenario([shortAnswer], [allowed]);
assert.equal(short.calls, 1);
assert.equal(short.result.content[0].text, shortAnswer);

for (const isError of [false, true]) {
  let audits = 0;
  const messages = [user, call('workbook_query', 'past'), {
    role: 'toolResult', toolCallId: 'past', toolName: 'workbook_query', isError,
    content: [{ type: 'text', text: '上一轮工具结果' }],
  }, { role: 'user', content: '你好' }];
  const guarded = guardResearchDelivery(scriptedProvider([reply('stop', '你好。')]), {
    audit: async () => { audits++; return allowed; },
  });
  assert.equal((await (await guarded({}, { messages }, {})).result()).content[0].text, '你好。');
  assert.equal(audits, 0, 'past workbook tools must not turn a greeting into research');
}

const historical = [user, call('workbook_query', 'old'), {
  role: 'toolResult', toolName: 'workbook_query', toolCallId: 'old', isError: false,
  content: [{ type: 'text', text: '旧回合原始工具数据' }],
}];
const concise = await managedResearch([reply('stop', first)], () => allowed, historical);
assert.equal(concise.record.text, first);
console.log('PASS managed research length, empty drafts, split-claim audit, internal repairs and concise answers');

const originalMessages = [user];
const auditedQuestions = [];
let callsInTurn = 0;
const retry = guardResearchDelivery(() => {
  callsInTurn++;
  return scriptedProvider([reply('stop', badSentence)])();
}, {
  getSessionMessages: () => originalMessages,
  audit: async (_provider, _model, context) => {
    auditedQuestions.push(context.messages.filter(m => m.role === 'user').at(-1).content);
    return denied(badSentence);
  },
});
const normalized = () => ({ messages: originalMessages.map(m =>
  m.role === 'custom' ? { role: 'user', content: m.content } : m) });
await (await retry({}, normalized(), {})).result();
assert.equal(callsInTurn, 3, 'initial and two targeted repair attempts');
originalMessages.push({ role: 'custom', customType: 'pe_answer_correct', content: '内部修订' });
await (await retry({}, normalized(), {})).result();
assert.equal(callsInTurn, 4, 'internal correction does not replenish the two research repairs');
originalMessages.push({ role: 'user', content: '请重新解读估值模型。' });
await (await retry({}, normalized(), {})).result();
assert.equal(callsInTurn, 7, 'new actual user turn restores the two repairs');
assert.deepEqual([...new Set(auditedQuestions)], [user.content, '请重新解读估值模型。']);
const failedThenCorrected = [...pending, { role: 'custom', customType: 'pe_answer_correct', content: '再次回答' }];
const guardedReceipt = guardResearchDelivery(scriptedProvider([reply('stop', valid), reply('stop', valid)]), {
  getSessionMessages: () => failedThenCorrected, audit: async () => allowed,
});
const receiptResult = await (await guardedReceipt({}, { messages: failedThenCorrected.map(m =>
  m.role === 'custom' ? { role: 'user', content: m.content } : m) }, {})).result();
assert.match(receiptResult.content[0].text, /文件尚未保存：exports\/analysis.md/);
console.log('PASS managed internal prompts retain audit allowance, actual user question and report receipts');
