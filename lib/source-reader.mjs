import {searchErrorMessage} from './transcript-search-error.mjs';
import {createHash} from 'node:crypto';

export function exactSourceReader(req) {
  return (
    req?.headers?.['x-pe-source-links'] === 'exact-v1' ||
    new URL(req?.url ?? '/', 'http://localhost').searchParams.get('sourceLinks') === 'exact-v1'
  );
}

function textOnlyResult(output) {
  if (typeof output !== 'string') return output;
  let result;
  try {
    result = JSON.parse(output);
  } catch {
    return output;
  }
  if (!Array.isArray(result?.matches)) return output;
  const matches = result.matches.map((match) => {
    const labels = (match.citations ?? []).map((c) =>
      [c.filename ?? c.materialId, c.version ? 'v' + c.version : '版本未知', c.locator, c.id]
        .filter(Boolean)
        .join(' · '),
    );
    const excerpt = String(match.excerpt ?? '').slice(0, 480);
    return {
      turn: match.turn,
      role: match.role,
      excerpt:
        excerpt + (labels.length ? '\n来源信息（文本；此读者无法精确打开原版本） ' + labels.join('\n') : ''),
      citations: [],
      sourceStatus: match.sourceStatus,
    };
  });
  const view = {
    matches: [],
    totalMatches: result.totalMatches,
    ledgerTotalMatches: result.ledgerTotalMatches,
    displayTruncated: result.displayTruncated || result.coverage?.truncated || false,
  };
  for (const row of matches) {
    view.matches.push(row);
    if (JSON.stringify(view).length > 4000) {
      view.matches.pop();
      view.displayTruncated = true;
      break;
    }
  }
  return JSON.stringify(view);
}

function legacyTool(tool, sourceTurn = false) {
  if (tool.name === 'transcript_search' && tool.status === 'error') {
    const reason=searchErrorMessage(tool.output);
    return {...tool, detail: reason, output: reason, presentationError: reason, citations: []};
  }
  const output = textOnlyResult(tool.output);
  if (output === tool.output && !sourceTurn && tool.name !== 'transcript_search') return tool;
  const copy = {...tool, citations: [], output};
  if (tool.presentation?.payload?.citations || (sourceTurn && tool.presentation)) {
    delete copy.presentation;
  }
  return copy;
}

function exactRecord(record) {
  const binding = record?.sourceDelivery;
  if (!binding) return record;
  const text = record.text ?? '',
    ids = new Set((record.citations ?? []).filter((c) => c.version).map((c) => c.id));
  const digest = createHash('sha256').update(text).digest('hex');
  let end = 0;
  const valid =
    binding.schema === 1 &&
    digest === binding.textDigest &&
    Array.isArray(binding.occurrences) &&
    binding.occurrences.every((row) => {
      if (
        !Number.isInteger(row.start) ||
        !Number.isInteger(row.end) ||
        row.start < end ||
        row.end <= row.start ||
        row.end > text.length ||
        text.slice(row.start, row.end) !== row.text ||
        !ids.has(row.citationId)
      )
        return false;
      end = row.end;
      return true;
    });
  return {
    ...record,
    sourceDelivery: {schema: 1, textDigest: digest, occurrences: valid ? binding.occurrences : []},
    ...(valid ? {} : {citations: []}),
  };
}

function legacyRecord(record) {
  if (!record || typeof record !== 'object') return record;
  const source = !!record.sourceDelivery || record.tools?.some((tool) => tool.name === 'transcript_search');
  const out = source ? {...record, citations: []} : record;
  if (source) delete out.sourceDelivery;
  if (record.tools) return {...out, tools: record.tools.map((tool) => legacyTool(tool, source))};
  return out;
}

export function projectSourceEvent(event, exact) {
  if (!event) return event;
  const record = exact ? exactRecord : legacyRecord;
  if (event.type === 'snapshot') return {...event, messages: (event.messages ?? []).map(record)};
  if (event.type === 'turn.delivered') return {...event, record: record(event.record)};
  if (event.type === 'CUSTOM' && event.name === 'pe.turn_delivery')
    return {...event, value: record(event.value)};
  // Older AG-UI clients render only the name and args during execution.
  // This optional display label describes the input; END/RESULT alone
  // decide success, cancellation or failure. Call ID, args and cursor persist.
  if (event.type === 'TOOL_CALL_START' && event.argumentIssue && !exact) {
    return {...event, toolCallName:event.toolCallName+'（'+event.argumentIssue+'）'};
  }
  if (exact) return event;
  if (event.type === 'tool.completed' || event.type === 'tool.updated')
    return legacyTool(event, event.sourceTurn === true);
  if (event.type === 'CUSTOM' && event.name === 'pi.tool_progress')
    return {...event, value: {...event.value, content: textOnlyResult(event.value?.content)}};
  if (event.type === 'TOOL_CALL_RESULT') return {...event, content: textOnlyResult(event.content)};
  return event;
}
