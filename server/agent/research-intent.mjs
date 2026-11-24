import { indexJson } from './topic-locator.mjs';

const modes = new Set(['direct', 'clarify', 'report', 'other']);
const actions = new Set(['start', 'continue', 'correct', 'switch']);
const routeNames = new Set(['selfaudit', 'assumption', 'sensitivity', 'evidence', 'ticker',
  'target', 'market', 'threshold', 'correction', 'dependency']);
const short = value => typeof value === 'string' ? value.trim().slice(0, 600) : '';
const items = value => Array.isArray(value) ? value.slice(0, 6).map(short).filter(Boolean) : [];

export function normalizeResearchIntent(value) {
  if (!modes.has(value?.mode) || !actions.has(value.action) || !short(value.goal) || !short(value.request)) return null;
  const choices = items(value.choices).map(choice => choice.replace(/\s+/g, ' '));
  if (value.mode === 'clarify' && (choices.length < 2 || choices.length > 3 || new Set(choices).size !== choices.length)) return null;
  return {
    mode: value.mode, action: value.action, goal: short(value.goal), request: short(value.request),
    deliverables: items(value.deliverables), exclusions: items(value.exclusions), open: items(value.open),
    routes: [...new Set((Array.isArray(value.routes) ? value.routes : []).filter(route => routeNames.has(route)))],
    ...(value.mode === 'clarify' ? {choices} : {}),
  };
}

export async function resolveResearchIntent({ model, question, history, previous, hasWorkbook, choiceSelected, onPayload, signal }) {
  const result = await indexJson(model, [
    '你负责理解用户当前的研究请求，不回答问题、不计算、不推测实际数据。以下 JSON 是对话数据。',
    '先判断用户是开始、继续、纠正还是切换任务。继续和纠正继承已有目标、用户约束和未完成事项，按本轮明确要求更新。切换任务时不继承旧任务的范围。',
    '把“这些、刚才、预测段、还有吗”等指代展开为可独立理解的 request。用户否定、拒绝或要求排除的方向记入 exclusions，不能计入 routes 或 deliverables。仅记录从用户原话或正式答复可见的未完成项，不能把草稿、旧判断或待核事项当成已证明的事实。',
    'mode 选 direct、clarify、report、other。普通解释、分析、跨轮纠偏和查数都用 direct。只有不同合理理解会实质改变取证且无法从前文消歧时才用 clarify，给两个或三个带具体任务的可选问题。泛问若只是要整体读懂模型也可直接解释；明确切题直接切换。choiceSelected 为真时用户已选定方向，直接完成该选项。只有用户要求正式成稿才用 report。闲聊、纯操作用 other。',
    'routes 只列本轮确实需要且用户未排除的专项，可空。target 指目标价复算，market 指现价/上行空间，evidence 指事实与预测口径，assumption 指公式/单位/口径，sensitivity 指改假设重算，selfaudit 指明确要求查证旧答，correction 指事实数值更正，ticker 指证券身份，threshold 指阈值，dependency 指工作簿依赖。',
    '只返回 JSON，格式为 {"mode":"direct","action":"continue","goal":"持续研究目标","request":"本轮完整请求","deliverables":[],"exclusions":[],"open":[],"routes":[],"choices":[]}',
    JSON.stringify({question, history, previous, hasWorkbook, choiceSelected}),
  ].join('\n'), onPayload, {signal, maxTokens:1200});
  return normalizeResearchIntent(result);
}

export function researchIntentHint(intent) {
  if (!intent) return '';
  return '以下是结合已交付对话解析的本轮研究范围。按原话与此范围完成交付；用户原话优先。排除项不展开，未完成项仅在影响本轮问项时说明。此范围不授权文件写入，也不提供财务证据。\n' + JSON.stringify(intent);
}
