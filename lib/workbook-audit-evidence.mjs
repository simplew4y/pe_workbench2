import path from 'node:path';
import {adoptedCitations} from './citations.mjs';

/** Prompt selection never mutates the complete successfully-read archive. */
export function selectWorkbookAuditEvidence(cells, draft, maxChars=100000, sourceIds=[]) {
  const candidates=cells.map(c=>({id:c.file+'!'+c.ref,locator:c.ref,
    filename:c.filename || path.basename(c.file || ''),materialId:c.file,version:1}));
  const cited=new Set(adoptedCitations(draft,candidates).map(c=>c.materialId+'!'+c.locator));
  const linked=new Set(sourceIds);
  for(const cell of cells)if(linked.has(`cell:${cell.file}:${cell.ref}`))cited.add(cell.file+'!'+cell.ref);
  const numbers=new Set([...draft.matchAll(/(?<![\d.])[−-]?\d[\d,]*(?:\.\d+)?/g)].map(m=>Number(m[0].replaceAll(',','').replace('−','-'))));
  const score=c=>{
    if(cited.has(c.file+'!'+c.ref))return 100;
    if(typeof c.value!=='number')return 0;
    const values=[c.value,...(/%|decimal/.test(c.unit || c.display_unit || '')?[c.value*100]:[])];
    return values.some(v=>[0,1,2,3,4].some(p=>numbers.has(Number(v.toFixed(p)))))?10:0;
  };
  const ordered=cells.map((cell,index)=>({cell,index,score:score(cell)})).sort((a,b)=>b.score-a.score || b.index-a.index);
  const selected=[],omittedReferenced=[];let remaining=maxChars;
  for(const {cell,score} of ordered){
    const size=JSON.stringify(cell).length;
    if(size>remaining){if(score===100)omittedReferenced.push({file:cell.file,ref:cell.ref});continue;}
    selected.push(cell);remaining-=size;
  }
  return {cells:selected,coverage:{available:cells.length,selected:selected.length,truncated:selected.length<cells.length,
    omittedReferenced,note:'预算省略不等于没有读取。仅可判断所提供证据；未展示的证据不得判为不存在。'}};
}
