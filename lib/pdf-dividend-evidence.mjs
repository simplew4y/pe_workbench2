import { calculate } from './calc-tool.mjs';

const number = String.raw`\d+(?:,\d{3})*(?:\.\d+)?`;
const perShare = String.raw`每\s*(\d+)?\s*股\s*派(?:发)?(?:现金(?:红利|股利)?)?\s*(${number})\s*元`;
const proposalPatterns = [
  String.raw`(20\d{2})\s*年\s*(?:年)?度\s*(?:公司)?现金分配方案[^。\n]{0,280}?拟[^。\n]{0,220}?(?:共计|合计)分配现金\s*(${number})\s*元`,
  String.raw`拟[^。\n]{0,140}?实施\s*(20\d{2})\s*年\s*(?:年)?度\s*利润分配[^\n]{0,300}?以此计算(?:共计|合计)派发现金红利\s*(${number})\s*元`,
].map(pattern => new RegExp(pattern, 'gu'));
const interimPattern = new RegExp(String.raw`[《「](20\d{2})\s*年\s*中期(?:利润分配|现金分红)方案[》」][^。\n]{0,150}?(\d+(?:,\d{3})*(?:\.\d+)?)\s*(万)?股为基数[^。\n]{0,45}?${perShare}(?:(?!\n|[《「])[^\n]){0,250}?实施完毕`, 'gu');
const clean = value => value.replaceAll(',', '');

export function pdfDividendFacts(text, page) {
  const facts = [];
  function append(metric, year, value, rate, formula) {
    const fact = {metric, year, part:'FY', page, value, display_unit:'元', currency:'CNY', formula};
    facts.push(fact);
    if (!rate) return;
    const shares = rate[1] || '1';
    const amount = rate[2];
    facts.push({
      ...fact, metric:`${metric}_per_share`, value:calculate({expression:`${clean(amount)} / ${shares}`}).value,
      formula:`每${shares}股${amount}元`,
    });
  }
  for (const pattern of proposalPatterns) {
    for (const [source, year, value] of text.matchAll(pattern)) {
      append('annual_dividend_proposal', year, value, source.match(new RegExp(perShare, 'u')));
    }
  }
  for (const [, year, base, scale, shares = '1', rate] of text.matchAll(interimPattern)) {
    const baseExpression = scale ? `(${clean(base)} * 10000)` : clean(base);
    const formula = `${baseExpression} * ${clean(rate)} / ${shares}`;
    append('interim_dividend_paid', year, calculate({expression:formula}).value, [null, shares, rate], formula);
  }
  return facts;
}

// Join only the original disclosures for this one report. Duplicate
// appearances of the same amount on different pages are interchangeable.
export function dividendTotals(facts) {
  const annual = facts.filter(fact => fact.metric === 'annual_dividend_proposal');
  const interim = facts.filter(fact => fact.metric === 'interim_dividend_paid');
  const totals = [];
  for (const year of new Set(annual.map(fact => fact.year))) {
    const proposals = annual.filter(fact => fact.year === year);
    const payments = interim.filter(fact => fact.year === year);
    if (new Set(proposals.map(fact => clean(fact.value))).size !== 1 ||
        new Set(payments.map(fact => clean(fact.value))).size !== 1) continue;
    const value = calculate({expression: `${clean(proposals[0].value)} + ${clean(payments[0].value)}`}).value;
    for (const proposal of proposals) for (const payment of payments) totals.push({
      ...proposal, metric:'dividends_with_proposal', value,
      pages:[...new Set([payment.page, proposal.page])].sort((a, b) => a - b),
      formula:`中期 ${payment.value}元 + 年度预案 ${proposal.value}元`,
    });
  }
  return totals;
}

export function dividendClaim(prefix, sentence, suffix, previousAmount, unit) {
  if (/假设|估算|同比|并非|误写/.test(prefix)) return null;
  const year = sentence.match(/(20\d{2})\s*年(?:度)?/u)?.[1] || '';
  // The composite amount includes a proposal as well as a completed payment.
  // "Total cash paid" and an unqualified annual dividend mean something else.
  if (/(?:两(?:项|期|笔|次)|中期(?:分红)?(?:加|与|和|\+)年度(?:分红)?预案)\s*合计\s*(?:为|约|共|[:：])*\s*$/u.test(prefix) && /中期/.test(sentence) &&
      /年度[^。；]{0,12}(?:预案|拟)/u.test(sentence) && !/均已(?:派|发|实施)|合计已(?:派|发)/u.test(sentence)) {
    return {metric:'dividends_with_proposal', year, part:'FY'};
  }
  const rate = prefix.match(/每\s*(\d+)?\s*股\s*(?:拟)?(?:派(?:发)?(?:现金(?:红利|股利)?)?)?\s*(?:为|约|[:：])*\s*$/u);
  const suffixRate = suffix.match(/^\s*[/／]\s*(\d+)\s*股/u)?.[1];
  if (rate || suffixRate || unit === '元/股') {
    const head = rate ? prefix.slice(0, rate.index) : prefix;
    const shares = rate?.[1] || suffixRate || '1';
    if (/中期[^；，。]{0,14}$/u.test(head)) return {metric:'interim_dividend_paid_per_share', year, part:'FY', shares};
    if (/年度[^；，。]{0,14}(?:预案|拟)[^；，。]{0,10}$/u.test(head + (rate?.[0] || ''))) {
      return {metric:'annual_dividend_proposal_per_share', year, part:'FY', shares};
    }
    return null;
  }
  if (previousAmount?.metric === 'annual_dividend_proposal_per_share' && /合计\s*(?:为|约|共|[:：])*\s*$/u.test(prefix) &&
      !/中期|两(?:项|期|笔|次)/u.test(prefix)) {
    return {metric:'annual_dividend_proposal', year:year || previousAmount.year, part:'FY'};
  }
  if (/中期(?:现金)?(?:分红|红利|股利)\s*(?:为|是|约|[:：])*\s*$/u.test(prefix)) {
    return {metric:'interim_dividend_paid', year, part:'FY'};
  }
  if (/中期/.test(prefix)) return null;
  const annual = prefix.match(/(?:(20\d{2})\s*年)?\s*(?:年度|全年|年末|年终|度)?\s*(?:现金分红|利润分配)?预案\s*(?:金额)?\s*(?:为|是|约|[:：])*\s*$/u) ||
    prefix.match(/(?:(20\d{2})\s*年)?\s*(?:年度|全年|度)\s*(?:现金分红方案|分红方案|利润分配方案)?\s*(?:拟派(?:发)?(?:现金(?:红利|股利)?)?|拟(?:现金)?分红)\s*(?:为|约|[:：])*\s*$/u);
  if (!annual || !/现金|分红|利润分配|股利|红利/.test(sentence)) return null;
  return {metric:'annual_dividend_proposal', year:annual[1] || year, part:'FY'};
}
