import { researchContract } from './research-contract.mjs';

/** Narrow semantic guards for closed, user-supplied accounting scenarios.
 * No company identities, benchmark IDs or expected answer values live here.
 * External financial disclosures remain the responsibility of source review.
 */
export function accountingReasoningIssues(draft,{question='',sourceQuestions=[]}={}) {
  const premises=[...sourceQuestions,question].join('\n');
  const contract=researchContract(question,premises);
  const issues=[];
  for (const excerpt of String(draft).replace(/[*\x60_]/g,'').split(/[。！？\n]/).filter(Boolean)) {
    const projected=/预测|预计|预期|可能|估计|情景|假设|若|如果|能否|展望|[0-9]E\b/i;
    if (contract.informationCutoff) {
      for (const clause of excerpt.split(/[，,；;]/)) {
        const period=clause.match(/(20\d{2})(?:年(?:(\d{1,2})月(?:(\d{1,2})日)?|第?([一二三四1-4])季度)?|Q([1-4])\b)/i);
        if (!period) continue;
        const quarter=period[5] || period[4];
        const q=Number(quarter) || '一二三四'.indexOf(quarter)+1;
        const month=period[2] || (q ? (q-1)*3+1 : 1);
        const start=period[1]+'-'+String(month).padStart(2,'0')+'-'+String(period[3] || 1).padStart(2,'0');
        if (start>contract.informationCutoff && !projected.test(excerpt.slice(0,excerpt.indexOf(clause))+clause) &&
            /转跌|回升|下跌|增长了|已(?:经)?(?:实现|达到|披露|完成)/.test(clause))
          issues.push({check:'comparison_basis',excerpt,reason:'所述结果晚于用户的信息截止日。请标为当时的预测并注明依据，或撤回这一事后判断。',
            correction:/(?:价格|报价|合约价)/.test(excerpt)
              ? '截至'+contract.informationCutoff+'，后续价格变动仍是待验证的情景。用同规格、同交易口径的成交价与基期比较，再判断涨跌。'
              : '这一结果在'+contract.informationCutoff+'之后才能观察。评估当时的投资判断，只能使用截至该日已披露的数据或当时明确标注的预测。'});
      }
    }
    if (/改(?:为)?计入(?:营业|销售|主营业务)成本/.test(excerpt) &&
        /(?:会|将|从而|因此)(?:推高|提高|抬高)毛利率/.test(excerpt) && !/不会|不能|未必|不一定|同时.*(?:降低|下降)/.test(excerpt))
      issues.push({check:'metric_meaning',excerpt,correction:'若将原列销售费用的质保等支出转入营业成本，收入不变时毛利率会下降；营业利润可以不变。对比两年毛利率须先按同一列报口径重述。',reason:'收入和其余成本不变时，将费用转入销售成本会降低毛利率。同比还需核实比较期是否已重述。'});
    if (/(?:增长|增速).{0,12}等于(?:资本成本|折现率|WACC)/i.test(excerpt) &&
        /意味着|因此|必然/.test(excerpt) && /新增投资.{0,18}(?:赚回|等于)|ROIC.{0,7}(?:等于|=)/i.test(excerpt) &&
        !/不意味着|不能推|不代表|未必/.test(excerpt))
      issues.push({check:'conclusion_strength',excerpt,correction:'永续增长率等于折现率时，正现金流的折现级数不收敛。新增投资赚多少还取决于再投资率；仅凭这个等式无法判断新增投资回报率。',reason:'永续增速与折现率相等只决定现金流级数的收敛性。推断新增投资回报率还需要再投资率等条件。'});
  }
  if (!contract.hypothetical) return issues;
  // Under a non-convergent perpetuity, leverage alone cannot turn the
  // continuation value into the finite no-growth capitalisation formula.
  for (const paragraph of String(draft).split(/\n\s*\n/)) {
    if (!/(?:永续)?增长(?:率|增速)?.{0,8}等于(?:资本成本|折现率|WACC)|永续增长率达到或超过折现率/i.test(paragraph)) continue;
    for (const excerpt of paragraph.split(/[。！？\n]/)) {
      if (/无杠杆.{0,18}(?:本应|应当|应|会)趋于.{0,55}有限/.test(excerpt) && !/零增长|增长为零|如果|假定不再增长|不能趋于/.test(excerpt))
        issues.push({check:'conclusion_strength',excerpt,correction:'取消杠杆不会使该永续模型恢复有限值。现金流除以折现率的公式还要求以后现金流不增长。',reason:'正现金流永续增长率达到折现率时，取消杠杆不能恢复有限现值；按现金流除以资本成本需要另设零增长条件。'});
    }
  }
  const costGiven=/(?:营业成本|销售成本|销货成本|毛利率|毛利)[：:为是约\s]*[\d.]+/.test(premises);
  const cashTaxGiven=/(?:实际|现金).{0,8}(?:缴税|缴纳税|支付所得税)|当期.{0,10}(?:少缴|减缴|退税|现金节税)/.test(premises);
  const monetaryUnit=/(?:人民币|美元|港元|欧元|[兆亿万千百]?元)/.test(premises);
  let taxBridge='其他项目不变，减值本身不付现。若本期未实际少缴税，经营现金流不变；若已少缴，仅增加实际节税额。';
  const amount=question.match(/计提\s*(\d+(?:\.\d+)?)\s*(?:的)?减值(?=[，。；,\s])/);
  const tax=question.match(/(?:所得)?税率(?:为)?\s*(\d+(?:\.\d+)?)\s*[%％]/);
  // Bind the baseline only when this closed scenario names one unambiguous
  // pair of cash flows. A changed baseline or a real issuer needs new evidence.
  const anchors=sourceQuestions.flatMap(q=>[...q.matchAll(/经营现金流\s*([+-]?\d+(?:\.\d+)?)\s*(?:→|至)\s*([+-]?\d+(?:\.\d+)?)(?=[，。；,;\s])/g)]);
  const numbers=Array.from(new Set(anchors.map(m=>Number(m[2]))));
  if(amount && tax && numbers.length===1 && /当期可扣除/.test(question) && Number(tax[1])<=100 &&
     !/递延税率|多个税率|部分可扣除/.test(question) && sourceQuestions.some(q=>/虚构|假设公司/.test(q)) &&
     !sourceQuestions.some(q=>/经营现金流.{0,8}(?:改为|调整为|更正为)/.test(q))) {
    const base=numbers[0], saving=Number((Number(amount[1])*Number(tax[1])/100).toPrecision(12));
    taxBridge='其他项目不变，减值不付现。本期未少缴现金税时，经营现金流仍为'+base+'；若本期足额少缴，经营现金流为'+base+'＋'+amount[1]+'×'+tax[1]+'%＝'+Number((base+saving).toPrecision(12))+'。部分兑现则按实际少缴额计。';
  }
  for(const block of String(draft).split(/\n\s*\n/)) {
    const conditionalTax=/(?:若|如|只有|假设|前提|取决于|并不|不等于|不代表|不能|未必|尚不能|不一定|未知|未给).{0,60}(?:现金|缴税|缴纳|支付|抵扣|退税)|(?:现金|缴税|缴纳).{0,30}(?:未知|未给|不确定|不能确定)/.test(block);
    for(const excerpt of block.split(/[。！!？?\n]/).filter(s=>s.trim())) {
      const s=excerpt.replace(/[*`_]/g,'');
      if (/减值/.test(premises) && !cashTaxGiven && /(?:当期|本期)现金税(?:款)?(?:已)?少缴\s*\d/.test(s) && !/若|如果|假设|取决于|是否|未必|才能|才会/.test(s))
        issues.push({check:'conclusion_strength',excerpt,correction:taxBridge,reason:'当期扣除资格不能证明现金税已经少缴，现金流测算须明确实际支付条件。'});
      if(/当期可扣除/.test(question) && /(?:扣除|抵扣).{0,18}以后年度.{0,12}兑现.{0,14}(?:会|将)形成递延所得税资产/.test(s))
        issues.push({check:'metric_meaning',excerpt,reason:'支付税款的时间差本身不能判断递延所得税。',correction:'税务允许当期扣除与何时实际付税要分开确认。'});
      const negative=/(?:不能|无法|不应|不宜|不等于|不代表|不是|不可|未给|缺少).{0,30}(?:周转|天数)/.test(s);
      const fraudConstraint=/(?:若|假设|只有|仅在).{0,35}(?:全部|所有).{0,20}(?:虚增|虚假|虚构).{0,20}收入.{0,35}(?:仍|均|全部|仅).{0,10}(?:挂|计入|留在).{0,10}应收/.test(premises+'\n'+block);
      if(!fraudConstraint && /虚假收入|虚构收入|假收入|收入.{0,6}(?:假|虚构|造假)/.test(block) &&
         /应收.{0,18}(?:至少|上限|只有|不超过).{0,12}\d/.test(s) &&
         /冲突|不可能|至少|上限/.test(s) && !/不能|无法|不足以|不代表/.test(s))
        issues.push({check:'metric_meaning',excerpt,reason:'收入真实性与是否收款是不同维度。虚构交易也可能有回款，期末应收不能给虚构收入设上限或据此反证舞弊比例。只能说这些汇总数不足以识别真实交易；需要合同、履约、客户及资金闭环证据。'});
      const arFraction=/(?:应收|应收账款).{0,40}(?:÷|\/|除以|占).{0,25}(?:收入|营收).{0,45}(?:未收回|未回款|没收回)/.test(s);
      const cashProvesReal=/(?:回款|收回).{0,18}(?:则|就|说明|证明).{0,10}(?:只是|仅是|不是造假|并非舞弊|排除)/.test(s);
      if((arFraction || cashProvesReal) && !/(?:不能|无法|不代表|不等于|不足以|不可|不是).{0,35}(?:将|把|用|解释|证明|说明|表示|视为|得出|推断|说|认定|排除|未收回|未回款)/.test(s))
        issues.push({check:'metric_meaning',excerpt,reason:arFraction
          ? '期末应收余额除以全年收入是余额与流量的比值，不是当年收入未收回的比例。期末余额可能含以前年度应收，全年销售还包含已收现部分；必须按销售发生期间及实际收款匹配，不能据此限制虚假收入比例。'
          : '期后收款不能单独证明收入真实，也不能证明只是账期放宽。虚构交易可能伴随循环资金或关联方回款，应结合真实客户、履约和资金闭环证据判断。'});
      if(/利润增量|净利润增量/.test(s) && /营运资金/.test(s) && /现金流.{0,12}(?:应降|应增|应变)|其他项目.{0,15}(?:贡献|抵消|解释)/.test(s) &&
         !/(?:不能|无法|不足以).{0,20}(?:把|用|根据|按|推算|反推|推出|桥接)/.test(s) && !/两期营运资金现金影响|首年期初|上年期初/.test(premises))
        issues.push({check:'comparison_basis',excerpt,reason:'两期现金流差额的桥接需要两期营运资金现金影响。当前期应收与存货余额之差只对应一个期间，不能直接与净利润同比增量相减，反推出其他项目净贡献。缺首期初余额或现金流调整表时，只做有限的资金占用提示。'});

      if(/(?:资本开支|capex).{0,35}(?:所能对应|上限|限制).{0,15}(?:折旧|摊销)|(?:折旧|摊销).{0,15}(?:不能|不会)(?:大于|超过).{0,15}(?:资本开支|capex)/i.test(s) && !/(?:不能|无法).{0,10}(?:用|以|把)/.test(s) && !/(?:期初|年初).{0,8}固定资产.{0,8}(?:0|零)/.test(premises))
        issues.push({check:'comparison_basis',excerpt,reason:'当期资本开支不能给当期折旧摊销设上限；折旧还来自历史存量资产。缺存量资产和折旧政策时，不用资本开支大小限定其他现金流调整。'});
      if(!costGiven && !negative && /存货.{0,12}(?:周转|天数)|(?:周转|天数).{0,8}存货/.test(s) && /\d/.test(s) && !/收入折算|非标准|收入占用/.test(s))
        issues.push({check:'metric_meaning',excerpt,reason:'题设未提供营业成本或可推导成本的毛利数据，不能报告标准存货周转天数。收入不能替代成本；保留存货余额变化，说明标准周转需要成本及平均存货。'});
      if(/(?:存货)?减值/.test(premises) && !cashTaxGiven && !conditionalTax && /(?:经营现金流|经营活动现金流|CFO).{0,35}(?:增加|增至|升至|提高|变为|变成|→|从\s*\d.+到)\s*\d/i.test(s))
        issues.push({check:'conclusion_strength',excerpt,reason:'当期税务可扣除只给出税务处理，不证明现金税本期已少缴。经营现金流变化须明确“若本期实际少缴现金税”的条件；否则金额无法唯一确定。减值本身是非现金项目。'});
      if(/减值/.test(premises) && /(?:存货|库存|采购).{0,25}(?:过去|此前|先前|早已|已经|已).{0,10}(?:付过|付清|付款|付现|支付|流出)|(?:钱|现金).{0,15}(?:早已|之前已|此前已).{0,10}(?:付|流出)/.test(s) && !/(?:若|假设|是否|未必|不代表|不能|不一定)/.test(s))
        issues.push({check:'conclusion_strength',excerpt,reason:'存货减值不证明采购款已经支付，采购可能仍挂应付。只解释减值确认是非现金调整，不推断未提供的付款时间。'});
      const historicalDisclosure=/年报|季报|公告|披露|历史/.test(s) && /20\d{2}/.test(s) &&
        /https?:\/\/|\bp\.?\s*\d+|第\s*\d+(?:\s*[-–—至]\s*\d+)?\s*页|![A-Z]+\d+/.test(s) && !/假设|题设|情景/.test(s);
      if(!monetaryUnit && !historicalDisclosure && /\d(?:[\d,.]*)(?:\s*[兆亿万千百])?\s*(?:元|美元|港元|人民币)/.test(s))
        issues.push({check:'numeric_units',excerpt,reason:'题设没有给金额币种或单位，保持题设数值及无单位口径，不自行补元、亿元或币种。'});
      if(/现金流/.test(s) && /不是.{0,60}而是|全部(?:由于|来自|归因)|完全(?:由于|来自|归因)/.test(s) && /应收|存货|营运资金/.test(s) && !/应付|折旧|其他调整|不能|无法|不足/.test(s))
        issues.push({check:'conclusion_strength',excerpt,reason:'应收和存货变化只能提示现金占用，缺应付、折旧和其他调整时不能把经营现金流变化完全归因于营运资金。资本开支属于投资现金流，不能据其不变完成经营现金流归因。'});
    }
  }
  return issues;
}
