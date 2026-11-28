export function informationCutoff(question='') {
  const q=String(question);
  if(!/截至.{0,35}(?:公开|已知|可核|可查|信息|资料)/.test(q))return null;
  const m=q.match(/截至\s*(20\d{2})(?:[-年\/](\d{1,2})(?:[-月\/](\d{1,2})日?)?)?/);
  if(!m)return null;
  const year=Number(m[1]),month=Number(m[2] || 12),day=Number(m[3] || new Date(Date.UTC(year,month,0)).getUTCDate());
  const date=new Date(Date.UTC(year,month-1,day));
  return date.getUTCFullYear()===year && date.getUTCMonth()===month-1 && date.getUTCDate()===day ? date.toISOString().slice(0,10):null;
}

export function hasScenarioPremise(text='') {
  // A prohibition such as 'do not invent company figures' is not a premise.
  const clean=String(text).replace(/(?:不要|不得|不能|禁止|避免|并非|不是|没有|不|勿|别|未)\s*(?:自行|凭空|随意)?(?:虚构|编造|假设|假定)/g,'禁止捏造');
  return /虚构|假设公司|假设企业|给定条件|仅用给定|(?:仅用|只用|仅依据)题设|题设参数/.test(clean);
}

/** Current-question scope. History supplies premises, never extra deliverables. */
export function researchContract(question = '', history = '') {
  const q=String(question);
  const hypothetical=hasScenarioPremise(q) ||
    (/只把|其他不变|恢复|重算|减值|税率|原净利|应收增|审查推理|题设|FCFF|WACC|每股价值/i.test(q) && hasScenarioPremise(history));
  const completeAnalysis=/复现.{0,12}(?:目标价|估值)|(?:形成|完成|开展|进行|输出).{0,15}(?:投资框架|投资分析|估值分析)|公式级敏感性/.test(q);
  const method=!completeAnalysis && /如何检验|所需数据|混杂因素|必要证据|可跟踪|可证伪命题|尽调清单|分别受什么影响|审查推理/.test(q);
  const originalSources=!hypothetical && !method && /年报|原始披露|官方公告|官方出处|公开核验|关键事实.{0,8}出处/.test(q);
  const noNetwork=/不联网|不要联网|仅用题设|仅依据题设/.test(q) || (hypothetical && /不联网|仅用题设/.test(history));
  const marketRequested=/现价|当前股价|最新股价|上行空间|股价偏离|(?:最新|实时|当前|今天|今日)(?:的)?(?:行情|报价|价格)|截至今天.{0,8}行情/.test(q) && !/不(?:用|使用|要).{0,4}(?:现价|当前股价|最新股价|最新行情|实时行情)/.test(q);
  const artifactRequested=q.split(/[。；;，,\n]/).some(clause=>!/(?:不要|无需|不用|禁止|不必|不需要)(?:再|额外)?(?:保存|导出|写入|写到|创建|生成|输出|落盘)/.test(clause) && /保存|导出|写入|写到|写至|落成|落盘|修改|编辑|更新|创建|新增|删除|输出.{0,12}(?:报告|研报|文件)|(?:报告|研报|文件).{0,12}(?:放到|放在|存到|存为|另存)|(?:生成|撰写|写|出具).{0,12}(?:报告|研报|文件)|重写.{0,8}(?:报告|文件)/.test(clause));
  return {hypothetical,method,originalSources,noNetwork,marketRequested,artifactRequested,informationCutoff:informationCutoff(q)};
}
export function researchContractGuidance(question,history='') {
  const c=researchContract(question,history);
  return [
    '先把本轮问题拆成必须交付的问项，逐项确定需要题设、原始披露还是解释方法。旧轮话题提供背景，不自动增加本轮要求。有限计算或口径解释先答齐原题，不扩展未要求的指标、预测或数值阈值。只搜索和计算能改变本轮答案的资料。',
    c.hypothetical?'按用户给定条件推演，未给单位时保持无单位或题设单位，不能自行补亿元。给定假设不需重新向现实核实；不能凭未给的项目补全现金流或因果归因。存货周转须营业成本与平均存货，缺成本就不算标准周转天数。税务当期可扣除不等于当期已少缴现金税；条件未给时只算利润影响，现金流给条件分支。减值是非现金调整，不说明采购是否已付款。':'',
    c.method?'本轮重在检验方法、证据需求或口径解释。列出将来需要的证据就是交付内容，不必为凑数字另查公司现值；不能把未来调查项写成自己本轮未完成的工作。':'',
    c.informationCutoff?`本轮限定截至${c.informationCutoff}当时可公开获得的信息。区分财务所属期间与首次披露日期：之后才公布的回溯数据不能用于当时判断，也不能因未取得未来披露而说本轮未完成。`:'',
    c.originalSources?'本轮需要原始披露。搜索只用于定位链接，必须打开原文；官方PDF可直接用web_fetch读取并用query定位相关页。一个入口失败时换可访问的同一披露，不要反复搜索摘要后声称读过年报。逐项用读到的内容回答，已取得的数据不能再写成没有披露。':'',
    !c.marketRequested?'本轮未要求实时行情，不额外查现价、汇率或计算静态估值倍数。':'',
    c.noNetwork?'本轮禁止联网，使用题设和已给材料。':'',
    !c.artifactRequested?'本轮交付是对话答文，不创建或保存报告文件。建立投资框架指回答分析问题，不能扩展为额外文件保存任务。':'',
    '先回答每个问项，再补必要理由。未能取得本轮明确要求的事实才标未核验；将来研究还需的资料应说明其用途，不能替代已有证据的判断。'
  ].filter(Boolean).join('\n');
}
