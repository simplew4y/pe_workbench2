import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Derive state from actual tool calls in this user turn, including after resume.
function pendingReports(messages) {
  const requests = new Map();
  const pending = new Set();
  for (const message of messages.slice(messages.findLastIndex(m => m.role === "user") + 1)) {
    if (message.role === "assistant") {
      for (const part of message.content || []) {
        if (part.type === "toolCall") requests.set(part.id, part);
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const call = requests.get(message.toolCallId);
    const path = call?.arguments?.path;
    if (typeof path !== "string" || !/(?:^|\/)exports\/.+\.md$/.test(path)) continue;
    if (!["review_research", "write", "edit"].includes(call.name)) continue;
    if (message.isError) pending.add(path);
    if ((call.name === "write" || (call.name === "review_research" && call.arguments.save)) && !message.isError &&
        message.content?.some(p => p.type === "text" && p.text.startsWith("[research_write_verified]"))) {
      pending.delete(path);
    }
  }
  return [...pending];
}

async function collect(stream) {
  // Consume provider events so request errors, cancellation and tool calls
  // follow the ordinary SDK path, without broadcasting rejected draft text.
  for await (const event of stream) {
    if (event.type === "done" || event.type === "error") break;
  }
  return stream.result();
}

function completed(message) {
  const stream = createAssistantMessageEventStream();
  const error = ["aborted", "error"].includes(message.stopReason);
  const final = { ...message, content: message.content.filter(p => p.type !== "text" || !error) };
  if (!error && final.content.every(p => p.type === "text")) {
    stream.push({type: "start", partial: {...final, content: []}});
    for (const [contentIndex, part] of final.content.entries()) {
      stream.push({type: "text_start", contentIndex, partial: {...final, content: []}});
      stream.push({type: "text_delta", contentIndex, delta: part.text, partial: final});
      stream.push({type: "text_end", contentIndex, content: part.text, partial: final});
    }
  }
  stream.push(error ? {type: "error", reason: final.stopReason, error: final}
    : {type: "done", reason: final.stopReason, message: final});
  stream.end();
  return stream;
}

export function guardResearchDelivery(provider) {
  return async (model, context, options) => {
    const pending = pendingReports(context.messages);
    if (!pending.length) return provider(model, context, options);

    let message = await collect(await provider(model, context, options));
    if (message.stopReason === "stop" && !options?.signal?.aborted &&
        !message.content.some(p => p.type === "toolCall")) {
      // One internal recovery attempt. Keep the original user turn and the
      // persisted tool result intact. Only this provider request gets the note.
      const messages = [...context.messages];
      const index = messages.findLastIndex(m => m.role === "toolResult");
      const last = messages[index];
      messages[index] = {...last, content: [...last.content, {type:"text",
        text:"工作台仍有待交付报告。请直接调用工具修正并核验报告，保留可证实的原表数值，说明其他证据缺口。无需用户再次确认。"}]};
      const retry = await collect(await provider(model, {...context, messages}, options));
      const usage = {...retry.usage};
      for (const key of ["input","output","cacheRead","cacheWrite","totalTokens"]) {
        usage[key] = (message.usage?.[key] || 0) + (retry.usage?.[key] || 0);
      }
      usage.cost = {...retry.usage?.cost};
      for (const key of Object.keys(usage.cost)) usage.cost[key] += message.usage?.cost?.[key] || 0;
      message = {...retry, usage};
    }
    if (["error", "aborted"].includes(message.stopReason)) return completed(message);
    const calls = message.content.filter(p => p.type === "toolCall");
    if (calls.length) return completed({...message, content: message.content.filter(p => p.type !== "text")});
    return completed({...message, content: [{type: "text",
      text: `报告尚未交付。以下文件的本轮写入或核验未完成：${pending.join("、")}。本轮草稿中的结论尚待核验。`
    }]});
  };
}
