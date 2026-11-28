import assert from 'node:assert/strict';
import {financialEvidenceFindings,reconciliationCandidates} from '../lib/financial-evidence.mjs';
import {reconcileEvidence} from '../lib/evidence-reconciliation.mjs';
const source={id:'rev',materialId:'book',version:1,filename:'模型.xlsx',locator:'IS!A1',metric:'收入',value:100,raw_unit:'亿元',display_unit:'亿元',currency:'CNY',period:'2025E',basis_type:'forecast'};
const context={citations:[source],currentVersions:{book:1},toolCalls:[]};
const ambiguous={rule:'unsourced_number',severity:'error',field:'source',evidenceStatus:'missing_source',excerpt:'收入100亿元，占总额一部分。',claim:{value:'100',unit:'亿元',metric:'总额',ambiguous:true,period:'2025',basis_type:'forecast',currency:'CNY'}};
assert.equal(reconciliationCandidates(ambiguous,context).length,1);
const allowed=await reconcileEvidence([ambiguous],context,async()=>({decisions:[{index:0,status:'supported',sourceId:'rev',reason:'该数字在原句中指收入，与当年收入来源对应。'}]}));
assert.equal(allowed.findings[0].severity,'info');
for (const decisions of [[{index:0,status:'supported',sourceId:'fake',reason:'same'}],
 [{index:0,status:'uncertain',sourceId:'rev',reason:'period unclear'}],
 [{index:0,status:'supported',sourceId:'rev',reason:'same'},{index:0,status:'conflict'}],[]]) {
 assert.equal((await reconcileEvidence([ambiguous],context,async()=>({decisions}))).findings[0].severity,'error');
}
assert.equal((await reconcileEvidence([ambiguous],context,async()=>{throw Error('offline')})).findings[0].severity,'error');
for(const patch of [{value:'999'},{currency:'USD'},{period:'2026'},{basis_type:'actual'},{metric:'净利润',ambiguous:false}]) {
 assert.equal(reconciliationCandidates({...ambiguous,claim:{...ambiguous.claim,...patch}},context).length,0);
}
assert.equal(reconciliationCandidates(ambiguous,{...context,currentVersions:{book:2}}).length,0);
assert.equal(reconciliationCandidates(ambiguous,{...context,citations:[{...source,period:''}]}).length,0);
for(const text of ['2025E净利润100亿元（[模型.xlsx]IS!A1）。','2025E收入999亿元（[模型.xlsx]IS!A1）。','2026E收入100亿元（[模型.xlsx]IS!A1）。']) {
 const findings=financialEvidenceFindings(text,context,[]);
 assert.ok(findings.some(f=>f.severity==='error'));
 for(const f of findings)assert.equal(reconciliationCandidates(f,context).length,0);
}
console.log('PASS semantic bindings require real matching evidence; fabricated IDs, wrong values/currency/period/basis/metric, stale data and reviewer outage cannot release conflicts');
