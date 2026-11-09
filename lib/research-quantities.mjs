// Bind each quantity to its own metric, rather than every number in a sentence.
const num = s => Number(s.replaceAll(',', ''));
const near = (v, s) => Math.abs(v-num(s)) <= .5*10**-(s.split('.')[1]?.length || 0)+1e-8;
const scales = {百万元:1,万元:.01,亿元:100,亿:100};
const metricPattern = /收入占比|销售占比|毛利占比|毛利率|净利润|归母净利|净利|毛利|收入|营收/g;
const negative = /不是|并非|误写|错误地|不能将|不能把|撤回/;
const revenueRatio = c => c.ratioEvidence?.denominator?.label === 'Revenues';
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
  // Preserve thousands separators, but separate independent clauses/claims.
  const clauses=text.split(/，|;|；|,(?!\d{3}(?:\D|$))|以及|同时|而|和(?=[^。]{0,12}(?:收入|毛利|净利))/);
  // A trailing citation clause belongs to the preceding claim.
  for(let i=clauses.length-1;i>0;i--) {
    if(/^\s*(?:来源|见|引用)\s*[:：]?\s*/.test(clauses[i]) && !/\d\s*(?:%|亿元|百万元)/.test(clauses[i])) {
      clauses[i-1]+='，'+clauses[i];clauses.splice(i,1);
    }
  }
  const allPeriods=[...new Set(text.match(/20\d{2}[AE]?/g) || [])];
  for(const clause of clauses) {
    if(negative.test(clause))continue;
    const metrics=[...clause.matchAll(metricPattern)];
    const quantities=[...clause.matchAll(/([\d][\d,]*(?:\.\d+)?)\s*(百万元|万元|亿元|亿|%)(?!股|Gb|GB)/g)];
    for(const q of quantities) {
      // Prefer the nearest preceding metric; support "65%毛利率" too.
      const before=metrics.filter(m=>m.index<q.index).at(-1);
      const after=metrics.find(m=>m.index>=q.index+q[0].length && m.index<=q.index+q[0].length+2);
      const metric=after || before;
      const start=metric?.index ?? 0;
      const next=metrics.find(m=>m.index>Math.max(start,q.index+q[0].length-1));
      const segment=clause.slice(metric===after?q.index:start,next?.index ?? clause.length);
      const refs=facts.filter(c=>(metrics.length<=1?clause:segment).includes(c.ref));
      const periods=clause.match(/20\d{2}[AE]?/g) || (allPeriods.length===1?allPeriods:[]);
      const percent=q[2]==='%';
      let candidates=refs.length?refs:facts.filter(c=>
        periods.some(y=>String(c.period || '').replace(/[AE]$/,'')===y.replace(/[AE]$/,'')) &&
        metric && matchesMetric(c,metric[0],percent) &&
        (/净利/.test(metric[0]) || (/HBM/i.test(text) && c.rowLabel==='HBM')));
      candidates=candidates.filter(c=>percent?!!c.ratioEvidence:!!c.amount);
      if(candidates.length!==1)continue; // Ambiguous sources require semantic review.
      const c=candidates[0];
      if(percent) {
        if(metric && !matchesMetric(c,metric[0],true)) {
          issues.push({check:'metric_meaning',excerpt:line,reason:`${c.ref}属于${c.metricContext?.label || c.rowLabel}，分母为${c.ratioEvidence.denominator?.label}，不能表述为${metric[0]}。`});
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
