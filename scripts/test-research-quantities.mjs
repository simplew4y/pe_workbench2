import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {queryGraph} from '../lib/workbook-query.mjs';
import {deterministicEvidenceIssues, auditResearch, AUDIT_CHECKS} from '../lib/research-audit.mjs';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
const file=process.argv[2];
assert.ok(file,'pass the regression workbook path');
const parsed=spawnSync('python3',['services/workbook/parse_workbook.py',file],{encoding:'utf8',maxBuffer:30e6});
assert.equal(parsed.status,0,parsed.stderr);
const graph=JSON.parse(parsed.stdout);
const cells=['PL!BE25','Assumption!AH13','Assumption!AH37','Assumption!AH42','Assumption!AH32','Assumption!AL32','Assumption!AL47'].flatMap(ref=>queryGraph(graph,ref,{maxCells:1}).cells);
assert.equal(cells.find(c=>c.ref==='Assumption!AH13').value,7293);
const finance='| EndDate | OperatingRevenue |\n| --- | --- |\n| 2026-03-31 | 50800145545.85 |\n| 2026-06-30 | 150310076758.00 |\n| 2026-09-30 | 269024106510.18 |\n| 2025-12-31 | 61799321546.81 |';
const source={role:'toolResult',toolName:'westock_query',toolCallId:'finance',text:finance};
const cases=[
 ['HBM tenfold error','2026E HBM收入仅7.3亿元。','numeric_units'],
 ['original parenthesis','DDR + LPDDR放量，自2026Q4起切入HBM（2026E HBM收入仅7.3亿元，2030E扩张至大几百亿）。','numeric_units'],
 ['HBM correct','2026E HBM收入72.93亿元。'],
 ['HBM rounded','2026E HBM收入约72.9亿元。'],
 ['HBM equivalent','2026E HBM收入7,293百万元，即72.93亿元（Assumption!AH13）。'],
 ['income and gross profit','2026E HBM收入72.93亿元，毛利47.4045亿元。'],
 ['correct compound','2026E HBM毛利率65%（Assumption!AH42），收入占比2.055%（Assumption!AH32）。'],
 ['correct compound no refs','2026E HBM毛利率65%，收入占比2.055%。'],
 ['correct conjunction','2026E HBM毛利率65%和收入占比2.055%。'],
 ['correct postfix','2026E HBM的65%毛利率与2.055%收入占比均为模型假设。'],
 ['wrong revenue mix','2026E HBM毛利率65%，收入占比65%。','metric_meaning'],
 ['wrong cited metric','2026E HBM收入占比65%（Assumption!AH42）。','metric_meaning'],
 ['wrong grossprofit mix','2030E HBM收入占比23.9%（Assumption!AL47）。','metric_meaning'],
 ['correct long term mix','HBM收入到2030E爬到26.8%。'],
 ['wrong long term mix','HBM收入到2030E爬到23.9%。','metric_meaning'],
 ['raw cumulative sum','实际前三季度累计收入=50800145545.85+150310076758+269024106510.18=4701亿元。','comparison_basis'],
 ['rounded cumulative sum','前三季度收入=508.0亿+1503.1亿+2690.2亿=4701.3亿元。','comparison_basis'],
 ['false single quarter','2026Q3单季收入2690.2亿。','comparison_basis'],
 ['correct single quarter difference','按累计口径，2026Q3单季收入=(269024106510.18-150310076758)/1e8=1187.14亿元。'],
 ['correct cumulative total','按累计口径，前三季度收入2690.24亿元，半年收入1503.10亿元。'],
 ['correct expanded difference','前三季度收入=50800145545.85+(150310076758-50800145545.85)+(269024106510.18-150310076758)。'],
 ['different years','两年合计=61799321546.81+269024106510.18元。'],
 ['negated sum','这些累计数不能直接相加：50800145545.85+150310076758+269024106510.18。'],
 ['explicit quarter basis','收入合计=50800145545.85+150310076758+269024106510.18元。',undefined,[{...source,text:'口径：单季\n'+finance}]],
 ['failed source ignored','2026Q3单季收入2690.2亿。',undefined,[{...source,isError:true}]],
 ['unrelated amounts','支出=10+20+30亿元。'],
 ['another table cannot establish quarter basis','2026Q3单季收入2690.2亿。','comparison_basis',[{...source,text:'口径：单季\n| EndDate | OtherMetric |\n| --- | --- |\n| 2026-09-30 | 10 |\n'+finance}]],
 ['citation after comma','HBM收入占比是65%，来源Assumption!AH42。','metric_meaning'],
 ['citation before claim','Assumption!AH42表明HBM收入占比65%。','metric_meaning'],
 ['original correct values','模型2026E HBM毛利率65%（Assumption!AH42），收入占比约2.055%（Assumption!AH32）；2030E归母净利745398.925百万元，约7453.989亿元（PL!BE25）。均为缓存预测，不代表实绩。'],
 ['original period sum','2026Q3单季收入2690.2亿。实际前三季度累计收入=50800145545.85+150310076758+269024106510.18=4701亿元，已超过全年模型预测3549亿元。','comparison_basis'],
 ['wrong adjacent amounts','2026E HBM收入72.93亿元，毛利4.74045亿元。','numeric_units'],
];
const results=[];
for(const [name,draft,expected,timeline=[source]] of cases) {
 const issues=deterministicEvidenceIssues(draft,timeline,cells);
 if(expected)assert.ok(issues.some(i=>i.check===expected),`${name}: ${JSON.stringify(issues)}`);
 else assert.deepEqual(issues,[],`${name}: ${JSON.stringify(issues)}`);
 results.push({name,draft,expected:expected || 'pass',issues});
}
// Even an incorrectly permissive reviewer must not bypass the actual audit entry point.
const provider=async()=>{
 const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:JSON.stringify({checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass'])),issues:[]})}]};
 const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end();return stream;
};
for(const index of [0,6,10,15,18]) {
 const [name,draft,expected]=cases[index];
 const result=await auditResearch(provider,{}, {messages:[{...source,content:[{type:'text',text:finance}]}]}, {},draft,{workbookEvidence:cells});
 assert.equal(result.ok,!expected,`audit integration: ${name}`);
}
if(process.env.RESULT_PATH)fs.writeFileSync(process.env.RESULT_PATH,JSON.stringify(results,null,2));
console.log(`PASS ${cases.length} targeted cases + 5 audit integration cases; no external model calls`);
