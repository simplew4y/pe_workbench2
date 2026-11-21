import { composeResearchAnswer } from '../../lib/answer-composition.mjs';
import { convertExact, formatDecimal } from '../../lib/calc-tool.mjs';
import { answerCharCount } from '../../lib/answer-length.mjs';
import { pdfPageRanges } from '../../lib/pdf-period-evidence.mjs';
import { readCitedPdfReports } from './pdf-period-evidence.mjs';

const billionYuan = amount => formatDecimal(convertExact(amount.replaceAll(',', ''), '元', '亿元'), 2);
const pageRefs = pages => pages.map(page => 'p.' + page).join('、');
const shortName = report => report.filename.match(/^([\p{L}\p{N}]{2,28})_/u)?.[1];
const source = (report, fact) => ({
  filename:report.filename, materialId:report.materialId, version:report.version, sha256:report.sha256,
  ...fact,
});

export async function preparePdfDisclosure(ctx, attachments, question, history, summaryItems, budget, priorQuestions = []) {
  const pdfs = (attachments || []).filter(path => /\.pdf$/i.test(path));
  const compareDividends = pdfs.length > 1 && /可比|对比|比较/u.test(question) &&
    /[：:、，,]\s*(?:现金)?分红(?=[。！？；;、，,]|$)/u.test(question);
  const marginSummary = pdfs.length === 1 && summaryItems.includes('最强证据') && /毛利率/u.test(history);
  if (!compareDividends && !marginSummary) return null;
  const years = [...new Set([...question.matchAll(/(20\d{2})\s*年/gu)].map(match => match[1]))];
  if (years.length > 1) return null;
  const year = years[0];
  const profitCounterpoint = marginSummary && summaryItems.includes('反证') &&
    /非\s*(?:IFRS|[国國][际際][财財][务務][报報]告[准準][则則])/iu.test(history) && /股[权權]激励|股份酬金/u.test(history);
  const scenarioHorizon = marginSummary && summaryItems.includes('三项待核') &&
    priorQuestions.at(-1)?.match(/^(?:虚构|假设)(?:压力)?情景[：:]\s*(未来[一二三四五六七八九十两\d]+(?:个)?季(?:度)?)[^。！？\n]*?[，,；;、]\s*经营现金流\s*(?:仍然?|尚)?未知(?=[，,。；;！？]|$)/u)?.[1];
  const reports = await readCitedPdfReports(ctx, pdfs, [], '', page => page.paragraphs.some(paragraph =>
    compareDividends ? /现金分配方案|中期(?:利润分配|现金分红)方案|合计派发现金红利|分销售模式|不同模式、不同产品|经营活动产生的现金流量净额/u.test(paragraph)
      : /毛利率/u.test(paragraph) || profitCounterpoint && /[權权]益持有人[應应][佔占]盈利/u.test(paragraph) ||
        Boolean(scenarioHorizon) && /自由[現现]金流/u.test(paragraph)));

  let result;
  if (compareDividends) {
    const entries = reports.map(report => {
      const name = shortName(report);
      if (!name || !question.includes(name)) return null;
      const totals = report.facts.filter(fact => fact.metric === 'dividends_with_proposal' && (!year || fact.year === year));
      if (new Set(totals.map(fact => fact.year)).size !== 1) return null;
      const total = totals[0];
      const proposal = report.facts.find(fact => fact.metric === 'annual_dividend_proposal' &&
        fact.year === total.year && total.pages.includes(fact.page));
      return {report, name, total, proposal};
    });
    if (entries.length !== pdfs.length || entries.some(entry => !entry) ||
        new Set(entries.map(entry => entry.total.year)).size !== 1) return null;
    entries.sort((left, right) => question.indexOf(left.name) - question.indexOf(right.name));
    const dividends = {
      heading:'分红',
      body:[
        '**分红**',
        ...entries.map(({name, total, proposal}) =>
          `${name}${total.year}年已实施中期分红及年度预案合计${billionYuan(total.value)}亿元，年度预案为${billionYuan(proposal.value)}亿元（年报${pageRefs(total.pages)}）。`),
        '跟踪两期分红占归母净利润的比例，以及年度预案的实际执行。',
      ].join('\n'),
      facts:entries.flatMap(({report, total, proposal}) => [source(report, total), source(report, proposal)]),
    };
    const sections = [];
    const additional = [
      ['渠道', 'annual_sales_channels', ({name}, row) =>
        `${name}直销占${row.year}年酒类收入${row.directShare}%（直销收入÷酒类收入），直销毛利率${row.direct.margin}%（年报p.${row.page}）。`],
      ['现金转化', 'operating_cash_flow', ({name}, row) =>
        `${name}${row.year}年经营现金流净额${billionYuan(row.value)}亿元（年报p.${row.page}）。`],
    ];
    for (const [heading, metric, render] of additional) {
      if (!question.includes(heading)) continue;
      const values = entries.map(({report, total}) => report.facts.filter(row => row.metric === metric &&
        row.year === total.year && row.part === 'FY'));
      if (values.some(rows => rows.length !== 1)) continue;
      const rows = values.map(([row]) => row);
      const body = [`**${heading}**`, ...entries.map((entry, index) => render(entry, rows[index])),
        heading === '现金转化' ? '比较经营现金流和净利润是否同步，并追踪预收、存货等变动。' : '按年报渠道定义比较收入结构和毛利率。',
      ].join('\n');
      const combined = [...sections, {body}, dividends].map(section => section.body).join('\n\n');
      if (budget !== null && answerCharCount(combined) >= budget) continue;
      sections.push({heading, body, facts:entries.map(({report}, index) => source(report, rows[index]))});
    }
    sections.push(dividends);
    result = {
      kind:'dividends', heading:dividends.heading, headings:sections.map(section => section.heading),
      body:sections.map(section => section.body).join('\n\n'), facts:sections.flatMap(section => section.facts),
    };
  } else {
    const [report] = reports;
    const name = report && shortName(report);
    if (!name || !history.includes(name)) return null;
    const cited = pdfPageRanges(history);
    const margins = report.facts.filter(fact => fact.metric === 'group_gross_margin' && fact.segments?.length &&
      (!year || fact.year === year) && cited.some(([first, last]) => first <= fact.page && fact.page <= last));
    if (margins.length !== 1) return null;
    const [margin] = margins;
    const allUp = margin.segments.every(row => Number(row.value) > Number(row.previous));
    const changes = margin.segments.map(row => `${row.label}${row.previous}%→${row.value}%`).join('、');
    const observedYear = Number(margin.value) > Number(margin.previousValue) &&
      summaryItems.includes('已修订的结论') ? margin.year : '';
    const observed = observedYear
      ? `**最强证据**：${name}${observedYear}年集团毛利率已由${margin.previousValue}%升至${margin.value}%（年报p.${margin.page}）。${allUp ? '各分部同比均升：' : '分部毛利率：'}${changes}。\n后续能否延续仍待验证。`
      : `**最强证据**：${name}${margin.year}年报p.${margin.page}列有集团和各分部毛利率。集团${margin.previousValue}%→${margin.value}%，${allUp ? '各分部同比均升，' : ''}${changes}。`;
    result = {
      kind:'segment_margins', heading:'最强证据',
      body:observed, observedYear,
      facts:[source(report, margin)],
    };
    const profit = profitCounterpoint ? report.facts.filter(fact => fact.metric === 'annual_owner_profit_yoy_comparison' && fact.year === margin.year) : [];
    if (profit.length === 1) {
      const [row] = profit;
      const counterpoint = `**反证**：${row.year}年归母盈利同比，IFRS为${row.reported}%，非IFRS为${row.adjusted}%（年报p.${row.page}）。仅凭调整后盈利增速，无法判断经营改善的来源。`;
      const combined = observed + '\n\n' + counterpoint;
      if (budget === null || answerCharCount(combined) < budget) {
        result = {...result, body:combined, headings:['最强证据','反证'], facts:[...result.facts,source(report,row)]};
      }
    }
    const quarterlyCash = scenarioHorizon ? report.facts.filter(fact => fact.metric === 'free_cash_flow' &&
      fact.year === margin.year && fact.part === 'Q4' && fact.currency === 'CNY') : [];
    if (quarterlyCash.length === 1) {
      const [row] = quarterlyCash;
      const cash = `**现金流**：${row.year}年第四季度自由现金流为${row.value}${row.display_unit}（年报p.${row.page}）。\n题设中${scenarioHorizon}的经营现金流仍未知。`;
      const combined = result.body + '\n\n' + cash;
      if (budget === null || answerCharCount(combined) < budget) {
        result = {...result, body:combined, headings:[...(result.headings || [result.heading]),'现金流'],
          facts:[...result.facts,source(report,row)], scenarioCashFlow:{horizon:scenarioHorizon,userTurn:priorQuestions.length}};
      }
    }
  }
  return budget === null || answerCharCount(result.body) < budget ? result : null;
}

const headings = /^(?:#{1,6}\s+|\*\*[^*]+\*\*|(?:[一二三四五六\d]+[、.．]\s*)?(?:品牌定价|渠道|现金转化|现金流|分红(?:口径)?|结论|框架|置信度|最强证据|反证|已修订的结论|三项待核|下次行动)[：:])/u;
function withoutRepeatedSection(text, heading) {
  let skipped = false;
  return text.split('\n').filter(line => {
    const trim = line.trim();
    const label = trim.replace(/^(?:#{1,6}\s+|\*\*|(?:[一二三四五六\d]+[、.．]\s*))+/u, '');
    if (label.startsWith(heading) && /^[*\s：:（(]|^$/u.test(label.slice(heading.length))) {
      skipped = true;
      return false;
    }
    if (headings.test(trim)) skipped = false;
    return !skipped;
  }).join('\n');
}

const marginDenial = /(?:(?:未(?:披露|列(?:示|出)?|提供)|没有(?:披露|列(?:示|出)?|提供))\s*(?:明示的?|具体的?|各个?)?(?:分部|分业务)\s*毛利率(?:明细)?(?=[，,。；;）)\s]|$)|(?:分部毛利率(?:明细)?|分部上升|分部明细)(?:在(?:该页|本表|年报))?\s*(?:未(?:披露|列示|见于|提供)|没有(?:披露|列示)|不披露)|(?:仅|只)(?:有)?集团(?:层面)?毛利率[^，。；]{0,8}(?:可核实|有披露|有明细))/u;
const marginGap = /^(?:各)?分部(?:的)?毛利率(?:明细)?[。.]?$/u;
const attributionGap = /^(?:AI|人工智能)(?:资本开支|投入)(?:所?对应|所?带来|所?产生)的?(?:收入贡献|回报)(?:的?(?:量化证据|数据))?[。.]?$/iu;
const undatedCashFlow = /^\s*当前(?:值|的?现金流|的?自由现金流)(?:已|已被|被)?(?:压低|下降)\s*[（(][^）)]*[）)]\s*[。.]?\s*$/u;

export function prepareDisclosureAnswer(answer, section, requestedItems = [], question = '') {
  if (!section) return {text:answer, removed:[]};
  const covered = section.headings || [section.heading];
  const labels = covered.includes('最强证据') && covered.includes('反证') ? [...covered,'最强证据与反证'] : covered;
  const modelText = labels.reduce(withoutRepeatedSection, answer);
  if (section.kind !== 'segment_margins') return {text:modelText.trim(), removed:[]};
  const [margin] = section.facts;
  const cash = section.scenarioCashFlow && section.facts.find(fact => fact.metric === 'free_cash_flow');
  const requestsFollowUp = requestedItems.includes('三项待核') && requestedItems.includes('下次行动') &&
    !/核验|核实|查证|核对/u.test(question);
  const downgrade = section.observedYear && new RegExp(String.raw`^(?<lead>\s*(?:\d+[.、．)）]\s*)?)原[“「"](?:${section.observedYear}\s*年(?:度)?)?(?:集团|整体)?毛利率(?:同比)?(?:已)?(?:改善|提升)(?:已|可)?确认[”」"]\s*(?:改为|调整为|修订为|下调为)[“「"]?待观察[”」"]?(?:[，,][^。；]*?(?:单期|一年|延续|趋势)[^。；]*)?[。]?$`, 'u');
  const retraction = section.observedYear && new RegExp(String.raw`(?:决定|判断|评估)是否(?:推翻|否定)\s*${section.observedYear}\s*年(?:单期结论|毛利率(?:同比)?改善(?:的结论)?)`, 'u');
  const removed = [];
  const lines = modelText.split('\n');
  const text = lines.map((original, index) => {
    let line = original;
    if (cash && /现金流/u.test(original + (lines[index - 1] || ''))) {
      line = original.split(/(?<=。)/u).filter(clause => {
        if (!undatedCashFlow.test(clause) || !pdfPageRanges(clause).some(([first,last]) => first <= cash.page && cash.page <= last)) return true;
        removed.push(clause.trim());
        return false;
      }).join('');
    }
    if (/^\s*未核验[：:]/u.test(line)) {
      const [, items] = line.split(/[：:]/u, 2);
      const future = [];
      const kept = items.split(/[、，,；;]/u).filter(item => {
        const value = item.trim().replace(/^以及\s*/u, '');
        if (marginGap.test(value)) {
          removed.push(value);
          return false;
        }
        const futureYear = value.match(/^(20\d{2})\s*年(?:及以后|以后|后)?(?:的)?(?:各期)?(?:财务数据|财报数据|年报数据|定期报告|同口径(?:财务|财报|年报)?数据)[。.]?$/u)?.[1];
        if (requestsFollowUp && ((futureYear && Number(futureYear) > Number(margin.year)) ||
            (section.observedYear && attributionGap.test(value)))) {
          future.push(value);
          return false;
        }
        return true;
      });
      return [kept.length ? '未核验：' + kept.join('、') : '',
        future.length ? '后续核对资料：' + future.map(value => value.replace(/[。.]$/u, '')).join('、') + '。' : '']
        .filter(Boolean).join('\n');
    }
    const refs = pdfPageRanges(line);
    const years = [...line.matchAll(/(20\d{2})\s*年/gu)].map(match => match[1]);
    if ((refs.length && !refs.some(([first, last]) => first <= margin.page && margin.page <= last)) ||
        (years.length && years.every(year => year !== margin.year && year !== margin.previous))) return line;
    const heading = line.match(/^\s*\*\*[^*]+\*\*\s*[：:]?/u)?.[0] || '';
    if (heading && !line.slice(heading.length).trim()) return line;
    const kept = line.slice(heading.length).split(/(?<=[。！？；;])/u).map(clause => {
      if (marginDenial.test(clause.trim().replace(/[。！？；;]$/u, ''))) {
        removed.push(clause.trim());
        return '';
      }
      const revision = downgrade && clause.match(downgrade);
      if (revision) {
        removed.push(clause.trim());
        return `${revision.groups.lead}${section.observedYear}年毛利率同比改善已确认。后续能否延续仍待观察。`;
      }
      if (retraction && retraction.test(clause)) {
        removed.push(clause.trim());
        return clause.replace(retraction, '判断毛利率改善能否延续');
      }
      return clause;
    }).join('');
    return kept.trim() ? heading + kept : '';
  }).join('\n');
  return {text:text.replace(/\n{3,}/gu, '\n\n').trim(), removed};
}

export function appendDisclosure(outcome, section) {
  return {
    ...outcome, status:outcome.status === 'failed' ? 'partial' : outcome.status,
    text:composeResearchAnswer(outcome.text, { verifiedPdfDisclosure: section }),
    pdfDisclosure:{kind:section.kind, body:section.body, facts:section.facts,
      ...(section.scenarioCashFlow ? {scenarioCashFlow:section.scenarioCashFlow} : {})},
  };
}
