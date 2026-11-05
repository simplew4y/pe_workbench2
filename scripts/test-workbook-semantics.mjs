import assert from 'node:assert/strict';
import {queryGraph,formatResult} from '../lib/workbook-query.mjs';
const rows={7:'Revenues',13:'HBM',29:'Mix',32:'HBM',34:'Gross profits',37:'HBM',39:'GM',42:'HBM',44:'Mix',47:'HBM',122:'ASP (US$ / GB)'};
const specs=[[7,null,354858.7468],[13,null,7293],[32,'=AH13/AH$7',.02055],[34,null,298631.811],[37,null,4740.45],[42,'=AH37/AH13',.65],[47,'=AH37/AH$34',.01587],[122,null,8.3404]];
const graph={sheets:[{name:'Assumption',rowLabels:rows}],cells:specs.map(([r,f,v])=>[`Assumption!AH${r}`,f,v,r,34,rows[r],'2026E']),edges:[]};
for(const [r,n,d] of [[32,13,7],[42,37,13],[47,37,34]]){
 const result=queryGraph(graph,`Assumption!AH${r}`,{maxCells:1});
 assert.equal(result.cells[0].ratioEvidence.numerator.ref,`Assumption!AH${n}`);
 assert.equal(result.cells[0].ratioEvidence.denominator.ref,`Assumption!AH${d}`);
 assert.match(formatResult(result),/分子：[\s\S]*分母：/);
}
assert.match(formatResult(queryGraph(graph,'Assumption!AH42')),/34:Gross profits/);
assert.match(formatResult(queryGraph(graph,'Assumption!AH122')),/US\$ \/ GB/);
console.log('PASS ratio meaning, numerator/denominator context and case-sensitive units');
