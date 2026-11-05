
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {createResearchReview} from "../lib/research-review.mjs";
import {queryGraph,formatResult} from "../lib/workbook-query.mjs";
import {traceGraph,formatTrace} from "../lib/workbook-trace.mjs";
const file=process.argv[2];
if(!file)throw new Error("Provide the regression workbook path");
const out=path.join(fs.mkdtempSync(path.join(os.tmpdir(),"research-model-")),"graph.json");
try {
 const p=spawnSync("python3",["services/workbook/parse_workbook.py",file,"--out",out],{encoding:"utf8"});
 assert.equal(p.status,0,p.stderr);
 const graph=JSON.parse(fs.readFileSync(out,"utf8"));
 const get=ref=>queryGraph(graph,ref,{maxCells:1}).cells[0];
 assert.equal(get("Discount PE!H33").value,1.49);
 assert.equal(queryGraph(graph,"Absent Sheet!H33").error,"reference_not_found");
 assert.equal(get("Assumption!AH13").amount.unit,"百万元");
 assert.equal(get("Assumption!AH13").amount.yiYuan,72.93);
 assert.equal(get("Assumption!AH37").amount.yiYuan,47.4045);
 assert.equal(get("Assumption!AH42").amount,null);
 assert.equal(get("Assumption!AH42").metricContext.label,"GM");
 assert.ok(queryGraph(graph,"HBM 65%",{maxCells:120}).cells.some(c=>c.ref==="Assumption!AH42"));
 assert.equal(get("Assumption!AH32").ratioEvidence.denominator.ref,"Assumption!AH7");
 assert.equal(get("Assumption!AH42").ratioEvidence.denominator.ref,"Assumption!AH13");
 assert.equal(get("Assumption!AD32").period,"4Q30E");
 assert.equal(get("Assumption!AD32").annualCounterpart.ref,"Assumption!AL32");
 assert.ok(Math.abs(get("Assumption!AL32").value-.268056379096)<1e-10);
 assert.equal(get("Discount PE!N35").rowLabel,"");
 assert.equal(get("Discount PE!G8").period,"2026E");
 assert.equal(get("Discount PE!R14").period,"2027");
 assert.equal(get("Discount PE!S14").period,"2028");
 assert.equal(get("Discount PE!T14").period,null);
 assert.equal(get("Discount PE!T14").header,"AVG");
 assert.equal(get("Capacity & capex!AJ4").value,270);
 assert.equal(get("Capacity & capex!AK4").value,318.75);
 assert.ok(Math.abs(get("PL!BE25").amount.yiYuan-7453.98925364665)<1e-8);
 assert.match(get("Assumption!AH122").rowLabel,/GB/);
 const chart=get("Discount PE!N35").chartEvidence[0];
 assert.equal(chart.xRange,"'Discount PE'!$T$12:$T$19");
 assert.equal(chart.yRange,"'Discount PE'!$Q$12:$Q$19");
 assert.equal(chart.fit.n,5);
 assert.equal(chart.leaveOneOut.length,5);
 const withoutHuaHong=chart.leaveOneOut.find(p=>p.excluded.endsWith("T18"));
 assert.ok(withoutHuaHong.rSquared<.1);
 assert.equal(withoutHuaHong.n,4);
 assert.equal(chart.xTitle,"2027-28E avg. NI YoY");
 assert.equal(chart.yTitle,"2027E P/E");
 assert.ok(chart.downstreamPaths.some(route=>route.at(-1).ref==="Discount PE!H29"));
 assert.ok(Math.abs(chart.fit.slope-143.8864059634)<1e-8);
 assert.ok(Math.abs(chart.fit.intercept+13.0084251416)<1e-8);
 assert.match(formatResult(queryGraph(graph,"Discount PE!N35")),/143.886405/);

 const root=path.dirname(out);
 fs.mkdirSync(path.join(root,"exports"));
 const review=createResearchReview({ctx:{root,
   store:{findMaterialByPath:p=>p==="uploads/model.xlsx"?{id:"m"}:null},
   workbooks:{queryMaterial:async(_id,ref)=>queryGraph(graph,ref,{maxCells:1})}}});
 const args={path:"exports/report.md",file:"uploads/model.xlsx",save:true,
   content:"# 2026 年 HBM 核验\n\n模型收入 {{Assumption!AH13}}。\n模型收入占比 {{Assumption!AH32}}。\n模型毛利率 {{Assumption!AH42}}。\n模型ASP {{Assumption!AH122}}。\n数值为模型缓存，不代表已实现。"};
 const saved=await review.tool.execute("report",args,undefined,undefined,{executeTool:async(name,params)=>{
   assert.equal(name,"write");fs.writeFileSync(path.join(root,params.path),params.content);
   return {isError:false,result:{content:[]}};
 }});
 assert.equal(saved.isError,false,JSON.stringify(saved));
 assert.ok(saved.content.some(c=>c.text.startsWith("[research_write_verified]")));
 const report=fs.readFileSync(path.join(root,args.path),"utf8");
 for(const text of ["7293 百万元","2.0552%","65%","8.3404 US$ / GB"])assert.ok(report.includes(text),text);
 assert.doesNotMatch(report,/\{\{|部分完成/);
 console.log("PASS real workbook report: four requested metrics saved and read back, no user hint or partial fallback");
 console.log("PASS real workbook: exact refs, metric semantics, product units, periods, ratio operands, chart regression and source citations");
} finally {fs.rmSync(path.dirname(out),{recursive:true,force:true});}
