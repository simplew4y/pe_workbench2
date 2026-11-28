// An unrestricted overview invites illustrative shocks. A user's specified
// cases, narrow questions, and requested deliverable always take precedence.
export function asksModelOverview(question) {
  const q=String(question || '').split(/\n\n(?:\[已上传资料\]\n|---\n## 本次选用的研究记录\n)/u,1)[0].trim().replace(/[。！？?]+$/,'');
  if(/审计|审查|机器学习|语言模型|训练模型|神经网络|找(?:错|茬)|查错|排错|逐格|重算|核对|复核|验证公式|(?:按|沿用).{0,6}(?:模板|格式)|只(?:要|用)|仅(?:需|限)|\b(?:audit|debug|recalculate)\b/i.test(q))return false;
  if(!/模型|(?:financial|valuation) model/i.test(q) || /只(?:需|做|回答|看)|仅(?:核验|列|查)|不要.{0,6}(?:测算|情景|敏感性)|(?:重算|下调|上调|若|假设).{0,15}\d|单变量|保存|写入|形成投资框架/.test(q))return false;
  const overview=/(?:看看|看一下|读一下|带我看|解读|分析|理解|讲解|解释|拆解|梳理|读懂|看懂|评估|介绍)[^，。！？：；\n]{0,45}模型|模型[^，。！？：；\n]{0,18}(?:概览|整体|怎么估值)|(?:explain|analy[sz]e|walk me through).*(?:financial|valuation) model/i;
  if (/^(?:(?:请|帮我)\s*)?(?:这个|这份|该)?(?:财务|估值|财务和估值)?模型(?:怎么看|怎么理解|怎么分析)$/.test(q))return true;
  const first=q.split(/[，,。；;\n]/)[0];
  const explicitOverview=/(?:看看|看一下|读懂|理解|解读|拆解|讲解).{0,25}模型$/.test(first) &&
    first!==q && /(?:业务|经营|骨架|框架|关键假设|核心驱动|全貌|基本面)/.test(q.slice(first.length));
  const wholeModel=explicitOverview || /模型(?:做个?(?:整体|全面|完整)(?:分析|解读|拆解))?$|(?:financial|valuation) model[.!]?$/i.test(q) ||
    /(?:模型结构|目标价.{0,5}计算路径)/.test(q) && /(?:假设|驱动)/.test(q);
  return overview.test(q) && wholeModel && !/如何.{0,12}模型|怎么.{0,12}模型|(?:创建|建立|构建|修改|校准|拟合).{0,10}模型/.test(q);
}


export const overviewGuidance = `探索性模型导读按以下顺序交付。第一句独立成段，用一句白话点出标的、经营什么业务、这份模型用什么方法得出什么基准结论。引用紧跟结论。开头直接介绍标的，禁止以但、但是、然而或审计意见起笔。
然后以“模型怎么算”为题，从公司靠什么赚钱讲起，沿实际输入说明经营假设怎样传到盈利或现金流，再解释估值方法、关键期间、基准结果和有依据的情景。最后以“哪些假设要小心”为题，集中说明哪些假设可能失效、对应哪项判断、应观察什么。不要把质疑提前，也不要强加 PE、目标价或未披露的业务。财务预测模型就讲其预测结果。
每次压缩、补证、改稿均保留这三个部分，局部错误只更正相应事实。用投研语言直接交付，例如“折现期为三年”；对数反算、检查动作和“机械上正确、结构可复算”留在后台。如缺少某项关键输入，在相应结论旁说明具体限制。明确的用户格式和篇幅优先。`;
