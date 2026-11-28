import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createResearchReview} from '../lib/research-review.mjs';
import {publishFinalReport} from '../lib/report-publication.mjs';
import {latestReportFeedback} from '../lib/research-delivery.mjs';
globalThis.fetch=()=>{throw new Error('offline only');};
const root=fs.mkdtempSync(path.join(os.tmpdir(),'report-final-publication-'));
const outside=fs.mkdtempSync(path.join(os.tmpdir(),'report-outside-'));
try {
 const review=createResearchReview({ctx:{root,store:{findMaterialByPath:()=>null},workbooks:{}}});
 const target='exports/company/report.md';
 const rejected=await review.tool.execute('review',{path:target,content:'# 结论\n利润999亿元。',save:true});
 assert.equal(rejected.isError,true);
 const text='# 结论\n\n当前资料无法确认盈利，需补充同期间报表。\n\n## 观察方法\n\n核对订单、价格与回款。\n\n文件尚未保存：'+target+'。';
 const outcome={status:'partial',text,reason:'盈利资料不足',citations:[]};
 const result=review.publishDelivery(outcome,'分析公司并保存报告到'+target);
 assert.equal(result.status,'partial');assert.equal(result.reportPublication.saved,true);
 const body=fs.readFileSync(path.join(root,target),'utf8');
 assert.doesNotMatch(body,/^> 部分完成/);assert.match(body,/## 观察方法/);assert.doesNotMatch(body,/999|文件尚未保存/);
 assert.equal(crypto.createHash('sha256').update(body).digest('hex'),result.reportPublication.sha256);
 assert.equal(review.artifactSnapshot()[0].saved,true);
 assert.equal(review.artifactSnapshot()[0].researchStatus,'partial');
 assert.equal(review.publishDelivery(outcome,'保存报告').reportPublication.saved,false,'do not overwrite');
 assert.equal(fs.readFileSync(path.join(root,target),'utf8'),body);
 const draft={path:'exports/second.md',baseline:null,saveRequested:true,issues:['missing evidence']};
 const publish=(patch={})=>publishFinalReport({root,draft,outcome,question:'保存报告',...patch});
 assert.equal(publish({question:'只回答问题，不要保存文件'}),outcome);
 assert.equal(publish({outcome:{...outcome,status:'cancelled'}}).status,'cancelled');
 assert.equal(publish({draft:{...draft,saveRequested:false}}),outcome);
 assert.equal(publish({draft:{...draft,path:'../outside.md'}}).reportPublication.saved,false);
 assert.equal(publish({authorizeWrite:()=>({block:true,reason:'禁止写入'})}).reportPublication.saved,false);
 fs.symlinkSync(outside,path.join(root,'exports','linked'));
 assert.equal(publish({draft:{...draft,path:'exports/linked/report.md'}}).reportPublication.saved,false);
 assert.equal(fs.existsSync(path.join(outside,'report.md')),false);
 const pair=(id,p='exports/report.md',error=true)=>[
  {role:'assistant',content:[{type:'toolCall',id,name:'review_research',arguments:{path:p,content:'rejected 999',save:true}}]},
  {role:'toolResult',toolCallId:id,toolName:'review_research',isError:error,content:[{type:'text',text:id+' needs evidence'}]}];
 const messages=[{role:'user',content:'old'},...pair('old'),{role:'user',content:'current'},...pair('first'),...pair('last'),...pair('other','exports/other.md')];
 const copy=JSON.stringify(messages),feedback=latestReportFeedback(messages,['exports/report.md']);
 assert.equal(feedback.length,2);assert.equal(feedback[0].content[0].id,'last');assert.equal(feedback[1].toolCallId,'last');
 assert.equal(feedback[1].isError,true);assert.match(feedback[1].content[0].text,/last needs evidence/);
 assert.equal(feedback[0].content[0].arguments.content,undefined);
 assert.equal(JSON.stringify(messages),copy,'do not mutate historical transcript');
 assert.equal(latestReportFeedback([...messages,{role:'user',content:'next'}],['exports/report.md']).length,0);
 console.log('PASS offline final report publication, exact-body readback, honest partial status, no-clobber/path/write guards, latest paired feedback');
} finally {fs.rmSync(root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true});}
