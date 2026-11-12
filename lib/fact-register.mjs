/** Structured, append-preserving verified facts layered onto the v1 session ledger. */
import { randomUUID } from 'node:crypto';
import { updateLedger, readLedger } from './ledger.mjs';

export const WESTOCK_FACT_TTL_MS = 24 * 60 * 60 * 1000;
const marketDay = (date) => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Hong_Kong',year:'numeric',month:'2-digit',day:'2-digit'}).format(date);
const rows = (v) => Array.isArray(v) ? v : [];
const scalar = (v) => v != null && ['string','number','boolean'].includes(typeof v);
const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\s+/g,'');
const num = (v) => Number(String(v ?? '').replaceAll(',',''));
function bindingEqual(a,b) {
  const x=a?.binding||{}, y=b?.binding||{};
  if (!x.metric || !y.metric || norm(x.metric)!==norm(y.metric)) return false;
  if(!x.period||!y.period||norm(x.period)!==norm(y.period)) return false;
  if(!((x.unit||x.currency)&&(y.unit||y.currency))) return false;
  for(const key of ['unit','currency']) if(x[key]&&y[key]&&norm(x[key])!==norm(y[key])) return false;
  if(!x.unit&&!x.currency||!y.unit&&!y.currency) return false;
  for (const key of ['company','line']) if ((x[key]||y[key]) && norm(x[key])!==norm(y[key])) return false;
  return true;
}
function sameValue(a,b) {
  const x=num(a),y=num(b);
  return Number.isFinite(x)&&Number.isFinite(y) ? x===y : String(a)===String(b);
}
export function isFactExpired(fact, now = new Date()) {
  if (fact?.status === 'stale_source') return true;
  if (fact?.source !== 'westock' || !fact.fetchedAt) return fact?.status === 'expired';
  const fetched = new Date(fact.fetchedAt);
  const current = new Date(now);
  return !Number.isFinite(fetched.getTime()) || marketDay(fetched)!==marketDay(current) || (fact.expiresAt && current >= new Date(fact.expiresAt));
}
function currentItems(ledger) { return rows(ledger?.facts).filter(f => f?.status === 'current' || !f?.status); }
function freshFact(input) {
  if (!input || !scalar(input.value)) return null;
  const createdAt = input.createdAt || new Date().toISOString();
  const f = { id: input.id || randomUUID(), claim: String(input.claim || input.binding?.metric || 'verified fact'), value: input.value, unit: String(input.unit || ''), period: String(input.period || ''), createdAt,
    binding: input.binding || {}, source: input.source || 'workbook', scope: input.scope || 'session', turn:input.turn || 0, status: 'current' };
  if (input.citation) f.citation=input.citation;
  if (input.fetchedAt) { f.fetchedAt=input.fetchedAt; f.expiresAt=input.expiresAt || new Date(new Date(input.fetchedAt).getTime()+WESTOCK_FACT_TTL_MS).toISOString(); }
  return f;
}
export async function registerFact(root, sessionId, input) {
  const incoming=freshFact(input); if(!incoming) return null;
  return updateLedger(root,sessionId,l=>{
    l.facts ||= [];
    const matches=currentItems(l).filter(f=>bindingEqual(f,incoming));
    const equal=matches.find(f=>sameValue(f.value,incoming.value));
    if(equal) {
      if(incoming.fetchedAt) { equal.fetchedAt=incoming.fetchedAt; equal.expiresAt=incoming.expiresAt; }
      if(incoming.citation) equal.citation=incoming.citation;
      return equal;
    }
    if(incoming.source==='user_correction') {
      for(const old of matches) { old.status='superseded'; old.supersededBy=incoming.id; }
    } else {
      const conflicting=matches.filter(f=>f.source!==incoming.source);
      if(conflicting.length) {
        incoming.status='conflict'; incoming.conflictsWith=conflicting.map(f=>f.id);
        for(const old of conflicting) { old.status='conflict'; old.conflictsWith=[...new Set([...rows(old.conflictsWith),incoming.id])]; }
      } else for(const old of matches) { old.status='superseded'; old.supersededBy=incoming.id; }
    }
    l.facts.push(incoming); return incoming;
  });
}
export async function registerToolResult(root,sessionId,call,{turn=0}={}) {
  if(!call?.success || call.result?.isError===true || call.isError===true) return [];
  const d=call.details||call.result?.details||{}, name=call.name, facts=[];
  if(['workbook_query','workbook_trace','pdf_query','pdf_read'].includes(name)) {
    for(const c of rows(d.citations)) if(c?.value!=null) facts.push({value:c.value,unit:c.display_unit||'',period:c.period||'',claim:c.claim||c.locator,binding:{company:c.company,metric:c.metric||c.role||'cell_value',line:c.line||c.locator,period:c.period||'',currency:c.currency||'',unit:c.display_unit||''},citation:c,source:name.startsWith('pdf')?'pdf':'workbook'});
  } else if(name==='calc') {
    for(const result of rows(d.results)) if(result?.value!=null) facts.push({value:result.value,unit:result.unit||'',period:result.period||'',claim:result.name||'calc result',binding:{metric:result.name||`calc:${result.expression||call.id||turn}`,period:result.period||'',unit:result.unit||'',currency:result.currency||''},source:'calc'});
  } else if(['ratio','unit_convert'].includes(name)) {
    const result=d;
    if(result.value!=null) {
      const citation=rows(d.citations).find(c=>String(c?.value)===String(result.value)&&Array.isArray(c.derivedFrom)&&c.derivedFrom.length);
      const metric=result.name||(citation?`${name}:${[...citation.derivedFrom].sort().join(',')}`:`${name}:${call.id||turn}`);
      facts.push({value:result.value,unit:result.unit||'',period:result.period||'',claim:result.name||name,binding:{metric,period:result.period||'',unit:result.unit||'',currency:result.currency||''},source:'calc',...(citation?{citation}:{})});
    }
  } else if(name==='westock_query') {
    for(const q of rows(d.quotes)) if(q?.ticker && Number.isFinite(Number(q.price)) && q.currency && q.fetched_at) facts.push({value:q.price,unit:q.currency,claim:`${q.ticker} price`,binding:{company:q.ticker,metric:'share_price',line:q.ticker,period:'current',currency:q.currency,unit:q.currency},source:'westock',fetchedAt:q.fetched_at});

  }
  const written=[];
  for(const fact of facts) { const item=await registerFact(root,sessionId,{...fact,createdAt:new Date().toISOString(),turn}); if(item) written.push(item); }
  return written;
}
export async function markStaleVersions(root,sessionId,currentVersions={}) {
  return updateLedger(root,sessionId,l=>{let count=0; for(const f of rows(l.facts)) { const c=f.citation; if(c?.materialId && currentVersions[c.materialId]!=null && Number(currentVersions[c.materialId])!==Number(c.version) && f.status==='current') {f.status='stale_source';count++;} } return count; });
}
export async function readCurrentFacts(root,sessionId) { const ledger=await readLedger(root,sessionId); return currentItems(ledger); }
export { bindingEqual };
