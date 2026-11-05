
import {spawnSync} from "node:child_process";
import fs from "node:fs";
const tasks=["test:p0","test:workbook","test:agent-tools","test:server","test:tool-contracts","test:protocol"];
const args=process.argv.slice(2),index=args.indexOf("--workbook"),file=index<0?null:args[index+1];
const results=[];
function run(name,command,argv){
 const started=Date.now();
 const result=spawnSync(command,argv,{stdio:"inherit"});
 results.push({name,passed:result.status===0,seconds:(Date.now()-started)/1000});
}
for(const task of tasks)run(task,"npm",["run",task]);
if(file)run("real-workbook-and-save",process.execPath,["scripts/test-research-model.mjs",file]);
if(args.includes("--live"))run("live-audit-positive-negative",process.execPath,["scripts/test-research-audit-live.mjs"]);
console.log(JSON.stringify({results},null,2));
if(process.env.RESEARCH_TEST_RESULTS)fs.writeFileSync(process.env.RESEARCH_TEST_RESULTS,JSON.stringify({at:new Date().toISOString(),results},null,2));
process.exitCode=results.every(r=>r.passed)?0:1;
