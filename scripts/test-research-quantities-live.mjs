// Opt-in: six short model reviews of the three repaired cases; no full QA session.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {streamSimple} from '../node_modules/@earendil-works/pi-ai/dist/compat.js';
import {loadConfig} from '../server/config.mjs';
import {queryGraph} from '../lib/workbook-query.mjs';
import {auditResearch} from '../lib/research-audit.mjs';
const [file,out]=process.argv.slice(2);assert.ok(file && out,'pass workbook and results path');
const parsed=spawnSync('python3',['services/workbook/parse_workbook.py',file],{encoding:'utf8',maxBuffer:30e6});assert.equal(parsed.status,0,parsed.stderr);
const graph=JSON.parse(parsed.stdout);
const cells=['Assumption!AH13','Assumption!AH42','Assumption!AH32'].flatMap(ref=>queryGraph(graph,ref,{maxCells:1}).cells);
const finance='| EndDate | OperatingRevenue |\n| --- | --- |\n| 2026-03-31 | 50800145545.85 |\n| 2026-06-30 | 150310076758.00 |\n| 2026-09-30 | 269024106510.18 |';
const cases=[
 ['amount_bad',false,'模型2026E HBM收入7.3亿元。'],
 ['amount_good',true,'模型2026E HBM收入72.93亿元。'],
 ['metrics_bad',false,'模型2026E HBM毛利率65%，收入占比65%。'],
 ['metrics_good',true,'模型2026E HBM毛利率65%（Assumption!AH42），收入占比约2.055%（Assumption!AH32）。'],
 ['period_bad',false,'2026Q3单季收入2690.2亿。前三季度累计收入=50800145545.85+150310076758+269024106510.18=4701亿元。'],
 ['period_good',true,'若来源为累计口径，前三季度收入2690.24亿元；Q3单季收入应以前三季度减半年：(269024106510.18-150310076758)/1e8=1187.14亿元。来源仅提供截止日，仍需确认累计或单季口径。'],
];
const config=await loadConfig(),results=[];
for(let i=0;i<cases.length;i+=2) {
 await Promise.all(cases.slice(i,i+2).map(async([name,expected,draft])=>{
  const period=name.startsWith('period');
  const evidence=period?finance:JSON.stringify(cells.map(({ref,value,period,rowLabel,metricContext,amount,ratioEvidence})=>({ref,value,period,rowLabel,metricContext,amount,ratioEvidence})));
  const context={messages:[{role:'user',content:period?'根据来源解释收入期间口径。':'根据模型简述HBM收入和相关指标。'}, {role:'toolResult',toolCallId:'evidence',toolName:period?'westock_query':'workbook_query',content:[{type:'text',text:evidence}]}]};
  const result=await auditResearch(streamSimple,config.model,context,{apiKey:config.deepseekApiKey},draft,{workbookEvidence:period?[]:cells});
  results.push({name,expected,draft,evidence,result,passed:result.status==='reviewed' && result.ok===expected});
  console.log(JSON.stringify({name,expected,ok:result.ok,status:result.status,issues:result.issues,usage:result.usage}));
 }));
 fs.writeFileSync(out,JSON.stringify(results,null,2));
}
assert.ok(results.every(r=>r.passed),'targeted real audit failures: see results');
console.log('PASS 6 targeted real model reviews');
