import { calculate } from './calc-tool.mjs';

const number = String.raw`[+-]?(?:\d{1,14}(?:\.\d{1,8})?|\.\d{1,8})`;
const amount = (expression, unit = '') => ({ expression, unit, value: calculate({ expression }).value });
const quotient = (n, d, percent = false) => Number(d) === 0 ? null : {
  expression: `(${n})/(${d})${percent ? '*100' : ''}`,
  unit: percent ? '%' : '倍',
  value: calculate({ expression: `(${n})/(${d})${percent ? '*100' : ''}`, precision: 2 }).value,
};
const display = result => result ? result.value + result.unit : '无定义（分母为零）';
const inputsAt = (fields, turn) => Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {value, userTurn:turn}]));

const totalChange = new RegExp(String.raw`总收入(?:同比)?(增长|增加|下降|减少)\s*(${number}%)`, 'u');
const shares = new RegExp(String.raw`(?:^|[,;:。])\s*(?<component>(?:第一大|最大|头部|核心|主要)[\p{L}]{1,12}?)(?:的?收入)?占比(?:由|从)?\s*(?<before>${number}%)\s*(?:升至|增至|降至|降到|变为|到|至|→)\s*(?<after>${number}%)`, 'u');
const startingRevenue = new RegExp(String.raw`(?:原|基期|上期)总收入\s*(?:为|是|=)?\s*(${number})(?![\d.%万亿元])`, 'u');

function componentGrowth(text, turn) {
  const change = text.match(totalChange);
  const share = text.match(shares)?.groups;
  const base = text.match(startingRevenue)?.[1];
  if (!base || !change || !share || !/其(?:他|余).*收入增(?:长)?率|其(?:他|余).*增速/u.test(text)) return null;
  const { component, before, after } = share;
  const decreases = /下降|减少/u.test(change[1]);
  if (decreases && /^[+-]/u.test(change[2])) return null;
  const rate = decreases ? '-' + change[2] : change[2];
  const inRange = value => parseFloat(value) >= 0 && parseFloat(value) <= 100;
  if (Number(base) <= 0 || !inRange(before) || !inRange(after) || parseFloat(rate) < -100) return null;
  const total = amount(`${base}*(1+(${rate}))`);
  const firstBase = amount(`${base}*(${before})`);
  const firstNow = amount(`${total.value}*(${after})`);
  const otherBase = amount(`${base}-${firstBase.value}`);
  const otherNow = amount(`${total.value}-${firstNow.value}`);
  const firstDelta = amount(`${firstNow.value}-${firstBase.value}`);
  const otherDelta = amount(`${otherNow.value}-${otherBase.value}`);
  const totalDelta = amount(`${total.value}-${base}`);
  const firstGrowth = quotient(firstDelta.value, firstBase.value, true);
  const otherGrowth = quotient(otherDelta.value, otherBase.value, true);
  const contribution = quotient(firstDelta.value, totalDelta.value, true);
  const otherContribution = quotient(otherDelta.value, totalDelta.value, true);
  const inputs = inputsAt({component, baseRevenue:base, totalGrowth:rate, initialShare:before, finalShare:after}, turn);
  const outputs = {total, firstBase, firstNow, otherBase, otherNow, firstDelta, otherDelta, totalDelta,
    ...Object.fromEntries(Object.entries({firstGrowth,otherGrowth,contribution,otherContribution}).filter(([,v]) => v))};
  return {
    receipt: {template:'component-revenue-growth', inputs, outputs},
    body: [
      `按题设，${component}收入从 ${firstBase.value} 到 ${firstNow.value}，增长率为 **${display(firstGrowth)}**。其余合计从 ${otherBase.value} 到 ${otherNow.value}，增长率为 **${display(otherGrowth)}**。`,
      `两期总收入为 ${base} 和 ${total.value}。两期分别乘当期占比 ${before}、${after}，得到${component}的收入。总收入变动 ${totalDelta.value}，其中${component}贡献 ${firstDelta.value}，其余贡献 ${otherDelta.value}。${contribution ? '两者分别占总变动的 ' + display(contribution) + ' 和 ' + display(otherContribution) + '。' : '总变动为零，无法计算增量贡献比例。'}`,
    ].join('\n\n'),
    supplement: /健康|证明|说明|判断/u.test(text) ? '用一两句话回答原题的判断，结合其余产品实际的变动方向给理由。各组成部分的增量和增速已在正文，只写一遍判断。' : '原题的计算已列出，只说明各组增长率使用各自的基期收入作分母。',
  };
}

const cashField = new RegExp(String.raw`(归母净利(?:润)?|经营现金流(?:净额)?|资本开支|(?:现金)?分红)\s*(?:为|=)?\s*(${number})`, 'gu');
const payoutLabel = key => key.startsWith('归母') ? 'income' : key.startsWith('经营') ? 'cash' : key.startsWith('资本') ? 'capex' : 'dividend';
const cashRow = /^\s*(?:虚构(?:对比|情景)|假设(?:对比|情景)?)?\s*:?\s*([A-Za-z]|甲|乙|丙|丁)(?:公司)?\s*[:：]?\s*(.*)$/u;

function dividendCoverage(text, turn) {
  if (!/分红覆盖倍数/u.test(text) || !/简化自由现金流/u.test(text)) return null;
  const clauses = text.split(/[。!?]/u)[0].split(';');
  if (clauses.length !== 2) return null;
  const rows = [];
  let order;
  for (const clause of clauses) {
    const match = clause.match(cashRow);
    if (!match) return null;
    const [, company, data] = match;
    const fields = [...data.matchAll(cashField)];
    let values;
    if (fields.length === 4 && /^[\s、,]*$/u.test(data.replace(cashField,''))) {
      const labels = fields.map(field => payoutLabel(field[1]));
      if (new Set(labels).size !== 4) return null;
      order = labels;
      values = Object.fromEntries(fields.map((field,i) => [labels[i],field[2]]));
    } else if (order && /^对应(?:为)?/u.test(data)) {
      const cells = data.replace(/^对应(?:为)?/u,'').trim().split(/\s*[、,]\s*/u);
      if (cells.length !== order.length || !cells.every(cell => new RegExp('^' + number + '$').test(cell))) return null;
      values = Object.fromEntries(order.map((key,i) => [key,cells[i]]));
    } else return null;
    if (Number(values.dividend) < 0 || rows.some(row => row.company === company)) return null;
    const fcf = amount(`(${values.cash})-(${values.capex})`);
    const cover = quotient(fcf.value,values.dividend);
    rows.push({company,values,fcf,cover});
  }
  const inputs = {}, outputs = {};
  const lines = rows.map(({company,values,fcf,cover}) => {
    for (const [k,v] of Object.entries(values)) inputs[company + '.' + k] = {value:v,userTurn:turn};
    outputs[company+'.fcf'] = fcf;
    if (cover) outputs[company+'.coverage'] = cover;
    return `- ${company} 的自由现金流为 ${values.cash} − ${values.capex}＝**${fcf.value}**。覆盖倍数为 ${fcf.value} ÷ ${values.dividend}＝**${display(cover)}**。`;
  });
  return {
    receipt: {template:'free-cash-flow-dividend-coverage',inputs,outputs},
    body: ['按题设，简化自由现金流等于经营现金流减资本开支。分红覆盖倍数是自由现金流除以分红，表示当期产生的钱够付几次分红。', ...lines].join('\n\n'),
    supplement: /投资|值得|缺口|判断/u.test(text) ? '回答原题的投资判断。说明当期现金是否够分红、多年现金能否持续、缺口如何筹资，以及买入价格为何影响回报。公司是题设的代号，不需为它们寻找实名。' : '说明覆盖倍数怎样反映当期的现金能否支付分红。',
  };
}

export function calculateScenarioRatios(text, turn) {
  if (!/^(?:虚构|假设|题设)/u.test(text)) return null;
  return componentGrowth(text,turn) || dividendCoverage(text,turn);
}

function checkCoverageValue(findings, receipt, company, value, excerpt) {
  const fcf = receipt.outputs[company+'.fcf'];
  if (!fcf) return;
  const dividend = receipt.inputs[company+'.dividend'];
  const expected = receipt.outputs[company+'.coverage'];
  const places = (value.split('.')[1] || '').length;
  if (expected && places <= 100 && Number(calculate({expression:expected.expression,precision:places}).value) === Number(value)) return;
  findings.push({rule:'scenario_conclusion',severity:'error',excerpt,message:company+' 的分红覆盖倍数与题设计算不符',
    expected:`${fcf.value} ÷ ${dividend.value}，结果为${display(expected)}`});
}

/** Check meaning as well as the arithmetic, against this scenario's own inputs. */
export function ratioInterpretationFindings(draft, receipt) {
  if (!receipt || !['component-revenue-growth','free-cash-flow-dividend-coverage'].includes(receipt.template)) return [];
  const findings = [];
  let table;
  for (const raw of draft.split(/[。！？\n]/u)) {
    const excerpt = raw.trim();
    const statement = excerpt.replace(/[*\x60\s]/gu, '');
    if (receipt.template === 'component-revenue-growth') {
      const {firstDelta,otherDelta} = receipt.outputs;
      const exclusive = /(?:全靠|全由|完全由|都由|全部来自|完全来自|完全依赖|均来自|唯一(?:的)?(?:增长)?来源)/u.exec(statement);
      if (!exclusive || /(?:不能说|不能证明|无法证明|不能断言|不是|并非|并不|非|不|若|假如)[^，,；;]{0,12}$/u.test(statement.slice(0,exclusive.index))) continue;
      const after = statement.slice(exclusive.index + exclusive[0].length).split(/[，,;；]/u)[0];
      const before = statement.slice(0,exclusive.index).split(/[，,;；]/u).at(-1);
      if (![receipt.inputs.component.value,'头部IP','头部产品','其余产品','其他IP'].some(label=>after.startsWith(label) || before.endsWith(label+'是'))) continue;
      if (Number(firstDelta.value) > 0 && Number(otherDelta.value) > 0) findings.push({
        rule:'scenario_conclusion', severity:'error', excerpt, message:'其余部分也贡献了增长，不能把全部增量归给单一部分',
        expected:`头部贡献 ${firstDelta.value}，其余贡献 ${otherDelta.value}。按各自增量解释。`,
      });
    } else if (/(?:分红)?覆盖(?:倍数|率)[^。；;]{0,18}(?:分红|股息|红利)(?:额|总额)?(?:÷|\/|除以)(?:当期)?(?:自由|经营)现金流/iu.test(statement) &&
        !/不能|不可|不是|并非|误用|误写|错误/u.test(statement)) {
      findings.push({rule:'scenario_conclusion',severity:'error',excerpt,message:'分红覆盖倍数的分子、分母写反了',expected:'自由现金流÷分红。分红÷自由现金流表示支付比例。'});
    } else if (receipt.template === 'free-cash-flow-dividend-coverage') {
      if (statement.includes('|')) {
        const cells = statement.replace(/^\||\|$/gu,'').split('|');
        const coverageColumn = cells.findIndex(cell=>/^(?:分红)?覆盖倍数(?:[（(]倍[）)])?$/u.test(cell));
        if (coverageColumn >= 0) table = { company:cells.findIndex(cell=>/^(?:公司|企业|主体|对象)$/u.test(cell)), coverage:coverageColumn };
        else if (table?.company >= 0) {
          const company = cells[table.company]?.match(/^([A-Za-z甲乙丙丁])(?:公司)?$/u)?.[1];
          const value = cells[table.coverage]?.match(/^([+-]?\d+(?:\.\d+)?)(?:倍|[x×])?$/u)?.[1];
          if (company && value) checkCoverageValue(findings,receipt,company,value,excerpt);
        }
      } else table = null;
      const stated = /(?:^|[，,；;])([A-Za-z甲乙丙丁])(?:公司)?(?:的)?(?:自由现金流)?(?:分红)?覆盖(?:倍数|率)(?:为|是|约为|=)?([+-]?\d+(?:\.\d+)?)倍/gu;
      for (const [,company,value] of statement.matchAll(stated)) {
        checkCoverageValue(findings,receipt,company,value,excerpt);
      }
    }
  }
  return findings;
}
