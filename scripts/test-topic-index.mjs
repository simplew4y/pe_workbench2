import assert from 'node:assert/strict';
import {fixtureMessages, topicRetrievalCases, topicLedgerFixture as fixture} from './fixtures/topic-retrieval.mjs';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os'; import path from 'node:path';
import {readLedger,appendFact} from '../lib/ledger.mjs';
import {lintLedgerAnswer} from '../lib/answer-lint.mjs';
import {registerFact} from '../lib/fact-register.mjs';
import {buildTurnContext} from '../lib/turn-context.mjs';
import {upsertTopicFromFacts,validateTopicProposal,retrieveTopics,expandTopics,defaultLocate,updateTopicsFromFacts} from '../lib/topic-index.mjs';
import {createLedgerTool} from '../lib/ledger-tool.mjs';
import {getModel, registerApiProvider, resetApiProviders} from '@earendil-works/pi-ai/compat';
import {locateChatTopics, recentTopicDialogue} from '../server/agent/topic-locator.mjs';
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
 for (const {id,history,question,expected} of topicRetrievalCases) {
  const selection=defaultLocate({question,history,topics:fixture.topics});
  assert.deepEqual(selection.topicIds.sort(), [...expected.topicIds].sort(), `${id} node selection`);
  assert.deepEqual(selection.clarification, expected.clarification, id);
  assert.equal(selection.parsed.company, expected.company, id);
  assert.deepEqual(selection.parsed.periods, expected.periods, id);
  if (id === 'R01') {
   assert.deepEqual(fixture.topics.filter(t=>selection.topicIds.includes(t.id)).map(t=>t.binding.metrics[0]).sort(), ['营业收入','归母净利润'].sort());
  }
  if (id === 'R03' || id === 'R04') assert.equal(selection.parsed.metric, '营业收入', id);
  const result=await retrieveTopics({ledger:fixture,question,history});
  const expanded=expandTopics({ledger:fixture,selection:result});
  assert.deepEqual(expanded.facts.map(f=>f.id).sort(), [...expected.factIds].sort(), `${id} expansion`);
  assert(!Object.hasOwn(selection,'difference')&&!JSON.stringify(selection).includes('差额为'), `${id} locator must not calculate`);
 }
 const multiMetric = topicRetrievalCases.find(({id}) => id === 'R01');
 const metrics = ['营业收入', '归母净利润'];
 const model = getModel('openrouter', 'nvidia/nemotron-3.5-lightning:free');
 const stream = () => ({
  async result() {
   return {content: [{type: 'text', text: JSON.stringify({
    topicIds: ['W01', 'W02'],
    parsed: {company: 'A 公司', metric: metrics, periods: [2024, '2023']},
    clarification: {needed: false, missing: []},
   })}]};
  },
 });
 registerApiProvider({api: model.api, stream, streamSimple: stream});
 try {
  const selection = await retrieveTopics({
   ledger: fixture,
   question: multiMetric.question,
   history: recentTopicDialogue(fixtureMessages(multiMetric.history)),
   locator: input => locateChatTopics(model, input),
  });
  assert.deepEqual(selection.parsed.metric, metrics);
  assert.deepEqual(selection.parsed.periods, ['2024', '2023']);
  const expanded = expandTopics({ledger: fixture, selection});
  assert.deepEqual(expanded.facts.map(fact => fact.id).sort(), [...multiMetric.expected.factIds].sort());
 } finally {
  resetApiProviders();
 }
 console.log('topic index passed');
} finally {await rm(root,{recursive:true,force:true});}
