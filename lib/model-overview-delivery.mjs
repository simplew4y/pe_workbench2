import {asksModelOverview} from '../ui/chat/model-overview.js';
import {supportedCells} from './retained-read-evidence.mjs';
import {requestedAnswerLength} from './answer-length.mjs';

const bridge=/^(?:但(?:是)?|然而|不过|可是|尽管如此)[，,\s]*/;
const heading=/^#{1,3}\s+([^\n]+)$/;
const risk=/风险|偏弱|偏高|偏低|偏保守|激进|合理性|可靠性|不一致|口径问题|不确定|哪里要小心|成立条件|观察信号|该盯/;
const strip=s=>s.replace(/[*#\x60]/g,'').trim();
const ref=c=>'['+c.filename+']'+c.locator;
const bookKey=c=>JSON.stringify([c.materialId,c.version,c.sha256]);
const plainCell=c=>c.id && c.materialId && c.version && c.sha256 && c.filename && !/[\r\n[\]<>]/.test(c.filename) && c.locator && !c.derivedFrom;
const usableText=s=>typeof s==='string' && s.length<=80 && !/[\n\r\x60*<>[\]]/.test(s);

export function brokenOverviewLead(text) {
  const first=String(text || '').split(/\n/).map(strip).find(s=>s && !/^(?:判断|核心画像|模型导读|模型概览|结论)$/.test(s)) || '';
  return bridge.test(first) || /^(?:此项判断证据不足|模型的.{0,14}假设.{0,6}激进|我用对数法)/.test(first);
}

export function overviewLayoutIssue(draft, requireSections=false) {
  if(brokenOverviewLead(draft))return '第一句缺少能独立阅读的模型画像';
  const titles=[...draft.matchAll(/^#{1,3}\s+([^\n]+)/gm)].map(m=>m[1]);
  const model=titles.findIndex(t=>/怎么算|经营|驱动|估值方法|估值路径|模型骨架|业务逻辑/.test(t) && !risk.test(t));
  const warning=titles.findIndex(t=>risk.test(t) || /哪些假设要小心/.test(t));
  if(warning>=0 && (model===-1 || warning<model))return '在解释经营与估值路径之前就进入了风险审计';
  if(requireSections && (model<0 || warning<0))return '导读尚未分清模型骨架、经营驱动与关键风险，应在对应部分交代各项内容';
  if(/(?:我用|我按)(?:对数法|ln\()[^\n。]{0,70}(?:反解|复算|验证|折现)/i.test(draft))return '应给出折现期限及其依据，技术核验过程留在后台';
  return '';
}

function portrait(answer,messages) {
  const reads=messages.filter(m=>m.role==='toolResult' && m.isError===false && ['workbook_trace','workbook_query'].includes(m.toolName));
  const cells=supportedCells(reads.flatMap(m=>(m.details?.citations || []).filter(plainCell)));
  const prices=cells.filter(c=>Number.isFinite(c.value) && /(?:^|[;；]\s*)(?:TP|Target Price|Price Target|目标价)(?:\s*[(（][^()（）]*[）)])?$/i.test(c.metric || '') &&
    answer.citations.some(d=>d.id===c.id && d.value===c.value && bookKey(c)===bookKey(d)));
  if(prices.length>1 || new Set(cells.map(bookKey)).size!==1)return null;
  const price=prices[0], sheet=price?.locator.split('!')[0];
  const unit={rmb:'元',cny:'元','元':'元','元/股':'元','rmb/sh':'元','cny/sh':'元',hkd:'港元','港元':'港元','港元/股':'港元','hkd/sh':'港元',usd:'美元','美元':'美元','美元/股':'美元','usd/sh':'美元'}[String(price?.display_unit).toLowerCase()];
  if(price && (!unit || !answer.text.includes(price.locator)))return null;
  const covers=cells.filter(c=>/^(?:cover(?: page)?|封面|首页)!/i.test(c.locator) && usableText(c.value));
  const tagged=covers.filter(c=>/^(?:company(?: name)?|issuer|公司(?:名称)?|标的)$/.test(String(c.metric).toLowerCase()));
  const candidates=tagged.length?tagged:covers.filter(c=>/^.{1,45}\s*[(（](?:[A-Z0-9]{1,10}(?:\.[A-Z]{1,4})?)[)）]$/i.test(c.value) && !/team|contact|analyst|评级/i.test(c.value));
  if(new Set(candidates.map(c=>c.value)).size!==1)return null;
  const cover=candidates[0];
  let name=cover.value;
  const symbol=/\((\d{6})\.(SS|SZ|SH)\)/i.exec(name);
  if(symbol){
    const code=(symbol[2].toUpperCase()==='SZ'?'sz':'sh')+symbol[1];
    const verified=messages.filter(m=>m.toolName==='westock_query' && m.isError===false).map(m=>m.details?.identity)
      .filter(d=>d?.verified===true && String(d.code).toLowerCase()===code && usableText(d.name));
    if(new Set(verified.map(d=>d.name)).size===1)name=verified[0].name;
  }
  const sources=price?[cover,price]:[cover];
  const business=covers.find(c=>/^(?:主营业务|业务|business(?: description)?|industry|行业)$/i.test(c.metric || '') && c.value!==c.metric);
  const demand=cells.find(c=>c.locator.split('!')[0]===sheet && /^\d{4}E$/.test(c.period || '') && usableText(c.value) && /\b(?:rising|growing|increasing)\s+([\w -]{1,35}?)\s+(?:end\s+)?demand\b/i.test(c.value));
  const product=demand?.value.match(/\b(?:rising|growing|increasing)\s+([\w -]{1,35}?)\s+(?:end\s+)?demand\b/i)?.[1];
  const businessText=business?business.value:product;
  if(business || demand)sources.push(business || demand);
  const methods=cells.filter(c=>c.locator.split('!')[0]===sheet && typeof c.value==='string' &&
    /^(?:discounted (?:P\/?E|cash flow)|DCF|SOTP|sum of the parts|net asset value|市盈率估值|现金流折现|分部估值)$/i.test(c.value));
  const method=new Set(methods.map(c=>c.value.toLowerCase())).size===1?methods[0]:null;
  const methodName=method && (/^(?:discounted P\/?E|市盈率估值)$/i.test(method.value)?'市盈率估值':
    /DCF|cash flow|现金流/i.test(method.value)?'现金流折现估值':/SOTP|sum of|分部/i.test(method.value)?'分部估值':'净资产估值');

  const pe=methodName==='市盈率估值' && cells.find(c=>c.locator.split('!')[0]===sheet && Number.isFinite(c.value) && /^(20\d{2})E?\s+target P\/?E$/i.test(c.metric || '') && answer.citations.some(d=>d.id===c.id));
  if(pe || method)sources.push(pe || method);
  const at=c=>'（'+ref(c)+'）';
  const scope=businessText?'的 '+businessText+(business?'':' 业务')+at(business || demand):'的经营业绩';
  const year=pe?pe.metric.slice(0,4)+' 年的目标市盈率':'';
  const discounted=price?.metric.match(/discounted back to (\d{4})/i)?.[1];
  const valuation=year?'按 '+year+'估值':methodName?'采用'+methodName:'';
  const profile='这份模型预测'+name+at(cover)+scope+'，'+(valuation?valuation+at(pe || method)+'，':'')+
    (price?(discounted?'折回 '+discounted+' 年后，':'')+'每股目标价为 '+price.value+' '+unit+at(price):'下文按表内的经营预测解释收入和盈利')+'。';
  const operating=[];
  if(demand)operating.push('模型假设 '+product+' 需求增长'+(/capacity expansion/i.test(demand.value)?'，同时扩大产能':'')+at(demand)+'。');
  // Show the source's own revenue -> gross profit bridge when all three cells
  // share the year, currency and amount scale, and the formula actually ties.
  const profit=cells.find(c=>/^(?:gross profits?|毛利)$/i.test(c.metric || '') && /^\d{4}E$/.test(c.period || '') &&
    Number.isFinite(c.value) && /^=\$?[A-Z]{1,3}\$?\d+-\$?[A-Z]{1,3}\$?\d+$/.test(c.formula || ''));
  if(profit){
    const sheet=profit.locator.split('!')[0]+'!';
    const [rev,cost]=profit.formula.slice(1).replace(/\$/g,'').split('-').map(a=>cells.find(c=>c.locator===sheet+a));
    const scale=profit.display_unit;
    if(/^(?:revenues?|营业收入)$/i.test(rev?.metric) && /^(?:COGS|cost of (?:goods sold|sales)|营业成本)$/i.test(cost?.metric) &&
      rev.period===profit.period && cost.period===profit.period && scale===cost.display_unit && scale===rev.display_unit &&
      ['百万元','亿元','万元'].includes(scale) && [rev,cost].every(c=>c.currency===profit.currency && Number.isFinite(c.value)) &&
      Math.abs(rev.value-cost.value-profit.value)<1e-7*Math.max(1,Math.abs(profit.value))){
      const divisor=scale==='百万元'?100:scale==='万元'?10000:1;
      const show=c=>Math.abs(profit.value)>=divisor && c.currency==='CNY'
        ? Number((c.value/divisor).toFixed(2))+' 亿元'+at(c) : Number(c.value.toFixed(2))+' '+scale+at(c);
      operating.push(profit.period.slice(0,4)+' 年，模型预计收入 '+show(rev)+'，扣除营业成本 '+show(cost)+'，得到毛利 '+show(profit)+'。');
      sources.push(rev,cost,profit);
    }
  }
  if(!price && !operating.length)return null;
  const assumption=operating.join('');
  return {profile,assumption,sources};
}

// Move complete Markdown sections, keeping tables, source links and local caveats together.
// Only repair a damaged opening when the saved turn has an unambiguous source-backed replacement.
export function restoreModelOverview(answer,question,messages) {
  if(!asksModelOverview(question) || !['partial','completed'].includes(answer.status) ||
      requestedAnswerLength(question) || /^(?: {0,3})(?:\x60{3}|~{3})/m.test(answer.text))return answer;
  const firstLine=answer.text.trimStart().split('\n')[0];
  const broken=brokenOverviewLead(answer.text) || (heading.test(firstLine) && risk.test(firstLine));
  const layout=overviewLayoutIssue(answer.text);
  if(!broken && !layout)return answer;
  const evidence=broken?portrait(answer,messages):null;
  if(broken && !evidence)return answer;
  const blocks=answer.text.split(/\n\s*\n/), intro=[], model=[], concerns=[], appendix=[];
  let section=intro;
  for(let block of blocks){
    const h=heading.exec(block.split('\n')[0]);
    if(h){
      const title=h[1].replace(/^(?:[一二三四五六七八九十]+|\d+)[、.．]\s*/,'');
      if(broken && section===intro && /^(?:判断|核心画像|模型导读|模型概览|结论)$/.test(title) && block===h[0])continue;
      section=/计算依据|附录|原始依据/.test(title)?appendix:(risk.test(title) || /哪些假设要小心/.test(title))?concerns:model;
      block=block.replace(h[0],'### '+title);
    }
    // Strip internal verification narration only for a standalone check whose
    // actual discount period is also stated later in the retained valuation.
    if(/^我(?:用|按)对数法(?:反解|复算)折现[^。！？\n]*[。.]$/.test(block) &&
        !block.includes('!') && /(?:与.{0,12}(?:公式|原表).{0,15}\d+\s*年一致|折现\s*\d+\s*(?:年|期))/.test(answer.text))continue;
    if(/^复算折现年数[^。！？\n]{0,80}与公式固定[^。！？\n]+一致。$/.test(block) && !block.includes('!'))continue;
    // A sourced explanation of how a multiple was chosen belongs with the
    // valuation, even when an old answer put it under a reliability heading.
    if(section===concerns && /^(?:这个倍数|目标(?:市盈率|倍数)).*?(?:取自|来自|由)/.test(block) &&
        /可比公司|同业/.test(block) && /回归|中位数|均值/.test(block) && block.includes('!') &&
        !/[\n]|但是|然而|不稳|局限|偏弱|离群|不能|不具备/.test(block)){
      model.push(block.replace(/^这个倍数/,'目标市盈率'));
      continue;
    }
    if(/^(?:\*\*)?(?:仍待核实|证据边界|保存状态)(?:\*\*)?[：:]/.test(block))section=appendix;
    section.push(block);
  }
  if(!model.length || !concerns.length || (!broken && !intro.length))return answer;
  const original=intro.join('\n\n').replace(bridge,'').replace(/(?:这个数字本身的)?结构可以复算[，,]业务含义不能照单全收/g,'取决于这些假设能否兑现');
  const text=[evidence?.profile || intro.join('\n\n'),'## 模型怎么算',evidence?.assumption,...model,'## 哪些假设要小心',broken?original:'',...concerns,...appendix].filter(Boolean).join('\n\n');
  return {...answer,text,citations:[...new Map([...answer.citations,...(evidence?.sources || [])].map(c=>[c.id,c])).values()]};
}
