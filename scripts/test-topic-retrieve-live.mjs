import assert from 'node:assert/strict';
import path from 'node:path';
import {completeSimple,getModel} from '@earendil-works/pi-ai/compat';
import {loadEnvFile,REPO_ROOT} from '../server/config.mjs';
loadEnvFile(path.join(REPO_ROOT,'.env.local'));
const apiKey=process.env.DEEPSEEK_API_KEY||process.env.DEEPSEEK_KEY;
if(!apiKey){console.log('topic live locate skipped: no API key configured');process.exit(0);}
const modelId=process.env.PI_INDEX_MODEL||'deepseek-flash';
const model=getModel('deepseek',modelId);
const topics=[
{id:'W01',title:'A 公司：2024 年与 2023 年营业收入及业务规模对比',summary:'A 公司：2024 年与 2023 年营业收入及业务规模对比',binding:{company:'A 公司',metrics:['营业收入'],periods:['2024','2023']}},
{id:'W02',title:'A 公司：2024 年与 2023 年归属于母公司股东的净利润',summary:'A 公司：2024 年与 2023 年归属于母公司股东的净利润',binding:{company:'A 公司',metrics:['归母净利润'],periods:['2024','2023']}},
{id:'W03',title:'A 公司：2024 年与 2023 年合并净利润，包含子公司其他股东收益',summary:'A 公司：2024 年与 2023 年合并净利润，包含子公司其他股东收益',binding:{company:'A 公司',metrics:['合并净利润'],periods:['2024','2023']}},
{id:'W04',title:'B 公司：2024 年与 2023 年营业收入及业务规模对比',summary:'B 公司：2024 年与 2023 年营业收入及业务规模对比',binding:{company:'B 公司',metrics:['营业收入'],periods:['2024','2023']}}
];
const cases=[
['R01','帮我看看 A 公司 2024 年的年报。\n已定位到这份年报。','2024 年和 2023 年，分别做了多少钱的生意？扣掉各种开销和税，算到这家公司自己股东头上的收益又有多少？',['W01','W02']],
['R02','A 公司 2024 年做了多少钱的生意？\n120 亿元。\n换成 B 公司，同一年呢？\n80 亿元。','那前一年呢？',['W04']],
['R03','把 A 和 B 公司 2024 年做了多少钱的生意放一起看看。\nA 公司为 120 亿元，B 公司为 80 亿元。','它比前一年多了多少？',['W01','W04']],
['R04','A 公司 2024 年做了多少钱的生意？\n120 亿元。\n那扣掉开销后，算到它自己股东头上的收益呢？\n15 亿元。\n再看 B 公司，2024 年做了多少钱的生意？\n80 亿元。','回到最开始那家公司，还是最开始问的生意规模，2024 年和 2023 年差多少？',['W01']]
];
for(const [id,history,question,expected] of cases){
 const prompt=`根据问题、对话历史与主题摘要定位主题。不要计算或输出证据数字。R03有歧义时保留两个候选并标记company待确认。仅输出JSON：{"topicIds":[],"parsed":{"company":null,"metric":null,"periods":[]},"clarification":{"needed":false,"missing":[]}}\n历史：${history}\n当前问题：${question}\n主题：${JSON.stringify(topics)}`;
 const response=await completeSimple(model,{messages:[{role:'user',content:prompt}]},{temperature:0});
 if(response?.errorMessage) throw new Error(`${id}: live request failed (${response.errorMessage})`);
 const content=Array.isArray(response?.content)?response.content.filter(x=>x.type==='text').map(x=>x.text).join(''):String(response?.content||response?.text||'');
 let result;try{const cleaned=content.replace(/^```(?:json)?\s*|\s*```$/g,'').trim();const start=cleaned.indexOf('{'),end=cleaned.lastIndexOf('}');result=JSON.parse(start>=0?cleaned.slice(start,end+1):cleaned);}catch{throw new Error(`${id}: model returned invalid JSON (${content.slice(0,240)})`);}
 assert.deepEqual((result.topicIds||[]).slice().sort(),expected.slice().sort(),`${id} topic IDs`);
 if(id==='R03')assert.deepEqual(result.clarification?.missing,['company']);
 console.log(`${id}: passed`);
}
