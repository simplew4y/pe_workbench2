import { createHash } from 'node:crypto';
import { sourceEvidence } from '../lib/research-delivery.mjs';
import assert from 'node:assert/strict';
import { queryGraph } from '../lib/workbook-query.mjs';
import { financialEvidenceFindings } from '../lib/financial-evidence.mjs';
import { runWithPostAnswer } from '../server/agent/post-answer.mjs';
import { researchTaskInstructions } from '../lib/research-task.mjs';

// Real Tencent layout, reduced to the conflicting headings and target output.
const headings = [['SOTP!B1', null, 'USD to RMB', 1, 2], ['SOTP!J2', null, 'HK$/sh', 2, 10],
  ['SOTP!I2', null, 'Rmb/sh', 2, 9], ['SOTP!E2', null, 'Valuation US$mn', 2, 5]];
const graph = {sheets:[{name:'SOTP',contextCells:headings,rowLabels:{134:'NAV'}}],edges:[],
  cells:[['SOTP!J134','=ROUNDUP(J132+J133,0)',752,134,10,'NAV','HK$/sh'],
    ['SOTP!I134','=ROUND(I132+I133,0)',689,134,9,'NAV','Rmb/sh'],
    ['SOTP!E134','=H134/C1',100,134,5,'NAV','Valuation US$mn']]};
const cell = queryGraph(graph,'SOTP!J134',{maxCells:1}).cells[0];
assert.equal(cell.currency,'HKD'); assert.equal(cell.display_unit,'元/股');
assert.equal(queryGraph(graph,'SOTP!I134',{maxCells:1}).cells[0].currency,'CNY');
assert.equal(queryGraph(graph,'SOTP!E134',{maxCells:1}).cells[0].display_unit,'百万元');
const unknown = structuredClone(graph); unknown.sheets[0].contextCells = [headings[0]]; unknown.cells[0][6]='';
assert.equal(queryGraph(unknown,'SOTP!J134',{maxCells:1}).cells[0].currency,'');
const cite={id:'target',materialId:'book',version:1,filename:'腾讯估值模型.xlsx',locator:'SOTP!J134',
  value:752,display_unit:cell.display_unit,raw_unit:cell.unit,currency:cell.currency,basis_type:'forecast',metric:'NAV'};
const answer='模型目标价为752港元/股（[腾讯估值模型.xlsx]SOTP!J134）。';
const context={question:'为什么目标价偏离现价？解释关键假设和下行情景。',citations:[cite],toolCalls:[]};
assert.deepEqual(financialEvidenceFindings(answer,context,[]),[]);
assert.ok(financialEvidenceFindings(answer.replace('752','999'),context,[]).some(f=>f.field==='value'));
assert.ok(financialEvidenceFindings(answer.replace('港元','美元'),context,[]).some(f=>f.field==='currency'));
assert.ok(financialEvidenceFindings('实际'+answer,context,[]).some(f=>f.field==='basis_type'));
const income={...cite,id:'income',locator:'SOTP!J8',metric:'收入',value:100,display_unit:'亿元',raw_unit:'亿元',currency:'CNY',period:'2026E'};
assert.ok(financialEvidenceFindings('收入为100亿元（[腾讯估值模型.xlsx]SOTP!J8）。',
  {question:'2025年实际收入是多少？',citations:[income]},[]).some(f=>f.field==='period'));
assert.equal(researchTaskInstructions('收入是多少？'),'');
assert.match(researchTaskInstructions(context.question),/改变判断/);

// Exercise the actual delivery lifecycle without external models or project data.
async function deliver(drafts, question, thinking = false, source = cite, verification = null, toolFailure = null) {
 const records=[],requests=[]; let index=0;
 const messages=[{role:'assistant',content:[{type:'toolCall',id:'prior',name:'workbook_query',arguments:{}}]}];
 const levels=[];
 const session={messages,...(thinking?{model:{reasoning:true},thinkingLevel:'off',setThinkingLevel(level){levels.push(level);this.thinkingLevel=level;}}:{}),sessionManager:{appendCustomEntry(type,data){records.push({type,data});}},
  async prompt(){
   if (thinking) assert.equal(this.thinkingLevel,'high');
   const text=drafts[index++]; assert.notEqual(text,undefined,'recovery must be bounded');
   messages.push({role:'assistant',content:[{type:'toolCall',id:'read-'+index,name:'workbook_query',arguments:{}}]},
    {role:'toolResult',toolName:'workbook_query',toolCallId:'read-'+index,isError:false,content:[{type:'text',text:'source'}],details:{citations:[source]}},
    ...(toolFailure?[{role:'assistant',content:[{type:'toolCall',id:'failed-'+index,name:toolFailure,arguments:{}}]},{role:'toolResult',toolCallId:'failed-'+index,toolName:toolFailure,isError:true,content:[{type:'text',text:'tool unavailable'}]}]:[]),
     {role:'assistant',stopReason:'stop',content:[{type:'text',text}],...(verification?{researchVerification:{status:verification.status,draftHash:createHash('sha256').update(verification.wrongHash?'different draft':text).digest('hex')}}:{})});
  },
  async sendCustomMessage(message,options){requests.push(message);if(options.triggerTurn)await this.prompt();}
 };
 const record=await runWithPostAnswer({session},question);
 return {record,records,requests,index,levels,thinkingLevel:session.thinkingLevel};
}
const explanation='这一判断取决于盈利增长能否兑现。模型估值不能单独证明市场错误，需要进一步比较增长持续性和资本回报。';
const complete=answer+'\n\n'+explanation+'\n\n未核验：估值倍数的外部可比依据。';
const kept=await deliver([complete],context.question);
assert.equal(kept.record.status,'partial');assert.equal(kept.record.text,'> **待复核**\n\n'+complete);
const wrong=answer.replace('752','999')+'\n\n'+explanation.repeat(5);
const repaired=await deliver([wrong,wrong,complete],context.question);
assert.equal(repaired.record.text,'> **待复核**\n\n'+complete); assert.equal(repaired.index,3);
assert.equal(repaired.requests.filter(r=>r.customType==='pe_answer_recover').length,1);
const rejected=await deliver([wrong,wrong,wrong],context.question);
assert.notEqual(rejected.record.status,'completed');assert.ok(!rejected.record.text.includes('999'));assert.equal(rejected.index,3);
console.log('PASS currency/identity positives and negatives; complete partial answer; bounded audited recovery');

const evidence=[{role:'user',content:'分析公司估值和收入假设'},
 {role:'toolResult',toolName:'web_fetch',toolCallId:'filing',content:'财报原始披露'},
 {role:'toolResult',toolName:'workbook_trace',toolCallId:'model',content:'SOTP!J134=752'},
 ...Array.from({length:12},(_,i)=>({role:'toolResult',toolName:'calc',toolCallId:'calc-'+i,content:'计算结果'})),
 {role:'toolResult',toolName:'web_fetch',toolCallId:'failed',isError:true,content:'错误来源'}];
const selected=sourceEvidence(evidence,answer);
assert.ok(selected.some(s=>s.id==='filing'));assert.ok(selected.some(s=>s.id==='model'));
assert.ok(selected.some(s=>s.tool==='calc'));assert.ok(!selected.some(s=>s.id==='failed'));assert.ok(selected.length<=8);
console.log('PASS recovery retains early external/model evidence alongside calculations');

const rounded={...cite,value:752.123};
assert.deepEqual(financialEvidenceFindings(answer.replace('为752','约752'),{...context,citations:[rounded]},[]),[]);
assert.deepEqual(financialEvidenceFindings(answer,{...context,citations:[rounded]},[]),[]);
assert.ok(financialEvidenceFindings(answer.replace('为752','约750'),{...context,citations:[rounded]},[]).length);
const supplied={question:'把现价固定为题设400港元/股，不查实时行情。',citations:[]};
assert.deepEqual(financialEvidenceFindings('题设现价400港元/股。',supplied,[]),[]);
assert.ok(financialEvidenceFindings('题设现价500港元/股。',supplied,[]).length);
assert.ok(financialEvidenceFindings('最新现价400港元/股。',supplied,[]).length);
console.log('PASS explicit rounding and exact user-supplied price; wrong/unqualified prices rejected');

// Regression: sheet names and formula constants are not metric/value claims.
const {lintFactIdentity}=await import('../lib/fact-memory/context.mjs');
const memory={query:()=>({facts:[{metric:'Revenue',period:'2026',raw_value:6339,raw_unit:'百万元',canonical_value:6339000000,canonical_unit:'元',currency:'CNY',quality:'source_checked'}]})};
assert.deepEqual(lintFactIdentity('API单价增长71.4%（Revenue!J44）。',memory),[]);
assert.ok(lintFactIdentity('2026年收入为1百万元。',memory).length);
const unrelated={...cite,id:'other',locator:'SOTP!J95',value:38.98,metric:'Investment'};
const gaps=financialEvidenceFindings('目标价为999港元/股。',{question:'分析估值',citations:[unrelated]},[]);
assert.ok(gaps.length);assert.ok(!gaps.some(g=>g.expected==='38.98'));
assert.deepEqual(financialEvidenceFindings('模型目标价为752港元/股（[腾讯估值模型.xlsx]SOTP!J134），公式 `=ROUND(SOTP!J134,0)`。',context,[]),[]);
const {researchExecutionGaps}=await import('../lib/research-task.mjs');
assert.equal(researchExecutionGaps('请独立复核业务假设，用可查证据说明。',[]).length,1);
assert.equal(researchExecutionGaps('请独立复核业务假设，用可查证据说明。',[{name:'westock_query',success:true}]).length,1);
assert.equal(researchExecutionGaps('请独立复核业务假设，用可查证据说明。',[{name:'web_fetch',success:true}]).length,0);
assert.equal(researchExecutionGaps('不联网，独立复核业务假设，用可查证据说明。',[]).length,0);
console.log('PASS source-local identity, formula masking, no unrelated corrections, actual research execution gate');

const {researchFailureMessage}=await import('../server/agent/post-answer.mjs');
assert.match(researchFailureMessage('402: Insufficient Balance'),/余额不足/);
assert.ok(!researchFailureMessage('402: Insufficient Balance').includes('核验失败'));
const missingMetadata=financialEvidenceFindings(answer,{...context,citations:[{...cite,currency:'',raw_unit:'unit_unknown',display_unit:'unit_unknown'}]},[]);
assert.ok(missingMetadata.some(f=>f.evidenceStatus==='metadata_missing' && f.claim.value==='752' && f.evidenceIds.includes('target')));
console.log('PASS structured diagnostics and honest provider failure messages');

assert.deepEqual(financialEvidenceFindings('按题设400港元/股，模型目标价为752港元/股（[腾讯估值模型.xlsx]SOTP!J134）。',
 {question:'把现价固定为题设400港元/股。',citations:[cite]},[]),[]);
assert.ok(financialEvidenceFindings('按题设500港元/股，模型目标价为752港元/股（[腾讯估值模型.xlsx]SOTP!J134）。',
 {question:'把现价固定为题设400港元/股。',citations:[cite]},[]).length);
console.log('PASS compound sentence does not attach model citation to user price');

// Adjacent source/value pairs must prefer the source immediately before the number.
const pair=[{...cite,id:'fx1',locator:'SOTP!C1',value:7.15,metric:'',currency:'',raw_unit:'',display_unit:''},
 {...cite,id:'fx2',locator:'SOTP!E1',value:7.8,metric:'',currency:'',raw_unit:'',display_unit:''}];
assert.deepEqual(financialEvidenceFindings('SOTP!C1=7.15、SOTP!E1=7.8。',{citations:pair},[]),[]);
assert.ok(financialEvidenceFindings('SOTP!C1=7.8、SOTP!E1=7.15。',{citations:pair},[]).length);
console.log('PASS adjacent citation/value pairs retain their own source');

assert.equal(researchExecutionGaps('请独立复核业务假设，用可查证据说明。',[{name:'deepseek_search',success:true}]).length,1);

const displaySource={...cite,id:'investment',locator:'SOTP!J126',metric:'Investment',value:121.99769311019465};
assert.deepEqual(financialEvidenceFindings('SOTP!J126=122.00港元/股。',{citations:[displaySource]},[]),[]);
assert.ok(financialEvidenceFindings('SOTP!J126=122.01港元/股。',{citations:[displaySource]},[]).length);
const revenueSource={...income,metric:'Total Marketing services revenue'};
assert.deepEqual(financialEvidenceFindings('广告收入为100亿元（SOTP!J8）。',{citations:[revenueSource]},[]),[]);
assert.ok(financialEvidenceFindings('净利润为100亿元（SOTP!J8）。',{citations:[revenueSource]},[]).length);
assert.deepEqual(financialEvidenceFindings('SOTP!J126 `=SUM(J100:J125)` =122.00港元/股，模型目标价 SOTP!J134=752港元/股。',{citations:[displaySource,cite]},[]),[]);
console.log('PASS ordinary rounding, financial label synonyms, formula-separated source/value binding');

const linked=structuredClone(graph);
linked.cells.push(['SOTP!H1','=+J134',752,1,8,'','']);
linked.edges.push(['SOTP!J134','SOTP!H1']);
assert.equal(queryGraph(linked,'SOTP!H1',{maxCells:1}).cells[0].currency,'HKD');
const arithmetic=structuredClone(linked);arithmetic.cells.at(-1)[1]='=J134/7.8';
assert.equal(queryGraph(arithmetic,'SOTP!H1',{maxCells:1}).cells[0].currency,'');
const cycle={sheets:[{name:'Sheet',contextCells:[]}],cells:[['Sheet!A1','=A2',1,1,1,'',''],['Sheet!A2','=A1',1,2,1,'','']],edges:[['Sheet!A1','Sheet!A2'],['Sheet!A2','Sheet!A1']]};
assert.equal(queryGraph(cycle,'Sheet!A1',{maxCells:1}).cells[0].currency,'');
console.log('PASS pure aliases inherit units; arithmetic and cycles do not invent them');

const filingUrl='https://example.com/filing.pdf?id=12345';
const externalContext={question:'独立复核估值假设',citations:[],toolCalls:[{id:'filing',name:'web_fetch',success:true,args:{url:filingUrl},result:{content:[{type:'text',text:'本期毛利率为26.4%，与上年持平。'}]}}]};
const disclosed=`公司毛利率为26.4%（[原始披露](${filingUrl})）。`;
assert.deepEqual(financialEvidenceFindings(disclosed,externalContext,[]),[]);
assert.ok(financialEvidenceFindings(disclosed.replace('26.4%','62.4%'),externalContext,[]).length);
assert.ok(financialEvidenceFindings(disclosed,{...externalContext,toolCalls:[{...externalContext.toolCalls[0],success:false}]},[]).length);
assert.ok(financialEvidenceFindings(disclosed,{...externalContext,toolCalls:[{...externalContext.toolCalls[0],name:'deepseek_search'}]},[]).length);
assert.ok(financialEvidenceFindings(disclosed.replace('example.com','other.com'),externalContext,[]).length);
console.log('PASS fetched, explicitly linked disclosure quantities; failed/search/unrelated sources cannot certify claims');

const scenarioSource={...cite,storedFilename:'book.xlsx'};
const scenarioCall={name:'model_whatif',success:true,result:{details:{path:'uploads/book.xlsx',recalculated:true,results:[{cell:'SOTP!J134',before:752,after:665}]}}};
const scenarioContext={citations:[scenarioSource],toolCalls:[scenarioCall]};
assert.deepEqual(financialEvidenceFindings('下行情景目标价为665港元/股（SOTP!J134）。',scenarioContext,[]),[]);
assert.ok(financialEvidenceFindings('模型原目标价为665港元/股（SOTP!J134）。',scenarioContext,[]).length);
assert.ok(financialEvidenceFindings('下行情景目标价为666港元/股（SOTP!J134）。',scenarioContext,[]).length);
assert.ok(financialEvidenceFindings('下行情景目标价为665港元/股（SOTP!J134）。',{...scenarioContext,toolCalls:[{...scenarioCall,success:false}]},[]).length);
assert.ok(financialEvidenceFindings('下行情景目标价为665港元/股（SOTP!J134）。',{...scenarioContext,citations:[{...scenarioSource,storedFilename:'other.xlsx'}]},[]).length);
console.log('PASS successful recalculated scenario outputs are distinct from original workbook values');

assert.ok(financialEvidenceFindings('敏感性分析：原模型目标价为665港元/股（SOTP!J134）。',scenarioContext,[]).length);

const freshIncome={...income,value:100};
assert.deepEqual(lintFactIdentity('2026年收入为100亿元（SOTP!J8）。',memory,{citations:[freshIncome]}),[]);
assert.ok(financialEvidenceFindings('2026年收入为999亿元（SOTP!J8）。',{citations:[freshIncome]},[]).length);
assert.ok(lintFactIdentity('2026年收入为1百万元。',memory).length);
console.log('PASS fresh explicit observations use source validation; conflicting numbers and unsupported memory claims still fail');

const researchMode=await deliver([complete],context.question,true);
assert.deepEqual(researchMode.levels,['high']);assert.equal(researchMode.thinkingLevel,'high');
const lookupMode=await deliver([answer],'目标价是多少？',true);
assert.deepEqual(lookupMode.levels,['high']);assert.equal(lookupMode.thinkingLevel,'high');
const vagueMode=await deliver([answer],'看一下这个文件',true);
assert.deepEqual(vagueMode.levels,['high']);assert.equal(vagueMode.thinkingLevel,'high');
console.log('PASS reasoning defaults on for research, lookups and vague file requests, including restored off sessions');

const percentageGraph={sheets:[{name:'PL',numberFormats:{B2:'0.0%',B3:'0"%"',B4:'0\\%'},contextCells:[['PL!A1',null,'Rmb mn',1,1,'','']]}],edges:[],cells:[['PL!B2',null,.0913375,2,2,'YoY',''],['PL!B3',null,20,3,2,'Revenue',''],['PL!B4',null,20,4,2,'Revenue','']]};
const percentCell=queryGraph(percentageGraph,'PL!B2',{maxCells:1}).cells[0];
assert.equal(percentCell.unit,'decimal');assert.equal(percentCell.display_unit,'%');assert.equal(percentCell.currency,'');assert.match(percentCell.display,/9\.134%/);
assert.notEqual(queryGraph(percentageGraph,'PL!B3',{maxCells:1}).cells[0].unit,'decimal');
assert.notEqual(queryGraph(percentageGraph,'PL!B4',{maxCells:1}).cells[0].unit,'decimal');
const percentCitation={...cite,id:'growth',locator:'PL!B2',metric:'',currency:'',value:percentCell.value,raw_unit:percentCell.unit,display_unit:percentCell.display_unit};
assert.deepEqual(financialEvidenceFindings('模型同比为9.134%（PL!B2）。',{citations:[percentCitation]},[]),[]);
assert.ok(financialEvidenceFindings('模型同比为0.091%（PL!B2）。',{citations:[percentCitation]},[]).length);
console.log('PASS actual Excel percentage format survives parsing; quoted/escaped percent literals do not scale values');

const {boundedResearchOptions}=await import('../lib/research-audit.mjs');
assert.deepEqual(boundedResearchOptions({reasoning:true,maxTokens:384000},{reasoning:'high'},4000),{reasoning:'low',maxTokens:16000});
assert.deepEqual(boundedResearchOptions({reasoning:true},{},5000),{maxTokens:5000});
assert.deepEqual(boundedResearchOptions({reasoning:false},{},4000),{maxTokens:4000});
console.log('PASS reasoning-aware audit/recovery budgets retain room for visible output');

const {auditRequestOptions}=await import('../lib/research-audit.mjs');
const auditSignal=new AbortController().signal;
assert.deepEqual(auditRequestOptions({reasoning:'high',signal:auditSignal}),{reasoning:'off',signal:auditSignal,maxTokens:5000});
console.log('PASS bounded audit disables hidden reasoning while preserving cancellation');

const {quantityIssues}=await import('../lib/research-quantities.mjs');
const operatingGraph={sheets:[{name:'IS',rowLabels:{1:'Year to 31 Dec, Rmb mn',120:'Gross margin',133:'Operating profit, GAAP, new def'},contextCells:[['IS!B1',null,'Year to 31 Dec, Rmb mn',1,2]]}],edges:[],cells:[['IS!AE133','=AE99+SUM(AE125:AE126,AE130)',277541.9147,133,31,'Operating profit, GAAP, new def','2026E']]};
const operating=queryGraph(operatingGraph,'IS!AE133',{maxCells:1}).cells[0];
assert.equal(operating.metricContext.label,'Operating profit, GAAP, new def');
assert.equal(operating.amount.unit,'百万元');
assert.deepEqual(quantityIssues('比集团经营利润277542百万元（IS!AE133）高13.3%',[operating]),[]);
assert.ok(quantityIssues('经营利润277542亿元（IS!AE133）',[operating]).length);
console.log('PASS GAAP operating profit ends inherited margin section and keeps monetary units');

const qualifiedDelivery=await deliver([answer+'\n\n'+explanation],context.question,false,{...cite,currency:'',raw_unit:'元/股',display_unit:'元/股'});
assert.equal(qualifiedDelivery.record.status,'completed');
assert.ok(qualifiedDelivery.record.text.includes(explanation));
assert.match(qualifiedDelivery.record.text,/证据边界/);
console.log('PASS delivery completeness stays separate from visible metadata uncertainty');

const proseEvidence='公司披露收入为10亿元。'+explanation.repeat(5);
const reviewedProse=await deliver([proseEvidence],context.question,false,cite,{status:'reviewed'});
assert.equal(reviewedProse.record.status,'completed');
assert.ok(reviewedProse.record.text.includes('10亿元'));
assert.match(reviewedProse.record.text,/证据边界/);
for(const verification of [{status:'limited'},{status:'reviewed',wrongHash:true}]) {
 const limited=await deliver([proseEvidence,proseEvidence,proseEvidence],context.question,false,cite,verification);
 assert.notEqual(limited.record.status,'completed');
 assert.ok(!limited.record.text.includes('10亿元'));
}
const reviewedConflict=await deliver([wrong,wrong,wrong],context.question,false,cite,{status:'reviewed'});
assert.notEqual(reviewedConflict.record.status,'completed');
assert.ok(!reviewedConflict.record.text.includes('999'));
console.log('PASS only exact-draft complete semantic review can qualify parser misses; limited/stale receipts and real conflicts remain blocked');

const failedScenario=await deliver([answer+'\n\n'+explanation],context.question,false,cite,null,'model_whatif');
assert.equal(failedScenario.record.status,'partial');
assert.ok(failedScenario.record.text.startsWith(answer+'\n\n'+explanation));
assert.match(failedScenario.record.text,/有一项模型情景重算未成功/);
assert.ok(!failedScenario.record.text.includes('仍待核实**：。'));
assert.equal(failedScenario.index,1);
console.log('PASS failed supplementary scenario keeps the entire validated research answer and explains its limit');
