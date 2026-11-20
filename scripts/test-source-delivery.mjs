import assert from 'node:assert/strict';
import test from 'node:test';
import {runWithPostAnswer} from '../server/agent/post-answer.mjs';
import {createTranscriptSearchTool} from '../lib/transcript-search-tool.mjs';
import {sourceObservations} from '../server/agent/source-observations.mjs';
import {evaluateSourceDraft, recoverSourceFields} from '../server/agent/source-delivery.mjs';
import {lintLedgerAnswer} from '../lib/answer-lint.mjs';
import {sourceModelOptions} from '../server/agent/source-provider.mjs';
import {prepareSourcePlan, assertionQuestion, modelPlan, digest} from '../server/agent/source-plan.mjs';
import {projectSourceEvent} from '../lib/source-reader.mjs';
import {transcriptMessages} from '../server/agent/snapshot.mjs';

const materialId = '06b49121-555f-44c3-8604-9346978911cc';
const filename = 'Acceptance13.xlsx';
const original = {
  id: 'cite:' + materialId + ':v1:Model!B2',
  materialId,
  version: 1,
  locator: 'Model!B2',
  filename,
  value: 317,
};
const sourceText = '字面常量的来源是 [Acceptance13.xlsx]Model!B2。';
const report =
  '第1轮回答引用的出处是 [Acceptance13.xlsx]Model!B2（材料 ' +
  materialId +
  '，版本 v1）。\n\n命中该条 citation 带的完整引用 ID 为 ' +
  original.id;
const query = '字面常量';
const query2 = '折旧政策';
const history = '请查第1轮“字面常量”的正式答文出处，给出单元格、材料版本和完整引用 ID。';
const multiple =
  '请在第1轮分别查询两个词：“字面常量”，“折旧政策”。分别说明两个词的检索结果和历史出处，列出命中的完整引用 ID。';
const exists =
  '请查第1轮“折旧政策”是否引用过 Acceptance13.xlsx；仅当引用过才查同一材料当前版本，否则只报告未命中。';

async function run(question, searches, text, budgetStop = false, readSourceLanguage) {
  const rows = [];
  const events = new Set();
  const prior = [
    {role: 'user', content: '查看工作簿'},
    {
      role: 'assistant',
      content: sourceText,
      sourceTurnId: 'T1',
      sourceStatus: 'completed',
      citations: [original],
    },
  ];
  const tool = createTranscriptSearchTool({getMessages: () => prior});
  const markersAtCall = [];
  let prompts = 0;
  const session = {
    messages: [],
    sessionId: 'session',
    sessionManager: {appendCustomEntry: (type, data) => rows.push({type, data})},
    subscribe(fn) {
      events.add(fn);
      return () => events.delete(fn);
    },
    async prompt() {
      if (!prompts++) {
        for (const [i, args] of searches.entries()) {
          const key = 'call-' + i;
          markersAtCall.push(rows.map((r) => r.type));
          const result = await tool.execute(key, args);
          this.messages.push(
            {role: 'assistant', content: [{type: 'toolCall', id: key, name: tool.name, arguments: args}]},
            {role: 'toolResult', toolName: tool.name, toolCallId: key, isError: !!result.isError, ...result},
          );
        }
      }
      if (budgetStop === true || budgetStop === prompts) {
        entry.activeTurn.sourceBudgetStop = {lane: 'business'};
        this.messages.push({
          role: 'assistant',
          content: [],
          stopReason: 'error',
          errorMessage: '来源核验模型预算耗尽',
        });
      } else
        this.messages.push({
          role: 'assistant',
          content: Array.isArray(text) ? text[Math.min(prompts, text.length) - 1] : text,
          stopReason: 'stop',
          timestamp: Date.now(),
        });
    },
  };
  const entry = {session, id: 'session', readSourceLanguage};
  const record = await runWithPostAnswer(entry, question);
  return {record, rows, markersAtCall, session};
}

test('two independently requested searches remain separate without any tool calls', async () => {
  const {record} = await run(multiple, [], '已经整理完毕。');
  assert.equal(record.status, 'failed');
  assert.match(record.reason, /折旧政策/);
  assert.equal(record.text, '');
});

test('single query recovered, independently visible ID retained, source turn preserved into next search', async () => {
  const {record, rows, markersAtCall, session} = await run(history, [{}, {query, turn: 1}], report);
  assert.ok(markersAtCall.every((types) => types.includes('pe_source_plan')));
  assert.deepEqual(
    [record.status, record.text, record.citations.map((c) => c.id)],
    ['completed', report, [original.id]],
  );
  assert.equal(record.sourceDelivery.occurrences[0].citationId, original.id);
  assert.equal(rows.filter((r) => r.type === 'pe_turn_delivery').length, 1);
  const next = await createTranscriptSearchTool({getMessages: () => transcriptMessages(session, {})}).execute(
    'T3',
    {query: original.id},
  );
  assert.ok(
    next.details.matches.some((m) => m.sourceTurnId === record.turnId && m.sourceStatus === 'completed'),
  );
});
test('budget recovery publishes one verified unique source and separately records host authorship', async () => {
  const result = await run(history, [{query, turn: 1}], '', true);
  assert.equal(result.record.status, 'completed', result.record.reason);
  assert.equal(result.record.citations[0].id, original.id);
  assert.ok(result.record.text.includes(original.id));
  assert.ok(result.rows.some((r) => r.type === 'pe_source_host_repair'));
  const missing = await run(history, [], '', true);
  assert.equal(missing.record.status, 'failed');
  assert.ok(!missing.rows.some((r) => r.type === 'pe_source_host_repair'));
});

test('the model cannot add a new unresolved request after all requested source fields are delivered', async () => {
  const {record, rows} = await run(
    history,
    [{query, turn: 1}],
    report + '。\n\n未核验：今天的工作副本是否仍是 v1。',
  );
  assert.equal(record.status, 'completed', record.reason);
  assert.ok(record.text.includes(original.id));
  assert.ok(!record.text.includes('工作副本'));
  assert.ok(rows.some((r) => r.data.kind === 'requestedFieldsReverified'));
  const missing = await run(multiple, [{query, turn: 1}], report + '。\n\n未核验：第二项。');
  assert.equal(missing.record.status, 'partial');
  assert.ok(!missing.rows.some((r) => r.data.kind === 'requestedFieldsReverified'));
});

test('an empty correction can recover the checked source without publishing a replaced draft', async () => {
  const first = report + '。\n\n当前材料版本为 v5。';
  const second = '第1轮正式回答引用的是 [Else.xlsx]Model!A3。';
  const result = await run(history, [{query, turn: 1}], [first, second]);
  assert.equal(result.record.status, 'completed', result.record.reason);
  assert.ok(result.record.text.includes(original.id));
  assert.ok(!result.record.text.includes('v5') && !result.record.text.includes('Else.xlsx'));
  assert.equal(result.rows.filter((r) => r.type === 'pe_source_host_repair').length, 1);
});

test('a verified result for X does not satisfy the missing query Y', async () => {
  const {record} = await run(multiple, [{query, turn: 1}], report);
  assert.deepEqual([record.status, record.text], ['partial', report]);
  assert.match(record.reason, /折旧政策/);
});
test('requested actual source for B cannot deliver A', async () => {
  const {record} = await run(
    '请在第1轮查询“字面常量”。这次只看工作簿 Budget13.xlsx 的历史出处，请给出单元格、材料版本和完整引用 ID。',
    [{query, turn: 1}],
    report,
  );
  assert.deepEqual([record.status, record.text, record.citations], ['failed', '', []]);
  assert.match(record.reason, /Budget13.xlsx/);
});
test('exhaustive empty discharges a conditional current read; unexecuted search cannot', async () => {
  const text = '第1轮“折旧政策”未命中。';
  const {record} = await run(exists, [{query: query2, turn: 1}], text);
  assert.deepEqual([record.status, record.text], ['completed', text]);
  assert.ok(record.sourceDelivery.items.some((item) => item.state === 'notApplicable'));
  const missing = await run(exists, [], text);
  assert.equal(missing.record.status, 'failed');
});
test('ordinary answer remains deliverable without a historical query', async () => {
  const {record} = await run('用一句话解释折旧。', [], '折旧是对资产可折旧金额的系统分摊。');
  assert.equal(record.status, 'completed');
  const plan = await prepareSourcePlan(
    {turnId: 'T', question: '请给出两个单元格的出处。'},
    {
      id: 'session',
      session: {},
      readSourceLanguage: () => {
        throw Error('ordinary answer routed to historical reader');
      },
    },
  );
  assert.equal(plan.route, 'ordinary');
});

function observation(name, id, args, details, failed = false) {
  return {name, id, args, success: !failed, result: {details, isError: failed}};
}
const sourcePlan = {
  rev: 1,
  gaps: [],
  items: [
    {id: 'X', action: 'search', query, turn: 1, operation: 'exists', needsLocator: true, fields: ['id']},
  ],
};
const formalHit = {
  role: 'assistant',
  turn: 1,
  sourceTurnId: 'T1',
  sourceStatus: 'completed',
  citations: [original],
};
const activeSearch = observation(
  'transcript_search',
  'search-X',
  {query, turn: 1},
  {matches: [formalHit], totalMatches: 1, coverage: {turnsScanned: 1, turns: [1], truncated: false}},
);
const current = {
  ...original,
  id: original.id.replace(':v1:', ':v2:'),
  version: 2,
  value: 942,
  basis_type: 'unknown',
};

test('observe terminal failure, per-cell partial, duplicate observations and identity conflicts before deduplication', () => {
  const row = observation('workbook_query', 'read-2', {}, {citations: [current]});
  assert.equal(sourceObservations(sourcePlan, [row], [{...row, success: false}]).witnesses.length, 0);
  assert.equal(sourceObservations(sourcePlan, [row], [row]).witnesses.length, 1);
  const mixed = observation(
    'workbook_query',
    'read-2',
    {},
    {
      partial: true,
      materialId,
      version: 2,
      successfulCitationIds: [current.id],
      cells: [{locator: 'Model!B2', value: 942}],
      citations: [current, {...current, id: 'unchecked', locator: 'Model!A1'}],
    },
  );
  assert.deepEqual(
    sourceObservations(sourcePlan, [mixed], []).witnesses.map((w) => w.citation.id),
    [current.id],
  );
  const conflicting = {...current, id: original.id};
  const shadow = observation('transcript_search', activeSearch.id, activeSearch.args, {
    matches: [{...formalHit, citations: [conflicting]}],
  });
  const found = sourceObservations(sourcePlan, [activeSearch], [shadow]);
  assert.deepEqual(found.badIds, [original.id]);
  assert.equal(found.witnesses.length, 0);
});
test('R2 one turn proves X, exhaustive Y zero, and current read with independent positions', async () => {
  const question =
    '请在第1轮分别查“字面常量”和“折旧政策”是否引用 Acceptance13.xlsx。逐项说有无，命中给原格、版本和完整 ID。如果第一项有，再给这本书现在同一格的坐标、版本和读数。';
  const plan = await prepareSourcePlan({question, turnId: 'T2'}, {session: {}, id: 's'});
  assert.deepEqual(
    plan.items.map((i) => i.query ?? i.action),
    [query, query2, 'read'],
  );
  const searchY = observation(
    'transcript_search',
    'search-Y',
    {query: query2, turn: 1},
    {matches: [], totalMatches: 0, coverage: {turns: [1], turnsScanned: 1, truncated: false}},
  );
  const direct = observation('workbook_query', 'read-N', {}, {citations: [current]});
  const historical = '第1轮“字面常量”引用的是 [Acceptance13.xlsx]Model!B2（版本 v1）。';
  const idNote = '完整 citation.id：' + original.id;
  const zero = '第1轮“折旧政策”未命中。';
  const read = '本次读取同一材料 v2 的 Model!B2，值为 942。';
  const text = [historical, idNote, zero, read].join('\n\n');
  function assess(calls, body = text, head = 2) {
    const observations = sourceObservations(plan, calls, []);
    const meaning = {
      claims: [
        {quote: historical, relation: 'historical', polarity: 'positive'},
        {quote: idNote, relation: 'historical', polarity: 'positive'},
        {quote: read, relation: 'current', polarity: 'positive'},
      ],
    };
    return evaluateSourceDraft({
      text: body,
      question,
      plan,
      observations,
      currentVersions: {[materialId]: head},
      lint: (part, pool) =>
        lintLedgerAnswer(
          part,
          {},
          {question: assertionQuestion(question, plan), citations: pool, locatorCitations: pool},
        ),
      meaning,
    });
  }
  const verified = assess([activeSearch, searchY, direct]);
  assert.deepEqual([verified.status, verified.text], ['completed', text], JSON.stringify(verified));
  assert.deepEqual(
    verified.sourceDelivery.occurrences.map((r) => [text.slice(r.start, r.end), r.citationId]),
    [
      ['[Acceptance13.xlsx]Model!B2', original.id],
      ['Model!B2', current.id],
    ],
  );
  assert.equal(assess([searchY, direct, activeSearch]).status, 'completed');
  for (const receipt of [assess([activeSearch, direct]), assess([activeSearch, searchY, direct], text, 3)]) {
    assert.equal(receipt.status, 'partial');
    assert.ok(receipt.text.includes(original.id));
  }
  const truncated = structuredClone(searchY);
  truncated.result.details.coverage.truncated = true;
  assert.equal(assess([truncated, direct, activeSearch]).status, 'partial');
  const old = projectSourceEvent({type: 'turn.delivered', record: verified}, false).record;
  assert.deepEqual([old.text, old.citations], [text, []]);
  const damaged = projectSourceEvent(
    {type: 'turn.delivered', record: {...verified, text: 'changed'}},
    true,
  ).record;
  assert.deepEqual([damaged.citations, damaged.sourceDelivery.occurrences], [[], []]);
});
test('verified field values and observed search counts survive a different field layout', () => {
  function decide(note, fields, relation = 'historical', extraCalls = []) {
    const text = report + '\n\n' + note;
    const observations = sourceObservations(sourcePlan, [activeSearch, ...extraCalls], []);
    return evaluateSourceDraft({
      text,
      question: history,
      plan: sourcePlan,
      observations,
      currentVersions: {[materialId]: 2},
      meaning: {
        claims: [
          ...report
            .split('\n\n')
            .map((quote) => ({quote, relation: 'historical', polarity: 'positive', fields: []})),
          {quote: note, relation, polarity: 'positive', fields},
        ],
      },
    });
  }
  const joint = '材料 ID 和版本：' + materialId + '，v1';
  const fields = [
    {name: 'materialId', literal: materialId},
    {name: 'version', literal: 'v1'},
  ];
  assert.equal(decide(joint, fields).status, 'completed');
  assert.equal(decide(joint.replace('v1', 'v2'), fields).status, 'partial');
  const zero = '本次工作簿实读 0 次。';
  const evidence = [{name: 'directReadCount', literal: '0', value: 0}];
  assert.equal(decide(zero, evidence, 'execution').status, 'completed');
  assert.equal(decide(zero, evidence, 'execution', [observation('read', 'other', {}, {})]).status, 'partial');
  assert.equal(decide(zero.replace('0', '7'), evidence, 'execution').status, 'partial');
});

test('a research receipt proves only the audited text and cannot complete a missing source', () => {
  const historical = report.split('\n\n')[0],
    financial = '本轮报告依据 Model!B2，值为 942。';
  const plan = {
    ...sourcePlan,
    items: [
      {...sourcePlan.items[0], fields: []},
      {id: 'report', action: 'review', requiresSave: true},
    ],
  };
  const read = observation('workbook_query', 'report-read', {query: 'Model!B2'}, {citations: [current]});
  const text = [historical, financial].join('\n\n');
  const meaning = {
    claims: [
      {quote: historical, relation: 'historical', polarity: 'positive'},
      {quote: financial, relation: 'financial', polarity: 'positive'},
    ],
  };
  const decide = (calls, review) =>
    evaluateSourceDraft({
      text,
      question: history,
      plan,
      meaning,
      review,
      observations: sourceObservations(plan, calls, []),
      currentVersions: {[materialId]: 2},
    });
  const review = {digest: digest(text), written: true, pending: [], openFindings: []};
  assert.equal(decide([activeSearch, read], review).status, 'completed');
  assert.equal(decide([read], review).status, 'partial');
  for (const wrong of [
    {written: false},
    {digest: digest(financial)},
    {openFindings: [{excerpt: '值为 942'}]},
  ]) {
    const result = decide([activeSearch, read], {...review, ...wrong});
    assert.equal(result.status, 'partial');
    assert.ok(!result.text.includes('942'));
  }
});

test('the first projection reserves the omission marker while preserving full original results', async () => {
  const rows = [];
  for (let i = 1; i <= 60; i++) {
    const materialId = 'synthetic-' + i;
    rows.push(
      {role: 'user', content: '第' + i + '项'},
      {
        role: 'assistant',
        content: 'sample ' + '材料正文'.repeat(180),
        sourceTurnId: 'T' + i,
        sourceStatus: 'partial',
        sourceLimits: ['仅回答已核实的出处'],
        citations: [
          {
            id: 'cite:' + materialId + ':v1:Model!B2',
            materialId,
            filename: materialId + '.xlsx',
            version: 1,
            locator: 'Model!B2',
          },
        ],
      },
    );
  }
  const active = {
    admitted: true,
    plan: {route: 'history', items: [{id: 'X', action: 'search', query: 'sample'}]},
  };
  const result = await createTranscriptSearchTool({getMessages: () => rows, getActive: () => active}).execute(
    'large',
    {query: 'sample', limit: 50},
  );
  assert.ok(result.content[0].text.length <= 12000);
  assert.equal(JSON.parse(result.content[0].text).sourceEvidenceOmitted, true);
  assert.equal(result.details.sourceEvidence.length, 50);
  assert.equal(result.details.totalMatches, 60);
});

test('the provider receipt distinguishes final evidence fields, a handle-only projection and an omitted row', async () => {
  const active = {
    turnId: 'T2',
    admitted: true,
    controller: new AbortController(),
    plan: {...sourcePlan, route: 'history', branch: 'b'},
    question: history,
    rawDrafts: [],
  };
  active.planProjection = modelPlan(active.plan);
  const tool = createTranscriptSearchTool({
    getMessages: () => [
      {role: 'user', content: '请看工作簿'},
      {...formalHit, content: sourceText},
    ],
    getActive: () => active,
  });
  const result = await tool.execute('X', {query, turn: 1});
  const row = result.details.sourceEvidence[0];
  assert.deepEqual(row.itemIds, ['X']);
  const body = (value) => ({
    tools: [],
    messages: [
      {role: 'user', content: active.planProjection},
      {role: 'tool', tool_call_id: 'X', content: JSON.stringify({sourceEvidence: value})},
    ],
  });
  const invoke = async (value) => {
    const o = sourceModelOptions(active, {id: 'fixture', maxTokens: 1024}, {}, null);
    await o.onPayload(body(value));
    return active.budget.requests.at(-1);
  };
  assert.ok((await invoke([row])).visible[0].fields.includes('id'));
  assert.deepEqual((await invoke([{handle: row.handle}])).visible[0].fields, ['handle']);
  assert.equal((await invoke([])).visible[0].handleVisible, false);
  const targeted = await tool.execute('follow', {query, handle: row.handle});
  assert.equal(targeted.details.sourceEvidence[0].id, original.id);
  active.plan = {...active.plan, rev: 2};
  assert.equal((await tool.execute('stale', {query, handle: row.handle})).isError, true);
  active.controller.abort();
  assert.throws(() => sourceModelOptions(active, {id: 'fixture'}, {}, null));
});

test('visible negative historical assertion and a new corporate claim cannot inherit a true source', async () => {
  for (const text of [
    report.replace('出处是', '出处并非'),
    report.replace('（材料', '，而且董事会已经批准收购（材料'),
  ]) {
    const {record} = await run(history, [{query, turn: 1}], text);
    assert.notEqual(record.status, 'completed');
    assert.ok(!record.text.includes('董事会') && !record.text.includes('并非'));
  }
});

test('an earlier assistant reply binds the requested fields even without a tool or a proposed search term', async () => {
  const definition = '折旧是将可折旧金额在资产使用寿命内进行分摊。';
  for (const subject of ['第1轮正式回答', '第一条答复', '第一个回复']) {
    const seen = [];
    const q = '你发给我的' + subject + '用了哪本工作簿的哪个单元格？请给出完整 citation.id。';
    const {record, rows} = await run(q, [], definition, false, (op) => {
      seen.push(op);
      return op === 'request' ? {kind: 'history', items: []} : null;
    });
    assert.ok(seen.includes('request'), subject);
    const plan = rows.find((r) => r.type === 'pe_source_plan').data;
    assert.deepEqual(
      plan.items.map((i) => [i.action, i.turn, i.fields]),
      [['search', 1, ['id', 'filename']]],
    );
    assert.deepEqual([record.status, record.text], ['failed', '']);
  }
  assert.equal((await run('请用一句话说明什么是折旧。', [], definition)).record.status, 'completed');
});

test('searching a workbook and auditing the conversation keep their original checks', async () => {
  for (const question of ['查一下模型', '自查前文']) {
    const entry = {session: {messages: [{role: 'assistant'}]}};
    const plan = await prepareSourcePlan({question, turnId: 'turn'}, entry);
    assert.equal(plan.route, 'ordinary');
    assert.deepEqual(plan.items, []);
  }
});

test('a checked search heading governs field rows; independently stated current facts keep their time', () => {
  const heading = '第1轮命中1处，出处如下：';
  const lines = [
    '- 工作簿：' + filename + '（材料ID ' + materialId + '，v1）',
    '- 单元格：Model!B2',
    '- 材料版本：v1',
    '- 完整引用 ID：' + original.id,
  ];
  const text = heading + '\n\n' + lines.join('\n') + '\n\n未核验：无。';
  const claims = [
    {
      quote: heading,
      relation: 'execution',
      polarity: 'positive',
      fields: [
        {name: 'scannedTurn', literal: '第1轮', value: 1},
        {name: 'ledgerMatches', literal: '1处', value: 1},
      ],
    },
    ...lines.map((quote, i) => ({
      quote,
      relation: 'current',
      polarity: 'positive',
      fields: [
        {
          name: ['filename', 'locator', 'version', 'id'][i],
          literal: [filename, 'Model!B2', 'v1', original.id][i],
        },
      ],
    })),
  ];
  const plan = {...sourcePlan, route: 'history'};
  const found = structuredClone(activeSearch);
  found.result.details.ledgerTotalMatches = 0;
  const evaluate = (s, meaning = claims) =>
    evaluateSourceDraft({
      text: s,
      question: history,
      plan,
      observations: sourceObservations(plan, [found], []),
      meaning: {claims: meaning},
      currentVersions: {[materialId]: 2},
    });
  const good = evaluate(text);
  assert.deepEqual(
    [good.status, good.text, good.citations.map((c) => c.id)],
    ['completed', text, [original.id]],
  );
  const prose = (line) => line.replace('出处如下：', '出处如下。').replace(/^- (.*?)：/, '$1为');
  const paragraph = text.split('\n').map(prose).join('\n');
  const paragraphReceipt = evaluate(
    paragraph,
    claims.map((claim) => ({...claim, quote: prose(claim.quote)})),
  );
  assert.equal(paragraphReceipt.status, 'completed');
  assert.equal(paragraphReceipt.text, paragraph);
  assert.deepEqual(
    paragraphReceipt.sourceDelivery.occurrences.map((r) => paragraph.slice(r.start, r.end)),
    ['Model!B2'],
  );
  for (const extra of [
    '当前工作簿版本为 v1。',
    '- 当前材料版本：v1',
    '- 另一个格：Model!Z999',
    '- 材料版本：v2',
    '- 不是这个版本。',
  ]) {
    const scored = evaluate(text + '\n' + extra, [
      ...claims,
      {quote: extra, polarity: 'positive', relation: 'historical', fields: []},
    ]);
    assert.ok(!scored.text.includes(extra), extra);
    assert.equal(scored.status, 'partial', extra);
  }
  assert.ok(!evaluate(text.replace('命中1处', '命中2处')).text.includes('命中2处'));
});

test('budget stop rechecks the retained prose of multiple obligations and names a remaining missing target', async () => {
  const bad = report + '。\n\n当前材料的 [Unknown.xlsx]Model!C9 版本为 v9。';
  const both = multiple.replaceAll(query2, '来源');
  const {record, rows} = await run(
    both,
    [
      {query, turn: 1},
      {query: '来源', turn: 1},
    ],
    bad,
    2,
  );
  assert.equal(record.status, 'completed', record.reason);
  assert.ok(record.text.includes(original.id) && !record.text.includes('v9'));
  assert.ok(rows.some((r) => r.type === 'pe_source_host_repair'));
  const earlyStop = await run(multiple, [{query, turn: 1}], '', true);
  assert.equal(earlyStop.record.status, 'partial', earlyStop.record.reason);
  assert.ok(earlyStop.record.text.includes(original.id));
  assert.match(earlyStop.record.reason, /折旧政策/);
  const missing = await run(multiple, [{query, turn: 1}], bad, 2);
  assert.equal(missing.record.status, 'partial');
  assert.match(missing.record.reason, /折旧政策/);
});

test('read-only scoped research can start its authorized searches inside the first physical input limit', async () => {
  const question =
    '请查第1轮“字面常量”的正式出处，列出工作簿、原格、版本和完整引用 ID。再就同一份材料做一个只读的估值分析：本轮打开现在的同一格，给出其当前值与版本，并说明仅凭这一个值能否判断企业估值。只在聊天答复。';
  const plan = await prepareSourcePlan({turnId: 'R', question}, {id: 's', session: {}});
  const active = {question, plan, controller: new AbortController(), planProjection: modelPlan(plan)};
  const body = {
    messages: [
      {role: 'system', content: '权限及研究规则。'},
      {role: 'user', content: active.planProjection},
      {role: 'user', content: question},
    ],
    tools: ['transcript_search', 'workbook_query', 'web_fetch', 'edit'].map((name) => ({
      type: 'function',
      function: {name, description: name === 'edit' ? 'x'.repeat(71500) : name},
    })),
  };
  const fitted = await sourceModelOptions(active, {id: 'fixture'}, {sourceStage: 'research-draft'}).onPayload(
    body,
  );
  assert.deepEqual(
    fitted.tools.map((t) => t.function.name),
    ['transcript_search', 'workbook_query'],
  );
  assert.ok(
    fitted.messages.some((m) => m.content === question) &&
      fitted.messages.some((m) => m.content === active.planProjection),
  );
  assert.ok(active.budget.input <= 32000);
});

test('history tool error is readable by a versionless client without reflecting supplied arguments', () => {
  const msg =
    'Validation failed for tool "transcript_search":\n  - query: must have required properties query\n\nReceived arguments:\n{"token":"not-for-display"}';
  const tool = {id: 'invalid', name: 'transcript_search', status: 'error', detail: '{}', output: msg};
  for (const row of [
    projectSourceEvent({type: 'snapshot', messages: [{tools: [tool]}]}, false).messages[0].tools[0],
    projectSourceEvent({type: 'tool.completed', ...tool}, false),
  ]) {
    assert.match(row.presentationError ?? row.detail, /query/);
    assert.ok(!JSON.stringify(row).includes('not-for-display'));
    assert.equal(row.id, tool.id);
    assert.equal(row.status, 'error');
  }
});

test('interrupted mixed requests preserve signed-version evidence and keep the unaudited explanation open', () => {
  const plan = {
    ...sourcePlan,
    route: 'mixed',
    sourceOnlyRead: true,
    research: true,
    items: [
      {...sourcePlan.items[0], operation: 'source'},
      {id: 'now', action: 'read', fields: ['version', 'locator', 'value']},
      {id: 'research', action: 'review', fields: ['reviewedAnswer']},
    ],
  };
  const read = observation('workbook_query', 'cell', {query: 'Model!B2'}, {citations: [current]});
  const observations = sourceObservations(plan, [activeSearch, read], []);
  function recover(head) {
    const currentVersions = {[materialId]: head};
    const text = recoverSourceFields(plan, observations, currentVersions);
    const result = evaluateSourceDraft({text, question: history, plan, observations, currentVersions});
    assert.equal(result.status, 'partial', result.reason);
    assert.equal(result.text, text);
    assert.match(result.reason, /研究审校/);
    assert.ok(result.text.includes(original.id));
    return result;
  }
  assert.deepEqual(
    recover(2).citations.map((c) => c.version),
    [1, 2],
  );
  assert.deepEqual(
    recover(3).citations.map((c) => c.version),
    [1],
  );
  const currentVersions = {[materialId]: 2};
  const evidence = recoverSourceFields(plan, observations, currentVersions);
  const note = '单一工作簿中的读数不足以判断企业估值。';
  const text = evidence + '\n\n' + note;
  const meaning = {
    claims: [
      ...evidence
        .split('\n\n')
        .map((quote) => ({
          quote,
          relation: quote.startsWith('当前') ? 'current' : 'historical',
          polarity: 'positive',
          fields: [],
        })),
      {quote: note, relation: 'financial', polarity: 'positive', fields: []},
    ],
  };
  const review = {digest: digest(text), openFindings: []};
  const evaluate = (overrides) =>
    evaluateSourceDraft({
      text,
      question: history,
      plan,
      observations,
      currentVersions,
      meaning,
      review,
      ...overrides,
    });
  assert.equal(evaluate({}).status, 'completed', JSON.stringify(evaluate({}).rejectedChecks));
  for (const overrides of [
    {review: {}},
    {currentVersions: {[materialId]: 3}},
    {review: {...review, openFindings: [{excerpt: note}]}},
  ]) {
    assert.ok(!evaluate(overrides).text.includes(note));
  }
});
