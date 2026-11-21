import assert from 'node:assert/strict';
import {financialEvidenceFindings} from '../lib/financial-evidence.mjs';
import {lintAnswer} from '../lib/answer-lint.mjs';
import {queryGraph} from '../lib/workbook-query.mjs';
import {researchPortion} from '../server/agent/answer-delivery.mjs';
const base={materialId:'m',version:1,filename:'模型.xlsx',currency:'CNY',raw_unit:'亿元',display_unit:'亿元',metric:'Revenues',basis_type:'forecast'};
const cites=[391,525,608].map((value,i)=>({...base,id:'r'+i,locator:`IS!${['A','B','C'][i]}1`,period:`${2025+i}E`,value}));
const check=(s,c=cites)=>financialEvidenceFindings(s,{citations:c,question:'解释估值关键假设'},[]);
const range='2025E—2027E收入分别为391亿元、525亿元、608亿元（[模型.xlsx]IS!A1、B1、C1）。';
assert.deepEqual(check(range),[]);
assert.ok(check(range.replace('391亿元、525亿元','525亿元、391亿元')).some(f=>f.severity==='error'));
const separated='2025E收入391亿元、2026E收入525亿元、2027E收入608亿元（[模型.xlsx]IS!A1、B1、C1）。';
assert.deepEqual(check(separated),[]);
assert.ok(check(separated.replace('2025E收入391','2026E收入391')).some(f=>f.severity==='error'));
const missing=cites.map((c,i)=>i===0?{...c,raw_unit:'',display_unit:''}:c);
const findings=check(range,missing);
assert.ok(findings.some(f=>f.claim.value==='391' && f.evidenceStatus==='metadata_missing' && f.severity==='warning'));
assert.ok(!findings.some(f=>f.claim.value==='391' && f.expected==='2026E'));
const price={...base,id:'p',locator:'SOTP!J134',value:752,metric:'NAV',period:'',raw_unit:'元/股',display_unit:'元/股',currency:'HKD'};
assert.deepEqual(check('模型目标价为752港元（[模型.xlsx]SOTP!J134）。',[price]),[]);
assert.ok(check('模型目标价为999港元（[模型.xlsx]SOTP!J134）。',[price]).some(f=>f.severity==='error'));
assert.ok(check('模型目标价为752美元（[模型.xlsx]SOTP!J134）。',[price]).some(f=>f.field==='currency'));
assert.ok(check('公司净利润为752港元（[模型.xlsx]SOTP!J134）。',[price]).some(f=>f.severity==='error'));
assert.ok(!lintAnswer('**判断：估值取决于利润兑现。').some(f=>f.rule==='incomplete'));
assert.ok(lintAnswer('判断：（估值取决于利润兑现。').some(f=>f.rule==='incomplete'));
const graph={sheets:[{name:'SOTP',contextCells:[['SOTP!H1',null,'Rmb mn',1,8]],rowLabels:{135:'Total shares outstanding (mn)',136:'EPS'}}],edges:[],cells:[
 ['SOTP!H135','',9258,135,8,'Total shares outstanding (mn)','Rmb mn'],
 ['SOTP!H136','',20,136,8,'EPS','Rmb mn']]};
assert.equal(queryGraph(graph,'SOTP!H135',{maxCells:1}).cells[0].display_unit,'百万股');
assert.equal(queryGraph(graph,'SOTP!H136',{maxCells:1}).cells[0].display_unit,'元/股');
const bad='模型目标价为999港元（[模型.xlsx]SOTP!J134）。';
const conditional='这一估值取决于盈利增长能否持续。如果回报率不能覆盖资本成本，就需要下调增长假设，同时观察现金流的变化。';
const dependent='因此公司明显低估，当前价格有确定的上行空间。';
const rejected=check(bad,[price]);
const kept=researchPortion([bad,conditional,dependent].join('\n\n'),s=>check(s,[price]),rejected,[price]);
assert.ok(kept.includes(conditional));assert.ok(!kept.includes('999'));assert.ok(!kept.includes('明显低估'));
assert.ok(kept.includes('尚未完成全部核验'));
console.log('PASS annual series, grouped sources, missing metadata, price units, real conflicts, markdown, shares/EPS and coherent partial delivery');

const share={...base,id:'shares',locator:'SOTP!H135',value:9258,metric:'Total shares outstanding (mn)',currency:'',period:'',display_unit:'百万股',raw_unit:'百万股'};
assert.deepEqual(check('股数为92.58亿股（[模型.xlsx]SOTP!H135）。',[share]),[]);
assert.ok(check('股数为925.8亿股（[模型.xlsx]SOTP!H135）。',[share]).some(f=>f.severity==='error'));
assert.ok(check('模型目标价为999港元（[模型.xlsx]SOTP!J134）。',[{...price,currency:''}]).some(f=>f.field==='value' && f.severity==='error'));
console.log('PASS share scaling and missing metadata cannot hide known numerical conflicts');

assert.deepEqual(check('模型目标价为752港元（[模型.xlsx]SOTP!J134）。',[{...price,display_unit:'HKD',raw_unit:'HKD'}]),[]);
assert.deepEqual(check('模型目标价为752港元/股（[模型.xlsx]SOTP!J134）。',[{...price,display_unit:'HKD',raw_unit:'HKD'}]),[]);
assert.ok(check('模型目标价为752港元（[模型.xlsx]SOTP!J134）。',[{...price,metric:'NAV (pre holdco discount)'}]).some(f=>f.field==='metric'));
console.log('PASS price sources in currency or currency/share; pre-discount NAV stays distinct');

const multipleGraph={sheets:[{name:'SOTP',contextCells:[['SOTP!F2',null,'Discount PE',2,6]],rowLabels:{10:'Domestic Games'}}],edges:[],cells:[['SOTP!F10','',22.4,10,6,'Domestic Games','Discount PE']]};
assert.equal(queryGraph(multipleGraph,'SOTP!F10',{maxCells:1}).cells[0].display_unit,'倍');
const component={...price,id:'core',locator:'SOTP!J28',metric:'CORE',value:695};
assert.deepEqual(check('目标价752港元/股（SOTP!J134）。其中核心业务695港元（SOTP!J28）。',[price,component]),[]);
console.log('PASS PE column unit and per-share context within one paragraph');

const pct={...base,id:'pct',locator:'SOTP!K21',metric:'Wealth Mgmt.',value:0.03975363051155847,raw_unit:'decimal',display_unit:'%',currency:'',period:''};
assert.deepEqual(check('理财贡献为4.0%（SOTP!K21）。',[pct]),[]);
assert.ok(check('理财贡献为4.2%（SOTP!K21）。',[pct]).some(f=>f.severity==='error'));
console.log('PASS displayed decimal precision is respected for small percentages');

const {lintFactIdentity}=await import('../lib/fact-memory/context.mjs');
const memory={query:()=>({facts:[{entity:'Popmart',metric:'revenue',period:'2026E',basis_type:'forecast',raw_value:52520.923798414624,raw_unit:'百万元',currency:'CNY',quality:'source_checked'}]})};
assert.deepEqual(lintFactIdentity('2026E收入为525.2亿元。',memory),[]);
assert.ok(lintFactIdentity('2026E收入为600亿元。',memory).some(f=>f.severity==='error'));
console.log('PASS project memory uses the same display precision as current source checks');

const discount={...price,id:'discount',locator:'SOTP!J133',metric:'Discount',value:-79.78913729966479};
assert.deepEqual(check('每股折价约−79.8港元（SOTP!J133）。',[discount]),[]);
assert.ok(check('每股折价约79.8港元（SOTP!J133）。',[discount]).some(f=>f.severity==='error'));
console.log('PASS Unicode minus rounding preserves the sign');

assert.deepEqual(check('2025E—2027E收入分别为391、525、608亿元（[模型.xlsx]IS!A1、B1、C1）。'),[]);
assert.ok(check('2025E—2027E收入分别为391、999、608亿元（[模型.xlsx]IS!A1、B1、C1）。').some(f=>f.severity==='error'));
console.log('PASS parallel annual amounts inherit the explicitly shared trailing unit');

const {createCalcTool}=await import('../lib/calc-tool.mjs');
const nav={...price,id:'nav',locator:'SOTP!J134',value:752};
const dom={...price,id:'dom',locator:'SOTP!J8',value:219.2,metric:'Domestic Games'};
const bound=await createCalcTool().execute('dom-ratio',{name:'国内游戏占比',expression:'dom/nav*100',outputUnit:'%',bindings:{nav,dom},precision:1});
assert.ok(!bound.isError);
const ratioContext={citations:[nav,dom,...bound.details.citations],toolCalls:[{id:'dom-ratio',name:'calc',success:true,result:bound}]};
assert.deepEqual(financialEvidenceFindings('国内游戏占比29.1%（SOTP!J8）。',ratioContext,[]),[]);
assert.ok(financialEvidenceFindings('国内游戏占比19.1%（SOTP!J8）。',ratioContext,[]).some(f=>f.severity==='error'));
assert.ok(financialEvidenceFindings('国内游戏占比29.1%（SOTP!J8）。',{...ratioContext,toolCalls:[]},[]).some(f=>f.severity==='error'));
console.log('PASS derived percentages can cite either verified input without depending on binding order');

const {researchRecoverySources}=await import('../lib/research-delivery.mjs');
const related={...component,id:'weight',locator:'SOTP!K28',value:0.925,raw_unit:'decimal',display_unit:'%',currency:''};
const subset=researchRecoverySources('核心价值695港元/股（SOTP!J28）。',[component,related]);
assert.equal(subset.find(s=>s.id==='weight').display_value,'92.5000');
assert.ok(subset.some(s=>s.id==='core'));
assert.ok(!researchRecoverySources('核心价值695港元/股（SOTP!J28）。',[component,{...related,materialId:'other'}]).some(s=>s.id==='weight'));
console.log('PASS compact recovery keeps same-row context and explicitly formatted percentages');

const multiples=[22.4,26.49,25.49].map((value,i)=>({...base,id:'pe'+i,locator:`SOTP!U${[8,9,17][i]}`,value,metric:'',period:'',raw_unit:'unit_unknown',display_unit:'unit_unknown',currency:''}));
assert.deepEqual(check('三个倍数输入分别为22.4、26.49、25.49[模型.xlsx]SOTP!U8、SOTP!U9、SOTP!U17。',multiples),[]);
assert.ok(check('三个倍数输入分别为22.4、99.99、25.49[模型.xlsx]SOTP!U8、SOTP!U9、SOTP!U17。',multiples).some(f=>f.severity==='error'));
const weight={...component,id:'coreWeight',locator:'SOTP!K28',value:0.925,raw_unit:'decimal',display_unit:'%',currency:''};
assert.deepEqual(check('模型目标价752港元/股中，核心业务695港元/股，占92.5%（SOTP!J28、SOTP!K28）。',[price,component,weight]),[]);
console.log('PASS bare numbers do not swallow the first citation; component sources do not bind an introductory target');

const rate={...price,id:'rate',locator:'SOTP!D133',value:-0.096,metric:'Discount',raw_unit:'decimal',display_unit:'%',currency:''};
assert.deepEqual(check('控股折价率为9.6%（SOTP!D133）。',[rate]),[]);
assert.ok(check('控股贡献为正9.6%（SOTP!D133）。',[rate]).some(f=>f.severity==='error'));
assert.ok(check('控股折价率为19.6%（SOTP!D133）。',[rate]).some(f=>f.severity==='error'));
console.log('PASS discount magnitude is distinct from a falsely positive signed contribution');

assert.deepEqual(check('9.6%的控股折价是模型输入（SOTP!D133）。',[rate]),[]);
assert.ok(check('9.6%的控股贡献为正（SOTP!D133）。',[rate]).some(f=>f.severity==='error'));

const quarter={...base,id:'quarter',locator:'Assumption!N58',period:'4Q26E',metric:'Bit shipment',value:12578.1,raw_unit:'百万',display_unit:'百万',currency:''};
const header={...quarter,id:'header',locator:'Assumption!N2',metric:'4Q26E',value:'4Q26E'};
assert.deepEqual(check('4Q26E出货量为12578.1百万（Assumption!N58）。',[quarter,header]),[]);
assert.ok(check('3Q26E出货量为12578.1百万（Assumption!N58）。',[quarter,header]).some(f=>f.field==='period'));
assert.deepEqual(check('4Q26E出货量假设为12578.1百万（Assumption!N58）。',[quarter]),[]);
assert.ok(check('4Q26E实际出货量为12578.1百万（Assumption!N58）。',[quarter]).some(f=>f.field==='basis_type'));
const yoy={...base,id:'yoy',locator:'Revenue!J42',period:'2026E',metric:'yoy %',value:0.6,raw_unit:'decimal',display_unit:'%',currency:''};
assert.deepEqual(check('2026E同比增速为60%（Revenue!J42）。',[yoy]),[]);
assert.ok(!check('比例：4Q26E为60%（Revenue!J42）。',[yoy]).some(f=>f.claim?.value==='4'));
console.log('PASS quarter/half-year labels and forecast suffix, date masking, forecast assumptions and YoY metrics');

const bitRate={...quarter,id:'rate',locator:'Assumption!AD97',period:'4Q30E',metric:'LPDDR ASP',value:1.5392,raw_unit:'US$ / Gb',display_unit:'US$ / Gb',currency:'USD'};
assert.deepEqual(check('4Q30E单价为1.5392美元/Gb（Assumption!AD97）。',[bitRate]),[]);
assert.ok(check('4Q30E单价为1.5392美元/GB（Assumption!AD97）。',[bitRate]).some(f=>f.severity==='error'));
assert.ok(check('4Q30E单价为1.5392美元（Assumption!AD97）。',[bitRate]).some(f=>f.severity==='error'));
const absent='附件没有目标价。';
for(const c of [{...price,locator:'IS!J58',metric:'EPS'}, {...price,locator:'DCF!B8',metric:'Revenue',display_unit:'百万元'}])
 assert.ok(!lintAnswer(absent,{citations:[c]}).some(f=>f.rule==='target_missing_claim' && f.severity==='error'));
assert.ok(lintAnswer(absent,{citations:[price]}).some(f=>f.rule==='target_missing_claim' && f.severity==='error'));
console.log('PASS USD/Gb rates and EPS/DCF inputs are not model target prices');

assert.ok(researchRecoverySources('附件没有目标价。',[price]).some(c=>c.id===price.id));

const {researchRecoveryToolEvidence}=await import('../lib/research-delivery.mjs');
const toolHistory=[{role:'user',content:'旧问题'},{role:'assistant',content:[{type:'toolCall',id:'old',name:'web_fetch',arguments:{url:'old'}}]},{role:'toolResult',toolCallId:'old',content:'旧数据'},{role:'user',content:'当前问题'},
 {role:'assistant',content:[{type:'toolCall',id:'market',name:'westock_query',arguments:{code:'hk09992'}},{type:'toolCall',id:'fetch',name:'web_fetch',arguments:{url:'https://example.com/report'}}]},
 {role:'toolResult',toolCallId:'market',content:'现价140.4，日期2026-11-20'}, {role:'toolResult',toolCallId:'fetch',isError:true,content:'读取失败'},
 {role:'user',content:'内部重试',peInternal:true}];
const recoveredTools=researchRecoveryToolEvidence(toolHistory);
assert.equal(recoveredTools.length,2);assert.ok(recoveredTools[0].text.includes('140.4'));assert.equal(recoveredTools[1].isError,true);
assert.ok(!JSON.stringify(recoveredTools).includes('旧数据'));
console.log('PASS recovery retains current-turn external evidence and failures, excluding old turns');
