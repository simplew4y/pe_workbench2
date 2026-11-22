import { researchContract, hasScenarioPremise } from './research-contract.mjs';
import { questionWithoutAttachments } from './answer-length.mjs';
/** Lightweight task framing; data lookups keep the existing short path. */
// Share one task decision between planning, semantic audit and delivery.
// Match reusable reasoning operations, not company names or benchmark wording.
const reasoningIntent = /解读|检查|估值|研报|研究报告|为什么|为何|如何|是否|能否|能推出|成立吗|合理吗|解释|分析|判断|评估|评价|检验|验证|复核|审查|推理|论证|反驳|比较|对比|敏感性|情景|证伪|命题|框架|尽调|投资逻辑|投资价值|竞争优势|商业模式|核心假设|关键假设|证据冲突|条件式|投委会|审计委员会|计算|重算|算出|测算|(?:^|[，。：；])算|\b(?:DCF|FCFF|WACC)\b/i;
const followupIntent = /上一轮|前[几一二三四五六七八九十\d]+轮|前文|上述|这些|其中|继续|综合|整合|压缩|重写|总结|恢复|只(?:把|改)|其他不变|哪些|怎么|需要哪些|最想问|给出.*条件/;
const administrative = /^(?:你好|您好|谢谢|多谢|收到|好的|列出文件|列出项目|新建项目|停止|取消)[！!。\s]*$/;
export function isResearchQuestion(question = '', history = '') {
  // Persisted user messages include transport metadata. Filenames must not
  // change the task between planning, auditing, delivery and recorded replay.
  question = questionWithoutAttachments(String(question));
  history = String(history).replace(/\[已上传资料\]\r?\n(?:- [^\n]*(?:\n|$))*/g, '');
  if (administrative.test(String(question).trim())) return false;
  if (/(?:理解|看懂|读懂|梳理|讲解|总结).*(?:模型|业务|报告|报表|公司)|(?:关键|核心|主要).*(?:驱动|影响因素)|驱动(?:因素|是什么|来自)/.test(question)) return true;
  if (reasoningIntent.test(question) || researchContract(question, history).method || /能(?:直接)?代表|意味着|会怎样|有何影响/.test(question)) return true;
  return followupIntent.test(question) && reasoningIntent.test(String(history));
}
export function isScenarioOnlyQuestion(question = '', history = '') {
  const input=String(question)+'\n'+String(history);
  return hasScenarioPremise(input) && !/附件|工作簿|单元格|\.xls[xm]/i.test(input);
}
export function researchTaskInstructions(question, history = '') {
  if (!isResearchQuestion(question, history)) return '';
  return `本轮是研究判断任务。工具调用前先在内部明确：用户要决定什么、两种可能解释、最关键的经营/估值驱动、区分解释所需的证据、什么结果会改变判断。按这些问题选工具，不把定位单元格视为任务完成。
回答应包含与问题有关的判断、业务机制到盈利/现金流/估值的传导、支持与反对证据、适用条件和最有价值的下一条验证信号。已有证据不足时给条件判断，不编造反证或强迫下结论。简单数字和公式细节服务于判断，不堆砌坐标；不强制固定标题或篇幅。
判断经营假设是否合理时必须查询实际经营披露及反证（用户禁止联网除外）；表内没有来源不等于假设错误，行情查询不能替代经营证据。对税费符号的判断必须追踪税前利润、税额及税后净额的完整公式；负税额加到利润上通常是在扣税，不可仅凭负号判错。金额计算必须先使用unit_convert或calc的fromUnit/toUnit转换，不能在算式中凭记忆写换算后数值；保留换算链。区分股权比例与少数股东占税前/税后利润比例。
情景分析先复现同口径基准，再改变真正独立输入；calc成功只证明算式执行，不证明经济含义正确。用户给定的新增利润必须保留原范围和税前/税后口径；原题未说税前时不得自行补成税前扣税。子公司增量归母比例与集团整体归母比例不可互相反驳。差额必须比较同口径的两个结果，贡献拆解应闭合，避免重复扣减。先分别记录原缓存、基准重算与情景结果；基准出现公式错误时不能将情景与损坏基准比较，不能自动改动原模型口径。无法全模型重算时可做明确范围的局部情景，说明固定条件和未覆盖路径。
用户明确给定价格或情景参数时标明题设，优先遵守其数据时点和联网约束，不擅自替换成实时数据。`;
}

// Execution requirements are checked against actual calls, not prose promises.
export function researchExecutionGaps(question, calls = []) {
  if ((!isResearchQuestion(question) && !researchContract(question).originalSources) || /不(?:要)?(?:联网|搜索)|仅(?:用|依据)附件|只(?:用|依据)附件/.test(question)) return [];
  if (!researchContract(question).originalSources && !/可查证据|公开(?:证据|资料)|待证假设|独立复核.*业务假设/.test(question)) return [];
  const external = calls.filter(c => ['deepseek_search','deepseek_fetch','anysearch_search','web_fetch','pdf_read'].includes(c.name));
  if (external.some(c => ['deepseek_fetch','web_fetch','pdf_read'].includes(c.name) && c.success === true && !c.result?.isError)) return [];
  return [{rule:'research_execution_gap',severity:'warning',message:external.length ? '尚未成功读取外部证据原文，搜索摘要不能据此确认业务假设' : '尚未执行外部经营证据核验',expected:'针对决定结论的业务假设查询公司公告或原始披露，读取原文并核对支持与反对证据；行情查询不替代经营证据。用户限制与服务不可用时明确缺口。'}];
}
