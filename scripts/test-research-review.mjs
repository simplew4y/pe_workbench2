import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {reviewClaims,createResearchReview} from '../lib/research-review.mjs';
const store={findMaterialByPath: file=>file==='uploads/model.xlsx'?{id:'m'}:null};
const workbooks={queryMaterial:async(_id,ref)=>({seeds:[ref],cells:[{ref,value:8.34,rowLabel:'ASP (US$ / GB)',columnLabel:'2026E'}]})};
const cell={id:'A',kind:'cell',text:'HBM ASP 8.34 US$/GB（2026E，Assumption!AH122）',valueText:'8.34',file:'uploads/model.xlsx',ref:'Assumption!AH122',value:8.34,unit:'US$ / GB',period:'2026E',entity:'CXMT',metric:'HBM ASP'};
const review=claims=>reviewClaims({content:claims.map(c=>c.text).join('\n'),claims,store,workbooks});
const mode=process.argv[2] || 'all';
if(['all','threshold'].includes(mode)){
 assert.equal((await review([{id:'T',kind:'threshold',text:'良率必须达到50%',value:.5,valueText:'50%',unit:'ratio',rationale:'经验'}])).ok,false);
 assert.equal((await review([{id:'U',kind:'unknown',text:'良率50%阈值无法推导，待验证'}])).ok,true);
 assert.equal((await review([cell,{id:'T',kind:'threshold',text:'阈值8.34',basisId:'A',value:9,valueText:'8.34',unit:cell.unit,rationale:'修改'}])).ok,false);
 assert.equal((await review([cell,{id:'T',kind:'threshold',text:'阈值8.34',basisId:'A',value:8.34,valueText:'8.34',unit:cell.unit,rationale:'沿用模型值作为待核验边界'}])).ok,false);
 const source={id:'s',kind:'source',text:'试验2026失效阈值50%',evidenceId:'e',quote:'试验2026失效阈值50%',locator:'source.pdf',value:.5,valueText:'50%',unit:'ratio',period:'2026',entity:'试验',metric:'失效阈值'};
 const threshold={id:'t',kind:'threshold',text:'阈值50%',basisId:'s',value:.5,valueText:'50%',unit:'ratio',rationale:'原文明确设定'};
 assert.equal((await reviewClaims({content:source.text+'\n'+threshold.text,claims:[source,threshold],store,workbooks,evidence:new Map([['e',source.quote+' source.pdf']])})).ok,true,'explicit source threshold accepted');
 console.log('PASS threshold: missing proof, invented value rejected; unknown accepted; ordinary model value cannot become a threshold');
}
if(['all','comparison'].includes(mode)){
 const a={id:'a',kind:'source',text:'CXMT 2026H1净利率51.6%',value:.516,valueText:'51.6%',unit:'ratio',period:'2026H1',entity:'CXMT',metric:'净利率',product:'all',valueType:'actual',locator:'https://example.test/report'};
 async function compare(patch={}) {
   const b={...a,id:'b',...patch};
   const claims=[a,b].map(c=>({...c,evidenceId:c.id,quote:`${c.entity} ${c.period} ${c.metric} ${c.valueText} ${c.unit}`}));
   const evidence=new Map(claims.map(c=>[c.id,`${c.quote} ${c.locator}`]));
   return reviewClaims({content:[a.text,b.text,'口径对齐'].join('\n'),claims:[...claims,{id:'c',kind:'comparison',text:'口径对齐',leftId:'a',rightId:'b'}],store,workbooks,evidence});
 }
 assert.equal((await compare()).ok,true,'same-basis positive control');
 for(const [field,value] of Object.entries({entity:'SMIC',product:'DDR5',metric:'毛利率',unit:'%',period:'2026FY',valueType:'forecast'})){
   const result=await compare({[field]:value,text:field==='unit'?'CXMT 2026H1净利率51.6%':a.text});
   assert.equal(result.ok,false,field);
   assert.ok(result.errors.some(e=>e.includes(`${field} 不一致`)),JSON.stringify(result));
 }
 console.log('PASS comparison: same basis accepted; company/product/metric/unit/period/actual-vs-forecast mismatch rejected');
}
if(['all','citation'].includes(mode)){
 assert.equal((await review([cell])).ok,true);
 assert.equal((await review([{...cell,unit:'USD/GB'}])).ok,true,'equivalent currency alias and spaces accepted');
 assert.equal((await reviewClaims({content:cell.text,claims:[cell],store,workbooks:{queryMaterial:async()=>({seeds:[cell.ref],cells:[{ref:cell.ref,value:8.34039754980094,rowLabel:'ASP (US$ / GB)',columnLabel:'2026E'}]})}})).ok,true,'rounded tool display can be cited without guessing hidden precision');
 for(const patch of [{unit:'US$ / Gb'},{period:'2027E'},{value:9},{file:'missing'},{text:cell.text.replace('8.34','9.34')},{text:cell.text.replace('GB','Gb')},{text:cell.text+'，另有良率50%'}]) assert.equal((await review([{...cell,...patch}])).ok,false);
 assert.equal((await review([{...cell,text:'# '+cell.text+' 多出50%'}])).ok,false,'headings cannot hide unsupported numbers');
 const uncovered=await reviewClaims({content:'未经核验的良率50%',claims:[],store,workbooks});assert.equal(uncovered.ok,false);
 console.log('PASS citations: exact value/unit/period/file checked, uncovered numeric lines rejected');
}
if(['all','correction'].includes(mode)){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'research-review-'));fs.mkdirSync(path.join(root,'exports'));
 try{
 const guard=createResearchReview({ctx:{root,store,workbooks}});
 guard.before('workbook_query',{});
 assert.equal(guard.before('write',{path:'exports/report.md',content:'结论50%'}).block,true);
 assert.equal(guard.before('edit',{path:'exports/report.md',oldText:'a',newText:'b'}).block,true);
 const args={path:'exports/report.md',content:cell.text,claims:[cell]};
 assert.equal((await guard.tool.execute('id',args)).isError,false);
 assert.equal(guard.before('write',args),undefined);
 assert.equal(guard.record({toolCall:{name:'write'},args,result:{content:[]}}).isError,true,'missing write cannot be declared complete');
 fs.writeFileSync(path.join(root,args.path),args.content);
 assert.match(guard.record({toolCall:{name:'write'},args,result:{content:[]}}).content[0].text,/research_write_verified/);

 assert.equal(guard.before('write',args).block,true,'approval single use');
 await guard.tool.execute('id',args);fs.writeFileSync(path.join(root,args.path),'concurrent change');
 assert.equal(guard.before('write',args).block,true,'baseline changed');
 fs.writeFileSync(path.join(root,'exports/old.md'),'错误：HBM收入占比65%');
 assert.equal((await guard.tool.execute('id',{...args,retracted:['HBM收入占比65%']})).isError,true);
 const old=fs.readFileSync(path.join(root,'exports/old.md'),'utf8');
 const withdrawal='> 已撤回：指标误读，更正见 report.md\n'+old;
 assert.equal(guard.before('write',{path:'exports/old.md',content:withdrawal}),undefined);
 fs.writeFileSync(path.join(root,'exports/old.md'),withdrawal);
 assert.equal((await guard.tool.execute('id',{...args,retracted:['HBM收入占比65%']})).isError,false);
 assert.equal((await guard.tool.execute('id',{...args,path:'../escape.md'})).isError,true);
 const stale='旧报告写道：HBM收入占比达到65%，这是核心估值假设。';
 fs.writeFileSync(path.join(root,args.path),stale);
 fs.writeFileSync(path.join(root,'exports/stale-copy.md'),stale);
 assert.equal((await guard.tool.execute('id',args)).isError,true,'automatically find removed quantitative lines copied to sibling reports');
 fs.symlinkSync(os.tmpdir(),path.join(root,'exports/link'));
 assert.equal((await guard.tool.execute('id',{...args,path:'exports/link/escape-new.md'})).isError,true);
 assert.equal(createResearchReview({ctx:{root,store,workbooks}}).before('write',{path:'exports/plain.md',content:'价格50'}).block,true);
 console.log('PASS correction: full-content approval, edit block, baseline race, old-report scan, withdrawal and path guard');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
}
