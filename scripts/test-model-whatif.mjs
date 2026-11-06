import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createModelWhatifTool } from '../lib/model-whatif-tool.mjs';
const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'pe-whatif-test-'));
try {
 const file=path.join(dir,'model.xlsx');
 const made=spawnSync('python3',['-c',"import openpyxl,sys; w=openpyxl.Workbook(); s=w.active; s.title='Discount PE'; s['A1']=2; s['B1']='=A1*2'; w.save(sys.argv[1])",file],{encoding:'utf8'}); assert.equal(made.status,0,made.stderr);
 const source=await fsp.readFile(file);
 const no=await createModelWhatifTool({workspace:dir,calcInfo:{available:false}}).execute('no',{path:'model.xlsx',inputs:[{cell:'Discount PE!A1',value:3}],targets:['Discount PE!B1']});
 assert.equal(no.isError,true); assert.match(no.content[0].text,/LibreOffice/);
 let recalcCalls=0;
 const tool=createModelWhatifTool({workspace:dir,calcInfo:{available:true},engine:{
  async recalculateXlsx(input){ recalcCalls++; assert.notEqual(input,file); return input; },
  async readCells(input,refs,opts){ if(opts?.formulas)return Object.fromEntries(refs.map(r=>[r,r.endsWith('B1')?'=A1*2':2])); return {'Discount PE!B1':recalcCalls===1?4:6}; },
  async writeCells(input,out,assignments){ assert.deepEqual(assignments,['Discount PE!A1=3']); await fsp.copyFile(input,out); }
 }});
 const yes=await tool.execute('yes',{path:'model.xlsx',inputs:[{cell:"'Discount PE'!A1",value:3}],targets:['Discount PE!B1']});
 assert.equal(yes.isError,undefined); assert.equal(yes.details.results[0].before,4); assert.equal(yes.details.results[0].after,6); assert.equal(recalcCalls,2);
 const formula=await tool.execute('formula',{path:'model.xlsx',inputs:[{cell:'Discount PE!B1',value:3}],targets:['Discount PE!B1']}); assert.equal(formula.isError,true); assert.match(formula.content[0].text,/公式/);
 assert.deepEqual(await fsp.readFile(file),source); assert.equal((await tool.execute('outside',{path:'../outside.xlsx',inputs:[],targets:[]})).isError,true);
 console.log('model whatif: ok');
} finally {await fsp.rm(dir,{recursive:true,force:true});}
