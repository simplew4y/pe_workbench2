import { researchContract } from './research-contract.mjs';

/** Narrow semantic guards for closed, user-supplied accounting scenarios.
 * No company identities, benchmark IDs or expected answer values live here.
 * External financial disclosures remain the responsibility of source review.
 */
export function accountingReasoningIssues(draft,{question='',sourceQuestions=[]}={}) {
  const premises=[...sourceQuestions,question].join('\n');
  if(!researchContract(question,premises).hypothetical)return [];
  const issues=[];
  const costGiven=/(?:营业成本|销售成本|销货成本|毛利率|毛利)[：:为是约\s]*[\d.]+/.test(premises);
  const cashTaxGiven=/(?:实际|现金).{0,8}(?:缴税|缴纳税|支付所得税)|当期.{0,10}(?:少缴|减缴|退税|现金节税)/.test(premises);
  const monetaryUnit=/(?:人民币|美元|港元|欧元|[兆亿万千百]?元)/.test(premises);
  for(const block of String(draft).split(/\n\s*\n/)) {
    const conditionalTax=/(?:若|如|只有|假设|前提|取决于|并不|不等于|不代表|不能|未必|尚不能|不一定|未知|未给).{0,60}(?:现金|缴税|缴纳|支付|抵扣|退税)|(?:现金|缴税|缴纳).{0,30}(?:未知|未给|不确定|不能确定)/.test(block);
    for(const excerpt of block.split(/[。！!？?\n]/).filter(s=>s.trim())) {
      const s=excerpt.replace(/[*`_]/g,'');
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
      if(!monetaryUnit && /\d(?:[\d,.]*)(?:\s*[兆亿万千百])?\s*(?:元|美元|港元|人民币)/.test(s))
        issues.push({check:'numeric_units',excerpt,reason:'题设没有给金额币种或单位，保持题设数值及无单位口径，不自行补元、亿元或币种。'});
      if(/现金流/.test(s) && /不是.{0,60}而是|全部(?:由于|来自|归因)|完全(?:由于|来自|归因)/.test(s) && /应收|存货|营运资金/.test(s) && !/应付|折旧|其他调整|不能|无法|不足/.test(s))
        issues.push({check:'conclusion_strength',excerpt,reason:'应收和存货变化只能提示现金占用，缺应付、折旧和其他调整时不能把经营现金流变化完全归因于营运资金。资本开支属于投资现金流，不能据其不变完成经营现金流归因。'});
    }
  }
  return issues;
}
