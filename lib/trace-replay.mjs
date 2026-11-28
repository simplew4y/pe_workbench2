import { Type } from "typebox";

export const TRACE_REPLAY_TOOL = "workbook_trace_replay";
const TRACE_CARD_MIN_BYTES = 4_000;
const REPLAY_PAGE_CHARS = 5_000;
const important = /目标价|估值|每股|利润率|收入|增速|折现|假设|target price|valuation|margin|revenue|discount|multiple|\b(?:eps|cagr|wacc)\b/i;
const valuationOutput = /目标价|每股价值|target price|fair value per share/i;
const contentText = message => typeof message?.content === "string" ? message.content :
  (message?.content || []).filter(block => block.type === "text").map(block => block.text).join("\n");

function cellEvidence(cell) {
  return Object.fromEntries(["ref", "label", "role", "formula", "value", "display", "cacheStatus", "display_unit",
    "currency", "period", "upstreamRefs", "upstreamCount"].filter(key => cell[key] != null).map(key => [key, cell[key]]));
}

function availableTrace(message) {
  return message?.role === "toolResult" && message.toolName === "workbook_trace" && !message.isError &&
    message.details?.status === "ready" && !!message.details.sha256 && message.details.version != null;
}

function findCell(trace, ref) {
  const search = ref.toLowerCase();
  const stack = [trace.tree, trace.target, ...(trace.direct || []), ...(trace.cells || [])];
  while (stack.length) {
    const cell = stack.pop();
    if (!cell) continue;
    if (cell.ref?.toLowerCase() === search) return cell;
    if (cell.children) stack.push(...cell.children);
  }
}

function batchSummary(trace) {
  return (trace.subtraces || []).map((item,index)=>{
    const prefix=`#${index+1}`;
    if(item.duplicateOf)return `${prefix} 同 #${item.duplicateOf}`;
    if(item.error)return `${prefix} 追踪失败：${item.error}`;
    const scope=item.target?.ref || item.ref || item.range ||
      (item.sheet ? `${item.sheet} 第 ${item.rowStart}-${item.rowEnd} 行` : item.mode);
    const selected=(item.target ? [item.target,...(item.direct || []).slice(0,4)] :
      (item.cells || []).filter(cell=>valuationOutput.test(cell.label || cell.rowLabel || "")).slice(0,4));
    return [`${prefix} ${scope}；${item.returned == null ? "" : `返回 ${item.returned} 格；`}原图截断=${!!item.truncated}`,
      ...selected.map(cell=>JSON.stringify(cellEvidence(cell)))].join("\n");
  });
}

export function createTraceReplayTool({ getMessages }) {
  return {
    name: TRACE_REPLAY_TOOL,
    label: "回看公式追踪证据",
    description: "从当前会话分支按回执编号回看已保存的 workbook_trace。可翻页查看原文，或按完整工作表!单元格坐标读取该次追踪的结构化证据；不会打开当前文件或重跑追踪。",
    promptSnippet: "workbook_trace_replay：按回执 ID 翻页回看公式明细，或按坐标取回原版本证据",
    parameters: Type.Object({
      callId: Type.String({ minLength: 1 }),
      ref: Type.Optional(Type.String({ minLength: 1, description: "完整坐标，如 Discount PE!H29" })),
      offset: Type.Optional(Type.Integer({ minimum: 0, description: "原回执文本的续读位置；使用上页返回的 nextOffset" })),
    }),
    async execute(_id, { callId, ref, offset = 0 }) {
      const message = getMessages().findLast(item => item.toolCallId === callId && availableTrace(item));
      if (!message) return {
        content: [{ type: "text", text: "当前会话分支未找到该成功回执；请核对 ID，或按原坐标重新追踪并核对版本。" }],
        isError: true,
      };
      const trace = message.details;
      const source = { callId, path: trace.path, version: trace.version, sha256: trace.sha256, traceTruncated: trace.truncated };
      if (ref) {
        const cell = findCell(trace, ref);
        if (!cell) return { content: [{ type: "text", text: JSON.stringify({ ...source, ref, miss: true,
          note: "该次回执未包含该格，不代表工作簿不存在该格。必要时按单格重新追踪并核对版本。" }) }] };
        const citations = (trace.citations || []).filter(citation => citation.locator?.toLowerCase() === ref.toLowerCase());
        return { content: [{ type: "text", text: JSON.stringify({ ...source, cell: cellEvidence(cell), citations }) }] };
      }
      const full = contentText(message);
      if (!Number.isSafeInteger(offset) || offset < 0 || offset >= full.length) return {
        content: [{ type: "text", text: "续读位置超出原回执范围；请使用上一页的 nextOffset。" }], isError: true,
      };
      let end = Math.min(offset + REPLAY_PAGE_CHARS, full.length);
      if (end < full.length && /[\uD800-\uDBFF]/.test(full[end - 1])) end--;
      const page = { ...source, offset, nextOffset: end < full.length ? end : null, fullChars: full.length };
      return { content: [{ type: "text", text: JSON.stringify(page) + "\n" + full.slice(offset, end) }],
        details: { traceReplayPage: page } };
    },
  };
}

export function compactSeenTraceEvidence(messages, lastQuestion, lastAssistant) {
  const latestBoundary = Math.max(lastQuestion, lastAssistant);
  const question = contentText(messages[lastQuestion]).toLowerCase();
  const terms = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(question)]
    .filter(item => item.isWordLike && item.segment.length > 1).map(item => item.segment).slice(0, 64);
  let changed = false;
  const projected = messages.map((message, index) => {
    if (index > latestBoundary) return message;
    if (message.role === "toolResult" && message.toolName === TRACE_REPLAY_TOOL && message.details?.traceReplayPage) {
      changed = true;
      return { ...message, content: [{ type: "text", text: JSON.stringify(message.details.traceReplayPage) +
        "\n已展示原文页；需要再次核对时按 callId 和 offset 回读。" }] };
    }
    if (!availableTrace(message) || !["rows", "range", "cell", "batch"].includes(message.details.mode)) return message;
    const trace = message.details;
    const raw = message.content?.[0]?.text || "";
    if (Buffer.byteLength(raw) < TRACE_CARD_MIN_BYTES) return message;
    const lines = raw.split("\n");
    let kept;
    if (trace.mode === "batch") {
      if (!trace.subtraces?.length) return message;
      kept=batchSummary(trace);
      if(lines.some(line=>line.includes("输出已截断")))kept.push("至少一项原始展示文本已截断；不是完整覆盖。");
    } else if (trace.mode === "cell") {
      const treeStart = lines.findIndex(line => line.startsWith("上游树（"));
      if (treeStart < 0) return message;
      kept = lines.slice(0, treeStart + 1);
    } else {
      const candidates = lines.flatMap((line, position) => {
        if (!/^- .+?!\$?[A-Z]{1,3}\$?\d+ · /u.test(line)) return [];
        const lower = line.toLowerCase();
        const score = (valuationOutput.test(line) ? 12 : important.test(line) ? 2 : 0) +
          terms.filter(term => lower.includes(term)).length * 3;
        return [{ position, score }];
      });
      const picked = new Set([...candidates.slice(0, 3), ...candidates.toSorted((a, b) => b.score - a.score).slice(0, 10)]
        .map(item => item.position));
      const all = new Set(candidates.map(item => item.position));
      kept = lines.filter((_line, position) => !all.has(position) || picked.has(position));
    }
    const suffix = lines.filter(line => line.startsWith("计算输入出处") || (trace.mode!=="batch" &&
      (line.includes("已截断") || trace.notes?.some(note => line === `- ${note}`))));
    for (const line of suffix) if (!kept.includes(line)) kept.push(line);
    const header = `公式追踪精简回执（非完整覆盖）：ID=${message.toolCallId}；版本=${trace.version}；SHA256=${trace.sha256}；原结果截断=${!!trace.truncated}。其余明细用 ${TRACE_REPLAY_TOOL} 按 ID/坐标回看；缓存值不等于重算。`;
    const compact = [header, ...kept].join("\n");
    if (Buffer.byteLength(compact) >= Buffer.byteLength(raw) * 0.8) return message;
    changed = true;
    return { ...message, content: [{ ...message.content[0], text: compact }, ...message.content.slice(1)] };
  });
  return changed ? projected : messages;
}
