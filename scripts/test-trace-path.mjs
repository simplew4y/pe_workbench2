import assert from 'node:assert/strict';
import { traceGraph, formatTrace } from '../lib/workbook-trace.mjs';
const doc = { sheets: [{name:'Model'}], cells: [
 ['Model!A1',null,1,1,1,'input',''],['Model!AD1351','=A1+1',2,1351,30,'multiple',''],
 ['Model!B2','=AD1351-1',1,2,2,'derived',''],['Model!C3','=B2*2',2,3,3,'目标价',''],['Model!D4',null,3,4,4,'isolated',''],
], edges:[['Model!A1','Model!AD1351'],['Model!AD1351','Model!B2'],['Model!B2','Model!C3']] };
const found=traceGraph(doc,{mode:'path',from:'Model!A1',to:'Model!C3'});
assert.deepEqual(found.paths[0].map(c=>c.ref),['Model!A1','Model!AD1351','Model!B2','Model!C3']);
assert.ok(['formula','derived_from_formula'].includes(found.paths[0][2].role));
const missing=traceGraph(doc,{mode:'path',from:'Model!D4',to:'Model!C3'});
assert.equal(missing.reachable,false); assert.match(formatTrace(missing),/不可达（在已解析的 3 个公式内）/);
const impact=traceGraph(doc,{mode:'impact',cell:'Model!A1'});
assert.equal(impact.totalDownstream,3); assert.ok(impact.outputs.some(c=>c.ref==='Model!C3'));
assert.equal(traceGraph(doc,{mode:'impact',cell:'Model!A1',depth:1}).truncated,true);
console.log('trace path: ok');
