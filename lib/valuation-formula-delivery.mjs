import {Lexer} from 'marked';
import {calculate} from './calc-tool.mjs';
import {adoptedCitations} from './citations.mjs';
import {questionWithoutAttachments} from './answer-length.mjs';

// An unrestricted overview invites illustrative shocks. A user's specified
// cases, narrow questions, and requested deliverable always take precedence.
export function asksModelOverview(question) {
  const q=questionWithoutAttachments(question).trim().replace(/[。！？?]+$/,'');
  if(!/模型|valuation model/i.test(q) || /只(?:需|做|回答|看)|仅(?:核验|列|查)|不要.{0,6}(?:测算|情景|敏感性)|(?:重算|下调|上调|若|假设).{0,15}\d|单变量|保存|写入|形成投资框架/.test(q))return false;
  const overview=/(?:解读|分析|理解|讲解|解释|拆解|梳理|看懂|评估|介绍)[^，。！？：；\n]{0,45}模型|模型[^，。！？：；\n]{0,18}(?:概览|整体|怎么估值)|(?:explain|analy[sz]e|walk me through).*valuation model/i;
  const wholeModel=/模型(?:做个?(?:整体|全面|完整)(?:分析|解读|拆解))?$|valuation model[.!]?$/i.test(q) ||
    /(?:模型结构|目标价.{0,5}计算路径)/.test(q) && /(?:假设|驱动)/.test(q);
  return overview.test(q) && wholeModel && !/如何.{0,12}模型|怎么.{0,12}模型|(?:创建|建立|构建|修改|校准|拟合).{0,10}模型/.test(q);
}

const coordinate=/(?:(?:'((?:[^']|'')+)'|([A-Za-z_][A-Za-z_0-9.]*))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)/g;
const targetMetric=/(?:^|[;；]\s*)(?:target price|price target|TP|目标价(?:格)?|每股价值)\s*(?:$|[(（][^)）]*[)）]$)/i;
const show=n=>String(Number(n.toPrecision(7)));
const label=c=>String(c.metric || c.locator).replace(/[\r\n|*<>\x60]/g,' ').trim();
const unitName=unit=>({rmb:'元',cny:'元',hkd:'港元',usd:'美元','rmb/sh':'元/股','cny/sh':'元/股'}[String(unit).toLowerCase()] || unit);
const ref=c=>'['+c.filename+']'+c.locator;

function verifiedStep(cell, byLocator) {
  if(!cell.formula?.startsWith('=') || cell.formula.length>240 || (cell.formula.match(/\^/g) || []).length>1)return null;
  const refs=[], parts=[];
  const sheet=cell.locator.slice(0,cell.locator.lastIndexOf('!'));
  const formula=cell.formula.slice(1);
  let start=0;
  for(const m of formula.matchAll(coordinate)) {
    const dep=byLocator.get((m[1]?.replaceAll("''","'") || m[2] || sheet)+'!'+m[3].replaceAll('$',''));
    if(!dep || dep===cell || !Number.isFinite(dep.value))return null;
    refs.push(dep);parts.push(formula.slice(start,m.index),dep);
    start=m.index+m[0].length;
  }
  parts.push(formula.slice(start));
  // Only a scalar arithmetic subset with Excel-compatible semantics. Reject
  // ranges, external names and unary-minus powers where the parsers differ.
  if(!refs.length || refs.length>6 || parts.some(p=>typeof p==='string' &&
      !/^[0-9.,+*/^()\s-]*$/.test(p.replace(/\b(?:ROUND|MIN|MAX|ABS|SUM)(?=\()/gi,''))) ||
      /(?:^|[(,*/^+-])\s*-[^,)]*\^/.test(formula))return null;
  const expression=(values,display=false)=>parts.map(p=>{
    if(typeof p==='string')return p;
    const n=values.get(p) ?? p.value;
    return display?(n<0?'('+show(n)+')':show(n)):'('+n+')';
  }).join('');
  const run=values=>Number(calculate({expression:expression(values)}).value);
  const base=run(new Map());
  if(!Number.isFinite(base) || Math.abs(base-cell.value)>1e-9*Math.max(1,Math.abs(cell.value)))return null;
  return {cell,refs:[...new Set(refs)],run,display:expression(new Map(),true)};
}

function mentionedDriver(cell,thesis) {
  const normalized=s=>s.toLowerCase().replace(/[\s/]/g,'');
  const metric=normalized(cell.metric || '');
  const words=(cell.metric || '').match(/\b(?:EPS|P\/?E|EBITDA|WACC|FCF[FE]?|ASP|ARPU|ROE|ROIC)\b/gi) || [];
  return metric.length>=2 && (normalized(thesis).includes(metric) ||
    words.some(w=>new RegExp('(?:^|[^a-z])'+normalized(w)+'(?:$|[^a-z])','i').test(normalized(thesis))));
}

function existingScenarios(answer,drivers) {
  if(!drivers.length)return false;
  const covered=new Set();
  for(const t of Lexer.lex(answer)){
    if(t.type!=='table')continue;
    const output=t.header.findIndex(x=>/目标价|每股价值|target price/i.test(x.text));
    if(output<0)continue;
    for(const row of t.rows){
      if(!/\d/.test(row[output]?.text || ''))continue;
      const input=row.filter((_,i)=>i!==output).map(x=>x.text).join(' ');
      if(!/\d/.test(input))continue;
      for(const d of drivers)if(mentionedDriver(d,input))covered.add(d.id);
    }
  }
  return drivers.every(d=>covered.has(d.id));
}

// Reconstruct from current read receipts, never from the draft's arithmetic.
// Scenarios are partial derivatives of the displayed cells, not a workbook run.
export function valuationFormulaDelivery(answer, cells) {
  const cited=adoptedCitations(answer,cells);
  const outputs=cited.filter(c=>targetMetric.test(c.metric || '') && c.formula && c.value>0 && typeof c.value==='number');
  if(outputs.length!==1)return null;
  const output=outputs[0],unit=output.display_unit || output.raw_unit;
  if(!/^(?:(?:[A-Z]{3}|[A-Z]{0,3}\$|元|人民币|港元|港币|美元|欧元|日元)(?:\s*\/\s*(?:股|share|sh))?)$/i.test(unit || '') || !output.sha256)return null;
  const displayUnit=unitName(unit);
  const local=cells.filter(c=>c.sha256===output.sha256 && c.version===output.version && c.materialId===output.materialId &&
    Number.isFinite(c.value) && !c.derivedFrom && c.filename && !/[\r\n[\]<>\x60]/.test(c.filename));
  const byLocator=new Map(local.map(c=>[c.locator,c]));
  if(byLocator.get(output.locator)?.id!==output.id)return null;
  try {
    const root=verifiedStep(output,byLocator);
    if(!root)return null;
    const thesis=answer.split(/\n\s*\n/).slice(0,3).join('\n');
    const children=new Map();
    for(const c of root.refs){
      const step=verifiedStep(c,byLocator);
      if(step && step.refs.length>1 && step.refs.every(d=>d!==output && !root.refs.includes(d)) &&
          step.refs.some(d=>mentionedDriver(d,thesis)))children.set(c,step);
    }
    const drivers=[...new Set(root.refs.flatMap(c=>children.get(c)?.refs || [c]))]
      .filter(c=>c.value>0 && mentionedDriver(c,thesis));
    const citations=[...new Set([output,...root.refs,...[...children.values()].flatMap(s=>s.refs)])];
    const basis=[...children.values(),root].map(s=>{
      const terms=s.refs.map(d=>{
        const u=d.display_unit && !/unknown|decimal/i.test(d.display_unit)?unitName(d.display_unit):'';
        const formatted=u==='%' && d.raw_unit==='decimal'?show(d.value*100)+'%':show(d.value)+(u?' '+u:'');
        return (d.metric?label(d)+' ':'')+formatted+' '+ref(d);
      }).join('、');
      return terms+'。'+(s.cell===output?'目标价':label(s.cell)+' ')+'按 \x60'+s.display+'\x60 计算约为 '+show(s.cell.value)+' '+(s.cell===output?displayUnit:unitName(s.cell.display_unit) || '')+' '+ref(s.cell)+'。';
    }).join('\n\n');
    const rows=[],changes=[];
    const tested=existingScenarios(answer,drivers)?[]:drivers.slice(0,3);
    for(const d of tested){
      const values=new Map([[d,d.value*0.9]]);
      for(const [c,step] of children)values.set(c,step.run(values));
      const price=root.run(values);
      if(!Number.isFinite(price) || price===output.value)continue;
      changes.push({inputId:d.id,before:d.value,after:values.get(d),output:price});
      rows.push('| '+label(d)+' '+ref(d)+' | '+show(d.value)+' → '+show(values.get(d))+' | '+show(price)+' |');
    }
    const scenarios=rows.length?'\n\n**关键假设的局部敏感性**\n\n以 '+show(output.value)+' '+displayUnit+'为基准，每次仅将一项指标下调 10%，其余引用格固定，按上列公式计算。\n\n| 调整项 | 原值 → 情景值 | 目标价（'+displayUnit+'） |\n|---|---:|---:|\n'+rows.join('\n'):'';
    if(!rows.length && citations.every(c=>cited.some(existing=>existing.id===c.id)) && answer.includes(root.cell.formula))return null;
    return {text:'**目标价复算**\n\n'+basis+scenarios,citations,output,receipt:{outputId:output.id,base:output.value,unit,scope:'local_formula',changes,sourceIds:citations.map(c=>c.id)}};
  } catch {return null;}
}
