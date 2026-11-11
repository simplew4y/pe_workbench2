import assert from 'node:assert/strict';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import {readLedger,appendFact} from '../lib/ledger.mjs';
import {lintLedgerAnswer} from '../lib/answer-lint.mjs';
import {registerFact} from '../lib/fact-register.mjs';
import {buildTurnContext} from '../lib/turn-context.mjs';
import {upsertTopicFromFacts,validateTopicProposal,retrieveTopics,expandTopics,defaultLocate,updateTopicsFromFacts} from '../lib/topic-index.mjs';
import {createLedgerTool} from '../lib/ledger-tool.mjs';
const root=await mkdtemp(path.join(os.tmpdir(),'topic-index-'));
try {
 await mkdir(path.join(root,'.pi','ledger'),{recursive:true});
 await writeFile(path.join(root,'.pi','ledger','old.json'),JSON.stringify({version:1,sessionId:'old',facts:[],corrections:[],open:[]}));
 assert.deepEqual((await readLedger(root,'old')).topics,[]);
 await appendFact(root,'old',{id:'OLD',claim:'营业收入',value:100,unit:'亿元',period:'2024',evidence:{type:'tool',ref:'fixture'},turn:1,binding:{company:'A 公司',metric:'营业收入',period:'2024',unit:'亿元'},source:'workbook'});
 await registerFact(root,'old',{id:'NEW',claim:'营业收入',value:120,unit:'亿元',period:'2024',binding:{company:'A 公司',metric:'营业收入',period:'2024',unit:'亿元'},source:'user_correction'});
 await updateTopicsFromFacts(root,'old',{factIds:['NEW']});
 let l=await readLedger(root,'old'); let topic=l.topics[0];
 assert(topic.factIds.includes('NEW')); assert(!topic.factIds.includes('OLD'));
 assert.equal(l.facts.find(f=>f.id==='OLD').status,'superseded');
 const rejected=await validateTopicProposal({id:topic.id,title:topic.title,summary:'数字 999 亿',factIds:['NEW']},l);
 assert.equal(rejected.ok,false);assert.equal(rejected.reason,'unsourced_number');
 assert(!JSON.stringify((await readLedger(root,'old')).topics).includes('999'));
 const tool=createLedgerTool({ctx:{root},getSessionId:()=> 'old',getTurn:()=>2});
 const unauthorized=await tool.execute('x',{kind:'fact',claim:'回答数字',value:999,unit:'亿元'});
 assert.equal(unauthorized.isError,true);assert.match(unauthorized.content[0].text,/only from successful structured tool/);
 assert(!JSON.stringify((await readLedger(root,'old')).topics).includes('999'));
 const rows=[];for(let i=0;i<60;i++)rows.push({id:`MISS${i}`,claim:`无关指标${i}`,value:1000+i,unit:'亿元',binding:{company:`C${i}`,metric:`无关指标${i}`,period:'2024',unit:'亿元'},status:'current'});
 l=await readLedger(root,'old');l.facts.push(...rows);
 const selected={topicIds:[topic.id],parsed:{company:'A 公司',metric:'营业收入',periods:['2024']},clarification:{needed:false,missing:[]}};
 const ctx=await buildTurnContext({question:'A 公司营业收入',ledger:l,locator:async()=>selected});
 assert(ctx.content.includes('NEW'));assert(!ctx.content.includes('MISS10'));assert(!ctx.content.includes('MISS59'));
 const fullRegister={facts:[{id:'FULL',value:777,unit:'亿',status:'current'}],topics:[]};
 const sliceOnly={facts:[],topics:[]};assert.equal((await buildTurnContext({question:'未命中主题',ledger:sliceOnly,locator:async()=>({topicIds:[],parsed:{},clarification:{needed:false,missing:[]}})})).content.includes('777'),false);
 const fullLedgerLint=lintLedgerAnswer('已核数值为 777 亿。',fullRegister);assert(!fullLedgerLint.some(f=>f.rule==='unsourced_number'));
 assert(lintLedgerAnswer('金额为 90 亿。',{facts:[]}).some(f=>f.rule==='unsourced_number'));
 const fixtures=[['E-A-REV-2024','A 公司','营业收入','2024',120],['E-A-REV-2023','A 公司','营业收入','2023',100],['E-A-PARENT-2024','A 公司','归母净利润','2024',15],['E-A-PARENT-2023','A 公司','归母净利润','2023',12],['E-A-TOTAL-2024','A 公司','合并净利润','2024',17],['E-A-TOTAL-2023','A 公司','合并净利润','2023',14],['E-B-REV-2024','B 公司','营业收入','2024',80],['E-B-REV-2023','B 公司','营业收入','2023',50]];
 const topics=[['W01','A 公司：2024 年与 2023 年营业收入及业务规模对比',['E-A-REV-2024','E-A-REV-2023'],'营业收入'],['W02','A 公司：2024 年与 2023 年归属于母公司股东的净利润',['E-A-PARENT-2024','E-A-PARENT-2023'],'归母净利润'],['W03','A 公司：2024 年与 2023 年合并净利润，包含子公司其他股东对应的收益',['E-A-TOTAL-2024','E-A-TOTAL-2023'],'合并净利润'],['W04','B 公司：2024 年与 2023 年营业收入及业务规模对比',['E-B-REV-2024','E-B-REV-2023'],'营业收入']].map(([id,title,factIds,metric])=>({id,title,summary:title,factIds,qaRefs:[],binding:{company:title[0]==='A'?'A 公司':'B 公司',metrics:[metric],periods:['2024','2023']},status:'current'}));
 const fixture={topics,facts:fixtures.map(([id,company,metric,period,value])=>({id,claim:metric,value,unit:'亿元',period,binding:{company,metric,period,unit:'亿元'},status:'current'}))};
 const dialogues=[
 ['R01','帮我看看 A 公司 2024 年的年报。\n已定位到这份年报。','2024 年和 2023 年，分别做了多少钱的生意？扣掉各种开销和税，算到这家公司自己股东头上的收益又有多少？',['W01','W02'],['E-A-REV-2024','E-A-REV-2023','E-A-PARENT-2024','E-A-PARENT-2023'],false,''],
 ['R02','A 公司 2024 年做了多少钱的生意？\n120 亿元。\n换成 B 公司，同一年呢？\n80 亿元。','那前一年呢？',['W04'],['E-B-REV-2023'],false,'2023'],
 ['R03','把 A 和 B 公司 2024 年做了多少钱的生意放一起看看。\nA 公司为 120 亿元，B 公司为 80 亿元。','它比前一年多了多少？',['W01','W04'],['E-A-REV-2024','E-A-REV-2023','E-B-REV-2024','E-B-REV-2023'],true,''],
 ['R04','A 公司 2024 年做了多少钱的生意？\n120 亿元。\n那扣掉开销后，算到它自己股东头上的收益呢？\n15 亿元。\n再看 B 公司，2024 年做了多少钱的生意？\n80 亿元。','回到最开始那家公司，还是最开始问的生意规模，2024 年和 2023 年差多少？',['W01'],['E-A-REV-2024','E-A-REV-2023'],false,'营业收入']
 ];
 for(const [id,history,question,expectedNodes,expectedFacts,clarify,metric] of dialogues){
  const selection=defaultLocate({question,history,topics:fixture.topics});assert.deepEqual(selection.topicIds.sort(),expectedNodes.slice().sort(),`${id} node selection`);
  assert.equal(selection.clarification.needed,clarify,id);assert.deepEqual(selection.clarification.missing,clarify?['company']:[],id);
  if(id==='R01'){assert.deepEqual(selection.parsed.periods,['2024','2023']);assert.deepEqual(fixture.topics.filter(t=>selection.topicIds.includes(t.id)).map(t=>t.binding.metrics[0]).sort(),['营业收入','归母净利润'].sort());}
  if(id==='R03'){assert.equal(selection.parsed.metric,'营业收入');assert.deepEqual(selection.parsed.periods,['2024','2023']);assert.equal(selection.parsed.company,null);}
  if(metric)assert(metric.split('与').every(part=>JSON.stringify(selection.parsed).includes(part)),`${id} parse: ${JSON.stringify(selection.parsed)}`);
  const result=await retrieveTopics({ledger:fixture,question,history});const expanded=expandTopics({ledger:fixture,selection:result});
  assert.deepEqual(expanded.facts.map(f=>f.id).sort(),expectedFacts.slice().sort(),`${id} expansion`);
  assert(!Object.hasOwn(selection,'difference')&&!JSON.stringify(selection).includes('差额为'),`${id} locator must not calculate`);
 }
 console.log('topic index passed');
} finally {await rm(root,{recursive:true,force:true});}
