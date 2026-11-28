// Links always open an immutable material version in its owning project.
export function calculationPageLinks(parents, projectId) {
  if (!projectId) return [];
  const links = new Map();
  for (const parent of parents) {
    const page = /^p\.([1-9]\d*)\/r\d+c\d+$/.exec(parent.locator)?.[1];
    if (!page || parent.role !== 'pdf_number' || !parent.sha256) continue;
    const base = '/api/materials/'+encodeURIComponent(parent.materialId)+'/versions/'+parent.version+'/file';
    const key = base+'#'+page;
    if (!links.has(key)) links.set(key, {base,page,parents:[]});
    links.get(key).parents.push(parent);
  }
  return [...links.values()].map(({base,page,parents}) => {
    const params = new URLSearchParams({project:projectId,source:parents.map(p=>p.locator).join(',')});
    return {href:base+'?'+params+'#page='+page,page,parents};
  });
}

export function pdfResultMarkdown(result, parents, projectId) {
  const links = calculationPageLinks(parents, projectId);
  if (!links.length) return '';
  return links.map(({href,page}, i) => '['+(i ? 'p.'+page : escapeMd(result.value+' '+result.display_unit))+']('+href+')').join('、');
}

const escapeRegex = s => String(s).replace(/[.*+?^\x24{}()|[\]\\]/g,'\\$&');
const amountPattern = result => '(?<![\\d.,+\\-])'+escapeRegex(result.value)+'\\s*'+escapeRegex(result.display_unit)+'(?![A-Za-z\\d/])';

export function mentionedPdfCalculations(text, citations) {
  const index = new Map(citations.map(c => [c.id,c]));
  const matches = [];
  for (const result of citations) {
    if (!result.derivedFrom?.length || !result.display_unit) continue;
    const parents = result.derivedFrom.map(id=>index.get(id));
    if (parents.some(p=>!p) || !parents.some(p=>p.role==='pdf_number')) continue;
    const pattern = new RegExp(amountPattern(result));
    if (pattern.test(text)) matches.push({result,parents});
  }
  return matches;
}

const escapeMd = value => String(value).replace(/[\\[\]\x60*_<>|]/g,'\\$&').replace(/\s+/g,' ');
const normalizedYear = value => String(value).replace(/[〇零一二三四五六七八九]{4}年/g, year =>
  [...year.slice(0,-1)].map(c => c === '〇' ? 0 : '零一二三四五六七八九'.indexOf(c)).join('')+'年');

// Plain prose can omit the tool's Markdown. Link a declared page inline only
// with an unambiguous result and matching period. Otherwise label the verified
// calculation separately, without attributing the prose claim by value alone.
export function deliverPdfCalculationLinks(text, matches, projectId, normalizeMetric = String) {
  if (!projectId || !matches?.length) return text;
  const notes = new Set();
  for (const {result,parents} of matches) {
    const markdown = pdfResultMarkdown(result,parents,projectId);
    if (!markdown || text.includes(markdown)) continue;
    const pages = calculationPageLinks(parents,projectId);
    const number = new RegExp(amountPattern(result),'g');
    const siblings = matches.filter(m=>m.result.value === result.value && m.result.display_unit === result.display_unit);
    let linked = false;
    if (siblings.length === 1 && parents.length === 1) {
      const year = normalizedYear(parents[0].period).match(/(?:19|20)\d\d/)?.[0];
      text = text.replace(number, (label, index, body) => {
        const before = body.slice(0,index).split(/[。；;！？\n（(]/).pop();
        const after = body.slice(index+label.length);
        const refs = /^[，,（(\s]*(p\.\d+(?:[、,，\s]+p\.\d+)*)/i.exec(after)?.[1];
        const metric = String(parents[0].metric).replace(/\s*[（(][a-z][)）]$/i,'').trim();
        if (!metric || !normalizeMetric(before).replace(/(?:为|為|是|约|約|[:：])\s*$/u, '').trimEnd().endsWith(normalizeMetric(metric)) || !refs || !refs.toLowerCase().match(/p\.\d+/g)?.includes('p.'+pages[0].page) ||
            !year || normalizedYear(before).match(/(?:19|20)\d\d/g)?.at(-1) !== year) return label;
        // Quarter and year can have identical ending dates; require explicit
        // matching duration for interim columns and never attach FY to a quarter.
        const interim = /季度?|[個个]月|quarter|months|半年|[QH][1-4]/i;
        if (interim.test(parents[0].period) || interim.test(before)) return label;
        linked = true;
        return markdown;
      });
    }
    if (!linked) {
      const source = parents.map(p=>[p.period,p.metric].filter(Boolean).map(escapeMd).join(' ')).join('、');
      notes.add(source+' · '+(result.role?.startsWith('derived_calc_') && result.metric ? escapeMd(result.metric)+' ' : '')+markdown);
    }
  }
  return notes.size ? text+'\n\n'+[...notes].map(n=>'计算出处：'+n).join('\n\n') : text;
}
