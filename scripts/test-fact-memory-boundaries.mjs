import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openStore} from '../store.mjs';
import {createSessionService} from '../server/agent/session-service.mjs';
import {FactMemory} from '../lib/fact-memory/store.mjs';
const root=await fs.mkdtemp(path.join(os.tmpdir(),'memory-boundary-'));
const outside=await fs.mkdtemp(path.join(os.tmpdir(),'memory-other-'));
const store=await openStore({root,workspace:root,projectId:'p1',seed:false});
const factMemory=new FactMemory({store});
const ctx={id:'p1',root,store,factMemory,tools:[],agentEvents:{append:()=>({})}};
const service=createSessionService({config:{fakeAgent:true,modelId:'fake',skillsDir:path.join(root,'skills')},bus:{broadcast(){},broadcastGlobal(){}},projectManager:{list:()=>[ctx]},live:new Map()});
try {
 await fs.mkdir(path.join(root,'skills'));await fs.mkdir(path.join(root,'exports/fact-memory'),{recursive:true});await fs.mkdir(path.join(root,'.pi/ledger'),{recursive:true});
 await fs.symlink(path.join(root,'exports/fact-memory'),path.join(root,'alias'));
 await fs.symlink(outside,path.join(root,'external'));
 const entry=await service.createEntry({ctx});
 const check=(name,file)=>entry.session.agent.beforeToolCall({toolCall:{name},args:{path:file}});
 for(const file of ['.pi/ledger/x.json','exports/fact-memory/F/r1/report.md','alias/F/r1/report.md','external/secret.txt'])assert.equal((await check('write',file)).block,true,file);
 assert.equal((await check('read','external/secret.txt')).block,true);
 assert.equal(await check('write','exports/draft.md'),undefined);
 assert.ok(entry.sessionTools.some(t=>t.name==='fact_query'));assert.ok(entry.sessionTools.some(t=>t.name==='framework_commit'));
 const automatic=await service.createEntry({ctx,automated:true});
 assert.deepEqual(automatic.sessionTools.map(t=>t.name),['fact_query']);
 factMemory.beginTool('interrupted',{id:'t',name:'workbook_query'});factMemory.recover({markInterrupted:true});
 assert.ok(factMemory.health().events.some(e=>e.status==='interrupted'));
 console.log('PASS protected write paths, symlink isolation, session-bound tools, background read-only tools and interrupted event observability');
} finally {service.close();store.db.close();await fs.rm(root,{recursive:true,force:true});await fs.rm(outside,{recursive:true,force:true});}
