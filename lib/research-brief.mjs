import {Lexer} from 'marked';
import {visibleAnswerChars} from './answer-length.mjs';

const references = /https?:\/\/|\[[^\]]+\]|![A-Z]+\$?\d+|[Pp]\.?\s*\d+|第.{1,8}页|年报|季报|公告|出处|来源/;
const qualified = /若|如果|除非|假设|前提|只有|尚|未知|待核|不能|不得|不足以|不一定|未披露|无法|不可比|取决于|分母|口径|但|然而|否则/;
const decision = /判断|上调|下调|维持|撤回|证伪|推翻|失效|置信度|支持|反证/;
const example = /^(?:例如|举例(?:来说)?|举个例子|打个比方)[：:，,]?/;
const protectedSyntax = /(“[^”\n]*”|「[^」\n]*」|\x60[^\x60]*\x60|\[[^\]\n]*\]\([^\n)]*\)|\[[^\]\n]*\][A-Za-z\d_ .!$:-]+|<https?:\/\/[^<>\s]+>|https?:\/\/[^\s<>，；。）》）\]]+)/g;

function tightenProse(text) {
  return text.split(protectedSyntax).map((part,i)=>{
    if(i%2) {
      if(!/^https?:\/\//.test(part))return part;
      try {
        const url=new URL(part);
        return '['+url.hostname+'](<'+part+'>)';
      } catch {return part;}
    }
    return part.replace(/^结论[：:]\s*(?=原推理|不成立|不能|不足以)/,'')
      .replace(/(?:沿用上一轮题设|按上述情景假设)[，,]/g,'按题设，')
      .replace(/如果([^，。]{1,20})这一点成立/g,'若$1成立')
      .replace(/(?:这)?两(?:个|项)指标比较的是同一对期间/g,'两指标期间一致')
      .replace(/因此可以得出|由此可以得出/g,'可得')
      .replace(/若要判断是否|要判断是否/g,'判断是否')
      .replace(/不能直接(?:据此)?推(?:出|断)/g,'不能推出')
      .replace(/不(?:能|可)直接换算(?:成|为)?/g,'不能换算为')
      .replace(/并不等于/g,'不等于').replace(/与此同时[，,]/g,'同时，')
      .replace(/所(?:提供|给出)的/g,'给的').replace(/基于上述(?:分析|结果)[，,]/g,'')
      .replace(/(?:的)?变化情况(?=[，。；])/g,'变化')
      .replace(/只有在([^，。；]{1,24})的条件下/g,'仅在$1时')
      .replace(/(?:是否|究竟能否)能够/g,'能否')
      .replace(/(?:若|如果)要(?:进一步)?验证/g,'要验证')
      .replace(/在([^，。；]{1,15})这一(?:前提|条件)下/g,'在$1前提下')
      .replace(/则(?:说明|表明)/g,'则表明')
      .replace(/因此，/g,'故').replace(/可以给/g,'可给')
      .replace(/都针对((?:20\d{2}年)?年报未披露项)，(?:其)?回答会直接改变估值假设/g,'涉及$1')
      .replace(/(20\d{2})年年报/g,'$1年报').replace(/(?:占比|比重)为/g,'占比')
      .replace(/(?:如何|是多少|是什么)[？?](?=若)/g,'？')
      .replace(/只有在/g,'仅在').replace(/连续两(?:个)?季度/g,'连续两季')
      .replace(/(收入|利润|单价|单位成本|销量|份额|毛利额|毛利率|售价)(?:下降|降低)(\d+(?:\.\d+)?%)/g,'$1降$2')
      .replace(/(收入|利润|单价|单位成本|销量|份额|毛利额|毛利率|售价)(?:增长|上升)(\d+(?:\.\d+)?%)/g,'$1增$2')
      .replace(/(?:企业|公司)自己已把/g,'公司已将')
      .replace(/(?:以下|上述)(?:几项|各项)数据/g,'这些数据')
      .replace(/需要进一步(?:核实|核查)/g,'待核')
      .replace(/这一情景中[，,]/g,'此时，').replace(/其余参数固定时/g,'其余不变时')
      .replace(/相关系数改为\s*([−+\d.-]+)\s*后/g,'相关系数为$1时').replace(/波动率为方差的平方根/g,'波动率=√方差')
      .replace(/下一步最值得获取[：:]/g,'待取：')
      .replace(/仍需对照原表确认/g,'待核原表').replace(/回答会直接改变/g,'影响')
      .replace(/可以提高对其([^，。；]{1,8})的信心/g,'增强对$1的信心')
      .replace(/(?:说明|表明)([^，。；]{1,16})更有意义/g,'使$1更有解释力')
      .replace(/同比(?:增长|增加|上升)\s*([0-9.]+%)/g,'同比+$1')
      .replace(/同比(?:下降|减少)\s*([0-9.]+%)/g,'同比−$1')
      .replace(/可直接观察/g,'可观察').replace(/可以保留/g,'可保留')
      .replace(/不能把([^，。]{1,12})直接当作/g,'不能将$1视为')
      .replace(/(?:需要(?:特别)?指出的是|值得(?:一提|注意)的是|具体而言|换句话说|从这个角度来看|之所以如此，是因为)[，：:]?/g,'')
      .replace(/在其他(?:所有)?条件(?:均)?保持不变的(?:情况|前提)下/g,'其余条件不变时')
      .replace(/不(?:能|可以)直接据此推(?:出|断)/g,'不能据此推断')
      .replace(/是否能够/g,'能否').replace(/的情况下(?=[，。])/g,'时')
      .replace(/招股说明书中披露的/g,'招股书披露的')
      .replace(/。{2,}/g,'。');
  }).join('');
}

const segments=new Intl.Segmenter('zh',{granularity:'word'});
function words(s) {
  return Array.from(segments.segment(s),x=>x.segment).filter(x=>/[\p{L}\p{N}]/u.test(x));
}
function duplicateRecap(raw,context) {
  const items=raw.split(/[：:]/).at(-1).replace(/[。.]$/,'').split('、');
  if(items.length<3)return false;
  const missing=context.split(/[。；！？\n]/).filter(s=>/缺|未知|未给|待核|需核实|未披露|需补/.test(s));
  return items.every(item=>item.length>=2 && missing.some(clause=>clause.includes(item)));
}
function signature(s) {return s.replace(/[*_\s]/g,'').replace(/[。；;]$/,'');}

// Work with whole sentences inside a single argument. A later paragraph can
// carry a different issuer, baseline or time horizon even if it looks similar.
function trimBlock(raw,question,remaining) {
  if(/["“”「」\[\]\x60]/.test(raw))return raw;
  const parts=raw.match(/[^。！？\n]+[。！？]?|[。！？\n]/g) || [raw];
  const seen=new Set(), kept=[];
  for(const s of parts) {
    const key=signature(s);
    if(key.length>8 && seen.has(key) && !references.test(s))continue;
    if(key)seen.add(key);
    kept.push(s);
  }
  for(let i=kept.length-1;i>0 && remaining()>0;i--) {
    const s=kept[i].trim();
    if(!example.test(s) || /\d|[%‰]/.test(s) || /举例|例子|例如说明/.test(question) || references.test(s) || qualified.test(s) || decision.test(s))continue;
    if(kept.slice(i+1).some(x=>/^(?:这|该|其|因此|所以|由此)/.test(x.trim())))continue;
    kept.splice(i,1);
  }
  return kept.join('');
}

// Fit an existing answer without manufacturing evidence or dropping a
// section to meet the cap. Unknown terminology, periods, formulas, source
// links and conditional qualifications stay with the statement they support.
export function compactResearchBrief(text,question,limit) {
  if(!limit || visibleAnswerChars(text)<=limit || /原文照录|逐字|逐句引用|逐字引用|原样返回|原样输出/.test(question))return text;
  if(/^\s*[\[{]/.test(text.trim()) || /^\s*(?:---|\x60{3}|~~~)/m.test(text))return text;
  let over=visibleAnswerChars(text)-limit;
  const tokens=Lexer.lex(text), output=[];
  for(const [i,t] of tokens.entries()) {
    if(!['paragraph','list','blockquote'].includes(t.type) || /\|.+\|/.test(t.raw)) {output.push(t.raw);continue;}
    let raw=t.raw;
    // A lead-in that only announces the immediately following numbered list
    // can go. Keep its source, timing and data availability qualifications.
    if(over>0 && t.type==='paragraph' && /[:：]\s*$/.test(raw) &&
        !references.test(raw) && !qualified.test(raw) && !/\d|[％%]|假设|口径|限制/.test(raw) &&
        /^(?:以下|下面|具体)[^。！？]{0,24}(?:问题|指标|清单|方面)[：:]\s*$/.test(raw.trim()) &&
        tokens.slice(i+1).find(x=>x.type!=='space')?.type==='list') {
      over-=visibleAnswerChars(raw);
      continue;
    }
    // A requested list of items still has to be present. Remove a recap only
    // if every whole item already occurs verbatim in the preceding text.
    if(over>0 && /^(?:\*{0,2})(?:还需|还缺|所需资料)(?:\*{0,2})[：:]/.test(raw.trim())) {
      if(duplicateRecap(raw.trim(),output.join(''))) {
        over-=visibleAnswerChars(raw);
        continue;
      }
    }
    if(over>0 && /^(?:情景条件|题设条件)[（(]非事实[）)][：:]/.test(raw) && /情景|假设/.test(question)) {
      const facts=words(raw.split(/[：:]/).slice(1).join('')).filter(w=>!['同比','增速','为','按'].includes(w));
      if(facts.length && facts.every(w=>question.includes(w) || /^[-+%]$/.test(w))) {
        const short='以下按题设情景推演。\n\n';
        over-=visibleAnswerChars(raw)-visibleAnswerChars(short);
        raw=short;
      }
    }
    if(over>0 && raw.startsWith('**证据边界**：部分引用的')) {
      raw=raw.replace(/^\*\*证据边界\*\*：部分引用的数值出处对应关系尚未完整识别，仍需对照原表确认。以上分析保留这一不确定性，不应视为这些数据已完成独立核验。/,'部分数值出处待对照原表。');
      raw=raw.replace(/部分引用的([^。]+?)尚未完整识别，仍需对照原表确认。以上分析保留这一不确定性，不应视为这些数据已完成独立核验。/,'部分引用的$1待核。');
      over-=visibleAnswerChars(t.raw)-visibleAnswerChars(raw);
    }
    if(over>0) {
      const initial=visibleAnswerChars(raw);
      const revised=tightenProse(raw);
      raw=t.type==='list'?revised:trimBlock(revised,question,()=>over);
      over-=initial-visibleAnswerChars(raw);
    }
    output.push(raw);
  }
  const result=output.join('').trim();
  return visibleAnswerChars(result)<visibleAnswerChars(text)?result:text;
}
