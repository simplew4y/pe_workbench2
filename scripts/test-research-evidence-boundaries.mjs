import assert from 'node:assert/strict';
import {quantityIssues} from '../lib/research-quantities.mjs';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {enrichFinancialSources} from '../lib/financial-source-identity.mjs';
import {auditTimeline} from '../lib/research-evidence-scope.mjs';
import {replaceResearchSpan} from '../lib/research-text-boundaries.mjs';

{
 const a={ref:'Assumptions!B8',rowLabel:'甲产品',metricContext:{label:'GM'},period:'2028E',value:.65};
 const b={...a,ref:'Assumptions!B9',rowLabel:'乙产品',value:.88};
 const revenue={...a,ref:'Assumptions!C8',metricContext:{label:'Revenues'},amount:{unit:'百万元'},period:'2027E',value:68307.3775};
 for(const line of ['2028年乙产品毛利率88%，甲产品收入继续增长。','2028年毛利率维持82%至88%，甲产品收入增长。','2027年甲产品产能扩张，把公司收入推到6597.4亿元。','2027年甲产品收入683.1亿元。'])assert.deepEqual(quantityIssues(line,[a,b,revenue]),[],line);
 assert.equal(quantityIssues('2028年甲产品毛利率60%，乙产品毛利率88%。',[a,b]).length,1);
 assert.equal(quantityIssues('2027年甲产品收入68.3亿元。',[revenue]).length,1);
 assert.equal(quantityIssues('2027年甲产品收入68.3亿元（Assumptions!C8）。',[revenue]).length,1);
 assert.deepEqual(quantityIssues('阈值为低于200亿元（模型明年 {{Assumptions!C8}} 百万元的三成）。',[revenue]),[]);
 const next={...a,ref:'Assumptions!C9',period:'2029E',value:.7};
 assert.deepEqual(quantityIssues('甲产品毛利率从2028年的65%升至2029年的70%。',[a,next]),[]);
 assert(quantityIssues('甲产品毛利率从2028年的70%升至2029年的65%。',[a,next]).length);
 const net={ref:'PL!B25',rowLabel:'Net profit',period:'2027E',value:362324.741,amount:{unit:'百万元'}};
 assert(quantityIssues('2027E净利362.3亿元',[net]).length);
}
{
 const base={materialId:'book',version:1,filename:'model.xlsx',storedFilename:'model.xlsx',period:'2028E',basis_type:'forecast',raw_unit:'decimal',display_unit:'%'};
 const citations=[{...base,id:'a-margin',locator:'M!B2',metric:'甲产品',value:.65},{...base,id:'b-margin',locator:'M!B3',metric:'乙产品',value:.88},{...base,id:'a-revenue',locator:'M!B4',metric:'甲产品',value:100,raw_unit:'百万元',display_unit:'百万元'}];
 const cells=citations.map((c,i)=>({ref:c.locator,rowLabel:c.metric,value:c.value,period:c.period,unit:c.raw_unit,display_unit:c.display_unit,metricContext:{label:i===2?'Revenues':'GM',product:c.metric}}));
 const call={id:'read',name:'workbook_query',success:true,result:{isError:false,details:{materialId:'book',version:1,path:'uploads/model.xlsx',cells,citations}}};
 const check=s=>financialEvidenceFindings(s,{question:'分析模型',citations,toolCalls:[call]},[]);
 for(const s of ['2028E甲产品毛利率65%。','2028E乙产品毛利率88%。','2028E甲产品收入1亿元。','2028E甲产品毛利率65%，乙产品毛利率88%。'])assert.deepEqual(check(s),[],s);
 for(const s of ['2028E甲产品毛利率88%。','2028E乙产品毛利率65%。','2028E甲产品收入10亿元。','2027E甲产品收入1亿元。'])assert(check(s).some(f=>f.severity==='error'),s);
 assert(check('2028E甲产品毛利率88%（M!B3）。').some(f=>f.severity==='error' && f.field==='segment'));
 assert.equal(enrichFinancialSources(citations,[{...call,success:false}])[0].metric,'甲产品');
 assert.equal(enrichFinancialSources([{...citations[0],version:2}],[call])[0].metric,'甲产品');
 const ambiguous={...call,result:{...call.result,details:{...call.result.details,cells:cells.map(c=>({...c,metricContext:{...c.metricContext,label:'Mix'}}))}}};
 assert(enrichFinancialSources(citations,[ambiguous])[0].semanticMetricUnresolved);
}
{
 const source={role:'toolResult',toolName:'web_fetch',toolCallId:'source',isError:false,text:'原始来源：甲公司收入100亿元。'.repeat(80)};
 const previous=Array.from({length:5},(_,i)=>({role:'toolResult',toolName:'review_research',toolCallId:'review-'+i,isError:true,text:'旧稿误报内容'.repeat(1000)}));
 const bounded=auditTimeline([source,...previous,{role:'assistant',text:'过时段落',calls:[{name:'edit',arguments:{path:'exports/state.json',edits:[{oldText:'旧值'.repeat(1000),newText:'新值'.repeat(1000)}]}}]}],8000);
 assert(bounded.some(x=>x.toolCallId==='source' && x.text===source.text));
 assert.equal(bounded.filter(x=>x.toolName==='review_research').length,5);
 assert(!JSON.stringify(bounded).includes('旧稿误报内容'));
 assert(!JSON.stringify(bounded).includes('旧值'));
 assert.equal(bounded.at(-1).calls[0].arguments.editCount,1);
 assert.equal(bounded.at(-1).calls[0].arguments.path,'exports/state.json');
}
{
 const note='数值待核。';
 const paragraph='收入999亿元[公司公告2026-11-20；计算]。风险需要持续观察。';
 assert.equal(replaceResearchSpan(paragraph,'收入999亿元',note),note+'风险需要持续观察。');
 const code='```json\n{"profit":999,"sources":[]}\n```\n\n## 风险\n\n保持观察。';
 const codeResult=replaceResearchSpan(code,'"profit":999',note);
 assert(!codeResult.includes('sources'));assert(!codeResult.includes('```'));assert(codeResult.includes('## 风险'));
 const table='| 指标 | 数值 |\n|---|---|\n| 收入 | 100亿元 |\n| 净利 | 999亿元 |\n| 合计 | 1099亿元 |\n\n## 风险\n\n持续观察。';
 const tableResult=replaceResearchSpan(table,'999亿元',note);
 assert(tableResult.includes('| 收入 | 100亿元 |'));assert(!tableResult.includes('1099'));assert(tableResult.includes('## 风险'));
 const earlier='上文存在未闭合“引用。\n\n';
 assert(replaceResearchSpan(earlier+paragraph,'收入999亿元',note).startsWith(earlier));
 assert.equal(replaceResearchSpan('无须修改。','不存在',note),'无须修改。');
}
console.log('PASS source product/metric identity, period binding, stale review isolation and structural text boundaries');
