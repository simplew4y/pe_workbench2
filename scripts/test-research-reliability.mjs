
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createAssistantMessageEventStream} from "@earendil-works/pi-ai";
import {AUDIT_CHECKS,parseAudit,evidenceTimeline,auditResearch,deterministicEvidenceIssues,researchContext} from "../lib/research-audit.mjs";
import {guardResearchDelivery} from "../lib/research-delivery.mjs";
import {createResearchReview,reviewClaims} from "../lib/research-review.mjs";
import {queryGraph,formatResult} from "../lib/workbook-query.mjs";

let count=0;
async function test(name,fn){await fn();console.log("PASS "+name);count++;}
const pass={checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,"pass"])),issues:[]};
function stream(text,stopReason="stop"){
  const message={role:"assistant",content:[{type:"text",text}],stopReason,usage:{input:10,output:5,totalTokens:15,cost:{total:0.1}}};
  const s=createAssistantMessageEventStream();
  s.push({type:"text_delta",delta:text,partial:message,contentIndex:0});
  s.push({type:stopReason==="error"?"error":"done",reason:stopReason,message,error:message});s.end();return s;
}
const bad="必须在2028年达到62%良率才能兑现收入。";
const failed={checks:{...pass.checks,threshold_provenance:"fail"},
 issues:[{check:"threshold_provenance",excerpt:"62%良率",reason:"当前良率不能推导商业化门槛，缺少适用条件及公式"}]};
await test("审校协议缺字段、伪造摘录、错误状态和空结果均拒绝",()=>{
 assert.equal(parseAudit(JSON.stringify(pass),"普通说明").ok,true);
 for(const x of [{},{...pass,checks:{}},{...failed,issues:[]},
   {...failed,issues:[{...failed.issues[0],excerpt:"不在草稿中"}]}])
   assert.equal(parseAudit(JSON.stringify(x),bad).ok,false);
 assert.equal(parseAudit("garbage",bad).ok,false);
 assert.equal(parseAudit(JSON.stringify(failed),bad).ok,false);
});
await test("审校不可调用工具，错误及截断响应不视作通过",async()=>{
 let captured;
 const provider=(_m,c)=>{captured=c;return stream(JSON.stringify(pass));};
 const r=await auditResearch(provider,{}, {messages:[{role:"user",content:"核验模型"}]}, {}, "数据不足");
 assert.equal(r.ok,true);assert.deepEqual(captured.tools,[]);
 assert.equal((await auditResearch(()=>stream("","error"),{}, {messages:[]},{},bad)).ok,false);
});
await test("历史时间线保留作者、顺序、失败状态及工具参数",()=>{
 const t=evidenceTimeline([{role:"user",content:"你说过50%"},{role:"assistant",content:[{type:"text",text:"来源待核实"}]},
 {role:"toolResult",toolCallId:"f",toolName:"edit",isError:true,content:[{type:"text",text:"not found"}]}]);
 assert.equal(t[0].role,"user");assert.equal(t[1].text,"来源待核实");assert.equal(t[2].isError,true);assert.equal(t[2].index,2);
});
await test("不依赖关键词技能，首轮研究答复先审校再发布，错误文本不泄漏",async()=>{
 let calls=0,audits=0;
 const provider=()=>stream(++calls===1?bad:"无法由当前良率推导商业化阈值。");
 const audit=async(_p,_m,_c,_o,draft)=>{audits++;return draft===bad?{ok:false,issues:failed.issues}:{ok:true,issues:[]};};
 const result=await guardResearchDelivery(provider,{audit})({}, {messages:[{role:"user",content:"分析模型假设"}]}, {});
 const events=[];for await(const event of result)events.push(event);
 assert.equal(calls,2);assert.equal(audits,2);
 assert.doesNotMatch(JSON.stringify(events),/62%/);
 assert.match((await result.result()).content[0].text,/无法.*推导/);
});
await test("审校连续失败时有限重试，草稿不会发布或入历史",async()=>{
 let n=0;
 const result=await guardResearchDelivery(()=>{n++;return stream(bad);},{audit:async()=>({ok:false,issues:failed.issues})})(
 {},{messages:[{role:"user",content:"检查估值"}]},{});
 const events=[];for await(const e of result)events.push(e);
 assert.equal(n,4);assert.doesNotMatch(JSON.stringify(events),/62%/);
 assert.match((await result.result()).content[0].text,/尚缺推导依据/);
});
await test("非研究聊天保留普通流式输出",async()=>{
 const result=await guardResearchDelivery(()=>stream("你好"),{audit:async()=>{throw new Error("must not audit");}})(
 {},{messages:[{role:"user",content:"你好"}]},{});
 const events=[];for await(const e of result)events.push(e);
 assert.equal(events[0].type,"text_delta");
});
const labels={1:"Rmb m",3:"Revenues",4:"HBM",5:"LPDDR4X",6:"Mix",7:"HBM",8:"Gross profits",9:"HBM",10:"GM",11:"HBM",13:"ASP (US$ / GB)"};
const specs=[[3,12000],[4,2400],[5,400],[6,.3],[7,.2],[8,8000],[9,1560],[10,.6],[11,.65],[13,9.12]];
const graph={sheets:[{name:"Model",rowLabels:labels}],cells:specs.map(([r,v])=>[
 "Model!C"+r,null,v,r,3,labels[r],"2031E","B"+r,"2031E"]),edges:[]};
await test("产品明细继承金额单位，毛利率、收入构成和ASP不继承",()=>{
 const cell=r=>queryGraph(graph,"Model!C"+r,{maxCells:1}).cells[0];
 assert.equal(cell(4).amount.yiYuan,24);assert.equal(cell(5).amount.yiYuan,4);
 assert.equal(cell(9).amount.yiYuan,15.6);
 for(const r of [7,11,13])assert.equal(cell(r).amount,null);
 assert.equal(cell(11).metricContext.label,"GM");
 assert.match(formatResult(queryGraph(graph,"65%")),/Model!C11/);
 assert.doesNotMatch(formatResult(queryGraph(graph,"65%")),/Model!C4/);
});
const root=fs.mkdtempSync(path.join(os.tmpdir(),"research-full-"));
const store={findMaterialByPath:()=>({id:"m"})};
const workbooks={queryMaterial:async(_id,ref)=>queryGraph(graph,ref,{maxCells:1})};
try {
 fs.mkdirSync(path.join(root,"exports"));
 await test("报告金额单位不符被拒绝，产品型号不会被当作未核验数字",async()=>{
  const base={id:"x",kind:"cell",file:"uploads/model.xlsx",ref:"Model!C4",value:2400,valueText:"2400",
   unit:"百万元",period:"2031E",text:"2031E HBM 2400 百万元（Model!C4）"};
  assert.equal((await reviewClaims({content:base.text+"\nLPDDR4X 与 LPDDR5X 产品分别核验。",claims:[base],store,workbooks})).ok,true);
  assert.equal((await reviewClaims({content:base.text.replace("百万元","万元"),claims:[{...base,unit:"万元",text:base.text.replace("百万元","万元")}],store,workbooks})).ok,false);
  assert.equal((await reviewClaims({content:base.text+"\n未经核验的收益99%",claims:[base],store,workbooks})).ok,false);
 });
 await test("普通文件编辑需读取当前版本，匹配失败及并发改动后必须重读",()=>{
  const guard=createResearchReview({ctx:{root,store,workbooks}});
  const args={path:"notes.txt",oldText:"old",newText:"new"};
  fs.writeFileSync(path.join(root,args.path),"old");
  assert.equal(guard.before("edit",args).block,true);
  guard.record({toolCall:{name:"read",id:"r"},args,result:{content:[]}});
  assert.equal(guard.before("edit",args),undefined);
  guard.record({toolCall:{name:"edit"},args,result:{isError:true}});
  assert.equal(guard.before("edit",args).block,true);
  guard.record({toolCall:{name:"read",id:"r2"},args,result:{content:[]}});
  fs.writeFileSync(path.join(root,args.path),"changed");
  assert.equal(guard.before("edit",args).block,true);
 });
 await test("语义审校同时保护报告，关联旧报告送审且并发变更阻止保存",async()=>{
  const guard=createResearchReview({ctx:{root,store,workbooks}});
  fs.writeFileSync(path.join(root,"exports/old.md"),"HBM占营收的大约三分之二。");
  let extra;
  guard.setAuditor(async(_content,e)=>{extra=e;return {ok:false,issues:[{reason:"关联报告仍含同一错误的改写"}]};});
  const args={path:"exports/new.md",file:"uploads/model.xlsx",content:"收入 {{Model!C4}}"};
  assert.equal((await guard.tool.execute("a",args)).isError,true);
  assert.match(extra.relatedReports[0].content,/三分之二/);
  guard.setAuditor(async()=>({ok:true,issues:[]}));
  const r=await guard.tool.execute("a",args);assert.equal(r.isError,false);
  const write={path:args.path,content:"收入 2031E Revenues / HBM 2400 百万元 （Model!C4）"};
  assert.equal(guard.before("write",write),undefined,"unchanged related reports allow exact approved content");
  assert.equal((await guard.tool.execute("b",args)).isError,false);
  fs.writeFileSync(path.join(root,"exports/old.md"),"concurrent change");
  assert.equal(guard.before("write",write).block,true,"same content now denied due to changed sibling");
 });
 await test("搜索摘要不得升级为权威阈值证据",async()=>{
  const source={id:"s",kind:"source",evidenceId:"search",quote:"CXMT 2028商业化阈值62%",locator:"https://example.test",
    entity:"CXMT",period:"2028",metric:"商业化阈值",unit:"ratio",value:.62,valueText:"62%",text:"官方确认 CXMT 2028商业化阈值62%"};
  const result=await reviewClaims({content:source.text,claims:[source],store,workbooks,
    evidence:new Map([["search",{text:source.quote+" "+source.locator,kind:"search_lead"}]])});
  assert.equal(result.ok,false);assert.ok(result.errors.some(e=>e.includes("搜索摘要")));
 });
} finally {fs.rmSync(root,{recursive:true,force:true});}


await test("百分数方向矛盾与已存在公式路径的否定由直接证据拦截",()=>{
 assert.ok(deterministicEvidenceIssues("65%远高于整体84.5%。",[]).length);
 assert.equal(deterministicEvidenceIssues("65%低于整体84.5%。",[]).length,0);
 const timeline=[{role:"toolResult",text:'chartEvidence xRange=T12:T19 downstreamPaths N35 -> N38 -> H27'}];
 assert.ok(deterministicEvidenceIssues("与趋势线的斜率和截距没有直接挂接。",timeline).length);
 assert.equal(deterministicEvidenceIssues("系数经N38用于H27估值。",timeline).length,0);
});


await test("原表结构化证据直接识别指标混淆、金额单位及动机臆测",()=>{
 const cells=[{ref:"Model!C11",value:.65,metricContext:{label:"GM"}},
   {ref:"Model!C4",value:2400,amount:{unit:"百万元"}}];
 assert.ok(deterministicEvidenceIssues("HBM收入占比是65%（Model!C11）。",[],cells).some(i=>i.check==="metric_meaning"));
 assert.ok(deterministicEvidenceIssues("HBM为**2400**万元（Model!C4）。",[],cells).some(i=>i.check==="numeric_units"));
 assert.equal(deterministicEvidenceIssues("HBM为2400百万元，折合24亿元（Model!C4）。",[],cells).length,0);
 assert.ok(deterministicEvidenceIssues("作者其实想要这个估值才回填系数。",[]).length);
});

await test("标准Gb到GB换算常数允许，任意阈值及错误换算不豁免",async()=>{
 const run=content=>reviewClaims({content,claims:[],store,workbooks});
 assert.equal((await run("Gb→GB 换算除以 8。")).ok,true);
 assert.equal((await run("Gb→GB 换算除以 80。")).ok,false);
 assert.equal((await run("Gb→GB 换算除以 8，良率门槛50%。")).ok,false);
});

await test("连续报告失败停止工具重试，但仍交付经过核验的答复",async()=>{
 const messages=[{role:"user",content:"保存研究报告"}];
 for(let i=0;i<6;i++){
  messages.push({role:"assistant",content:[{type:"toolCall",id:"r"+i,name:"review_research",arguments:{path:"exports/report.md"}}]});
  messages.push({role:"toolResult",toolCallId:"r"+i,isError:true,content:[{type:"text",text:"校验失败"}]});
 }
 let calls=0;
 const result=await guardResearchDelivery((_model,context)=>{
  calls++;assert.deepEqual(context.tools,[]);
  return stream("模型假设仍待外部证据验证，失效信号应结合价格和成本变化观察，不能直接编造定量门槛。");
 },{audit:async()=>({ok:true,issues:[]})})({}, {messages},{});
 for await(const e of result){}
 assert.equal(calls,2);
 assert.match((await result.result()).content.map(p=>p.text).join("\n"),/模型假设仍待外部证据验证[\s\S]*尚未保存/);
});
console.log("Research reliability: "+count+" scenarios passed");

await test('审校格式差异不误拒，部分协议错误保留有效意见，异常状态可区分',()=>{
 const draft='模型毛利率 **84.2%**（2026 年）。';
 const verdict={checks:{...pass.checks,numeric_units:'fail'},issues:[{check:'numeric_units',excerpt:'模型毛利率 84.2%(2026年)',reason:'测试定位'}]};
 const result=parseAudit(JSON.stringify(verdict),draft);
 assert.equal(result.status,'reviewed');assert.equal(result.issues[0].excerpt,'模型毛利率 **84.2%**（2026 年）');
 verdict.issues.push({check:'numeric_units',excerpt:'不存在的句子',reason:'无效条目'});
 const mixed=parseAudit(JSON.stringify(verdict),draft);
 assert.equal(mixed.status,'unavailable');assert.ok(mixed.issues.some(i=>i.excerpt===result.issues[0].excerpt));
 assert.equal(parseAudit('invalid',draft).status,'unavailable');
});

await test('历史报告草稿与实际证据分离，当前修复草稿保留',()=>{
 const call={role:'assistant',content:[{type:'toolCall',id:'r',name:'review_research',arguments:{path:'exports/r.md',content:'虚构的历史草稿',claims:[{text:'伪事实'}]}}]};
 const tool={role:'toolResult',toolCallId:'real',toolName:'workbook_query',content:[{type:'text',text:'原始模型证据'}]};
 const context={messages:[call,tool,{role:'user',content:'继续核验'},call]};
 const clean=researchContext(context);
 assert.equal(clean.messages[0].content[0].arguments.content,undefined);
 assert.equal(clean.messages[1],tool);assert.equal(clean.messages[3],call);
 assert.equal(context.messages[0].content[0].arguments.content,'虚构的历史草稿','history is not mutated');
 const audit=evidenceTimeline(context.messages);
 assert.equal(audit[0].calls[0].arguments.content,undefined);
 assert.equal(audit[1].text,'原始模型证据');
});
