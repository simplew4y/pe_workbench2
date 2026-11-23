// Bind each quantity to its own metric, rather than every number in a sentence.
import { extractLocatorMatches, locatorKey } from './citation-locator.mjs';
const num = s => Number(s.replaceAll(',', ''));
const near = (v, s) => Math.abs(v-num(s)) <= .5*10**-(s.split('.')[1]?.length || 0)+1e-8;
const scales = {百万元:1,万元:.01,亿元:100,亿:100};
const metricPattern = /收入占比|销售占比|毛利占比|毛利率|净利润|归母净利|净利|毛利|收入|营收/g;
const negative = /不是|并非|误写|错误地|不能将|不能把|撤回/;
const revenueRatio = c => c.ratioEvidence?.denominator?.label === 'Revenues';
const genericMetric = /^(?:revenues?|sales|net income|net profit|gross profit|gross margin|gm|净利润|归母净利|净利|毛利率|毛利|收入|营收)$/i;
function sourceSubject(cell) {
  const label=String(cell.rowLabel || '').trim();
  return label && !genericMetric.test(label) && cell.metricContext?.label ? label : '';
}
function adjacentSubject(prefix, subjects) {
  return subjects.filter(subject=>{
    const at=prefix.toLowerCase().lastIndexOf(subject.toLowerCase());
    if(at<0 || /^[a-z]/i.test(subject) && /[a-z]/i.test(prefix[at-1] || ''))return false;
    const gap=prefix.slice(at+subject.length);
    // Only an explicitly local subject can bind a product/segment source.
    // A mention elsewhere in the sentence cannot own every later quantity.
    return /^(?:\s|的|预计|预测|实际|对应|20\d{2}[AE]?|年|季度|[QH][1-4]|[1-4]Q)*$/i.test(gap);
  });
}
function matchesMetric(c, metric, percent) {
  const label=c.metricContext?.label || c.rowLabel || '';
  if(/净利/.test(metric))return /net income|net profit/i.test(c.rowLabel || '');
  if(metric==='毛利率')return /^(GM|gross margin)$/i.test(label);
  if(metric==='毛利占比')return /gross profit/i.test(c.ratioEvidence?.denominator?.label || '');
  if(/占比/.test(metric) || percent)return revenueRatio(c);
  if(metric==='毛利')return /gross profit/i.test(label);
  return /^Revenues$/i.test(label) && !!c.amount;
}
export function quantityIssues(line, facts) {
  const issues=[], text=line.replace(/[*`]/g,'');
  const subjects=[...new Set(facts.map(sourceSubject).filter(Boolean))];
  const proposedCondition=/^(?:(?:会|将)?(?:改变|推翻)判断的信号|观察信号|失效条件|触发条件|若|如果)[：:\s]?/.test(text.trim()) &&
    !/已(?:经)?(?:实现|发生|披露|达到|确认|核实)|实际(?:为|达到|发生)/.test(text);
  const periodCompatible=(c,clause)=> {
    // A year alone cannot turn actual quarterly disclosures or a proposed
    // monitoring threshold into the workbook's annual forecast.
    if(proposedCondition)return false;
    const period=String(c.period || '');
    if(/E$/i.test(period) && /实际|披露|季报|半年报/.test(text))return false;
    if(/^20\d{2}[AE]?$/i.test(period) && !/20\d{2}E\b/i.test(clause) && /单季|季度|前三季|前[一二三四1234]季|半年|上半年|下半年|[QH][1-4]|[1-4]Q/i.test(text))return false;
    return true;
  };
  // Preserve thousands separators, but separate independent clauses/claims.
  const clauses=text.split(/，|;|；|,(?!\d{3}(?:\D|$))|以及|同时|而|和(?=[^。]{0,12}(?:收入|毛利|净利))/);
  // A trailing citation clause belongs to the preceding claim.
  for(let i=clauses.length-1;i>0;i--) {
    if(/^\s*(?:来源|见|引用)\s*[:：]?\s*/.test(clauses[i]) && !/\d\s*(?:%|亿元|百万元)/.test(clauses[i])) {
      clauses[i-1]+='，'+clauses[i];clauses.splice(i,1);
    }
  }
  const allPeriods=[...new Set(text.match(/20\d{2}[AE]?/g) || [])];
  for(const [clauseIndex,clause] of clauses.entries()) {
    if(negative.test(clause))continue;
    const metrics=[...clause.matchAll(metricPattern)];
    const quantities=[...clause.matchAll(/([\d][\d,]*(?:\.\d+)?)\s*(百万元|万元|亿元|亿|%)(?!股|Gb|GB)/g)];
    for(const [quantityIndex,q] of quantities.entries()) {
      // Prefer the nearest preceding metric; support "65%毛利率" too.
      const before=metrics.filter(m=>m.index<q.index).at(-1);
      const after=metrics.find(m=>m.index>=q.index+q[0].length && m.index<=q.index+q[0].length+2);
      const metric=after || before;
      const start=metric?.index ?? 0;
      const next=metrics.find(m=>m.index>Math.max(start,q.index+q[0].length-1));
      const segment=clause.slice(metric===after?q.index:start,next?.index ?? clause.length);
      // Bind a suffix citation only to the quantity immediately before it.
      // An explicit locator that is absent from this evidence snapshot must
      // not silently inherit a different year's source from the sentence.
      const following=clause.slice(q.index+q[0].length,quantities[quantityIndex+1]?.index ?? clause.length);
      const localLocators=extractLocatorMatches(following);
      const citationGap=localLocators.length ? following.slice(0,localLocators[0].index).replace(/来源|引用|详见|见|模型/g,'').replace(/[\s()（）{}\[\]，,：:]/g,'') : '';
      const bindingText=localLocators.length ? citationGap?'':following : quantities.length===1 ? (metrics.length<=1?clause:segment) : '';
      const referencedCells=new Set(extractLocatorMatches(bindingText).map(match=>{
        if(facts.some(c=>locatorKey(c.ref)===match.key))return match.key;
        if(/^[，,\s]*(?:来源|引用|详见)(?=[A-Za-z])/.test(bindingText))
          return locatorKey(match.raw.replace(/^(?:来源|引用|详见)(?=[A-Za-z])/,''));
        return match.key;
      }));
      const refs=facts.filter(c=>referencedCells.has(locatorKey(c.ref)));
      const priorPeriods=[...clause.slice(0,q.index).matchAll(/20\d{2}[AE]?/g)];
      const periods=priorPeriods.length ? [priorPeriods.at(-1)[0]] : allPeriods.length===1?allPeriods:[];
      const previousQuantity=quantities[quantityIndex-1];
      const localPrefix=clause.slice(previousQuantity?previousQuantity.index+previousQuantity[0].length:0,q.index);
      const immediateSubjects=adjacentSubject(localPrefix,subjects);
      const localSubjects=immediateSubjects.length ? immediateSubjects : adjacentSubject(clause.slice(0,metric===after?q.index:metric?.index ?? q.index),subjects);
      // In an adjacent compact enumeration only the subject is elided.
      // Each metric still needs its own number, denominator and period.
      if(!localSubjects.length && clauseIndex>0 && metrics.length===1 && quantities.length===1 && allPeriods.length===1 &&
         metric && clause.slice(0,metric.index).trim()==='') {
        const previous=clauses[clauseIndex-1];
        const labels=[...previous.matchAll(metricPattern)];
        const coordinated=['，',',','和','以及','同时'].some(joiner=>text.includes(previous+joiner+clause));
        if(coordinated && labels.length===1 && /^(?:为|是|约为|约|达|仅|仅为|\s)*[\d,.]+(?:%|亿元|万元|百万元|亿)\s*(?:[（(][^()（）]*[）)])?\s*$/.test(previous.slice(labels[0].index+labels[0][0].length))) {
          const subject=adjacentSubject(previous.slice(0,labels[0].index),subjects);
          if(subject.length===1)localSubjects.push(subject[0]);
        }
      }
      const percent=q[2]==='%';
      const explicitRefs=extractLocatorMatches(clause).length;
      // A range, threshold or changed scenario is not an equality assertion
      // about a baseline cell. Repeated quantities need their own metric,
      // period or subject binding rather than inheriting a distant label.
      const uncertainBinding=/敏感性|情景|场景|model_input|假设变更|回到|下调|上调|调至|合计|平均/.test(clause) ||
        /(?:以上|以下|以内|以外)/.test(following.slice(0,4)) || /[≥≤<>]/.test(localPrefix) ||
        /\d\s*%?\s*[-–—~～至/]\s*$/.test(localPrefix) ||
        previousQuantity && metric?.index<previousQuantity.index && !/20\d{2}[AE]?/.test(localPrefix) && !immediateSubjects.length;
      let candidates=explicitRefs ? refs : uncertainBinding ? [] : facts.filter(c=>
        periodCompatible(c,clause) &&
        periods.some(y=>String(c.period || '').replace(/[AE]$/,'')===y.replace(/[AE]$/,'')) &&
        metric && matchesMetric(c,metric[0],percent) &&
        (sourceSubject(c) ? localSubjects.length===1 && localSubjects[0]===sourceSubject(c) : /净利/.test(metric[0]) && !localSubjects.length));
      // Percentage inputs may be hardcoded, with a verified margin label but no formula operands.
      candidates=candidates.filter(c=>percent
        ? c.ratioEvidence || /^(?:GM|gross margin)$/i.test(c.metricContext?.label || c.rowLabel || '')
        : c.amount);
      if(candidates.length!==1)continue; // Ambiguous sources require semantic review.
      const c=candidates[0];
      if(percent) {
        if(metric && !matchesMetric(c,metric[0],true)) {
          issues.push({check:'metric_meaning',excerpt:line,reason:`${c.ref}属于${c.metricContext?.label || c.rowLabel}，${c.ratioEvidence?.denominator?.label ? `分母为${c.ratioEvidence.denominator.label}，` : ''}不能表述为${metric[0]}。`});
        } else if(!near(c.value*100,q[1])) {
          issues.push({check:'metric_meaning',excerpt:line,reason:`${c.ref}的${metric?.[0] || '比例'}为${c.value*100}%，应根据该指标自己的分子和分母计算。`});
        }
      } else if(!near(c.value/scales[q[2]],q[1])) {
        issues.push({check:'numeric_units',excerpt:line,reason:`${c.ref}=${c.value}百万元，即${c.value/100}亿元；当前金额换算不一致。`});
      }
    }
  }
  return issues;
}

// Financial API EndDate is an end date, not proof of a single-quarter basis.
// Retain table/source boundaries so unrelated issuers/metrics cannot be added.
function revenueTables(timeline) {
  const tables=[];
  for(const item of timeline.filter(m=>m.role==='toolResult' && !m.isError && !['review_research','write','edit'].includes(m.toolName))) {
    let table, previousLine='';
    for(const line of (item.text || '').split('\n')) {
      if(!line.trim().startsWith('|')) {table=undefined;previousLine=line;continue;}
      const cols=line.trim().split('|').slice(1,-1).map(c=>c.trim());
      if(cols.includes('EndDate')) {
        const quarter=/^\s*(?:口径\s*[:：]\s*单季|period_basis\s*[:=]\s*quarter)\s*$/i.test(previousLine);
        table={date:cols.indexOf('EndDate'),value:cols.indexOf('OperatingRevenue'),quarter,rows:[]};
        if(table.value<0)table.value=cols.indexOf('TotalOperatingRevenue');
        if(table.value>=0)tables.push(table);
      } else if(table?.value>=0 && /^20\d{2}-\d{2}-\d{2}/.test(cols[table.date] || '')) {
        const value=num(cols[table.value] || '');
        if(Number.isFinite(value))table.rows.push({date:cols[table.date].slice(0,10),value});
      }
      previousLine=line;
    }
  }
  return tables;
}
export function periodIssues(draft, timeline) {
  const issues=[];
  for(const table of revenueTables(timeline).filter(t=>!t.quarter)) {
    for(const line of draft.replace(/[*`]/g,'').split(/[。\n]/)) {
      if(negative.test(line) || /不能直接相加|不可相加|不要相加/.test(line))continue;
      for(const sum of line.matchAll(/\d[\d,]*(?:\.\d+)?\s*(?:亿元|亿|元)?(?:\s*[+＋]\s*\d[\d,]*(?:\.\d+)?\s*(?:亿元|亿|元)?)+/g)) {
        const terms=sum[0].split(/[+＋]/).map(t=>t.trim());
        // Ignore subexpressions of a correctly differenced formula.
        if(/[\-−(（]\s*$/.test(line.slice(0,sum.index)) || /^\s*[-−)）]/.test(line.slice(sum.index+sum[0].length)))continue;
        const unit=/亿/.test(sum[0])?1e8:1;
        const rows=terms.map(t=>table.rows.find(r=>near(r.value/unit,t.match(/[\d,]+(?:\.\d+)?/)[0])));
        if(rows.every(Boolean) && new Set(rows.map(r=>r.date)).size>=2 && new Set(rows.map(r=>r.date.slice(0,4))).size===1) {
          issues.push({check:'comparison_basis',excerpt:line,reason:`${rows.map(r=>r.date).join('、')}是同年不同截止日的收入字段，尚无单季口径证据，不能直接相加；若为累计数，应取末期累计值，单季用相邻累计值相减。`});
        }
      }
      const single=line.match(/(20\d{2})\s*Q([234])\s*单季(?:营业)?收入\s*(?:为|约|是|=)?\s*([\d,]+(?:\.\d+)?)\s*(亿元|亿|元)/i);
      if(single) {
        const row=table.rows.find(r=>r.date===`${single[1]}-${({2:'06-30',3:'09-30',4:'12-31'})[single[2]]}`);
        if(row && near(row.value/(single[4]==='元'?1:1e8),single[3]))issues.push({check:'comparison_basis',excerpt:line,reason:'EndDate只说明财报截止日，不能把该字段直接当成单季收入；先核实累计/单季口径，累计口径需相减。'});
      }
    }
  }
  return issues;
}
