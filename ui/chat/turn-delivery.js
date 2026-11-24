/** Reconcile the persisted user turn on both chat transports. */
const terminal = new Set(['completed', 'partial', 'failed', 'cancelled']);

export function wasDelivered(messages, turnId) {
  return Boolean(turnId && messages.some(message =>
    message.role === 'assistant' && message.turnId === turnId && terminal.has(message.status)));
}

export function startTurn(state, { turnId, question, startedAt }) {
  if (!turnId || state.live.turnId === turnId || wasDelivered(state.messages, turnId)) return false;
  const publicQuestion = question?.replace(/\n\n\[已上传资料\][\s\S]*$/, '');
  const existing = state.messages.find(message => message.role === 'user' && message.turnId === turnId);
  const user = existing ?? state.messages.find(message => message.role === 'user' && message.pendingDelivery && !message.turnId && message.text === publicQuestion);
  state.messages = state.messages.filter(item => !(item.role === 'assistant' && item.status === 'pending' && item.turnId === turnId));
  if (user) user.turnId = turnId;
  else if (publicQuestion) {
    state.messages.push({ role: 'user', turnId, text: publicQuestion });
  }
  state.live = { turnId, text: '', tools: [], startedAt: Date.parse(startedAt) || Date.now() };
  state.streaming = true;
  return true;
}

export function receiveDelivery(state, record) {
  if (!record?.turnId || !terminal.has(record.status) || wasDelivered(state.messages, record.turnId)) return false;
  const active = state.live.turnId;
  const tools = !active || active === record.turnId ? state.live.tools : [];
  const message = {
    role: 'assistant', turnId: record.turnId, text: record.text || '',
    citations: record.citations || [], status: record.status, reason: record.reason,
    turnStartedAt: record.turnStartedAt ?? (active === record.turnId ? state.live.startedAt : undefined),
    finishedAt: record.finishedAt, tools: tools.map(tool => tool.status === 'running' ? { ...tool, status: 'error' } : tool),
    ...(record.analysisState ? {
      analysisState: record.analysisState, analysisStatePath: record.analysisStatePath,
      analysisStatePendingMerge: record.analysisStatePendingMerge === true,
    } : {}),
  };
  state.messages = state.messages.filter(item => !(item.role === 'assistant' && item.turnId === record.turnId && item.status === 'pending'));
  const userAt = state.messages.findIndex(item => item.role === 'user' && item.turnId === record.turnId);
  if (userAt >= 0) state.messages.splice(userAt + 1, 0, message);
  else state.messages.push(message);
  if (!active || active === record.turnId) {
    state.streaming = false;
    state.live = { text: '', tools: [], startedAt: 0 };
  }
  return true;
}

export function applyTurnSnapshot(state, snapshot, { preserveLive = false, forceStopped = false } = {}) {
  const messages = snapshot.messages || [];
  // A poll issued before delivery or the opening frame of an old connection
  // may still contain a pending row (or no row) for this turn.
  const finals = new Set(messages.filter(m => m.role === 'assistant' && terminal.has(m.status)).map(m => m.turnId));
  if (state.messages.some(m => m.role === 'assistant' && m.turnId && terminal.has(m.status) && !finals.has(m.turnId))) return false;
  const active = snapshot.activeTurnId;
  const live = state.live;
  if (live.turnId && live.turnId !== active && !finals.has(live.turnId)) return false;
  const pending = messages.find(m => m.role === 'assistant' && m.turnId === active && m.status === 'pending');
  state.messages = pending ? messages.filter(m => m !== pending) : messages;
  state.streaming = Boolean(active || (snapshot.streaming && !forceStopped));
  if (active) {
    const tools = new Map((pending?.tools || []).map(tool => [tool.id, tool]));
    if (live.turnId === active) {
      for (const tool of live.tools) {
        if (!tools.has(tool.id) || tools.get(tool.id).status === 'running') tools.set(tool.id, tool);
      }
    }
    state.live = { turnId: active, text: '', tools: [...tools.values()], startedAt: new Date(pending?.turnStartedAt).getTime() || live.startedAt || Date.now() };
  } else if (!state.streaming || !preserveLive) {
    state.live = { text: '', tools: [], startedAt: state.streaming ? Date.now() : 0 };
  }
  return true;
}
