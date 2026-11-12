/** Numeric publication gate. The draft never supplies its own verification status.
 * All numeric state leaves/tokens must bind exact fact versions. Numeric report
 * values are rendered by the host from {{fact:/json/pointer}} placeholders.
 */
import {normalizeValue,norm,periodKey,sameIdentity} from './value.mjs';
import {formatDecimal,convertExact} from '../calc-tool.mjs';
const excludedKeys=new Set(['id','schema_version','framework_id','revision','parent_revision','schema_memory_version','security','ticker','model_file','model_fingerprint','locator','path','url','published_at','accessed_at','as_of','model_as_of','valuation_date','market_price_date','price_date','fetched_at','last_checked_at','last_run_at','data_cutoff','actuals_through','forecast_start','period','multiple_period','source_ids','evidence_ids','assumption_ids','thesis_ids','support_ids','counter_ids','affects','superseded_by','last_run_id','triggered_falsifier_ids','numeric_bindings','fact_refs','numeric_coverage']);
const identityKeys=['entity','metric','period','scope','basis_type','scenario','currency'];
const metricAliases=new Map([['revenue','revenue'],['收入','revenue'],['营业收入','revenue'],['营收','revenue'],['ebitda','ebitda'],['息税折旧摊销前利润','ebitda'],['assets','assets'],['总资产','assets'],['资产','assets'],['enterprise_value','enterprise_value'],['企业价值','enterprise_value'],['equity_value','equity_value'],['股权价值','equity_value'],['net_debt','net_debt'],['净债务','net_debt'],['净负债','net_debt'],['target_price','target_price'],['目标价','target_price']]);
const metricKey=v=>metricAliases.get(norm(v)) || norm(v);
const pointerToken=v=>String(v).replaceAll('~','~0').replaceAll('/','~1');
const escapes = /[\u0000-\u001f]/;
export function numericTokens(text) {
  const out=[];const input=String(text);
  for(const match of input.matchAll(/[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?/g)) {
    const start=match.index,end=start+match[0].length,before=input.slice(Math.max(0,start-12),start),after=input.slice(end,end+15);
    if([...input.matchAll(/\b20\d{2}[-/](?:0?[1-9]|1[0-2])[-/](?:0?[1-9]|[12]\d|3[01])\b/g)].some(d=>start>=d.index && end<=d.index+d[0].length)) continue;
    // Explicit identifiers/dates/periods and Markdown list ordinals are metadata,
    // not financial values. Bare four-digit amounts are NOT assumed to be years.
    if(/(?:^|[^A-Za-z0-9_])(?:SRC|CHK|MON|[ATVSEFGC])$/.test(before) && /^\d+$/.test(match[0]) && !/^[A-Za-z0-9.%亿元万千倍]/.test(after)) continue;
    if([...input.matchAll(/https?:\/\/[^\s)]+/g)].some(url=>start>=url.index && end<=url.index+url[0].length)) continue;
    if(/^20\d{2}$/.test(match[0]) && /^(?:年|[EA]\b|Q[1-4]\b|H[12]\b|[-/]\d{1,2}[-/]\d{1,2})/.test(after)) continue;
    if(/(?:20\d{2}[-/]\d{1,2}[-/]|20\d{2}[-/])$/.test(before) && /^\d{1,2}$/.test(match[0])) continue;
    const lineStart=input.lastIndexOf('\n',start)+1;
    if(/^\s*$/.test(input.slice(lineStart,start)) && /^\d+$/.test(match[0]) && /^[.)、]\s/.test(after)) continue;
    out.push({start,end,raw:match[0]});
  }
  for(const match of input.matchAll(/\p{Nd}+/gu)) if(/[^0-9]/.test(match[0])) out.push({start:match.index,end:match.index+match[0].length,raw:match[0],non_ascii:true});
  return out.sort((a,b)=>a.start-b.start);
}
function isMetadata(key,value) {
  if(key==='numeric_bindings') return Array.isArray(value);
  if(key==='numeric_coverage') return value && typeof value==='object' && !Array.isArray(value);
  if(key==='fact_refs') return Array.isArray(value) && value.every(v=>v && typeof v.fact_id==='string' && Number.isInteger(v.fact_version));
  if(/_ids$/.test(key) || ['affects','highlights'].includes(key)) return Array.isArray(value) && value.every(v=>typeof v==='string' && /^[A-Za-z][A-Za-z0-9_.:@-]*$/.test(v));
  if(['revision','parent_revision','schema_memory_version'].includes(key))return value==null || Number.isInteger(value);
  if(!excludedKeys.has(key))return false;
  if(value==null)return true;
  if(typeof value!=='string')return false;
  if(key==='url')return /^https?:\/\//.test(value);
  if(['path','locator','model_file'].includes(key))return value.length>0;
  if(/(?:_at|_date|_as_of)$/.test(key) || ['as_of','data_cutoff','actuals_through','forecast_start'].includes(key))return /^20\d{2}-\d{2}-\d{2}(?:[T ].*)?$/.test(value);
  return /^[A-Za-z0-9_.:@/-]*$/.test(value);
}
export function inventoryState(state) {
  const fields=[];
  function walk(value,pointer='',parent={},key='') {
    if(isMetadata(key,value)) return;
    if(typeof value==='number') fields.push({path:pointer,value,parent,key});
    else if(typeof value==='string' && /^\(?[+-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?\)?%?$/.test(value.trim())) fields.push({path:pointer,value,parent,key});
    else if(typeof value==='string') for(const token of numericTokens(value)) fields.push({path:pointer,start:token.start,end:token.end,value:token.raw,parent,key,text:value});
    else if(Array.isArray(value)) value.forEach((item,index)=>walk(item,`${pointer}/${index}`,value,String(index)));
    else if(value && typeof value==='object') for(const [name,item] of Object.entries(value)) walk(item,`${pointer}/${pointerToken(name)}`,value,name);
  }
  walk(state);return fields;
}
const bindingKey=b=>`${b.path}#${b.start==null?'leaf':`${b.start}:${b.end}`}`;
const safeText=v=>String(v).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])).replace(/([\[\]_*`])/g,'\\$1');
const factRef=f=>`${f.fact_id}@${f.fact_version}`;
function suppliedUnit(field,binding) {
  // For prose a visible unit must agree with the declared display unit. Numeric
  // leaves use their sibling unit; there is no implicit % versus fraction swap.
  if(!field.text) return field.parent?.unit || binding.unit;
  const unit=field.text.slice(field.end).match(/^\s*((?:USD|RMB|CNY|HKD)\b(?:\s*(?:mn|mm|million|billion|bn))?|亿元|万元|百万元|千元|元\/股|美元|港元|人民币|元|%|％|个百分点|倍|x\b|[$¥￥]|[A-Za-z]+)/i)?.[1];
  return unit || binding.unit;
}
export function auditFrameworkNumbers({memory,state,report='',bindings=state?.numeric_bindings || []}) {
  const fields=inventoryState(state),errors=[],accepted=[],refs=[];
  if(!Array.isArray(bindings)) return {ok:false,errors:[{code:'invalid_numeric_bindings'}],fields:[]};
  const byKey=new Map();
  for(const binding of bindings) {
    if(!binding || typeof binding.path!=='string' || !binding.path.startsWith('/') || escapes.test(binding.path)) {errors.push({code:'invalid_binding'});continue;}
    const key=bindingKey(binding);if(byKey.has(key))errors.push({code:'duplicate_binding',path:binding.path});else byKey.set(key,binding);
  }
  for(const field of fields) {
    const key=bindingKey(field),b=byKey.get(key);
    if(!b) {errors.push({code:'unbound_state_number',path:field.path,start:field.start,end:field.end,value:field.value});continue;}
    byKey.delete(key);
    const f=memory.get(b.fact_id,b.fact_version);
    if(!f) {errors.push({code:'fact_unavailable',path:field.path});continue;}
    if(!['verified','needs_review','assumption','historical'].includes(b.role)) {errors.push({code:'binding_role_required',path:field.path});continue;}
    const expected=b.identity || {};
    const identityMatches=identityKeys.every(k=>k==='period'?periodKey(expected[k])===periodKey(f[k]):k==='metric'?metricKey(expected[k])===metricKey(f[k]):norm(expected[k])===norm(f[k]));
    if(!identityMatches || identityKeys.some(k=>!Object.hasOwn(expected,k)) || (b.role==='verified' && (!expected.entity || !expected.metric || !expected.period || !expected.scope || !['actual','forecast','assumption'].includes(expected.basis_type)))) {errors.push({code:'binding_identity_mismatch',path:field.path});continue;}
    // Explicit business names in the state may not be relabelled by bindings.
    const declaredMetric=field.key==='value'?(field.parent.metric || field.parent.output):metricAliases.has(norm(field.key))?field.key:null;
    if(declaredMetric && metricKey(declaredMetric)!==metricKey(f.metric)) {errors.push({code:'state_metric_mismatch',path:field.path});continue;}
    if(state.subject?.company && f.entity && norm(state.subject.company)!==norm(f.entity)) {errors.push({code:'state_entity_mismatch',path:field.path});continue;}
    const declaredPeriod=field.parent.period || field.parent.multiple_period;
    if(declaredPeriod && periodKey(declaredPeriod)!==periodKey(f.period)) {errors.push({code:'state_period_mismatch',path:field.path});continue;}
    for(const name of ['scope','basis_type','scenario','currency']) if(field.parent[name]!=null && norm(field.parent[name])!==norm(f[name])) errors.push({code:`state_${name}_mismatch`,path:field.path});
    if(field.text) {
      const prefix=norm(field.text.slice(0,field.start));
      const currencyPrefix=field.text.slice(0,field.start).match(/(USD|CNY|RMB|HKD|\$|¥|￥)\s*$/i)?.[1];
      if(currencyPrefix && (!/^(USD|CNY|RMB|HKD)$/i.test(currencyPrefix) || currencyPrefix.toUpperCase().replace('RMB','CNY')!==f.currency))errors.push({code:'prose_currency_mismatch',path:field.path});
      const nearby=[...metricAliases.keys(),norm(f.metric)].map(label=>({label,at:prefix.lastIndexOf(label)})).filter(x=>x.at>=0).sort((a,b)=>b.at-a.at)[0];
      if(!nearby || metricKey(nearby.label)!==metricKey(f.metric)) errors.push({code:'prose_metric_mismatch',path:field.path});
      const entityNames=[...new Set(memory.allFacts().map(x=>x.entity).filter(Boolean))];
      if(entityNames.some(name=>norm(field.text).includes(norm(name)) && norm(name)!==norm(f.entity)))errors.push({code:'prose_entity_mismatch',path:field.path});
      const years=[...field.text.matchAll(/(20\d{2})(?:年|[EA]\b)/g)].map(m=>m[1]);
      if(years.some(year=>!periodKey(f.period).startsWith(year)))errors.push({code:'prose_period_mismatch',path:field.path});
      if((/\bforecast\b|预测/i.test(field.text) && f.basis_type!=='forecast') || (/\bactual\b|实际/i.test(field.text) && f.basis_type!=='actual'))errors.push({code:'prose_basis_mismatch',path:field.path});
    }
    const value=normalizeValue(field.value,suppliedUnit(field,b),expected.currency || '');
    const numericMatches=!value.reason && value.canonical_value===f.canonical_value && value.canonical_unit===f.canonical_unit && value.currency===f.currency;
    // Unknown units may only be carried literally as explicitly unverified data.
    const literalReview=b.role==='needs_review' && String(field.value)===String(f.raw_value) && norm(suppliedUnit(field,b))===norm(f.raw_unit);
    if(!numericMatches && !literalReview) {errors.push({code:'binding_value_or_unit_mismatch',path:field.path});continue;}
    if(b.role==='historical') {
      if(!b.reason || !['superseded','stale'].includes(f.lifecycle)) errors.push({code:'historical_binding_requires_reason',path:field.path});
    } else if(f.lifecycle!=='current') errors.push({code:'stale_binding',path:field.path});
    if(b.role==='verified') {
      if(f.quality!=='source_checked') errors.push({code:'unverified_binding',path:field.path});
      const peers=memory.allFacts().filter(p=>p.lifecycle==='current' && sameIdentity(p,f));
      if(!peers.length || peers.some(p=>p.canonical_value!==f.canonical_value)) errors.push({code:'conflicting_or_unavailable_binding',path:field.path});
    }
    if(b.role==='assumption' && f.basis_type!=='assumption') errors.push({code:'assumption_identity_required',path:field.path});
    if(['needs_review','assumption'].includes(b.role) && !b.reason)errors.push({code:'review_binding_requires_reason',path:field.path});
    accepted.push({key,binding:b,fact:f,field});
    refs.push({fact_id:f.fact_id,fact_version:f.fact_version,role:b.role,reason:b.reason || '',path:field.path});
  }
  for(const b of byKey.values()) errors.push({code:'binding_target_not_numeric',path:b.path});
  // Render references from validated bindings only. Templates include full meaning
  // and provenance, so a number cannot silently inherit a different row's label.
  const template=/\{\{fact:([^{}]+)\}\}/g;
  let rendered=String(report).replace(template,(_match,key)=>{
    const item=accepted.find(a=>a.key===key || (a.field.start==null && a.binding.path===key));
    if(!item) {errors.push({code:'unknown_report_binding',path:key});return '';}
    const {fact:f,binding:b,field}=item;
    const unit=suppliedUnit(field,b);
    let display=String(field.value);
    if(!field.text && normalizeValue(display,unit,f.currency).reason==null) {
      try {display=formatDecimal(convertExact(f.canonical_value,f.canonical_unit,unit));}catch{/* exact literal already checked */}
    }
    const label=b.role==='historical'?'历史':b.role==='needs_review'?'待核':b.role==='assumption'?'假设':f.basis_type==='forecast'?'预测':'已核取数';
    return `${safeText(f.entity || '未知主体')} / ${safeText(f.metric || '未知指标')} / ${safeText(f.period || '未知期间')} / ${safeText(f.scope || '未知口径')}${f.scenario?` / ${safeText(f.scenario)}`:''}：${safeText(display)} ${safeText(unit)}${f.currency?` [${safeText(f.currency)}]`:''}（${label}，${factRef(f)}）`;
  });
  const residual=String(report).replace(template,' '.repeat(1));
  for(const token of numericTokens(residual)) errors.push({code:'unbound_report_number',start:token.start,end:token.end,value:token.raw});
  if(/\{\{fact:/.test(rendered))errors.push({code:'malformed_report_binding'});
  const uniqueRefs=[...new Map(refs.map(r=>[`${factRef(r)}:${r.role}`,r])).values()];
  return {ok:errors.length===0,errors,fields:fields.map(({parent,text,...f})=>f),bindings:accepted.map(a=>a.binding),fact_refs:uniqueRefs,rendered_report:rendered,
    coverage:{mode:'bound_fields_and_report_tokens',numeric_fields:fields.length,bound_fields:accepted.length,unbound_numbers:errors.filter(e=>e.code.startsWith('unbound')).length,excluded_metadata_keys:[...excludedKeys],scope:'numeric state values/prose tokens and numeric report templates; narrative conclusions not semantically proven'}};
}
