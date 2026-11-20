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

test('a formatting instruction can refer to this answer even when the session has prior answers', async () => {
  for (const messages of [[], [{role: 'assistant', content: sourceText}]]) {
    const entry = {session: {messages}, readSourceLanguage: async () => ({kind: 'ordinary', items: []})};
    for (const place of ['正文中', '回答中', '回复里']) {
      for (const definition of ['解释“单元格”的含义', '解释什么是单元格']) {
        const question = '请在' + place + '用一句话' + definition + '。';
        assert.equal((await prepareSourcePlan({question}, entry)).route, 'ordinary', question);
      }
    }
    const question = '请在回答中列出第一条答复引用的工作簿、单元格与完整引用 ID。';
    assert.equal((await prepareSourcePlan({question}, entry)).items[0].turn, 1);
  }
});

test('a history heading scopes neutral fields while keeping a separate present-tense predicate on its row', () => {
  const heading = '第1轮命中1处，出处如下：';
  const location = '- 单元格：Model!B2';
  const id = '- 完整引用 ID：' + original.id;
  const plan = {...sourcePlan, route: 'history'};
  for (const row of ['- 材料版本：v1', '- 材料沿用至今的版本是 v1']) {
    const text = [heading, '', location, row, id].join('\n');
    const meaning = {claims: [
      {quote: heading, relation: 'execution', fields: [{name: 'scannedTurn', literal: '第1轮', value: 1}]},
      ...[[location, 'locator', original.locator], [row, 'version', 'v1'], [id, 'id', original.id]].map(
        ([quote, name, literal]) => ({quote, relation: 'current', polarity: 'positive', fields: [{name, literal}]})),
    ]};
    const result = evaluateSourceDraft({text, question: history, plan, meaning,
      observations: sourceObservations(plan, [activeSearch], []), currentVersions: {[materialId]: 2}});
    assert.equal(result.text.includes(row), row.includes('：'), result.text);
    assert.ok(result.text.includes(id), result.text);
    assert.deepEqual(result.citations.map((c) => c.id), [original.id]);
  }
});

test('visible match quantities bind to the scoped search even when the reader only extracted a turn', () => {
  const plan = {...sourcePlan, route: 'history'};
  for (const relation of ['execution', 'historical', 'scope']) {
    for (const receiptIncludesCount of [false, true]) {
      for (const [word, value] of [['一', 1], ['两', 2]]) {
        const heading = '第1轮匹配到' + word + '处，出处如下：';
        const text = heading + '\n\n' + report;
        const fields = [{name: 'scannedTurn', literal: '第1轮', value: 1}];
        if (receiptIncludesCount) fields.push({name: 'totalMatches', literal: word + '处', value});
        const claims = [{quote: heading, relation, polarity: 'positive', fields}];
        const result = evaluateSourceDraft({text, question: history, plan, meaning: {claims},
          currentVersions: {[materialId]: 2}, observations: sourceObservations(plan, [activeSearch], [])});
        assert.equal(result.text.includes(heading), value === 1, [relation, receiptIncludesCount, result.text].join(' '));
        assert.ok(result.text.includes(original.id));
      }
    }
  }
});

test('the admitted read and explanation determine tool scope across paraphrases while wider work keeps its tools', async () => {
  const source = '请查第1轮“字面常量”的正式出处，列出工作簿、原格、版本和完整引用 ID。再就同一份材料做一个只读的估值分析：本轮打开现在的同一格，给出其当前值与版本，';
  for (const [task, bounded] of [
    ['并说明仅凭这一个值能否判断企业估值。只在聊天答复。', true],
    ['并说明只用这一个值能否判断企业估值。只在聊天答复。', true],
    ['并讨论这个读数是否足以支撑估值。', true],
    ['并说明仅凭这一个值能否判断企业估值。再查询市场行情和同业报告并比较。', false],
    ['并说明只用这一个值能否判断企业估值。请保存研究报告。', false],
  ]) {
    const question = source + task;
    const plan = await prepareSourcePlan({question}, {session: {}});
    const active = {question, plan, controller: new AbortController()};
    const names = ['transcript_search', 'workbook_query', 'workbook_trace', 'web_fetch', 'edit'];
    const body = await sourceModelOptions(active, {}, {sourceStage: 'research-draft'}).onPayload({
      messages: [{role: 'user', content: question}],
      tools: names.map((name) => ({type: 'function', function: {name}})),
    });
    assert.deepEqual(body.tools.map((t) => t.function.name), bounded ? names.slice(0, 3) : names, task);
  }
});

test('an omitted requested match count leaves an open field and cannot publish an all-clear', async () => {
  const question = history + '另请报告实际命中了几处。';
  const text = '未核验：无。\n\n' + report;
  const {record} = await run(question, [{query, turn: 1}], text);
  assert.equal(record.status, 'partial', record.text);
  assert.match(record.reason, /命中数/);
  assert.ok(!record.text.includes('未核验：无'));
  assert.ok(record.text.includes(original.id));
  const link = record.sourceDelivery.occurrences[0];
  assert.equal(record.text.slice(link.start, link.end), '[Acceptance13.xlsx]Model!B2');
});

test('a counted search result retains its quantity across punctuation and inline Markdown', () => {
  for (const heading of ['第1轮检索结果共两条，出处如下：', '第1轮查到两处，出处如下：',
    '第1轮匹配到结果，共两处，出处如下：', '第1轮匹配到**两**处，出处如下：', '第1轮匹配到的并非一处，出处如下：']) {
    const result = evaluateSourceDraft({text: heading + '\n\n' + report, question: history,
      plan: {...sourcePlan, route: 'history'}, observations: sourceObservations(sourcePlan, [activeSearch], []),
      meaning: {claims: [{quote: heading, relation: 'execution', polarity: 'positive',
        fields: [{name: 'scannedTurn', literal: '第1轮', value: 1}]}]}});
    assert.ok(!result.text.includes(heading), heading);
    assert.ok(result.text.includes(original.id));
  }
});

test('after correction, omissions outside the request can complete only on a fresh check of the exact retained text', async () => {
  const search = {query, turn: 1};
  const historyHeading = '第1轮匹配到一处，出处如下：';
  const badHeading = '第1轮匹配到两处，出处如下：';
  const wrongNow = '材料沿用至今的版本是 v1。';
  const coordinate = '- 单元格：[Acceptance13.xlsx]Model!B2';
  const id = '- 完整引用 ID：' + original.id;
  for (const [heading, note, more, wanted] of [
    [badHeading, '', '', 'completed'],
    [badHeading, '', '另请报告命中几处。', 'partial'],
    [historyHeading, wrongNow, '', 'completed'],
    [historyHeading, wrongNow, '还请说明当前材料版本。', 'partial'],
  ]) {
    const draft = [heading, coordinate, '- 材料版本：v1', note, id].filter(Boolean).join('\n');
    const claims = [
      {quote: heading, relation: 'execution', fields: [{name: 'scannedTurn', literal: '第1轮', value: 1}]},
      ...[[coordinate, 'locator', original.locator], ['- 材料版本：v1', 'version', 'v1'],
        [wrongNow, 'version', 'v1'], [id, 'id', original.id]].map(([quote, name, literal]) =>
        ({quote, relation: 'current', polarity: 'positive', fields: [{name, literal}]})),
    ];
    const {record, rows} = await run(history + more, [search], draft, false,
      (op) => op === 'request' ? {kind: 'history', items: []} : {claims});
    assert.equal(record.status, wanted, record.reason);
    assert.ok(record.text.includes(id), record.text);
    assert.ok(!record.text.includes(wrongNow) && !record.text.includes(badHeading));
    if (wanted === 'completed')
      assert.ok(rows.some((r) => r.type === 'pe_source_host_repair' && r.data.after === digest(record.text)));
  }
});

test('a verified transcript count fulfills only the requested population, even when the counts coincide', async () => {
  for (const userHit of [true, false]) {
    const matches = userHit ? [{role: 'user', turn: 1}, formalHit] : [formalHit];
    const search = observation('transcript_search', 'counted', {query, turn: 1}, {
      totalMatches: matches.length, matches, coverage: {turns: [1], turnsScanned: 1, truncated: false},
    });
    const populations = [
      ['全部消息（含用户消息）', '全部消息', 'totalMatches', matches.length],
      ['只计助手正式回答', '助手正式回答', 'assistantMatches', 1],
    ];
    for (const [requested, , required] of populations) {
      const question = history + '请报告' + requested + '共匹配到几条。';
      const plan = await prepareSourcePlan({question}, {session: {}});
      for (const [, offered, field, value] of populations) {
        const heading = '第1轮' + offered + '共匹配到' + value + '条，出处如下：';
        const text = heading + '\n\n' + report;
        const result = evaluateSourceDraft({text, question, plan, observations: sourceObservations(plan, [search, search], []),
          meaning: {claims: [{quote: heading, relation: 'execution', fields: [{name: field, literal: value + '条', value}]}]}});
        assert.equal(result.status, required === field ? 'completed' : 'partial', question + '\n' + text);
        assert.equal(result.sourceDelivery.items[0].fieldsDelivered.includes(required), required === field);
        assert.ok(result.text.includes(original.id));
      }
    }
  }
});

test('the second attached document has its own request, tool, and verbatim field receipt', async () => {
  const request = '读取附件 PricingMemo.txt 中的估值依据来源并逐字给出';
  const question = history + '再就同一份材料做只读估值分析，本轮打开现在的同一格，给出其当前值与版本，并说明只用这一个值能否判断企业估值。同时' + request + '。';
  const file = 'uploads/1795153342957-PricingMemo.txt';
  const content = '估值依据来源：蓝色台账 MC-729\n';
  const attachment = {id: 'memo', name: 'PricingMemo.txt', relPath: file, versions: [{v: 1, sha256: digest(content)}]};
  const plan = await prepareSourcePlan({question, attachments: [file]}, {session: {},
    ctx: {store: {findMaterialByPath: (rel) => rel === file ? attachment : null}},
    readSourceLanguage: async () => ({kind: 'mixed', research: true, items: [{action: 'read', quote: request, fields: ['verbatim source']}]})});
  assert.ok(plan.items.some(i => i.action === 'readAttachment' && i.filename === attachment.name && i.fields.includes('估值依据来源')));
  const active = {question, plan, controller: new AbortController()};
  const tools = ['workbook_query', 'workbook_trace', 'transcript_search', 'read', 'edit'].map(name => ({type: 'function', function: {name}}));
  const sent = await sourceModelOptions(active, {}, {sourceStage: 'research-draft'}).onPayload({messages: [], tools});
  assert.deepEqual(sent.tools.map(t => t.function.name), tools.slice(0, 4).map(t => t.function.name));
  const line = '备忘录中估值依据来源为：蓝色台账 MC-729。';
  const call = {id: 'memo-call', name: 'read', args: {path: file}, success: true,
    result: {isError: false, content: [{type: 'text', text: content}, {type: 'text', text: '[research_evidence_id] memo-call'}]}};
  for (const [calls, offered, expected] of [
    [[call], line, true], [[], line, false], [[{...call, args: {path: 'uploads/other.txt'}}], line, false],
    [[call], '', false], [[call], line.replace('729', '730'), false], [[call], line.replace('为：', '并非'), false],
    [[call], line + '据此估值翻倍。', true],
  ]) {
    const text = [report, offered].filter(Boolean).join('\n\n');
    const result = evaluateSourceDraft({text, question, plan, currentVersions: {}, observations: sourceObservations(plan, [activeSearch, ...calls], [])});
    const item = result.sourceDelivery.items.find(i => i.action === 'readAttachment');
    assert.equal(item.state, expected ? 'answered' : 'unresolved', offered);
    if (expected) assert.ok(result.sourceDelivery.claims.some(c => c.callIds.includes('memo-call') && c.itemIds.includes(item.id)));
    else assert.match(result.reason, /PricingMemo\.txt.*估值依据来源/);
    assert.ok(!result.text.includes('估值翻倍'));
  }
});

test('separate count requests preserve their populations, targets and unresolved selectors', async () => {
  const fieldPlan = async suffix => prepareSourcePlan({question: multiple + suffix}, {session: {}});
  for (const suffix of ['另给出其中一类消息的命中数。', '排除助手消息后共匹配到几条？', '请报告排除助手消息后的检索命中数。']) {
    const plan = await fieldPlan(suffix);
    assert.ok(plan.gaps.some(g => g.includes('统计对象')), suffix);
    assert.deepEqual(plan.items.filter(i => i.action === 'search').map(i => i.query).sort(), [query, query2].sort());
  }
  const both = await fieldPlan('分别给出“字面常量”的全部消息的命中数和助手正式回答的命中数。');
  assert.deepEqual(both.items.filter(i => i.fields.includes('totalMatches')).map(i => i.query), [query]);
  assert.deepEqual(both.items.filter(i => i.fields.includes('assistantMatches')).map(i => i.query), [query]);
  const split = await fieldPlan('报告“字面常量”的全部消息命中数，以及“折旧政策”的助手答文命中数。');
  const fields = k => split.items.find(i => i.query === k).fields;
  assert.ok(fields(query).includes('totalMatches') && !fields(query).includes('assistantMatches'));
  assert.ok(fields(query2).includes('assistantMatches') && !fields(query2).includes('totalMatches'));
});

test('a count from another round, an incomplete scan or a same-suffix attachment cannot satisfy the request', async () => {
  const question = history + '请报告全部消息共匹配到几条。';
  const plan = await prepareSourcePlan({question}, {session: {}});
  for (const [extra, truncated] of [[[{role: 'user', turn: 2}], false], [[], true]]) {
    const call = observation('transcript_search', 'range', {query, turnRange: [1, 2]}, {
      matches: [formalHit, ...extra], totalMatches: 1 + extra.length, coverage: {turns: [1, 2], turnsScanned: 2, truncated}});
    const heading = '第1轮全部消息共匹配到' + (1 + extra.length) + '条，出处如下：';
    const record = evaluateSourceDraft({text: heading + '\n\n' + report, question, plan, observations: sourceObservations(plan, [call], []),
      meaning: {claims: [{quote: heading, relation: 'execution', fields: [{name: 'totalMatches', literal: (1 + extra.length) + '条', value: 1 + extra.length}]}]}});
    assert.equal(record.status, 'partial');
    assert.ok(!record.text.includes(heading));
  }
  const actual = {id: 'one', relPath: 'uploads/123-PricingMemo.txt', name: 'PricingMemo.txt', versions: [{v: 1, sha256: digest('x')}]};
  const wrong = await prepareSourcePlan({question: history + '同时读取附件 OtherPricingMemo.txt 中的依据并逐字给出。', attachments: [actual.relPath]},
    {session: {}, ctx: {store: {findMaterialByPath: () => actual}}});
  assert.ok(!wrong.items.some(i => i.path === actual.relPath));
  assert.ok(wrong.gaps.some(g => g.includes('OtherPricingMemo.txt')));
});

test('an exhaustive assistant miss with a matching user row cannot supply a zero total', async () => {
  const question = '请查第1轮“字面常量”是否命中过助手回答，另请报告第1轮全部消息共匹配到几条。';
  const plan = await prepareSourcePlan({question}, {session: {}});
  const scan = observation('transcript_search', 'range', {query, turn: 1}, {
    matches: [{turn: 1, role: 'user'}], totalMatches: 1, coverage: {turns: [1], turnsScanned: 1, truncated: false},
  });
  for (const [line, field, value, status] of [
    ['全部消息共匹配到1条。', 'totalMatches', 1, 'completed'],
    ['助手正式回答共匹配到0条。', 'assistantMatches', 0, 'partial'],
    ['全部消息共匹配到0条。', 'totalMatches', 0, 'partial'],
  ]) {
    const text = '第1轮“字面常量”未命中助手正式回答。\n\n' + line;
    const result = evaluateSourceDraft({text, question, plan, observations: sourceObservations(plan, [scan], []),
      meaning: {claims: [{quote: line, relation: 'execution', fields: [{name: field, value, literal: value + '条'}]}]}});
    assert.equal(result.status, status, JSON.stringify(result));
    if (line.startsWith('全部') && !value) assert.ok(!result.text.includes(line));
  }
});

test('a true message count cannot settle an explicitly requested occurrence or deduplicated workbook count', async () => {
  const offered = '第1轮全部消息共匹配到一条，出处如下：';
  const claims = [{quote: offered, relation: 'execution', fields: [{name: 'totalMatches', literal: '一条', value: 1}]}];
  for (const [ask, field] of [['报告原文字串出现了几次。', 'textOccurrences'], ['给出去重后有几本工作簿。', 'uniqueWorkbooks']]) {
    const question = history + ask;
    const plan = await prepareSourcePlan({question}, {session: {}});
    const result = evaluateSourceDraft({text: offered + '\n\n' + report, question, plan, meaning: {claims},
      observations: sourceObservations(plan, [activeSearch], [])});
    assert.equal(result.status, 'partial', question);
    assert.ok(result.text.includes(original.id));
    const item = result.sourceDelivery.items.find(i => i.action === 'search');
    assert.ok(item.fields.includes(field) && !item.fieldsDelivered.includes(field));
  }
});

test('workbook cardinality uses distinct material identities from complete cited rows', async () => {
  const question = history + '给出去重后有几本工作簿。';
  const plan = await prepareSourcePlan({question}, {session: {}});
  const line = '命中的工作簿去重后共一本，出处如下：';
  const text = line + '\n\n' + report;
  const meaning = {claims: [{quote: line, relation: 'execution', fields: [{name: 'uniqueWorkbooks', literal: '一本', value: 1}]}]};
  const scan = observation('transcript_search', 'count-books', {query, turn: 1}, {
    coverage: {turns: [1], truncated: false}, totalMatches: 1, matches: [{...formalHit, citations: [original, original]}],
  });
  const ok = evaluateSourceDraft({text, question, plan, meaning, observations: sourceObservations(plan, [scan], [])});
  assert.equal(ok.status, 'completed', ok.reason);
  scan.result.details.matches[0].sourceDigest = 'excerpt-projection';
  const limited = evaluateSourceDraft({text, question, plan, meaning, observations: sourceObservations(plan, [scan], [])});
  assert.equal(limited.status, 'partial');
  assert.ok(!limited.text.includes(line));
});

test('each requested population needs a visible count in the same search scope', async () => {
  const matches = [{turn: 1, role: 'user'}, formalHit];
  const call = observation('transcript_search', 'both-counts', {query, turn: 1}, {
    totalMatches: 2, matches, coverage: {turns: [1], turnsScanned: 1, truncated: false},
  });
  const total = '全部消息共匹配到2条。';
  const assistants = '助手正式回答共匹配到1条。';
  for (const ending of [
    '分别报告两项：全部消息共匹配到几条；助手正式回答共匹配到几条。',
    '分别报告两项：全部消息共匹配到几条。助手正式回答共匹配到几条。',
    '请给出全部消息、助手正式回答各自的命中数。',
    '请分别列出助手正式回答与全部消息的命中数。',
    '全部消息共匹配到几条，同时也请说明助手正式回答共匹配到几条。',
    '请问助手正式回答的匹配数并列出所有消息的匹配数。',
  ]) {
    const question = history + ending;
    const plan = await prepareSourcePlan({question}, {session: {}});
    for (const offered of [[total], [assistants], [total, assistants]]) {
      const text = [report, ...offered].join('\n\n');
      const claims = offered.map(quote => ({quote, relation: 'execution', fields: [
        quote === total ? {name: 'totalMatches', literal: '2条', value: 2} :
          {name: 'assistantMatches', literal: '1条', value: 1},
      ]}));
      const result = evaluateSourceDraft({text, question, plan, meaning: {claims}, observations: sourceObservations(plan, [call], [])});
      assert.equal(result.status, offered.length === 2 ? 'completed' : 'partial', ending + text);
      if (offered.length === 1) assert.match(result.reason, offered[0] === total ? /缺少助手正式答文的检索命中数/ : /缺少全部消息的检索命中数/);
      for (const line of offered) {
        const receipt = result.sourceDelivery.claims.find(c => result.text.slice(c.start, c.end) === line);
        assert.equal(receipt?.searchCounts?.callId, 'both-counts');
        assert.ok(receipt.itemIds.includes(plan.items[0].id));
      }
    }
  }
});

test('a shared field belongs to every named upload and each published quote needs its own read', async () => {
  const field = '估值依据来源';
  const value = '蓝色台账 MC-729';
  const files = ['A.txt', 'B.txt'].map((name, index) => {
    const content = '作者：' + index + '\n' + field + '：' + value + '\n';
    return {name, content, id: 'file-' + index, relPath: 'uploads/stored-' + name, versions: [{v: 1, sha256: digest(content)}]};
  });
  const [a,b] = files;
  const read = file => ({id: 'r-' + file.id, name: 'read', args: {path: file.relPath}, success: true,
    result: {isError: false, content: [{type: 'text', text: file.content}]}});
  const line = file => file.name + ' 的' + field + '为：' + value + '。';
  for (const request of [
    '同时读取附件 A.txt 和 B.txt 中的“估值依据来源”，按文件分别逐字给出。',
    '同时读取附件 A.txt 中的“估值依据来源”。再读 B.txt 中的“估值依据来源”。',
  ]) {
    const question = history + request;
    const plan = await prepareSourcePlan({question, attachments: files.map(f => f.relPath)}, {session: {},
      ctx: {store: {findMaterialByPath: path => files.find(f => f.relPath === path)}},
      readSourceLanguage: async () => ({kind: 'history', items: files.map(f => ({action: 'read', quote: f.name, material: f.name, fields: [field]}))})});
    for (const [calls, lines, status] of [
      [[a,b], [line(a), line(b)], 'completed'],
      [[a], [line(a), line(b)], 'partial'],
      [[a,b], [line(a)], 'partial'],
      [[a,b], [line(a), line(b).replace('为：','并非：')], 'partial'],
    ]) {
      const text = [report, ...lines].join('\n\n');
      const result = evaluateSourceDraft({text, question, plan, observations: sourceObservations(plan, [activeSearch, ...calls.map(read)], [])});
      assert.equal(result.status, status, request + '\n' + result.reason);
      const items = result.sourceDelivery.items.filter(i => i.action === 'readAttachment');
      assert.deepEqual(items.map(i => i.materialId), [a.id,b.id]);
      for (const [n,file] of files.entries()) {
        const ok = calls.includes(file) && lines.includes(line(file));
        assert.equal(items[n].state, ok ? 'answered' : 'unresolved');
        const claim = result.sourceDelivery.claims.find(c => c.itemIds.includes(items[n].id));
        if (ok) {
          assert.deepEqual(claim.callIds, ['r-' + file.id]);
          assert.equal(result.text.slice(claim.start, claim.end), line(file));
        } else assert.match(result.reason, /B\.txt.*估值依据来源/);
      }
    }
  }
});

test('full upload reads fit a bounded request while preserving both targets and raw results', async () => {
  const paths = ['uploads/123-A.txt','uploads/456-B.txt'];
  const plan = {route: 'mixed', research: true, sourceOnlyRead: true,
    items: paths.map((path, n) => ({id: 'file' + n, action: 'readAttachment', path, fields: ['原文']}))};
  const active = {question: '请读取两份附件的原文。', plan, controller: new AbortController()};
  const read = {type: 'function', function: {name: 'read', strict: true,
    description: 'general file-reading documentation '.repeat(30),
    parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false}}};
  const messages = [{role: 'system', content: 'x'.repeat(31200)}, {role: 'user', content: active.question},
    ...paths.map((path, n) => ({role: 'tool', tool_call_id: 'call' + n, content: path + ' 原文：相同字串'}))];
  const payload = {messages, tools: [read]};
  const fit = () => sourceModelOptions(active, {id:'fixture'}, {}).onPayload(structuredClone(payload));
  const sent = await fit();
  assert.deepEqual(sent.messages, messages);
  assert.deepEqual(sent.tools[0].function.parameters.properties.path.enum, paths);
  assert.ok(active.budget.requests[0].inputUpperBound <= 32000);
  messages[0].content += 'x'.repeat(5000);
  await assert.rejects(fit, /预算/);
  assert.equal(active.budget.requests.length, 1);
});

test('a verified empty mixed-case query reports both zero populations in its original scope', async () => {
  const term = '对照词NordZZ99';
  const question = '请在第1轮查询“' + term + '”是否有命中；另请分别报告全部消息共匹配到几条；助手正式回答共匹配到几条。';
  const plan = await prepareSourcePlan({question}, {session:{}});
  const empty = observation('transcript_search','empty',{turn:1, query:term},
    {matches:[], totalMatches:0, coverage:{turns:[1], turnsScanned:1, truncated:false}});
  const intro = '第1轮“' + term + '”未命中。';
  const counts = '第1轮全部消息共匹配到0条，助手正式回答共匹配到0条。';
  const text = intro + '\n\n' + counts;
  const result = evaluateSourceDraft({question,text,plan,observations:sourceObservations(plan,[empty],[]),
    meaning:{claims:[{quote:intro,relation:'absence',polarity:'negative',fields:[]},
      {quote:counts,relation:'execution',polarity:'positive',fields:[{name:'scannedTurn',value:1,literal:'第1轮'}]}]}});
  assert.equal(result.status, 'completed', result.reason);
  assert.equal(result.text, text);
});

test('only whole requested file identities admit a read, including names containing joiners', async () => {
  const files = ['A.txt', '研究和开发.txt'].map((name, i) => ({name, id: String(i), relPath:'uploads/' + i + '-' + name,
    versions:[{v: 1, sha256:digest(name)}]}));
  const question = history + '同时读取附件“未附附件A.txt”和“研究和开发.txt”中的“依据”和“日期”，按文件分别给出。';
  const plan = await prepareSourcePlan({question, attachments:files.map(f=>f.relPath)}, {session:{},
    ctx:{store:{findMaterialByPath:path=>files.find(f=>f.relPath===path)}}});
  const reads = plan.items.filter(i=>i.action === 'readAttachment');
  assert.deepEqual(reads.filter(i=>i.path).map(i=>i.filename), ['研究和开发.txt']);
  assert.deepEqual(reads.find(i=>i.path).fields, ['依据','日期']);
  assert.ok(reads.some(i=>i.filename === '未附附件A.txt' && !i.path));
  assert.ok(plan.gaps.some(g=>g.includes('未附附件A.txt')));
});

test('a coordinated visible quotation has one proof per named file, including when values coincide', async () => {
  const field = '依据';
  const value = '蓝色台账';
  const files = ['A.txt','B.txt'].map((name, n) => {
    const content = '序号：' + n + '\n依据：' + value + '\n';
    return {name, id: name, relPath: 'uploads/' + name, content, versions: [{v: 1, sha256: digest(content)}]};
  });
  const question = history + '请读取 A.txt 与 B.txt 的“依据”，按文件给出。';
  const plan = await prepareSourcePlan({question, attachments: files.map(f => f.relPath)}, {
    session: {}, ctx: {store: {findMaterialByPath: path => files.find(f => f.relPath === path)}}});
  const calls = files.map(f => ({name: 'read', id: f.id, args: {path: f.relPath}, success: true,
    result: {content: [{type: 'text', text: f.content}]}}));
  const same = 'A.txt 和 B.txt 的依据均为：蓝色台账。';
  const separate = 'A.txt 的依据为：蓝色台账；B.txt 的依据为：蓝色台账。';
  for (const line of [same, separate]) for (const both of [false, true]) {
    const text = report + '\n\n' + line;
    const result = evaluateSourceDraft({text, question, plan,
      observations: sourceObservations(plan, [activeSearch,...(both ? calls : calls.slice(0,1))], [])});
    assert.equal(result.status, both ? 'completed' : 'partial', line + ' ' + result.reason);
    if (both) assert.equal(result.text, text);
    else {
      assert.match(result.reason, /B\.txt.*依据/);
      assert.ok(!result.text.includes('B.txt'));
    }
  }
});

test('coincident counts in one sentence retain distinct field positions in the signed text', async () => {
  const heading = '第1轮全部消息共匹配到一条，助手正式回答共匹配到一条，出处如下：';
  const question = history + '全部消息和助手正式回答各匹配到几条？';
  const plan = await prepareSourcePlan({question}, {session:{}});
  const text = heading + '\n\n' + report;
  const result = evaluateSourceDraft({text, question, plan, observations:sourceObservations(plan,[activeSearch],[]),
    meaning:{claims:[{quote:heading,relation:'execution',fields:[{name:'scannedTurn',literal:'第1轮',value:1}]}]}});
  assert.equal(result.status,'completed',result.reason);
  const proof = result.sourceDelivery.claims.find(c => c.searchCounts);
  const spans = proof.searchCounts.fields.map(f => [f.name, f.visibleRange]);
  const first = heading.indexOf('一条');
  const last = heading.lastIndexOf('一条');
  assert.deepEqual(spans, [['totalMatches',[first,first+2]],['assistantMatches',[last,last+2]]]);
});

test('one attachment read must deliver each requested field across mixed quoting', async () => {
  const fields = ['估值依据来源', '审核人'];
  const content = '估值依据来源：蓝色台账 MC-729\n审核人：林丙 073\n';
  const file = {id: 'memo-a', name: 'A.txt', relPath: 'uploads/stored-A.txt', versions: [{v: 1, sha256: digest(content)}]};
  const call = {id: 'read-A', name: 'read', args: {path: file.relPath}, success: true, result: {content: [{type: 'text', text: content}]}};
  for (const labels of ['“估值依据来源”和审核人', '估值依据来源和“审核人”', '“估值依据来源”和“审核人”', '估值依据来源、审核人']) {
    const question = history + '同时读取附件 A.txt 中的' + labels + '，请逐字给出这两个字段。';
    const plan = await prepareSourcePlan({question, attachments: [file.relPath]}, {session: {},
      ctx: {store: {findMaterialByPath: () => file}}, readSourceLanguage: async () => ({
        kind: 'mixed', items: [{action: 'read', material: 'A.txt', quote: 'A.txt', fields}]} )});
    const item = plan.items.find(i => i.materialId === file.id);
    assert.deepEqual(item.fields, fields, labels);
    const first = 'A.txt 的估值依据来源为：蓝色台账 MC-729';
    const second = '审核人为：林丙 073。';
    for (const [tail, deliveredFields] of [
      [first + '。', fields.slice(0, 1)], [first + '。\n\nA.txt 的' + second, fields],
      [first + '，' + second, fields], [first + '，审核人为：未知。', fields.slice(0, 1)],
      ['A.txt 的估值依据来源为：错误，' + second, fields.slice(1)],
    ]) {
      const text = report + '\n\n' + tail;
      const result = evaluateSourceDraft({text, question, plan, observations: sourceObservations(plan, [activeSearch, call], [])});
      const complete = deliveredFields.length === fields.length;
      assert.equal(result.status, complete ? 'completed' : 'partial', result.reason);
      const quotes = result.sourceDelivery.claims.flatMap(c => c.attachmentQuotes ?? []);
      assert.deepEqual(quotes.map(q => [q.itemId, q.field, q.callId]),
        deliveredFields.map(f => [item.id, f, call.id]), tail);
      if (complete) assert.equal(result.text, text);
      else assert.ok(result.reason.includes('附件 A.txt（缺少' + fields.find(f => !deliveredFields.includes(f)) + '）'));
    }
  }
});

test('independent counts in the same visible sentence bind to their own queries and calls', async () => {
  const terms = [query, '存储'];
  const question = '请核对第1轮已交付回答的历史出处，给出原工作簿、单元格、材料版本和完整引用 ID。' +
    terms.map(term => '请在本会话第1轮查询“' + term + '”，报告该词的全部消息共匹配到几条。').join('');
  const plan = await prepareSourcePlan({question}, {session:{}});
  for (const equal of [false, true]) {
    const rows = equal ? [formalHit] : [{turn: 1, role: 'user'}, formalHit];
    const calls = terms.map((term, i) => observation('transcript_search', 'count-' + i, {query: term, turn: 1},
      {matches: i ? [formalHit] : rows, totalMatches: i ? 1 : rows.length, coverage: {turns: [1], truncated: false}}));
    const expected = [equal ? '一条' : '两条', '一条'];
    for (const values of [expected, ['一条','两条'], [expected[0], '三条']]) for (const whole of [true,false]) for (const join of ['，', '而']) {
      const parts = terms.map((term,i) => '第1轮“' + term + '”的全部消息共匹配到' + values[i] + (i ? '，出处如下：' : join));
      const fields = values.map(literal => [{name:'scannedTurn', literal:'第1轮', value:1},
        {name:'totalMatches',literal,value: {'一条':1,'两条':2,'三条':3}[literal]}]);
      const claims = whole ? [{quote: parts.join(''), relation:'execution',fields:fields.flat()}] :
        parts.map((quote,i) => ({quote,relation:'execution',fields:fields[i]}));
      const text = parts.join('') + '\n\n' + report;
      const result = evaluateSourceDraft({text, question, plan, observations:sourceObservations(plan,[...calls].reverse(),[]), meaning:{claims}});
      const matches = expected.map((literal,i) => literal === values[i]);
      assert.equal(result.status, matches.every(Boolean) ? 'completed' : 'partial', result.reason);
      if (result.status === 'completed') assert.equal(result.text, text);
      for (const [i,term] of terms.entries()) {
        const owner = result.sourceDelivery.items.find(item => item.query === term);
        assert.equal(owner.fieldsDelivered.includes('totalMatches'), matches[i], term);
        const proof = result.sourceDelivery.claims.find(c => c.searchCounts && c.itemIds.includes(owner.id));
        if (!matches[i]) { assert.equal(proof, undefined); continue; }
        assert.equal(proof.searchCounts.callId, calls[i].id);
        assert.deepEqual(proof.itemIds, [owner.id]);
        const [start, end] = proof.searchCounts.fields[0].visibleRange;
        assert.equal(result.text.slice(proof.start + start, proof.start + end), values[i]);
      }
    }
  }
});

test('a named query cannot fulfill a shorter query included in its spelling', async () => {
  const terms = [query, '常量'];
  const question = '请查第1轮“字面常量”和“常量”的正式回答来源和完整引用 ID。' +
    terms.map(term => '请查询“' + term + '”，给出它的全部消息匹配数。').join('');
  const plan = await prepareSourcePlan({question}, {session: {}});
  const calls = terms.map(term => observation('transcript_search', 'call-' + term, {query:term, turn:1},
    {matches:[formalHit], totalMatches:1, coverage:{turns:[1],truncated:false}}));
  const line = '第1轮“字面常量”的全部消息共匹配到一条，出处如下：';
  const result = evaluateSourceDraft({question,plan,text:line+'\n\n'+report,
    observations:sourceObservations(plan,calls,[]),meaning:{claims:[{quote:line,relation:'execution',
      fields:[{name:'totalMatches',literal:'一条',value:1}]}]}});
  assert.equal(result.status, 'partial');
  assert.ok(result.text.includes(line));
  assert.deepEqual(result.sourceDelivery.items.filter(i => i.fieldsDelivered.includes('totalMatches')).map(i=>i.query), [query]);
});

test('splitting count predicates must not detach a qualification from its quantity', async () => {
  const question = '第1轮分别查询“字面常量”和“存储”的正式回答出处和完整引用 ID，并分别给出全部消息匹配数。';
  const plan = await prepareSourcePlan({question}, {session:{}});
  const calls = plan.items.filter(i => i.action === 'search').map(i =>
    observation('transcript_search', i.id, {query:i.query, turn:1}, {totalMatches:1,
      matches:[formalHit],coverage:{turns:[1],truncated:false}}));
  const first = '第1轮“字面常量”的全部消息匹配到一条以上';
  const second = '第1轮“存储”的全部消息匹配到一条，出处如下：';
  const line = first + '，' + second;
  const result = evaluateSourceDraft({plan, question, text:line+'\n\n'+report,
    observations:sourceObservations(plan,calls,[]),meaning:{claims:[{quote:line,relation:'execution',fields:[
      {name:'scannedTurn',literal:'第1轮',value:1},{name:'totalMatches',literal:'一条',value:1}]}]}});
  assert.equal(result.status,'partial');
  assert.ok(!result.text.includes(first));
  assert.deepEqual(result.sourceDelivery.items.filter(i => i.fieldsDelivered.includes('totalMatches')).map(i => i.query),['存储']);
});

test('a stated field total cannot be closed by an incomplete attachment proposal', async () => {
  const file = {id: 'memo', name:'A.txt', relPath:'uploads/one-A.txt', versions:[{v:1,sha256:digest('依据：台账')}]};
  const question = history + '请读取 A.txt 的“依据”，逐字给出这两个字段。';
  const plan = await prepareSourcePlan({question, attachments:[file.relPath]}, {session:{},
    ctx:{store:{findMaterialByPath: () => file}},
    readSourceLanguage:async () => ({kind:'mixed',items:[{action:'read',quote:'A.txt',material:'A.txt',fields:['依据']}]})});
  assert.ok(plan.gaps.some(reason => reason.includes('A.txt') && reason.includes('字段')), JSON.stringify(plan.gaps));
});
