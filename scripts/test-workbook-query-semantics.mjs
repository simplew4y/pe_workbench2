import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { queryGraph, summarizeGraph, indexGraph, formatResult, normalizeDisplayUnit } from '../lib/workbook-query.mjs';
for (const alias of ['Rmb mn','RMB mn','rmb mn','mn','HKD mn','百万元','百万']) assert.equal(normalizeDisplayUnit(alias),'百万元',alias);
assert.equal(normalizeDisplayUnit('亿'),'亿元'); assert.equal(normalizeDisplayUnit(''),'unit_unknown');
const dir=await fsp.mkdtemp(path.join(os.tmpdir(),'pe-query-semantics-'));
try {
 const file=path.join(dir,'fixture.xlsx');
 const made=spawnSync('python3',['-c',`import openpyxl,sys
w=openpyxl.Workbook(); s=w.active; s.title='Discount PE'
s['G32']='目标价'; s['H32']='2025E'; s['G33']='估值'; s['H33']='=5*2'
s=w.create_sheet('Segments'); s.append(['毛利率','%','2025E']); s.append(['HBM',None,0.65]); s.append(['收入占比','%','FY26']); s.append(['HBM',None,0.2]); s['D2']='=C2'; s['D4']='=C4'
s=w.create_sheet('Cover'); s.append(['公司名称','测试公司']); s.append(['证券代码','0700.HK']); s.append(['币种','HKD']); s.append(['估值日期','2026-11-04'])
s=w.create_sheet('Money'); s.append(['收入','RMB mn','2025E']); s.append(['腾讯',None,7053443])
s=w.create_sheet('Plain'); s['A1']='数值'; s['B1']=123; w.save(sys.argv[1])`,file],{encoding:'utf8'});
 assert.equal(made.status,0,made.stderr);
 const parser=fileURLToPath(new URL('../services/workbook/parse_workbook.py',import.meta.url));
 const parsed=spawnSync('python3',[parser,file],{encoding:'utf8'}); assert.equal(parsed.status,0,parsed.stderr);
 const graph=indexGraph(JSON.parse(parsed.stdout));
 for(const ref of ['Discount PE!H33',"'Discount PE'!H33",'Discount PE!G33:H33']) assert.ok(queryGraph(graph,ref).cells.some(c=>c.ref==='Discount PE!H33'),ref);
 const missing=queryGraph(graph,'Missing Sheet!H33'); assert.equal(missing.isError,true); assert.match(formatResult(missing),/未找到工作表/); assert.ok(missing.availableSheets.includes('Discount PE'));
 assert.equal(queryGraph(graph,'Discount PE!Z999').isError,true);
 assert.equal(queryGraph(graph,'C2',{sheet:'Discount PE'}).isError,true, 'an address on another sheet must not hide a scoped miss');
 const hbm=queryGraph(graph,'HBM',{maxCells:40});
 const margin=hbm.cells.find(c=>c.ref==='Segments!C2'), share=hbm.cells.find(c=>c.ref==='Segments!C4');
 assert.ok(margin.sectionPath.includes('毛利率')); assert.ok(share.sectionPath.includes('收入占比')); assert.equal(margin.unit,'%'); assert.equal(margin.display_unit,'%'); assert.equal(margin.period,'2025E'); assert.equal(share.period,'FY26');
 const money=queryGraph(graph,'Money!C2').cells.find(c=>c.ref==='Money!C2');
 assert.equal(money.unit,'RMB mn'); assert.equal(money.display_unit,'百万元');
 const plain=queryGraph(graph,'Plain!B1').cells.find(c=>c.ref==='Plain!B1');
 assert.equal(plain.display_unit,'unit_unknown');
 assert.equal(queryGraph(graph,'HBM',{maxCells:1}).coverage.truncated,true);
 const summary=summarizeGraph(graph); assert.ok(summary.outputs.every(c=>c.role));
 assert.ok(summary.metadataFacts.some(c=>String(c.value).includes('0700.HK')));
 assert.ok(summary.metadataFacts.every(c=>c.role));
 const bounded=queryGraph(graph,'HBM'); formatResult(bounded,{maxCells:1}); assert.equal(bounded.coverage.textTruncated,true); assert.equal(bounded.coverage.textReturnedCount,1);
 assert.ok(hbm.coverage.note.includes('不')); console.log('workbook query semantics: ok');
} finally { await fsp.rm(dir,{recursive:true,force:true}); }
