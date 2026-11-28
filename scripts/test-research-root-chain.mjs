import assert from 'node:assert/strict';
import test from 'node:test';
import {selectResearchEvidence} from '../lib/research-evidence-package.mjs';
import {auditResearch,evidenceTimeline,AUDIT_CHECKS} from '../lib/research-audit.mjs';
import {researchRecoveryToolEvidence} from '../lib/research-delivery.mjs';
import {metricContext,indexGraph} from '../lib/workbook-query.mjs';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {stripPublicationStatus} from '../lib/report-publication.mjs';
import {closeResearchDocument} from '../lib/research-document-closure.mjs';
import {repairFingerprint} from '../lib/research-repair-progress.mjs';
import {publishReportWithMaterials} from '../server/agent/report-materials.mjs';
import {guardResearchDelivery} from '../lib/research-delivery.mjs';
import {createHash} from 'node:crypto';
import {createAssistantMessageEventStream} from '@earendil-works/pi-ai';
import {marketEvidenceFromCalls,matchingMarketEvidence} from '../lib/market-evidence.mjs';
globalThis.fetch=()=>{throw Error('Offline only');};
const result=(id,text,name='westock_query',isError=false)=>({role:'toolResult',toolCallId:id,toolName:name,isError,content:[{type:'text',text}]});
const quote=result('old-quote','公司甲 2026-11-22 HKD\n| name | chg_ytd | high_52week |\n| 公司甲 | -21.5 | 88 |');
const draft='公司甲年内跌21.5%，52周高点88港元。';
test('claim selection survives later unrelated history; correction remains visible; recovery uses identical excerpts',()=>{
 const messages=[quote,...Array.from({length:30},(_,i)=>result('noise'+i,'无关航运资料\n\n'+('港口物流情况。'.repeat(2000)),'web_fetch')),
  result('correction','公司甲更正：2026-11-22 HKD high_52week=89；此前88为错误数据。')];
 const pack=selectResearchEvidence(evidenceTimeline(messages),{draft,maxChars:16000});
 assert.ok(pack.timeline.some(r=>r.toolCallId==='old-quote' && r.text.includes('high_52week')));
 assert.ok(pack.timeline.some(r=>r.toolCallId==='correction'));
 assert.ok(JSON.stringify(pack).length<=16000);assert.equal(pack.coverage.status,'limited');
 const recovery=researchRecoveryToolEvidence(messages,{draft,maxChars:16000});assert.ok(JSON.stringify(recovery).length<=16000);
 const recovered=recovery.filter(r=>!r.metadataOnly);
 assert.deepEqual(recovered.map(r=>[r.toolCallId,r.text]),pack.timeline.filter(r=>r.role==='toolResult').map(r=>[r.toolCallId,r.text]));
 const changed=selectResearchEvidence(evidenceTimeline(messages),{draft:draft.replace('21.5','99'),maxChars:16000});
 assert.ok(changed.timeline.some(r=>r.toolCallId==='old-quote' && r.text.includes('-21.5')),'no approval or value rewrite cached');
});
test('oversize sources are catalogued as missing input; whole source blocks preserve table header and qualifications',()=>{
 const long=result('long','单位：百万元；2025年，业务乙，仅持续经营。\n| 项目 | 金额 |\n| 收入 | 120 |\n\n'+'无关。'.repeat(50000),'web_fetch');
 const pack=selectResearchEvidence(evidenceTimeline([long]),{draft:'业务乙2025年收入',maxChars:3000});
 assert.ok(JSON.stringify(pack).length<=3000);
 assert.equal(pack.coverage.status,'limited');
 const included=pack.timeline.find(r=>r.toolCallId==='long');
 if(included)assert.match(included.text,/单位：百万元；2025年.*仅持续经营/);
 else assert.equal(pack.catalog.find(c=>c.id==='long').included,false);
 for(const maxChars of [256,1000,5000])assert.ok(JSON.stringify(selectResearchEvidence(evidenceTimeline([long]),{draft,maxChars})).length<=maxChars);
});
test('audit coverage gaps are protocol limitations, never a finance rejection or an approval',async()=>{
 const messages=[result('huge','公司甲'.repeat(60000),'web_fetch')];
 let received;
 const provider=async(_,context)=>{
  received=JSON.parse(context.messages[0].content[0].text);
  const message={stopReason:'stop',content:[{type:'text',text:JSON.stringify({checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass'])),issues:[],inputCoverageGaps:[{evidenceIds:['huge'],reason:'需要完整原文表头'}]})}]};
  return {async *[Symbol.asyncIterator](){yield {type:'done'};},result:async()=>message};
 };
 const verdict=await auditResearch(provider,{}, {messages},{},'资料支持业务分析。',{question:'分析业务'});
 assert.equal(received.evidenceCatalog.find(c=>c.id==='huge').included,false);
 assert.equal(verdict.ok,false);assert.equal(verdict.status,'unavailable');
 assert.deepEqual(verdict.issues.map(i=>i.check),['audit']);
});
test('accounting qualifiers preserve leaf metric identity, rather than inheriting prior interest income',()=>{
 const graph=indexGraph({cells:[],edges:[],sheets:[{name:'Income',rowLabels:{1:'Interest income',2:'Net profit, non-GAAP',3:'Net income (IFRS)',4:'Operating profit, GAAP'}}]});
 for(const [row,rowLabel] of [[2,'Net profit, non-GAAP'],[3,'Net income (IFRS)'],[4,'Operating profit, GAAP']])
  assert.equal(metricContext(graph,{sheet:'Income',row,rowLabel}).label,rowLabel);
});
test('overall and core valuation ratios never borrow each other\'s value; bad amount/year still fail',()=>{
 const source=(id,value,metric,period='2026')=>({id,materialId:'m',version:1,filename:'模型.xlsx',locator:'S!'+id,value,raw_unit:'倍',display_unit:'倍',metric,period});
 const context={citations:[source('A1',12,'整体市盈率'),source('A2',25,'核心业务市盈率')],toolCalls:[]};
 const errors=text=>financialEvidenceFindings(text,context,[]).filter(f=>f.severity==='error');
 assert.deepEqual(errors('2026年整体市盈率12倍，核心业务市盈率25倍。'),[]);
 for(const bad of ['2026年整体市盈率25倍。','2026年核心业务市盈率12倍。','2025年整体市盈率12倍。'])assert.ok(errors(bad).length,bad);
 const headerOnly=financialEvidenceFindings('整体市盈率12倍。',{citations:[source('A3','COMMENT','整体市盈率')],toolCalls:[]},[]);
 assert.ok(headerOnly.some(f=>f.evidenceStatus==='missing_source'));assert.ok(!headerOnly.some(f=>f.expected==='COMMENT'));
});
test('quote fields retain identity through numeric checking: YTD and 52-week bounds, with negative controls',()=>{
 const raw='| code | name | price_currency | price | time | chg_ytd | high_52week | low_52week |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n| hk01234 | 示例科技 | HKD | 50 | 2026-11-20 | -21.5 | 88 | 40 |';
 const call={id:'quote',name:'westock_query',success:true,args:{args:['quote','hk01234'],expectedName:'示例科技'},result:{isError:false,content:[{type:'text',text:raw}]}};
 assert.equal(marketEvidenceFromCalls([call]).length,4);
 const errors=answer=>financialEvidenceFindings(answer,{question:'分析示例科技的行情',citations:[],toolCalls:[call]},[]).filter(f=>f.severity==='error');
 for(const s of ['示例科技2026年年内跌幅21.5%。','示例科技52周高点88港元。','示例科技52周低点40港元。'])assert.deepEqual(errors(s),[],s);
 for(const s of ['示例科技年内涨幅21.5%。','示例科技52周高点87港元。','示例科技2025年年内跌幅21.5%。','示例科技52周低点40美元。'])assert.ok(errors(s).length,s);
 assert.equal(marketEvidenceFromCalls([{...call,success:false}]).length,0);
 const evidence=marketEvidenceFromCalls([call]);
 assert.equal(matchingMarketEvidence({metric:'52周高点',value:88,unit:'港元',company:'另一科技'},'另一科技52周高点88港元。',{question:'分析另一科技',evidence,matches:()=>true}).length,0);
});
test('receipt rewrite preserves facts and unrelated failures; partial preface and empty lead-ins disappear',()=>{
 const paths=['exports/a/report.md','exports/a/analysis-state.json'];
 const text='> 部分完成：以下保留分析。\n\n收入增长来自价格提升。\n\n- `exports/a/report.md`：未保存。\n- `exports/other.md`：未保存。\n\n现金流仍需关注。';
 const cleaned=stripPublicationStatus(text,paths);
 assert.doesNotMatch(cleaned,/部分完成|exports\/a\/report/);assert.match(cleaned,/exports\/other/);assert.match(cleaned,/收入增长来自价格提升/);
 assert.match(stripPublicationStatus('- exports/a/report.md：未保存。收入增长来自价格提升。',paths),/收入增长来自价格提升/);
 assert.doesNotMatch(stripPublicationStatus('- 仅报告文件未完成，状态文件不受影响。\n\n收入增长。',paths),/报告文件未完成/);
 assert.match(stripPublicationStatus('报告内容尚未完成，缺少同口径比较。',paths),/缺少同口径比较/);
 const stable='# 结论\n\n收入增长。\n\n- 回款\n- 现金流\n\n## 风险\n\n关注订单。';assert.equal(stripPublicationStatus(stable,paths),stable);
 const original='## 驱动\n\n主要驱动如下：\n\n坏数据。\n\n## 业务\n\n回款需要持续观察。';
 const cropped=original.replace('坏数据。','此项判断证据不足，暂不能确定。');
 const closed=closeResearchDocument(original,cropped).text;
 assert.doesNotMatch(closed,/主要驱动如下：/);assert.match(closed,/回款需要持续观察/);
 const orphan=closeResearchDocument('## 2. 未核判断\n\n### 2.3 回款\n\n回款需要持续观察。','### 2.3 回款\n\n回款需要持续观察。').text;
 assert.match(orphan,/^## 回款/);assert.doesNotMatch(orphan,/未核判断/);
 const intact='### 2.3 用户指定的章节\n\n3. 第三问的答复\n4. 第四问的答复';assert.equal(closeResearchDocument(intact,intact).text,intact);
});
test('repair convergence tracks claims and source contents, not revised surrounding prose or report writes',()=>{
 const finding={rule:'evidence_identity_mismatch',field:'value',claim:{metric:'收入',value:99,period:'2026'},expected:100};
 const source={id:'q',name:'web_fetch',success:true,result:{text:'2026收入100亿元'}};
 const first=repairFingerprint([finding],[source]);
 assert.equal(first,repairFingerprint([{...finding,excerpt:'换一种表述'}],[source,{id:'write',name:'write',success:false}]));
 assert.notEqual(first,repairFingerprint([{...finding,claim:{...finding.claim,value:101}}],[source]));
 assert.notEqual(first,repairFingerprint([finding],[{...source,result:{text:'2026收入99亿元'}}]));
});
test('committed report and state refresh through the same material hook; index failure never changes file truth',async()=>{
 const bundle={report:{path:'exports/report.md',sha256:'report-hash'},state:{path:'exports/analysis-state.json',sha256:'state-hash'}};
 const outcome={status:'partial',text:'收入与回款需要分别分析。',reportPublication:{saved:true},deliveryBundle:bundle};
 const indexed=[];
 const delivered=await publishReportWithMaterials(async()=>outcome,async(entry,tool,args)=>indexed.push({tool,args}),{},outcome,'保存报告');
 assert.deepEqual(indexed.map(i=>i.args.path),[bundle.report.path,bundle.state.path]);
 assert.deepEqual(indexed.map(i=>i.args.sha256),['report-hash','state-hash']);
 assert.equal(delivered.materialIndex.status,'updated');
 const pending=await publishReportWithMaterials(async()=>outcome,async()=>{throw Error('index unavailable');},{},outcome,'保存报告');
 assert.equal(pending.reportPublication.saved,true);assert.equal(pending.text,outcome.text);assert.equal(pending.materialIndex.pending.length,2);
});
test('later reviews reuse source links for unchanged passages, never previous approval or links for changed numbers',async()=>{
 const good='2026年营业收入100亿元。',bad='必然实现增长。';
 for(const changed of [false,true]){
  const next=(changed?good.replace('100','101'):good)+'需要继续观察回款。';
  let writes=0;const audits=[];
  const provider=async()=>{
   const message={role:'assistant',content:[{type:'text',text:++writes===1?good+bad:next}],stopReason:'stop'};
   const stream=createAssistantMessageEventStream();stream.push({type:'done',message,reason:'stop'});stream.end();return stream;
  };
  const guarded=guardResearchDelivery(provider,{audit:async(_p,_m,_c,_o,text,extra)=>{
   audits.push(extra.sourceIds);
   return {ok:audits.length>1,status:'reviewed',issues:audits.length===1?[{check:'conclusion_strength',excerpt:bad,reason:'不能保证增长'}]:[],
    draftHash:createHash('sha256').update(text).digest('hex'),verifiedPassages:audits.length===1?[{text:good,evidenceIds:['source']}]:[]};
  }});
  await (await guarded({}, {messages:[{role:'user',content:'分析营业收入与投资风险'},result('source',good)]},{})).result();
  assert.equal(audits.length,2,'a changed draft must be audited again');assert.deepEqual(audits[1],changed?[]:['source']);
 }
});
