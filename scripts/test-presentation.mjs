import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateState } from '../lib/validate-state.mjs';
const example = JSON.parse(fs.readFileSync(new URL('../skills/investment-framework/assets/analysis-state.example.json', import.meta.url)));
const presentation = () => ({verdict:{id:'verdict',text:'只能作为复现值。',status:'条件判断',value_identity:'复现值'},review_items:[{id:'R1',question:'核模型日期',reason:'时点未知',impact:'影响可比性'}],key_drivers:[{reference_id:example.assumptions[0].id,weight:0.6}],highlights:['verdict','R1']});
function state() { return {...structuredClone(example),presentation:presentation()}; }
let s=state(); assert.equal(validateState(s).ok,true);
for (const [key, count] of [['review_items',4],['key_drivers',4],['highlights',5]]) {
 s=state(); s.presentation[key]=Array.from({length:count},()=>s.presentation[key][0]);
 assert.ok(validateState(s).errors.some(e=>e.includes(`presentation.${key}`)),key);
}
s=state(); s.presentation.highlights=['missing']; assert.ok(validateState(s).errors.some(e=>e.includes('missing')));
s=state(); s.presentation.verdict.status='买入'; assert.equal(validateState(s).ok,false);
s=state(); s.presentation.key_drivers[0].weight='高'; assert.equal(validateState(s).ok,false);
s=state(); s.presentation.review_items[0].impact=''; assert.equal(validateState(s).ok,false);
s=state(); s.presentation.review_items=[null]; assert.equal(validateState(s).ok,false);
s=state(); s.presentation.highlights=[{id:'verdict',text:'forged'}]; assert.equal(validateState(s).ok,false);
s=state(); s.falsifiers[0].threshold='连续两季 < 15%'; s.falsifiers[0].status='triggered'; s.falsifiers[0].observed=-1;
assert.ok(validateState(s).errors.some(e=>e.includes('INSUFFICIENT_PERIODS')));
s.falsifiers[0].observations=[{period:'2026Q1',value:1},{period:'2026Q1',value:-1}]; assert.ok(validateState(s).errors.some(e=>e.includes('INSUFFICIENT_PERIODS')));
s.falsifiers[0].observations=[{period:'2026Q1',value:1},{period:'2026Q2',value:-1}]; assert.ok(!validateState(s).errors.some(e=>e.includes('INSUFFICIENT_PERIODS')));
s=state(); s.falsifiers[0].status='armed'; s.falsifiers[0].observed=''; assert.ok(validateState(s).warnings.every(w=>/^\[[A-Z0-9_]+\]/.test(w)));
s=state(); s.falsifiers[0].statement='连续三个季度低于阈值'; s.falsifiers[0].threshold='15%'; s.falsifiers[0].status='triggered'; s.falsifiers[0].observations=[{period:'2026Q1',value:1}];
assert.ok(validateState(s).errors.some(e=>e.includes('INSUFFICIENT_PERIODS')),'multi-period requirement in statement');
s.falsifiers[0].observations.push({period:'2026Q2',value:1}); assert.ok(validateState(s).errors.some(e=>e.includes('INSUFFICIENT_PERIODS')),'three periods require three');
console.log('presentation validation passed');
s=state();s.presentation.verdict.text='模型价仅供参考，不能作为当前可执行目标价';
assert.ok(validateState(s).warnings.some(w=>w.includes('VERDICT_DISCLAIMER')));
s.presentation.verdict.text='分部增长逻辑成立';s.presentation.verdict.valuation_id='missing';
assert.ok(validateState(s).errors.some(e=>e.includes('valuation_id')));
s.presentation.verdict.valuation_id=example.valuations[0].id;
assert.ok(!validateState(s).warnings.some(w=>w.includes('VERDICT_DISCLAIMER')));
s.market.fetched_at='yesterday';assert.ok(validateState(s).errors.some(e=>e.includes('fetched_at')));

// Method switches may leave optional presentation pointing at the historical V.
s=state();
s.presentation.verdict.valuation_id=s.valuations[0].id;
s.valuations[0].status='superseded';
assert.ok(!validateState(s).errors.some(e=>e.includes('valuation_id')));
assert.ok(validateState(s).warnings.some(w=>w.includes('PRESENTATION_STALE_VALUATION')));
s.valuations.push({...structuredClone(s.valuations[0]),id:'V-current',status:'active'});
s.presentation.verdict.valuation_id='V-current';
assert.ok(!validateState(s).errors.some(e=>e.includes('valuation_id')));
assert.ok(!validateState(s).warnings.some(w=>w.includes('PRESENTATION_STALE_VALUATION')));
delete s.presentation;
assert.ok(!validateState(s).errors.some(e=>e.includes('presentation')));
