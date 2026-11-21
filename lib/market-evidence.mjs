import {parseWestockQuotes,verifyQuoteIdentity} from './westock-tool.mjs';

// Market receipts remain market receipts: never fabricate a workbook locator.
// Reparse successful recorded responses so older missing metadata can be
// repaired without a new remote query.
export function marketEvidenceFromCalls(calls=[]) {
 const evidence=[];
 for(const call of calls) {
  if(call.name!=='westock_query' || call.success!==true || call.result?.isError)continue;
  const details=call.result?.details || call.details || {},args=call.args?.args || details.args || [];
  if(args[0]!=='quote' || details.truncated)continue;
  const raw=(call.result?.content || []).filter(p=>p.type==='text').map(p=>p.text).join('\n');
  let identity;
  try {identity=verifyQuoteIdentity(raw,call.args?.expectedName || details.identity?.name,args);} catch {continue;}
  for(const quote of parseWestockQuotes(raw,args,details.fetched_at)) {
   if(!quote.quote_at)continue;
   const common={toolCallId:call.id,entity:identity.name,ticker:quote.ticker,date:quote.quote_at.slice(0,10),currency:quote.currency};
   evidence.push({...common,id:`tool:${call.id}:price`,metric:'price',value:quote.price,unit:'元/股'});
   const lines=raw.split('\n').filter(l=>l.trim().startsWith('|'));
   const cells=l=>l.trim().split('|').slice(1,-1).map(c=>c.trim());
   const header=cells(lines[0] || '');
   const row=cells(lines[2] || '');
   const cap=Number(row[header.indexOf('total_market_cap')]);
   if(header.includes('total_market_cap') && row[header.indexOf('total_market_cap')] && Number.isFinite(cap))
    evidence.push({...common,id:`tool:${call.id}:total_market_cap`,metric:'market_cap',value:cap,unit:'元'});
  }
 }
 return evidence;
}

export function matchingMarketEvidence(claim,statement,{question='',heading='',evidence=[],matches}) {
 const metric=/市值/.test(claim.metric || '') ? 'market_cap' : /股价|现价|当前价|收盘|share price|stock price/i.test(claim.metric || '') ? 'price' : null;
 if(!metric)return [];
 const names=[...new Set(evidence.map(e=>e.entity))];
 const mentioned=names.filter(n=>statement.includes(n));
 const inherited=names.filter(n=>(heading+' '+question).includes(n));
 const target=mentioned.length?mentioned:inherited.length===1?inherited:names.length===1?names:[];
 // Retrieval time and the quoted trading date are distinct facts. A next-day
 // fetch must not turn a correctly dated closing quote into a date conflict.
 const quoteStatement=statement.replace(/(?:数据)?(?:抓取|获取|查询|检索|下载)(?:时间)?(?:于|为|[：:])?\s*20\d{2}-\d{2}-\d{2}/g,'');
 const dates=quoteStatement.match(/20\d{2}-\d{2}-\d{2}/g) || [];
 const statedCompany=claim.company || statement.match(/(?:^|[，。；\s])([\p{Script=Han}]{1,12}(?:公司|集团))(?=20\d{2}|的|股价|现价|收盘|当前|市值)/u)?.[1];
 if(new Set(dates).size>1)return [];
 return evidence.filter(e=>target.includes(e.entity) && e.metric===metric &&
  (!statedCompany || [e.entity,e.ticker].some(name=>name.toLowerCase()===statedCompany.toLowerCase())) &&
  (!dates.length || dates[0]===e.date) && (!claim.currency || claim.currency===e.currency) &&
  matches({...claim,...(metric==='price'?{perShare:true}:{})},{value:e.value,raw_unit:e.unit,currency:e.currency}));
}
