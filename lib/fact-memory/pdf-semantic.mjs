/** Conservative PDF semantics. Only explicitly labelled page metadata and
 * aligned table headers are trusted. No cross-page header guessing or OCR.
 * Unrecognized structures remain raw durable evidence, never inferred facts.
 */
import {normalizeValue,norm} from './value.mjs';
const metrics=new Map([['revenue','revenue'],['营业收入','revenue'],['收入','revenue'],['营收','revenue'],['ebitda','ebitda'],['息税折旧摊销前利润','ebitda'],['assets','assets'],['totalassets','assets'],['资产','assets'],['总资产','assets'],['netdebt','net_debt'],['净债务','net_debt'],['净负债','net_debt'],['netprofit','net_profit'],['净利润','net_profit'],['grossmargin','gross_margin'],['毛利率','gross_margin']]);
const scalarPattern=/^\s*(\(?[+−-]?(?:\d[\d,]*(?:\.\d+)?|\.\d+)\)?%?)\s*([^\d]*?)\s*$/;
const unitPattern=/(?:RMB|CNY|USD|HKD)\s*(?:million|mn|mm|billion|bn)?|百万元|千元|万元|亿元|元\/股|元|个百分点|%|倍/i;
const hasNotes=text=>/\b(?:footnote|restated|unaudited|excluding|excludes|continued)\b|\bnote\s*:|(?:注|附注)\s*[:：]|剔除|重述|未经审计|续表/i.test(text);
function unique(values) {const strings=[...new Set(values.filter(Boolean))];return strings.length===1?strings[0]:'';}
function tagged(text,names) {
  const re=new RegExp(`(?:^|[\\n;；|])\\s*(?:${names})\\s*[:：]\\s*([^\\n;；|]+)`,'gi');
  return [...text.matchAll(re)].map(m=>m[1].trim());
}
export function periodIdentity(header) {
  const raw=String(header || '').trim();
  const match=raw.match(/^(?:FY\s*)?(20\d{2}(?:Q[1-4]|H[12])?)([EA])?(?:\s+(actual|forecast|assumption|实际|预测|假设))?$/i);
  if(!match)return null;
  const basis=/E|forecast|预测/i.test([match[2],match[3]].join(' '))?'forecast':/assumption|假设/i.test(match[3] || '')?'assumption':/A|actual|实际/i.test([match[2],match[3]].join(' '))?'actual':'unknown';
  return {period:match[1].toUpperCase(),basis_type:basis};
}
function metadata(text) {
  const entities=tagged(text,'entity|company|主体|公司');
  const scopes=tagged(text,'scope|口径').map(s=>/^consolidated$|^合并$/i.test(s)?'consolidated':/^standalone$|^单体$/i.test(s)?'standalone':'');
  const bases=tagged(text,'basis|basis_type|数据类型').map(s=>/^actual$|^实际$/i.test(s)?'actual':/^forecast$|^预测$/i.test(s)?'forecast':/^assumption$|^假设$/i.test(s)?'assumption':'unknown');
  const periodLabels=tagged(text,'period|期间');
  const periods=periodLabels.map(s=>periodIdentity(s)).filter(Boolean);
  const unitLabels=tagged(text,'unit|units|单位');
  const units=unitLabels.map(s=>s.match(unitPattern)?.[0] || '');
  const currencyLabels=tagged(text,'currency|币种');
  const currencies=currencyLabels.map(s=>/^(CNY|RMB|USD|HKD)$/i.test(s)?s.toUpperCase().replace('RMB','CNY'):'');
  const currency=unique(currencies),scenarios=tagged(text,'scenario|情景');
  const raw_unit=unique(units),unitCurrency=raw_unit.match(/\b(CNY|RMB|USD|HKD)\b/i)?.[1]?.toUpperCase().replace('RMB','CNY') || '';
  return {entity:unique(entities),scope:unique(scopes),period:unique(periods.map(p=>p.period)),basis_type:unique(bases) || unique(periods.map(p=>p.basis_type)) || 'unknown',scenario:unique(scenarios),raw_unit,currency:currency || unitCurrency,
    review:hasNotes(text) || currencies.some(c=>!c) || new Set(currencies).size>1 || new Set(scenarios).size>1 || periods.length!==periodLabels.length || new Set(periods.map(p=>p.period)).size>1 || unitLabels.some(u=>norm(u)!==norm(u.match(unitPattern)?.[0])) || entities.length>1 || new Set(scopes).size>1 || new Set(units).size>1 || new Set(bases).size>1 || (unique(bases) && periods.some(p=>p.basis_type!=='unknown' && p.basis_type!==unique(bases))) || (currency && unitCurrency && currency!==unitCurrency)};
}
function rowMetric(label) {
  const clean=String(label || '').replace(/\([^)]*\)|（[^）]*）/g,'').trim();
  return metrics.get(norm(clean)) || null;
}
export function extractPdfFacts(input) {
  const context=input.page_context || input.text || '';
  const meta=metadata(context),candidates=[];
  if(input.scanned) return {candidates,coverage:'scanned_no_semantics'};
  function add(metric,raw,locator,column=null,extraReview=false) {
    const parsed=String(raw ?? '').match(scalarPattern);if(!parsed)return;
    const suffix=parsed[2].trim(),inlineUnit=suffix.match(unitPattern)?.[0] || (/[%％]$/.test(parsed[1])?'%':'');
    const raw_value=parsed[1],raw_unit=inlineUnit || meta.raw_unit;
    const inlineCurrency=inlineUnit.match(/\b(CNY|RMB|USD|HKD)\b/i)?.[1]?.toUpperCase().replace('RMB','CNY');
    const identity={entity:meta.entity,metric,period:column?.period || meta.period,scope:meta.scope,basis_type:column?.basis_type!=='unknown'&&column?.basis_type?column.basis_type:meta.basis_type,scenario:meta.scenario,currency:inlineCurrency || meta.currency};
    const numeric=normalizeValue(raw_value,raw_unit,identity.currency);
    if(numeric.canonical_value==null)return;
    const review=meta.review || (column?.basis_type && column.basis_type!=='unknown' && meta.basis_type!=='unknown' && column.basis_type!==meta.basis_type) || extraReview || Boolean(input.truncated) || Boolean(suffix && (!inlineUnit || norm(suffix)!==norm(inlineUnit))) || (inlineCurrency && meta.currency && inlineCurrency!==meta.currency);
    candidates.push({identity:{...identity,currency:numeric.currency || ''},raw_value,raw_unit,locator,semantic_review:Boolean(review),review_reason:review?'pdf_context_requires_review':null,excerpt:context+(input.table?'\n原始表格：'+JSON.stringify(input.table.data):''),extractor:'pdf-labelled-v1'});
  }
  if(input.table?.data) {
    const data=input.table.data;
    const headerIndex=data.findIndex(row=>row.length>1 && row.slice(1).every(cell=>periodIdentity(cell)));
    const headers=headerIndex>=0?data[headerIndex].slice(1).map(periodIdentity):null;
    const start=headerIndex>=0?headerIndex+1:0;
    for(let row=start;row<data.length;row++) {
      const cells=data[row],metric=rowMetric(cells[0]);if(!metric)continue;
      for(let col=1;col<cells.length;col++)add(metric,cells[col],`p.${input.page}/table.${input.table.index || 1}/r${row+1}c${col+1}`,headers?.[col-1],!headers || cells.length!==headers.length+1 || /[()（）]/.test(String(cells[0])));
    }
    return {candidates,coverage:headers?'aligned_table_only':'table_without_complete_headers'};
  }
  for(const [index,line] of String(input.text || '').split(/[\n;；]/).entries()) {
    const match=line.trim().match(/^([^:：]+)[:：]\s*(.+)$/);if(!match)continue;
    const metric=rowMetric(match[1]);if(!metric)continue;
    add(metric,match[2],`p.${input.page}/line.${index+1}`,null,/[()（）]/.test(match[1]));
  }
  return {candidates,coverage:candidates.length?'explicitly_labelled_rows_only':'no_supported_numeric_structure'};
}
