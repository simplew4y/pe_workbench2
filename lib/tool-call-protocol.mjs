import { randomUUID } from 'node:crypto';
import { Value } from 'typebox/value';
import { createAssistantMessageEventStream, getCurrentTools, normalizeContext } from '@earendil-works/pi-ai';

const marker = /<\/?[｜|]{2}DSML[｜|]{2}/;
export const hasToolProtocol = text => marker.test(String(text || ''));

// Decode only a complete assistant-authored envelope. Never scan tool results,
// quoted documents, prose, or incomplete generations for executable commands.
export function decodeToolProtocol(message, tools = []) {
  const text = (message.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  if (!hasToolProtocol(text)) {
    if (['stop','toolUse'].includes(message.stopReason) && message.content.some(p=>p.type==='toolCall' && !tools.some(t=>t.name===p.name))) {
      throw new Error('工具调用协议无效：原生调用的工具不在本次允许列表');
    }
    return message;
  }
  const fail = reason => { throw new Error(`工具调用协议无效：${reason}`); };
  if (!['stop', 'toolUse'].includes(message.stopReason)) fail('响应未完整结束');
  if (message.content.some(p => p.type === 'toolCall')) fail('混合原生调用与文本调用');
  const normalized = text.trim().replace(/<\/?[｜|]{2}DSML[｜|]{2}/g, token => token.replaceAll('｜','|'));
  const envelope = normalized.match(/^<\|\|DSML\|\| calls>\s*([\s\S]*?)\s*<\/\|\|DSML\|\| calls>$/);
  if (!envelope) fail('不是独立完整的调用信封');
  const calls = [], invoke = /<\|\|DSML\|\| invoke name="([\w-]+)">([\s\S]*?)<\/\|\|DSML\|\| invoke>/gy;
  let offset = 0;
  while (offset < envelope[1].length) {
    while (/\s/.test(envelope[1][offset] || '') && offset < envelope[1].length) offset++;
    if (offset === envelope[1].length) break;
    invoke.lastIndex = offset;
    const match = invoke.exec(envelope[1]);
    if (!match) fail('调用块不完整');
    offset = invoke.lastIndex;
    const tool = tools.find(t => t.name === match[1]);
    if (!tool) fail('工具不在本次允许列表');
    const args = Object.create(null), param = /\s*<\|\|DSML\|\| parameter name="([\w-]+)" string="(true|false)">([\s\S]*?)<\/\|\|DSML\|\| parameter>/gy;
    let at = 0;
    while (match[2].slice(at).trim()) {
      param.lastIndex = at;
      const p = param.exec(match[2]);
      if (!p || Object.hasOwn(args, p[1]) || ['__proto__', 'constructor', 'prototype'].includes(p[1])) fail('参数无效或重复');
      at = param.lastIndex;
      try { args[p[1]] = p[2] === 'true' ? p[3] : JSON.parse(p[3]); }
      catch { fail('非字符串参数不是完整JSON'); }
    }
    if (!tool.parameters || !Value.Check(tool.parameters, args)) fail('参数与工具定义不一致');
    calls.push({ type:'toolCall', id:`protocol_${randomUUID()}`, name:tool.name, arguments:{...args} });
    if (calls.length > 16) fail('调用数量超限');
  }
  if (!calls.length) fail('空调用');
  return {...message, content:[...message.content.filter(p => p.type === 'thinking'), ...calls], stopReason:'toolUse'};
}

function completed(message) {
  const stream = createAssistantMessageEventStream();
  if (['error','aborted'].includes(message.stopReason)) stream.push({type:'error',reason:message.stopReason,error:message});
  else {
    stream.push({type:'start',partial:{...message,content:[]}});
    for (const [contentIndex, part] of message.content.entries()) {
      if (part.type !== 'text') continue;
      stream.push({type:'text_start',contentIndex,partial:{...message,content:message.content.slice(0,contentIndex).concat({...part,text:''})}});
      stream.push({type:'text_delta',contentIndex,delta:part.text,partial:message});
      stream.push({type:'text_end',contentIndex,content:part.text,partial:message});
    }
    stream.push({type:'done',reason:message.stopReason,message});
  }
  stream.end();
  return stream;
}

export function guardToolProtocol(provider) {
  return async (model, context, options) => {
    const stream = await provider(model, context, options);
    for await (const event of stream) if (['done','error'].includes(event.type)) break;
    const message = await stream.result();
    try { return completed(decodeToolProtocol(message, getCurrentTools(normalizeContext(context).messages))); }
    catch (error) {
      // The delivery layer may compose a new plain answer, but malformed or
      // disabled calls must never execute or become user-visible answer text.
      return completed({...message, content:[], stopReason:['length','error','aborted'].includes(message.stopReason)?message.stopReason:'stop', protocolFailure:error.message});
    }
  };
}
