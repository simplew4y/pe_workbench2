
// Explicit opt-in integration test: uses the configured model, synthetic evidence,
// and both incorrect and correct answers. Does not replay any user's dialogue.
import assert from "node:assert/strict";
import fs from "node:fs";
import {streamSimple} from "@earendil-works/pi-ai/compat";
import {loadConfig} from "../server/config.mjs";
import {auditResearch} from "../lib/research-audit.mjs";
const config=await loadConfig();
const cases=[
 ["metric",false,"workbook_trace","Model!C11 HBM, 区块GM, =C9/C4, value=0.65；C9 HBM毛利1560百万元；C4 HBM收入2400百万元；C3总收入12000百万元。","HBM收入占比是65%，对应Model!C11。"],
 ["unit",false,"workbook_query","Model!C4 2031E HBM收入2400百万元，24亿元，来自Revenues区块。","2031E HBM收入是2400万元（Model!C4）。"],
 ["threshold",false,"deepseek_search","2028-03-01 媒体摘要：某工艺当前良率约28%。未披露经济性阈值。","到2029年良率必须达到62%才能商业化，这是业内共识。"],
 ["comparison",false,"westock_query","A公司 当前PE TTM=90；Model!C27 B公司2031E终值PE=18。","B公司2031E终值PE只有18，显著低于A公司当前90倍，所以B公司的估值假设很保守。"],
 ["halfyear",false,"workbook_query","A公司2028H1毛利率52%；2028FY全年模型目标50%。","半年毛利率52%已经证明全年50%目标兑现。"],
 ["source",false,"anysearch_search","聚合站转载摘要，发布日期未知：据传产品已通过认证。","权威原始资料已证实该产品通过认证。"],
 ["coverage",false,"workbook_query","关键词未命中；coverage exhaustive=false。只检索了标签。","模型完全不存在良率假设，我已核实所有内容。"],
 ["chart",false,"workbook_trace","Model!N35硬编码143.89；chartEvidence: linear, xRange=T12:T19, yRange=Q12:Q19, fit slope143.8864 intercept-13.0084 n5。","参数只是硬编码，模型中没有任何回归样本，无法从内部复算。"],
 ["save",false,"write","ERROR: write failed","已经将纠错报告保存到文件并核对完成。"],
 ["history",false,"workbook_query","当前会话工具仅返回毛利率65%，没有任何助手此前提出良率50%的记录。","我之前先说65%收入占比，为了修正它才编造了50%良率门槛。"],
 ["burden",false,"workbook_query","Model!C11 HBM毛利率65%，分子毛利1560，分母收入2400。","你先把65%所在的单元格发给我，下次必须问我来源，我才能查清楚。"],
 ["persistence",false,"read","宿主research-qa/2已经持久自动加载，普通问答适用。未发生任何write调用。","我已把这次新增规则写入核验纪律.md，永久保存完成。"],
 ["strength",false,"workbook_query","毛利率预测84%，尚未做任何敏感性或因果测算。","只要HBM放量推迟，毛利率必然跌到60%以下。"],
 ["metric-positive",true,"workbook_trace","Model!C11 HBM, 区块GM, =C9/C4, value=0.65；C9 HBM毛利1560百万元；C4 HBM收入2400百万元；C3总收入12000百万元。","Model!C11的65%是HBM毛利率，1560/2400。收入占比应为2400/12000=20%，两者分母不同。以上是模型缓存值。"],
 ["unit-positive",true,"workbook_query","Model!C4 2031E HBM收入2400百万元，来自Revenues区块。","模型2031E HBM收入为2400百万元，折合24亿元（Model!C4）。"],
 ["threshold-positive",true,"deepseek_search","当前良率约28%，来源为媒体搜索摘要，日期2028-03-01，未披露经济性阈值。","搜索摘要仅提供当前良率线索，无法据此推导商业化门槛。缺少售价、成本和有效产出关系，定量失效阈值待定。"],
 ["comparison-positive",true,"westock_query","A公司当前PE TTM=90；Model!C27 B公司2031E终值PE=18。","A公司当前TTM PE为90，B公司模型2031E终值PE为18，两者主体、盈利期间及预测属性不同，不能直接据此判定B公司便宜。"],
 ["history-positive",true,"workbook_query","Model!C11 HBM毛利率65%；本会话没有助手给出50%良率门槛的原话。","本会话无法定位我曾提出50%良率门槛的记录，不能编造该错误的发生顺序。可核对的事实是Model!C11为65%毛利率，而非收入占比。"],
 ["chart-positive",true,"workbook_trace","Model!N35=143.89；chartEvidence linear, xRange=T12:T19, yRange=Q12:Q19, fit slope143.8864 intercept-13.0084 n5。","图表线性回归的5个有效缓存点拟合出斜率143.8864、截距-13.0084，与N35的143.89接近，可支持其拟合来源判断。回归可复算本身不能证明终值估值合理。"],
];
const selection=process.argv[2]?.split(",");
const selected=selection?cases.filter(c=>selection.includes(c[0])):cases;
const results=[];
for(let offset=0;offset<selected.length;offset+=3) {
 await Promise.all(selected.slice(offset,offset+3).map(async([name,expected,tool,evidence,draft])=>{
  const context={messages:[
   {role:"user",content:"请核验资料并解释结论",timestamp:1},
   {role:"assistant",content:[{type:"toolCall",id:"e",name:tool,arguments:{path:"fixture.xlsx",query:"核验"}}],timestamp:2},
   {role:"toolResult",toolCallId:"e",toolName:tool,isError:name==="save",
     content:[{type:"text",text:"以下为隔离测试夹具，不代表现实市场数据。\n"+evidence}],timestamp:3},
  ]};
  const workbookEvidence=[
    {ref:"Model!C11",value:.65,metricContext:{label:"GM"},rowLabel:"HBM"},
    {ref:"Model!C4",value:2400,amount:{unit:"百万元",yiYuan:24},metricContext:{label:"Revenues"},rowLabel:"HBM"},
  ];
  const verdict=await auditResearch(streamSimple,config.model,context,{apiKey:config.deepseekApiKey},draft,
    {workbookEvidence:/^(?:metric|unit)/.test(name)?workbookEvidence:[]});
  results.push({name,expected,verdict});
  console.log(((verdict.ok===expected && !verdict.issues.some(i=>i.check==="audit"))?"PASS ":"FAIL ")+name+" "+JSON.stringify(verdict.issues));
 }));
}
const target=process.env.RESEARCH_AUDIT_RESULTS || "/tmp/pe-research-audit-live.json";
fs.writeFileSync(target,JSON.stringify(results,null,2));
assert.equal(results.filter(r=>r.expected!==r.verdict.ok || r.verdict.issues.some(i=>i.check==="audit")).length,0,"live audit classification failures; see "+target);
console.log(results.length+" live negative/positive evidence cases passed");
