/** Controlled evidence replay, not the original full conversation or Excel recalculation. */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import zlib from 'node:zlib';
import { queryGraph, formatResult } from '../lib/workbook-query.mjs';
import { traceGraph, formatTrace } from '../lib/workbook-trace.mjs';
import { systemHint } from '../server/project-context.mjs';
const phase = process.argv[2];
if (!['before','after'].includes(phase)) throw Error('usage: node scripts/eval-reliability.mjs before|after');
if(phase==='before') {
 try {execFileSync('git',['diff','--quiet','HEAD','--','lib','server','services'],{stdio:'ignore'});}
 catch {throw Error('before必须在修复前的产品代码上运行；拒绝以修改后的代码覆盖基线。已有基线请直接读取。');}
}
const out = path.resolve(process.env.EVAL_OUT || 'out/reliability-eval'); fs.mkdirSync(out,{recursive:true});
const source = process.env.EVAL_SOURCE;
if(!source)throw Error('请用 EVAL_SOURCE 指定归档 source/2026-11-03 目录；评估不内置私人证据。');
const hashes = {T:'f85695b3870bdd90bb57c2423555a8399fb2bab2fa6795d355807e64daaf8a01',C:'fb9e5ff89689dd85ba80ef85bd309e14d793e5d028b2dc019aabce7942185934'};
const graphs = Object.fromEntries(Object.entries(hashes).map(([k,h])=>[k,JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(source,'db/doc-cache',h+'.json.gz'))))]));
const cases = [
 {id:'R01',origin:'T003',book:'T',prompt:'SOTP!J132=831.1368468715082；J133=-9.6%*J132；J134=ROUNDUP(J132+J133,0)。分别算零折价和15%折价价格、相对原价变化。保留原取整规则。',expected:'832；707；原752；+80、-45；仅直接折价情景'},
 {id:'R02',origin:'T007',book:'T',prompt:'为云收入设跟踪失效条件，但没有历史分布，也没有阈值依据。现在怎样保存并进入跟踪？不要杜撰校准证据。',expected:'待校准；具体校准计划；不armed'},
 {id:'R03',origin:'T010',book:'T',prompt:'请检查 Cover Page，确认模型公司及证券代码，并说明证据位置。',expected:'Tencent Holdings (0700.HK)，封面行6'},
 {id:'R04',origin:'T016',book:'T',prompt:'两个净利润数值为7053440、6376310，单位人民币百万元。请分别换算成亿元。',expected:'70534.4亿元；63763.1亿元'},
 {id:'R05',origin:'T063',book:'T',prompt:'IS!AE1351能当独立敏感性输入吗？请查公式并说明真正的上游输入。',expected:'AE1351=AD1351-1，为派生公式；不能独立扰动'},
 {id:'R06',origin:'T056',book:'T',prompt:'游戏价值320.8766413，短视频46.40438543，pre-NAV831.13684687。算游戏单独占比及两者合计占比；2026E是预测，不能因今天日期就判断是否已披露。最后给出悲观、基准、乐观三种方向，不要编具体价。',expected:'38.61%与44.19%分别标记；预测身份；三情景完整'},
 {id:'R07',origin:'C026',book:'C',prompt:'请查 Assumption!N42 和 Discount PE!C8、E8，核实HBM毛利率及相关百分比的正负号，不要把利用率当毛利率。',expected:'65%；C8负3.13%、E8正5.58%'},
 {id:'R08',origin:'C029',book:'C',prompt:'CF!L14资本开支是否通过现金、利息收入影响 Discount PE!H29？请验证依赖路径。局部检索没看到能否说没有？',expected:'有路径；不得根据局部结果否认'},
 {id:'R09',origin:'C056',book:'C',history:[{role:'assistant',content:'HBM在2026年上半年量产。'},{role:'user',content:'纠正：资料第3页写的是1H27，即2027年上半年，不是2026年上半年。'},{role:'assistant',content:'已确认这个更正。'}],prompt:'现在重新说一下HBM量产时间和需要验证什么。',expected:'2027上半年；不回退旧错'},
 {id:'R10',origin:'C089',book:'C',history:[{role:'assistant',content:'Assumption!N13=7293，单位百万元，折合约7.3亿元。'}],prompt:'核查你前面回答有没有单位换算错误，指出原话并改正。',expected:'明确承认7293百万元=72.93亿元，原7.3错误'},
];
const frozen = path.join(out,'cases.json');
if (!fs.existsSync(frozen)) fs.writeFileSync(frozen,JSON.stringify(cases,null,2));
else if (JSON.stringify(JSON.parse(fs.readFileSync(frozen)))!==JSON.stringify(cases)) throw Error('Frozen cases changed');
const env={...process.env};
const envFile=process.env.EVAL_ENV || '.env.local';
for(const line of (fs.existsSync(envFile)?fs.readFileSync(envFile,'utf8'):'').split('\n')) { const m=line.match(/^([A-Z_]+)=(.*)$/); if(m&&!env[m[1]])env[m[1]]=m[2].replace(/^['"]|['"]$/g,''); }
const tools=[{name:'workbook_query',description:'查询缓存工作簿：关键词、Sheet名或Sheet!A1',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}},{name:'workbook_trace',description:'追踪工作簿依赖',parameters:{type:'object',properties:{cell:{type:'string'},sheet:{type:'string'},rows:{type:'string'},mode:{type:'string',enum:['path','impact']},from:{type:'string'},to:{type:'string'},depth:{type:'number'}}}}];
if(phase==='after') {
 const {createWorkbookTraceTool}=await import('../lib/workbook-trace-tool.mjs');
 const t=createWorkbookTraceTool({});tools[1]={...t};
}
let calc;
if(phase==='after' && fs.existsSync(new URL('../lib/calc-tool.mjs',import.meta.url))) {calc=(await import('../lib/calc-tool.mjs')).createCalcTool(); tools.push(calc);}
let hint=systemHint({name:'受控复现',root:'/fixture'},{workbookQuery:true});
if(phase==='after' && fs.existsSync(new URL('../lib/research-context.mjs',import.meta.url))) hint+='\n'+(await import('../lib/research-context.mjs')).researchProtocol(new Date('2026-11-03T04:00:00Z'));
if(!fs.existsSync(path.join(out,phase+'-config.json'))) fs.writeFileSync(path.join(out,phase+'-config.json'),JSON.stringify({model:env.PI_MODEL||'deepseek-v4-pro',temperature:0,max_tokens:2200,repeats:1,source:'archived parsed graphs; shortened controlled context',system:hint},null,2));
async function run(c){
 const dest=path.join(out,phase+'-'+c.id+'.json'); if(fs.existsSync(dest))return;
 const messages=[{role:'system',content:hint+'\n这是只读受控评估，只回答当前问题，限制500中文字；工具里的数值是缓存。无需写报告文件。'},...(c.history||[]),{role:'user',content:c.prompt}];
 const available=[...tools];
 if(phase==='after' && fs.existsSync(new URL('../lib/research-context.mjs',import.meta.url))){
   const {createResearchTools}=await import('../lib/research-context.mjs');
   const workspace=path.join(out,phase+'-session-'+c.id);fs.mkdirSync(workspace,{recursive:true});
   available.push(...createResearchTools({workspace,getSession:()=>({sessionId:c.id,messages})}));
 }
 const log=[]; let usage=[];
 try {for(let step=0;step<7;step++) {
  const res=await fetch('https://api.deepseek.com/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+env.DEEPSEEK_API_KEY,'Content-Type':'application/json'},body:JSON.stringify({model:env.PI_MODEL||'deepseek-v4-pro',messages,tools:available.map(t=>({type:'function',function:{name:t.name,description:t.description,parameters:t.parameters}})),temperature:0,max_tokens:2200,thinking:{type:'disabled'}}),signal:AbortSignal.timeout(120000)});
  if(!res.ok)throw Error('HTTP '+res.status+' '+(await res.text()).slice(0,300));
  const data=await res.json(),m=data.choices[0].message; usage.push(data.usage); messages.push(m);
  if(!m.tool_calls?.length){log.push({answer:m.content,finish_reason:data.choices[0].finish_reason});break;}
  for(const t of m.tool_calls){let result;try{const a=JSON.parse(t.function.arguments);result=!['workbook_query','workbook_trace'].includes(t.function.name)&&available.find(x=>x.name===t.function.name)?.execute?await available.find(x=>x.name===t.function.name).execute(t.id,a):t.function.name==='workbook_query'?formatResult(queryGraph(graphs[c.book],a.query)):formatTrace(traceGraph(graphs[c.book],a));}catch(e){result={isError:true,error:e.message};}log.push({name:t.function.name,args:t.function.arguments,result});messages.push({role:'tool',tool_call_id:t.id,content:typeof result==='string'?result:JSON.stringify(result)});}
 }
 fs.writeFileSync(dest,JSON.stringify({id:c.id,expected:c.expected,status:log.some(x=>'answer' in x)?'answered':'step_limit',log,usage},null,2));console.log(phase,c.id,'saved');
 }catch(e){fs.writeFileSync(dest,JSON.stringify({id:c.id,error:e.message,log,usage},null,2));console.log(phase,c.id,'FAILED',e.message);}
}
for(let i=0;i<cases.length;i+=2)await Promise.all(cases.slice(i,i+2).map(run));
