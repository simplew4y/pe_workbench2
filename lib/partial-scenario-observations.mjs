import {collectCitationsFromToolCalls,currentCitation,toolEvidenceState} from './citations.mjs';

const close=(a,b)=>Number.isFinite(a) && Number.isFinite(b) &&
  Math.abs(a-b)<=8*Number.EPSILON*Math.max(Math.abs(a),Math.abs(b),Number.MIN_VALUE);
const show=n=>Number(n.toPrecision(9));
const excelError=/^#(?:NAME\?|N\/A|REF!|VALUE!|DIV\/0!|NUM!|NULL!)$/;

// A partial archived recalculation describes only the outputs actually returned.
// Link its baseline to an independent source read. Never turn an intermediate
// change or an error-valued target into a price or into a successful full run.
export function partialScenarioObservations(calls,versions) {
  const observations=[];
  for(const call of calls){
    const d=call.result?.details || call.details,a=call.args;
    if(call.name!=='model_whatif' || toolEvidenceState(call)!=='success' || d?.recalculated!==true ||
      !a?.path || d.path!==a.path || !Array.isArray(a.targets) || !Array.isArray(d.results) ||
      !Array.isArray(a.inputs) || !a.inputs.length || a.inputs.length!==d.inputs?.length ||
      d.inputs.some((x,i)=>x.cell!==a.inputs[i].cell || !Number.isFinite(x.value) || x.value!==a.inputs[i].value))continue;
    // Fully attested runs are handled by workbookScenarioDelivery.
    if(d.sourceSha256 && Array.isArray(d.baselineChanged) && !d.baselineChanged.length)continue;
    if(calls.some(c=>c.args?.path===d.path && /(?:write|edit|patch|replace)/i.test(c.name)))continue;
    const reads=calls.filter(c=>['workbook_query','workbook_trace'].includes(c.name) && c.args?.path===d.path && toolEvidenceState(c)==='success');
    const pool=collectCitationsFromToolCalls(reads).filter(c=>!c.derivedFrom && c.version && currentCitation(c,versions) &&
      /^[a-f0-9]{64}$/i.test(c.sha256) && c.storedFilename===d.path.split('/').at(-1));
    if(new Set(pool.map(c=>[c.materialId,c.version,c.sha256].join('/'))).size!==1 || (d.sourceSha256 && pool[0]?.sha256!==d.sourceSha256))continue;
    const source=cell=>{
      const matches=pool.filter(c=>c.locator===cell);
      return matches.length && matches.every(c=>c.value===matches[0].value) ? matches[0] : undefined;
    };
    const inputs=d.inputs.map(x=>source(x.cell));
    if(inputs.some(c=>!c || !Number.isFinite(c.value)))continue;
    const rows=[];
    for(const r of d.results){
      const c=source(r.cell);
      if(!c || !a.targets.includes(r.cell) || !close(c.value,r.before) ||
         (d.cached && !close(d.cached[r.cell],r.before)) ||
         !(Number.isFinite(r.after) || excelError.test(String(r.after))))continue;
      if(Number.isFinite(r.after) && close(r.before,r.after))continue;
      rows.push({c,r});
    }
    const numeric=rows.filter(({r})=>Number.isFinite(r.after));
    const year=c=>/^(\d{4})E?$/.exec(c.period || '')?.[1];
    const inputYears=inputs.map(year).filter(Boolean).sort();
    const end=inputYears.at(-1);
    const last=numeric.find(({c})=>end && year(c)===end && c.metric===numeric[0].c.metric && c.locator!==numeric[0].c.locator);
    const selected=[...new Set([numeric[0],last || numeric[1]].filter(Boolean)),...rows.filter(({r})=>typeof r.after==='string').slice(0,1)];
    if(!selected.length)continue;
    const title='《'+inputs[0].filename+'》';
    const groups=new Map();
    for(const [i,x] of d.inputs.entries()){
      const c=inputs[i],parts=(c.excerpt || '').split('|').map(s=>s.trim());
      // Readers include row headers immediately before the observed value.
      // A repeated ratio label needs its neighbouring metric to distinguish drivers.
      const parent=parts.at(-4),metric=parts.at(-3);
      const label=metric===c.metric && /(?:yoy|growth|增速|同比)/i.test(metric) && parent && parent.length<70 ? parent+' '+metric : c.metric || '输入';
      if(!groups.has(label))groups.set(label,[]);
      groups.get(label).push(x.cell+' '+show(c.value)+'→'+show(x.value));
    }
    const shocks=[...groups].map(([metric,cells])=>metric+'（'+cells.join('，')+'）').join('，');
    const scale=c=>{
      const terms=(c.excerpt || '').split('|');
      if(!/^(?:rmb|cny|usd|hkd|eur|gbp)$/i.test(c.raw_unit || ''))return '';
      const unit=new RegExp('\\b'+c.raw_unit+'\\$?\\s*(?:mn|mm|bn|millions?|billions?)\\b','i');
      return terms.slice(0,5).join('|').match(unit)?.[0] || '';
    };
    const values=selected.map(({c,r})=>[c.period,c.metric].filter(Boolean).join(' ')+'（'+c.locator+'）'+
      (typeof r.after==='string'?'返回 '+r.after+'，该项没有重算数值':show(r.before)+'→'+show(r.after)+(scale(c)?' '+scale(c):'')+(r.before>0?'（'+show((r.after/r.before-1)*100)+'%）':''))).join('；');
    observations.push({id:call.id,text:title+' 输入 '+shocks+'。同次运行的输出为 '+values+'。',citations:[...inputs,...selected.map(x=>x.c)]});
  }
  if(!observations.length)return null;
  return {text:'**部分重算回执（按原表数值列示）**\n\n'+observations.map(o=>'- '+o.text).join('\n')+
    '\n\n这里列示的是与同路径工作簿读数核对过基准值的输出。旧回执缺少完整的文件或基线验证，只能追溯该次运行。',ids:observations.map(o=>o.id),citations:observations.flatMap(o=>o.citations)};
}
