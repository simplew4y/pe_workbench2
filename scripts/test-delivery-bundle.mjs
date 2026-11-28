import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {publishFinalReport} from '../lib/report-publication.mjs';
import {deliveryBundleIssue} from '../lib/delivery-bundle.mjs';
import {closeResearchDocument} from '../lib/research-document-closure.mjs';
import {deriveMonitorPlan} from '../lib/monitoring.mjs';
import {validateState} from '../lib/validate-state.mjs';
import {enrichFinancialSources} from '../lib/financial-source-identity.mjs';
import {accountingReasoningIssues} from '../lib/research-reasoning.mjs';
import {artifactDeliveryFindings} from '../lib/artifact-delivery.mjs';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {lintAnswer} from '../lib/answer-lint.mjs';
import {researchPortion} from '../server/agent/answer-delivery.mjs';
import {snapshotMessages} from '../server/agent/snapshot.mjs';
import {replaceResearchSpan} from '../lib/research-text-boundaries.mjs';
globalThis.fetch=()=>{throw Error('offline only');};
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'delivery-bundle-'));
const template=JSON.parse(fs.readFileSync('skills/investment-framework/assets/analysis-state.example.json','utf8'));
let count=0;
function fixture() {
 const dir='exports/case-'+(++count),report=dir+'/report.md',statePath=dir+'/analysis-state.json';
 const state=structuredClone(template);
 const oldReport='# 旧版\n\n| 编号 | 条件 |\n|---|---|\n| T1 | 旧条件 |';
 const stateBody=JSON.stringify(state);
 fs.mkdirSync(path.join(root,dir),{recursive:true});
 fs.writeFileSync(path.join(root,report),oldReport);fs.writeFileSync(path.join(root,statePath),stateBody);
 const text='# 新版\n\n| 编号 | 条件 |\n|---|---|\n| T1 | 新条件 |\n\nT1 将带来投资机会。\n\n## 资料\n\n核验订单与回款后再判断。';
 const receipts=[{path:report,saved:true,sha256:hash(oldReport)},{path:statePath,saved:true,sha256:hash(stateBody)}];
 const args={root,question:'生成并保存投资框架报告',draft:{path:report,saveRequested:true,content:text,baseline:hash(oldReport)},outcome:{text,status:'completed'},receipts};
 return {dir,report,statePath,stateBody,oldReport,args};
}
try {
 const f=fixture(),published=[];
 f.args.outcome.reason='报告未保存；阈值尚未核验';
 const result=publishFinalReport({...f.args,record:r=>published.push(r)});
 assert.equal(result.reportPublication.saved,true,result.reason);
 assert.equal(result.status,'partial');assert.equal(result.analysisState,null);
 assert(!result.reason.includes('未保存'));assert(result.publicationReview.priorReason.includes('未保存'));
 assert.equal(fs.readFileSync(path.join(root,f.report),'utf8'),result.text,'page and report exact bytes');
 assert(!result.text.includes('投资机会'));assert(!result.text.includes('| T1 |'));
 const state=JSON.parse(fs.readFileSync(path.join(root,f.statePath),'utf8'));
 assert.equal(validateState(state).ok,true);
 assert.equal(state.delivery.trackingEnabled,false);assert.deepEqual(deriveMonitorPlan(state).items,[]);
 assert.equal(fs.readFileSync(path.join(root,state.delivery.candidatePath),'utf8'),f.stateBody,'candidate is lossless');
 assert.equal(fs.readFileSync(path.join(root,state.delivery.candidateReportPath),'utf8'),f.args.draft.content,'latest rejected candidate is also lossless');
 assert.match(deliveryBundleIssue(root,f.statePath,state),/待核对/);
 const manifest=JSON.parse(fs.readFileSync(path.join(root,f.dir,'delivery-manifest.json')));
 assert.equal(manifest.report.sha256,hash(result.text));assert.equal(manifest.state.sha256,hash(fs.readFileSync(path.join(root,f.statePath))));
 assert.equal(published.length,3);
 const turnId='bundle-turn',oldState=JSON.parse(f.stateBody);
 oldState.presentation={verdict:{text:'旧版观点不得重现'}};
 const branch=[{customType:'pe_turn_started',data:{turnId,question:'保存报告',startedAt:1}},
  {message:{role:'user',content:'保存报告'}},
  {message:{role:'assistant',content:[{type:'toolCall',id:'write-state',name:'write',arguments:{path:f.statePath,content:JSON.stringify(oldState)}}]}},
  {message:{role:'toolResult',toolCallId:'write-state',toolName:'write',isError:false,content:[]}},
  {customType:'pe_turn_delivery',data:{...result,turnId,finishedAt:2}}];
 const view=snapshotMessages({messages:[],sessionManager:{getBranch:()=>branch.map(r=>({...r,type:r.message?'message':'custom'}))}},{root}).find(m=>m.role==='assistant');
 assert.equal(view.text,result.text);assert.equal(view.analysisState,undefined,'final snapshot omits earlier tool-written cards');
 fs.appendFileSync(path.join(root,f.report),'changed');
 assert.match(deliveryBundleIssue(root,f.statePath,state),/不一致/);
 // A blocked write and a failure halfway through commit preserve both files.
 for(const mode of ['denied','rename','concurrent']) {
  const x=fixture(),rename=fs.renameSync;let calls=0;
  if(mode==='rename')fs.renameSync=(...args)=>{if(++calls===2)throw Error('injected IO failure');return rename(...args);};
  let result;
  try {result=publishFinalReport({...x.args,authorizeWrite:({path:p})=>{
   if(mode==='denied' && p===x.statePath)return {block:true,reason:'denied'};
   if(mode==='concurrent' && p.endsWith('delivery-manifest.json'))fs.writeFileSync(path.join(root,x.report),'external edit');
  }});}finally{fs.renameSync=rename;}
  assert.equal(result.reportPublication.saved,false,mode);
  assert.equal(fs.readFileSync(path.join(root,x.statePath),'utf8'),x.stateBody,mode);
  assert.equal(fs.readFileSync(path.join(root,x.report),'utf8'),mode==='concurrent'?'external edit':x.oldReport,mode);
  assert.equal(fs.existsSync(path.join(root,x.dir,'.delivery-lock')),false);
 }
 const unowned=fixture();
 assert.equal(publishFinalReport({...unowned.args,receipts:[]}).reportPublication.saved,false);
 // A proven same-version state preserves its research graph and permits tracking.
 const aligned=fixture(),stateGood=JSON.parse(aligned.stateBody);
 for(const row of stateGood.falsifiers){row.threshold_basis='history';row.threshold_status='calibrated';row.last_observed=row.last_observed ?? {value:0,date:'2026-01-01'};}
 for(const row of stateGood.assumptions)row.role='input';
 const validation=validateState(stateGood);
 // The shipped complete example itself is the reviewed fixture.
 assert.equal(validation.ok,true,JSON.stringify(validation.errors));
 assert.deepEqual(validation.warnings,[],JSON.stringify(validation.warnings));
 const raw=JSON.stringify(stateGood);fs.writeFileSync(path.join(root,aligned.statePath),raw);
 aligned.args.receipts[1].sha256=hash(raw);
 aligned.args.draft.stateBinding={stateHash:hash(raw),reportHash:hash(aligned.args.outcome.text)};
 const good=publishFinalReport(aligned.args);
 assert.equal(good.status,'completed',good.reason);assert.equal(good.analysisState.theses.length,stateGood.theses.length);
 assert.equal(deliveryBundleIssue(root,aligned.statePath,good.analysisState),null);
 fs.unlinkSync(path.join(root,aligned.dir,'delivery-manifest.json'));
 assert.match(deliveryBundleIssue(root,aligned.statePath,good.analysisState),/清单/);
 const stale=fixture();stale.args.draft.stateBinding={stateHash:'stale',reportHash:hash(stale.args.outcome.text)};
 assert.equal(publishFinalReport(stale.args).analysisState,null,'stale state review cannot activate tracking');
 const oldReceipt=[{path:'exports/report.md',saved:true,current:false}];
 assert.deepEqual(artifactDeliveryFindings('新版报告尚未保存。',oldReceipt),[]);

 const original='# 观点\n\n| 编号 | 内容 |\n|---|---|\n| T8 | 利润上升 |\n| T9 | 成本下跌 |\n\n## 估值\n\n| 编号 | 内容 |\n|---|---|\n| V3 | 依赖 T8 |\n\nT8–T9 支持买入。\n\nV3 证明低估。\n\n## 独立事实\n\n资料尚待核查。';
 const closed=closeResearchDocument(original,original.replace('| T8 | 利润上升 |\n','')).text;
 assert(!closed.includes('支持买入'));assert(!closed.includes('证明低估'));assert(!closed.includes('| V3 |'));assert(closed.includes('| T9 |'));assert(closed.includes('资料尚待核查'));
 const dependent='此处数值或单位尚需核对，暂不据此判断。这是税项下降造成的。';
 assert(!closeResearchDocument(dependent,dependent).text.includes('税项下降'));
 assert.equal(replaceResearchSpan('利润999亿元。这是税项下降造成的。模型利润取决于售价。','利润999亿元。','待核。'),'待核。模型利润取决于售价。');
 assert(lintAnswer(dependent).some(f=>f.rule==='delivery_fragment'));
 const rejected='产能与成本均未公开披露';
 const retained=researchPortion(rejected+'。\n\n需要核验公告。',()=>[],[{rule:'delivery_gap',severity:'error',excerpt:rejected,message:rejected+'：不能因为未取得就断定不存在'}]);
 assert(!retained.includes(rejected));assert(retained.includes('该项结论'));
 const c={materialId:'m',version:1,locator:'P!D5',metric:'Net income',value:812,raw_unit:'百万元'};
 const calls=[{name:'workbook_query',success:true,details:{materialId:'m',version:1,cells:[{ref:'P!D5',metricContext:{label:'Net income',product:'Net income'}}]}}];
 assert.equal(enrichFinancialSources([c],calls)[0].metric,'Net income');
 assert.equal(enrichFinancialSources([c],calls)[0].segment,undefined);
 const profit={...c,id:'profit',filename:'model.xlsx',period:'2029E',basis_type:'forecast',display_unit:'百万元'};
 const multiple={...profit,id:'multiple',metric:'现市值对应2029E净利倍数',value:8.2,display_unit:'倍',raw_unit:'倍',derivedFrom:['profit'],role:'derived'};
 const finance=s=>financialEvidenceFindings(s,{question:'分析估值模型',citations:[profit,multiple],toolCalls:calls},[]);
 assert.deepEqual(finance('2029E净利812百万元。'),[]);
 assert(finance('2029E净利812亿元。').some(f=>f.severity==='error'));
 assert(!finance('按总市值/归母净利口径为8.2倍。').some(f=>f.field==='unit' && f.expected==='百万元'));
 assert(!finance('税前利润到归母净利漏损约45%。').some(f=>f.field==='unit' && f.expected==='百万元'));
 const scenario=s=>financialEvidenceFindings(s,{question:'虚构情景：游戏增长15%，广告增长8%。分析影响。',citations:[],toolCalls:[]},[]);
 assert.deepEqual(scenario('情景中游戏+15%能否改善利润取决于成本。'),[]);
 for(const s of ['情景中游戏+16%能否改善利润取决于成本。','情景中广告+15%能否改善利润取决于成本。','情景中游戏-15%能否改善利润取决于成本。'])assert(scenario(s).some(f=>f.severity==='error'),s);
 const question='虚构情景：收入100，成本60。分析利润。';
 const disclosure='2025年报披露收入200亿元（第35页）。';
 assert(!accountingReasoningIssues(disclosure,{question}).some(f=>f.check==='numeric_units'));
 assert(accountingReasoningIssues(disclosure+'题设利润40亿元。',{question}).some(f=>f.check==='numeric_units'));
 console.log('PASS offline bundle publication, rollback, ownership, reader hashes, inactive candidates, reference closure and numeric scope');
} finally {fs.rmSync(root,{recursive:true,force:true});}
