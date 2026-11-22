import assert from 'node:assert/strict';
import test from 'node:test';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {derivedCitation,collectCitationsFromToolCalls} from '../lib/citations.mjs';
import {enrichFinancialSources} from '../lib/financial-source-identity.mjs';
import {closeResearchDocument} from '../lib/research-document-closure.mjs';
globalThis.fetch=()=>{throw Error('Offline regression');};
const cell=(loc,value,unit,metric,extra={})=>({id:loc,materialId:'model',version:1,filename:'模型.xlsx',locator:loc,value,raw_unit:unit,display_unit:unit,metric,...extra});
function calculation(name,value,unit,sources,expression='a*0.1') {
  const r={name,value,unit,expression,index:0,bindings:Object.fromEntries(sources.map((s,i)=>[String.fromCharCode(97+i),s]))};
  r.citations=derivedCitation(r,sources,{toolCallId:name,role:'derived_calc_0'});
  return {id:name,name:'calc',success:true,args:{expressions:[{...r}]},result:{details:{results:[r],citations:r.citations}}};
}
const errors=(answer,citations,toolCalls=[])=>financialEvidenceFindings(answer,{citations,toolCalls},[]).filter(f=>f.severity==='error');
test('output currency follows explicit output unit, not first input; historical receipts recover from the same result',()=>{
  const source=cell('V!A1',200,'百万元','利润',{currency:'CNY'});
  const call=calculation('每股价值减少','15','港元/股',[source]);
  assert.equal(call.result.details.citations[0].currency,'HKD');
  call.result.details.citations[0].currency='CNY';
  assert.equal(collectCitationsFromToolCalls([call])[0].currency,'HKD');
  call.result.details.results[0].currency='USD';
  assert.equal(collectCitationsFromToolCalls([call])[0].currency,'USD');
  assert.ok(errors('每股价值少15美元。',[source],[call]).length);
});
test('per-share changes use verified change receipts; absolute NAV, wrong amount/currency/failed input cannot pass',()=>{
  const source=cell('V!A1',200,'元/股','目标价',{currency:'HKD'}),call=calculation('每股价值减少','20','港元/股',[source]);
  assert.equal(errors('每股价值少20港元。',[source],[call]).length,0);
  assert.ok(errors('每股价值少200港元。',[source],[call]).length);
  assert.ok(errors('目标价20港元。',[source],[call]).length);
  assert.ok(errors('每股价值少20美元。',[source],[call]).length);
  assert.ok(errors('每股价值少20港元。',[source],[{...call,success:false}]).length);
  const stale=structuredClone(source);stale.value=201;
  assert.ok(errors('每股价值少20港元。',[stale],[call]).length);
});
test('grouped EPS references can use an observed growth formula, never an unrelated row or a wrong explicit cell',()=>{
  const a=cell('I!A1',25,'元/股','每股收益',{period:'2025'}),b=cell('I!B1',30,'元/股','每股收益',{period:'2026'});
  const c=cell('I!B2',0.2,'decimal','% yoy change',{period:'2026',formula:'=B1/A1-1'});
  const text='每股收益从2025年25元/股升到2026年30元/股、2026年增20%（[模型.xlsx]I!A1、B1）。';
  assert.equal(errors(text,[a,b,c]).length,0);
  assert.ok(errors(text.replace('增20%','增25%'),[a,b,c]).length);
  assert.ok(errors('2026年同比增速20%[模型.xlsx]I!B1。',[a,b,c]).length);
  assert.ok(errors(text,[a,b,{...c,formula:'=D1/C1-1'}]).length);
});
test('uncited but observed unknown units remain a metadata warning, not fabricated evidence',()=>{
  const s=cell('V!A1',18.5,'unit_unknown','Division');
  const f=financialEvidenceFindings('估值倍数18.5倍。',{citations:[s]},[]);
  assert.ok(f.some(f=>f.severity==='warning'));assert.equal(f.filter(f=>f.severity==='error').length,0);
  assert.ok(errors('估值倍数19.5倍。',[s]).length);
  assert.ok(errors('2024年估值倍数18.5倍。',[{...s,period:'2026'}]).length);
});
test('scenario parameters need the paired successful output and matching driver/direction',()=>{
  const s=cell('V!A1',200,'元/股','目标价',{currency:'HKD'}),call=calculation('业务净利下滑10%每股减少','20','港元/股',[s]);
  const text='业务利润整体下调10%，每股少20港元。';
  assert.equal(errors(text,[s],[call]).length,0);
  for(const bad of [text.replace('10%','15%'),text.replace('少20','少25'),text.replace('下调','增加'),text.replace('业务利润','不同成本')])
    assert.ok(errors(bad,[s],[call]).length,bad);
  assert.ok(errors(text,[s],[{...call,success:false}]).length);
});
test('growth headings are metrics, not business segments',()=>{
  const c=cell('I!B2',0.2,'decimal','% yoy change',{formula:'=B1/A1-1'});
  const calls=[{name:'workbook_trace',success:true,details:{materialId:'model',version:1,cells:[{ref:'I!B2',metricContext:{product:'% yoy change',label:'Non-GAAP EPS'}}]}}];
  const enriched=enrichFinancialSources([c],calls)[0];
  assert.equal(enriched.metric,'% yoy change');assert.equal(enriched.segment,undefined);
});
test('a stated ratio can use a verified change and current same-currency denominator; wrong ratios still fail',()=>{
  const s=cell('V!A1',200,'元/股','目标价',{currency:'HKD'}),call=calculation('每股价值减少','20','港元/股',[s]);
  const text='每股少20港元，相当于目标价的10%。';
  assert.equal(errors(text,[s],[call]).length,0);
  assert.ok(errors(text.replace('的10%','的15%'),[s],[call]).length);
  assert.ok(errors(text,[s],[{...call,success:false}]).length);
});
test('closure removes stranded prose ordinals without changing intact lists or source identifiers',()=>{
  assert.equal(closeResearchDocument('','二是**资料偏旧**。\n\n三是范围有限。').text,'**资料偏旧**。\n\n范围有限。');
  const intact='一是资料。\n\n二是口径。';assert.equal(closeResearchDocument(intact,intact).text,intact);
  const sections='# 甲\n\n'+intact+'\n\n# 乙\n\n'+intact;assert.equal(closeResearchDocument(sections,sections).text,sections);
  const codes='二季度收入。\n\n```\n二是原始引文\n```';assert.equal(closeResearchDocument(codes,codes).text,codes);
});
