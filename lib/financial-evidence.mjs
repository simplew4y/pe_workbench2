/** Verify each stated amount against one source with the same identity. */
import { adoptedCitations, collectCitationsFromToolCalls, currentCitation, derivedEvidenceIssue, toolEvidenceState } from './citations.mjs';
import { citationIdentity, extractLocatorMatches, maskCitationIds } from './citation-locator.mjs';
import { normalizeValue, norm } from './fact-memory/value.mjs';
import { annualPeriod, extractPdfFacts } from './fact-memory/pdf-semantic.mjs';
import { datedFinancialFlow, pdfPageRanges, reportPeriodLabel } from './pdf-period-evidence.mjs';
import { dividendClaim, pdfDividendFacts } from './pdf-dividend-evidence.mjs';
import { calculate, convertExact, formatDecimal } from './calc-tool.mjs';
import { Lexer } from 'marked';
import { scenarioAmountEvidence } from './scenario-calculation.mjs';
import {marketEvidenceFromCalls,matchingMarketEvidence} from './market-evidence.mjs';
import {enrichFinancialSources} from './financial-source-identity.mjs';

const metrics = [
  ['收入','营收','营业收入','营业额','revenue','revenues','sales','turnover'], ['净利润','净利','net income','net profit'],
  ['利润','profit'], ['成本','营业成本','cost','cogs'], ['毛利润','毛利','gross profit'], ['毛利率','gross margin','gross profit margin'],
  ['净利率','net margin','net profit margin'], ['资产','总资产','assets'], ['预付款','预付账款'], ['现金流','cash flow','free cash flow','fcf'],
  ['企业价值','enterprise value'], ['股权价值','equity value'], ['净负债','net debt'],
  ['ebitda','息税折旧摊销前利润'], ['折旧','depreciation'], ['资本开支','capital expenditure','capital expenditures','capex'], ['营业利润','operating profit'],
  ['目标价','目标NAV','target price','nav','tp'], ['每股收益','eps','earnings per share'],
  ['股价','现价','当前价','收盘价','收盘','share price','stock price'],
  ['市值','总市值','market cap','market capitalization'],
  ['市盈率','pe','p/e','盈利倍数'],
  ['股数','股本','shares outstanding','total shares outstanding'],
];
const scopes = [['合并','consolidated'],['单体','母公司','standalone']];
const bases = [['实际','actual'],['预测','预计','forecast','estimate'],['假设','assumption']];
const scenarios = [['基准','基本情景','base'],['乐观','上行','bull','upside'],['悲观','下行','bear','downside']];
const currencyPattern = /人民币|港(?:币|元)|美元|美金|HK\$|US\$|CNY|RMB|HKD|USD/ig;
const periodPattern = /(?:FY\s*)?(?:19|20)\d{2}(?:\s*年)?(?:\s*(?:[QH][1-4]|[AE](?![A-Za-z])))?|(?:[1-4]Q|[12]H)\s*\d{2,4}(?:[AE](?![A-Za-z]))?/gi;
const number = String.raw`[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?`;
const monetaryScale = String.raw`(?:十亿|百万|千万|千|万|亿)?(?:美元|港元|港币|人民币|元)(?:\/(?:股|Gb|GB))?|十亿|百万|亿|万`;
const amount = new RegExp(String.raw`(?<![\d.A-Za-z])(?:(USD|CNY|RMB|HKD|HK\$|US\$|人民币)\s*)?(${number})\s*(个百分点|[%％倍]|十亿股|百万股|亿股|万股|股|${monetaryScale}|(?:(?:RMB|CNY|HKD|USD)\s*)?(?:million|mn)\b|(?:RMB|CNY|HKD|USD)\b)?`, 'gi');
// Masked citation whitespace must not become part of a bare numeric span.
const quantityEnd = m => m ? m.index + m[0].trimEnd().length : 0;
const cents = x => String(x ?? '').replaceAll(',','').replace('−','-');
const equalValue = (a,b) => a != null && b != null && cents(a).trim() && cents(b).trim() &&
  Number.isFinite(Number(cents(a))) && Number(cents(a)) === Number(cents(b));
const unique = values => [...new Set(values.filter(Boolean))];
const fieldNames = {value:'数值', unit:'单位', currency:'币种', metric:'指标', period:'期间', company:'主体', segment:'产品或业务分部', scope:'合并范围', basis_type:'实际或预测口径', scenario:'情景', version:'资料版本', dependency:'派生依赖'};
function currencyOf(s) {
  const label = s?.match(currencyPattern)?.[0];
  if (!label) return '';
  return /港|hk/i.test(label) ? 'HKD' : /美|us/i.test(label) ? 'USD' : 'CNY';
}
function units(s = '') {
  return s.replace(/US\$/gi,'USD').replace(/HK\$/gi,'HKD').replace(/(USD|HKD|RMB|CNY)(?=mn|mm|bn)/gi,'$1 ').replace(/(?:HK\$|US\$|HKD|USD|RMB|CNY)\s*\/\s*(?:sh(?:are)?|股)/gi, '元/股').replace(/(?:美元|港元|港币|人民币)/g, '元').replace(/^(?:RMB|CNY|USD|HKD)$/i,'元').replace(/(?:USD|HKD|RMB|CNY)\s*\/\s*(Gb|GB)/g,'元/$1').replace(/元\s*\/\s*(Gb|GB)/g,'元/$1').replace('％','%');
}
function comparable(value, unit, currency) {
  const rate=units(unit).replace(/\s/g,'').match(/^元\/(Gb|GB)$/);
  if (rate) { const multiplier=rate[1]==='GB'?1/8:1; return {canonical_unit:'元/Gb',canonical_value:Number(cents(value))*multiplier,multiplier}; }
  const shares={'股':1,'万股':1e4,'百万股':1e6,'亿股':1e8,'十亿股':1e9};
  if (shares[unit]) return {canonical_unit:'股',canonical_value:Number(cents(value))*shares[unit],multiplier:shares[unit]};
  const normalized = normalizeValue(cents(value),units(unit),currencyOf(unit) || currency);
  return normalized.reason ? null : normalized;
}
function roundedEqual(claim, actual, expected, multiplier = 1) {
  actual=Number(cents(actual)); expected=Number(cents(expected));
  if (!Number.isFinite(Number(multiplier))) return false;
  // Respect the precision actually printed. 3.975% -> 4.0% is normal
  // rounding even though its relative difference exceeds 0.5%.
  const significant=String(claim.value).replace(/[^0-9]/g,'').replace(/^0+/,'').length;
  if (!claim.approximate && significant<2 && Math.abs(Number(actual)-Number(expected)) > Math.abs(Number(expected))*0.005) return false;
  const decimals=(String(claim.value).split('.')[1] || '').length;
  return Math.abs(Number(actual)-Number(expected)) <= Math.abs(Number(multiplier))*0.5*10**(-decimals)+1e-9;
}
function suppliedPrice(claim, prefix, question) {
  if (!/题设|用户给定/.test(prefix) || !/现价|股价|价格/.test(prefix+' '+question)) return false;
  for (const m of question.matchAll(/(?:题设|固定为|假定为|给定)\s*([\d,.]+)\s*(港元|港币|美元|人民币|元)(\/股)?/g)) {
    if (equalValue(claim.value,m[1]) && currencyOf(m[2])===claim.currency &&
        norm(units(m[2]+(m[3] || '')))===norm(units(claim.unit))) return true;
  }
  return false;
}
function sameAmount(claim, cell) {
  // A stated deduction/rate magnitude is positive while its workbook cash or
  // valuation contribution can be signed negative. Preserve explicit signs.
  if (claim.magnitude && Number(cents(claim.value))>0 && Number(cell.value)<0) cell={...cell,value:-Number(cell.value)};
  if (!claim.unit) return (equalValue(claim.value,cell.value) || roundedEqual(claim,claim.value,cell.value)) ? null : 'value';
  let cellUnit = cell.raw_unit || cell.display_unit || '';
  let claimUnit = claim.unit;
  const moneyOnly = unit => /^(?:港元|港币|美元|人民币|元|HKD|USD|CNY|RMB)$/i.test(unit);
  const perShare = unit => /\/(?:股|sh(?:are)?)$/i.test(unit);
  if (claim.perShare && moneyOnly(claimUnit) && perShare(cellUnit)) claimUnit += '/股';
  if (perShare(claimUnit) && moneyOnly(cellUnit) && /目标价|股价|现价|每股|\bEPS\b|\bNAV\b|target price|share price/i.test(cell.metric || '')) cellUnit += '/股';
  if (!cellUnit || cellUnit === 'unit_unknown') return 'unit';
  const a = comparable(claim.value,claimUnit,claim.currency);
  const b = comparable(cell.value,cellUnit,cell.currency);
  if (!a || !b) return norm(units(claimUnit)) !== norm(units(cellUnit)) ? 'unit' : (equalValue(claim.value,cell.value) || roundedEqual(claim,claim.value,cell.value)) ? null : 'value';
  if (a.canonical_unit !== b.canonical_unit) return 'unit';
  if (a.canonical_value === b.canonical_value || roundedEqual(claim,a.canonical_value,b.canonical_value,a.multiplier)) return null;
  return equalValue(claim.value,cell.value) && a.multiplier !== b.multiplier ? 'unit' : 'value';
}
function groupKey(v, groups) {
  const key = norm(v);
  const exact=groups.find(group => group.some(label => norm(label) === key));
  if (exact) return exact[0];
  if (groups === metrics) {
    const text=String(v || '').toLowerCase();
    if(/净利.*倍数/.test(text) && /市值/.test(text) && !/增长|同比|环比/.test(text))return '市盈率';
    // A ratio calculated from profit/price is a new metric, not the input
    // metric whose word happens to occur in its name.
    if (/倍数|比值|占比|增长率|增速|市盈率|市净率|\bratio\b|\bmultiple\b/.test(text)) return norm(text);
    if (/nav.*(?:pre[ -]?holdco|before.*discount)/.test(text)) return norm(text);
    const matches=groups.flatMap(group=>group.filter(label=>{
      if (/^[a-z ]+$/.test(label)) return new RegExp('(^|[^a-z])'+label+'([^a-z]|$)','i').test(text);
      return text.includes(label);
    }).map(label=>({key:group[0],length:label.length})));
    const longest=matches.toSorted((a,b)=>b.length-a.length)[0];
    if (longest) return longest.key;
  }
  return key;
}
function lastLabel(text, labels) {
  const input = text.toLowerCase();
  let bestEnd = -1, best = '';
  for (const label of labels) {
    const word = label.trim().toLowerCase();
    if (!word) continue;
    const start = input.lastIndexOf(word);
    if (start < 0 || (/^[\w ]+$/.test(word) && /[a-z]/.test(input[start-1] || ''))) continue;
    const end = start + word.length;
    if (/^[a-z ]+$/.test(word) && /[a-z]/.test(input[end] || '')) continue;
    if (end > bestEnd || (end === bestEnd && word.length > best.length)) { best = word; bestEnd = end; }
  }
  return best;
}
function periodParts(text) {
  const p = norm(text).replace('fy','').replace('年','');
  const short = p.replace(/[ae]$/,'').match(/^([1-4])([qh])(\d{2}|\d{4})$/);
  const period = short ? (short[3].length === 2 ? '20' : '') + short[3] + short[2] + short[1] : p.replace(/[ae]$/,'');
  return {period, basis_type:/e$/.test(p)?'forecast':/a$/.test(p)?'actual':''};
}
function plainText(s) {
  // Hide filenames, versions and coordinates without changing offsets.
  let text = s.replace(/https?:\/\/[^\s)>]+/g, url => ' '.repeat(url.length)).replace(/`[^`\n]*=[^`\n]*`/g, code => ' '.repeat(code.length)).replace(/[*`]/g,' ');
  // Digits in material identifiers are metadata, including when an ID
  // follows a numeric-looking introduction such as “材料 ID 为 …”.
  text = text.replace(/\b[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}\b/gi, id => ' '.repeat(id.length));
  for (const m of extractLocatorMatches(text).reverse()) text = text.slice(0,m.index) + ' '.repeat(m.raw.length) + text.slice(m.index+m.raw.length);
  return text;
}

function* statements(answer, withParent = false) {
  const item = (text, sentence, sourceText=text) => withParent ? {text, sentence, sourceText} : text;
  const prose = s => s.split(/[。！？\n]|(?<=[.!?])\s+/).flatMap(sentence =>
    sentence.split(/[；;]/).filter(Boolean).map(text => item(text, sentence)));
  if (!answer.includes('|')) { yield* prose(answer); return; }
  for (const token of Lexer.lex(answer)) {
    if (token.type !== 'table') { yield* prose(token.raw); continue; }
    const headers = token.header.map(h => h.text);
    for (const [rowIndex,row] of token.rows.entries()) {
      const shared = row.filter(c => !/\d/.test(plainText(c.text)) && !c.text.includes('!')).map(c => c.text).join(' ');
      const refs = row.filter(c => c.text.includes('!') && !/\d/.test(plainText(c.text))).map(c => c.text).join(' ');
      for (const [i, cell] of row.entries()) {
        if (/\d/.test(plainText(cell.text))) {
          const text = [shared,headers[i],'为',cell.text,cell.text.includes('!')?'':refs].join(' ');
          yield item(text, text, token.raw.split(/\r?\n/)[rowIndex+2] || token.raw);
        }
      }
    }
  }
}

const reportMoney = /^(?:百万|千万|千|万|亿)?(?:元|人民币|港(?:元|币)|美元)$|^(?:万|亿|百万)$/u;
const annualCashFlowRow = new RegExp(
  String.raw`经营活动产生的现金流量净额\s+(${number})\s+(${number})\s+(${number})\s*%`, 'u',
);
const annualRevenueRow = new RegExp(
  String.raw`(20\d{2})年\s+(20\d{2})年\s+本年比上年增减\s+20\d{2}年\s*营业收入\s*\(元\)\s+(${number})\s+(${number})\s+(${number})\s*%`, 'u',
);
const annualReportYear = /^[^\n]*?(20\d{2})\s*年\s*(?:年)?度\s*报告(?:全文)?[ \t]*(?:\n|$)/u;
const annualCashFlowSummary = new RegExp(
  String.raw`单位:\s*元\s+币种:\s*人民币\s+变动比例\s+科目\s+本期数\s+上年同期数\s+\(%\)\s*营业收入\s+[^\n]{0,1000}?经营活动产生的现金流量净额\s+(${number})\s+(${number})\s+(${number})(?![\d.])`, 'u',
);
const annualOwnerProfitGrowth = new RegExp(
  String.raw`截至(?<date>20\d{2}|[零〇一二三四五六七八九]{4})年(?:十二月三十一日|12月31日)止年度的(?<adjusted>非[國国][際际][財财][務务][報报]告[準准][則则])?本公司[權权]益持有人[應应][佔占]盈利(?:同比)?(?<direction>增[長长]|增加|下降|下跌)(?<rate>\d+(?:\.\d+)?)%至人民[币幣]`, 'gu',
);
const channelRow = new RegExp(String.raw`(酒类(?:产品)?|批发代理|经销模式|直销(?:模式)?)\s+(${number})\s+${number}\s+(${number})(?=\s|%)`, 'gu');

function ownerProfitGrowth(text, page) {
  const rows = [...text.matchAll(annualOwnerProfitGrowth)].map(({groups}) => ({
    year:annualPeriod(groups.date + '年'), adjusted:Boolean(groups.adjusted),
    rate:(/^下/u.test(groups.direction) ? '-' : '') + groups.rate,
  }));
  const [reported] = rows.filter(row => !row.adjusted);
  const [adjusted] = rows.filter(row => row.adjusted);
  return rows.length === 2 && reported && adjusted && reported.year && reported.year === adjusted.year
    ? {metric:'annual_owner_profit_yoy_comparison', year:reported.year, part:'FY', page, reported:reported.rate, adjusted:adjusted.rate}
    : null;
}

function annualSalesChannels(text, page, year) {
  if (!year || !/单位\s*:\s*元(?=\s|营业收入)/u.test(text)) return null;
  const modeTable = text.match(/(?:^|\n)\d+、不同模式、不同产品的营业收入、营业成本、毛利率情况[^]{0,300}?销售模式(酒类产品[^]{0,500}?)产品分类/u)?.[1];
  const byIndustry = text.match(/主营业务分行业情况([^]{0,650}?)主营业务分产品情况/u)?.[1];
  const byMode = text.match(/主营业务分销售模式情况([^]{0,650})/u)?.[1];
  const rows = [...(modeTable || (byIndustry && byMode ? byIndustry + '\n' + byMode : '')).matchAll(channelRow)]
    .map(([, label, value, margin]) => ({label, value, margin}));
  const total = rows.find(row => /^酒类/u.test(row.label));
  const direct = rows.find(row => /^直销/u.test(row.label));
  const indirect = rows.find(row => /^(?:批发代理|经销)/u.test(row.label));
  if (rows.length !== 3 || !total || !direct || !indirect) return null;
  const [all, own, thirdParty] = [total, direct, indirect].map(row => cents(row.value));
  if (Number(own) <= 0 || Number(thirdParty) <= 0 || calculate({expression:`${own}+${thirdParty}-${all}`}).value !== '0') return null;
  const directShare = calculate({expression:`100*${own}/${all}`, precision:2}).value;
  return {metric:'annual_sales_channels', year, part:'FY', page, total, direct, indirect, directShare};
}
const groupMarginColumns = /(?:^|\n)截至(?:十二月三十一日|12月31日)止年度\s*\n([^\s]+年)\s+([^\s]+年)\s+同比[变變][动動]\s+([^\s]+年)\s+([^\s]+年)\s*毛利[^\n]{0,20}毛利率[^\n]*\n/u;
const groupMarginRow = new RegExp(String.raw`(?:^|\n)本集[团團]\s+${number}\s+${number}\s+${number}%\s+(${number})%\s+(\d+(?:\.\d+)?)%`, 'u');
const segmentMarginRow = new RegExp(String.raw`([\p{Script=Han}]{1,30})\s+\(?${number}\)?\s+\(?${number}\)?\s+(?:\(?${number}%\)?|不[适適]用)\s+(\(?${number}%\)?)\s+(\(?${number}%\)?)`, 'gu');

function segmentMargins(text) {
  const rows = [...text.matchAll(segmentMarginRow)];
  // PDF extraction may join adjacent rows. Any unmatched cell means the
  // segment columns weren't fully recovered, so use only the group row.
  let position = 0;
  for (const row of rows) {
    if (text.slice(position, row.index).trim()) return [];
    position = row.index + row[0].length;
  }
  if (text.slice(position).trim() || new Set(rows.map(row => row[1])).size !== rows.length) return [];
  const percent = value => value.replace(/^\(/u, '-').replace(/[%)]/gu, '');
  const label = name => name.replace(/服[務务]/gu, '服务').replace(/營銷/gu, '营销').replace(/企業/gu, '企业');
  return rows.map(([, name, value, previous]) => ({label:label(name), value:percent(value), previous:percent(previous)}));
}

function groupMarginFacts(text, page) {
  const heading = groupMarginColumns.exec(text);
  if (!heading) return [];
  const [current, previous, currentMargin, previousMargin] = heading.slice(1).map(annualPeriod);
  if (!current || Number(current) !== Number(previous) + 1 ||
      current !== currentMargin || previous !== previousMargin) return [];
  const table = text.slice(heading.index + heading[0].length).split(/\n\s*[－–—]\s*/, 1)[0];
  const row = groupMarginRow.exec(table);
  return row ? [{
    metric:'group_gross_margin', year:current, previous, value:row[1], previousValue:row[2],
    segments:segmentMargins(table.slice(0, row.index)), page,
  }] : [];
}

function reportedAnnualAmounts(text, page) {
  const amountFact = (metric, year, value, fields = {}) => ({
    metric, year, value, part: 'FY', page, display_unit: '元', currency: 'CNY', ...fields,
  });
  const facts = pdfDividendFacts(text, page);
  const revenue = text.match(annualRevenueRow);
  if (revenue && Number(revenue[1]) === Number(revenue[2]) + 1) {
    facts.push(amountFact('revenue', revenue[1], revenue[3], {yoy: revenue[5]}),
      amountFact('revenue', revenue[2], revenue[4]));
  }
  // These columns are explicit on annual cash flow tables. Stop before any
  // following table, including the balance sheet or quarterly disclosures.
  const table = text.match(/(?:^|\n)(?:\d+、)?现金流\s*\n单位\s*[:：]\s*元\s*\n项目\s*(20\d{2})年\s*(20\d{2})年\s*同比增减\s*\n([^\n]+(?:\n(?!单位|\d+、|[一二三四五六七八九]、)[^\n]+){0,2})/u);
  const cashFlow = table?.[3].match(annualCashFlowRow);
  if (cashFlow && Number(table[1]) === Number(table[2]) + 1) {
    facts.push(amountFact('operating_cash_flow', table[1], cashFlow[1], {yoy: cashFlow[3]}),
      amountFact('operating_cash_flow', table[2], cashFlow[2]));
  }
  const year = text.match(annualReportYear)?.[1];
  const summary = year && text.match(annualCashFlowSummary);
  if (summary) {
    facts.push(amountFact('operating_cash_flow', year, summary[1], {yoy:summary[3]}),
      amountFact('operating_cash_flow', String(Number(year) - 1), summary[2]));
  }
  const channels = annualSalesChannels(text, page, year);
  if (channels) facts.push(channels);
  const profitGrowth = ownerProfitGrowth(text, page);
  if (profitGrowth) facts.push(profitGrowth);
  return facts;
}

// Use complete, selectable-text pages from the cited material. A search
// hit can start in the middle of a sentence and omit its period.
export function pdfReportAmounts(page, issuer = '') {
  const text = page.paragraphs.join('\n').normalize('NFKC').replace(/億/g, '亿').replace(/萬/g, '万').replace(/幣/g, '币');
  const facts = reportedAnnualAmounts(text, page.page);
  if (issuer) {
    for (const fact of extractPdfFacts({page:page.page, issuer, text}).candidates) {
      if (fact.extractor !== 'pdf-annual-table-v1' || fact.semantic_review ||
          !['operating_profit', 'revenue'].includes(fact.identity.metric)) continue;
      facts.push({
        metric:fact.identity.metric, year:fact.identity.period, part:'FY', page:page.page,
        value:fact.raw_value, display_unit:fact.raw_unit, currency:fact.identity.currency,
      });
    }
  }
  facts.push(...groupMarginFacts(text, page.page));
  for (const statement of statements(text)) {
    for (const match of statement.matchAll(amount)) {
      if (!reportMoney.test(match[3] || '')) continue;
      const prefix = statement.slice(0, match.index);
      const currency = currencyOf(match[1] || match[3]) || currencyOf(prefix.match(/(?:人民[币幣]|港[币元]|美元)\s*$/)?.[0]);
      const flow = datedFinancialFlow(prefix);
      if (flow?.year) facts.push({ ...flow, currency, page: page.page, value: match[2], display_unit: match[3] });
    }
  }
  return facts;
}

function reportsNamedIn(text, reports) {
  const normalized = norm(text);
  const explicit = /\.pdf\b/iu.test(text);
  const named = reports.filter(report => {
    const filename = norm(report.filename);
    if (explicit) return normalized.includes(filename);
    const name = filename.replace(/\.pdf$/u, '');
    const issuer = name.split('_', 1)[0];
    return normalized.includes(name) || (issuer !== name && normalized.includes(issuer));
  });
  if (named.length || explicit) return named;
  // A short form attached to the local page may uniquely identify its issuer.
  // Never use a different issuer named in the rest of a comparison instead.
  const aliases = [...text.matchAll(/[（(]\s*([\p{Script=Han}]{2,12})\s*(?=p\.|第\s*\d+\s*页)/giu)]
    .map(match => norm(match[1]));
  return reports.filter(report => {
    const issuer = norm(report.filename).split('_', 1)[0];
    return aliases.some(alias => issuer.endsWith(alias));
  });
}

function reportFactsFor(statement, reports, parent = statement) {
  const named = reportsNamedIn(statement, reports);
  const family = parent !== statement ? reportsNamedIn(parent, reports) : [];
  const ranges = pdfPageRanges(statement);
  const eligible = named.length || /\.pdf\b/iu.test(statement) ? named : (!ranges.length && family.length) ? family : reports;
  if (eligible.length !== 1) return [];
  const report = eligible[0];
  if (!ranges.length && family.length === 1 && family[0] === report) ranges.push(...pdfPageRanges(parent));
  return report.facts.map(fact => ({
    ...fact, filename: report.filename,
    cited: (fact.pages || [fact.page]).every(page => ranges.some(([first, last]) => first <= page && page <= last)),
  }));
}

function decimalPlaces(value) {
  return Math.min(100, value.split('.')[1]?.length || 0);
}

function amountInClaimUnit(claim, fact, shares = '1') {
  const source = comparable(fact.value, fact.display_unit, fact.currency);
  const target = comparable(claim.value, claim.unit, claim.currency);
  if (source?.canonical_unit !== '元' || target?.canonical_unit !== '元') return null;
  const precision = decimalPlaces(claim.value);
  const perUnit = shares === '1' ? source.canonical_value : calculate({expression:`${source.canonical_value} * ${shares}`}).value;
  const expected = formatDecimal(convertExact(perUnit, '元', units(claim.unit)), precision);
  const actual = calculate({expression: cents(claim.value), precision}).value;
  return {fact, expected, matches: actual === expected};
}

function reportPages(fact) {
  return (fact.pages || [fact.page]).map(page => 'p.' + page).join('、');
}

function matchReportAmount(prefix, sentence, claim, facts, previousAmount, suffix) {
  if (!facts.length || (!reportMoney.test(claim.unit) && claim.unit !== '元/股')) return null;
  const comparisonYear = prefix.match(/^[\s，,、]*(20\d{2})\s*年(?:度)?\s*(?:为|约|[:：])*\s*$/u)?.[1];
  const earlier = comparisonYear && previousAmount?.cited && !previousAmount.metric.includes('dividend')
    ? {metric:previousAmount.metric, year:comparisonYear, part:previousAmount.part} : null;
  const dividend = dividendClaim(prefix, sentence, suffix, previousAmount, claim.unit);
  if (claim.unit === '元/股' && !dividend?.shares) return null;
  if (claim.unit === '元/股') claim = {...claim, unit:'元'};
  const flow = dividend || datedFinancialFlow(prefix, { allowUnlabelled: true }) || earlier;
  if (!flow) return null;
  if (flow.metric === 'operating_profit' && /非\s*IFRS|非國際財務報告準則|非国际财务报告准则/iu.test(prefix)) return null;
  const comparisons = facts.filter(fact => fact.metric === flow.metric && (!claim.currency || claim.currency === fact.currency))
    .map(fact => amountInClaimUnit(claim, fact, flow.shares)).filter(Boolean);
  const samePeriod = ({fact}) => (!flow.year || flow.year === fact.year) && (!flow.part || flow.part === fact.part);
  const verified = comparisons.find(row => row.fact.cited && row.matches && samePeriod(row));
  if (verified) return { fact: verified.fact };

  const wrongPeriod = comparisons.filter(row => row.fact.cited && row.matches);
  if (wrongPeriod.length && new Set(wrongPeriod.map(({fact}) => reportPeriodLabel(fact))).size === 1) {
    const {fact} = wrongPeriod[0];
    return { rule:'pdf_period_mismatch', field:'period', message:'财报数字的期间与引用页不一致',
      expected:`${reportPeriodLabel(fact)}（${fact.filename} p.${fact.page}）` };
  }
  const inPeriod = comparisons.filter(samePeriod);
  const cited = inPeriod.filter(row => row.fact.cited);
  const matchingOtherPage = inPeriod.find(row => row.matches);
  const expected = ({fact, expected: value}) => {
    const period = {
      annual_dividend_proposal: '年度现金分红预案',
      annual_dividend_proposal_per_share: '年度现金分红预案',
      interim_dividend_paid: '中期已实施分红',
      interim_dividend_paid_per_share: '中期已实施分红',
      dividends_with_proposal: '中期与年度预案合计',
    }[fact.metric];
    const label = period ? fact.year + '年' + period : reportPeriodLabel(fact);
    const detail = fact.formula ? '依据 ' + fact.formula : `原文 ${fact.value}${fact.display_unit}`;
    return `${value}${claim.unit}（${fact.filename} ${reportPages(fact)}，${label}，${detail}）`;
  };
  if (matchingOtherPage) return {
    rule:'pdf_source_mismatch', field:'source', message:'引用页未能核实这笔金额，已找到对应披露', expected:expected(matchingOtherPage),
  };
  // Only a uniquely bound proposal or a year-labelled amount can support a
  // numerical correction. Don't pick a value from a different table column.
  const pool = cited.length ? cited : inPeriod;
  if ((flow.year || flow.metric.includes('dividend')) &&
      pool.length && new Set(pool.map(row => row.expected)).size === 1) return {
    rule:'pdf_amount_mismatch', field:'value', message:'财报金额与原文换算结果不一致', expected:expected(pool[0]),
  };
  return null;
}

function matchReportChange(prefix, claim, previousAmount) {
  if (!previousAmount?.yoy || claim.unit !== '%') return null;
  const relation = prefix.match(/^\s*[）)]?\s*[、，,]?\s*同比\s*(?:增(?:长|加)?|上升|下降|下滑|下跌|降|减(?:少|低)?)?\s*(?:为|约)?\s*$/u);
  if (!relation) return null;
  const signed = /降|下[滑跌]|减/.test(prefix) && !/^[-−]/.test(claim.value) ? '-' + claim.value : claim.value;
  const precision = decimalPlaces(claim.value);
  const expected = calculate({expression: cents(previousAmount.yoy), precision}).value;
  if (calculate({expression: cents(signed), precision}).value === expected) return { fact: previousAmount };
  return { rule:'pdf_amount_mismatch', field:'value', message:'同比变动与财报原表不一致',
    expected:`${expected}%（${previousAmount.filename} p.${previousAmount.page}，${reportPeriodLabel(previousAmount)}）` };
}

function matchDirectReportChange(prefix, claim, facts) {
  if (claim.unit !== '%') return null;
  const start = prefix.lastIndexOf('同比');
  if (start < 0) return null;
  const flow = datedFinancialFlow(prefix.slice(0,start).trim(), {allowUnlabelled:true});
  if (!flow?.year) return null;
  const matches = facts.filter(fact => fact.metric === flow.metric && fact.cited &&
    fact.year === flow.year && fact.part === flow.part && fact.yoy != null);
  if (new Set(matches.map(fact => fact.yoy)).size !== 1) return null;
  return matchReportChange(prefix.slice(start), claim, matches[0]);
}

function groupMarginChange(text, facts) {
  const checked = new Map();
  const pattern = /(?:(?:(20\d{2})\s*年(?:度)?\s*)?(?:整体|本?集[团團])\s*|(20\d{2})\s*年(?:度)?\s*)毛利率\s*(?:从|由)?\s*(?:(?<priorYear>20\d{2})\s*年的?)?\s*(?<previous>\d+(?:\.\d+)?)\s*[%％]\s*(?:→|升(?:至|到)|提[升高]至|增至|降(?:至|到))\s*(?:(?<endYear>20\d{2})\s*年的?)?\s*(?<current>\d+(?:\.\d+)?)\s*[%％]/dgu;
  for (const match of text.matchAll(pattern)) {
    const year = match[1] || match[2];
    const sources = facts.filter(fact => fact.metric === 'group_gross_margin' && fact.cited && (!year || year === fact.year));
    if (sources.length !== 1) continue;
    const source = sources[0];
    if ((match.groups.priorYear && match.groups.priorYear !== source.previous) ||
        (match.groups.endYear && match.groups.endYear !== source.year)) continue;
    for (const [field, value] of [['previous', source.previousValue], ['current', source.value]]) {
      const stated = match.groups[field];
      const precision = decimalPlaces(stated);
      const expected = calculate({expression:value, precision}).value;
      // Disclosed whole percentages only prove that precision (or coarser).
      const rounded = decimalPlaces(value) >= precision;
      if (!rounded && !equalValue(stated, value)) continue;
      checked.set(match.indices.groups[field][0], equalValue(stated, expected) ? {fact:source} : {
        rule:'pdf_amount_mismatch', field:'value', message:'集团毛利率与年报原表不一致',
        expected:`${field === 'current' ? source.year : source.previous}年集团毛利率 ${expected}%（${source.filename} ${reportPages(source)}）`,
      });
    }
  }
  return checked;
}

// A quoted condition can carry a percentage from the actual user turn.
// Keep the metric and direction coupled to the value.
const scenarioRateHead = /(?<metric>[\p{Script=Han}]{2,24}?)(?<verb>增速降至|增速降到|增速为|增长|增加|增|下降|下滑|减少)\s*$/u;
function scenarioRateKey(text) {
  const match = text.match(scenarioRateHead);
  if (!match) return '';
  const metric = match.groups.metric
    .replace(/^未来[一二两三四五六七八九十\d]+(?:季度|季|年|个月)/u, '')
    .replace(/^(?:(?:在)?(?:该|本)?情景[中下]|按题设|如果|若|假设)/u, '');
  const verb = match.groups.verb.replace(/增速降到/u, '增速降至').replace(/^(?:增长|增加)$/u, '增').replace(/^(?:下降|下滑|减少)$/u, '下降');
  return metric ? metric + ':' + verb : '';
}

function scenarioRateInputs(question) {
  const premise = question.normalize('NFKC').match(/^\s*(?:虚构|假设)(?:压力)?情景[:：]\s*([^。！？\n]+)/u)?.[1];
  if (!premise) return [];
  return premise.split(/[，,；;、]/u).flatMap(clause => {
    const match = clause.match(/^(.*?)(\d+(?:\.\d+)?)\s*%\s*$/u);
    const key = match && scenarioRateKey(match[1]);
    return key ? [{key, value:match[2]}] : [];
  });
}

export function scenarioDirectionFindings(answer, question) {
  const inputs = scenarioRateInputs(question);
  const findings = [];
  for (const input of inputs) {
    const metric = input.key.split(':')[0];
    const subject = metric.replace(/收入$/u, '');
    if (subject && !answer.includes(subject)) findings.push({
      rule:'scenario_direction', severity:'error', excerpt:subject,
      message:`漏答题设中的${metric}变化`, expected:'解释这项变化会缓解或加重哪些压力，以及仍缺什么条件',
    });
  }
  const slower = inputs.some(input => input.key.endsWith(':增速降至') && Number(input.value) > 0);
  if (slower && !/(?:总体|整体|总|集团)收入[^，。]{0,5}(?:减少|下降|下滑)/u.test(question)) {
    for (const sentence of statements(answer)) {
      if (!/增速[^，。；]{0,14}(?:降|放缓)|营销[^，。；]{0,12}降速/u.test(sentence) ||
          /如果|若|能否|是否|不能|不一定|未必/u.test(sentence)) continue;
      if (/分母(?:降|减|变小)|(?:整体|集团|总)收入(?:会|将|随之)?(?:下降|下滑|减少)/u.test(sentence)) findings.push({
        rule:'scenario_direction', severity:'error', field:'direction', excerpt:sentence.trim(),
        message:'用分部增速放缓推出了总收入下降', expected:'区分收入增速和收入金额。总收入及资本开支占收入比是否越线仍需权重和金额',
      });
    }
  }
  return findings;
}

function questionMetrics(question, candidates) {
  const labels = unique([...metrics.flat(), ...candidates.map(c => c.metric)]).filter(label=>label.length > 1 && ! /^(?:(?:FY\s*)?20\d{2}(?:[QH][1-4])?|[1-4][QH]\d{2,4})(?:[AE]|年)?$/i.test(label));
  const pattern = labels.toSorted((a,b) => b.length - a.length).map(s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
  const mentions = [...question.matchAll(new RegExp(pattern, 'gi'))];
  const keys = unique(mentions.map(m => groupKey(m[0], metrics)));
  const inherited = keys.length === 1 ? keys[0] : '';
  const last = mentions.at(-1);
  if (!inherited) return {labels, inherited, requested:''};
  const tail = question.slice(last.index + last[0].length).trim().replace(/[？?。.]$/, '').trim();
  const head = question.slice(0, last.index).replace(periodPattern, '').trim();
  const direct = /^(?:是|为|有)?\s*多少(?:钱)?$/.test(tail) || (!tail &&
    /^(?:(?:请\s*)?(?:帮我\s*)?(?:给出|列出|提供|查询)|请问|what (?:is|was)(?: the)?)$/i.test(head));
  return {labels, inherited, requested:direct ? inherited : ''};
}
function statedMetric(prefix, labels) {
  const unknownMetric = prefix.match(/([\p{Script=Han}]{2,10}(?:余额|款项|负债|支出|拨备))\s*(?:为|是|[:：])?\s*$/u)?.[1];
  return lastLabel(prefix,labels) || unknownMetric || '';
}
function claimDimensions(prefix, question, candidates, metricContext) {
  const labelsFor = (field,groups) => unique([...groups.flat(), ...candidates.map(c=>c[field])]);
  const metric = statedMetric(prefix,metricContext.labels) || metricContext.requested;
  const namedSubject = text => text.match(/(?:^|[，,、(（\s])([A-Z][A-Za-z0-9-]{1,30})\s+(?=(?:的\s*)?(?:合并|单体|收入|成本|净利|revenue|profit))/)?.[1];
  const explicit = prefix.match(/(?:主体|公司|entity|company)\s*[:：]\s*([\w.-]+|[\p{Script=Han}]+?公司)/iu)?.[1] ||
    prefix.match(/(?:^|[\s，,])([\p{Script=Han}]{1,10}(?:公司|集团))(?=\s|的|合并|单体|[12]\d{3}|收入|成本|净利)/u)?.[1];
  const period = [...prefix.matchAll(periodPattern)].at(-1)?.[0];
  const periodsAsked = unique(question.match(periodPattern) || []);
  const parts = periodParts(period || (metricContext.requested && periodsAsked.length === 1 ? periodsAsked[0] : ''));
  const dimension = (field,groups) => {
    const labels = labelsFor(field,groups);
    const value = lastLabel(prefix,labels);
    const asked = unique(labels.filter(label => lastLabel(question,[label])).map(v=>groupKey(v,groups)));
    return value || (metricContext.requested && asked.length === 1 ? asked[0] : '');
  };
  const ratio = /占比|增速|增长率|百分比变化|份额|比重|\bratio\b|\bshare\b/i.exec(prefix);
  const segment=dimension('segment',[]);
  let company=explicit || dimension('company',[]) || namedSubject(prefix) || namedSubject(question);
  if(company===segment && !candidates.some(c=>c.company===company))company=undefined;
  return { ...parts, metric, segment, company, scope:dimension('scope',scopes),
    basis_type:lastLabel(prefix,bases.flat()) || parts.basis_type || dimension('basis_type',bases),
    scenario:dimension('scenario',scenarios), ratio: ratio?.[0] || '' };
}
function compare(claim, cell, deps) {
  if (cell.derivedFrom || cell.role?.startsWith('derived')) {
    const issue = derivedEvidenceIssue(cell, deps.sources, deps.calls);
    if (issue) return ['dependency',issue];
  }
  if (!currentCitation(cell,deps.versions)) return ['version',String(deps.versions[cell.materialId])];
  const missing=[];
  const mismatch = (field, expected) => {
    if (expected == null || expected === '' || ['unknown','unit_unknown'].includes(expected)) {
      missing.push([field,'出处缺少该字段']); return null;
    }
    return [field,expected];
  };
  let issue;
  if(cell.semanticMetricUnresolved)mismatch('metric',null);
  if(cell.segment && !claim.segment)mismatch('segment',null);
  if (claim.period && periodParts(cell.period).period !== claim.period && (issue=mismatch('period',cell.period))) return issue;
  for (const [field,groups] of [['company',[]],['segment',[]],['scope',scopes],['basis_type',bases],['scenario',scenarios]]) {
    if (!claim[field]) continue;
    const source = field === 'basis_type' && (!cell[field] || cell[field] === 'unknown') ? periodParts(cell.period).basis_type : cell[field];
    // Forecast model inputs are assumptions; actual observations remain distinct.
    if (field==='basis_type' && groupKey(claim[field],groups)==='假设' && groupKey(source,groups)==='预测') continue;
    if (groupKey(claim[field],groups) !== groupKey(source,groups) && (issue=mismatch(field,source))) return issue;
  }
  const sourceCurrency = currencyOf(cell.currency || '') || currencyOf(cell.raw_unit || cell.display_unit || '');
  if (claim.currency && sourceCurrency !== claim.currency && (issue=mismatch('currency',sourceCurrency))) return issue;
  if (claim.metric && !cell.metric && (cell.period || cell.company || cell.scope || cell.basis_type)) mismatch('metric',null);
  if (claim.metric && cell.metric && groupKey(claim.metric,metrics) !== groupKey(cell.metric,metrics) &&
      !(claim.ratio && norm(cell.metric).includes(norm(claim.metric)) && norm(cell.metric).includes(norm(claim.ratio)))) return mismatch('metric',cell.metric);
  if (claim.ratio && cell.role !== 'derived_ratio' && !(cell.role?.startsWith('derived_calc_') && /^(?:%|decimal)$/.test(cell.raw_unit || cell.display_unit)) && !/占比|增速|增长率|比重|份额|ratio|growth|share|\byoy\b|\bqoq\b/i.test(cell.metric || '') &&
      (issue=mismatch('metric',cell.metric))) return issue;
  const field = sameAmount(claim,cell);
  if (field && (issue=mismatch(field,field === 'unit' ? cell.display_unit || cell.raw_unit : cell.value))) return issue;
  return missing[0] || null;
}

// Recalculated scenario outputs are observations of a temporary workbook,
// not replacement values for the original cell. Only use them in an explicitly
// labelled scenario and with the original target's units/material identity.
function scenarioOutputSupports(claim, statement, pool, calls, deps) {
  if (!/情景|场景|假设|敏感性/.test(statement) || /原模型|原始|基准|缓存/.test(statement)) return false;
  for (const call of calls) {
    const details=call.result?.details || call.details;
    if (call.name!=='model_whatif' || call.success!==true || call.result?.isError || details?.recalculated!==true) continue;
    for (const result of details.results || []) {
      if (!Number.isFinite(result.after) || !Number.isFinite(result.before)) continue;
      const source=pool.find(c=>!c.derivedFrom && c.locator===result.cell && c.storedFilename &&
        String(details.path || '').split('/').at(-1)===c.storedFilename);
      if (!source || !currentCitation(source,deps.versions)) continue;
      const candidate={...source,value:result.after,scenario:claim.scenario || '',role:'scenario_output'};
      delete candidate.derivedFrom;
      if (!compare(claim,candidate,deps)) return true;
    }
  }
  return false;
}

// External disclosure numbers are not workbook cells. Only accept a linked,
// successfully fetched original containing that quantity. The research audit
// still checks whether the source supports this metric, period and conclusion.
function fetchedQuantitySupports(claim, statement, calls) {
  const urls=[...statement.matchAll(/https?:\/\/[^\s)>]+/g)].map(m=>m[0].replace(/#.*$/,''));
  if (!urls.length || !claim.unit) return false;
  return calls.some(call=>{
    if (call.success !== true || call.result?.isError || !['web_fetch','deepseek_fetch'].includes(call.name)) return false;
    const url=String(call.args?.url || '').replace(/#.*$/,'');
    if (!urls.includes(url)) return false;
    const content=call.result?.content || [];
    const source=Array.isArray(content)?content.filter(c=>c.type==='text').map(c=>c.text).join('\n'):String(content);
    for (const m of source.matchAll(amount)) {
      const unit=m[3]?.trim() || (m[1]?'元':'');
      if (!unit) continue;
      const currency=currencyOf([m[1],unit].filter(Boolean).join(' '));
      if (claim.currency && currency!==claim.currency) continue;
      if (!sameAmount(claim,{value:m[2],raw_unit:unit,currency})) return true;
    }
    return false;
  });
}

// Only expand an explicit contiguous annual range whose value group has
// exactly the same arity. A wrong/swapped value still compares to its own year.
function seriesPeriod(clean, amounts, index) {
  const lead = clean.slice(0, amounts[0]?.index || 0);
  const range = lead.match(/((?:19|20)\d{2})([AE]?)\s*(?:年)?\s*[—–~～至到-]\s*((?:19|20)\d{2})([AE]?)/i);
  if (!range) return null;
  const first=Number(range[1]), last=Number(range[3]);
  if (last < first || last-first > 10) return null;
  const kind = m => /%|％|个百分点/.test(m[3] || '') ? 'ratio' : 'amount';
  let start=index, end=index+1;
  while(start>0 && kind(amounts[start-1])===kind(amounts[index])) start--;
  while(end<amounts.length && kind(amounts[end])===kind(amounts[index])) end++;
  if (end-start!==last-first+1) return null;
  // Later explicit dates override the introductory range.
  if (clean.slice(amounts[0].index,amounts[index].index).match(periodPattern)) return null;
  return periodParts(String(first+index-start)+(range[4] || range[2]));
}

export function financialEvidenceFindings(answer, context, ledgerSources) {
  const calls = context.toolCalls || [];
  const marketEvidence=marketEvidenceFromCalls(calls);
  const heading=answer.match(/^#\s+.+$/m)?.[0] || '';
  const current = context.citations || [];
  const raw = collectCitationsFromToolCalls(calls);
  const all = enrichFinancialSources([...new Map([...current,...raw].map(c=>[c.id,c])).values()],calls);
  if (context.scenarioOnly) ledgerSources=[];
  const pdf = calls.filter(call => call.name === 'pdf_read' && call.success && toolEvidenceState(call) === 'success')
    .flatMap(call => {
      const details = call.details || call.result?.details;
      return (details?.evidence || []).flatMap(page => extractPdfFacts({ ...page, truncated: details.truncated }).candidates
        .filter(fact => fact.extractor === 'pdf-annual-table-v1' && !fact.semantic_review)
        .map(fact => ({
          materialId: details.materialId, version: details.version, filename: details.filename, page: page.page,
          company: fact.identity.entity, ...fact.identity, display_unit: fact.raw_unit, value: fact.raw_value,
        })));
    });
  const candidates = enrichFinancialSources([...all, ...ledgerSources],calls);
  const question = context.question || '';
  const premiseRates = scenarioRateInputs(question);
  const metricContext = questionMetrics(question, [...candidates, ...pdf]);
  const reportedMetrics = new Set();
  const deps = {sources:new Map(all.filter(c=>currentCitation(c,context.currentVersions)).map(c=>[c.id,c])), calls, versions:context.currentVersions};
  const findings = [];
  const reports = context.pdfReports || [];
  const inheritedMargins = reports.length === 1 && context.pdfDisclosure?.kind === 'segment_margins'
    ? context.pdfDisclosure.facts.filter(fact => fact.metric === 'group_gross_margin' && fact.materialId === reports[0].materialId &&
      fact.version === reports[0].version && fact.sha256 === reports[0].sha256).map(fact => ({...fact,cited:true})) : [];
  for (const {text: statement, sentence, sourceText} of statements(answer, true)) {
    const findingStart=findings.length;
    const clean = plainText(maskCitationIds(statement, context.locatorCitations || current));
    const refs = extractLocatorMatches(statement);
    const statementAt=answer.indexOf(statement);
    const paragraphEnd=statementAt<0?-1:answer.indexOf('\n\n',statementAt+statement.length);
    const sourceParagraph=statementAt<0?statement:answer.slice(Math.max(0,answer.lastIndexOf('\n\n',statementAt)+2),paragraphEnd<0?answer.length:paragraphEnd);
    const paragraphUrls=[...sourceParagraph.matchAll(/https?:\/\/[^\s)>]+/g)].map(m=>m[0]);
    const sourceStatement=/https?:\/\//.test(statement) || new Set(paragraphUrls).size!==1 ? statement : statement+' '+paragraphUrls[0];
    const paragraphPrefix=statementAt<0?'':answer.slice(Math.max(0,answer.lastIndexOf('\n\n',statementAt)+2),statementAt);
    const perShareContext=/每股|(?:元|币)\/股|(?:HKD|USD|RMB)\/sh/i.test(paragraphPrefix);
    const reportFacts = refs.length ? [] : reportFactsFor(statement, reports, sentence);
    // An adjacent delivered proof can substantiate the same group's rates.
    // An explicit reference must still match the actual cited page.
    const inherit = !refs.length && !pdfPageRanges(sentence).length &&
      /^\s*(?:20\d{2}\s*年(?:度)?\s*)?(?:整体|本?集[团團])\s*毛利率/u.test(clean.replace(/^\s*[^：:\n]{1,14}[：:]\s*/u, ''));
    const groupMargins = groupMarginChange(clean, inherit && inheritedMargins.length ? inheritedMargins : reportFacts);
    const pageRefs = [...statement.matchAll(/\bp\.\s*(\d+)\b|第\s*(\d+)\s*页/giu)].map(match => Number(match[1] || match[2]));
    const pdfReference = !refs.length && pageRefs.length > 0 && pdf.length > 0;
    const amounts = [...clean.matchAll(amount)].filter(m => {
      // The share count in a dividend quote is its denominator, verified with the amount.
      if (m[3] === '股' && (/每\s*$/.test(clean.slice(0,m.index)) && /^\s*(?:派|分|现金)/.test(clean.slice(quantityEnd(m))) || /元\s*[/／]\s*$/.test(clean.slice(0,m.index)))) return false;
      if (m[1] || m[3]) return true;
      const at = m.index, before = clean.slice(0,at), after = clean.slice(at+m[0].length);
      if ([...clean.matchAll(periodPattern)].some(p=>at>=p.index && at<p.index+p[0].length)) return false;
      if (/(?:storedFilename|materialId|filename|存储文件名|文件名|版本号?|version)\s*(?:为|是)?\s*[:：=]?\s*$/i.test(before)) return false;
      if (/(?:19|20)\d{2}/.test(m[2]) && /^(?:年|[AEQH])/.test(after) || /^\s*年/.test(after)) return false;
      return (refs.length || candidates.some(c=>c.metric)) && (/(?:为|是|[:：=])\s*$/.test(before) || /分别|各自/.test(before)) && !/^\s*[年月日]/.test(after);
    });
    let lastReportAmount = null;
    for (const [i,m] of amounts.entries()) {
      const priorReportAmount = lastReportAmount;
      lastReportAmount = null;
      const previous = amounts[i-1], next = amounts[i+1];
      const start = previous ? quantityEnd(previous) : 0;
      const clauses = clean.slice(start,m.index).split(/[，,()（）]/);
      const clause = clauses.pop();
      const prefix = [...clauses.filter(part => !/未核验|未验证|待核/.test(part)), clause].join('，');
      const suffix = clean.slice(quantityEnd(m),next?.index);
      // A qualification must apply to this assertion. An aside about a
      // different unverified item cannot exempt a completed amount.
      if (/未核验|未验证|待核|例如|比如|举例/.test(clause) ||
          /^\s*[（(]\s*(?:未核验|未验证|待核)\s*[）)]/.test(suffix) ||
          /(?:例如|比如|举例)[：:]?\s*$/.test(prefix)) continue;
      const identity = claimDimensions(prefix,question,pdfReference ? pdf : candidates,metricContext);
      // A distant metric in a subordinate clause does not name this amount.
      // Dates may span comma clauses, but metric labels need a local subject.
      identity.metric = statedMetric(clause,metricContext.labels) || metricContext.requested;
      const series = seriesPeriod(clean, amounts, i);
      if (series) Object.assign(identity,series);
      if (!identity.metric && previous && (series || /^[\s、，,约为是分别各自AE0-9年]*$/i.test(clause))) identity.metric = statedMetric(clean.slice(0,amounts[0].index),metricContext.labels);
      const names = clean.slice(0,amounts[0].index).match(/([^，,；;：:]+?)\s*(?:分别|各自)\s*(?:为|是)\s*$/)?.[1]?.split(/和|与|及|、/);
      if (names?.length === amounts.length) identity.metric = statedMetric(names[i], metricContext.labels);
      const local = statement.slice(start,next?.index);
      const localRefs = extractLocatorMatches(local);
      const nextRefs = localRefs.filter(r => r.index >= m.index - start);
      const precedingRef = localRefs.filter(r => r.index < m.index-start &&
        /^[\s`*:：=为是约（(]*$/.test(local.slice(r.index+r.raw.length,m.index-start).replace(/`[^`\n]*=[^`\n]*`/g,''))).at(-1);
      // A trailing source group supports the preceding series, not only its
      // last amount. Keep that group's material/version boundaries intact.
      const tail = statement.slice(quantityEnd(amounts.at(-1)));
      const grouped = amounts.length > 1 && adoptedCitations(tail,current).length >= amounts.length && refs.every(r=>r.index >= amounts.at(-1).index);
      const refText = precedingRef?.raw || (grouped ? tail : nextRefs.length ? local.slice(nextRefs[0].index) : amounts.length === 1 && refs.length === 1 ? refs[0].raw : '');
      const ref = refText ? {raw:refText} : null;
      const sharedUnit = !m[3] && (series || names?.length===amounts.length) ? amounts.at(-1)?.[3]?.trim() || '' : '';
      const claim = {...identity,ambiguous:amounts.length>1,magnitude:/折价率|折让率|扣除|扣减|减去/.test(clause),approximate:/(?:约|≈|大致|接近)\s*$/.test(prefix),value:m[2],unit:m[3]?.trim() || sharedUnit || (m[1] ? '元' : ''),
        currency:currencyOf([m[1],m[3],suffix.match(/^\s*(人民币|美元|港元|港币|USD|CNY|RMB|HKD)/i)?.[1],prefix].filter(Boolean).join(' '))};
      if(claim.unit==='倍' && /市值\s*(?:\/|÷|除以)\s*(?:归母)?净利/.test(prefix))claim.metric='市盈率';
      const compositeRate=/^[%％]$/.test(claim.unit) && /漏损|流失|转化|转化率/.test(clause);
      // Prices conventionally omit /share in prose. Only infer it from a
      // price/per-share subject, never for a company's total monetary amount.
      if (/^(?:港元|港币|美元|人民币|元|HKD|USD|CNY|RMB)$/i.test(claim.unit) &&
          (/目标价|股价|现价|每股|\bEPS\b|\bNAV\b/i.test(clean) || perShareContext) &&
          !/总额|总市值|总收入|营业收入|净利润/.test(clause)) claim.perShare = true;
      if (/^[%％]$/.test(claim.unit) && /^\s*的?(?:控股)?折价(?:率)?/.test(suffix)) claim.magnitude=true;
      if (!/%|％|个百分点/.test(claim.unit)) claim.ratio = '';
      if (!ref && suppliedPrice(claim,prefix,question)) continue;
      if(!ref && matchingMarketEvidence(claim,clean,{question,heading,evidence:marketEvidence,matches:(a,b)=>sameAmount(a,b)===null}).length)continue;
      const scenarioProof = !ref && scenarioAmountEvidence(sentence, clean.slice(0,m.index), claim.value, claim.unit, context.calculation, clean);
      if (scenarioProof) {
        if (!scenarioProof.matches) findings.push({rule:'scenario_value', field:'value', severity:'error', excerpt:statement.trim(),
          message:'所写数值与对应题设或复算结果不一致',expected:scenarioProof.expected});
        continue;
      }
      if (!ref && /可能|若|如果|假设/.test(prefix)) continue;
      if (!ref && /[%％]/u.test(claim.unit) && premiseRates.length &&
          !/实际|实现|披露|据年报/u.test(prefix) &&
          /情景[中下]|按题设|能否|取决于/u.test(clean) &&
          premiseRates.some(input => {
            if (!equalValue(input.value, claim.value)) return false;
            if (input.key === scenarioRateKey(clause)) return true;
            const [metric,verb]=input.key.split(':');
            const subject=metric.replace(/收入$/, '');
            return verb==='增' && subject && new RegExp(subject+'(?:收入)?\\s*\\+?\\s*$').test(clause) && !String(claim.value).startsWith('-');
          })) continue;
      if (claim.metric) reportedMetrics.add(groupKey(claim.metric, metrics));
      const preceding = clean.slice(start, m.index);
      const equivalent = priorReportAmount?.cited && /^\s*[（(]\s*(?:原文(?:为)?\s*)?$/u.test(preceding) &&
        /^\s*[）)]/u.test(suffix) && reportMoney.test(claim.unit) &&
        (!claim.currency || claim.currency === priorReportAmount.currency) ? amountInClaimUnit(claim, priorReportAmount) : null;
      const reportMatch = groupMargins.get(m.index) || matchReportAmount(prefix, sentence, claim, reportFacts, priorReportAmount, suffix) ||
        (equivalent && (equivalent.matches ? {fact:priorReportAmount} : {
          rule:'pdf_amount_mismatch', field:'value', message:'原文金额与所述数值不一致',
          expected:`${equivalent.expected}${claim.unit}（${priorReportAmount.filename} ${reportPages(priorReportAmount)}）`,
        })) ||
        matchReportChange(preceding, claim, priorReportAmount) || matchDirectReportChange(prefix, claim, reportFacts);
      if (reportMatch) {
        if (reportMatch.rule) findings.push({ ...reportMatch, severity:'error', excerpt:statement.trim() });
        else if (claim.unit !== '%') lastReportAmount = reportMatch.fact;
        continue;
      }
      let pool = candidates;
      if (ref) {
        const fresh = adoptedCitations(ref.raw,current);
        const adopted = fresh.length ? fresh : adoptedCitations(ref.raw,all);
        const matches = c => c && adopted.some(a=>citationIdentity(a)===citationIdentity(c) && a.locator===c.locator);
        // A calculation may cite any of its bound inputs. Its display anchor
        // depends on binding order; that must not change evidence validity.
        pool = all.filter(c=>matches(c) || c.derivedFrom?.some(id=>matches(deps.sources.get(id))));
      } else if (pdfReference) {
        const onPage = pdf.filter(source => pageRefs.includes(source.page));
        const named = onPage.filter(source => source.filename && statement.includes(source.filename));
        const eligible = /\.pdf\b/iu.test(statement) ? named : onPage;
        pool = new Set(eligible.map(source => source.materialId)).size === 1 ? eligible : [];
      }
      const issues = pool.map(c=>compare(claim,c,deps));
      if (issues.some(issue=>!issue)) continue;
      if (scenarioOutputSupports(claim,clean,pool,calls,deps)) continue;
      if (!ref && fetchedQuantitySupports(claim,sourceStatement,[...calls,...(context.sourceCalls || [])])) continue;
      // Older registers can hold corrections and quotes without a unit or
      // financial identity. They remain usable as standalone legacy amounts.
      if (!ref && !pdfReference && ledgerSources.some(c=>c.legacy && !c.display_unit && !c.metric && equalValue(c.value,claim.value))) continue;
      // Only report an expected value from an explicitly bound source or a
      // matching identity. An unrelated candidate is not a correction.
      const identityPool = pool.map((cell,index)=>({cell,issue:issues[index]})).filter(({cell}) =>
        (!compositeRate || /^(?:%|％|decimal|fraction)$/.test(cell.raw_unit || cell.display_unit || '')) &&
        (!claim.segment || !cell.segment || claim.segment===cell.segment) &&
        (!claim.metric || groupKey(claim.metric,metrics)===groupKey(cell.metric,metrics) ||
          !cell.metric && !cell.derivedFrom && sameAmount(claim,cell)===null) &&
        (!claim.period || !periodParts(cell.period).period || claim.period===periodParts(cell.period).period) &&
        (claim.metric || sameAmount(claim,cell)===null));
      // Pick the closest identity, not whichever citation was emitted first.
      // A 2026 value cannot disprove a 2025 assertion when a 2025 source is
      // present but its unit metadata is missing.
      const score = cell => ['period','metric','currency','basis_type','segment'].reduce((n,field)=>{
        if (!claim[field]) return n;
        const a=field==='period'?claim.period:field==='metric'?groupKey(claim.metric,metrics):field==='basis_type'?groupKey(claim.basis_type,bases):field==='segment'?claim.segment:claim.currency;
        const b=field==='period'?periodParts(cell.period).period:field==='metric'?groupKey(cell.metric,metrics):field==='basis_type'?groupKey(cell.basis_type || periodParts(cell.period).basis_type,bases):field==='segment'?cell.segment:currencyOf(cell.currency || cell.raw_unit || cell.display_unit);
        return n+(a===b?3:!b || b==='unknown'?0:-4);
      },sameAmount(claim,cell)===null?100:0);
      const scoped = (ref ? pool.map((cell,index)=>({cell,issue:issues[index]})) : identityPool).toSorted((a,b)=>score(b.cell)-score(a.cell));
      const best=scoped.filter(x=>score(x.cell)===score(scoped[0]?.cell || {}));
      const relevant = best.find(x=>x.issue?.[1]==='出处缺少该字段')?.issue || best.find(x=>x.issue?.[0]==='value')?.issue || best[0]?.issue;
      const field = relevant?.[0], expected = relevant?.[1];
      findings.push({rule:field && (field !== 'value' || ref) ? 'evidence_identity_mismatch' : 'unsourced_number',severity:expected === '出处缺少该字段' && (ref || best.some(x=>sameAmount(claim,x.cell)===null)) ? 'warning' : 'error',field:field || 'source',
        message:expected === '出处缺少该字段' ? `出处缺少${fieldNames[field]}信息，需要补核，尚不能判断主张错误` : field?`主张的${fieldNames[field]}与出处不匹配`:'主张数字没有完整登记或本轮结构化出处',
        claim, evidenceIds: (ref ? pool : identityPool.map(x=>x.cell)).map(c=>c.id).filter(Boolean),
        excerpt:statement.trim(),evidenceStatus: expected === '出处缺少该字段' ? 'metadata_missing' : !relevant ? 'missing_source' : 'source_conflict',expected: expected != null ? String(expected) : '核验同一指标、期间和单位的来源'});
    }
    // Synthetic table-cell statements are not literal prose spans. Keep the
    // original table boundary so final delivery cannot miss their findings.
    for(let j=findingStart;j<findings.length;j++)findings[j].sourceText=sourceText;
  }
  if (metricContext.requested && reportedMetrics.size && !reportedMetrics.has(metricContext.requested)) {
    findings.push({rule:'unanswered_metric', severity:'error', message:`答文未给出所问指标：${metricContext.requested}`,
      excerpt:[...reportedMetrics].join('、'), expected:metricContext.requested});
  }
  return findings;
}


// Candidate generation for semantic reconciliation. The reviewer can explain
// a local metric binding; it cannot invent a source or change a numeric value.
export function reconciliationCandidates(finding, context) {
  if (!finding.claim || finding.severity!=='error') return [];
  if (!(finding.rule==='unsourced_number' || finding.rule==='evidence_identity_mismatch' &&
      finding.field==='metric')) return [];
  if (['dependency','version','currency','basis_type','company','scope'].includes(finding.field)) return [];
  const current=context.citations || [], calls=context.toolCalls || [];
  const sources=enrichFinancialSources([...new Map([...current,...collectCitationsFromToolCalls(calls)].map(c=>[c.id,c])).values()],calls);
  const deps={sources:new Map(sources.map(c=>[c.id,c])),calls,versions:context.currentVersions};
  // Explicit references remain binding, even when the sentence has many values.
  const bound=finding.rule==='evidence_identity_mismatch' ? new Set(finding.evidenceIds) : null;
  const claim={...finding.claim,metric:finding.claim.ambiguous?'':finding.claim.metric,ratio:''};
  if (!claim.metric && /估值|目标价|每股|股价/.test(context.question || '') &&
      /^(?:港元|港币|美元|人民币|元|HKD|USD|CNY|RMB)$/i.test(claim.unit)) claim.perShare=true;
  return sources.filter(c=>{
    if (bound && !bound.has(c.id)) return false;
    if (!currentCitation(c,context.currentVersions) || derivedEvidenceIssue(c,deps.sources,calls)) return false;
    if (sameAmount(claim,c)!==null) return false;
    const sourceMetricKnown=metrics.some(group=>groupKey(c.metric,metrics)===group[0]);
    const interpretation=finding.field==='metric' && !sourceMetricKnown ? {...claim,metric:''} : claim;
    const issue=compare(interpretation,c,deps);
    return !issue;
  }).slice(0,20);
}

export const matchesEvidenceQuantity = (claim, source) => sameAmount(claim,source) === null;
