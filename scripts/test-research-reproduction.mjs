import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {queryGraph} from '../lib/workbook-query.mjs';
import {deterministicEvidenceIssues,evidenceTimeline} from '../lib/research-audit.mjs';
import {checkTurnTools} from '../lib/turn-context.mjs';
import {evidenceFallback} from '../lib/research-delivery.mjs';
const file=process.argv[2];
assert.ok(file,'pass regression workbook path');
const parsed=spawnSync('python3',['services/workbook/parse_workbook.py',file],{encoding:'utf8',maxBuffer:30e6});assert.equal(parsed.status,0,parsed.stderr);
const graph=JSON.parse(parsed.stdout);
const refs=['PL!BA25','PL!BE25','Assumption!AH42','Assumption!AH32','Assumption!AL32','Assumption!AL47','Assumption!AH122','Discount PE!N35'];
const cells=refs.flatMap(r=>queryGraph(graph,r,{maxCells:1}).cells);
const check=text=>deterministicEvidenceIssues(text,[],cells);
for(const text of ['2030E归母净利745亿（PL!BE25）。','2026年净利暴增至183.8亿。','HBM收入到2030E爬到23.9%。','2026E HBM ASP=8.34 US$/Gb，来源Assumption!AH122。','去掉NAURA，斜率从+143反转为−3.3。','129 ÷ 59.12 - 1 = +132.2%。']) assert.ok(check(text).length,text);
for(const text of ['2030E归母净利7453.99亿元（PL!BE25）。','2026年净利1838.33亿。','HBM收入到2030E爬到26.8%。','2026E HBM ASP=8.34 US$/GB，来源Assumption!AH122。','去掉Hua Hong，斜率从+143反转为−3.3。','去掉NAURA，斜率变为186.76。','129 ÷ 59.12 - 1 = +118.2%。']) assert.deepEqual(check(text),[],text);
assert.equal(cells.find(c=>c.ref==='Assumption!AH42').unit,'');
const bad='我之前在表格里写的HBM收入占比65%是写错了。';
const timeline=evidenceTimeline([{role:'user',content:'你为什么说收入占比65%？'},{role:'assistant',content:[{type:'text',text:'毛利率65%，收入占比2.1%。'}]}]);
assert.ok(checkTurnTools({answer:'这些约束跟你怎么提问无关。',routes:['dependency']}).length===0);
assert.ok(checkTurnTools({answer:'两种错误与65%收入占比无关。',routes:['general']}).length===0);
assert.ok(checkTurnTools({answer:'capex不进入估值。',routes:['general']}).length===1);
assert.ok(deterministicEvidenceIssues(bad,timeline,cells).some(i=>i.check==='history'));
assert.ok(!deterministicEvidenceIssues(bad,[...timeline,{role:'assistant',text:'HBM收入占比65%。'}],cells).some(i=>i.check==='history'));
const sources=[{role:'toolResult',toolName:'deepseek_fetch',toolCallId:'source',content:[{type:'text',text:'测试公司披露2026全年营业利润率70%，未经独立验证。'}]}];
assert.match(evidenceFallback('此项判断证据不足，暂不能确定。',sources),/70%/);
assert.doesNotMatch(evidenceFallback('此项判断证据不足，暂不能确定。',[{...sources[0],isError:true}]),/70%/);
assert.equal(evidenceFallback('模型利润率取决于售价、成本与产品组合；未来若售价下降而成本没有下降，利润率可能承压，需要核实后续季度的变化。',sources),'模型利润率取决于售价、成本与产品组合；未来若售价下降而成本没有下降，利润率可能承压，需要核实后续季度的变化。');
console.log('PASS reproduced numeric, metric, chart identity, history, dependency and delivery cases');

assert.equal(checkTurnTools({answer:'公式错误不影响估值。',routes:['dependency']}).length,1);

// Exercise the real delivery wrapper: reviewer rejects all generated drafts,
// saving has exhausted its budget, but successful source evidence survives.
const {guardResearchDelivery}=await import('../lib/research-delivery.mjs');
const {createAssistantMessageEventStream}=await import('@earendil-works/pi-ai');
const messages=[{role:'user',content:'核验模型并保存报告'},...sources];
for(let i=0;i<6;i++) messages.push(
 {role:'assistant',content:[{type:'toolCall',name:'review_research',id:'r'+i,arguments:{path:'exports/report.md'}}]},
 {role:'toolResult',toolName:'review_research',toolCallId:'r'+i,isError:true,content:[{type:'text',text:'未保存'}]});
let requests=0;
const provider=async(_model,context)=>{
 requests++;assert.deepEqual(context.tools,[]);
 const message={role:'assistant',stopReason:'stop',content:[{type:'text',text:'错误结论已确认。'}]};
 const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end();return stream;
};
const stream=await guardResearchDelivery(provider,{audit:async()=>({ok:false,status:'reviewed',issues:[{check:'conclusion_strength',excerpt:'错误结论已确认。',reason:'没有来源支持'}]})})({}, {messages,tools:[]},{});
for await(const event of stream){}
const result=await stream.result();const body=result.content.map(c=>c.text).join('');
assert.match(body,/70%/);assert.match(body,/尚未保存/);assert.doesNotMatch(body,/错误结论已确认/);assert.ok(requests<=4);
console.log('PASS delivery wrapper preserves successful source facts after exhausted save/repair budget');

assert.ok(deterministicEvidenceIssues('我之前说收入占比 **65%** 是错误。',timeline,cells).some(i=>i.check==='history'));
assert.ok(!deterministicEvidenceIssues('我之前没有说过收入占比65%。',timeline,cells).some(i=>i.check==='history'));
