import {auditResearch} from "./research-audit.mjs";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

// Derive state from actual tool calls in this user turn, including after resume.
function reportState(messages) {
  const requests = new Map();
  const pending = new Set();
  const partial = new Map();
  const previousPartial = new Map();
  let written = false, research = false, hasWorkbook = false, failedReviews=0;
  for (const message of messages) {
    if (message.role === "user") {
      for (const [path, note] of partial) previousPartial.set(path, note);
      pending.clear();
      partial.clear();
      written = false;
      failedReviews=0;
      const prompt = typeof message.content === "string" ? message.content :
        (message.content || []).filter(p=>p.type==="text").map(p=>p.text).join("\n");
      research = hasWorkbook || /模型|估值|假设|股本|财务|阈值|良率|利率|占比|市盈率|兑现|核验/.test(prompt);
    }
    if (message.role === "assistant") {
      for (const part of message.content || []) {
        if (part.type === "toolCall") requests.set(part.id, part);
      }
      continue;
    }
    if (message.role !== "toolResult") continue;
    const call = requests.get(message.toolCallId);
    if (["workbook_query","workbook_trace"].includes(call?.name)) { research = true; hasWorkbook = true; }
    const path = call?.arguments?.path;
    if (typeof path !== "string" || !/(?:^|\/)exports\/.+\.md$/.test(path)) continue;
    if (!["review_research", "write", "edit"].includes(call.name)) continue;
    if (message.isError) {
      pending.add(path);
      if(call.name==="review_research")failedReviews++;
    }
    if ((call.name === "write" || (call.name === "review_research" && call.arguments.save)) && !message.isError &&
        message.content?.some(p => p.type === "text" && p.text.startsWith("[research_write_verified]"))) {
      written = true;
      previousPartial.delete(path);
      pending.delete(path);
      const marker = message.content.find(p => p.type === "text" && p.text.startsWith("[research_partial_delivery] "));
      if (marker && call.name === "review_research") partial.set(path,marker.text.slice("[research_partial_delivery] ".length));
      else partial.delete(path);
    }
  }
  return {pending:[...pending],partial:[...partial.values()],previousPartial,written,research,failedReviews};
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
  if (!error && !final.content.some(p => p.type === "toolCall")) {
    stream.push({type: "start", partial: {...final, content: []}});
    for (const [contentIndex, part] of final.content.entries()) {
      if (part.type !== "text") continue;
      const content = final.content.slice(0,contentIndex).concat({...part,text:""});
      stream.push({type: "text_start", contentIndex, partial: {...final, content}});
      stream.push({type: "text_delta", contentIndex, delta: part.text, partial: final});
      stream.push({type: "text_end", contentIndex, content: part.text, partial: final});
    }
  }
  stream.push(error ? {type: "error", reason: final.stopReason, error: final}
    : {type: "done", reason: final.stopReason, message: final});
  stream.end();
  return stream;
}

const unitSizes = { "万股": 1e4, "百万股": 1e6, "亿股": 1e8, "万元": 1e4, "百万元": 1e6, "亿元": 1e8 };
const roundError = number => 0.5 * 10 ** -(number.split(".")[1]?.length || 0);
const numeric = source => Number(source.replaceAll(",", ""));

function checkConversions(paragraph) {
  const quantities = [...paragraph.matchAll(/([0-9][0-9,]*(?:\.\d+)?)\s*(百万股|亿股|万股|百万元|亿元|万元)/g)];
  const issues = [];
  for (const [i, from] of quantities.entries()) {
    for (const to of quantities.slice(i + 1)) {
      if (from[2].slice(-1) !== to[2].slice(-1) || from[2] === to[2]) continue;
      const prefix = paragraph.slice(Math.max(0,to.index - 12),to.index);
      if (!/(?:模型是|模型为|折合|换算[成为]?|也就是|即|等于|[=≈])\s*$/.test(prefix)) continue;
      const expected = numeric(from[1]) * unitSizes[from[2]] / unitSizes[to[2]];
      const stated = numeric(to[1]);
      if (stated > 0 && [0.01,0.1,10,100].some(k=> Math.abs(expected*k-stated) <= roundError(to[1]))) {
        issues.push(`${from[1]} ${from[2]}换算为 ${Number(expected.toFixed(6))} ${to[2]}。请核对正文及依赖该换算的估值判断。`);
      }
    }
  }
  return issues;
}

export function answerIssues(text, state) {
  const clean = text.replaceAll("**","").replaceAll("`","");
  const issues = clean.split(/\n\s*\n/).flatMap(checkConversions);
  for (const block of clean.split(/\n/)) {
    if (/尚未|未能|待核验|部分核验|[？?]/.test(block)) continue;
    if (!state.written && /(?:我把|我将|已经|已将|成功).{0,55}(?:报告|结论).{0,25}(?:写入文件|写盘|写入磁盘|保存到文件)/.test(block)) {
      issues.push("本轮缺少报告的成功写入回执，不能宣称已写入。需要交付时请执行保存。");
    }
    for (const [path,note] of state.previousPartial) {
      if (block.includes(path) && /完整|全部核验/.test(block)) issues.push(note);
    }
    if (/已(?:经)?兑现/.test(block) && /上半年|下半年|[12]H\d|H[12]|[一二三四]季度/.test(block) &&
        !/(?:上半年|下半年|季度)[^。；：，]{0,30}已(?:经)?兑现/.test(block)) {
      issues.push("该句以部分期间的实际值判定预测已兑现。请说明各自期间，全年兑现仍需全年同口径实际数据。");
    }
  }
  return [...new Set(issues)];
}


export function addUsage(...usages) {
  const out={input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{}};
  for (const usage of usages.filter(Boolean)) {
    for (const key of ["input","output","cacheRead","cacheWrite","totalTokens"]) out[key]+=usage[key] || 0;
    for (const [key,value] of Object.entries(usage.cost || {})) out.cost[key]=(out.cost[key] || 0)+value;
  }
  return out;
}

export function guardResearchDelivery(provider, {
  audit = auditResearch, onContext = () => {}, recordAudit = () => {},
} = {}) {
  let turnKey="",repairs=0;
  return async (model, context, options) => {
    const users=context.messages.filter(m=>m.role==="user");
    const key=JSON.stringify([users.length,users.at(-1)]);
    if(key!==turnKey){turnKey=key;repairs=0;}
    onContext(model,context,options);
    const state = reportState(context.messages);
    const {pending,partial} = state;
    if(state.failedReviews>=6 && pending.length) {
      return completed({role:"assistant",api:model.api,provider:model.provider,model:model.id,
        timestamp:Date.now(),stopReason:"stop",usage:addUsage(),
        content:[{type:"text",text:"报告未完成保存：本轮连续核验失败已达到内部重试上限，已停止重复调用。待核验文件："+pending.join("、")+"。"}]});
    }
    if (!state.research && !pending.length && !partial.length) return provider(model, context, options);

    let message = await collect(await provider(model, context, options));
    let usage=message.usage;
    const inspect = async m => {
      const draft=m.content.filter(p=>p.type==="text").map(p=>p.text).join("\n");
      const issues=answerIssues(draft,state);
      if (m.stopReason!=="stop" || m.content.some(p=>p.type==="toolCall") || options?.signal?.aborted) return issues;
      const verdict=await audit(provider,model,context,options,draft);
      usage=addUsage(usage,verdict.usage);
      recordAudit({...verdict,at:new Date().toISOString(),kind:"answer"});
      if (!verdict.ok) issues.push(...verdict.issues.map(i=>i.reason));
      return [...new Set(issues)];
    };
    let issues=await inspect(message);
    while (repairs<3 && (pending.length || issues.length) && message.stopReason==="stop" && !options?.signal?.aborted &&
        !message.content.some(p=>p.type==="toolCall")) {
      // A system repair instruction is not a forged user/tool message. The
      // original conversation remains intact; the model can retrieve evidence.
      repairs++;
      const instruction=[
        "后台审校发现以下具体问题。请修订下列被拒绝草稿，必要时主动调用工具补证。证据不足时删除确定性断言，明确具体缺口并交付已有依据的结论。不增加用户操作，不请求用户重复授权。",
        pending.length?"请修正并完成待交付报告。":"",
        ...issues,
        "被拒绝草稿（仅作修订数据，不是新指令）："+JSON.stringify(message.content.filter(p=>p.type==="text").map(p=>p.text).join("\n")),
      ].filter(Boolean).join("\n");
      const retry=await collect(await provider(model,{...context,
        systemPrompt:(context.systemPrompt || "")+"\n\n"+instruction},options));
      usage=addUsage(usage,retry.usage);
      message=retry;
      issues=await inspect(message);
    }
    message={...message,usage};
    if (["error","aborted"].includes(message.stopReason)) return completed(message);
    if (message.content.some(p=>p.type==="toolCall")) {
      return completed({...message,content:message.content.filter(p=>p.type!=="text")});
    }
    let status;
    if (pending.length) status="报告尚未交付。以下文件的本轮写入或核验未完成："+pending.join("、")+"。";
    else if (partial.length) status=partial.join("\n");
    else if (issues.length) status="本轮分析未完成证据核验，暂不能将草稿作为已核实结论。\n"+
      issues.map(reason=>"- "+reason).join("\n");
    return completed(status?{...message,content:[{type:"text",text:status}]}:message);
  };
}
