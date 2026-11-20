import {digest, sourceBusinessTools} from './source-plan.mjs';
import {DOCUMENT_OUTPUT_POLICY} from '../../lib/document-output-policy.mjs';
import {appendTurnMarker} from './turn-delivery.mjs';

const instructions = {
  request:
    '只读原问。列出明确要求，保留原文区间所对应的精确词语、条件、轮次、材料和必答字段。输出 JSON {"kind":"ordinary|history|mixed|pending","items":[{"action":"search|read","term":"原问中明确要求查的词（未指定则为空）","quote":"原文","condition":"原文或空","fields":[]}]}。书名和输出字段本身不是待搜索的词。返回历史引用的字段属于 search；只有另行读取材料才列 read。',
  claims:
    '只读可见 Markdown。对每个给出的 unit 逐项回答，quote 必须完整逐字复制对应的 unit，不复制用户原问。不接触工具真值。按每个完整句或独立行列出所作的实质断言，逐字复制 quote，保留否定、条件、并列附加事实的作用域。输出 JSON {"claims":[{"quote":"精确原文","relation":"historical|current|absence|financial|execution|scope|unknown","polarity":"positive|negative|uncertain","fields":[{"name":"materialId|version|locator|filename|displayFilename|storedFilename|id|value","literal":"原文字段"}]}]}。仅陈述本次答文会报告哪些字段、不会重报哪些内容，且没有附加事实时标 scope。仅陈述本回合搜索覆盖或是否再次读取时标 execution。每个 execution 字段包含 name、原文 literal 和精确 value；可选 assistantMatches（该次命中的正式回答数）、citationCount（引用数）、ledgerMatches（台账命中数）、scannedTurn（唯一被扫描的轮次）、turnsScanned、directReadCount、totalTurns、truncated、sourceTurnId、sourceStatus、limitCount。value 按证据字段使用 JSON 类型和枚举：计数为整数，truncated 为布尔，状态用 completed/partial/failed/cancelled/unknown。台账的零和历史答文的零分别标注。保留否定后的真实值，例如“没有重新读取”对应 directReadCount=0。单独的字段标题属于同一出处。只有整句纯粹说明先前正式答文所用出处时才标 historical。按陈述关系区分显示文件名 displayFilename、磁盘文件名 storedFilename 和未限定的 filename。引导语或字段排版不影响归类。',
};

function turnBudget(active) {
  return (active.budget ??= {started: Date.now(), business: 0, side: 0, input: 0, output: 0, requests: []});
}

export function sourceModelOptions(active, model, options, configPayload) {
  const budget = turnBudget(active);
  const side = !!options?.sourceOperation;
  const ms = 180000 - (Date.now() - budget.started);
  if (ms <= 0 || active.controller.signal.aborted) throw new Error('本轮模型调用已停止');
  const signal = AbortSignal.any([
    active.controller.signal,
    AbortSignal.timeout(Math.max(1, Math.min(ms, side ? 15000 : 180000))),
    ...(options?.signal ? [options.signal] : []),
  ]);
  const maxTokens = Math.min(model.maxTokens || 5000, options?.maxTokens || 2048, side ? 1024 : 5000);
  const onPayload = async (payload, requestModel) => {
    const modified = await options?.onPayload?.(payload, requestModel);
    const body = (await configPayload?.(modified ?? payload, requestModel)) ?? modified ?? payload;
    if (signal.aborted) throw new Error('本轮模型请求已停止');
    if (side && (body.tools?.length || body.functions?.length)) throw new Error('无工具核读请求意外包含工具');
    const initialBytes = Buffer.byteLength(JSON.stringify(body));
    const availableBytes = Math.min(side ? 8000 : 32000, 192000 - budget.input);
    // Redundant completed tool outputs from earlier turns are recoverable
    // through transcript_search. Preserve paired protocol messages and every
    // result from the current question, including errors and negative results.
    const allowed = sourceBusinessTools(active.plan, options);
    if (allowed && Array.isArray(body.tools)) {
      body.tools = body.tools.filter((t) => allowed.has(t.function?.name ?? t.name));
      active.offeredSourceTools = new Set(body.tools.map((t) => t.function?.name ?? t.name));
    }
    if (allowed && Buffer.byteLength(JSON.stringify(body)) > availableBytes && Array.isArray(body.messages)) {
      const boundary = body.messages.findLastIndex(
        (m) => m.role === 'user' && JSON.stringify(m.content).includes(active.question),
      );
      const parts = (m) =>
        typeof m.content === 'string'
          ? [m.content]
          : Array.isArray(m.content)
            ? m.content.map((p) => p.text ?? '')
            : [];
      const currentContext = active.contextContent
        ? body.messages.findLastIndex(
            (m) => m.role === 'user' && parts(m).some((p) => p === active.contextContent),
          )
        : -1;
      const repeatedPolicy = body.messages.some(
        (m) =>
          ['system', 'developer'].includes(m.role) &&
          parts(m).some((p) => p.includes(DOCUMENT_OUTPUT_POLICY)),
      );
      const compactContext = (value) =>
        value === active.contextContent ? value.replace(DOCUMENT_OUTPUT_POLICY + '\n', '') : value;
      body.messages = body.messages.flatMap((m, index) => {
        // Earlier tool arguments and per-turn context may concern a different
        // workbook. Only the current question's injected rules apply. All
        // system/developer instructions and current-turn attempts stay intact.
        if (index < boundary && index !== currentContext && ['user', 'assistant', 'tool'].includes(m.role))
          return [];
        if (index === currentContext && repeatedPolicy) {
          return [
            {
              ...m,
              content:
                typeof m.content === 'string'
                  ? compactContext(m.content)
                  : m.content.map((p) =>
                      typeof p.text === 'string' ? {...p, text: compactContext(p.text)} : p,
                    ),
            },
          ];
        }
        if (m.role !== 'tool' || typeof m.content !== 'string') return [m];
        let result;
        try {
          result = JSON.parse(m.content);
        } catch {
          return [m];
        }
        if (!Array.isArray(result.matches) || !Array.isArray(result.sourceEvidence)) return [m];
        const {totalMatches, coverage, sourceEvidence, ledgerTotalMatches, truncated} = result;
        const matches = result.matches.map(
          ({turn, role, excerpt, sourceTurnId, sourceStatus, sourceLimits}) => ({
            turn,
            role,
            excerpt: Array.from(String(excerpt ?? '')).slice(0, 64).join(''),
            sourceTurnId,
            sourceStatus,
            sourceLimits,
          }),
        );
        return [
          {
            ...m,
            content: JSON.stringify({
              matches,
              totalMatches,
              coverage,
              sourceEvidence,
              ledgerTotalMatches,
              ledgerCoverage: result.ledgerCoverage,
              ledgerMatchesOmitted: result.ledgerMatches?.length ? true : undefined,
              excerptsAbbreviated: true,
              truncated,
            }),
          },
        ];
      });
    }
    if (allowed && Array.isArray(body.messages) && Buffer.byteLength(JSON.stringify(body)) > availableBytes) {
      const offered = active.offeredSourceTools;
      const citations = new Map();
      const excerpts = new Map();
      const ledgerScans = new Map();
      body.messages = body.messages.map((message) => {
        // Pi advertises its initially loaded tools in a separate catalogue.
        // Match that catalogue to the actual offered schemas. Leave permission
        // rules, developer instructions and every user message intact.
        if (offered && message.role === 'system' && typeof message.content === 'string') {
          const content = message.content.replace(/<tools>\n([\s\S]*?)\n<\/tools>/, (_, lines) =>
            '<tools>\n' + lines.split('\n').filter((line) => {
              const tool = line.match(/^- (\w+): /);
              return !tool || offered.has(tool[1]);
            }).join('\n') + '\n</tools>');
          return {...message, content};
        }
        if (message.role !== 'tool' || typeof message.content !== 'string') return message;
        let result;
        try { result = JSON.parse(message.content); } catch { return message; }
        if (!Array.isArray(result.sourceEvidence)) return message;
        if (result.ledgerCoverage) {
          const key = JSON.stringify(result.ledgerCoverage);
          const prior = ledgerScans.get(key);
          if (prior) {
            delete result.ledgerCoverage;
            result.ledgerCoverageFrom = prior;
          } else ledgerScans.set(key, message.tool_call_id);
        }
        if (Array.isArray(result.matches)) {
          result.matches = result.matches.map((match, index) => {
            if (!match.sourceTurnId || !match.excerpt) return match;
            const {excerpt, ...source} = match;
            const key = JSON.stringify([source.sourceTurnId, source.role, source.sourceStatus, source.sourceLimits, excerpt]);
            const earlier = excerpts.get(key);
            if (earlier) return {...source, excerptFrom: earlier};
            excerpts.set(key, [message.tool_call_id, index]);
            return match;
          });
        }
        // Share only the literal citation fields. Each hit keeps its own
        // source turn, permissions, limits, target items and retrievable handle.
        result.sourceEvidence = result.sourceEvidence.map((row) => {
          if (!row.handle || !row.id || !row.version || !row.materialId || !row.locator) return row;
          const {id, materialId, version, locator, filename, storedFilename, ...observation} = row;
          const identity = JSON.stringify([id, materialId, version, locator, filename, storedFilename]);
          const earlier = citations.get(identity);
          if (earlier) return {...observation, citationFromHandle: earlier};
          citations.set(identity, row.handle);
          return row;
        });
        return {...message, content: JSON.stringify(result)};
      });
    }
    const encoded = JSON.stringify(body);
    // A byte upper bound deliberately overestimates BPE input. Never charge
    // host-only details, credentials or an earlier, unfitted transcript.
    const toolNames = body.tools?.map((tool) => tool.function?.name ?? tool.name) ?? [];
    const input = Buffer.byteLength(encoded);
    const lane = side ? 'side' : 'business';
    const sizes = (body.messages ?? []).map((m) => [m.role, Buffer.byteLength(JSON.stringify(m))]);
    if (
      budget[lane] >= (side ? 4 : 12) ||
      input > (side ? 8000 : 32000) ||
      budget.input + input > 192000 ||
      budget.output + maxTokens > 24000
    ) {
      active.sourceBudgetStop={lane,input,sizes,toolNames,initialBytes,priorInput:budget.input,stage:options?.sourceStage ?? options?.sourceOperation ?? 'answer',
        digest:digest(encoded),perRequestExceeded:input>(side?8000:32000),totalInputExceeded:input+budget.input>192000,
        callLimitExceeded:budget[lane]>=(side?4:12),outputLimitExceeded:budget.output+maxTokens>24000,toolCount:body.tools?.length??0};
      active.receipt?.('pe_source_budget_stop', active.sourceBudgetStop);
      throw new Error(
        '来源核验模型预算耗尽（' +
          lane +
          '，请求输入上界 ' +
          input +
          '，累计输入 ' +
          budget.input +
          '，阶段 ' +
          (options?.sourceStage ?? options?.sourceOperation ?? 'answer') +
          '）',
      );
    }
    budget[lane]++;
    budget.input += input;
    budget.output += maxTokens;
    const modelRows = [];
    for (const message of body.messages ?? body.input ?? []) {
      if (message.role !== 'tool' || typeof message.content !== 'string') continue;
      try {
        const result = JSON.parse(message.content);
        modelRows.push(
          ...(result.sourceEvidence ?? (result.handle ? [result] : [])).map((row) => ({
            id: message.tool_call_id,
            row,
          })),
        );
      } catch {
        // fitContextMessages emits compact evidence as individual JSON lines.
        for (const line of message.content.split('\n')) {
          const start = line.indexOf('{');
          if (start < 0) continue;
          try {
            const row = JSON.parse(line.slice(start));
            if (row.handle) modelRows.push({id: message.tool_call_id, row});
          } catch {}
        }
      }
    }
    const visible = [];
    for (const row of active.sourceRows?.values() ?? []) {
      const evidence = row.evidence;
      const seen = modelRows.find(
        (m) => m.row.handle === evidence.handle && (m.id === row.callId || m.row.id === evidence.id),
      );
      visible.push({
        handle: evidence.handle,
        callId: seen?.id,
        handleVisible: !!seen,
        fields: seen
          ? Object.keys(evidence).filter(
              (k) => evidence[k] !== undefined && JSON.stringify(evidence[k]) === JSON.stringify(seen.row[k]),
            )
          : [],
      });
    }
    const request = {
      turnId: active.turnId,
      ordinal: budget.side + budget.business,
      lane,
      operation: options?.sourceOperation ?? options?.sourceStage ?? 'answer',
      model: model.id,
      digest: digest(encoded),
      planVisible: Boolean(
        active.planProjection &&
          (body.messages ?? []).some(
            (m) =>
              m.role === 'user' &&
              (typeof m.content === 'string'
                ? [m.content]
                : Array.isArray(m.content)
                  ? m.content.map((p) => p.text ?? '')
                  : []
              ).some((p) => p.includes(active.planProjection)),
          ),
      ),
      sentAt: Date.now(),
      toolNames, initialBytes, priorInput:budget.input-input, inputUpperBound: input,
      maxTokens,
      visible,
    };
    budget.requests.push(request);
    active.receipt?.('pe_source_request', request);
    return body;
  };
  return {...options, signal, maxTokens, maxRetries: 0, onPayload};
}

export async function readSourceLanguage(provider, model, operation, data, active) {
  if (!instructions[operation]) throw new Error('未知的来源核验请求');
  try {
    const stream = await provider(
      model,
      {
        systemPrompt: instructions[operation],
        tools: [],
        messages: [
          {role: 'user', content: [{type: 'text', text: JSON.stringify(data)}], timestamp: Date.now()},
        ],
      },
      {sourceOperation: operation, maxTokens: 1024, temperature: 0, signal: active.controller.signal},
    );
    const msg = await stream.result();
    if (
      active.controller.signal.aborted ||
      msg.stopReason !== 'stop' ||
      msg.content.some((p) => p.type === 'toolCall')
    )
      throw new Error(msg.errorMessage || '独立核读未生成完整结果');
    const json = msg.content
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('')
      .trim()
      .replace(/^```(?:json)?\s*|\s*```$/g, '');
    const result = JSON.parse(json);
    if (
      operation === 'request' &&
      Array.isArray(result.items) &&
      ['ordinary', 'history', 'mixed', 'pending'].includes(result.kind)
    )
      return result;
    if (
      operation === 'claims' &&
      result.claims?.length &&
      result.claims.every(
        (c) =>
          typeof c.quote === 'string' &&
          data.answer.includes(c.quote) &&
          ['historical', 'current', 'absence', 'financial', 'execution', 'scope', 'unknown'].includes(
            c.relation,
          ) &&
          ['positive', 'negative', 'uncertain'].includes(c.polarity) &&
          Array.isArray(c.fields),
      )
    )
      return result;
    throw new Error('独立核读返回未对齐的字段或陈述');
  } catch (error) {
    active.languageErrors ??= [];
    active.languageErrors.push({operation, reason: String(error.message).slice(0, 240)});
    return null;
  }
}

export function recordSourceModelCall(session, active, stream, context, options) {
  const side = Boolean(options?.sourceOperation);
  const kind = options?.sourceOperation ?? options?.sourceStage ?? 'answer';
  stream
    .result()
    .then((msg) => {
      const raw = (msg.content ?? [])
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('');
      if (!side)
        active.rawDrafts.push({kind, stopReason: msg.stopReason, textDigest: digest(raw), at: Date.now()});
      appendTurnMarker(session, 'pe_source_model', {
        turnId: active.turnId,
        kind,
        receivedAt: Date.now(),
        usage: msg.usage
          ? Object.fromEntries(
              ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens']
                .filter((k) => Number.isFinite(msg.usage[k]))
                .map((k) => [k, msg.usage[k]]),
            )
          : undefined,
        stopReason: msg.stopReason,
        textDigest: digest(raw),
      });
    })
    .catch(() => {});
}
