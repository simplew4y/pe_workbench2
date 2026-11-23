import assert from "node:assert/strict";
import { fitContextMessages, assessContextBudget } from "../lib/context-budget.mjs";
import { test } from "node:test";
import { createUpdateModelTool } from "../lib/tracking-tool.mjs";
import { modelChangesHTML } from "../ui/approvals/model-change.js";
import { researchRecoveryToolEvidence } from "../lib/research-delivery.mjs";

test("submission requires page bodies for the archived version, with unreadable pages identified", async () => {
  const messages = [], sha256 = "a".repeat(64);
  const preview = {previewId:"abc",source:"uploads/report.pdf",sha256};
  let submitted = 0;
  const tool = createUpdateModelTool(async args => args.previewId ? {submitted:++submitted} : {...preview}, {
    messages:() => messages, store:{findMaterialByPath:() => ({id:"m"})}, pdfs:{outline:async () => ({pages:3,sha256})}
  });
  const p = await tool.execute("preview", {});
  assert.equal(p.details.disclosureReview.nextRead.page, "1-3");
  messages.push({role:"toolResult",toolName:"update_model",...p});
  const read = (mode, pages, content, sha = sha256) => messages.push({role:"toolResult",toolName:"pdf_read",
    details:{mode, fullPageBatch:mode === "pages", sha256:sha, pages, evidence:content.map(([page,text,scanned,ocr])=>({page,text,scanned,ocr}))}});
  read("pages",[1],[[1,"正文"],[2,"不在实际返回页中"]]);
  read("search",[2],[[2,"摘录"]]);
  read("pages",[3],[[3,"旧版"]],"old");
  await assert.rejects(tool.execute("submit",{previewId:"abc"}), /2-3/);
  assert.equal(submitted,0);
  read("pages",[2,3],[[2,"",true],[3,"OCR 正文",true,true]]);
  const result = await tool.execute("submit",{previewId:"abc"});
  assert.deepEqual(result.details.disclosureReview,{pageCount:3,pagesRead:2,unreadablePages:[2],ocrPages:[3]});
  assert.equal(submitted,1);
});

test("approval prose shows business units, exact location, empty cells, percentages and source pages", () => {
  const row = {sheet:"损益",cell:"C4",period:"3Q26",metric:"Revenue",unit:"RMB mn"};
  const base = {ref:"损益!C4",metric:"Revenue",from:10000,to:12000,source:"uploads/a.pdf#page=9",bindingVerified:true};
  const pct = {sheet:"损益",cell:"C5",metric:"毛利率",unit:"%",storageScale:.01};
  const html = modelChangesHTML({actuals:[row,pct], changes:[base,{...base,ref:"损益!C5",from:null,to:.25},
    {...base,ref:"损益!C6",metric:"<自定义>",from:7,to:"=C4-C5"}]}, {status:"pending_approval"});
  for (const text of ["营业收入","公司销售商品","2026 年第 3 季度","100亿元","120亿元","第 4 行，C 列","公告第 9 页","新增 25%","拟改用公式计算","&lt;自定义&gt;"]) assert.ok(html.includes(text),text);
  assert.ok(!html.includes("<自定义>"));
});

test("answer recovery retains the successful approval receipt beside an earlier failed attempt", () => {
  const approval = {id:"apr-example",status:"pending_approval"};
  const message = (id,isError,text,details) => ({role:"toolResult",toolName:"update_model",toolCallId:id,isError,content:[{type:"text",text}],details});
  const rows = researchRecoveryToolEvidence([{role:"user",content:[{type:"text",text:"更新模型并提交审批"}]},
    message("first",true,"缺少期间"),
    {...message("calc",false,"财务计算".repeat(860)),toolName:"calc"},
    message("second",false,"x".repeat(20000),{result:{writeback:{approval},modelChanges:[{}]}})],{maxChars:5000});
  assert.deepEqual(rows.find(r=>r.id==="second").receipt.approval,approval);
  const largeArgs = {outputs:Array.from({length:40}, (_, i)=>({sheet:"Model",cell:"A"+i,label:"估值核对项目".repeat(20)}))};
  const withArgs = researchRecoveryToolEvidence([{role:"user",content:"提交审批"},
    {role:"assistant",content:[{type:"toolCall",id:"second",name:"update_model",arguments:largeArgs}]},
    message("second",false,"x".repeat(1100),{result:{writeback:{approval},modelChanges:[{}]}})],{maxChars:5000});
  assert.deepEqual(withArgs.find(r=>r.id==="second").receipt.approval,approval);
});

test("the next model request gets complete PDF page bodies under context pressure", () => {
  const body = "页首" + "甲".repeat(2200) + "重述对期初利润的影响" + "乙".repeat(2200) + "页尾";
  const messages = [{role:"user",content:"通读公告"},
    {role:"toolResult",toolName:"workbook_query",toolCallId:"old",content:[{type:"text",text:"旧模型".repeat(5000)}]},
    {role:"assistant",content:[{type:"toolCall",name:"pdf_read",id:"p",arguments:{page:"5",mode:"pages"}}]},
    {role:"toolResult",toolName:"pdf_read",toolCallId:"p",content:[{type:"text",text:body}]}];
  const model = {contextWindow:8500,maxTokens:800};
  assert.equal(assessContextBudget(messages,model).ok,false);
  const fitted = fitContextMessages(messages,model);
  assert.equal(assessContextBudget(fitted,model).ok,true);
  assert.equal(fitted.at(-1).content[0].text,body);
});

test("disclosed EPS target, added formula and valuation multiple keep their own basis", () => {
  const a = {sheet:"Model",period:"FY2026",cell:"B2",metric:"Revenue",unit:"RMB mn"};
  const b = {...a,cell:"B3",metric:"Gross profit"};
  const eps = {...a,cell:"B5",metric:"EPS diluted",mode:"formula",unit:"RMB/share",expected:2.5};
  const data = {actuals:[a,b,eps],edits:[{sheet:"Model",cell:"B4",value:"=B2/B3"}],
    changes:[{ref:"Model!B2",from:8,to:10},{ref:"Model!B3",from:4,to:5},
      {ref:"Model!B4",metric:"覆盖倍数",from:1.8,to:"=B2/B3"},{ref:"Model!B5",from:null,to:"=B2/B3"}]};
  const html=modelChangesHTML(data,{rowLabels:{"Model!B4":"覆盖倍数"},percentRefs:[]});
  assert.match(html,/覆盖倍数/);
  assert.match(html,/原值 1.8，拟改用公式计算，按本提案输入为 2/);
  assert.doesNotMatch(html,/180%/);
  assert.match(html,/拟新增公式.*待核对值 2.5元\/股/);
});
