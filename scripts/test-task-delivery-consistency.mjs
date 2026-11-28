import assert from 'node:assert/strict';
import test from 'node:test';
import {financialEvidenceFindings,citedReportConflicts} from '../lib/financial-evidence.mjs';
import {collectCitationsFromToolCalls,derivedCitation} from '../lib/citations.mjs';
import {enrichFinancialSources} from '../lib/financial-source-identity.mjs';
import {createHash} from 'node:crypto';
import {guardResearchDelivery,reviewedReportForAnswer} from '../lib/research-delivery.mjs';
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
test('spot quotes survive handoff next to cited model prices and reject stale, peer, or wrong-currency prices',()=>{
  const model=cell('Prices!B1',90,'元/股','目标价',{currency:'HKD'}),stale={...model,id:'old',locator:'Prices!B2',metric:'股价',value:63};
  const quote=(id,name,ticker,value,date)=>({id,name:'westock_query',success:true,args:{args:['quote',ticker],expectedName:name},
    result:{content:[{type:'text',text:[ '| code | name | price_currency | price | time |','| --- | --- | --- | --- | --- |',
      `| ${ticker} | ${name} | HKD | ${value} | ${date} |`].join('\n')}]}});
  const toolCalls=[quote('market','示例控股','hk01234',54,'2026-10-15'),quote('stale','示例控股','hk01234',63,'2026-10-14'),quote('peer','乙公司','hk05678',72,'2026-10-15')];
  const bindings=[],ctx={citations:[model,stale],toolCalls,onVerifiedQuantity:b=>bindings.push(b)};
  const report='# 示例控股 投资框架\n\n模型目标价90港元（[输入.xlsx]Prices!B1），现价54港元。';
  assert.deepEqual(citedReportConflicts(report,ctx),[]);
  assert.ok(bindings.some(b=>b.valueText==='54' && b.sourceIds.includes('tool:market:price')));
  for(const price of ['63港元','72港元','54美元'])
    assert.ok(financialEvidenceFindings(report.replace('54港元',price),ctx,[]).some(f=>f.claim?.value===price.slice(0,2) && f.severity==='error'));
});

test('a price transition binds both endpoints and the same row of joint assumptions',()=>{
  const price=cell('Equity!C3',160,'港元/股','NAV',{currency:'HKD',sha256:'revision'});
  const inputs=[cell('Equity!D1',9,'倍','生产'),cell('Equity!D2',10,'倍','服务'),cell('Equity!D3',-0.1,'decimal','控股折价')];
  const scenario={name:'model_whatif',id:'uniform-trial',success:true,details:{path:'uploads/input.xlsx',sourceSha256:price.sha256,recalculated:true,
    inputs:inputs.map((c,i)=>({cell:c.locator,value:[7,7,-0.2][i]})),results:[{cell:price.locator,before:160,after:112}]}};
  const table='| 扰动 | 结果 | 对目标价 |\n|---|---|---|\n| 两项 7 倍 + 折价 20% | 160→112 | -30% |';
  const verified=[],context={citations:[price,...inputs],toolCalls:[scenario],onVerifiedQuantity:b=>verified.push(b)};
  assert.deepEqual(citedReportConflicts(table,context),[]);
  assert.ok(verified.some(b=>b.valueText==='112' && b.sourceIds.includes(scenario.id)));
  for(const [a,b] of [['160→','150→'],['→112','→48'],['7 倍','8 倍'],['20%','22%']])
    assert.ok(citedReportConflicts(table.replace(a,b),context).length);
  assert.ok(citedReportConflicts(table,{...context,toolCalls:[{...scenario,success:false}]}).length);
});

test('a cited revenue level supplies the numerator of its own annual growth',()=>{
  const level=cell('Income!C8',125,'百万元','收入',{period:'2025E'}),prior={...level,id:'prev',locator:'Income!B8',value:100,period:'2024A'};
  const unrelated={...prior,id:'other',locator:'Income!B7',metric:'成本',value:110};
  const text='模型收入 125 原表缓存值 （[输入.xlsx]Income!C8） 百万元，同比 +25%。';
  const bindings=[],context={citations:[level,prior,unrelated],onVerifiedQuantity:b=>bindings.push(b)};
  assert.deepEqual(citedReportConflicts(text,context),[]);
  assert.ok(bindings.some(b=>b.valueText==='+25' && b.sourceIds.includes(prior.id)));
  assert.ok(citedReportConflicts(text.replace('+25','+20'),context).some(f=>f.expected==='25'));
});

test('joint recalculations require the matching inputs, currency, result, and workbook revision',()=>{
  const price=cell('V!C3',160,'元/股','NAV',{currency:'HKD',sha256:'sample-revision'});
  const inputs=[cell('V!A1',8,'倍','生产'),cell('V!A2',9,'倍','服务')];
  const details={path:'uploads/input.xlsx',sourceSha256:price.sha256,recalculated:true,
    inputs:inputs.map((c,i)=>({cell:c.locator,value:5+i})),results:[{cell:price.locator,before:160,after:121}]};
  const call={name:'model_whatif',id:'trial',success:true,details};
  const text='按5/6倍重算为121港元。两项同调的结果是121港元。';
  const check=(body,executions=[call],sources=[price,...inputs])=>errors(body,sources,executions).filter(f=>f.claim?.value==='121');
  assert.deepEqual(check(text),[]);assert.deepEqual(check(text,[call,{...call,id:'repeat'}]),[]);
  for(const bad of [text.replace('5/6','6/5'),text.replaceAll('港元','美元'),'两项同调的结果是121港元。','原模型基准为121港元。'])assert.ok(check(bad).length,bad);
  for(const altered of [{...call,success:false},{...call,details:{...details,sourceSha256:'other'}},
    {...call,details:{...details,results:[{cell:price.locator,before:99,after:121}]}}])assert.ok(check(text,[altered]).length);
  assert.ok(check(text,[call,{...call,id:'conflicting',details:{...details,results:[{cell:price.locator,before:160,after:110}]}}]).length);
  assert.ok(citedReportConflicts('模型目标价999港元（[输入.xlsx]V!C3）。',{citations:[price],toolCalls:[call]}).length);
  assert.deepEqual(citedReportConflicts('模型目标价160港元（[输入.xlsx]V!C3）。',{citations:[price],toolCalls:[call]}),[]);
  const cash=cell('V!B1',500,'百万元','收入',{currency:'CNY',sha256:price.sha256});
  const margins=['P!A1','P!A2'].map(ref=>cell(ref,0.12,'decimal','利润率'));
  const result=financialEvidenceFindings('按5/6%重算为590百万元。',{citations:[cash,...margins],toolCalls:[{...call,details:{...details,
    inputs:margins.map((m,i)=>({cell:m.locator,value:(5+i)/100})),results:[{cell:cash.locator,before:500,after:590}]}}]},[]);
  assert.ok(!result.some(f=>f.claim?.value==='590' && f.severity==='error'));
});

test('the report handoff requires this turn and both current saved revisions',()=>{
  const path='exports/demo/report.md',state='exports/demo/analysis-state.json',content='经过审校的研究报告。';
  const hash=createHash('sha256').update(content).digest('hex'),question='保存报告到 '+path+'，将观点写入 '+state+'。';
  const draft={path,content,saved:true,saveRequested:true,issues:[],reviewedHash:hash,stateBinding:{reportHash:hash,stateHash:'state'}};
  const files=[{path,saved:true,sha256:hash},{path:state,saved:true,sha256:'state'}];
  const history=[{role:'user',content:question},{role:'assistant',content:[{type:'toolCall',id:'save',name:'review_research',arguments:{path}}]},
    {role:'toolResult',toolCallId:'save',isError:false,content:[{type:'text',text:'[research_write_verified] '+path+' sha256='+hash}]}];
  const approved=(q=question,d=draft,f=files,m=history)=>reviewedReportForAnswer(q,d,f,m);
  assert.equal(approved(),draft);
  assert.equal(approved('保存研究报告，并生成状态文件。'),draft);
  assert.equal(approved(question+'另写 exports/demo/other.md。'),null);
  assert.equal(approved(question+'聊天仅给摘要。'),null);
  for(const patch of [{content:content+'新增结论'},{saved:false},{issues:['未解决']},{reviewedHash:null}])assert.equal(approved(question,{...draft,...patch}),null);
  assert.equal(approved(question,draft,[files[0],{...files[1],sha256:'changed'}]),null);
  assert.equal(approved(question,draft,files,[...history,{role:'user',content:question}]),null);
  assert.equal(approved(question,draft,files,[...history,{role:'toolResult',toolCallId:'new'}]),null);
});

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
