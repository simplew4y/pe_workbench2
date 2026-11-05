import assert from 'node:assert/strict';
import {queryGraph,formatResult,displayValue} from '../lib/workbook-query.mjs';
import {traceGraph,formatTrace} from '../lib/workbook-trace.mjs';
import {periodLabelFromHeader,formatCellLabels} from '../lib/workbook-cell-metadata.mjs';
import {focusedAnswerContract,needsFocusedDeliveryCheck} from '../lib/research-context.mjs';
const doc={sheets:[{name:'Cover Page',rows:20,rowLabels:{6:'Example Holdings (0123.HK)',8:'Target price'}},{name:'Other',rows:20,rowLabels:{6:'Unrelated plc'}},{name:'Model',rows:30,rowLabels:{1:'Revenue',2:'Widget',9:'Gross profits',10:'Widget',19:'Margin',20:'Widget'}}],cells:[['Cover Page!C8','=Model!A2',100,8,3,'Target price',''],['Other!A6',null,'Unrelated plc',6,1,'Unrelated plc',''],['Model!A2',null,100,2,1,'Widget','2026E'],['Model!A10','=A2*A20',40,10,1,'Widget','2026E'],['Model!A20',null,.4,20,1,'Widget','2026E']],edges:[['Model!A2','Model!A10'],['Model!A20','Model!A10']]};
let passed=0,failed=0;function test(name,fn){try{fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.message);}}
test('tool numeric text round-trips without silently rounding ratios or small values',()=>{
 for(const value of [-0.0312656298,0.055782,0.000000014,58343.017459271,1e20])assert.equal(Number(displayValue(value)),value);
 assert.equal(displayValue(null),'—');assert.equal(displayValue(Infinity),'—');
});
test('row/column label origins stay separate and a business header is not a period',()=>{
 assert.equal(periodLabelFromHeader('DDR & LPDDR'),null);assert.equal(periodLabelFromHeader('4Q26E'),'4Q26E');
 for(const h of ['1999','Q1 2026','2026Q1','1H27','FY2026E'])assert.equal(periodLabelFromHeader(h),h);
 const labels=formatCellLabels({rowLabel:'Gross margin',columnLabel:'DDR & LPDDR'});assert.match(labels,/行标签=Gross margin/);assert.match(labels,/列标签=DDR & LPDDR/);
});
test('sheet discovery is available on misses and wrong-sheet errors without guessing aliases',()=>{
 assert.match(formatResult(queryGraph(doc,'封面 公司名称 股票代码')),/工作表目录.*Cover Page/);
 assert.match(formatResult(queryGraph(doc,'Missing!A1')),/工作表目录.*Cover Page/);
 assert.throws(()=>traceGraph(doc,{sheet:'Cover',rows:'1-10'}),/可用工作表.*Cover Page/);
 const only={sheets:[{name:'Text only',rowLabels:{1:'Issuer'}}],cells:[],edges:[]};assert.doesNotMatch(formatTrace(traceGraph(only,{cell:'Text only!A1'})),/工作表不存在/);
});
test('identity available via exact, mixed, rows and range routes',()=>{
 for(const q of ['Cover Page','Cover Page 公司 证券代码'])assert.match(formatResult(queryGraph(doc,q)),/Example Holdings/);
 for(const opts of [{sheet:'Cover Page',rows:'1-17'},{cell:'Cover Page!A1:C17'}])assert.match(formatTrace(traceGraph(doc,opts)),/Example Holdings/);
});
test('metadata scope does not leak sheets or rows; absent is not blank',()=>{
 assert.doesNotMatch(formatResult(queryGraph(doc,'Other')),/Example Holdings/);
 const overlap={...doc,sheets:[...doc.sheets,{name:'Cover',rowLabels:{6:'Wrong issuer'}}]};
 for(const q of ['Cover Page','Cover Page 公司'])assert.doesNotMatch(formatResult(queryGraph(overlap,q)),/Wrong issuer/);
 assert.doesNotMatch(formatTrace(traceGraph(doc,{cell:'Cover Page!A9:C10'})),/Example Holdings/);
 const r=traceGraph(doc,{cell:'Cover Page!A6:C6'});assert.equal(r.cells[0].cacheStatus,'not_parsed');assert.equal(r.cells[0].empty,undefined);assert.match(formatTrace(r),/不能.*空白|不代表.*空白/);
 assert.match(formatTrace(r),/列位置.*未知|列坐标.*未知/);
});
test('metadata-only queries and bounded output',()=>{
 const d={sheets:[{name:'Notes',rows:200,rowLabels:Object.fromEntries(Array.from({length:100},(_,i)=>[i+1,'Label '+i+'x'.repeat(100)]))}],cells:[],edges:[]};
 const r=queryGraph(d,'Notes');assert(r.metadata.length>0);assert(r.metadataTruncated);assert(formatResult(r,{maxChars:1000}).length<=1000);
 assert.doesNotMatch(formatResult(r),/没有匹配到任何标签/);
 assert.match(formatTrace(traceGraph(d,{cell:'Notes!A1:C3'})),/Label 0/);
 const t=traceGraph(d,{sheet:'Notes',rows:'1-100'});assert(t.metadataTruncated);assert(formatTrace(t,{maxChars:1000}).length<=1000);
});
test('semantic evidence shows real consumers without invented financial identity',()=>{
 const q=formatResult(queryGraph(doc,'Model!A20'));assert.match(q,/Gross profits/);assert.match(q,/Revenue/);
 const t=traceGraph(doc,{cell:'Model!A20'});assert(t.consumers.some(c=>c.ref==='Model!A10'));const s=formatTrace(t);assert.match(s,/A2\*A20/);assert.match(s,/Gross profits/);assert.match(s,/Revenue/);assert.match(s,/其他操作数（此分组不表示与目标格的依赖方向/);assert(!t.consumers.some(c=>c.ref==='Model!A2'));assert(t.consumerInputs.some(c=>c.ref==='Model!A2'));assert.doesNotMatch(s,/业务含义为毛利率|业务含义为税率/);
});
test('aggregation labels are backed by real sum edges, not nearest labels',()=>{
 const d=structuredClone(doc);
 d.cells.push(['Model!A1','=A2+A3',120,1,1,'Revenue',''],['Model!A3',null,20,3,1,'Other product',''],['Model!A9','=SUM(A10:A11)',50,9,1,'Gross profits',''],['Model!A11',null,10,11,1,'Other product','']);
 d.edges.push(['Model!A2','Model!A1'],['Model!A3','Model!A1'],['Model!A10','Model!A9'],['Model!A11','Model!A9']);
 const t=traceGraph(d,{cell:'Model!A20'});
 assert(t.aggregationEvidence.some(e=>e.from==='Model!A10'&&e.to==='Model!A9'&&e.rowLabel==='Gross profits'));
 assert(t.aggregationEvidence.some(e=>e.from==='Model!A2'&&e.to==='Model!A1'&&e.rowLabel==='Revenue'));
 assert(!t.aggregationEvidence.some(e=>e.to==='Model!A20'));
 assert.equal(t.productUses[0].product,'Model!A10');assert.equal(t.productUses[0].operand,'Model!A2');
 assert.equal(t.productUses[0].productSums[0].rowLabel,'Gross profits');
 assert.equal(t.productUses[0].operandSums[0].rowLabel,'Revenue');
 assert.equal(t.productUses[0].ratioInterpretation.kind,'gross_margin');
 const missing=structuredClone(d);missing.cells.find(c=>c[0]==='Model!A9')[1]='=SUM(A10:A12)';
 assert.equal(traceGraph(missing,{cell:'Model!A20'}).productUses[0].ratioInterpretation,null,'unparsed sum references prevent inference');
 const mixed=structuredClone(d);mixed.cells.find(c=>c[0]==='Model!A11')[5]='Costs';
 assert.equal(traceGraph(mixed,{cell:'Model!A20'}).productUses[0].ratioInterpretation,null,'revenue minus costs is not a component-margin partition');
 const manySums=structuredClone(d);
 for(const row of [60,61]){manySums.cells.push([`Model!A${row}`,'=A10+A11',50,row,1,'Other sum','']);manySums.edges.push(['Model!A10',`Model!A${row}`]);}
 const bounded=traceGraph(manySums,{cell:'Model!A20'});assert.equal(bounded.productUses[0].productSumsTruncated,true);assert.equal(bounded.productUses[0].productSums.length,2);assert.match(formatTrace(bounded),/汇总示例已截断/);
 const noProduct=structuredClone(d);noProduct.cells.find(c=>c[0]==='Model!A10')[1]='=A2+A20';
 assert.deepEqual(traceGraph(noProduct,{cell:'Model!A20'}).productUses,[]);
 for(let i=21;i<=50;i++){d.cells.push([`Model!A${i}`,null,i,i,1,'Input','']);d.edges.push([`Model!A${i}`,'Model!A10']);}
 assert.equal(traceGraph(d,{cell:'Model!A20'}).aggregationTruncated,true);
});
test('focused contract respects report requests and latest user turn',()=>{
 const completedCalc={role:'toolResult',toolName:'calc',content:[]};
 assert(needsFocusedDeliveryCheck([{role:'user',content:'这个金额对吗？'},completedCalc]));
 assert(!needsFocusedDeliveryCheck([completedCalc,{role:'user',content:'谢谢'}]));
 assert(!needsFocusedDeliveryCheck([{role:'user',content:'写一份完整报告'},completedCalc]));
 assert(!needsFocusedDeliveryCheck([{role:'user',content:'你好'}]));
 for(const content of ['请核算已给金额。','请核对这个数值。','复核此换算。'])assert(focusedAnswerContract([{role:'user',content}]));
 assert(focusedAnswerContract([{role:'user',content:'请核实这三个数，分别给出公式。'}]));
 for(const content of ['请核实整份模型并撰写完整报告','请详细说明换算规则和所有例子','你好'])assert.equal(focusedAnswerContract([{role:'user',content}]),'');
 assert.equal(focusedAnswerContract([{role:'user',content:'核查旧答'},{role:'assistant',content:'done'},{role:'user',content:'现在撰写完整报告'}]),'');
});
console.log({passed,failed});process.exitCode=failed?1:0;
