import {Lexer} from 'marked';

// Only narrow an inference in research prose. Keep quoted statements, source
// links, and structured deliverables intact. Never supply a company observation.
function investmentScope(text,calls) {
  const receipts=calls.filter(c=>c.success && c.name==='web_fetch' && !c.result?.isError &&
    c.details?.status===200 && typeof c.details.url==='string' && text.includes(c.details.url))
    .map(c=>(Array.isArray(c.result?.content) ? c.result.content : []).filter(x=>x.type==='text').map(x=>x.text).join('\n'));
  if(!receipts.length)return part=>part;
  // An expenditure on a particular use cannot inherit a consolidated total.
  // Require the actual linked disclosure, a matching amount, magnitude, and
  // accompanying growth rate. Never infer the undisclosed use's own amount.
  return part=>part.replace(/(AI|人工智能|研发|算力|扩产|数字化)(资本(?:开支|支出))\s*([\d,]+(?:\.\d+)?)\s*(亿元|万元|百万元)([、，]\s*\+([\d.]+)%)/g,
    (claim,use,metric,value,unit,change,growth)=>{
      const amount=value.replaceAll(',','').replace('.','\\.');
      const total=new RegExp('(?:^|[▪•\\n。；])\\s*(?:总|集团)?'+metric+'(?:为|达)?(?:人民币)?\\s*'+amount+'\\s*'+unit+'[^。\\n]{0,38}同比(?:增加|增长)\\s*'+growth.replace('.','\\.')+'%','m');
      if(!receipts.some(r=>/综合业绩|合并财务报表|合并业绩/.test(r) && total.test(r)) ||
          receipts.some(r=>new RegExp(use+'[^。\\n]{0,8}'+metric+'[^。\\n]{0,8}'+amount+'\\s*'+unit).test(r)))return claim;
      return '整体'+metric+value+unit+change+'（其中用于'+use+'的金额需分项披露）';
    });
}
export function clarifyResearchInference(text,question,calls=[],priorAnswers=[]) {
  if (!text || /逐字|原样|原文照录|逐句引用|转录|翻译/.test(question) || /^\s*[[{]/.test(text))return text;
  const qualifyInvestment=investmentScope(text,/对比|比较两家|分别比较|跨公司/.test(question)?[]:calls);
  const tokens=Lexer.lex(text);
  const growthQuestion=/(?:利润|盈利)(?:增长|增速|增量)/.test(question);
  return tokens.map(t=>{
    if(!['paragraph','list'].includes(t.type) || /[\x60]|~~~|\|.+\|/.test(t.raw))return t.raw;
    let s=t.raw;

    // “A 比 B 低” uses B as the denominator. Repair only an identifiable
    // swapped denominator, with explicit matching units and positive operands.
    s=s.replace(/([\d,]+(?:\.\d+)?)\s*(百万元|亿元|万元|港元|元)\s*(\*{0,2})，比(模型|预测|预算|实际)\s*([\d,]+(?:\.\d+)?)\s*\2\s*(低|高)\s*(\*{0,2})(\d+(?:\.\d+)?)%/g,
      (all,a,unit,close,base,b,direction,open,pct)=>{
        const x=Number(a.replaceAll(',','')),y=Number(b.replaceAll(',',''));
        const places=pct.split('.')[1]?.length || 0;
        if(x<=0 || y<=0 || (direction==='低'?x>=y:x<=y) ||
            Math.abs(100*(x-y)/x).toFixed(places)!==pct)return all;
        return a+' '+unit+close+'，比'+base+' '+b+' '+unit+direction+' '+open+Math.abs(100*(x-y)/y).toFixed(places)+'%';
      });

    if(growthQuestion && /(?:非IFRS|非GAAP|经调整|调整后)/i.test(s) &&
        /差额[^。]{0,110}(?:加回|调整项)[^。]{0,60}占[\d.]+%/.test(s)) {
      // Keep the observed reconciliation, but withdraw a verdict that treats
      // its level as evidence of the cause of growth. Preserve source-bearing
      // and quantitative statements verbatim.
      s=s.split(/(?<=。)/u).filter(sentence=>
        /[\d％%]|年报|公告|来源|https?:|\[[^\]]+\]/.test(sentence) ||
        !/^(?:结论[：:]|因此[，,])/.test(sentence.trim()) ||
        !/前提.{0,10}成立|接近事实/.test(sentence)).join('');
      s=s.trimEnd()+' 该比例描述本期利润差额。要解释同比增长，应以本期调整额减上期同口径调整额，再与报告利润增量相加。'+(s.match(/\n+$/)?.[0] || '');
    }
    if(/分部|分业务|分产品|分渠道/.test(question) && /回款|现金流/.test(question) &&
        /(?:合并|集团)(?:口径)?(?:收现比|现金转化率)/.test(s) && /均合并口径/.test(s)) {
      s=s.replace(/均合并口径[。.]?/,'该指标是合并口径。定位到分部，需要将同一批业务的发货、应收、预收与实际回款配对。');
    }
    // A forecast with several necessary conditions fails as soon as any
    // condition fails over the stated horizon. Preserve the original thresholds.
    if(/可证伪|推翻条件|证伪条件/.test(question)) {
      s=s.replace(/(预测[：:]([^。\n]{6,180})。)若([^。\n]{4,130})，则命题被推翻。/g,(whole,pred,condition,trigger)=>
        /且|，.{2,40}(?:不低于|保持|不会)/.test(condition) &&
        !/约|大致|可能|通常|允许|容忍|指引|置信区间|或者|[或「“\[\]【】]/.test(condition) &&
        !/[「“\[\]【】]|来源|年报/.test(trigger)
          ? pred+'按上述期限逐项检验，任一条件未达到即推翻。' : whole);
    }
    return s.split(/(「[^」]*」|“[^”]*”|\[[^\]\n]*\]\([^)\n]*\)|<[^>\n]+>)/g).map((part,i)=>{
      if(i%2)return part;
      // A change in revenue can reflect outlet count or sales per outlet.
      // Preserve an unidentified rate as such without silently assigning it
      // either to outlet count or to same-store sales.
      const history=part.replace(/(?:由|从)(?:原引|先前引用的|此前引用的|上轮引用的)([+-]?[\d,.]+(?:亿元|万元|倍|%|港元|元))更正为/g,(all,old)=>{
        if(!/修订|复盘|更正|回顾/.test(question))return all;
        const value=old.replace(/,/g,'');
        return priorAnswers.some(a=>a.text?.replace(/[,\s]/g,'').includes(value))
          ? all : '按本轮资料列示为';
      });
      return history.split(/(?<=[。！？\n])/).map(sentence=>{
        if(/不能(?:说|认为|声称|断言)|不(?:应|宜)(?:认为|写成)|错误(?:示范|说法)|这一说法错误/.test(sentence))return sentence;
        return qualifyInvestment(sentence)
        .replace(/((?:营收|收入)[^。；\n]{0,15}(?:包括|含|包含)[^。；\n]{0,10})(?:开店|拓店)[（(]([+−-]?[\d.]+%)[)）]/g,
          '$1新店贡献（$2对应的指标待核）。需分别看店数和同店收入')

        .replace(/(?:票据结算|以票据结算)(?:不会|不)形成预收(?=[。；])/g,'收票早于履约也可能形成预收，须核对收票、履约和兑付日')
        .replace(/(售价|单价)降幅不大于(?:电芯|原料)?单位成本降幅，((?:单[A-Za-z]+|单位)毛利稳定或上升)/g,'每单位$1减少额不大于全部单位成本节省额，$2')
        .replace(/只有([^。\n]{1,60}(?:账龄|回款)[^。\n]{0,60})同时出现，才升级为收入真实性疑点/g,'$1同时出现应升级调查。单项直接反证（如客户否认交易）也足以启动核查')
        .replace(/(?:因此)?该笔收入真实性基本成立/g,'该笔的履约和收款风险下降，收入截止与退货条款仍须核查')
        .replace(/((?:报价|溢价|价格)[^。；\n]{0,60})，支持供给与成本改善/g,'$1，支持供给改善。判断成本还须比较同产品、同利用率的单位成本')
        .replace(/(合计多占用\s*[*]*[\d.]+[*]*)，远高于利润增量[\d.]+/g,'$1。余额变动只能提示占款，要解释经营现金流同比变化还缺两期营运资金调整及其他非现金项');
      }).join('');
    }).join('');
  }).join('');
}
