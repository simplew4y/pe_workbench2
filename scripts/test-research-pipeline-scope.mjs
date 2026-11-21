import { parseLimitAssessments } from '../lib/research-limit-scope.mjs';
import { auditRequestOptions } from '../lib/research-audit.mjs';
import { informationCutoff } from '../lib/research-contract.mjs';
import { researchRecoveryToolEvidence } from '../lib/research-delivery.mjs';
import { calculateUserScenario, scenarioAmountEvidence } from '../lib/scenario-calculation.mjs';
import { guardResearchDelivery, researchAnswerContext } from '../lib/research-delivery.mjs';
import { getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';
import { accountingReasoningIssues } from '../lib/research-reasoning.mjs';
import { isResearchQuestion } from '../lib/research-task.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { researchContract } from '../lib/research-contract.mjs';
import { auditTimeline, resolvedToolFailures, historicalSourceCalls } from '../lib/research-evidence-scope.mjs';
import { AUDIT_CHECKS, auditResearch } from '../lib/research-audit.mjs';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { financialEvidenceFindings } from '../lib/financial-evidence.mjs';
import { researchExecutionGaps } from '../lib/research-task.mjs';
import { extractRemotePdf, selectPdfPages } from '../lib/remote-pdf.mjs';
import { execFileSync } from 'node:child_process';
const pass={checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass'])),issues:[]};
const stream=text=>{const s=createAssistantMessageEventStream(),m={role:'assistant',stopReason:'stop',content:[{type:'text',text}]};s.push({type:'done',reason:'stop',message:m});s.end();return s;};
assert.equal(researchContract('如何检验增长？列所需数据。').method,true);
assert.equal(researchContract('依据公司年报列关键事实及官方出处。').originalSources,true);
assert.equal(researchContract('解释毛利率，不用当前股价。').marketRequested,false);
assert.equal(researchContract('只把折现率改8%，其他不变。','虚构公司，仅用题设，不联网。').noNetwork,true);
assert.equal(researchExecutionGaps('依据公司年报列关键事实及官方出处。',[]).length,1);
assert.equal(researchExecutionGaps('依据公司年报列关键事实及官方出处。',[{name:'pdf_read',success:true,result:{isError:false}}]).length,0);
const timeline=[{role:'toolResult',toolCallId:'bad',isError:true,text:'fetch failed'},
 {role:'toolResult',toolCallId:'good',toolName:'web_fetch',isError:false,text:'Revenue 37 million'},
 {role:'toolResult',toolCallId:'large',isError:false,text:'前文'.repeat(90000)},
 {role:'user',text:'解释增长'}];
const bounded=auditTimeline(timeline);assert(bounded.some(x=>x.toolCallId==='good'));assert(bounded.some(x=>x.toolCallId==='large' && x.truncated));
const items=[{id:'bad',disposition:'replaced',evidenceIds:['good'],reason:'same document'},
 {id:'bad',disposition:'replaced',evidenceIds:['invented'],reason:'fake'},
 {id:'invented',disposition:'outside_scope',reason:'fake'}];
assert.deepEqual(resolvedToolFailures(items,timeline),[items[0]]);
const gap='账龄和客户合同需要后续调研';const draft='应检查账龄和交易真实性。\n未核验：'+gap+'。';
let payload;
const review=await auditResearch((_m,c)=>{payload=JSON.parse(c.messages[0].content[0].text);return stream(JSON.stringify({...pass,answeredLimits:[gap,'伪造'],resolvedToolFailures:items}));},{},{messages:[]},{},draft,{question:'解释风险判断的方法。'});
assert.deepEqual(payload.limitsToClassify,[gap]);assert.deepEqual(review.answeredLimits,[gap]);
const required=await auditResearch(()=>stream(JSON.stringify({...pass,answeredLimits:[gap]})),{},{messages:[]},{},draft,{question:'查实客户合同并提供原文。'});
assert.equal(required.answeredLimits,undefined);
const url='https://issuer.example/annual';const c={type:'toolCall',id:'source',name:'web_fetch',arguments:{url}};
const result={role:'toolResult',toolCallId:'source',toolName:'web_fetch',isError:false,content:[{type:'text',text:'公司2023年收入37亿元。'}]};
const history=[{role:'assistant',content:[c]},result];const sources=historicalSourceCalls(history);
assert.equal(sources.length,1);assert.equal(historicalSourceCalls(history,'最新收入是多少').length,0);
assert.equal(historicalSourceCalls([{role:'assistant',content:[{type:'text',text:'收入37亿元。'}]}]).length,0);
assert.equal(historicalSourceCalls([history[0],{...result,isError:true}]).length,0);
const answer=`2023年收入37亿元。相关披露见[年报](${url})。`;
assert.equal(financialEvidenceFindings(answer,{sourceCalls:sources},[]).filter(f=>f.rule==='unsourced_number').length,0);
assert(financialEvidenceFindings(answer.replace('37','73'),{sourceCalls:sources},[]).some(f=>f.rule==='unsourced_number'));
assert(financialEvidenceFindings(answer.replace(url,'https://other.example/annual'),{sourceCalls:sources},[]).some(f=>f.rule==='unsourced_number'));
// Real parser roundtrip, not just mocked PDF extraction.
const pdf=execFileSync('python3',['-c','import pymupdf as fitz,sys; d=fitz.open(); p=d.new_page(); p.insert_text((40,40),"Revenue 37 million"); sys.stdout.buffer.write(d.tobytes())']);
const pages=await extractRemotePdf(pdf);assert.equal(pages[0].page,1);assert.match(pages[0].text,/Revenue 37 million/);
console.log('PASS research task scope, audited limits, failure receipts, source reuse, bounded context and real remote PDF parsing');

assert.deepEqual(selectPdfPages([{page:1,text:'封面'},{page:2,text:'會 員複購率及存貨'}],'会员 存货',1000).pages,[2]);

const {runWithPostAnswer}=await import('../server/agent/post-answer.mjs');
for(const valid of [true,false]) {
  const text='应比较订单取消情况与现金回收，分别验证需求和履约。\n未核验：客户合同需后续调研。';
  const session={messages:[],async prompt(){this.messages.push({role:'assistant',stopReason:'stop',content:[{type:'text',text}],
    researchVerification:{status:'reviewed',draftHash:createHash('sha256').update(valid?text:'旧稿').digest('hex')},
    researchAnsweredLimits:['客户合同需后续调研']});}};
  const record=await runWithPostAnswer({session},'如何检验需求质量？给出所需证据。');
  assert.equal(record.status,valid?'completed':'partial');
  if(valid)assert.doesNotMatch(record.text,/未核验：/);
}
console.log('PASS exact-body review receipts classify future research needs; stale receipts cannot clear a gap');

// General formulations and changed inputs: no fixture-specific answers.
for(const question of ['预收款能直接代表需求吗？列混杂因素及所需数据。','自用与外供的毛利率分别受什么影响？','合同增长意味着什么？']) assert(isResearchQuestion(question),question);
assert(!isResearchQuestion('谢谢'));
const cleanTimeline=auditTimeline([{role:'assistant',text:'已删除的错误草稿'}, {role:'assistant',text:'旧草稿',calls:[{name:'calc',arguments:{expression:'9/3'}}]}, {role:'user',text:'请继续'}]);
assert(!JSON.stringify(cleanTimeline).includes('旧草稿'));assert(!JSON.stringify(cleanTimeline).includes('已删除'));
assert(cleanTimeline.some(m=>m.calls?.[0]?.name==='calc'));
const scenario={question:'虚构公司，收入从200增至250，存货从30增至50，仅用题设分析。'};
assert(accountingReasoningIssues('存货周转天数从55天增至73天。',scenario).length);
assert(!accountingReasoningIssues('缺少营业成本，不能计算存货周转天数。',scenario).length);
assert(!accountingReasoningIssues('存货周转天数73天。',{question:'虚构公司，营业成本250，平均存货50。'}).length);
assert(!accountingReasoningIssues('存货周转天数73天。',{question:'依据公司年报分析。'}).length);
const tax={question:'虚构公司，存货减值8，当期税务可扣除，税率20%。'};
assert(accountingReasoningIssues('经营现金流增加1.6。',tax).length);
assert(accountingReasoningIssues('经营现金流由10变为11.6。',tax).length);
assert(!accountingReasoningIssues('若本期实际少缴现金税，经营现金流增加1.6；否则仅凭税务可扣除无法确定。',tax).length);
assert(!accountingReasoningIssues('经营现金流增加1.6。',{question:tax.question+'明确本期实际少缴税1.6。'}).length);
assert(accountingReasoningIssues('存货已经付款，本期不影响现金。',tax).length);
assert(!accountingReasoningIssues('减值是非现金调整，但不能确定采购是否已经付款。',tax).length);
assert(accountingReasoningIssues('利润减少6.4亿元。',tax).length);
assert(!accountingReasoningIssues('利润减少6.4亿元。',{question:tax.question+'金额单位亿元。'}).length);
const faultyAudit=await auditResearch(()=>stream(JSON.stringify(pass)),{},{messages:[{role:'user',content:tax.question}]},{},'经营现金流增加1.6。',tax);
assert(!faultyAudit.ok);assert(faultyAudit.issues.some(i=>i.check==='conclusion_strength'));
console.log('reasoning guards and draft isolation passed');

for(const q of ['不虚构分部现金流','不要虚构公司数据','不得凭空假设公司营收','并非虚构公司，请核对年报','如何检验增长？按年报可直接取得、需额外调研、不可判断组织证据，不虚构现金流。']) {
 assert(!researchContract(q).hypothetical,q);
 assert(!accountingReasoningIssues('年报收入125亿元。',{question:q}).length,q);
}
assert(researchContract('虚构公司，按给定条件计算。').hypothetical);
assert(researchContract('指出FCFF计算错误。','假设公司基期FCFF80。').hypothetical);
const fixtureReceipt={receipt:{inputs:{discount:{value:'7%'},testedDiscount:{value:'11%'}},outputs:{},activeInputs:{discount:'testedDiscount'}}};
assert(scenarioAmountEvidence('WACC11%','WACC','11','%',fixtureReceipt).matches);
assert(!scenarioAmountEvidence('WACC7%','WACC','7','%',fixtureReceipt).matches);
assert(scenarioAmountEvidence('原情景WACC7%','原情景WACC','7','%',fixtureReceipt).matches);
const calcBase='假设公司基期FCFF80，未来1至3年每年增10%，第3年后永续增长3%，WACC7%，净债务150，股数200，现金流年末发生。DCF计算企业价值、每股价值和终值占比，列公式。';
const calcNext='只把WACC改11%，其他不变，重算企业价值、每股价值及相对原情景变化。';
const calcQuestion='有人用第3年FCFF直接除以WACC减永续增速，忘乘1.03。指出错误，并计算在WACC11%时对每股价值造成的差额。';
const calculated=calculateUserScenario(calcQuestion,[calcBase,calcNext]);
assert.equal(calculated.receipt.activeInputs.discount,'testedDiscount');
assert(scenarioAmountEvidence('WACC11%','WACC','11','%',calculated).matches);
for(const ok of [true,false]) {
 const text='回款改善仍需结合账龄。';
 const guarded=guardResearchDelivery(()=>stream(text),{getCompactAnswer:()=>({prompt:'压缩解释',verifyAnswer:true}),audit:async()=>({ok,issues:ok?[]:[{check:'coverage',excerpt:text,reason:'需要证据'}],answeredLimits:['账龄'],resolvedToolFailures:[{id:'x',disposition:'outside_scope',reason:'unrelated'}]})});
 const result=await (await guarded({},{messages:[{role:'user',content:'分析回款质量。'}]},{})).result();
 if(ok) {assert.equal(result.researchVerification.draftHash,createHash('sha256').update(text).digest('hex'));assert.equal(result.researchVerification.status,'reviewed');assert.equal(result.researchResolvedToolFailures.length,1);}
 else assert.equal(result.researchVerification,undefined);
}
const toolContext={tools:[{name:'write'},{name:'edit'},{name:'review_research'},{name:'web_fetch'},{name:'calc'},{name:'framework_commit'}],messages:[]};
assert.deepEqual(getCurrentTools(normalizeContext(researchAnswerContext(toolContext,'建立投资框架，说明风险。')).messages).map(t=>t.name),['web_fetch','calc','framework_commit']);
assert.equal(researchAnswerContext(toolContext,'生成研究报告并保存。'),toolContext);
assert.equal(researchAnswerContext(toolContext,'修改模型并分析影响。'),toolContext);
const transcriptTools={messages:[{role:'system',toolsAdded:toolContext.tools,content:'Research policy'}]};
assert(!getCurrentTools(normalizeContext(researchAnswerContext(transcriptTools,'分析投资框架。')).messages).some(t=>t.name==='write'));
console.log('PASS negation scope, active scenario binding, compaction receipts and answer-only tool declarations');

const middleFact='原文关键指标67.2%，统计口径为年度购买两次以上客户';
const sourceText='前部资料'.repeat(1800)+middleFact+'后部资料'.repeat(1800);
const sourceMessage={role:'toolResult',toolCallId:'middle',toolName:'web_fetch',isError:false,content:sourceText};
const sourceHistory=[{role:'user',content:'解释年报指标'},{role:'assistant',content:[{type:'toolCall',id:'middle',name:'web_fetch',arguments:{url:'https://issuer.example/annual'}}]},sourceMessage];
const keptSource=auditTimeline([{role:'toolResult',toolName:'web_fetch',text:sourceText,isError:false}])[0];
assert(keptSource.text.includes(middleFact));assert(!keptSource.truncated);
assert(researchRecoveryToolEvidence(sourceHistory)[0].text.includes(middleFact));
const fraud={question:'虚构公司，收入200，应收余额50。能判定虚构收入比例吗？'};
assert(accountingReasoningIssues('若一半是假收入，应收至少达到100；实际应收只有50，这与假收入过半直接冲突。',fraud).length);
assert(!accountingReasoningIssues('不能由应收余额确定假收入比例；已回款也可能是虚构交易。',fraud).length);
assert(!accountingReasoningIssues('若所有虚增收入均留在期末应收，则应收至少达到100。',{question:fraud.question+'明确假设所有虚增收入均计入应收且未收回。'}).length);
const bridge={question:'虚构公司两年净利润10和20，经营现金流15和8，应收40和60，存货20和35。'};
assert(accountingReasoningIssues('按利润增量+10、营运资金−35推，现金流应降25，实际降7意味着其他项目贡献18。',bridge).length);
assert(!accountingReasoningIssues('不能把利润增量与单期营运资金增加直接桥接；缺首期初余额，其他调整未知。',bridge).length);
console.log('PASS intact source middles, fraud/receivable distinction and cash-flow period alignment');

const nextRead={...c,id:'source-other-page',arguments:{url,query:'现金流'}};
const nextResult={...result,toolCallId:nextRead.id,content:[{type:'text',text:'经营现金流12亿元。'}]};
const bothSources=historicalSourceCalls([...history,{role:'assistant',content:[nextRead]},nextResult]);
assert.equal(bothSources.length,2,'distinct page/query reads at the same URL must not overwrite earlier evidence');
assert(bothSources.some(x=>x.id==='source'));assert(bothSources.some(x=>x.id===nextRead.id));

assert.equal(informationCutoff('依据截至2022年12月31日可公开核验的信息分析。'),'2022-12-31');
assert.equal(informationCutoff('截至2024年2月底公开信息'),'2024-02-29');
assert.equal(informationCutoff('截至2021年底可查资料'),'2021-12-31');
assert.equal(informationCutoff('以2022年年报为事实边界，不用2023年以后业绩。'),null);
assert.equal(informationCutoff('截至2022年12月31日的余额，见2023年发布年报。'),null);
assert.equal(auditRequestOptions({}, {reasoning:true,maxTokens:64000}).reasoning,'low');
assert.equal(auditRequestOptions({}, {reasoning:true,maxTokens:64000}).maxTokens,24000);
assert.equal(auditRequestOptions({}, {reasoning:true,maxTokens:64000},true).reasoning,'off');
const attempts=[];let count=0;
const retriedAudit=await auditResearch((_m,_c,o)=>{
 attempts.push(o);if(count++>0)return stream(JSON.stringify(pass));
 const s=createAssistantMessageEventStream();const m={role:'assistant',stopReason:'length',content:[],usage:{input:2,output:3,totalTokens:5}};s.push({type:'done',reason:'length',message:m});s.end();return s;
},{reasoning:true,maxTokens:64000},{messages:[]},{},'观点与证据保持一致。',{question:'解释证据。'});
assert(retriedAudit.ok);assert.deepEqual(attempts.map(o=>o.reasoning),['low','off']);assert.equal(retriedAudit.usage.totalTokens,5);
const limitText='下一阶段需客户账龄';
const assessments={items:[{id:0,kind:'future_evidence',reason:'用户问调查方法'}]};
assert.equal(parseLimitAssessments(JSON.stringify(assessments),[limitText])[0].text,limitText);
assert.equal(parseLimitAssessments(JSON.stringify({items:[]}),[limitText]),null);
assert.equal(parseLimitAssessments(JSON.stringify({items:[{id:8,kind:'outside_scope',reason:'fake'}]}),[limitText]),null);
let scopeCalls=0;
const scoped=await auditResearch((_m,c)=>{scopeCalls++;return stream(JSON.stringify(c.systemPrompt.includes('你只判断当前用户问题')?assessments:pass));},{},{messages:[]},{},'应看回款。\n未核验：'+limitText+'。',{question:'如何检验回款质量？列所需证据。'});
assert.equal(scopeCalls,2);assert.deepEqual(scoped.answeredLimits,[limitText]);assert.equal(scoped.limitAssessment.status,'classified');
const requiredScope=await auditResearch((_m,c)=>stream(JSON.stringify(c.systemPrompt.includes('你只判断当前用户问题')?{items:[{id:0,kind:'required_missing',reason:'问题明确要求该结果'}]}:pass)),{},{messages:[]},{},'未核验：缺用户要求的计算结果。',{question:'计算该项结果。'});
assert.deepEqual(requiredScope.answeredLimits,[]);
assert(accountingReasoningIssues('按利润增量+10、营运资金−35推，现金流应降25，实际降7意味着其他项目贡献18；因缺明细，该18无法核验。',bridge).length);
assert(accountingReasoningIssues('这个调整大于资本开支5所能对应的折旧。',bridge).length);
assert(!accountingReasoningIssues('不能用资本开支给折旧设上限，历史资产也会折旧。',bridge).length);
console.log('PASS information vintage, bounded reasoning fallback and explicit scope classification');

import { lintFactIdentity } from '../lib/fact-memory/context.mjs';
import { isResearchCondition } from '../lib/research-condition.mjs';
const conditionQuestion='设计可跟踪、可证伪命题，列推翻条件。';
const conditionMemory={query:()=>({facts:[{metric:'revenue',entity:'示例公司',period:'2023',raw_value:70,raw_unit:'亿元',quality:'needs_review',basis_type:'actual'}]})};
assert.deepEqual(lintFactIdentity('推翻：收入不低于70亿元。',conditionMemory,{question:conditionQuestion}),[]);
assert.deepEqual(lintFactIdentity('证伪条件：收入低于90亿元。',conditionMemory,{question:conditionQuestion}),[]);
assert(lintFactIdentity('收入70亿元。',conditionMemory,{question:conditionQuestion}).some(f=>f.rule==='fact_needs_review'));
assert(lintFactIdentity('推翻：年报披露收入70亿元。',conditionMemory,{question:conditionQuestion}).some(f=>f.rule==='fact_needs_review'));
assert(lintFactIdentity('推翻：收入不低于70亿元。',conditionMemory,{question:'核对公司收入。'}).length);
assert(lintFactIdentity('实际收入90亿元。',conditionMemory,{question:conditionQuestion}).some(f=>f.rule==='fact_identity_mismatch'));
assert(!isResearchCondition('证伪：收入已经达到70亿元。',conditionQuestion));
assert(!isResearchCondition('2023年实际收入70亿元。',conditionQuestion));
console.log('PASS hypothetical decision rules cannot be bound as historical observations; factual conflicts remain blocking');

assert(isResearchCondition('1. 若收入低于65亿元，降低对需求的判断。','列尽调清单，说明如何改变判断。'));

const arPremise={question:'虚构公司，收入240，期末应收60，能判断收入真实吗？'};
assert(accountingReasoningIssues('应收60÷收入240即25%未收回，未超过一半。',arPremise).length);
assert(accountingReasoningIssues('大部分收回则只是账期放宽。',arPremise).length);
assert(!accountingReasoningIssues('不能把应收60÷收入240解释为25%未收回。',arPremise).length);
assert(!accountingReasoningIssues('应收余额/全年收入不是当年收入未收回的比例。',arPremise).length);
assert(!accountingReasoningIssues('期后回款不能证明只是账期放宽，还需要履约和资金流证据。',arPremise).length);
console.log('PASS stock/flow and transaction authenticity guard variants');
