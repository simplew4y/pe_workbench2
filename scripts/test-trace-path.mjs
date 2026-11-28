import assert from 'node:assert/strict';
import { traceGraph, formatTrace, parseCellRef } from '../lib/workbook-trace.mjs';
import { indexGraph } from '../lib/workbook-query.mjs';
import { resolveCachedWorkbookTrace } from '../lib/workbook-trace-cache.mjs';
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
assert.deepEqual(parseCellRef("Model!A1:Model!C3"),parseCellRef("Model!A1:C3"));
assert.equal(parseCellRef("Model!A1:Other!C3"),null);
const graph=indexGraph(doc);
const broad={sheet:'Model',rows:'1-4'};
const narrow={sheet:'Model',rows:'2-3',maxCells:3};
assert.equal(resolveCachedWorkbookTrace(graph,broad).reuse,null);
assert.equal(resolveCachedWorkbookTrace(graph,{...broad,maxChars:1000}).reuse,'exact');
const subset=resolveCachedWorkbookTrace(graph,narrow);
assert.equal(subset.reuse,'covered_rows');
assert.deepEqual(subset.result,traceGraph(graph,narrow));
assert.equal(resolveCachedWorkbookTrace(indexGraph(doc),narrow).reuse,null);
const limited=indexGraph(doc);
assert.equal(resolveCachedWorkbookTrace(limited,{...broad,maxCells:1}).result.truncated,true);
assert.equal(resolveCachedWorkbookTrace(limited,narrow).reuse,null);
console.log('trace path: ok');
