import { readableArchivedLine, groupFormulaProof, wantsWorkbookSyntax } from './workbook-formulas.js';
// Chat presentation only. The delivery, its findings and the original report
// keep their exact text. Match host templates, never arbitrary uncertainty.
const legacyBanner = '本次尚未完成全部核验。以下保留有依据的分析与成立条件；存在争议的数值及其确定性结论暂不采用。';
const reviewNotes = new Set([
  '补充复核暂未完成；以上分析仍需结合所列来源与证据缺口判断。',
  '> 补充复核暂未完成。以下按来源披露、模型假设和分析判断区分陈述，不代表全部结论已获独立验证。',
  '部分数值出处待对照原表。',
]);
const partialNotes = new Set([
  '> 本节部分内容尚未完成核验，相关数值及依赖结论暂不采用。',
  '> **待复核**',
]);
const dimension = '(?:数值出处对应关系|单位|期间|币种|指标口径|主体|合并范围|实际或预测口径|情景|来源信息)';
const dimensions = dimension + '(?:、' + dimension + ')*';
const boundary = new RegExp('^\\*\\*证据边界\\*\\*：部分引用的' + dimensions +
  '尚未完整识别，仍需对照原表确认。以上分析保留这一不确定性，不应视为这些数据已完成独立核验。$');
const shortBoundary = new RegExp('^(?:\\*\\*证据边界\\*\\*：)?部分引用的' + dimensions + '待核。$');
const fieldLabel = /^(?:部分结论的证据|部分补充核验未完成|答复完整性|[\p{L}\d%/]{1,24}的(?:数值|单位|币种|期间|指标口径|实际与预测口径|计算依据|来源|证据))$/u;

function presentLine(line, partial, inlineGaps) {
  if (reviewNotes.has(line) || boundary.test(line) || shortBoundary.test(line) || (partial && partialNotes.has(line))) return '';
  // Mixed lists can also contain a substantive missing input. Keep every
  // non-template item; never suppress a disclosure just because of its title.
  const checklist = /^\*\*仍待核实\*\*：(.+)。$/.exec(line);
  if (partial && checklist) {
    const items = checklist[1].split('；');
    const concrete = items.filter(item => !fieldLabel.test(item) || /缺少|尚缺|未披露|未取得|无法|不足以|未单列/.test(item));
    if (concrete.length === items.length) return line;
    return concrete.map(item => {
      if (/^[\p{L}、与]{2,40}的实际结果$/u.test(item)) {
        inlineGaps.push(item);
        return '';
      }
      return '尚待确认：' + item + '。';
    }).join('');
  }
  const calculation = /^\*\*核验范围\*\*：派生数值计算未成功：(.+)，相应结果尚不能确认。以上分析以已取得的资料为限。$/.exec(line);
  if (calculation) return '本次计算未得出' + calculation[1] + '。';
  // The reviewer recognises this marker at a sentence boundary. Display the
  // underlying limitation as prose when it already states the missing input
  // and its consequence. Keep checklists, code and quotations verbatim.
  if (!/^\s*(?:>|#{1,6} |\||\x60|<)/.test(line) && !line.includes('\x60') && !/[“”「」]/.test(line)) {
    return line.replace(/(^|[。！？])未核验[：:]\s*((?:缺少|尚缺|尚无|未取得)[^。！？\n]{1,180}?(?:无法|不能|只能|仅能)[^。！？\n]+)/gu,'$1$2');
  }
  return line;
}

// If a delivered observation quotes a bare amount, keep any qualification
// on that row. A missing unit in this receipt says nothing about other pages.
function qualifyAmount(line, citations) {
  if (!line.startsWith('- ') || !line.includes('（[')) return line;
  const observation = /^- (?:\d{4}E?\s+)?(.+?)\s+([+-]?\d+(?:\.\d+)?)（\[([^\]]+)\]([^）]+)）(?:，原式 \x60[^\x60]+\x60|，原表输入值)?。$/.exec(line);
  if (!observation) return line;
  const [, metric, value, filename, locator] = observation;
  if (!/^(?:(?:total |net |operating )?(?:revenue[s]?|income|profit|cash flow)|cash and (?:cash )?equivalents|cogs|现金及现金等价物|收入|营业收入|净利润|经营利润|营业成本)$/i.test(metric)) return line;
  const matches = citations.filter(c => c.filename === filename && c.locator === locator);
  if (matches.length !== 1) return line;
  const c = matches[0], hasUnit = u => u && !['unknown','unit_unknown'].includes(u);
  if (c.metric !== metric || !Number.isFinite(c.value) || Number(c.value.toPrecision(9)) !== Number(value) ||
      hasUnit(c.display_unit) || hasUnit(c.raw_unit)) return line;
  // Skip notes or headers that may already identify the scale independently.
  const excerpt = (c.excerpt || '').trim();
  if (excerpt && (!excerpt.endsWith('|') || /[$€¥£元万亿千]|\b(?:mn|mm|bn|thousands?|millions?|billions?|rmb|cny|hkd|usd|eur)\b/i.test(excerpt))) return line;
  return line + '这条取数记录未附金额单位，单凭该格无法换算成亿元。';
}

export function visibleAnswerText(message, question) {
  const text = message.text || '';
  if (message.role !== 'assistant' || !['partial','completed'].includes(message.status)) return text;
  const originalSyntax = wantsWorkbookSyntax(question);
  const partial = message.status === 'partial';
  const source = partial && (text === legacyBanner || text.startsWith(legacyBanner + '\n\n'))
    ? text.slice(legacyBanner.length).trimStart() : text;
  const lines = source.split('\n'), inlineGaps = [], topics = [];
  let fence = null, htmlEnd = null;
  for (const [i, raw] of lines.entries()) {
    const line = raw.trimEnd();
    const marker = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
      continue;
    }
    if (htmlEnd) {
      if (line.toLowerCase().includes(htmlEnd)) htmlEnd = null;
      continue;
    }
    const html = /^ {0,3}(?:<(pre|code|script|style|textarea)(?:\s|>)|<!--)/i.exec(line);
    if (html) {
      const end = html[1] ? '</' + html[1].toLowerCase() + '>' : '-->';
      if (!line.toLowerCase().includes(end)) htmlEnd = end;
      continue;
    }
    if (marker) { fence = marker[1]; continue; }
    const qualified = qualifyAmount(presentLine(line, partial, inlineGaps), message.citations || []);
    const presented = originalSyntax ? qualified : readableArchivedLine(qualified, message.citations || []);
    if (presented !== line) lines[i] = presented;
    const topic = /^(?:\*\*)?([\p{L}]{2,16})[：:](?:\*\*)?\s*\S/u.exec(line);
    if (topic && presented === line) topics.push({name:topic[1],index:i});
  }
  for (const item of inlineGaps) {
    const matching = topics.filter(t => item.startsWith(t.name));
    const sentence = '尚缺' + item + '。';
    if (matching.length === 1) lines[matching[0].index] += ' ' + sentence;
    else lines.push('', sentence);
  }
  return originalSyntax ? lines.join('\n') : groupFormulaProof(lines.join('\n'),message.citations);
}


// Some archived answers carry page markers in the prose and a page-to-file
// declaration in the bibliography. Reuse that document link at each marker
// only if one file accounts for every page. Do not invent a PDF page offset.
export function linkDeclaredPages(html) {
  if (!/\[P\d/.test(html) || !html.includes('来源') || typeof globalThis.document?.createElement !== 'function') return html;
  const template = document.createElement('template');
  template.innerHTML = html;
  const root = template.content, pages = new Map(), sources = new Set();
  for (const p of root.querySelectorAll('p')) {
    if (p.closest('blockquote,pre') || !/^来源[：:]/.test(p.textContent)) continue;
    const links = p.querySelectorAll('a[href]');
    if (links.length !== 1) return html;
    const anchor = links[0], href = anchor.getAttribute('href');
    if (!/^https?:\/\//i.test(href)) return html;
    const range = document.createRange();
    range.selectNodeContents(p); range.setEndBefore(anchor);
    const prefix = range.toString();
    const ref = /^来源[：:]\s*([^，,；;：:]{1,70}?)\s*P(\d+(?:\/P?\d+)*)\s*[，,]\s*$/i.exec(prefix);
    if (!ref) return html;
    sources.add(p);
    for (const page of ref[2].split(/\/P?/i)) {
      const prior = pages.get(page);
      pages.set(page,prior === null || (prior && prior.href !== href) ? null : {href,title:ref[1]});
    }
  }
  if (!pages.size) return html;
  const declared = new Set([...sources].map(p => p.querySelector('a').getAttribute('href')));
  if ([...root.querySelectorAll('a[href]')].some(a => /^https?:/i.test(a.href) && !declared.has(a.getAttribute('href')))) return html;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  let changed = false;
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || sources.has(parent.closest('p')) || parent.closest('a,code,pre,blockquote,button')) continue;
    const text = node.textContent, fragment = document.createDocumentFragment();
    let pos = 0;
    for (const m of text.matchAll(/\[P(\d+(?:\/P?\d+)*)\]/gi)) {
      const refs = m[1].split(/\/P?/i).map(page => pages.get(page));
      if (!refs[0] || !refs.every(ref => ref?.href === refs[0].href)) continue;
      fragment.append(text.slice(pos,m.index));
      const a = document.createElement('a');
      a.href = refs[0].href; a.title = refs[0].title; a.textContent = m[0];
      a.target = '_blank'; a.rel = 'noopener noreferrer'; fragment.append(a);
      pos = m.index + m[0].length;
    }
    if (pos) { fragment.append(text.slice(pos)); node.replaceWith(fragment); changed = true; }
  }
  return changed ? template.innerHTML : html;
}
