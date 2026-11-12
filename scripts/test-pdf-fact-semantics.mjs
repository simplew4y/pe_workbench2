import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store.mjs';
import {PdfStore} from '../lib/pdf-store.mjs';
import {createPdfTool} from '../lib/pdf-tool.mjs';
import {FactMemory} from '../lib/fact-memory/store.mjs';
import {withFactCapture} from '../lib/fact-memory/tools.mjs';
import {extractPdfFacts} from '../lib/fact-memory/pdf-semantic.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pe-pdf-facts-')),workspace=path.join(root,'project'),dataDir=path.join(root,'data');fs.mkdirSync(path.join(workspace,'uploads'),{recursive:true});fs.mkdirSync(path.join(dataDir,'blobs'),{recursive:true});
const db=new DatabaseSync(path.join(dataDir,'workbench.db')),store=new Store(db,{workspace,dataDir,projectId:'p'});store.migrate();
const memory=new FactMemory({store}),pdfs=new PdfStore({store});
const pdf=withFactCapture(createPdfTool({store,pdfs,workspace}),memory,()=>({session_id:'pdf-gold'}));
try {
 const gen=spawnSync('python3',['-c',`import fitz,sys
p=sys.argv[1];doc=fitz.open()
def text_page(lines):
 page=doc.new_page()
 for i,line in enumerate(lines):page.insert_text((50,50+i*18),line+';')
 return page
text_page(['Entity: ACME','Period: 2024','Scope: consolidated','Basis: actual','Unit: RMB million','Revenue: 100','EBITDA: 20'])
text_page(['Entity: Beta','Period: 2025','Scope: standalone','Basis: forecast','Unit: USD million','Revenue: 80'])
text_page(['Entity: Gamma','Period: 2024','Scope: consolidated','Basis: actual','Unit: RMB million','Revenue: 50','Note: excludes discontinued operations'])
page=text_page(['Entity: TableCo','Scope: consolidated','Unit: RMB million'])
xs=[50,250,390,540];ys=[150,185,220,255]
for x in xs:page.draw_line((x,ys[0]),(x,ys[-1]))
for y in ys:page.draw_line((xs[0],y),(xs[-1],y))
for row,values in enumerate([['Metric','2024 actual','2025 forecast'],['Revenue','100','110'],['EBITDA','20','22']]):
 for col,value in enumerate(values):page.insert_text((xs[col]+6,ys[row]+22),value,fontsize=10)
doc.new_page();doc.save(p)
`,path.join(workspace,'uploads','gold.pdf')],{encoding:'utf8'});assert.equal(gen.status,0,gen.stderr);
 const read=await pdf.execute('pages',{path:'uploads/gold.pdf',page:'1-5'});assert.notEqual(read.isError,true,JSON.stringify(read));
 const a=memory.query({entity:'ACME',metric:'revenue',period:'2024'});assert.equal(a.status,'found',JSON.stringify(a));assert.equal(a.facts[0].quality,'source_checked');assert.equal(a.facts[0].canonical_value,'100000000');
 const b=memory.query({entity:'Beta',metric:'revenue',period:'2025'}).facts[0];assert.equal(b.quality,'source_checked');assert.equal(b.basis_type,'forecast');assert.equal(b.currency,'USD');
 const g=memory.query({entity:'Gamma',metric:'revenue',period:'2024'}).facts[0];assert.equal(g.quality,'needs_review');assert.ok(g.review_reasons.includes('pdf_context_requires_review'));
 const tables=await pdf.execute('table',{path:'uploads/gold.pdf',mode:'tables',page:'4'});assert.notEqual(tables.isError,true,JSON.stringify(tables));
 for(const [period,value,basis] of [['2024','100000000','actual'],['2025','110000000','forecast']]) {
   const f=memory.query({entity:'TableCo',metric:'revenue',period}).facts[0];assert.ok(f,JSON.stringify(tables));assert.equal(f.quality,'source_checked',JSON.stringify(f));assert.equal(f.canonical_value,value);assert.equal(f.basis_type,basis);assert.match(memory.evidence(f.evidence_ids[0]).locator,/table\.1\/r2c/);
 }
 const base='Entity: Delta; Period: 2024; Scope: consolidated; Basis: actual; Unit: RMB million;';
 for(const text of [base+' Revenue: 100*',base+' Revenue: 100; Footnote: adjusted',base+' Basis: forecast; Revenue: 100',base+' Currency: USD; Currency: CNY; Revenue: 100',base+' Scenario: base; Scenario: bear; Revenue: 100',base+' Currency: nonsense; Revenue: 100',base+' Period: invalid; Revenue: 100',base+' Revenue (forecast): 100',base+' Revenue: 100 RMB million*',base+' Revenue: 100 RMB million (forecast)']) {
   const result=extractPdfFacts({page:1,text});assert.ok(!result.candidates.length || result.candidates.every(f=>f.semantic_review));
 }
 assert.equal(extractPdfFacts({page:1,text:base+' Revenue: 100',scanned:true}).candidates.length,0);
 const orphan=extractPdfFacts({page:2,text:'continued',page_context:'Entity: Delta; Scope: consolidated; Unit: RMB million; continued',table:{index:1,data:[['Revenue','100','110']]}});
 assert.ok(orphan.candidates.every(f=>f.semantic_review && !f.identity.period));
 const unknown=extractPdfFacts({page:1,text:'Revenue: 100'}).candidates[0];assert.equal(unknown.identity.entity,'');assert.equal(unknown.identity.period,'');
 console.log('PASS three real PDF semantic gold pages, multi-period table, exact page/table evidence, forecast/currency identity, footnote/conflict/cross-page/OCR abstention');
} finally {pdfs.close?.();db.close();fs.rmSync(root,{recursive:true,force:true});}
