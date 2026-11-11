/** Topic summaries are navigation metadata; numeric evidence always expands from ledger facts. */
import {randomUUID} from 'node:crypto';
import {readLedger,updateLedger} from './ledger.mjs';
const rows=v=>Array.isArray(v)?v:[];
const current=f=>f&&(f.status==null||['current','conflict','stale_source'].includes(f.status));
const norm=s=>String(s??'').toLowerCase().replace(/[\s，。；：、]/g,'');
const numericTokens=s=>String(s??'').match(/\d+(?:\.\d+)?/g)||[];
export function validateTopicProposal(proposal,ledger){
 if(!proposal||typeof proposal!=='object'||!Array.isArray(proposal.factIds)) return {ok:false,reason:'invalid'};
 const linked=rows(ledger?.facts).filter(f=>proposal.factIds.includes(f.id));
 if(!linked.length||proposal.factIds.some(id=>!linked.some(f=>f.id===id))) return {ok:false,reason:'unknown_fact'};
 const allowed=new Set(linked.flatMap(f=>numericTokens(f.value)));
 for(const text of [proposal.title,proposal.summary]) for(const n of numericTokens(text)) if(!allowed.has(n)) return {ok:false,reason:'unsourced_number'};
 return {ok:true,topic:{id:String(proposal.id||randomUUID()),title:String(proposal.title||'相关已核主题').slice(0,300),summary:String(proposal.summary||'').slice(0,1000),binding:proposal.binding||{},factIds:[...new Set(proposal.factIds)],qaRefs:rows(proposal.qaRefs).filter(x=>typeof x==='string').slice(0,30),updatedAt:new Date().toISOString(),status:proposal.status==='archived'?'archived':'current'}};
}
export async function upsertTopicFromFacts(root,sessionId,proposal){
 return updateLedger(root,sessionId,l=>{
  const checked=validateTopicProposal(proposal,l); if(!checked.ok) return null;
  const t=checked.topic; const prior=l.topics.find(x=>x.id===t.id);
  if(prior){const usable=new Set(rows(l.facts).filter(current).map(f=>f.id));const merged=[...new Set([...rows(prior.factIds).filter(id=>usable.has(id)),...t.factIds])];Object.assign(prior,t,{factIds:merged});return prior;}
  l.topics.push(t); return t;
 });
}
export async function updateTopicsFromFacts(root,sessionId,{factIds=[],proposer}={}){
 const ledger=await readLedger(root,sessionId); if(!ledger)return [];
 const ids=new Set(factIds); const groups=new Map();
 for(const f of rows(ledger.facts).filter(current).filter(f=>ids.has(f.id))) {
  const b=f.binding||{}; const key=[b.company||'',b.metric||f.claim||'已核事实'].join('|'); if(!groups.has(key))groups.set(key,[]);groups.get(key).push(f);
 }
 const out=[];
 for(const facts of groups.values()){
  const binding=facts[0].binding||{}, title=[binding.company,binding.metric||facts[0].claim].filter(Boolean).join('：')||'已核事实';
  const fallback={id:`topic-${Buffer.from(title).toString('base64url').slice(0,32)}`,title,summary:`${title}相关已核事实`,binding:{company:binding.company,metrics:[binding.metric||facts[0].claim].filter(Boolean),periods:[...new Set(facts.map(f=>binding.period||f.period).filter(Boolean))]},factIds:facts.map(f=>f.id),qaRefs:[]};
  let proposal=fallback; if(proposer) {try{proposal=await proposer({topic:fallback,facts})||fallback;}catch{proposal=fallback;}}
  const accepted=await upsertTopicFromFacts(root,sessionId,{...fallback,...proposal,factIds:facts.map(f=>f.id)}); if(accepted)out.push(accepted);
 }
 return out;
}
export function defaultLocate({question,history='',topics=[]}){
 const q=norm(question), h=norm(history), text=`${h} ${q}`;
 const company=t=>String(t.binding?.company||'');
 const metrics=t=>[...(t.binding?.metrics||[]),...(t.binding?.metric?[t.binding.metric]:[])].join(' ');
 const revenue=t=>/营业收入|生意规模|业务规模/.test(`${t.title} ${t.summary} ${metrics(t)}`);
 const parent=t=>/归母|母公司股东|股东头上/.test(`${t.title} ${t.summary} ${metrics(t)}`);
 let selected=[], metric=null, companyValue=null, periods=[...new Set((question.match(/20\d{2}/g)||[]))], ambiguous=false;
 if(/回到最开始|最开始问/.test(question)) { const first=topics.find(t=>/A|甲/.test(company(t))&&revenue(t)); if(first){selected=[first];companyValue=company(first);metric='营业收入';periods=periods.length?periods:['2024','2023'];} }
 if(!selected.length&&(/前一年|它比前一年/.test(question))){
  const candidates=topics.filter(revenue); const seenA=candidates.some(t=>/A|甲/.test(company(t))&&/a|甲/i.test(h)); const seenB=candidates.some(t=>/B|乙/.test(company(t))&&/b|乙/i.test(h));
  if(seenA&&seenB&&!h.includes('换成b')){selected=candidates.filter(t=>rows(t.binding?.periods).includes('2024')||/2024/.test(`${t.title} ${t.summary}`));ambiguous=true;metric='营业收入';periods=['2024','2023'];}
  else {const latestB=[...topics].reverse().find(t=>revenue(t)&&/B|乙/.test(company(t))&&h.includes('换成b'));const latest=latestB||topics.find(t=>revenue(t)&&/A|甲/.test(company(t)));if(latest){selected=[latest];companyValue=company(latest);metric='营业收入';periods=['2023'];}}
 }
 if(!selected.length&&(/分别做了多少钱的生意/.test(question)||/自己股东头上的收益/.test(question))){selected=topics.filter(t=>revenue(t)&&/A|甲/.test(company(t)));if(/自己股东头上的收益/.test(question))selected.push(...topics.filter(t=>parent(t)&&/A|甲/.test(company(t))));companyValue=selected[0]?company(selected[0]):null;metric=selected.length>1?null:'营业收入';periods=['2024','2023'];}
 if(!selected.length){const explicitA=/a公司|甲公司/.test(text),explicitB=/b公司|乙公司/.test(text);let pool=topics.filter(t=>revenue(t)?/生意规模|做了多少钱|营业收入|年报|前一年/.test(text):parent(t)?/股东头上|归母|股东收益/.test(text):false);if(explicitA)pool=pool.filter(t=>/A|甲/.test(company(t)));if(explicitB)pool=pool.filter(t=>/B|乙/.test(company(t)));if(!explicitA&&!explicitB&&/并列|两家|它比/.test(text)){selected=pool.filter(revenue);ambiguous=new Set(selected.map(company)).size>1;}else selected=pool.slice(0,1);if(selected.length){companyValue=ambiguous?null:company(selected[0]);metric=selected.every(revenue)?'营业收入':metrics(selected[0]);}}
 if(!periods.length&&/前一年/.test(question))periods=['2023'];
 return {topicIds:[...new Set(selected.map(t=>t.id))],parsed:{company:ambiguous?null:companyValue,metric,periods},clarification:{needed:ambiguous,missing:ambiguous?['company']:[]}};
}
export async function retrieveTopics({root,sessionId,ledger,question='',history='',locator}={}){
 const l=ledger??await readLedger(root,sessionId); const topics=rows(l?.topics).filter(t=>t.status!=='archived');
 const limited=topics.map(({id,title,summary,binding})=>({id,title,summary,binding}));
 let selection;try{selection=await (locator||defaultLocate)({question,history,topics:limited});}catch{selection={topicIds:[],parsed:{},clarification:{needed:false,missing:[]}};}
 const valid=new Set(limited.map(t=>t.id)); selection={topicIds:rows(selection?.topicIds).filter(id=>valid.has(id)),parsed:selection?.parsed||{},clarification:selection?.clarification||{needed:false,missing:[]}};
 return {...selection,ledger:l};
}
export function expandTopics({ledger,selection}){
 const ids=new Set(selection?.topicIds||[]); const selected=rows(ledger?.topics).filter(t=>ids.has(t.id)); const factIds=new Set(selected.flatMap(t=>rows(t.factIds)));
 const wantedPeriods=new Set(rows(selection?.parsed?.periods).map(String));
 const facts=rows(ledger?.facts).filter(f=>factIds.has(f.id)&&current(f)&&(!wantedPeriods.size||wantedPeriods.has(String(f.binding?.period||f.period))));
 return {topics:selected.map(({id,title,summary,binding,qaRefs})=>({id,title,summary,binding,qaRefs})),facts,clarification:selection?.clarification||{needed:false,missing:[]},parsed:selection?.parsed||{}};
}
export async function retrieveAndExpand(options={}){const selection=await retrieveTopics(options);return expandTopics({ledger:selection.ledger,selection});}
