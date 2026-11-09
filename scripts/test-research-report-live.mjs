// Opt-in paid-model integration. All evidence is synthetic; writes are isolated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Value} from 'typebox/value';
import {streamSimple} from '@earendil-works/pi-ai/compat';
import {loadConfig} from '../server/config.mjs';
import {createResearchReview} from '../lib/research-review.mjs';
import {guardResearchDelivery} from '../lib/research-delivery.mjs';
import {auditResearch} from '../lib/research-audit.mjs';
import {RESEARCH_POLICY} from '../lib/research-policy.mjs';
const config=await loadConfig();
const assistantMeta={api:config.model.api,provider:config.model.provider,model:config.model.id,usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-report-live-'));
const options={apiKey:config.deepseekApiKey,maxTokens:3500,signal:AbortSignal.timeout(240000)};
const fixture='以下全部是测试夹具，不代表现实公司。\nhttps://example.test/fixture\n测试甲公司2026年经营资料\n公司营业利润率为70%。\n口径：全年实际营业利润除以营业收入；仅为公司披露，未经独立验证。';
const messages=[
 {role:'user',content:'请核验这份材料中的营业利润率，说明适用边界和需要观察的失效信号，保存简短报告到exports/source.md。',timestamp:1},
 {...assistantMeta,role:'assistant',content:[{type:'toolCall',id:'fixture-source',name:'deepseek_fetch',arguments:{url:'https://example.test/fixture'}}],stopReason:'toolUse',timestamp:2},
 {role:'toolResult',toolCallId:'fixture-source',toolName:'deepseek_fetch',isError:false,content:[{type:'text',text:fixture+'\n[research_evidence_id] fixture-source'}],timestamp:3}
];
const ctx={root,store:{findMaterialByPath:()=>null},workbooks:{queryMaterial:()=>{throw new Error('no workbook in fixture');}}};
const review=createResearchReview({ctx});
const guarded=guardResearchDelivery(streamSimple,{onContext:(model,context,opts)=>{
 review.restoreEvidence(context.messages);
 review.setAuditor((draft,extra)=>auditResearch(streamSimple,model,context,opts,draft,extra));
}});
async function collect(stream){for await(const e of stream){}return stream.result();}
let reviews=0,failures=0;
try {
 fs.mkdirSync(path.join(root,'exports'));
 for(let step=0;step<5;step++){
  const context={systemPrompt:'这是隔离回归测试。只使用已给出的虚构材料，不查询现实行情。\n'+RESEARCH_POLICY,tools:[review.tool,{name:'deepseek_fetch',description:'读取测试材料，返回同一隔离夹具',parameters:{type:'object',properties:{url:{type:'string'}},required:['url']}}],messages};
  const answer=await collect(await guarded(config.model,context,options));
  assert.equal(['error','aborted'].includes(answer.stopReason),false,answer.errorMessage || answer.stopReason);
  messages.push(answer);
  const calls=answer.content.filter(p=>p.type==='toolCall');
  if(!calls.length) break;
  for(const call of calls){
   if(call.name==='deepseek_fetch') {
    assert.equal(call.arguments.url,'https://example.test/fixture');
    messages.push({role:'toolResult',toolCallId:call.id,toolName:call.name,isError:false,content:[{type:'text',text:fixture+'\n[research_evidence_id] '+call.id}],timestamp:Date.now()});
    continue;
   }
   assert.equal(call.name,'review_research');reviews++;
   assert.equal(Value.Check(review.tool.parameters,call.arguments),true,'model produced invalid source contract');
   const result=await review.tool.execute(call.id,call.arguments,options.signal,undefined,{executeTool:async(name,args)=>{
    assert.equal(name,'write');fs.mkdirSync(path.dirname(path.join(root,args.path)),{recursive:true});
    fs.writeFileSync(path.join(root,args.path),args.content);return {result:{content:[]}};
   }});
   if(result.isError) {failures++;console.log('REVIEW_REPAIR',JSON.stringify(result.details?.errors || result.content));}
   messages.push({role:'toolResult',toolCallId:call.id,toolName:call.name,isError:!!result.isError,content:result.content,timestamp:Date.now()});
  }
 }
 const report=path.join(root,'exports/source.md');
 assert.ok(fs.existsSync(report),'report was not saved');
 const body=fs.readFileSync(report,'utf8');
 assert.match(body,/70%/);assert.match(body,/未经|未独立|未经过|来源披露|公司披露/);
 assert.ok(reviews<6,'review limit exhausted');
 console.log('PASS live source report: validated model arguments, independent audit, saved/read back; reviews='+reviews+', failures='+failures);
 const capped=messages.slice(0,3);
 for(let i=0;i<6;i++)capped.push(
  {...assistantMeta,role:'assistant',content:[{type:'toolCall',id:'r'+i,name:'review_research',arguments:{path:'exports/failed.md'}}],stopReason:'toolUse',timestamp:4+i*2},
  {role:'toolResult',toolCallId:'r'+i,toolName:'review_research',isError:true,content:[{type:'text',text:'缺少引用，未保存'}],timestamp:5+i*2}
 );
 const fallback=await collect(await guarded(config.model,{systemPrompt:RESEARCH_POLICY,messages:capped,tools:[review.tool]},options));
 assert.equal(fallback.stopReason,'stop',fallback.errorMessage);
 assert.ok(fallback.content.every(p=>p.type==='text'));
 const answer=fallback.content.map(p=>p.text).join('\n');
 assert.match(answer,/尚未保存/);assert.match(answer,/70%/);
 assert.doesNotMatch(answer,/本轮分析未完成证据核验/);
 console.log('PASS live exhausted review: no more tools, substantive audited answer retained with honest unsaved status');
} finally {fs.rmSync(root,{recursive:true,force:true});}
