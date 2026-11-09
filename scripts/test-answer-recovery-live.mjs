// Opt-in: real final composition using a saved draft and injected audit outage.
// Does not write to a user project or replay market tools.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {streamSimple,createAssistantMessageEventStream} from '@earendil-works/pi-ai/compat';
import {loadConfig} from '../server/config.mjs';
import {guardResearchDelivery} from '../lib/research-delivery.mjs';
const input=process.argv[2],output=process.argv[3];
if(!input || !output)throw new Error('Provide input draft and output Markdown paths');
const config=await loadConfig(),draft=fs.readFileSync(input,'utf8');
let calls=0;
const provider=async(model,context,options)=>{
 if(calls++)return streamSimple(model,context,options);
 const message={role:'assistant',api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),content:[{type:'text',text:draft}],stopReason:'stop',usage:{input:0,output:0,totalTokens:0,cost:{}}};
 const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end();return stream;
};
const historyFile=process.argv[4];
const history=historyFile?fs.readFileSync(historyFile,'utf8').split('\n').filter(Boolean).map(line=>JSON.parse(line))
 .filter(row=>row.type==='message' && row.timestamp<'2026-11-05T08:53:00').map(row=>row.message):[];
const context={systemPrompt:'当前任务是继续已有研究，用户已上传资料并已取得工具结果。历史资料和当前草稿在上下文中；直接修订现有分析，不要求用户重新提供已有文件。',messages:[...history,{role:'user',content:'所有这些关键假设，你要用各种方法去验证假设是否合理，在什么情况或条件之下会失效，有什么信号标志假设失效了，等等这些问题',timestamp:Date.now()}]};
const result=await guardResearchDelivery(provider,{audit:async()=>({ok:false,status:'unavailable',issues:[{check:'audit',reason:'后台证据核验结果不完整，不能据此认定通过'}]})})(config.model,context,{apiKey:config.deepseekApiKey,maxTokens:4000,signal:AbortSignal.timeout(180000)});
for await(const event of result){}
const message=await result.result();
assert.equal(message.stopReason,'stop',message.errorMessage);
const text=message.content.filter(p=>p.type==='text').map(p=>p.text).join('\n');
fs.writeFileSync(output,text);
assert.ok(text.length>500);assert.match(text,/HBM/);assert.match(text,/毛利率/);assert.doesNotMatch(text,/没有可访问的工作区文件|需要至少提供|工作区还没有文件/);assert.match(text,/失效/);assert.match(text,/信号|观察/);
assert.doesNotMatch(text,/本轮分析未完成证据核验|后台证据核验结果不完整|选一个|可直接用|已被证实成立|你倾向/);
console.log('PASS real audit-outage recovery: substantive readable answer, no internal error or workflow handoff; '+text.length+' chars; '+output);
