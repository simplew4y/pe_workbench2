import assert from 'node:assert/strict';
import {queryGraph, formatResult} from '../lib/workbook-query.mjs';
const graph={cells:[['Discount PE!H33',null,1.49,33,8,'Beta',''],['Capacity & capex!AK4',null,318.75,4,37,'Total capacity','2027E'],["O'Brien!A1",null,7,1,1,'Value',''],['Other!H33',null,99,33,8,'PE','2026E']],edges:[]};
for(const q of ['Discount PE!H33', "'Discount PE'!$H$33", 'discount pe!h33']) assert.equal(queryGraph(graph,q).cells[0].value,1.49,q);
assert.equal(queryGraph(graph,"'Capacity & capex'!AK4").cells[0].value,318.75);
assert.equal(queryGraph(graph,"'O''Brien'!A1").cells[0].value,7);
for(const [q,error] of [['Missing!H33','reference_not_found'],['Discount PE!Z999','reference_not_found'],['Discount PE!H33 Beta','invalid_reference'],['H33','ambiguous_reference']]){
 const r=queryGraph(graph,q);assert.equal(r.error,error);assert.equal(r.returned,0);assert.match(formatResult(r),/未执行关键词回退/);
}
assert.ok(queryGraph(graph,'Beta').cells.length);
console.log('PASS 10 exact-reference and keyword regressions');
