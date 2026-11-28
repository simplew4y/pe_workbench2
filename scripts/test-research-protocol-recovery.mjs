import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Type} from 'typebox';
import {createAssistantMessageEventStream, normalizeContext, getCurrentTools} from '@earendil-works/pi-ai';
import {decodeToolProtocol, guardToolProtocol} from '../lib/tool-call-protocol.mjs';
import {guardResearchDelivery,researchAnswerContext} from '../lib/research-delivery.mjs';
import {researchContract} from '../lib/research-contract.mjs';
import {createResearchReview, reviewClaims} from '../lib/research-review.mjs';
import {auditResearch, AUDIT_CHECKS} from '../lib/research-audit.mjs';

const tool={name:'read',parameters:Type.Object({path:Type.String()})};
const xml=(name='read',value='uploads/model.xlsx')=>`<｜｜DSML｜｜ calls>\n<｜｜DSML｜｜ invoke name="${name}"><｜｜DSML｜｜ parameter name="path" string="true">${value}</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>\n</｜｜DSML｜｜ calls>`;
const msg=text=>({role:'assistant',stopReason:'stop',content:[{type:'text',text}],usage:{}});
const stream=message=>{const s=createAssistantMessageEventStream();s.push({type:'done',reason:message.stopReason,message});s.end();return s;};
assert.equal(decodeToolProtocol(msg(xml()),[tool]).content[0].arguments.path,'uploads/model.xlsx');
assert.equal(decodeToolProtocol(msg(xml('read','含｜字符.xlsx')),[tool]).content[0].arguments.path,'含｜字符.xlsx');
for(const [message,tools] of [[msg(xml()),[]],[msg(xml('write')),[tool]],[msg('文档引用：'+xml()),[tool]],
  [msg(xml().slice(0,-8)),[tool]],[{...msg(xml()),stopReason:'length'},[tool]],
  [msg(xml().replace('string="true"','string="false"')),[tool]]]) assert.throws(()=>decodeToolProtocol(message,tools));
const native={role:'assistant',stopReason:'toolUse',content:[{type:'toolCall',id:'native',name:'read',arguments:{path:'a'}}]};
assert.equal(decodeToolProtocol(native,[tool]),native);
assert.throws(()=>decodeToolProtocol(native,[]),'disabled native calls cannot bypass the allowed tool set');
const typed={name:'scenario',parameters:Type.Object({enabled:Type.Boolean(),inputs:Type.Array(Type.Number()),note:Type.String()})};
const typedXml='<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="scenario"><｜｜DSML｜｜ parameter name="enabled" string="false">true</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="inputs" string="false">[1,2.5]</｜｜DSML｜｜ parameter><｜｜DSML｜｜ parameter name="note" string="true">第一行\n第二行</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>';
assert.deepEqual(decodeToolProtocol(msg(typedXml),[typed]).content[0].arguments,{enabled:true,inputs:[1,2.5],note:'第一行\n第二行'});
const duplicate=typedXml.replace('name="note" string="true"','name="enabled" string="true"');
assert.throws(()=>decodeToolProtocol(msg(duplicate),[typed]));

const wrapper=guardToolProtocol(async()=>stream(msg(xml())));
const decoded=await (await wrapper({}, {tools:[tool],messages:[]},{})).result();
assert.equal(decoded.stopReason,'toolUse');
const disabled=await (await wrapper({}, {tools:[],messages:[]},{})).result();
assert.ok(disabled.protocolFailure);assert.deepEqual(disabled.content,[]);

// A real report write still passes through the normal tool boundary. A changed
// extension cannot evade approval; malformed/signed values remain failures.
const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-protocol-'));
try {
 fs.mkdirSync(path.join(root,'exports'));
 const store={findMaterialByPath:()=>null},workbooks={};
 const guard=createResearchReview({ctx:{root,store,workbooks}});
 for(const extension of ['md','MD','Md']) assert.equal(guard.before('write',{path:`exports/report.${extension}`,content:'收入100亿元'}).block,true);
 assert.equal((await reviewClaims({content:'信息截止：2026-11-21。',store,workbooks})).ok,true);
 assert.equal((await reviewClaims({content:'信息截止：2026-11-21。收入100亿元',store,workbooks})).ok,false);
 let saves=0;
 const args={path:'exports/report.MD',content:'甲公司2026年收入100亿元。',save:true};
 const context={executeTool:async(_name,a)=>{fs.writeFileSync(path.join(root,a.path),a.content);saves++;return {result:{content:[]}};}};
 for(const verdict of [{ok:true,issues:[]},{ok:false,status:'unavailable',issues:[]},{ok:false,issues:[{check:'numeric_units',reason:'单位错误'}],coverageValidated:[0]}]) {
   guard.setAuditor(async()=>verdict);
   assert.equal((await guard.tool.execute('fail',args,undefined,undefined,context)).isError,true);
 }
 assert.equal(saves,0);
 guard.setAuditor(async()=>({ok:true,issues:[],coverageValidated:[0]}));
 const saved=await guard.tool.execute('save',args,undefined,undefined,context);
 assert.equal(saved.isError,false);assert.match(JSON.stringify(saved),/research_write_verified/);
 assert.equal(guard.draftSnapshot().saved,true);assert.equal(fs.readFileSync(path.join(root,args.path),'utf8'),args.content);
 guard.startRun();assert.equal(guard.draftSnapshot(),null);
 const market=createResearchReview({ctx:{root,store,workbooks}});
 market.record({toolCall:{name:'westock_query',id:'quote1'},args:{},result:{content:[{type:'text',text:'| name | price | time |\n| Example | 42.5 | 2026-11-20 |'}]}});
 market.setAuditor(async()=>({ok:true,issues:[]}));
 const sourceArgs={path:'exports/quote.md',content:'{{source:price}}',sources:[{id:'price',evidenceId:'quote1',quote:'| Example | 42.5 | 2026-11-20 |'}]};
 assert.equal((await market.tool.execute('market',sourceArgs)).isError,false,'market quote without URL uses a real receipt');
 assert.equal((await market.tool.execute('market-space',{...sourceArgs,sources:[{...sourceArgs.sources[0],quote:'| Example |\t42.5 | 2026-11-20 |',locator:'westock_query quote Example'}]})).isError,false,'formatting whitespace and guessed market locator are repaired without changing numbers');
 for (const patch of [{evidenceId:'missing'},{quote:'| Example | 43.5 | 2026-11-20 |'},{quote:'| Example | 4 2.5 | 2026-11-20 |'}]) {
   assert.equal((await market.tool.execute('bad-market',{...sourceArgs,sources:[{...sourceArgs.sources[0],...patch}]})).isError,true);
 }
 const metadata='> 信息截止：2026-11-21 ｜ 币种：人民币\n> 报告版本：1\n通过核验（CHK1、SRC2）。';
 assert.equal((await reviewClaims({content:metadata,store,workbooks})).ok,true);
 assert.equal((await reviewClaims({content:metadata+'收入50亿元。',store,workbooks})).ok,false,'metadata exemption cannot swallow a financial assertion');
 for (const numeric of ['成本USD100','收入CNY200','毛利率GM50%']) assert.equal((await reviewClaims({content:numeric,store,workbooks})).ok,false,numeric);
 const completeReceipt=content=>({ok:true,status:'reviewed',issues:[],checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass'])),draftHash:createHash('sha256').update(content).digest('hex'),verifiedEvidenceCount:1,evidenceHash:'a'.repeat(64)});
 const natural=createResearchReview({ctx:{root,store,workbooks}});
 const prose={path:'exports/natural.md',content:'模型利润率40%，需要产能兑现。',save:true};
 for(const patch of [{draftHash:'b'.repeat(64)},{status:'unavailable'},{verifiedEvidenceCount:0},{checks:{source_quality:'pass'}}]) {
   natural.setAuditor(async content=>({...completeReceipt(content),...patch}));
   assert.equal((await natural.tool.execute('stale',prose,undefined,undefined,context)).isError,true);
 }
 natural.setAuditor(async(content,extra)=>{assert.equal(extra.mode,'report');assert.equal(extra.publicationPending,true);return completeReceipt(content);});
 assert.equal((await natural.tool.execute('complete-review',prose,undefined,undefined,context)).isError,false);
 assert.equal(natural.draftSnapshot().saved,true);
 fs.writeFileSync(path.join(root,prose.path),'changed after publication');
 assert.equal(natural.draftSnapshot().saved,false,'changed files cannot be supplied as verified delivered artifacts');
 const missingFile=await reviewClaims({content:'利润8元',claims:[{id:'x',kind:'cell',ref:'Model!A1',text:'利润8元'}],store:{findMaterialByPath:file=>{assert.equal(typeof file,'string');return null;}},workbooks});
 assert.ok(missingFile.errors.some(e=>e.includes('来源文件不存在')));
 const hint=await reviewClaims({content:'利润8元',file:'uploads/m.xlsx',claims:[{id:'x',kind:'cell',ref:'Model!A1',text:'利润8元'}],store:{findMaterialByPath:()=>({id:'m'})},workbooks:{queryMaterial:async()=>({seeds:['Model!A1'],cells:[{ref:'Model!A1',value:8,rowLabel:'利润'}]})}});
 assert.equal(hint.referenceHints.length,1);assert.equal(hint.ok,false,'reference-only hints do not independently certify prose numbers');
} finally {fs.rmSync(root,{recursive:true,force:true});}

// An audit receipt must name real successful evidence, never a failed lookup,
// a report write, a fabricated ID or an unrelated assistant draft.
const auditJson=id=>JSON.stringify({checks:Object.fromEntries(AUDIT_CHECKS.map(k=>[k,'pass'])),issues:[],numericCoverage:[{index:0,evidenceIds:[id]}]});
for(const [id,expected] of [['e1',[0]],['missing',[]],['bad',[]],['draft',[]],['self-read',[]]]) {
 const result=await auditResearch(async()=>stream(msg(auditJson(id))),{}, {messages:[
  {role:'user',content:'核验收入'},
  {role:'toolResult',toolCallId:'e1',toolName:'web_fetch',isError:false,content:[{type:'text',text:'甲公司2026年收入100亿元。'}]},
  {role:'toolResult',toolCallId:'bad',toolName:'web_fetch',isError:true,content:[]},
  {role:'toolResult',toolCallId:'draft',toolName:'write',isError:false,content:[]},
  {role:'toolResult',toolCallId:'self-read',toolName:'read',isError:false,content:[{type:'text',text:'自行生成的报告'}]},
 ]},{},'甲公司2026年收入100亿元。',{unboundNumericLines:['收入100亿元。']});
 assert.deepEqual(result.coverageValidated,expected);
 assert.equal(result.verifiedPassages.length,expected.length);
}

const partialChecks=Object.fromEntries(AUDIT_CHECKS.map(k=>[k,k==='source_quality'?'fail':'pass']));
// A real source omitted by the audit context budget cannot certify a passage.
const omitted=await auditResearch(async()=>stream(msg(auditJson('too-old'))),{}, {messages:[
 {role:'user',content:'核验收入'},
 {role:'toolResult',toolCallId:'too-old',toolName:'web_fetch',isError:false,content:[{type:'text',text:'甲公司收入100亿元。'.repeat(6000)}]},
 ...Array.from({length:4},(_,i)=>({role:'toolResult',toolCallId:`recent-${i}`,toolName:'web_fetch',isError:false,content:[{type:'text',text:'近期来源。'.repeat(12000)}]})),
]},{},'甲公司收入100亿元。',{unboundNumericLines:['甲公司收入100亿元。']});
assert.deepEqual(omitted.coverageValidated,[]);
for(const issue of ['另一项缺少来源。','甲公司2026年收入100亿元。']) {
 const draft='甲公司2026年收入100亿元。\n\n另一项缺少来源。';
 const partial=await auditResearch(async()=>stream(msg(JSON.stringify({checks:partialChecks,issues:[{check:'source_quality',excerpt:issue,reason:'缺少可核实来源'}],numericCoverage:[{index:0,evidenceIds:['e1']}]}))),{}, {messages:[
  {role:'user',content:'核验收入'},
  {role:'toolResult',toolCallId:'e1',toolName:'web_fetch',isError:false,content:[{type:'text',text:'甲公司2026年收入100亿元。'}]},
 ]},{},draft,{unboundNumericLines:['甲公司2026年收入100亿元。']});
 assert.equal(partial.ok,false);
 assert.equal(partial.verifiedPassages.length,issue.startsWith('另一项')?1:0,'Partial audits retain independent verified paragraphs only');
}

// After the report retry budget is exhausted, compose from the resolved draft
// and evidence instead of replaying failed tool instructions/placeholders.
const history=[{role:'user',content:'请分析估值模型并保存报告'}];
for(let i=0;i<6;i++) history.push({role:'assistant',content:[{type:'toolCall',id:`r${i}`,name:'review_research',arguments:{path:'exports/report.MD',content:'目标价{{V!A1}}'}}]},
 {role:'toolResult',toolName:'review_research',toolCallId:`r${i}`,isError:true,content:[{type:'text',text:'待核验'}]});
let calls=0;
const guarded=guardResearchDelivery(guardToolProtocol(async(_m,context)=>{
 assert.equal(getCurrentTools(normalizeContext(context).messages).length,0);
 assert.doesNotMatch(JSON.stringify(context),/目标价\{\{V!A1\}\}/);
 assert.match(JSON.stringify(context),/模型目标价80元/);
 assert.match(JSON.stringify(context),/state.json/);
 return stream(msg(++calls===1?xml():'模型目标价80元建立在利润率假设之上，仍需观察成本兑现；报告尚未保存。'));
}),{audit:async()=>({ok:true,issues:[]}),getSessionMessages:()=>history,
 getReportDraft:()=>({content:'模型目标价80元',issues:['外部行业数据待核实'],saved:false}),
 getArtifacts:()=>[{path:'exports/state.json',saved:true,sha256:'a'.repeat(64)}]});
const final=await (await guarded({}, {messages:history},{})).result();
assert.equal(final.stopReason,'stop');assert.match(final.content[0].text,/80元/);assert.doesNotMatch(final.content[0].text,/DSML|\{\{/);
console.log('PASS protocol decoding, tool boundaries, case-insensitive reports, evidence-bound numeric coverage and clean final recovery');

const declarations=['read','write','edit','review_research'].map(name=>({name,parameters:Type.Object({})}));
for (const question of [
 '请分析估值模型，报告写到 exports/company/report.md。',
 '请完成投资框架，同时把结论落成可跟踪的状态文件。',
 '解读模型并输出报告文件。',
 '请解读模型，报告写至 exports/research/result.MD。',
 '请分析模型，不要写入原模型，同时生成报告。',
]) {
 assert.equal(researchContract(question).artifactRequested,true,question);
 const ctx=researchAnswerContext({tools:declarations,messages:[{role:'user',content:question}]},question);
 assert.ok(getCurrentTools(normalizeContext(ctx).messages).some(t=>t.name==='review_research'),question);
}
for (const question of ['解释模型的估值方法。','解释模型，不要生成报告。','解释模型，无需保存文件。']) {
 assert.equal(researchContract(question).artifactRequested,false,question);
 const ctx=researchAnswerContext({tools:declarations,messages:[{role:'user',content:question}]},question);
 assert.ok(!getCurrentTools(normalizeContext(ctx).messages).some(t=>t.name==='review_research'),question);
}
assert.equal(researchContract('结合截至今天的最新行情形成七节投资框架，落成可跟踪状态文件。').marketRequested,true);
assert.equal(researchContract('结合截至今天的最新行情形成七节投资框架，落成可跟踪状态文件。').method,false);
assert.equal(researchContract('如何检验增长？列出所需数据。').method,true);
console.log('PASS explicit artifact destinations retain review tools; full analysis and market scope are not downgraded by tracking language');
