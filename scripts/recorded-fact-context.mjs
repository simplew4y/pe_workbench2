import {DatabaseSync} from 'node:sqlite';
import {FactMemory} from '../lib/fact-memory/store.mjs';

// Reconstruct only receipts visible by this point in the recorded session.
// A normalized fact is eligible only if its id, version and quality match the
// original persistence receipt. Never pull the final project DB into an earlier turn.
export function recordedFactContext(root, sessionId) {
  const db=new DatabaseSync(':memory:');
  const memory=new FactMemory({store:{db,workspace:root,projectId:'offline'}});
  const calls=new Map(), authenticated=new Map(), seen=new Set();
  const key=f=>f.fact_id+'@'+f.fact_version;
  function observe(message) {
    if(message.role==='assistant' && Array.isArray(message.content)) {
      for(const part of message.content) if(part.type==='toolCall') calls.set(part.id,part);
    }
    const manifest=message.details?.factMemory, call=calls.get(message.toolCallId);
    if(message.role!=='toolResult' || !manifest?.facts?.length || !call || seen.has(call.id)) return;
    seen.add(call.id);
    const {factMemory,...details}=message.details;
    const generated=memory.capture(sessionId,{id:call.id,name:call.name,args:call.arguments,
      success:!message.isError,details,result:{...message,details}});
    const allowed=new Map(manifest.facts.map(f=>[key(f),f.quality]));
    for(const fact of generated) if(allowed.get(key(fact))===fact.quality)authenticated.set(key(fact),fact.quality);
  }
  return {observe,close:()=>db.close(),recover(){},query(filters={}) {
    const result=memory.query(filters);
    return {...result,facts:result.facts.filter(f=>authenticated.get(key(f))===f.quality)};
  }};
}
