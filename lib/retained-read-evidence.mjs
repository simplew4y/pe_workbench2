import {archivedReadEvidence} from './archived-read-evidence.mjs';
import {collectCitationsFromToolCalls,currentCitation,toolEvidenceState,adoptedCitations} from './citations.mjs';
import {calculate} from './calc-tool.mjs';
import {researchStatementSpans} from './research-text-boundaries.mjs';
import {visibleAnswerChars} from './answer-length.mjs';

const plain=s=>String(s || '').replace(/[*\x60#]/g,'').replace(/\s+/g,' ').trim();
const inline=s=>String(s ?? '').replace(/[\r\n]+/g,' ').replace(/([\\\x60*_[\]<>|])/g,'\\$1');
const ref=c=>c.role==='page'?c.filename+' p.'+c.locator.slice(2):'['+c.filename+']'+c.locator;
const rounded=n=>Number(n.toPrecision(9)).toString();
const words=s=>new Set((String(s).toLowerCase().match(/[a-z]{2,}|[\d,.]+(?:%|亿|万)?|[\u3400-\u9fff]{2,}/g)||[]).flatMap(w=>
  /^[\u3400-\u9fff]/.test(w)?Array.from(w.slice(1),(_,i)=>w.slice(i,i+2)):[w]));
function pageExcerpt(c,context) {
  const lines=c.excerpt.split(/\n/).map(s=>s.trim()).filter(Boolean);
  const needle=words(context.replace(/(?:source|page)%3A[\w-]+/gi,''));
  let best=null;
  // Quote a contiguous source window. Never splice sentences across pages.
  for(let i=0;i<lines.length;i++){
    let window='';
    for(const line of lines.slice(i,i+4)){
      if(window.length+line.length>145)break;
      window+=(window?' ':'')+line;
      if(window.length<10)continue;
      const hit=[...words(window)].filter(w=>needle.has(w));
      if(hit.length<3)continue;
      const numbers=window.match(/\d+(?:\.\d+)?/g) || [];
      const bothValues=new Set(numbers.filter(n=>context.includes(n))).size>=2;
      const standalone=i===0 && window===lines[0] && /[：:]/.test(window);
      const score=hit.length/Math.sqrt(window.length)+(bothValues && standalone ? 3 : 0);
      if(!best || score>best.score)best={score,window};
    }
  }
  return best?.window;
}

function verifiedDifference(quote,answer,question) {
  if(!/差异|差额|相差|差多少/.test(question))return '';
  // An absolute difference between two named source amounts, never a model
  // impact. Both operands and the reported difference must appear in the
  // draft; no inference about the arithmetic sign of an expense is needed.
  const quantities=s=>[...s.matchAll(/(?<![\d.,])([+-]?\d[\d,]*(?:\.\d+)?)\s*(亿元|万元|百万元|亿美元|亿港元)/g)]
    .map(m=>({n:Number(m[1].replaceAll(',','')),unit:m[2]}));
  const terms=quantities(quote),claims=quantities(answer);
  if(terms.length!==2 || terms[0].unit!==terms[1].unit || !terms.every(t=>claims.some(c=>c.n===t.n && c.unit===t.unit)))return '';
  const [low,high]=terms.map(t=>t.n).sort((a,b)=>a-b),unit=terms[0].unit;
  const diff=Number((high-low).toPrecision(12));
  if(!new RegExp('(?:差异|差额|相差)[约为是：:\\s*]*'+String(diff).replace('.','\\.')+'\\s*'+unit).test(answer))return '';
  return (diff?'两数不一致，差额 ':'两数一致，差额 ')+high+'−'+low+'＝'+diff+unit+'。';
}

export function supportedCells(citations) {
  const ids=new Map(),ambiguous=new Set();
  for(const c of citations){
    const key=[c.materialId,c.version,c.locator].join('\n');
    const prev=ids.get(key);
    if(prev && (prev.value!==c.value || prev.formula!==c.formula || prev.sha256!==c.sha256 || (c.role==='page' && prev.excerpt!==c.excerpt)))ambiguous.add(key);
    else ids.set(key,c);
  }
  return [...ids].filter(([key])=>!ambiguous.has(key)).map(([,c])=>c);
}
function describe(c,index,compact,quotedComment) {
  const unit=c.raw_unit && !['unit_unknown','decimal','unknown'].includes(c.raw_unit)?c.raw_unit:'';
  const percent=c.raw_unit==='decimal' && c.display_unit==='%';
  const value=percent?rounded(c.value*100)+'%':rounded(c.value)+(unit?' '+unit:'');
  let period=c.period;
  if(!period && c.id.startsWith('source:')){
    const [sheet,coord]=c.locator.split('!'),header=coord?.replace(/\d+$/,'1');
    const year=index.find(other=>other.materialId===c.materialId && other.version===c.version && other.locator===sheet+'!'+header);
    if(year && /^20\d{2}E?$/.test(String(year.value)))period=year.value;
  }
  let metric=c.metric;
  if(/^(?:%\s*)?(?:yoy|y\/y|yoy growth|growth|margin|同比|同比增长|增长率|占比)(?:\s*%)?$/i.test((metric || '').trim())){
    const parts=(c.excerpt || '').split('|').map(s=>s.trim());
    // Only display a free-standing rate if the read names its subject.
    // A column label, period or neighbouring number cannot supply it.
    const parent=parts.at(-4);
    if(parts.at(-3)?.trim()!==metric.trim() || !parent || !/[\p{L}]{2}/u.test(parent) ||
       parent.length>75 || /^(?:yoy|y\/y|growth|margin|\d|\W*$)/i.test(parent))return '';
    metric=parent+' '+metric;
  }
  let text=[period,metric].filter(Boolean).map(inline).join(' ');
  text+=(text?' ':'')+value+'（'+(compact && index.filter(x=>x.locator===c.locator).length===1?c.locator:ref(c))+'）';
  if(c.formula && c.formula.length<=80 && !/[\r\n\x60]/.test(c.formula))text+='，原式 \x60'+c.formula+'\x60';
  else if(c.role==='input')text+='，原表输入值';
  if(c.id.startsWith('source:') && c.excerpt && !(compact && quotedComment))text+='，表内批注“'+inline(c.excerpt.replace(/^[^:\n]{1,40}:\s*\n/,'').slice(0,150))+'”';
  return text+'。';
}

function boundCell(binding, index) {
  const c=binding && index.get(binding.id);
  return c && c.sha256 && c.sha256===binding.sha256 && c.value===binding.value && Number.isFinite(c.value)?c:null;
}

// When an argument quotes an entire time series, bind it to one calculation
// batch. Indexing the observed ratio cancels the common source units and avoids
// attributing a currency scale or product mix that its cells do not establish.
function ratioSeries(block,batches,index) {
  const statements=researchStatementSpans(block);
  const pieces=[];
  for(const batch of batches){
    const groups=new Map();
    for(const r of batch){
      const m=/^\s*(\w+)\s*\/\s*(\w+)\s*$/.exec(r.expression);
      if(!m || r.provenance!=='bound_inputs' || !r.unit || !/^\d+\.\d{1,9}$/.test(String(r.value)))continue;
      const [a,b]=m.slice(1).map(k=>boundCell(r.bindings?.[k],index));
      if(!a || !b || !a.metric || !b.metric || !a.period || a.period!==b.period || !/^20\d\dE?$/.test(a.period) ||
         a.sha256!==b.sha256 || a.materialId!==b.materialId || a.version!==b.version || b.value<=0 || a.value<=0)continue;
      const ratio=a.value/b.value;
      if(!Number.isFinite(ratio) || Number(calculate({expression:a.value+'/'+b.value,precision:String(r.value).split('.')[1].length}).value)!==Number(r.value))continue;
      const key=JSON.stringify([a.materialId,a.sha256,r.unit,...[a,b].flatMap(c=>[c.metric,c.raw_unit,c.currency,c.locator.replace(/![A-Z]+(\d+)$/,'!$1')])]);
      if(!groups.has(key))groups.set(key,[]);
      groups.get(key).push({a,b,value:r.value,unit:r.unit,ratio,name:r.name});
    }
    for(const group of groups.values())for(const statement of statements){
      const series=group.filter(x=>statement.includes(String(x.value))).sort((x,y)=>x.a.period.localeCompare(y.a.period));
      if(series.length<2 || series.length>8 || new Set(series.map(x=>String(x.value))).size!==series.length)continue;
      const first=series[0],last=series.at(-1);
      const subject=String(first.name || '').replace(/^20\d\dE?年?\s*/,'').replace(/\s*[(（][^()（）]*[)）]\s*$/,'').trim();
      if(!subject || !statement.replace(/\s/g,'').toLowerCase().includes(subject.replace(/\s/g,'').toLowerCase()))continue;
      if(!statement.includes(first.unit) || !statement.includes(first.a.period.slice(0,4)) || !statement.includes(last.a.period.slice(0,4)) ||
         !series.every((x,i)=>!i || parseInt(x.a.period)===parseInt(series[i-1].a.period)+1))continue;
      // Require the ordered sequence itself. A year and two coincidentally
      // matching figures in unrelated clauses are insufficient.
      const values=series.map(x=>String(x.value).replace('.','\\.')).join('\\s*[、，,]\\s*');
      if(!new RegExp('(?<![\\d.])'+values+'(?![\\d.])').test(statement))continue;
      const inputs=series.flatMap(x=>[x.a,x.b]);
      const seriesText=series.map(x=>x.a.period+' 为 '+Number((100*x.ratio/first.ratio).toFixed(1))+'（'+ref(x.a)+'、'+ref(x.b)+'）').join('，');
      pieces.push({c:first.a,inputs,text:inline(first.a.metric)+' ÷ '+inline(first.b.metric)+'，按 '+first.a.period+' = 100 比较各年表内数值：'+seriesText+'。'});
    }
  }
  return pieces;
}

// A derived ratio can be reconstructed even when the prose attached the
// result to an input as if it were a raw cell. Bind both sides, including
// period and units, and describe the actual division instead of inheriting
// an interpretation from the draft or the calculation's free-text name.
function ratiosInBlock(block, anchors, results,index) {
  const rows=[];
  for(const r of results) {
    if(r.provenance!=='bound_inputs' || !/^-?\d+(\.\d+)?$/.test(String(r.value)))continue;
    const m=r.unit==='%' && /^\s*(\w+)\s*\/\s*(\w+)\s*\*\s*100\s*$/.exec(r.expression);
    const change=r.unit==='倍' && /^\((\w+)\/(\w+)\)\/\((\w+)\/(\w+)\)$/.exec(r.expression.replace(/\s/g,''));
    if(!m && !change)continue;
    const bindings=(m || change).slice(1).map(k=>{
      const source=r.bindings?.[k];
      return boundCell(source,index);
    });
    const [a,b,pa,pb]=bindings;
    if(bindings.some(c=>!c || !c.metric || !c.period || !Number.isFinite(c.value) ||
        c.materialId!==a.materialId || c.version!==a.version || c.sha256!==a.sha256) ||
        a.period!==b.period || a.metric===b.metric || !b.value)continue;
    const anchored=c=>anchors.some(x=>x.id===c.id);
    const precision=String(r.value).split('.')[1]?.length || 0;
    if(precision>10)continue;
    let expr,result,text;
    if(m) {
      if(!anchored(a) || !anchored(b) || !a.raw_unit || /unknown|decimal|%/i.test(a.raw_unit) ||
         a.raw_unit!==b.raw_unit || (a.currency || '')!==(b.currency || ''))continue;
      expr='('+a.value+')/('+b.value+')*100';result=Number(r.value);
      text=inline(a.period)+' '+inline(a.metric)+' '+ref(a)+' ÷ '+inline(b.metric)+' '+ref(b)+' = '+r.value+'%。';
    }else{
      // The draft may have cited adjacent volume cells incorrectly. Use the
      // recorded denominator only when both periods identify the same row and
      // a stable unit, and both numerators are actually cited in this argument.
      const sameRow=(x,y)=>x.metric===y.metric && x.raw_unit===y.raw_unit && x.currency===y.currency &&
        x.locator.replace(/![A-Z]+(\d+)$/,'!$1')===y.locator.replace(/![A-Z]+(\d+)$/,'!$1') &&
        ((x.raw_unit && !/unknown/i.test(x.raw_unit)) || /\([^()]*\b(?:mn|million|Gb|kg|units?)\b[^()]*\)/i.test(x.metric));
      if(!anchored(a) || !anchored(pa) || pa.period!==pb.period || a.period===pa.period ||
         !sameRow(a,pa) || !sameRow(b,pb) || !pa.value || !pb.value)continue;
      expr='(('+a.value+')/('+b.value+'))/(('+pa.value+')/('+pb.value+'))';
      result=Number(((Number(r.value)-1)*100).toFixed(Math.max(0,precision-2)));
      text=inline(a.metric)+' ÷ '+inline(b.metric)+'，'+inline(a.period)+'（'+ref(a)+'、'+ref(b)+'）是 '+
        inline(pa.period)+'（'+ref(pa)+'、'+ref(pb)+'）的 '+r.value+' 倍（'+(result>=0?'+':'')+result+'%）。';
    }
    if(![...block.matchAll(/([-+]?\d+(?:\.\d+)?)\s*[%％]/g)].some(x=>Number(x[1])===result))continue;
    if(Number(calculate({expression:expr,precision}).value)!==Number(r.value))continue;
    rows.push({c:a,inputs:bindings,text});
  }
  return rows;
}

// A displayed ratio can be witnessed by a workbook formula or a bound
// calculation. Recover the business meaning from the actual rows and headers.
function valuationRatios(block,anchors,results,index,reads) {
  const rows=[];
  const rates=[...block.matchAll(/(\d+(?:\.\d+)?)\s*%/g)].map(m=>m[1]);
  if(!rates.length)return rows;
  for(const result of results){
    if(result.unit!=='%' || result.provenance!=='bound_inputs' || result.ratioEncoding!=='percentage_points')continue;
    const m=/^\((\w+)\/(\w+)\)\*100$/.exec(result.expression?.replace(/\s/g,''));
    if(!m)continue;
    const [a,b]=m.slice(1).map(key=>boundCell(result.bindings?.[key],index));
    if(!a || !b || a.materialId!==b.materialId || a.version!==b.version || !b.value || a.sha256!==b.sha256)continue;
    const ratio=100*a.value/b.value, rate=rates.find(x=>ratio.toFixed(x.split('.')[1]?.length || 0)===x);
    if(!rate || Math.abs(ratio-Number(result.value))>1e-8)continue;
    const sheet=a.locator.split('!')[0];
    if(!b.locator.startsWith(sheet+'!'))continue;
    const currencyHeader=c=>(c.excerpt || '').split('|').map(x=>x.trim().toLowerCase()).filter(x=>
      /^\(?(?:rmb|cny|hkd|usd) (?:million|mn|billion|bn)\)?$/.test(x)).at(0);
    const header=currencyHeader(a);
    if(!header || header!==currencyHeader(b))continue;
    const seen=c=>anchors.some(x=>x.id===c.id);
    if(seen(a) && seen(b) && /^(profit after tax|net income|税后利润|净利润)$/i.test(a.metric) &&
        /^(total revenue|revenue|营业收入)$/i.test(b.metric) && a.period && a.period===b.period && /净利率|净利润率/.test(block)){
      rows.push({c:a,inputs:[a,b],text:'模型 '+a.period+' 的税后利润 '+ref(a)+' 除以收入 '+ref(b)+'，净利率为 '+rate+'%。'});continue;
    }
    if(!/终值/.test(block) || !/discounted fcf|折现现金流/i.test(a.metric) || !/value of core operations|企业价值/i.test(b.metric))continue;
    const numerator=a.locator.split('!')[1], denominator=b.locator.split('!')[1],column=numerator.replace(/\d+$/,'');
    for(const read of reads){
      const d=read.result?.details || read.details;
      if(d?.materialId!==a.materialId || d.version!==a.version || d.sha256!==a.sha256)continue;
      const cells=d.cells || [];
      const witnesses=anchors.filter(c=>c.materialId===a.materialId && c.version===a.version && c.sha256===a.sha256 &&
        cells.some(x=>x.ref===c.locator && x.value===c.value && x.formula?.replace(/\$/g,'')==='='+numerator+'/'+denominator));
      const heading=cells.some(x=>x.sheet===sheet && x.ref.split('!')[1].replace(/\d+$/,'')===column &&
        x.row<Number(numerator.slice(column.length)) && /^(terminal value|终值)$/i.test(String(x.value).trim()));
      if(witnesses.length!==1 || !heading)continue;
      const w=witnesses[0];
      rows.push({c:w,inputs:[w,a,b],text:'终值现值 '+ref(a)+' 占核心经营价值 '+ref(b)+' 的 '+rate+'% '+ref(w)+'。'+(ratio>50?'模型的大部分经营价值来自显式预测期之后。':'')});break;
    }
  }
  return rows;
}

// Read the row name, measure band and year band from returned cells in the
// same sheet. A nearby shipment count like 1940 is not a year header.
function volumeSeries(anchors,reads) {
  const rows=new Map();
  for(const c of anchors){
    const m=/^(.+)!([A-Z]+)(\d+)$/.exec(c.locator);
    if(!m || !Number.isFinite(c.value))continue;
    const k=JSON.stringify([c.materialId,c.version,c.sha256,m[1],m[3]]);
    if(!rows.has(k))rows.set(k,[]);
    rows.get(k).push({c,sheet:m[1],col:m[2],row:Number(m[3])});
  }
  const out=[];
  for(const group of rows.values()){
    if(group.length<2)continue;
    const {c,sheet,row}=group[0];
    const receipt=reads.map(r=>r.result?.details || r.details).find(d=>
      d?.sha256===c.sha256 && d.materialId===c.materialId && d.version===c.version &&
      group.every(x=>d.cells?.some(cell=>cell.ref===x.c.locator && cell.value===x.c.value)) &&
      d.cells.some(cell=>cell.ref===sheet+'!A'+row && typeof cell.value==='string'));
    if(!receipt)continue;
    const values=new Map(receipt.cells.map(cell=>[cell.ref,cell.value]));
    const get=(col,r)=>values.get(sheet+'!'+col+r);
    const label=get('A',row);
    let factor;
    for(let r=row-1;r>=Math.max(1,row-12);r--){
      const heading=get('A',r);
      if(typeof heading!=='string' || !heading.trim())break;
      const unit=heading.match(/(?:volume|shipments?|出货量|销量)\s*[(（]\s*(['’]000|thousand|mn|million)\s*(?:units?|件|台|套)\s*[)）]/i);
      if(unit){factor=/million|mn/i.test(unit[1])?1e6:1e3;break;}
      if(/[(（]|price|\bASP\b|成本|收入|费用|总计/i.test(heading))break;
    }
    if(!factor)continue;
    for(let r=row-1;r>0 && r>=row-60;r--){
      const years=group.map(x=>Number(get(x.col,r)));
      if(!years.every((y,i)=>Number.isInteger(y) && y>=1900 && y<=2100 &&
        (i===0 || y>years[i-1])))continue;
      // The two dates must also be part of a calendar sequence in adjacent columns.
      const rowCells=receipt.cells.filter(x=>x.sheet===sheet && x.row===r).sort((a,b)=>a.col-b.col);
      if(!years.every(y=>rowCells.some((x,i)=>x.value===y && [rowCells[i-1],rowCells[i+1]].some(n=>
        n && Math.abs(x.col-n.col)===1 && n.value-x.value===n.col-x.col))))continue;
      const terms=group.map((x,i)=>years[i]+' 年 '+Number((x.c.value*factor/10000).toFixed(3))+' 万件 '+ref(x.c));
      out.push({c,inputs:group.map(x=>x.c),text:inline(label)+' 的模型出货量为 '+terms.join('、')+'。'});break;
    }
  }
  return out;
}

// Restore an actual/forecast comparison only when the dated market receipt
// and the workbook independently match the two rates quoted in the draft.
function actualMarginComparison(block,context,calls,index) {
  const clean=plain(block);
  const values=/实际毛利率\s*([0-9.]+)%[，,]\s*模型(?:为|毛利率为)\s*([0-9.]+)%/.exec(clean);
  if(!values)return;
  const matches=[];
  for(const call of calls) {
    const d=call.result?.details || call.details;
    if(call.name!=='westock_query' || !call.success || call.result?.isError || d?.truncated ||
        d?.args?.[0]!=='finance' || !/^(hk|sh|sz)\d+$/i.test(d.args[1]))continue;
    const symbol=d.args[1], code=symbol.slice(2).replace(/^0+/,'');
    const exchange=symbol.slice(0,2);
    const identity=new RegExp('(?:^|[^a-z0-9])(?:'+exchange+'0*'+code+'|0*'+code+'\\.'+exchange+')(?![a-z0-9])','i');
    const lines=(call.result?.content || []).map(p=>p.text || '').join('\n').split('\n');
    let fields=[];
    for(const line of lines){
      if(!line.startsWith('|')){fields=[];continue;}
      const row=line.slice(1).replace(/\|\s*$/,'').split('|').map(v=>v.trim());
      if(row.includes('EndDate')){fields=row;continue;}
      const date=row[fields.indexOf('EndDate')],actual=row[fields.indexOf('GrossIncomeRatio')];
      if(!/^\d{4}-12-31$/.test(date || '') || !actual || !context.includes(date.slice(0,4)) ||
          Number(actual).toFixed(values[1].split('.')[1]?.length || 0)!==values[1])continue;
      for(const c of index){
        if(!identity.test(c.filename || '') || !/^(gross margin|毛利率)$/i.test(c.metric) ||
            !new RegExp('^'+date.slice(0,4)+'[ea]?$','i').test(String(c.period)) ||
            !Number.isFinite(c.value) || c.raw_unit!=='decimal' || c.display_unit!=='%' ||
            (c.value*100).toFixed(values[2].split('.')[1]?.length || 0)!==values[2])continue;
        const gap=c.value*100-Number(actual);
        matches.push({c,inputs:[c],text:date.slice(0,4)+' 年实际毛利率为 '+values[1]+'%（WeStock 利润表，'+symbol+'，'+date+'，GrossIncomeRatio），模型毛利率为 '+values[2]+'% '+ref(c)+'。模型较实际'+(gap>=0?'高':'低')+' '+Math.abs(gap).toFixed(2)+' 个百分点。'});
      }
    }
  }
  const unique=new Map(matches.map(m=>[m.text,m]));
  if(unique.size===1)return [...unique.values()][0];
}

// Return observations from a successful current-version read, not the model's
// discarded sentence. An observed input can survive an unverified conclusion;
// neither its value nor a nearby citation authenticates that conclusion.
export function retainReadEvidence({answer,retained,findings,calls,versions={},limit=Infinity,question=''}) {
  const reads=calls.filter(c=>['workbook_query','workbook_trace','pe_excel_range','pe_pdf_read','pdf_read'].includes(c.name) && toolEvidenceState(c)==='success');
  if(!reads.length)return {text:retained,citations:[]};
  const items=reads.flatMap(call=>collectCitationsFromToolCalls([call],{includeArchived:true})).filter(c=>!c.derivedFrom && c.version && currentCitation(c,versions));
  items.push(...reads.filter(c=>c.name==='pe_pdf_read').flatMap(archivedReadEvidence).filter(c=>currentCitation(c,versions)));
  for(const call of reads.filter(c=>c.name==='pdf_read')){
    const d=call.result?.details || call.details;
    for(const e of d?.evidence || []){
      if(!d.filename || !e.materialId || !e.version || !e.sha256 || e.scanned || !e.text || !Number.isInteger(e.page))continue;
      const c={id:'page:'+e.materialId+':v'+e.version+':'+e.page,materialId:e.materialId,version:e.version,sha256:e.sha256,filename:d.filename,role:'page',locator:'p.'+e.page,excerpt:e.text.slice(0,10000),toolCallId:call.id};
      if(currentCitation(c,versions))items.push(c);
    }
  }
  const index=supportedCells(items),pages=index.filter(c=>c.role==='page');
  const accepted=adoptedCitations(retained,index);
  const citedCells=accepted.slice();
  const pageSources=pages.filter(p=>retained.includes('#pe-source?evidence_id='+encodeURIComponent(p.id)) || retained.includes(ref(p)));
  accepted.push(...pageSources);
  const delivered=new Set(accepted.map(c=>c.id)),added=[];
  const errors=findings.filter(f=>f.severity==='error' && f.rule!=='artifact_status');
  const paragraphs=answer.split(/\n\s*\n/);
  const batches=calls.filter(c=>c.name==='calc' && ['success','partial'].includes(toolEvidenceState(c)))
    .map(c=>(c.result?.details || c.details)?.results || []);
  const results=batches.flat();
  const ratioKeys=new Set(),byId=new Map(index.map(c=>[c.id,c]));
  for(const [i,block] of paragraphs.entries()){
    const comparison=actualMarginComparison(block,(paragraphs[i-1] || '')+' '+block,calls,index);
    if(comparison && !retained.includes(comparison.text)){
      added.push({...comparison,block:i});delivered.add(comparison.c.id);
    }
    const local=/^(?:引用|依据|出处|来源)[：:]/.test(plain(block)) ? (paragraphs[i-1] || '')+'\n'+block : block;
    if(plain(retained).includes(plain(block)) || !errors.some(f=>{
      const span=plain(f.sourceText || f.excerpt);
      return span && (plain(local).includes(span) || span.includes(plain(block)));
    }))continue;
    const anchors=adoptedCitations(block,index);
    // Archived Markdown explicitly identifies the cell/page independently of
    // its display label. A conflicting visible coordinate invalidates the link.
    for(const link of block.matchAll(/\[([^\]\n]+)\]\(#pe-source\?evidence_id=([^)]+)\)/g)){
      let id;try{id=decodeURIComponent(link[2]);}catch{continue;}
      const c=index.find(c=>c.id===id);
      if(!c)continue;
      const label=link[1].trim();
      if(c.role!=='page' && !(label===c.locator || label===c.filename+' '+c.locator))continue;
      if(c.role==='page' && !new RegExp('(?:p\\.?\\s*|第)'+c.locator.slice(2)+'(?:页|$)','i').test(label))continue;
      anchors.push(c);
    }
    for(const p of pages)if(block.includes(p.filename) && new RegExp('(?:p\\.?\\s*|第)'+p.locator.slice(2)+'(?:页|\\b)','i').test(block))anchors.push(p);
    for(const row of [...valuationRatios(block,anchors,results,byId,reads),...volumeSeries(anchors,reads),...ratioSeries(block,batches,byId),...ratiosInBlock(block,anchors,results,byId)]){
      const key=row.inputs.map(c=>c.id).join('|');
      if(ratioKeys.has(key) || (row.inputs.every(c=>delivered.has(c.id)) && retained.includes(row.text)))continue;
      ratioKeys.add(key);added.push({...row,block:i});
      for(const c of row.inputs)delivered.add(c.id);
    }
    for(const c of anchors){
      if(delivered.has(c.id) || !c.filename || /[\r\n\x60\[\]]/.test(c.filename))continue;
      let text;
      if(c.role==='page'){
        const quote=pageExcerpt(c,block+' '+(paragraphs[i-1] || ''));
        if(!quote)continue;
        const difference=verifiedDifference(quote,answer,question);
        const fragments=quote.split(/[；;。“”\n]|\b[a-zA-Z]+\b/u).map(s=>s.trim()).filter(s=>/\d\s*(?:亿元|万元|百万元|亿美元|亿港元)/.test(s));
        const excerpts=difference && fragments.length===2?fragments:[quote];
        text=difference+excerpts.map(s=>'“'+inline(s)+'”').join('、')+'（'+ref(c)+'）。';
      }else if(Number.isFinite(c.value))text=describe(c,index,limit<=500,pages.some(p=>c.excerpt && p.excerpt.includes(c.excerpt.split(/\s+/).slice(-2).join(' '))));
      if(!text)continue;
      delivered.add(c.id);added.push({c,text,block:i});
    }
  }
  if(!added.length)return {text:retained,citations:citedCells,pageSources};
  // First allocate one observation per affected argument and material, then
  // further observations from those arguments, within the user's reading budget.
  const groups=new Set();
  const ranked=added.map(x=>{
    const key=x.block+'|'+x.c.materialId;
    const first=!groups.has(key);groups.add(key);return {...x,first};
  }).sort((a,b)=>Number(b.first)-Number(a.first));
  const pieces=[],citations=[];
  const [body,...tail]=retained.split(/\n\n(?=\*\*仍待核实\*\*)/);
  const usable=body.trim().replace(/^> 未交付的部分：([^\n。]+)。[^\n]*$/gm,
    '> 原稿中未完整核验的部分：$1。以下列出可以逐项回查的依据。');
  const heading=/^(?:#{1,6} [^\n]+|\*\*[^*\n]{2,80}\*\*)$/;
  // Put evidence under its surviving argument. If the heading was removed,
  // do not recreate the discarded conclusion from an unverified draft.
  const headingFor=block=>{
    for(let i=block;i>=0;i--){
      const line=paragraphs[i].split('\n')[0].trim();
      if(heading.test(line))return line;
      const lead=line.match(/^\*\*[^*\n]{2,80}\*\*(?=\s)/);
      if(lead)return i===block?lead[0]:'';
    }
    return '';
  };
  const render=()=>{
    const sections=usable.split(/\n\n(?=(?:#{1,6} |\*\*))/);
    const rest=[];
    const attached=new Map();
    for(const p of pieces){
      const idx=p.heading && sections.findIndex(section=>section===p.heading || section.startsWith(p.heading+'\n') || section.startsWith(p.heading+' ') || (p.heading.startsWith('**') && section.startsWith(p.heading)));
      if(Number.isInteger(idx) && idx>=0){
        const chunks=sections[idx].split(/\n\s*\n/);
        const pos=chunks.findLastIndex(chunk=>plain(chunk) && plain(paragraphs[p.block]).includes(plain(chunk)));
        const slot=pos>=0?pos:chunks.length-1;
        const key=idx+':'+slot;
        attached.set(key,[...(attached.get(key)||[]),p.line]);
      }
      else rest.push(p.line);
    }
    for(const [i,section] of sections.entries()){
      sections[i]=section.split(/\n\s*\n/).map((s,j)=>[s,...(attached.get(i+':'+j) || [])].join('\n\n')).join('\n\n');
    }
    if(rest.length)sections.push((limit<=500?'':'**可核对的原始依据**\n\n')+rest.join('\n'));
    return [...sections,...tail].filter(Boolean).join('\n\n');
  };
  const concise=()=>pieces.map(p=>p.line).join('\n');
  for(const x of ranked){
    // A read with many coordinates should not bury the answer in a cell dump.
    if(pieces.length>=8)break;
    pieces.push({line:'- '+x.text,heading:headingFor(x.block),block:x.block});
    if(visibleAnswerChars(render())>limit && !(limit<Infinity && !usable && visibleAnswerChars(concise())<=limit)){pieces.pop();continue;}
    citations.push(...(x.inputs || [x.c]));
  }
  if(!citations.length)return {text:retained,citations:citedCells,pageSources};
  const text=visibleAnswerChars(render())<=limit?render():concise();
  return {text,citations:[...adoptedCitations(text,index),...citations.filter(c=>c.role!=='page')],pageSources:[...pageSources,...citations.filter(c=>c.role==='page')]};
}
