import assert from 'node:assert/strict';
import {lintLedgerAnswer} from '../lib/answer-lint.mjs';
import {checkTurnTools,buildTurnContext} from '../lib/turn-context.mjs';
const ledger={corrections:[{claim:'期间',from:'2026H1',to:'1H27'},{claim:'利润',from:7.3,to:72.93,unit:'亿'}]};
assert.equal(lintLedgerAnswer('利润为7.3 亿。',ledger)[0].rule,'repeats_corrected_value');
assert.equal(lintLedgerAnswer('期间为2026H1。',ledger).length,1);
assert.equal(lintLedgerAnswer('原为 7.3 亿，已更正为72.93亿。',ledger).length,0);
assert.equal(lintLedgerAnswer('此前误写2026H1，现值1H27。',ledger).length,0);
assert.equal(lintLedgerAnswer('利润72.93亿。',ledger).length,0);
assert.equal(lintLedgerAnswer('利润17.3亿。',ledger).length,0);
assert.equal(lintLedgerAnswer('利润7.30 亿。',ledger).length,1);
assert.equal(checkTurnTools({routes:['selfaudit'],answer:'全部正确。'})[0].rule,'missing_transcript_search');
assert.equal(checkTurnTools({routes:['selfaudit'],toolCalls:[{name:'transcript_search',success:false}]}).length,1);
assert.equal(checkTurnTools({routes:['selfaudit'],toolCalls:[{name:'transcript_search',success:true}]}).length,0);
const ctx=await buildTurnContext({question:'检查前面之前说的全部正确吗，核对一下',ledger});assert.ok(ctx.routes.includes('selfaudit'));assert.match(ctx.content,/transcript_search/);
console.log('ledger lint PASS');

assert.equal(lintLedgerAnswer('利润1,234.50 亿。',{corrections:[{claim:'利润',from:1234.5,to:12345,unit:'亿'}]}).length,1);

assert.equal(lintLedgerAnswer('利润-7.3亿。',ledger).length,0);
assert.equal(lintLedgerAnswer('期间为2026 H1。',ledger).length,1);
