import assert from 'node:assert/strict';
import {archivedReadEvidence} from '../lib/archived-read-evidence.mjs';
import {partialScenarioObservations} from '../lib/partial-scenario-observations.mjs';
import {retainReadEvidence} from '../lib/retained-read-evidence.mjs';
import {extractLocatorMatches} from '../ui/chat/citation-locator.js';
import {requestedAnswerLength} from '../lib/answer-length.mjs';

const document={doc_id:'archive',filename:'Costs.xlsx',version_no:2};
const id='source:'+Buffer.from(JSON.stringify(['archive','excel','Costs','D5'])).toString('base64url');
const cell={sheet_name:'Costs',cell_ref:'D5',numeric_value:-1250,is_formula:true,formula:'=-D9',formula_cache_status:'present',evidence_id:id};
const archive={id:'read',name:'pe_excel_range',success:true,details:{document,cells:[cell]}};
assert.equal(archivedReadEvidence(archive)[0].value,-1250);
for(const change of [{cell_ref:'D8'},{formula_cache_status:'missing'},{evidence_id:'source:eA'}])
  assert.deepEqual(archivedReadEvidence({...archive,details:{document,cells:[{...cell,...change}]}}),[]);
assert.deepEqual(archivedReadEvidence({...archive,success:false}),[]);
const answer='成本 Costs!D5 应为 +9000。';
const input={answer,retained:'',findings:[{severity:'error',sourceText:answer}],calls:[archive],versions:{archive:2}};
const retained=retainReadEvidence(input);
assert.match(retained.text,/-1250/);
assert.doesNotMatch(retained.text,/9000/);
assert.equal(retained.citations[0].locator,'Costs!D5');
assert.equal(retainReadEvidence({...input,versions:{archive:3}}).text,'');
assert.equal(extractLocatorMatches('[Model.xlsx]A+B!D4')[0].raw,'[Model.xlsx]A+B!D4');
assert.equal(requestedAnswerLength('请在200字以内。\n\n---\n## 本次选用的研究记录\n旧记录要求1000字').chars,200);
const path='uploads/Cost.xlsx',sha='a'.repeat(64);
const ref=(locator,value)=>({id:'c:'+locator,filename:'Cost.xlsx',storedFilename:'Cost.xlsx',materialId:'costs',version:2,sha256:sha,locator,value});
const refs=[ref('X!A1',2),ref('X!A2',20),ref('X!A3',100)];
const read={id:'new',name:'workbook_query',success:true,args:{path},details:{citations:refs}};
const inputs=[{cell:'X!A1',value:1}];
const whatif={id:'simulate',name:'model_whatif',success:true,args:{path,inputs,targets:['X!A2','X!A3']},details:{path,inputs,recalculated:true,results:[{cell:'X!A2',before:20,after:10},{cell:'X!A3',before:100,after:'#NAME?'}]}};
const run=(c=whatif,r=read,v=2)=>partialScenarioObservations([r,c],{costs:v});
assert.match(run().text,/20→10/);
assert.match(run().text,/#NAME\?/);
assert.equal(run(whatif,read,3),null);
assert.equal(run(whatif,{...read,args:{path:'elsewhere/Cost.xlsx'}}),null);
assert.equal(run({...whatif,details:{...whatif.details,sourceSha256:'b'.repeat(64)}}),null);
assert.equal(run({...whatif,details:{...whatif.details,inputs:[{cell:'X!A1',value:9}]}}),null);
assert.doesNotMatch(run({...whatif,details:{...whatif.details,cached:{'X!A2':25,'X!A3':100}}}).text,/20→10/);
console.log('PASS archived read identity, formula cache, version, wrong sign, compound sheet, prompt budget, partial scenario provenance and error scope');


// A batch ratio series survives a disputed interpretation, but crossing a
// version boundary, a different metric, or a different period invalidates it.
{
 const model='test-book',sha256='b'.repeat(64);
 const c=(coord,value,metric,period)=>({id:'cite:'+model+':v1:'+coord,materialId:model,version:1,filename:'Costs.xlsx',
  sha256,locator:coord,metric,value,period,raw_unit:metric==='Revenue'?'百万元':'件'});
 const observations=[c('Base!A1',12,'Revenue','2028E'),c('Base!A2',10,'Units','2028E'),
  c('Base!B1',15,'Revenue','2029E'),c('Base!B2',10,'Units','2029E')];
 const res=[0,2].map((i,j)=>({name:observations[i].period+'单位收入',value:['1.2','1.5'][j],unit:'百万元/件',
  expression:'rev/units',provenance:'bound_inputs',bindings:{rev:observations[i],units:observations[i+1]}}));
 const evaluate=(values,claim)=>{
  const input={answer:claim,retained:'**业务假设**',findings:[{severity:'error',sourceText:claim}],
    calls:[{name:'workbook_query',success:true,details:{citations:values}},
      {name:'calc',success:true,details:{results:res}}],versions:{[model]:1}};
  return retainReadEvidence(input);
 };
 const claim='2028–2029年单位收入为 1.2、1.5 百万元/件。';
 const proof=evaluate(observations,claim);
 assert.match(proof.text,/2029E 为 125/);
 assert.deepEqual(new Set(proof.citations.map(c=>c.id)),new Set(observations.map(c=>c.id)));
 assert.doesNotMatch(evaluate(observations,claim.replace('单位收入','单位成本')).text,/为 125/);
 assert.doesNotMatch(evaluate(observations.map((c,i)=>i===3?{...c,period:'Q4 2029'}:c),claim).text,/为 125/);
 assert.doesNotMatch(evaluate(observations.map((c,i)=>i===3?{...c,sha256:'c'.repeat(64)}:c),claim).text,/为 125/);
}
