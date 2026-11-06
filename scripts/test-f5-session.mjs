import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../store.mjs';
import {createSessionService} from '../server/agent/session-service.mjs';
import {appendCorrection,readLedger} from '../lib/ledger.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'f5-session-'));
const store=await openStore({root,workspace:root,projectId:'p',seed:false});
const ctx={id:'p',root,store,tools:[],agentEvents:{append:()=>({})}};
const service=createSessionService({config:{fakeAgent:true,modelId:'fake'},bus:{broadcast(){},broadcastGlobal(){}},projectManager:{list:()=>[ctx]},live:new Map()});
try {
 const entry=await service.createEntry({ctx});
 assert.deepEqual(entry.sessionTools.map(t=>t.name),['ledger_record','transcript_search']);
 entry.session.messages.push({role:'user',content:'问题'});
 const tool=entry.sessionTools[0];
 const r=await tool.execute('x',{kind:'correction',claim:'期间',from:'2026H1',to:'1H27',evidence:{type:'user',ref:'问题'},sessionId:'other',turn:999});
 assert.ok(!r.isError);assert.equal((await readLedger(root,entry.id)).corrections[0].turn,1);assert.equal(await readLedger(root,'other'),null);
 await appendCorrection(root,entry.id,{claim:'利润',from:7.3,to:72.93,unit:'亿',evidence:{type:'user',ref:'问题'},turn:1});
 assert.deepEqual(entry.snapshot().pendingMerges,[]);
 entry.transcriptBoundary=1;entry.session.messages.push({role:'user',content:'新问题'});
 const search=await entry.sessionTools[1].execute('x',{query:'新问题'});assert.equal(search.details.totalMatches,0);assert.equal(search.details.ledger.sessionId,entry.id);assert.equal(search.details.ledger.corrections.length,2);
 await fs.mkdir(path.join(root,'exports'),{recursive:true});await fs.writeFile(path.join(root,'exports/r.md'),'期间2026H1。');
 await tool.execute('pending',{kind:'correction',claim:'期间',from:'2026H1',to:'1H27',evidence:{type:'user',ref:'问题'}});
 assert.equal(entry.snapshot().pendingMerges[0].path,'exports/r.md');
 const watch=await service.createEntry({ctx,writeRoots:['.watch/']});assert.deepEqual(watch.sessionTools,[]);assert.deepEqual(watch.snapshot().pendingMerges,[]);
 const tracking=await service.createEntry({ctx,automated:true});assert.deepEqual(tracking.sessionTools,[]);
 console.log('F5 session binding and automated isolation PASS');
} finally {service.close();store.db.close();await fs.rm(root,{recursive:true,force:true});}
