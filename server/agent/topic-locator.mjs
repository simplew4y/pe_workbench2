import { completeSimple, getModel } from '@earendil-works/pi-ai/compat';
import { textOfContent } from './snapshot.mjs';

export function recentTopicDialogue(messages) {
  return messages
    .filter(message => message.role === 'user' || message.role === 'assistant')
    .slice(-12)
    .map(message => `${message.role}: ${textOfContent(message.content).slice(0, 1200)}`)
    .join('\n');
}

// The locator needs dates and qualitative dialogue. Amounts belong to the fact register.
const amounts = /[+−-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\s*(?:万亿元|千亿元|百亿元|亿元|千万元|百万元|万元|千元|元|个百分点|%|％)/gu;

export async function indexJson(modelId, prompt) {
  let result;
  try {
    result = await completeSimple(
      getModel('deepseek', modelId || 'deepseek-flash'),
      { messages: [{ role: 'user', content: prompt }] },
      { temperature: 0 },
    );
  } catch (error) {
    throw Object.assign(new Error(error.message, { cause: error }), { code: 'provider_error' });
  }
  if (result?.errorMessage || ['error', 'aborted'].includes(result?.stopReason)) {
    throw Object.assign(new Error(result.errorMessage || result.stopReason), { code: 'provider_error' });
  }
  const text = Array.isArray(result?.content)
    ? result.content.filter(block => block.type === 'text').map(block => block.text).join('')
    : String(result?.content || '');
  try {
    return JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (error) {
    throw Object.assign(new Error('Index model returned invalid JSON', { cause: error }), { code: 'malformed_output' });
  }
}

function strings(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function validSelection(value) {
  const { topicIds, parsed, clarification } = value ?? {};
  return strings(topicIds)
    && parsed && (parsed.company === null || typeof parsed.company === 'string')
    && (parsed.metric === null || typeof parsed.metric === 'string')
    && Array.isArray(parsed.periods)
    && parsed.periods.every(period => typeof period === 'string' || Number.isInteger(period))
    && clarification && typeof clarification.needed === 'boolean' && strings(clarification.missing);
}

export async function locateChatTopics(modelId, { question, history, topics }) {
  const selection = await indexJson(modelId,
    `只根据问题、近期对话和主题标题/摘要定位。禁止输出事实数字、计算结果。严格输出 JSON：{"topicIds":[],"parsed":{"company":null,"metric":null,"periods":[]},"clarification":{"needed":false,"missing":[]}}
问题:${question}
历史:${history.replace(amounts, '[金额略]')}
主题:${JSON.stringify(topics)}`);
  if (!validSelection(selection)) {
    throw Object.assign(new Error('Index model returned an invalid topic selection'), { code: 'malformed_output' });
  }
  return { ...selection, parsed: { ...selection.parsed, periods: selection.parsed.periods.map(String) } };
}
