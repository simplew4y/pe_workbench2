// Scope the fallback's dependency checks to the original complete Markdown.
// This is deliberately conservative for unscoped summaries: a new heading
// alone does not prove independence, and a title saying "verified" is no proof.
const plain = text => String(text || '').replace(/[*`#]/g, '').replace(/\s+/g, ' ').trim().replace(/^(?:[-+•]|\d+[.)])\s+/, '');
const overlaps = (a,b) => !!plain(a) && !!plain(b) && (plain(a).includes(plain(b)) || plain(b).includes(plain(a)));
const verdictHeading = text => /^(?:结论|判断|小结|总结|综合判断|核心判断|投资结论|估值结论)(?:[：:]|$)/u.test(plain(text));
const globalConclusion = text => /^(?:综上|总之|综合上述|总体(?:上|而言)|整体(?:上|而言))/u.test(plain(text));
const titleAlias = text => plain(text).replace(/^[\d一二三四五六七八九十]+[.、）)\s]+/, '')
  .replace(/[（(].*?[）)]/g, '').replace(/(?:分析|情况|概况|表现)[：:]?$/, '').trim();

// Disclosed research procedures respond to a missing premise; they do not
// assert its financial consequence. Keep these qualifications, while any
// finding on the sentence itself still blocks it in the delivery layer.
function qualifiedProcedure(text) {
  const value=plain(text);
  if (/证明|证实|推翻|买入|卖出|低估|高估|兑现|必然|确定|保证/.test(value)) return false;
  if (/^(?:因此|所以|据此|由此)[，,]?\s*(?:(?:后续|下一步|本次|本轮|我们)(?:将|会|需要|应|暂)?\s*)?(?:核验|核对|补查|检查|跟踪|补充资料|保留缺口|保留待核)/.test(value)) return true;
  return /^(?:因此|所以|据此|由此)[，,]?\s*(?:本(?:次|轮)?(?:框架|分析|研究|报告)|本文)/.test(value) &&
    /(?:用|采用|使用|以).+(?:替代|代理)/.test(value) && /保留(?:缺口|待核)|仅作代理|口径不同/.test(value);
}

export function answerDependencies(tokens, findings, dependent) {
  const root = {parent:null, depth:0, title:'', tokens:[], children:[]};
  const sections=[root], owners=new Map();
  let current=root;
  for (const token of tokens) {
    if (token.type==='heading') {
      while (current.parent && current.depth>=token.depth) current=current.parent;
      const child={parent:current, depth:token.depth, title:token.text, tokens:[], children:[]};
      current.children.push(child);sections.push(child);current=child;
    }
    current.tokens.push(token);owners.set(token,current);
  }
  const financial=findings.filter(f=>f.rule!=='artifact_status');
  const span=f=>f.sourceText || f.excerpt;
  for (const section of sections) {
    section.localBad=financial.some(f=>span(f) && section.tokens.some(t=>overlaps(t.raw,span(f))));
    section.premise=section.tokens.some(t=>!['heading','space'].includes(t.type) && plain(t.raw) &&
      !dependent(t.raw) && !financial.some(f=>span(f) && overlaps(t.raw,span(f))));
  }
  for (const section of [...sections].reverse()) section.bad=section.localBad || section.children.some(s=>s.bad);
  const unknown=financial.some(f=>!span(f) || !tokens.some(t=>overlaps(t.raw,span(f))));
  const aliases=new Set(sections.filter(s=>s.bad).map(s=>titleAlias(s.title)).filter(s=>s.length>=2 && !verdictHeading(s)));
  for (const f of financial) {
    if (f.claim?.company) aliases.add(f.claim.company);
    // Subject explicitly named in a rejected assertion, even under a generic
    // heading. These are extracted from the draft, never company-specific rules.
    const subject=plain(span(f)).match(/^(?:因此|所以|据此)?[：:]?([^，。；：:\d]{1,24}?(?:公司|业务|产品|板块))/u)?.[1];
    if (subject) aliases.add(subject);
  }
  return (text,token) => {
    if (!dependent(text)) return false;
    if (qualifiedProcedure(text)) return false;
    if (unknown) return true;
    if (globalConclusion(text) && root.bad) return true;
    if ([...aliases].some(alias=>plain(text).includes(alias))) return true;
    let section=owners.get(token) || root;
    // A conclusion-only section inherits its premises instead of resetting
    // the dependency boundary. A clean substantive section can stand alone.
    while (section.parent && (verdictHeading(section.title) || !section.premise && !section.bad)) section=section.parent;
    return section.bad;
  };
}
