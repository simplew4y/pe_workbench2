import {quantityIssues, periodIssues} from './research-quantities.mjs';
// Checks grounded in retrieved structured facts, independent of reviewer prose.
const number = s => Number(s.replaceAll(',', ''));
const near = (value, text) => Math.abs(value-number(text)) <= .5*10**-(text.split('.')[1]?.length || 0)+1e-8;
const norm = s => s.replace(/[*`\s]/g,'').replace(/(?:是|为|约)(?=\d)/g,'');
export function consistencyIssues(draft, timeline, cells=[]) {
  const issues=[];
  const facts=[...new Map(cells.map(c=>[`${c.file || ''}:${c.ref}`,c])).values()];
  const add=(check,excerpt,reason)=>issues.push({check,excerpt,reason});
  for(const line of draft.split(/[。\n]/).filter(Boolean)) {
    const text=line.replace(/[*`]/g,'');
    issues.push(...quantityIssues(line,facts));
    if (/不是|并非|误写|错误地|不能将|不能把|撤回/.test(text)) continue;
    const mentioned=facts.filter(c=>text.includes(c.ref));
    for(const c of mentioned) {
      if(/US\$\s*\/\s*Gb\b/.test(text) && /US\$\s*\/\s*GB\b/.test(c.rowLabel || '')) add('numeric_units',line,`${c.ref}原表单位为US$/GB，不能写成US$/Gb。`);
    }
    const charts=facts.flatMap(c=>c.chartEvidence || []);
    if(/去掉|剔除|排除/.test(text)) for(const chart of charts) for(const result of chart.leaveOneOut || []) {
      if(!result.company || !text.includes(result.company)) continue;
      const match=text.match(/斜率.{0,35}?(?:变为|变成|变到|翻到|反转为|到|为)\s*([+−-]?\d+(?:\.\d+)?)/);
      if(match && !near(result.slope,match[1].replace('−','-'))) add('conclusion_strength',line,`剔除${result.company}（${result.excluded}）的重算斜率为${result.slope}；不能使用另一公司的剔除结果。`);
    }
    if(charts.length && /(?:系数|N35|N36|可比|拟合)/.test(text) && /硬编码无依据|没有任何依据|根本没用于估值/.test(text)) add('coverage',line,'已取得图表样本和拟合证据；硬编码不等于没有依据。');
    for(const q of text.matchAll(/(\d+(?:\.\d+)?)\s*[÷/]\s*(\d+(?:\.\d+)?)\s*[-−]\s*1\s*=\s*\+?(\d+(?:\.\d+)?)%/g)) {
      if(Number(q[2]) && !near((Number(q[1])/Number(q[2])-1)*100,q[3])) add('numeric_units',line,`算式结果为${(Number(q[1])/Number(q[2])-1)*100}%，请按实际运算结果修正。`);
    }
  }
  issues.push(...periodIssues(draft,timeline));
  // A user accusation is not evidence that the assistant made that statement.
  const prior=timeline.filter(m=>m.role==='assistant').flatMap(m=>(m.text || '').split(/[。\n]/)).filter(s=>! /不是|并非|误|错|撤回|没有|无依据|我之前|我此前|我上一/.test(s));
  for(const line of draft.split(/[。\n]/)) {
    if(/没有说|没说|未曾|并未|不是我|无法确认|找不到/.test(line))continue;
    if(!/我(?:之前|此前|上一|曾经|先前).{0,40}(?:写|说|提到)/.test(line))continue;
    const claims=[...line.replace(/[*`]/g,'').matchAll(/(?:收入占比|销售占比|良率)\s*(?:是|为|约)?\s*\d+(?:[–—~\-]\d+)?%/g)].map(m=>m[0]);
    for(const claim of claims) if(!prior.some(s=>norm(s).includes(norm(claim)))) add('history',line,`当前可见assistant原话未支持“${claim}”这一历史归因；先核对原话，不能把用户引述当成自己说过的证据。`);
  }
  return [...new Map(issues.map(i=>[i.check+':'+i.excerpt,i])).values()];
}
