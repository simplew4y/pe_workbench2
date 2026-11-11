import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  readLedger, appendClaim, appendCorrection, summarizeLedger, correctedValues, searchLedger,
} from '../lib/ledger.mjs';
import {detectUserClaims, recordUserClaims} from '../lib/claim-detect.mjs';
import {auditLedgerClaims} from '../lib/self-audit.mjs';
import {createLedgerTool} from '../lib/ledger-tool.mjs';
import {createTranscriptSearchTool} from '../lib/transcript-search-tool.mjs';
import {unitConvert, calculate} from '../lib/calc-tool.mjs';
import {lintAnswer, lintLedgerAnswer} from '../lib/answer-lint.mjs';
import {checkTurnTools} from '../lib/turn-context.mjs';
import {runWithPostAnswer} from '../server/agent/post-answer.mjs';

const roots=[];
const temp=async(prefix)=>{const root=await mkdtemp(path.join(os.tmpdir(),prefix));roots.push(root);return root;};
const evidence={type:'user',ref:'turn 1'};
const RAW='7,293 百万元写成了 7.3 亿元';

try {
  /* T1: record user_claim from an explicit correction pattern. */
  const root1=await temp('ledger-claims-');
  const detected=detectUserClaims(RAW);
  assert.equal(detected.length,1);
  assert.equal(detected[0].value,'7.3');
  assert.equal(detected[0].unit,'亿元');
  assert.equal(detected[0].correctValue,'7293');
  assert.equal(detected[0].correctUnit,'百万元');
  assert.equal(detected[0].type,'user_claim');
  assert.equal(detected[0].role,'user');
  assert.equal(detectUserClaims('收入 7293 百万元，利润 7.3 亿元。').length,0,'no auto-NER without correction marker');
  assert.equal(detectUserClaims('有人写成 7.3 亿元').length,1);
  assert.equal(detectUserClaims('量产时点应为 1H27')[0].period,'1H27');

  const written=await recordUserClaims(root1,'s',RAW,{turn:1});
  assert.equal(written.length,1);
  assert.equal((await recordUserClaims(root1,'s',RAW,{turn:1})).length,0,'duplicate claim is not re-recorded');
  let ledger=await readLedger(root1,'s');
  const claim=ledger.claims[0];
  assert.equal(ledger.version,1);
  assert.equal(claim.type,'user_claim');
  assert.equal(claim.role,'user');
  assert.equal(claim.status,'superseded','explicit old/new values promote a correction immediately');
  assert.match(claim.claim,/7,293/);

  /* T3: ledger.search hits user claim by keyword and by "十倍". */
  for(const query of ['十倍','7.3','亿元','写成了']) {
    const result=searchLedger(ledger,{query});
    assert.ok(result.matches.some(m=>m.type==='user_claim'&&m.role==='user'),`search ${query} must hit user_claim`);
  }
  assert.ok(Array.isArray(searchLedger(ledger,{query:'十倍'}).matches));

  /* T4: empty search is an empty array, never the phrase "全部正确". */
  const empty=searchLedger({version:1,sessionId:'s',facts:[],corrections:[],open:[],claims:[]},{query:'十倍'});
  assert.deepEqual(empty.matches,[]);
  assert.equal(empty.totalMatches,0);
  assert.ok(!JSON.stringify(empty).includes('全部正确'));
  assert.deepEqual(searchLedger(null,{query:'十倍'}).matches,[]);

  /* T2: correction supersedes the old claim without deleting it. */
  const correction=await appendCorrection(root1,'s',{
    claim:'金额',from:7.3,to:72.93,unit:'亿元',evidence:{type:'user',ref:'turn 2'},turn:2,claimId:claim.id,reason:'十倍',
  });
  ledger=await readLedger(root1,'s');
  assert.equal(ledger.claims.length,1,'old claim is retained');
  assert.equal(ledger.claims[0].status,'superseded');
  assert.equal(ledger.claims[0].supersededBy,correction.id);
  assert.ok(correctedValues(ledger).some(c=>String(c.from)==='7.3'&&String(c.to)==='72.93'&&c.claim==='金额'));
  const current=searchLedger(ledger,{query:'72.93'});
  assert.ok(current.matches.some(m=>m.type==='correction'&&String(m.expected)==='72.93'&&m.status==='current'));
  assert.ok(searchLedger(ledger,{query:'7.3'}).matches.some(m=>m.type==='user_claim'&&m.status==='superseded'));
  assert.ok(!summarizeLedger(ledger).includes('7.3'),'summary must not revive the old claim');

  /* T5: self-check happy path: claim + cell 7293 mn -> 7.3 -> 72.93 via unit_convert. */
  const root2=await temp('ledger-audit-');
  await recordUserClaims(root2,'s',RAW,{turn:1});
  await appendClaim(root2,'s',{claim:'有人写成 7.3 亿元',value:7.3,unit:'亿元',evidence,turn:2});
  const ledger2=await readLedger(root2,'s');
  assert.ok(searchLedger(ledger2,{query:'十倍'}).matches.some(m=>m.type==='user_claim'&&m.expected==null),'unknown-magnitude money claim is still a candidate');
  const conversion=unitConvert({value:'7293',from_unit:'百万元',to_unit:'亿元'});
  assert.equal(conversion.value,'72.93');
  assert.equal(conversion.unit,'亿元');
  const audit=auditLedgerClaims(ledger2,{query:'十倍',cell:{value:'7293',unit:'百万元'}});
  const hit=audit.candidates.find(c=>c.claim===RAW);
  assert.ok(hit,'audit must list the claim');
  assert.equal(hit.status,'mismatch');
  assert.equal(hit.claimed,'7.3 亿元');
  assert.equal(hit.expected,'72.93 亿元');
  assert.ok(hit.ratio>9&&hit.ratio<11);
  assert.match(audit.table,/72\.93/);
  assert.match(audit.table,/7\.3/);
  const fallback=auditLedgerClaims(ledger2,{query:'7.3',cell:{value:'7293',unit:'百万元'}}).candidates.find(c=>c.claim==='有人写成 7.3 亿元');
  assert.equal(fallback.expected,'72.93 亿元');
  assert.equal(fallback.basis,'cell');
  assert.equal(auditLedgerClaims({claims:[],corrections:[]}).table,'未发现候选人。');

  /* T6: speech gate forbids "全部正确 / 没有十倍错误" without a same-turn search. */
  const noSearch=checkTurnTools({routes:['selfaudit'],answer:'自查结果：全部正确，没有十倍错误。'});
  assert.equal(noSearch[0].rule,'missing_transcript_search');
  assert.ok(noSearch.some(f=>f.rule==='forbidden_all_correct'));
  const searchOk=checkTurnTools({routes:['selfaudit'],answer:'未发现候选人。',toolCalls:[{name:'transcript_search',success:true}]});
  assert.equal(searchOk.length,0);
  const checked=checkTurnTools({routes:['selfaudit'],answer:'核对 1 条后均与单元格一致。',toolCalls:[{name:'transcript_search',success:true}]});
  assert.equal(checked.length,0);
  const failedSearch=checkTurnTools({routes:['selfaudit'],answer:'全部正确。',toolCalls:[{name:'transcript_search',success:false}]});
  assert.ok(failedSearch.some(f=>f.rule==='forbidden_all_correct'));
  const searchTool=createTranscriptSearchTool({getMessages:()=>[],getLedger:async()=>({version:1,sessionId:'s',facts:[],corrections:[],open:[],claims:[]})});
  const emptySearch=await searchTool.execute('x',{query:'十倍'});
  assert.deepEqual(emptySearch.details.ledgerMatches,[]);
  assert.ok(!emptySearch.content[0].text.includes('全部正确'));

  /* T7: B3 memory: 2026H1 -> 1H27 remains the current fact and is searchable. */
  const root3=await temp('ledger-b3-');
  await recordUserClaims(root3,'s','量产时点应为 1H27',{turn:1});
  await appendCorrection(root3,'s',{claim:'量产时点',from:'2026H1',to:'1H27',evidence,turn:1});
  const ledger3=await readLedger(root3,'s');
  assert.equal(ledger3.claims[0].status,'confirmed','a claim asserting the corrected value is confirmed');
  const summary=summarizeLedger(ledger3);
  assert.match(summary,/1H27/);
  assert.ok(!summary.includes('2026H1'));
  assert.ok(!summary.includes('待核主张'));
  const b3=searchLedger(ledger3,{query:'1H27'});
  assert.ok(b3.matches.some(m=>m.type==='correction'&&String(m.expected)==='1H27'));
  assert.equal(lintLedgerAnswer('量产时点为1H27。',ledger3).length,0);
  assert.equal(lintLedgerAnswer('量产时点为2026H1。',ledger3).length,1);

  /* T8: DT-1 coexistence: 7293 百万元 -> 72.93 亿元; wrong 7.3 is caught by U1. */
  assert.equal(unitConvert({value:'7293',from_unit:'百万元',to_unit:'亿元'}).value,'72.93');
  assert.equal(calculate({expression:'7293',fromUnit:'百万元',toUnit:'亿元'}).value,'72.93');
  assert.equal(unitConvert({value:'7053443',from_unit:'百万元',to_unit:'亿元'}).value,'70534.43');
  assert.equal(lintAnswer('7,293 百万元 ≈ 72.93 亿元。').filter(f=>f.rule==='unit_conversion').length,0);
  assert.ok(lintAnswer('7,293 百万元 ≈ 7.3 亿元。').some(f=>f.code==='U1'));

  /* Tool write path: ledger_record kind=claim then kind=correction with claimId. */
  const root4=await temp('ledger-tool-');
  const tool=createLedgerTool({ctx:{root:root4},getSessionId:()=> 's',getTurn:()=>1});
  const claimOut=await tool.execute('x',{kind:'claim',claim:'有人写成 7.3 亿元',value:7.3,unit:'亿元',evidence:{type:'user',ref:'msg'}});
  assert.ok(!claimOut.isError,claimOut.content?.[0]?.text);
  assert.equal(claimOut.details.record.type,'user_claim');
  const correctionOut=await tool.execute('x',{kind:'correction',claim:'金额',from:7.3,to:72.93,unit:'亿元',claimId:claimOut.details.record.id,evidence:{type:'user',ref:'msg'}});
  assert.ok(!correctionOut.isError,correctionOut.content?.[0]?.text);
  const ledger4=await readLedger(root4,'s');
  assert.equal(ledger4.claims[0].status,'superseded');
  assert.equal(ledger4.corrections[0].supersedes[0],ledger4.claims[0].id);

  /* Host path: runWithPostAnswer records the user's explicit correction before prompting. */
  const root5=await temp('ledger-host-');
  const hostSession={messages:[],async prompt(text){this.messages.push({role:'user',content:text},{role:'assistant',stopReason:'stop',content:'已记录。'});},async sendCustomMessage(){}};
  const hostEntry={id:'s',ctx:{root:root5},session:hostSession};
  await runWithPostAnswer(hostEntry,RAW);
  const hostLedger=await readLedger(root5,'s');
  assert.equal(hostLedger.claims.length,1);
  assert.equal(hostLedger.claims[0].type,'user_claim');
  assert.equal(hostLedger.claims[0].turn,1);
  assert.equal(hostLedger.corrections[0].from,'7.3');
  assert.equal(hostLedger.corrections[0].to,'72.93');
  assert.equal(lintLedgerAnswer('收入为7.3亿元。',hostLedger).some(f=>f.rule==='repeats_corrected_value'),true);

  console.log('ledger claims/self-audit T1-T8 PASS');
} finally {
  await Promise.all(roots.map(root=>rm(root,{recursive:true,force:true})));
}
