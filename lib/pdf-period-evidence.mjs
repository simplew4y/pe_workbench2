// Match explicit period labels on financial flows. A report's publication
// year, a balance-sheet date, or a nearby column must not supply the period.
const flows = [
  ['free_cash_flow', '自由[现現]金流(?:量)?|free cash flow'],
  ['operating_cash_flow', '[经經][营營]活[动動](?:所)?[产產]生的[现現]金流量[净淨][额額]|[经經][营營]活[动動][现現]金流(?:量)?[净淨][额額]|[经經][营營](?:性)?[现現]金流(?:量)?(?:[净淨][额額])?'],
  ['investment_cash_flow', '投[资資]活[动動](?:所)?[产產]生的[现現]金流量[净淨][额額]'],
  ['financing_cash_flow', '[筹籌][资資]活[动動](?:所)?[产產]生的[现現]金流量[净淨][额額]'],
  ['revenue', '[营營][业業](?:[总總])?收入'],
  ['net_profit_attributable', '[归歸]母[净淨]利[润潤]|[归歸][属屬]于上市公司股[东東]的[净淨]利[润潤]'],
  ['operating_profit', '[经經][营營](?:盈利|利[润潤])'],
];
const claimTail = String.raw`\s*(?:(?:[为為是]|[约約]|[仅僅]|大[约約]|合[计計]|[达達](?:到)?|曾|降至|[录錄]得|[：:])\s*)*$`;
const flowAtAmount = new RegExp(`(${flows.map(([, labels]) => labels).join('|')})${claimTail}`, 'i');
const metricPatterns = flows.map(([metric, labels]) => [metric, new RegExp(`^(?:${labels})$`, 'i')]);
const digits = '零一二三四五六七八九';
const term = String.raw`(?:第\s*[一二三四1-4]\s*季(?:度)?|[一二三四1-4]\s*季度|Q\s*[1-4]|上半年|下半年|半年度?|H\s*[12]|前\s*[三3]\s*季(?:度)?|前\s*[九9]\s*(?:个|個)?月|全年度?|年度)`;
const periods = new RegExp(String.raw`(?<![\dA-Za-z])(?:FY\s*)?(?<year>20\d{2})(?:\s*年)?\s*(?<term>${term})?(?![0-9A-Za-z])|(?<termOnly>${term})`, 'gi');
const toDigit = char => char === '〇' ? '0' : String(digits.indexOf(char));

export function datedFinancialFlow(prefix, { allowUnlabelled = false } = {}) {
  const plain = prefix.normalize('NFKC').replace(/[*`]/g, ' ');
  if (/假[设設]|如果|[预預][计計測测]|年化|并非|並非|不是|[误誤]写|剔除|分部|母公司|[单單][体體]|[经經][调調]整/.test(plain)) return null;
  const text = plain.replace(/[零〇一二三四五六七八九]{4}(?=\s*年)/g, year => [...year].map(toDigit).join(''));
  const labels = [...text.matchAll(periods)];
  const flow = text.replace(periods, ' ').match(flowAtAmount);
  if (!flow) return null;
  const metric = metricPatterns.find(([, pattern]) => pattern.test(flow[1]))[0];
  if (!labels.length && allowUnlabelled) return {metric, year: '', part: ''};
  if (labels.length !== 1) return null;
  const {year = '', term: explicit, termOnly} = labels[0].groups;
  const termText = (explicit || termOnly || '').toUpperCase().replace(/\s+/g, '');
  const tail = text.slice(labels[0].index + labels[0][0].length);
  if (/^\s*(?:年\s*)?(?:[报報]|末|初|同期|同比|[–—至-]\s*20\d{2}|\d{1,2}\s*月)/.test(tail) ||
      /截至\s*$/.test(text.slice(0, labels[0].index)) || /^\s*[累合總总][计計]/.test(tail)) return null;
  const quarter = termText.match(/^(?:第|Q)?([一二三四1-4])(?:季度?)?$/)?.[1];
  const part = quarter ? `Q${/[1-4]/.test(quarter) ? quarter : toDigit(quarter)}` :
    /前/.test(termText) ? '9M' : /下半年|H2/.test(termText) ? 'H2' : /半年|H1/.test(termText) ? 'H1' : 'FY';
  return {metric, year, part};
}

export function pdfPageRanges(text) {
  return [...text.matchAll(/\bp(?:p)?\.\s*(\d+)(?:\s*[-–—至]\s*(\d+))?\b|第\s*(\d+)(?:\s*[-–—至]\s*(\d+))?\s*[页頁]/giu)]
    .map(match => [Number(match[1] || match[3]), Number(match[2] || match[4] || match[1] || match[3])]);
}

export function reportPeriodLabel({year, part}) {
  const label = {FY:'全年', H1:'上半年', H2:'下半年', '9M':'前三季度'}[part] || `第${part[1]}季度`;
  return `${year}年${label}`;
}
