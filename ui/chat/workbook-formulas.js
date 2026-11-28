// Shared by generated Markdown and the reader for already-delivered workbook answers.
export const wantsWorkbookSyntax = question => /原式|Excel\s*(?:原始)?公式|(?:原始|原表|单元格)公式|公式原文|(?:exact|raw|original) (?:excel |cell )?formula/i.test(question || '');

const names = [
  [/^EPS(?:\s*\([^)]*diluted[^)]*\))$|^diluted EPS$/i, '摊薄每股收益'],
  [/^(?:EPS|earnings per share)(?:\s*\((?:Rmb|CNY|HKD|USD)\))?$/i, '每股收益'],
  [/^target (?:P\/?E|price.to.earnings)(?: multiple)?$/i, '目标市盈率'],
  [/^target multiple\s*[×x*]\s*EPS$/i, '按目标倍数估算的每股价值'],
  [/^(?:discounted back to \d{4}\s*[;；]\s*)?(?:TP|target price|price target)(?:\s*\([^)]*\))?$/i, '目标价'],
  [/^(?:COE|cost of equity)$/i, '股权成本'],
  [/^WACC$/i, '加权平均资本成本'],
  [/^(?:revenues?|sales revenue)$/i, '营业收入'],
  [/^operating profit$/i, '营业利润'],
  [/^tax rate$/i, '税率'],
  [/^shares(?: outstanding)?$/i, '股数'],
];
const units = {rmb:'元',cny:'元',hkd:'港元',usd:'美元','rmb/sh':'元/股','cny/sh':'元/股',
  'hkd/sh':'港元/股','usd/sh':'美元/股','cny mn':'百万元','rmb mn':'百万元'};
const legacyUnit = u => ({rmb:'元',cny:'元',hkd:'港元',usd:'美元','rmb/sh':'元/股','cny/sh':'元/股'}[String(u).toLowerCase()] || u || '');
const precise = n => String(Number(n.toPrecision(7)));
const number = n => String(Number(n.toPrecision(5)));
const reference = c => '['+c.filename+']'+c.locator;
const shortLabel = c => String(c.metric || '').replace(/^20\d{2}[AE]?\s+/i,'').trim();
function nameOf(c) {
  return names.find(([re])=>re.test(shortLabel(c)))?.[1];
}
export function metricLabel(c) {
  const metric = nameOf(c);
  if (!metric) return String(c.metric || '').replace(/[\r\n|*<>\x60]/g,' ').trim();
  const period = c.period || /^(20\d{2}[AE]?)\s/i.exec(c.metric || '')?.[1];
  const date = String(period || '').replace(/^(\d{4})E$/, '$1 年预计').replace(/^(\d{4})$/, '$1 年');
  if (!date) return metric;
  return date+(/年(?:预计)?$/.test(date)?'':' ')+metric;
}
function unitOf(c) {
  const unit = [c.display_unit,c.raw_unit].find(u=>u && !/^(?:decimal|unknown|unit_unknown)$/i.test(u)) || '';
  return units[unit.toLowerCase()] || unit;
}
function amount(c) {
  const u = unitOf(c);
  return number(c.value*(u==='%' && c.raw_unit==='decimal'?100:1))+(u && u!=='%'?' ':'')+u;
}
function sameBook(a,b) {
  return a.materialId && a.materialId===b.materialId && a.version===b.version && a.sha256 && a.sha256===b.sha256;
}
function unique(cells) {
  const first=cells[0];
  return first && cells.every(c=>sameBook(first,c) && c.formula===first.formula && c.value===first.value && c.metric===first.metric) ? first : null;
}
function linkedInput(c,cells) {
  const ref=/^=((?:'[^']+'|[\w.]+)!\$?[A-Z]{1,3}\$?\d+)$/i.exec(c.formula || '')?.[1]?.replace(/[$']/g,'');
  return ref && unique(cells.filter(d=>sameBook(c,d) && d.locator===ref && d.value===c.value));
}

export function readableObservation(c, cells, locator) {
  if (!nameOf(c) || !Number.isFinite(c.value) || !unitOf(c)) return null;
  const product=/^=\s*(\$?[A-Z]{1,3}\$?\d+)\s*\*\s*(\$?[A-Z]{1,3}\$?\d+)\s*$/i.exec(c.formula || '');
  if (product) {
    const sheet=c.locator.slice(0,c.locator.lastIndexOf('!')+1);
    const operands=product.slice(1).map(a=>unique(cells.filter(d=>sameBook(c,d) && d.locator===sheet+a.replace(/\$/g,''))));
    if (operands.every(d=>d && nameOf(d) && Number.isFinite(d.value) && unitOf(d)) &&
        Math.abs(operands[0].value*operands[1].value-c.value)<=1e-10*Math.max(1,Math.abs(c.value))) {
      return formulaStep(c,operands,operands.map(d=>precise(d.value)).join('*'),false,cells).replace(/。$/,'');
    }
  }
  const input=linkedInput(c,cells);
  // Only inherit a period when the formula copies that exact source value.
  const label=metricLabel(input?.period && !c.period ? {...c,period:input.period} : c);
  const labelWithPeriod = nameOf(c)==='目标价' && /^discounted back to (\d{4})/i.test(c.metric) ?
    '折回 '+c.metric.match(/discounted back to (\d{4})/i)[1]+' 年的目标价' : label;
  return labelWithPeriod+'为 '+amount(c)+'（'+locator+(input?'、'+reference(input):'')+'）';
}

function math(expr) {
  return expr.replace(/\*/g,' × ').replace(/\//g,' ÷ ').replace(/\+/g,' + ')
    .replace(/\^(\d+)(?![\d.])/g,(_,digits)=>[...digits].map(d=>'⁰¹²³⁴⁵⁶⁷⁸⁹'[d]).join(''))
    .replace(/\b(SUM|MIN|MAX|ABS|ROUND)\(/gi,(_,f)=>({SUM:'求和',MIN:'取最小值',MAX:'取最大值',ABS:'取绝对值',ROUND:'四舍五入'}[f.toUpperCase()])+'(');
}
export function formulaStep(c, inputs, expression, target, cells=inputs) {
  const ref = d=>reference(d);
  const result = amount(c)+' '+ref(c);
  const [base,rate,period]=inputs;
  const raw = expression.replace(/\s/g,'');
  const match=/^ROUND\((.+),0\)$/i.exec(raw);
  const inner=match ? match[1] : raw;
  const rounding=match?'，按原表四舍五入取整':'';
  if (inputs.length===3 && inner===precise(base.value)+'/(1+'+precise(rate.value)+')^'+precise(period.value) &&
      unitOf(rate)==='%' && rate.raw_unit==='decimal' && Number.isInteger(period.value) && period.value>0) {
    const date=/discounted back to (\d{4})/i.exec(c.metric || '')?.[1];
    // State years only when the valuation period and the discount endpoint agree.
    const years=date && nameOf(base)==='按目标倍数估算的每股价值' && cells.some(d=>
      sameBook(c,d) && nameOf(d)==='目标市盈率' &&
      Number(/^(\d{4})E?$/.exec(d.period || '')?.[1])===Number(date)+period.value &&
      base.formula?.replace(/\$/g,'').split(/[*=]/).includes(d.locator.split('!').at(-1)) &&
      base.locator.split('!')[0]===d.locator.split('!')[0]);

    return '将期末价值 '+amount(base)+' '+ref(base)+'，按'+(nameOf(rate) || '折现率')+' '+amount(rate)+' '+ref(rate)+' 折现 '+period.value+(years?' 年 ':' 期 ')+ref(period)+(date?' 至 '+date+' 年':'')+'。\n\n'+
      '**'+(target?'目标价':metricLabel(c))+'** ≈ '+number(base.value)+' ÷ (1 + '+amount(rate)+')'+math('^'+period.value)+' ≈ **'+amount(c)+'** '+ref(c)+rounding+'。';
  }
  if (inputs.length===2 && inner===inputs.map(d=>precise(d.value)).join('*')) {
    return inputs.map(d=>{
      const input=linkedInput(d,cells);
      const label=metricLabel(input?.period && !d.period?{...d,period:input.period}:d) || '输入值';
      return label+' '+amount(d)+'（'+ref(d)+(input?'、'+ref(input):'')+'）';
    }).join(' × ')+' ≈ **'+amount(c)+'** '+ref(c)+'（'+(metricLabel(c) || '计算结果')+'）'+rounding+'。';
  }
  const terms=inputs.map(d=>(metricLabel(d) || '输入值')+' '+amount(d)+' '+ref(d)).join('，');
  return terms+'。'+(target?'目标价':metricLabel(c) || '计算结果')+' ≈ '+math(inner)+' ≈ '+result+rounding+'。';
}

// Match just the two historical host templates, with the exact source version,
// stored value and formula. Leave authored Markdown and conflicting receipts alone.
export function readableArchivedLine(line,cells) {
  if (!cells.length || !line.includes('[')) return line;
  const obs=/^- (.+?)（\[([^\]]+)\]([^）]+)），原式 \x60([^\x60]+)\x60。$/.exec(line);
  if (obs) {
    const [,prefix,file,loc,formula]=obs;
    const c=unique(cells.filter(d=>d.filename===file && d.locator===loc));
    if (!c || c.formula!==formula || !Number.isFinite(c.value)) return line;
    const rawUnit=c.raw_unit && !/^(unit_unknown|decimal|unknown)$/.test(c.raw_unit)?' '+c.raw_unit:'';
    const pct=c.raw_unit==='decimal' && c.display_unit==='%';
    const expected=[c.period,c.metric].filter(Boolean).join(' ')+' '+Number((c.value*(pct?100:1)).toPrecision(9))+(pct?'%':rawUnit);
    const text=prefix===expected && readableObservation(c,cells,reference(c));
    return text ? '- '+text+'。' : line;
  }
  const proof=/^(.+?)。(.+?)按 \x60([A-Z0-9.,()+*/^\s-]+)\x60 计算约为 (.+?) (\[[^\]]+\].+?)。$/i.exec(line);
  if (!proof) return line;
  const [,terms,title,expr,value,loc]=proof;
  const c=unique(cells.filter(d=>d.filename && reference(d)===loc));
  if (!c || !Number.isFinite(c.value) || !c.formula || value!==precise(c.value)+' '+legacyUnit(c.display_unit || c.raw_unit)) return line;
  if (title.trim()!=='目标价' && title.trim()!==String(c.metric || c.locator).trim()) return line;
  const inputs=[];
  for (const term of terms.split('、')) {
    const d=unique(cells.filter(d=>sameBook(c,d) && term.endsWith(' '+reference(d))));
    if (!d || !Number.isFinite(d.value)) return line;
    const u=d.display_unit && !/unknown|decimal/i.test(d.display_unit)?legacyUnit(d.display_unit):'';
    const shown=u==='%' && d.raw_unit==='decimal'?precise(d.value*100)+'%':precise(d.value)+(u?' '+u:'');
    const label=String(d.metric || '').replace(/[\r\n|*<>\x60]/g,' ').trim();
    if (term!==(label?label+' ':'')+shown+' '+reference(d)) return line;
    inputs.push(d);
  }
  const sheet=c.locator.slice(0,c.locator.lastIndexOf('!'));
  const formula=c.formula.slice(1).replace(/(?:(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!)?(\$?[A-Z]{1,3}\$?[1-9]\d*)/g,(_,quoted,bare,addr)=>{
    const loc=(quoted?.replaceAll("''","'") || bare || sheet)+'!'+addr.replaceAll('$','');
    const input=inputs.find(d=>d.locator===loc);
    return input ? (input.value<0?'('+precise(input.value)+')':precise(input.value)) : '?';
  });
  return formula===expr ? formulaStep(c,inputs,expr,title.trim()==='目标价',cells) : line;
}

// A generated read-back can immediately precede the same verified worked example.
// Fold only whole generated observations whose source cells survive in that example.
export function groupFormulaProof(text,cells) {
  const heading='**目标价复算**';
  if (!cells?.length || !text.includes(heading)) return text;
  const parts=text.split(/\n\n/), at=parts.indexOf(heading);
  if (at<1 || parts.indexOf(heading,at+1)!==-1 || /^(?: {0,3})(?:\x60{3}|~{3}|<(?:pre|code)\b)/im.test(text)) return text;
  const isBullet=p=>p?.startsWith('- ') && !p.includes('\n');
  let from=at;
  while (isBullet(parts[from-1])) from--;
  if (at===from || !parts[at+1]?.startsWith('将期末价值 ') || !parts[at+2]?.startsWith('**目标价** ≈ ')) return text;
  const discount=parts.slice(at+1,at+3).join('\n\n');
  const keep=[];
  for (const paragraph of parts.slice(from,at).reverse()) {
    const cell=cells.find(c=>c.filename && c.locator && paragraph.includes(reference(c)) &&
      '- '+readableObservation(c,cells,reference(c))+'。'===paragraph);
    if (!cell) return text;
    const later=[...keep,discount].join('\n');
    const sources=cells.filter(c=>c.filename && c.locator && paragraph.includes(reference(c)));
    // A multiplication step explains how the numerator was built. A scalar
    // observation can be folded only if its own value and all links remain.
    if (paragraph.includes(' × ') || !sources.every(c=>later.includes(reference(c))) || !later.includes(amount(cell))) keep.unshift(paragraph);
  }
  parts.splice(from,at-from+1,heading,...keep);
  return parts.join('\n\n');
}
