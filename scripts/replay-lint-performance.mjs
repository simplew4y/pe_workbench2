import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
globalThis.fetch=()=>{throw Error('network disabled');};
const [recordDir,outDir,baseline]=process.argv.slice(2);
fs.mkdirSync(outDir,{recursive:true});
const rows=fs.readFileSync(path.join(recordDir,'session.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
const meta=JSON.parse(fs.readFileSync(path.join(recordDir,'run-meta.json'),'utf8'));
const pending=new Map(),calls=[];let draft='',sample;
for(const row of rows){const m=row.message;
 if(m?.role==='assistant'){
  for(const c of m.content || [])if(c.type==='toolCall')pending.set(c.id,c);
  if(m.stopReason==='stop')draft=typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
 }
 if(m?.role==='toolResult' && pending.has(m.toolCallId)){const c=pending.get(m.toolCallId);calls.push({id:c.id,name:c.name,args:c.arguments,result:m,details:m.details,success:!m.isError});}
 if(row.customType==='pe_answer_lint'){sample={draft,context:{question:meta.question,citations:row.data.citations || [],toolCalls:calls,locatorFindings:row.data.findings}};break;}
}
if(!sample)throw Error('No recorded lint sample');
const results=[];
for(const [label,root] of [['current',process.cwd()],...(baseline?[['baseline',baseline]]:[])]){
 const {lintLedgerAnswer}=await import(pathToFileURL(path.join(root,'lib/answer-lint.mjs')));
 const start=performance.now();const findings=lintLedgerAnswer(sample.draft,{facts:[]},sample.context);
 const serialized=JSON.stringify(findings);
 const result={label,network:false,elapsedMs:performance.now()-start,draftChars:sample.draft.length,citations:sample.context.citations.length,toolCalls:calls.length,findings:findings.length,errors:findings.filter(f=>f.severity==='error').length,sha256:createHash('sha256').update(serialized).digest('hex')};
 fs.writeFileSync(path.join(outDir,label+'-findings.json'),JSON.stringify(findings,null,2));results.push(result);console.log(JSON.stringify(result));
}
fs.writeFileSync(path.join(outDir,'performance.json'),JSON.stringify(results,null,2));
