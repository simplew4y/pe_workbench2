import assert from "node:assert/strict";
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {guardResearchDelivery} from "../lib/research-delivery.mjs";

const path = "exports/analysis.md";
const user = {role:"user", content:"请解读估值模型"};
function call(name, id) {
  return {role:"assistant",content:[{type:"toolCall",name,id,arguments:{path}}]};
}
const failure = {role:"toolResult",toolCallId:"r",toolName:"review_research",isError:true,
  content:[{type:"text",text:"期间不匹配"}]};
const pending = [user, call("review_research","r"), failure];
const text = {type:"text",text:"已交付草稿，预计收益 999%"};
async function run(messages, second) {
  let requests = 0;
  const provider = async () => {
    const content = ++requests === 2 && second ? second : [text];
    const message = {role:"assistant",timestamp:Date.now(),content,
      stopReason:content.some(p=>p.type==="toolCall")?"toolUse":"stop"};
    const stream = createAssistantMessageEventStream();
    stream.push({type:"text_delta",delta:text.text,partial:message,contentIndex:0});
    stream.push({type:"done",reason:message.stopReason,message});
    stream.end();
    return stream;
  };
  const result = await guardResearchDelivery(provider)({}, {messages}, {});
  const events = [];
  for await (const e of result) events.push(e);
  return {requests,events,final:await result.result()};
}
const rejected = await run(pending);
assert.equal(rejected.requests,2);
assert.doesNotMatch(JSON.stringify(rejected.events),/999%/);
assert.match(rejected.final.content[0].text,/尚未交付/);
const repair = await run(pending,[text,...call("review_research","retry").content]);
assert.equal(repair.final.content[0].id,"retry");
assert.doesNotMatch(JSON.stringify(repair.events),/999%/);
const receipt = {role:"toolResult",toolCallId:"w",isError:false,
  content:[{type:"text",text:"[research_write_verified] exports/analysis.md sha256=test"}]};
for (const messages of [[...pending,user],[...pending,call("write","w"),receipt]]) {
  const normal = await run(messages);
  assert.equal(normal.requests,1);
  assert.equal(normal.events[0].type,"text_delta");
}
console.log("PASS failed research delivery: no rejected draft in stream/history, one recovery attempt, tool calls preserved, turn reset and successful receipt");
