/** Real XLSX/PDF parser → production tool → DB → restarted/new session.
 * This is deterministic product-tool integration, NOT a live-model E2E run.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from '../store.mjs';
import {WorkbookStore} from '../lib/workbook-store.mjs';
import {PdfStore} from '../lib/pdf-store.mjs';
import {createWorkbookTool} from '../lib/workbook-tool.mjs';
import {createPdfTool} from '../lib/pdf-tool.mjs';
import {FactMemory} from '../lib/fact-memory/store.mjs';
import {withFactCapture,createFactMemoryTools} from '../lib/fact-memory/tools.mjs';
import {buildTurnContext} from '../lib/turn-context.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'pe-memory-tool-'));
const workspace=path.join(root,'project'),dataDir=path.join(root,'data');
fs.mkdirSync(path.join(workspace,'uploads'),{recursive:true});fs.mkdirSync(path.join(dataDir,'blobs'),{recursive:true});
const db=new DatabaseSync(path.join(dataDir,'workbench.db'));
const store=new Store(db,{workspace,dataDir,projectId:'p1'});store.migrate();
const workbooks=new WorkbookStore({store});const pdfs=new PdfStore({store});
let memory=new FactMemory({store});
try {
 const generated=spawnSync('python3',['-c',`import openpyxl, fitz, sys, os
root=sys.argv[1]
w=openpyxl.Workbook();w.remove(w.active)
for entity in ['ACME','Beta']:
 s=w.create_sheet(entity)
 s.append(['company: '+entity]);s.append(['consolidated RMB mn'])
 s.append(['Metric','2023 actual','2024 actual','2025 forecast; scenario: base'])
 s.append(['revenue',90,100,110]);s.append(['ebitda',18,20,22]);s.append(['assets',100,100,120]);s.append(['net_debt',30,30,30])
 s.append(['ratio %',20,20,20]);s.append(['cached formula',None,'=C5/C4'])
w.save(os.path.join(root,'model.xlsx'))
doc=fitz.open()
for text in ['ACME annual results 2024. Revenue 100 RMB million. Consolidated actuals.', 'ACME 2024 EBITDA 20 RMB million. Footnote: exclude discontinued operations.', 'Beta 2024 Revenue 100 RMB million. Forecast 2025: 110 RMB million.']:
 p=doc.new_page();p.insert_text((70,70),text)
doc.new_page() # blank/image-like, must not fabricate a number
pdf=os.path.join(root,'report.pdf');doc.save(pdf)
`,path.join(workspace,'uploads')],{encoding:'utf8'});assert.equal(generated.status,0,generated.stderr);
 const tool=withFactCapture(createWorkbookTool({store,workbooks,workspace}),memory,()=>({session_id:'initial',turn:1}));
 const read=await tool.execute('excel-1',{path:'uploads/model.xlsx',query:'ACME!C4:C7',maxCells:30});assert.notEqual(read.isError,true,JSON.stringify(read));
 assert.equal(read.details.factMemory.status,'persisted');
 let result=memory.query({entity:'ACME',metric:'revenue',period:'2024',scope:'consolidated',basis_type:'actual'});
 assert.equal(result.status,'found',JSON.stringify(result));assert.equal(result.facts[0].raw_value,100);assert.equal(result.facts[0].quality,'source_checked',JSON.stringify(result.facts[0]));
 const revenue=result.facts[0];
 for(const [id,query] of [['excel-2','Beta!B4:C7'],['excel-3','ACME!B4:B7'],['excel-4','ACME!D4:D7'],['excel-5','ACME!C9']])await tool.execute(id,{path:'uploads/model.xlsx',query});
 assert.equal(memory.query({metric:'revenue',period:'2024'}).status,'ambiguous');
 assert.notEqual(memory.query({entity:'ACME',metric:'cached formula',period:'2024'}).facts[0]?.quality,'source_checked');
 assert.equal(memory.query({entity:'ACME',metric:'revenue',period:'2025E'}).status,'not_found'); // period 2025 forecast retained as 2025, basis separate
 const forecast=memory.query({entity:'ACME',metric:'revenue',period:'2025',basis_type:'forecast'});
 assert.equal(forecast.facts[0].raw_value,110);assert.equal(forecast.facts[0].basis_type,'forecast');
 memory=new FactMemory({store});
 const newTools=createFactMemoryTools({memory,getMetadata:()=>({session_id:'new-session'})});
 const answer=await newTools.find(t=>t.name==='fact_query').execute('q',{entity:'ACME',metric:'revenue',period:'FY2024',basis_type:'actual'});
 assert.equal(answer.details.facts[0].raw_value,100);assert.equal(answer.details.facts[0].evidence_ids[0],revenue.evidence_ids[0]);
 const ctx=await buildTurnContext({root:workspace,sessionId:'new-session',question:'ACME 2024 revenue',factMemory:memory});assert.ok(ctx.content.includes(revenue.fact_id));
 const pdf=withFactCapture(createPdfTool({store,pdfs,workspace}),memory,()=>({session_id:'pdf-session',turn:2}));
 const p=await pdf.execute('pdf-pages',{path:'uploads/report.pdf',mode:'pages',page:'1-4'});assert.notEqual(p.isError,true,JSON.stringify(p));assert.equal(p.details.factMemory.status,'persisted');
 const evidence=memory.listEvidence({limit:100}).filter(e=>e.extractor==='pdf-text-v1');
 for(const page of [1,2,3])assert.ok(evidence.some(e=>e.locator===`p.${page}` && /2024/.test(e.excerpt)));
 const scanned=evidence.find(e=>e.locator==='p.4');assert.ok(scanned?.scanned || !scanned?.excerpt);
 assert.equal(memory.query({fact_id:'pdf-uninvented'}).status,'not_found');
 console.log('PASS real XLSX/PDF tool adapters, project persistence, new-session recall, multi-entity/basis separation, scan abstention');
} finally {workbooks.close?.();pdfs.close?.();db.close();fs.rmSync(root,{recursive:true,force:true});}
