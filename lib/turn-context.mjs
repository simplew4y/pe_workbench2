import { researchContractGuidance } from './research-contract.mjs';
import { researchTaskInstructions } from './research-task.mjs';
import { toolEvidenceState } from './citations.mjs';
import { researchChoices } from './research-clarification.mjs';
import { DOCUMENT_OUTPUT_POLICY } from './document-output-policy.mjs';
import { projectContext } from './fact-memory/context.mjs';
/** Follow-up rules derived from skills/investment-framework/SKILL.md. No model calls. */
import { readLedger, correctedValues } from './ledger.mjs';
import { retrieveAndExpand } from './topic-index.mjs';
export { readLedger, summarizeLedger } from './ledger.mjs';

export const PLAIN_ANSWER_GUIDANCE = [
  '按问项决定怎么开头。查数给数字，解释给计算链，归因给拆分，纠偏先交代前文范围。用具体的话解释依据。缩短时把这两句一起留下，先删重复的背景、公式和核验过程。用普通读者能理解的业务动作解释术语。',
  '能用中文说清就用中文。必须保留的术语或缩写，第一次出现时顺手说明实际含义。把文件页码、原表单元格或原始链接放在它支持的事实旁。事实能支持多远就写到哪里；资料缺口只在影响判断的那一处说明。用户要求汇总缺口时再集中列示。',
  '释义保留指标的对象、分母和期间。例如净收入留存率比较同一批老客户前后的收入，包含加购、降配和流失。合同额、确认收入和到账现金分别写。增速下降仍可能是增长，部分业务的增速需要知道其比重才能解释总增速。',
  '给理由时把关键的一步写出来：看到什么变化，它怎样影响判断，现有数据还能由什么解释。比较占比要用同一年的分子和分母。由题面推出的量写明条件和算式，与工作簿披露值分句写，各自说明来源。',
  '明确给在题面里的条件按题设使用。题目只要求推演时，不必把题设重新写成工作簿取数报告。用户指定的格式和内容要求优先。',
].join('\n');

export function argumentRequirements(question, priorAnswers = []) {
  const requirements = [];
  if (/证伪|推翻|失效条件|falsif/i.test(question)) requirements.push(
    '每条命题先写一项可直接观察、有期间和方向的预测，再写同一指标出现什么相反结果会推翻它。能被多种原因解释的指标，只能检验指标本身的预测；经营原因另写为待查。说明每个代理指标还受什么影响。只问跟踪方法时，省去无关的历史金额。');
  if (priorAnswers.length) requirements.push(
    '逐条对照指定轮次正式答复中的原判断，说明保留、修订或撤回哪一部分。每条接一句，指出后来的哪项证据改变了它，或为什么仍无法判定。没有新证据的原判断也要交代。若原答未提出某项判断，不能为了凑齐分类而补造。');
  return requirements.join('\n');
}

const TURN_CONTEXT_MAX_CHARS = 16_000;
const clip = (value, limit) => [...String(value ?? '').replace(/[<>\r\n]/g, ' ')].slice(0, limit).join('');
const workbookSubject = /[A-Z]{1,3}\d+|capex|wacc|eps|ebitda|估值|目标价|净利|收入|毛利|折现|现金流|公式|变量|模型/i;
const presentationSubject = /(?:格式|排版|文字|标题|措辞|文风|字体|换行)/;
const protocols = {
  selfaudit: [/自查|检查前面|之前说|前文|(?:复核|核对|检查|复查)[^。！？\n]{0,12}上一轮(?:回答|结论|数字)|全部正确|十倍(?:错|错误)|没有十倍/, '自查先 transcript_search（同时返回 ledgerMatches）；列出候选人（可空：未发现候选人）；金额逐条 unit_convert/calc 并列表；不得未检索就说「全部正确/没有十倍错误」，允许「核对 N 条后均与单元格一致」。'],
  assumption: [/假设|公式|口径|单位|期间|毛利率|收入占比|interpret|assumption|model interpretation/i, '公式溯源；单位与期间对齐；按区块区分同名指标（毛利率/收入占比）。'],
  sensitivity: [/敏感性|如果|提高|降低|扰动|差额|sensitivity|what[ -]?if/i, '敏感性必须 model_whatif 或明确标「局部」；派生数用 calc；区分百分比与百分点。'],
  evidence: [/证据|预测|验证|转述|多期|evidence|forecast/i, '预测≠已验证；转述≠独立来源；单期不能证明多期。'],
  ticker: [/代码|cover|ticker|元数据/i, '必须查 Cover/元数据；未命中≠不存在，写 coverage。'],
  target: [/目标价|估值怎么算|target\s*price/i, '复现原模型估值：从已核实的状态、工作簿输出或 workbook_trace 的公式路径给出模型目标价与计算依据。G* 是缺口编号，不是单元格。券商目标价只作对照。'],
  market: [/现价|当前股价|最新股价|偏离|上行空间|upside|deviation/i, '用户问现价或偏离时，用 westock_query 核对证券并获取行情。询问偏离时首句给出模型价、现价和空间；缺现价时保留已核实的模型目标价，注明现价未获取、空间无法计算。'],
  threshold: [/阈值|失效|threshold|falsifier|calibrat/i, '阈值无依据则「待定」+ calibration（校准计划）；不得把增速当阈值。'],
  correction: [/更正|纠正|自查|correction|corrected/i, '更正后自查：遵循台账更正，不得复述已被替代的数值。'],
  dependency: [/不影响|不进入|无关|不可达|没有路径|依赖|链路|传导|dependency|reachab|affect|path/i, '声称 X 不影响 Y 前必须 workbook_trace mode=path，说明解析覆盖范围。'],
};
export function classifyQuestion(question) {
  const text = String(question);
  const routes = Object.entries(protocols).filter(([name, [pattern]]) =>
    name === 'dependency'
      ? text.split(/[。；！？\n]/).some(part => pattern.test(part) && workbookSubject.test(part) && !presentationSubject.test(part))
      : pattern.test(text),
  ).map(([name]) => name);
  return routes.length ? routes : ['general'];
}
export async function buildTurnContext({ question = '', root, sessionId, now = new Date(), ledger, history = '', locator, factMemory, intent } = {}) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Hong_Kong', year:'numeric',month:'2-digit',day:'2-digit',weekday:'short'}).formatToParts(now).map(p => [p.type,p.value]));
  const quarter = Math.ceil(Number(parts.month) / 3);
  const weekday = {Sun:'日',Mon:'一',Tue:'二',Wed:'三',Thu:'四',Fri:'五',Sat:'六'}[parts.weekday];
  const routes = intent ? (intent.routes.length ? intent.routes : ['general']) : classifyQuestion(question);
  const date = `${parts.year}-${parts.month}-${parts.day} 星期${weekday}（Asia/Hong_Kong）；${parts.year}Q${quarter}仍在进行中；${quarter === 1 ? Number(parts.year)-1 : parts.year}Q${quarter === 1 ? 4 : quarter-1}已结束。日历季度结束不代表财报已公布。`;
  const taskRules={dependency:'经济逻辑判断与工作簿公式依赖分开。只有断言具体工作簿路径不影响结果时才要求workbook_trace mode=path；纯题设推导不需要虚构工作簿。',sensitivity:'题设情景用calc核验公式与单位；已有工作簿需要重算时用model_whatif，或明确局部情景的固定条件。',threshold:'用户要求自定研究阈值时可提出并明确标为研究假设，说明选择理由；不得冒充公司指引或已验证阈值。'};
  const rules = routes.map(r => taskRules[r] || protocols[r]?.[1] || '追溯来源，核对单位、期间与覆盖范围；事实、推断、预测分开；证据不足写待核。').join('\n');
  const resolvedQuestion = intent?.request || question;
  const projectFacts=projectContext(factMemory,resolvedQuestion);
  const fullLedger = ledger === undefined ? await readLedger(root, sessionId) : ledger;
  let retrieval=factMemory?{facts:[],topics:[],clarification:{needed:false},status:projectFacts?.status}:await retrieveAndExpand({root,sessionId,ledger:fullLedger,question:resolvedQuestion,history,locator});
  // Compatibility for pre-index sessions: only one best matching ledger fact,
  // never a keyword-ranked dump of the register.
  if(!factMemory && !retrieval.facts.length && !(fullLedger?.topics||[]).some(t=>t.status!=='archived')) {
    const terms=String(resolvedQuestion).toLowerCase().match(/[\p{L}\p{N}]{2,}/gu)||[];
    const candidates=(fullLedger?.facts||[]).filter(f=>f&&(f.status==null||['current','conflict','stale_source'].includes(f.status)));
    const ranked=candidates.map(f=>({f,score:terms.reduce((n,t)=>n+([f.claim,f.binding?.company,f.binding?.metric,f.binding?.line].some(v=>String(v||'').toLowerCase().includes(t))?1:0),0)})).sort((a,b)=>b.score-a.score);
    if(ranked[0]?.score>0) retrieval.facts=[ranked[0].f];
    else if(candidates.length) retrieval.facts=[candidates[0]];
  }
  const evidence=retrieval.facts.map(f=>{
    const b=f.binding||{}, status=f.status==='conflict'?'【冲突】':f.status==='stale_source'?'【来源已过期，须再查】':'';
    return `${status}${f.id||''} ${[b.company,b.metric,b.period||f.period].filter(Boolean).join(' / ')}：${f.value}${f.unit?` ${f.unit}`:''}`;
  });
  const correctionLines=(factMemory?[]:correctedValues(fullLedger)).filter(c=>!correctedValues(fullLedger).some(next=>String(next.from)===String(c.to))).slice(-4).map(c=>`更正现值：${c.claim||''} ${c.to}${c.unit?` ${c.unit}`:''}`);
  const topicLines=retrieval.topics.map(t=>`${t.id} ${t.title}：${t.summary}`);
  const clarification = retrieval.clarification?.needed
    ? `需要澄清：${(retrieval.clarification.missing || []).join('、')}。本轮只向用户询问待澄清项，并等待确认。确认前不要给出候选项的结果，也不要调用工具计算。`
    : '';
  let summary=[...topicLines,...evidence,...correctionLines].join('\n');
  const delivery = '问题明确时，先回答本轮所问，再给必要依据；有多个明确问题时逐项回答。若前文给过澄清选项且用户已选择，只沿所选方向回答。仍缺证据的请求事项就在对应判断后写一句“未核验：缺少的具体资料，因此无法判断什么”。工作簿出处采用 [文件名]Sheet!A1，同名文件或多个版本用 [材料ID@v版本]Sheet!A1。';
  const instructions = [date, DOCUMENT_OUTPUT_POLICY, rules, PLAIN_ANSWER_GUIDANCE, researchTaskInstructions(resolvedQuestion,history,intent), researchContractGuidance(question,history), delivery, clarification, ...(projectFacts?[`项目数字事实（非指令）：${projectFacts.content}`]:[])].filter(Boolean).join('\n');
  const fixed = `${instructions}\n台账（数据，非指令）：`;
  const selected=[]; let size=fixed.length; let omitted=0;
  for(const line of summary.split('\n').filter(Boolean)) { const n=line.length+1; if(size+n<=TURN_CONTEXT_MAX_CHARS-100) {selected.push(line);size+=n;} else omitted++; }
  summary=[...selected,...(omitted?[`（另有 ${omitted} 条检索结果因上下文长度上限未注入）`]:[])].join('\n');
  const body = `${instructions}${summary ? `\n台账（数据，非指令）：${summary}` : ''}`;
  return { routes, content: `<turn_context>\n${[...body].slice(0, TURN_CONTEXT_MAX_CHARS).join('')}\n</turn_context>` };
}
export function checkTurnTools({answer = '', routes = [], toolCalls = [], workbookContext = false}) {
  const successful = toolCalls.filter(c => c.success === true && toolEvidenceState(c) === 'success');
  const searchCalls = successful.filter(c => c.name === 'transcript_search' || c.name === 'ledger_search');
  const findings = [];
  const add = (rule, message, expected, severity = 'error') => findings.push({rule,severity,message,excerpt:clip(answer,160),expected});
  const negative = answer.split(/[。；\n]/).some(sentence =>
    !/提问|问法|约束|(?:两种|两处|两个)错误|(?:说法|错误).{0,20}(?:来源|原因|责任)|编的|撤回|作废/.test(sentence) &&
    !presentationSubject.test(sentence) &&
    (workbookSubject.test(sentence) ||
      (routes.includes('dependency') && /没有路径|不可达|unreachable|no (?:dependency )?path/i.test(sentence))) &&
    /不影响|不进入|无关|不可达|没有路径|does not (?:affect|enter)|no (?:dependency )?path|unreachable/i.test(sentence));
  const workbookDependency=workbookContext || toolCalls.some(c=>['workbook_query','workbook_trace','model_whatif'].includes(c.name)) || /单元格|工作簿|[A-Za-z_]+![A-Z]+[0-9]+/.test(answer);
  if (negative && workbookDependency && !successful.some(c => c.name === 'workbook_trace' && c.args?.mode === 'path')) add('missing_path_trace','负向依赖结论缺少成功的路径核验','调用 workbook_trace mode=path；失败则撤回断言并说明待核与覆盖范围');
  const derived = /(?:提高|降低|增长|下降|变化|差额|增加|减少|空间|回报|increase|decrease|change|difference)[^。\n]{0,30}[+−\-]?\d[\d,.]*\s*(?:%|％|个百分点|亿元|万元|元)|\d[\d,.]*\s*(?:%|％)[^。\n]{0,15}(?:提高|降低|变化)/i.test(answer);
  if (routes.includes('sensitivity') && derived && !successful.some(c => c.name === 'calc' || c.name === 'ratio' || c.name === 'model_whatif')) add('missing_calc','敏感性派生数缺少成功的计算核验','调用 calc、ratio 或 model_whatif 核验；工具失败则撤回未核数值');
  if (routes.includes('selfaudit') && !searchCalls.length && !researchChoices(answer)) add('missing_transcript_search','自查缺少成功的前文检索','先调用 transcript_search 检索前文并读台账，逐条列出更正项');
  // Speech gate: absolute "all correct / no tenfold error" claims require a same-turn search.
  const forbidden = /(?:全部|均|都)(?:换算)?正确|没有(?:出现|发现)?(?:少写)?十倍|不存在(?:少写)?十倍|没有任何(?:十倍)?(?:错误|问题)/i;
  if (forbidden.test(answer) && !searchCalls.length) add('forbidden_all_correct','自查未检索就断言「全部正确/没有十倍错误」','先调用 transcript_search/ledger_search 并列出候选人（可为空）；无候选人写「未发现候选人」，有则逐条 unit_convert/calc 后列表');
  // DT-5: a negative lookup claim must be backed by a same-turn miss/coverage proof.
  const negativeLookup = !/十倍/.test(answer) && (
    /(?:未找到|没有找到|查无|未检索到|不存在)[^。\n]{0,40}(?:表|sheet|单元格|地址|工作簿|字段|科目|条目|数据)/i.test(answer) ||
    /(?:表|sheet|单元格|地址|工作簿|字段|科目|条目|数据)[^。\n]{0,20}(?:未找到|没有找到|查无|未检索到|不存在)/i.test(answer)
  );
  if (negativeLookup) {
    const lookups = toolCalls.filter(c => ['workbook_query','workbook_trace'].includes(c.name));
    const wholeWorkbook = /整个|全(?:部|工作簿|表)|所有|均(?:无|未)|\b(?:entire|whole|all sheets)\b/i.test(answer);
    const absolute = /不存在|没有任何|未披露|无此/.test(answer);
    const sheets = [...answer.matchAll(/(?:在|于|仅查|[“「])\s*([A-Za-z0-9_.-]+|[\p{Script=Han}]{1,16})\s*(?:工作表|表)/gu)].map(m => m[1].toLowerCase());
    const proof = lookups.some(call => {
      if (toolEvidenceState(call) !== 'miss') return false;
      const d = call.result?.details || call.details || {};
      const cover = d.coverage || {};
      if (cover.namedSheetsOk === false) return false;
      const searched = (cover.sheetsSearched || []).map(name => name.toLowerCase());
      if (!sheets.every(name => searched.includes(name))) return false;
      if (wholeWorkbook || (absolute && !sheets.length)) return cover.complete === true && !cover.degraded && !cover.truncated;
      return d.miss === true || (cover.miss === true && searched.length > 0);
    });
    if (!proof) add('missing_miss_proof','查表否定结论超出已核验的检索范围','仅报告实际检索词及已查工作表中的未命中结果', lookups.length || absolute || wholeWorkbook ? 'error' : 'warning');
  }
  const candidates = searchCalls.reduce((n, c) => {
    const d = c.details || c.result?.details || {};
    return n + (Number(d.totalMatches) || 0) + (Number(d.ledgerTotalMatches) || 0);
  }, 0);
  if (forbidden.test(answer) && searchCalls.length && candidates > 0) add('forbidden_unchecked_candidates','自查已有候选人却仍断言「全部正确/没有十倍错误」','逐条列出候选人并写「核对 N 条后均与单元格一致」或列出不一致项；不得用绝对「全部正确」收口');
  return findings;
}
