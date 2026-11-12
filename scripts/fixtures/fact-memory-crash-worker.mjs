// Child-process fault injector. Not imported or reachable from production tools.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {FactMemory} from '../../lib/fact-memory/store.mjs';
import {importLegacy,previewLegacy} from '../../lib/fact-memory/maintenance.mjs';
const [root,mode,gate]=process.argv.slice(2),db=new DatabaseSync(path.join(root,'test.db'));
db.exec('pragma journal_mode=WAL; pragma busy_timeout=5000;');
const memory=new FactMemory({store:{db,projectId:'p',workspace:root}});
const crash=()=>process.kill(process.pid,'SIGKILL');
const call={id:'one',name:'workbook_query',success:true,details:{sha256:'sha',citations:[{materialId:'m',version:1,locator:'S!B2',company:'ACME',metric:'revenue',period:'2024',scope:'consolidated',basis_type:'actual',currency:'CNY',value:100,display_unit:'百万元'}]}};
if(mode==='start') {memory.beginTool('s',call);crash();}
if(mode==='receipt') {memory.processEvent=crash;memory.capture('s',call);}
if(mode==='normalization') {const append=memory._append.bind(memory);memory._append=(...args)=>{append(...args);crash();};memory.capture('s',call);}
if(mode==='import') {const append=memory._append.bind(memory);memory._append=(...args)=>{append(...args);crash();};const preview=previewLegacy(memory,'old');importLegacy(memory,{session_id:'old',expected_sha256:preview.sha256});}
if(mode==='export-first')memory.exportPending({afterFileWritten:crash});
if(mode==='export-both')memory.exportPending({beforePublish:crash});
if(mode==='commit' || mode==='race') {
 if(gate)while(!fs.existsSync(gate))await new Promise(resolve=>setTimeout(resolve,5));
 const f=memory.allFacts()[0];
 try {const result=memory.commitFramework({framework_id:'F',expected_revision:1,state:{note:'next'},report:'新版本',fact_refs:[{fact_id:f.fact_id,fact_version:f.fact_version,role:'verified'}]});if(mode==='commit')crash();else process.stdout.write(JSON.stringify(result));}
 catch(e) {process.stdout.write(JSON.stringify({status:'failed',error:e.code || e.message}));}
}
db.close();
