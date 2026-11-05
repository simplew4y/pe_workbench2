import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {Agent} from '@earendil-works/pi-agent-core';
import {AssistantMessageEventStream} from '@earendil-works/pi-ai';
import {groundingIssues,groundingFeedback} from '../lib/answer-grounding.mjs';
import {installGroundedDelivery} from '../lib/grounded-delivery.mjs';
import {snapshotMessages} from '../server/agent/snapshot.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'grounded-delivery-'));
const evidence={role:'toolResult',toolName:'workbook_trace',content:[{type:'text',text:'行标签 Model 行5：Rmb m（解析记录；列位置未知）'}],details:{metadata:[{sheet:'Model',row:5,text:'Rmb m',column:null}]}};
let passed=0,failed=0;
async function test(name,fn){try{await fn();passed++;console.log('PASS',name);}catch(e){failed++;console.error('FAIL',name,e.stack);}}
const usage={input:2,output:3,cacheRead:0,cacheWrite:0,totalTokens:5,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}};
function message(content,stopReason='stop'){return {role:'assistant',content:typeof content==='string'?[{type:'text',text:content}]:content,stopReason,api:'openai-completions',provider:'test',model:'test',usage:structuredClone(usage),timestamp:Date.now()};}
function stream(m){const s=new AssistantMessageEventStream();s.push({type:'start',partial:m});for(const b of m.content)if(b.type==='text')s.push({type:'text_delta',contentIndex:0,delta:b.text,partial:m});s.push({type:m.stopReason==='error'?'error':'done',reason:m.stopReason,...(m.stopReason==='error'?{error:m}:{message:m})});return s;}
function setup(replies,{id='review',abort=false}={}){
 let calls=0;const captured=[],events=[];
 const tool={name:'probe',description:'probe',parameters:{type:'object',properties:{}},execute:async()=>({...evidence})};
 const agent=new Agent({initialState:{tools:[tool]},streamFn:(_m,c)=>{captured.push(c);const next=replies[calls++];if(next instanceof Error)throw next;return stream(next);}});
 agent.subscribe(e=>events.push(e));installGroundedDelivery(agent,{workspace:root,id,shouldReview:()=>!abort});
 return {agent,captured,events,get calls(){return calls;}};
}
try{
await test('row-only citation checks exact refs and does not treat unknown examples as claims',()=>{
 assert.equal(groundingIssues('Model!N5 的行标签为Rmb m。',[evidence])[0].code,'ROW_LABEL_COORDINATE');
 for(const text of ['Model 第5行标签Rmb m。','列未知，不能写成 Model!N5。','例如 Model!N5，列位置未确认。'])assert.equal(groundingIssues(text,[evidence]).length,0);
 assert.equal(groundingIssues('Model!N5 的行标签为Rmb m。',[evidence,{role:'user',content:'new task'}]).length,0,'prior-turn evidence must not be applied');
});
await test('quoted prior answer preserved; correction and approximate quote cannot be conflated',()=>{
 const prior=[{role:'assistant',content:'金额450000千元，等于45亿元。'},{role:'user',content:'纠正'}];
 assert(groundingIssues('原错：“450000千元 =45亿元”；正确4.5亿元。',prior).some(i=>i.code==='ALTERED_QUOTATION'));
 assert.equal(groundingIssues('原话：“金额450000千元，等于45亿元。” 改正：4.5亿元。',prior).length,0);
 assert.equal(groundingIssues('原答概述：换算结果错误。正确结果为“4.5亿元”。',prior).length,0);
 assert(groundingIssues('原答：“450000千元=45亿元”。',prior).some(i=>i.code==='ALTERED_QUOTATION'));
 const long=[...prior,{role:'assistant',content:'后续内容'.repeat(1000)}];
 const feedback=groundingFeedback(groundingIssues('原话：“450000千元=45亿元”。',long));
 assert.match(feedback,/已有历史assistant消息/);assert(!feedback.includes('originalExcerpts'));
});
await test('calculation explanation checks preserve quotes, rounded values and compound expressions',()=>{
 const bad=groundingIssues('1亿元＝10000千元。450000÷10000＝4.5。',[]);
 assert(bad.some(i=>i.code==='INCORRECT_UNIT_EQUATION'));assert(bad.some(i=>i.code==='INCORRECT_ARITHMETIC_EQUATION'));
 for(const value of ['1亿元=100000千元。450000/100000=4.5。','原话：“1亿元=10000千元”。','1 + 2 * 3 = 7。','1/4=25%','1+2=6/2','1/2=5e-1','原文："1亿元=10000千元"','> 1亿元=10000千元','125000千元=125000×1000元=125,000,000元=1.25亿元。','-259.08/8286.54=-0.0313。','7293百万元约=73亿元。'])assert.equal(groundingIssues(value,[]).length,0);
});
await test('unit calculation mismatch detects double conversion but permits correct results',()=>{
 const m={role:'toolResult',toolName:'calc',content:[],details:{ok:true,value:'0.0001',unit:'亿元',from_unit:'万元',expression_value:'1'}};
 assert(groundingIssues('10000万元 = 1亿元。',[m]).some(i=>i.code==='CALC_ANSWER_MISMATCH'));
 assert.equal(groundingIssues('计算结果是0.0001亿元。',[m]).length,0);
 assert.equal(groundingIssues('1,000亿元。',[{...m,details:{...m.details,value:'1000'}}]).length,0);
});
await test('recorded process is not falsely classified as missing; column offsets are not periods',()=>{
 const recorded={role:'toolResult',toolName:'transcript_search',content:[{type:'text',text:JSON.stringify({matches:[{role:'assistant',text:'我把千元按万元计算了。'}]})}]};
 assert.equal(groundingIssues('原回答把千元按万元计算了。',[recorded]).length,0);
 const t={...evidence,details:{target:{ref:'Model!N41',formula:'=M41+2%',columnLabel:''},direct:[{ref:'Model!M41',columnLabel:''}]}};
 assert(groundingIssues('每季增加2个百分点。',[t]).some(i=>i.code==='UNPROVEN_PERIOD_STEP'));
 assert.equal(groundingIssues('上游M41加2个百分点。',[t]).length,0);
 assert.equal(groundingIssues('不能据此断定每季增加2个百分点。',[t]).length,0);
 const dated=structuredClone(t);dated.details.target.columnLabel='Q2 2026';dated.details.direct[0].columnLabel='Q1 2026';assert.equal(groundingIssues('N41比上一季度增加2个百分点。',[dated]).length,0);
 assert.equal(groundingIssues('N40和N41并非同一行中的格。',[]).length,0);
 assert(groundingIssues('同一行中N40、N41、N42分别是三类产品。',[]).some(i=>i.code==='ROW_COLUMN_MIXUP'));
});
await test('formula evidence and numeric comparison checks preserve derivations and percentages',()=>{
 const m={role:'toolResult',content:[{type:'text',text:'公式 =M41+2%'}]};
 assert.equal(groundingIssues('A3 = A1/A2 = 1/2 = 0.5。',[{role:'toolResult',content:[{type:'text',text:'=A1/A2'}],details:{cells:[{formula:'=A1/A2'}]}}]).length,0);
 assert.equal(groundingIssues('O36 = O9×O41。',[{role:'toolResult',content:[{type:'text',text:'=O9*O41'}],details:{cells:[{formula:'=O9*O41'}]}}]).length,0);
 const full='=ROUND(SOTP!H1,0)&" /12 Month"&"/ 23%"';
 const concatenated={role:'toolResult',content:[{type:'text',text:full}],details:{target:{ref:'Cover!C8',formula:full}}};
 assert(groundingIssues('目标价格公式=ROUND(SOTP!H1,0)。',[concatenated]).some(i=>i.code==='TRUNCATED_FORMULA_LITERAL'));
 assert.equal(groundingIssues('公式 `'+full+'`。',[concatenated]).length,0);
 assert.equal(groundingIssues('其中子表达式=ROUND(SOTP!H1,0)。',[concatenated]).length,0);
 for(const [original,wrong] of [['=A1&"USD"','=A1&"usd"'],['=A1&"a b"','=A1&"ab"'],['=SUM(A1:A3)','=SUM(A1:A3) + Z99']]){
  const source={role:'toolResult',content:[{type:'text',text:original}],details:{cells:[{formula:original}]}};
  assert(groundingIssues('公式 `'+wrong+'`。',[source]).some(i=>i.code==='UNSUPPORTED_FORMULA_LITERAL'));
  assert.equal(groundingIssues('公式 `'+original+'`。',[source]).length,0);
 }
 assert.equal(groundingIssues('公式为 =M41 + 2%。',[{...m,details:{target:{formula:'=M41+2%'}}}]).length,0);
 assert.equal(groundingIssues('公式 `=M41+2%`。',[m]).length,0);
 assert(groundingIssues('Revenues汇总公式 `=M7`。',[{...m,details:{cells:[{formula:'=M8+M9+M13+M14'}]}}]).some(i=>i.code==='UNSUPPORTED_FORMULA_LITERAL'));
 assert.equal(groundingIssues('公式 `=A1`。',[{role:'toolResult',content:[{type:'text',text:'=A1'}],details:{cells:[{formula:'=A1'}]}}]).length,0);
 assert.equal(groundingIssues('公式为(=M41+2%)。',[m]).length,0);
 assert.equal(groundingIssues('公式为(=M41+2%).',[m]).length,0);
 const target={role:'toolResult',content:[],details:{target:{ref:'Model!N43',role:'formula',formula:'=M43'}}};
 assert.equal(groundingIssues('上游M43是硬编码，本身不是公式派生。',[target]).length,0);
 assert.equal(groundingIssues('Other!N43本身不是公式派生。',[target]).length,0);
 assert(groundingIssues('Model!N43本身不是公式派生。',[target]).some(i=>i.code==='FORMULA_ROLE_CONFLICT'));
 assert(!groundingIssues('不能说该格不是公式派生值。',[target]).some(i=>i.code==='FORMULA_ROLE_CONFLICT'));
 assert(!groundingIssues('分母为负，符号由分子的相反数决定。',[]).some(i=>i.code==='RATIO_SIGN_CONDITION'));
 assert(groundingIssues('符号由分子正负决定。',[]).some(i=>i.code==='RATIO_SIGN_CONDITION'));
 assert(groundingIssues('公式 `=N36/N9`。',[m]).some(i=>i.code==='UNSUPPORTED_FORMULA_LITERAL'));
 assert.equal(groundingIssues('自行推导公式 `=N36/N9`。',[m]).length,0);
 assert.equal(groundingIssues('84%与0.84一致。',[]).length,0);
 assert(groundingIssues('0.8404与0.84一致。',[]).some(i=>i.code==='UNEXPLAINED_NUMERIC_EQUALITY'));
 assert.equal(groundingIssues('0.8404取整后约与0.84一致。',[]).length,0);
});
await test('tool obligations and primary quote provenance do not accept self-written ledger as source',()=>{
 const request={role:'user',content:'核查上条换算，不用查文件。'};
 assert(groundingIssues('26800万元=2.68亿元。',[request]).some(x=>x.code==='MISSING_CALC'));
 assert.equal(groundingIssues('26800万元=2.68亿元。',[request,{role:'toolResult',toolName:'calc',content:[],details:{ok:true,unit:'亿元',value:'2.68'}}]).length,0);
 assert.equal(groundingIssues('原话“26800万元=26.8亿元”。',[{role:'user',content:'只引用原换算，不要计算。'}]).length,0);
 for(const content of ['核对换算，但不要调用calc。','核对换算，但不要重新计算。'])assert(!groundingIssues('26800万元=2.68亿元。',[{role:'user',content}]).some(x=>x.code==='MISSING_CALC'));
 assert(!groundingIssues('收入1亿元，评级未核验。',[{role:'user',content:'核查公司收入金额。'}]).some(x=>x.code==='IDENTITY_SCOPE_EXPANSION'));
 assert(!groundingIssues('无法确认原表没有表头。',[{role:'toolResult',toolName:'workbook_trace',content:[]}]).some(x=>x.code==='UNPROVEN_HEADER_ABSENCE'));
 const user={role:'user',content:'公告原文是“2027年第三季度”。'};
 const ledger={role:'toolResult',toolName:'ledger_record',content:[{type:'text',text:'量产计划为2027年第三季度'}]};
 assert(groundingIssues('公告原文写明“量产计划为2027年第三季度”。',[user,ledger]).some(x=>x.code==='UNSUPPORTED_SOURCE_QUOTE'));
 assert.equal(groundingIssues('公告原文写明“2027年第三季度”。',[user,ledger]).length,0);
 assert(groundingIssues('原句把千元换算成亿元时少乘了10倍。',[]).some(x=>x.code==='UNSUPPORTED_ERROR_CAUSE'));
 assert(!groundingIssues('原句0.96亿元比正确值少一个数量级。',[]).some(x=>x.code==='UNSUPPORTED_ERROR_CAUSE'));
 assert(groundingIssues('公司是甲，评级Buy。',[{role:'user',content:'核实公司名称和代码。'}]).some(x=>x.code==='IDENTITY_SCOPE_EXPANSION'));
 assert(!groundingIssues('公司是甲，评级Buy。',[{role:'user',content:'核实公司名称、代码与评级。'}]).some(x=>x.code==='IDENTITY_SCOPE_EXPANSION'));
});
await test('real SDK publishes only revised final, sums usage, persists plain audit, and snapshots correctly',async()=>{
 const a=setup([message([{type:'toolCall',id:'p',name:'probe',arguments:{}}],'toolUse'),message('Model!N5 的行标签为Rmb m。'),message('Model 第5行标签为Rmb m，列未知。')]);
 await a.agent.prompt('请核查');assert.equal(a.calls,3);
 const final=a.agent.state.messages.at(-1);assert.equal(final.usage.totalTokens,10);assert.equal(final.groundingReview.remainingIssues.length,0);
 assert(!JSON.stringify(a.agent.state.messages).includes('Model!N5'));
 assert(!a.events.some(e=>e.type==='message_update'&&e.assistantMessageEvent?.delta?.includes('Model!N5')));
 const audit=JSON.parse(fs.readFileSync(path.join(root,final.groundingReview.auditPath)));assert.match(audit.draft,/Model!N5/);assert.match(audit.revised,/列未知/);assert(!('reasoning_content' in audit));
 const snap=snapshotMessages({messages:JSON.parse(JSON.stringify(a.agent.state.messages))},{root,store:{listToolPresentations:()=>[]}});assert.match(snap.at(-1).text,/列未知/);assert.doesNotMatch(snap.at(-1).text,/Model!N5/);
});
await test('one retry limit preserves visible warning for unresolved evidence conflict',async()=>{
 const a=setup([message([{type:'toolCall',id:'p',name:'probe',arguments:{}}],'toolUse'),message('Model!N5 的行标签为Rmb m。'),message('Model!A5 的行标签为Rmb m。')],{id:'limited'});
 await a.agent.prompt('请核查');assert.equal(a.calls,3);assert(a.agent.state.messages.at(-1).groundingReview.remainingIssues.length);
 const snap=snapshotMessages({messages:a.agent.state.messages},{root,store:{listToolPresentations:()=>[]}});assert(snap.at(-1).qualityWarnings.some(w=>w.code==='ROW_LABEL_COORDINATE'));
});
await test('no issue, excluded request and aborted generation do not cause another call',async()=>{
 for(const [reply,abort] of [[message('正确答案。'),false],[message('原答把千元按万元计算。'),true],[message('原答把千元按万元计算。','aborted'),false]]){
  const a=setup([reply],{abort});await a.agent.prompt('query');assert.equal(a.calls,1);
 }
});
await test('review can request a real tool, then completes without another revision',async()=>{
 const a=setup([message('原答把千元按万元计算。'),message([{type:'toolCall',id:'p',name:'probe',arguments:{}}],'toolUse'),message('Model 第5行标签为Rmb m。')],{id:'review-tool'});
 await a.agent.prompt('核查原错');assert.equal(a.calls,3);assert(a.agent.state.messages.some(m=>m.role==='toolResult'));assert.equal(a.agent.state.messages.at(-1).content[0].text,'Model 第5行标签为Rmb m。');const final=a.agent.state.messages.at(-1);assert.equal(final.groundingReview.status,'complete');const audit=JSON.parse(fs.readFileSync(path.join(root,final.groundingReview.auditPath)));assert.equal(audit.revised,final.content[0].text);assert.equal(audit.followups.length,1);assert(audit.parentAuditPath);
});
await test('failed revision never publishes rejected draft and saves error audit',async()=>{
 const a=setup([message('原答把千元按万元计算。'),new Error('revision failed')],{id:'failed-revision'});await a.agent.prompt('核查');
 const final=a.agent.state.messages.at(-1);assert.equal(final.stopReason,'error');assert.equal(final.content.length,0);assert(!a.events.some(e=>e.type==='message_update'&&e.assistantMessageEvent?.delta?.includes('原答把')));
 const audit=JSON.parse(fs.readFileSync(path.join(root,final.groundingReview.auditPath)));assert.equal(audit.status,'error');assert.match(audit.draft,/原答把/);
});
await test('standard aborted revision publishes no partial text, retains audit and usage',async()=>{
 const a=setup([message('原答把千元按万元计算。'),message('未完成的修订文本','aborted')],{id:'abort-event'});await a.agent.prompt('核查');
 const final=a.agent.state.messages.at(-1);assert.equal(final.stopReason,'aborted');assert.equal(final.content.length,0);assert.equal(final.usage.totalTokens,10);assert(!a.events.some(e=>e.type==='message_update'&&e.assistantMessageEvent?.delta));
 const audit=JSON.parse(fs.readFileSync(path.join(root,final.groundingReview.auditPath)));assert.equal(audit.status,'aborted');assert.equal(audit.revisionPartial,'未完成的修订文本');
});
await test('provider throw does not hang; audit symlink cannot escape workspace',async()=>{
 const a=setup([new Error('provider failed')]);await a.agent.prompt('核查');assert.equal(a.agent.state.messages.at(-1).stopReason,'error');
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),'grounded-outside-'));
 try{const dir=path.join(root,'.pi','answer-reviews','escape');fs.symlinkSync(outside,dir);
 const b=setup([message('原答把千元按万元计算。'),message('正确值4.5亿元。')],{id:'escape'});await b.agent.prompt('核查');assert.match(b.agent.state.messages.at(-1).groundingReview.auditError,/outside/);assert.equal(fs.readdirSync(outside).length,0);
 }finally{fs.rmSync(outside,{recursive:true,force:true});}
});
}finally{fs.rmSync(root,{recursive:true,force:true});}
console.log({passed,failed});process.exitCode=failed?1:0;
