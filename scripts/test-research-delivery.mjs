import assert from "node:assert/strict";
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
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
assert.equal(rejected.requests,4);
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
 assert.equal(result.requests,2);assert.equal(result.audits,1);
 assert.equal(result.message.usage.input,2,'audit tokens must not inflate SDK context usage');
 assert.equal(result.message.researchUsage.input,5,'billing remains recorded separately');
 assert.equal(result.message.usage.totalTokens,5,'SDK context size is the last writer request, not cumulative billing');
 assert.equal(result.message.researchUsage.totalTokens,12);
}
const unsafe=await answerCase(capped,{draft:'无依据的结论已经完全证实',bad:true});
assert.equal(unsafe.requests,4);assert.doesNotMatch(JSON.stringify(unsafe.events),/无依据的结论已经完全证实/);
assert.match(unsafe.message.content[0].text,/证据不足/);
const stillCalls=await answerCase(capped,{tool:true});
assert.equal(stillCalls.requests,2);assert.equal(stillCalls.message.stopReason,'error','noncompliant provider cannot be marked complete');
for(const draft of ['已保存报告','已交付草稿','报告已保存到文件']) {
 assert.ok(answerIssues(draft,{written:false,previousPartial:new Map()}).length);
}
console.log('PASS report/answer separation: verified answer retained, cap disables tools, unsafe drafts hidden, bounded repairs and usage preserved');

async function scenario(drafts,verdicts) {
 let calls=0,audits=0;
 const provider=async()=>{
  const text=drafts[Math.min(calls++,drafts.length-1)];
  const message={role:'assistant',content:[{type:'text',text}],stopReason:'stop'};
  const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end();return stream;
 };
 const stream=await guardResearchDelivery(provider,{audit:async()=>verdicts[Math.min(audits++,verdicts.length-1)]})({}, {messages:[user]},{});
 for await(const e of stream){}
 return {calls,audits,result:await stream.result()};
}
const valid='模型利润率取决于售价、产品组合与成本。若售价下跌而单位成本未同步下降，利润率假设会承压；应观察成交价、成本与产品结构，现有资料不足以确定具体阈值。';
const outage={ok:false,status:'unavailable',issues:[{check:'audit',reason:'后台证据核验结果不完整，不能据此认定通过'}]};
const preserved=await scenario([valid],[outage]);
assert.equal(preserved.calls,2);assert.match(preserved.result.content[0].text,/模型利润率取决于售价/);
assert.doesNotMatch(preserved.result.content[0].text,/核验结果不完整|本轮分析未完成/);
const progress=await scenario(['我先重新梳理',valid],[{ok:true,issues:[]}]);
assert.equal(progress.calls,2);assert.equal(progress.audits,1);assert.match(progress.result.content[0].text,/应观察成交价/);
const badSentence='良率低于62%必然失效。';
const scoped=await scenario([valid+'\n\n'+badSentence],[{ok:false,issues:[{check:'threshold_provenance',excerpt:badSentence,reason:'缺少阈值推导依据，具体失效门槛无法确定。'}]}]);
assert.equal(scoped.calls,4);assert.match(scoped.result.content[0].text,/应观察成交价/);assert.doesNotMatch(scoped.result.content[0].text,/62%必然/);
const saved=await scenario(['报告已保存。\n\n'+valid],[outage]);
assert.match(saved.result.content[0].text,/应观察成交价/);assert.doesNotMatch(saved.result.content[0].text,/报告已保存/);
for(const sentence of ['报告没有成功保存。','我将把报告保存到文件。','不能声称报告已保存。','报告未保存，下面直接回答。']) assert.deepEqual(answerIssues(sentence,{written:false,previousPartial:new Map()}),[],sentence);
const carried=await scenario([badSentence+'\n\n'+valid],[{ok:false,issues:[{check:'threshold_provenance',excerpt:badSentence,reason:'缺少阈值推导依据。'}]},outage]);
assert.doesNotMatch(carried.result.content[0].text,/62%必然/);assert.match(carried.result.content[0].text,/应观察成交价/);
console.log('PASS usable delivery: audit outage keeps answer, specific errors stay local, progress-only repaired, known errors survive reviewer outage');

const adjacent=await scenario([badSentence+valid],[{ok:false,issues:[{check:'threshold_provenance',excerpt:badSentence,reason:'具体阈值缺少依据。'}]}]);
assert.match(adjacent.result.content[0].text,/模型利润率取决于售价/,'a complete bad sentence must not erase the following good sentence');
assert.doesNotMatch(adjacent.result.content[0].text,/62%必然/);
