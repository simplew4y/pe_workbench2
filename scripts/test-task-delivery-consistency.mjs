import assert from 'node:assert/strict';
import test from 'node:test';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {collectCitationsFromToolCalls,derivedCitation} from '../lib/citations.mjs';
import {enrichFinancialSources} from '../lib/financial-source-identity.mjs';
import {guardResearchDelivery} from '../lib/research-delivery.mjs';
import {lintLedgerAnswer} from '../lib/answer-lint.mjs';
import {researchPortion} from '../server/agent/answer-delivery.mjs';
import {runWithPostAnswer} from '../server/agent/post-answer.mjs';
import {closeResearchDocument} from '../lib/research-document-closure.mjs';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
globalThis.fetch=()=>{throw Error('Offline regression: network forbidden');};
const cell=(ref,value,unit,metric,extra={})=>({id:ref,materialId:'sample',version:1,filename:'输入.xlsx',storedFilename:'input.xlsx',locator:ref,value,raw_unit:unit,display_unit:unit,metric,...extra});
const errors=(text,citations,toolCalls=[])=>financialEvidenceFindings(text,{citations,toolCalls},[]).filter(f=>f.severity==='error');
function calc(name,value,unit,sources) {
  const result={index:0,name,value,unit,expression:'a/b',bindings:Object.fromEntries(sources.map((s,i)=>[String.fromCharCode(97+i),s]))};
  result.citations=derivedCitation(result,sources,{toolCallId:name,role:'derived_calc_0'});
  return {id:name,name:'calc',success:true,result:{details:{results:[result],citations:result.citations}}};
}
test('NAV total and per-share values use units, and cannot replace one another',()=>{
  const total=cell('S!A1',1200,'百万元','NAV (pre holdco discount)',{currency:'CNY'});
  const price=cell('S!A2',30,'元/股','NAV',{currency:'HKD'});
  assert.equal(errors('折价前净资产价值1200百万元（[输入.xlsx]S!A1）。',[total]).length,0);
  assert.equal(errors('目标价30港元（[输入.xlsx]S!A2）。',[price]).length,0);
  assert.ok(errors('目标价1200港元（[输入.xlsx]S!A1）。',[total]).length);
  assert.ok(errors('净资产价值30百万元（[输入.xlsx]S!A2）。',[price]).length);
});
test('a suffix names PE rather than inheriting the preceding EPS metric',()=>{
  const eps=cell('I!A1',4,'元/股','EPS',{currency:'HKD'}),price=cell('V!A1',80,'元/股','目标价',{currency:'HKD'});
  const call=calc('目标价对应PE','20','倍',[price,eps]);
  const text='每股收益4港元（[输入.xlsx]I!A1）20倍市盈率。';
  assert.equal(errors(text,[eps,price],[call]).length,0);
  assert.ok(errors(text.replace('20倍','25倍'),[eps,price],[call]).length);
});
test('contribution ratios retain their denominator, including NAV terminology',()=>{
  const a=cell('V!A1',10,'百万元','分部价值'),b=cell('V!A2',100,'百万元','NAV (pre holdco discount)');
  const call=calc('分部价值占折价前NAV','10','%',[a,b]);
  assert.equal(errors('分部价值占折价前净资产10%。',[a,b],[call]).length,0);
  assert.ok(errors('分部价值占收入10%。',[a,b],[call]).length);
});
test('later observations can fill missing metadata only for the same version and value',()=>{
  const a=cell('I!A1',120,'unit_unknown','利润'),b={...a,raw_unit:'百万元',display_unit:'百万元',currency:'CNY'};
  const call=c=>({name:'workbook_query',success:true,details:{citations:[c]}});
  assert.equal(collectCitationsFromToolCalls([call(a),call(b)])[0].raw_unit,'百万元');
  assert.equal(collectCitationsFromToolCalls([call(a),call({...b,value:121})])[0].raw_unit,'unit_unknown');
  assert.equal(collectCitationsFromToolCalls([call(a),call({...b,version:2})])[0].raw_unit,'unit_unknown');
  assert.equal(collectCitationsFromToolCalls([call(a),{...call(b),success:false}])[0].raw_unit,'unit_unknown');
});
test('accounting labels are neither companies nor business segments',()=>{
  const c=cell('I!A1',125,'百万元','Net profit, non-GAAP');
  const calls=[{name:'workbook_trace',success:true,details:{materialId:'sample',version:1,cells:[{ref:c.locator,metricContext:{label:'Net margin',product:'Net profit, non-GAAP'}}]}}];
  const enriched=enrichFinancialSources([c],calls)[0];
  assert.equal(enriched.metric,c.metric);assert.equal(enriched.segment,undefined);
  assert.equal(errors('非 GAAP 净利125百万元（[输入.xlsx]I!A1）。',[c],calls).length,0);
});
test('recalculated outputs require successful matching input changes and never replace base values',()=>{
  const price=cell('V!A1',100,'元/股','NAV',{currency:'HKD'}),input=cell('V!A2',20,'倍','PE');
  const call={id:'scenario',name:'model_whatif',success:true,result:{details:{path:'uploads/input.xlsx',recalculated:true,inputs:[{cell:'V!A2',value:18}],results:[{cell:'V!A1',before:100,after:90}]}}};
  const text='倍数下调2倍，全模型重算后目标价从100港元降到90港元。';
  assert.equal(errors(text,[price,input],[call]).filter(f=>f.claim?.value==='90').length,0);
  for(const bad of [text.replace('下调2','下调3'),text.replace('90港元','95港元'),'原模型基准目标价90港元。'])assert.ok(errors(bad,[price,input],[call]).length,bad);
  assert.ok(errors(text,[price,input],[{...call,success:false}]).length);
  assert.ok(errors(text,[price,input],[{...call,result:{details:{...call.result.details,recalculated:false}}}]).length);
  assert.equal(errors('倍数从20倍调整到18倍，全模型重算后目标价90港元。',[price,input],[call]).length,0);
  assert.ok(errors('倍数从20倍调整到15倍，全模型重算后目标价90港元。',[price,input],[call]).length);
});
test('identical audit inputs reuse review, while changed evidence and new user turns invalidate it',async()=>{
  let audits=0;
  const provider=async()=>{
    const message={role:'assistant',content:[{type:'text',text:'模型的驱动是销量与利润率，应核实预测依据。'}],stopReason:'stop'};
    const stream=createAssistantMessageEventStream();stream.push({type:'done',reason:'stop',message});stream.end();return stream;
  };
  const guarded=guardResearchDelivery(provider,{audit:async()=>{audits++;return {ok:true,status:'reviewed',issues:[]};}});
  const user={role:'user',content:'理解这份模型的关键驱动'};
  const run=async messages=>{const stream=await guarded({}, {messages}, {});for await(const event of stream){}return stream.result();};
  await run([user]);await run([user]);assert.equal(audits,1);
  const tool={role:'toolResult',toolCallId:'read1',toolName:'workbook_query',content:[],details:{value:1}};
  await run([user,tool]);assert.equal(audits,2);
  await run([user,{...tool,details:{value:2}}]);assert.equal(audits,3);
  await run([user,{role:'user',content:'理解这份模型的关键驱动'}]);assert.equal(audits,4);
});
test('a rounded observed number with unknown units is a metadata gap, not a contradictory amount',()=>{
  const c=cell('I!A1',1234.7,'unit_unknown','Net profit, non-GAAP');
  const f=financialEvidenceFindings('非 GAAP 净利1235百万元。',{citations:[c]},[]);
  assert.equal(f.filter(f=>f.severity==='error').length,0);
  assert.ok(f.some(f=>f.evidenceStatus==='metadata_missing'));
  assert.ok(errors('非 GAAP 净利1435百万元。',[c]).length);
});
test('one unsupported repeated number cannot remove a separately supported sentence elsewhere',()=>{
  const answer='甲业务的贡献占比12.3%（[输入.xlsx]S!A1）。\n\n乙业务的贡献占比12.3%（[输入.xlsx]S!B2）。';
  const source=cell('S!A1',12.34,'%','甲业务贡献占比');
  const findings=lintLedgerAnswer(answer,{facts:[]},{citations:[source],locatorFindings:[{rule:'unverified_locator',excerpt:'S!B2'}]});
  const orphan=findings.find(f=>f.rule==='orphaned_number');assert.ok(orphan.sourceText.includes('乙业务'));
  const delivered=researchPortion(answer,()=>{throw Error('isolated re-lint');},findings,[source]);
  assert.match(delivered,/甲业务的贡献占比12.3%/);assert.doesNotMatch(delivered,/乙业务的贡献占比12.3%/);
});
test('partial sentence removal repairs Markdown emphasis without changing valid code or formatting',()=>{
  const original='**第一句。第二句。**\n\n`a**b`';
  const kept='第二句。**\n\n`a**b`';
  assert.equal(closeResearchDocument(original,kept).text,'第二句。\n\n`a**b`');
});
test('a repeated failed draft over unchanged evidence stops before another recovery generation',async()=>{
  const records=[],messages=[];let prompts=0;
  const answer='模型的业务驱动是客户数量、单客收入与利润率，应分别验证这些预测的依据。'.repeat(8)+'\n\n目标价999港元。';
  const session={messages,sessionManager:{getBranch:()=>[],appendCustomEntry(type,data){records.push({type,data});}},
    async prompt(){prompts++;messages.push({role:'assistant',stopReason:'stop',content:[{type:'text',text:answer}]});},
    async sendCustomMessage(_message,options){if(options?.triggerTurn)await this.prompt();}};
  const result=await runWithPostAnswer({session},'理解这份模型的关键驱动是什么？');
  assert.equal(prompts,2,JSON.stringify(records.filter(r=>r.type==='pe_answer_lint').map(r=>r.data.findings)));assert.equal(result.status,'partial');
  assert.match(result.text,/客户数量/);assert.doesNotMatch(result.text,/999港元/);
  assert.ok(result.text.startsWith('模型的业务驱动是客户数量'));
  assert.doesNotMatch(result.text,/本次尚未完成全部核验/);
  assert.equal(records.find(r=>r.type==='pe_task_route').data.research,true);
});
