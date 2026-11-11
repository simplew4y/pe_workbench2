const facts = [
  ['E-A-REV-2024', 'A 公司', '营业收入', '2024', 120],
  ['E-A-REV-2023', 'A 公司', '营业收入', '2023', 100],
  ['E-A-PARENT-2024', 'A 公司', '归母净利润', '2024', 15],
  ['E-A-PARENT-2023', 'A 公司', '归母净利润', '2023', 12],
  ['E-A-TOTAL-2024', 'A 公司', '合并净利润', '2024', 17],
  ['E-A-TOTAL-2023', 'A 公司', '合并净利润', '2023', 14],
  ['E-B-REV-2024', 'B 公司', '营业收入', '2024', 80],
  ['E-B-REV-2023', 'B 公司', '营业收入', '2023', 50],
].map(([id, company, metric, period, value]) => ({
  id,
  claim: metric,
  value,
  unit: '亿元',
  period,
  binding: { company, metric, period, unit: '亿元' },
  status: 'current',
}));

const topics = [
  ['W01', 'A 公司：2024 年与 2023 年营业收入及业务规模对比', ['E-A-REV-2024', 'E-A-REV-2023'], '营业收入'],
  ['W02', 'A 公司：2024 年与 2023 年归属于母公司股东的净利润', ['E-A-PARENT-2024', 'E-A-PARENT-2023'], '归母净利润'],
  ['W03', 'A 公司：2024 年与 2023 年合并净利润，包含子公司其他股东对应的收益', ['E-A-TOTAL-2024', 'E-A-TOTAL-2023'], '合并净利润'],
  ['W04', 'B 公司：2024 年与 2023 年营业收入及业务规模对比', ['E-B-REV-2024', 'E-B-REV-2023'], '营业收入'],
].map(([id, title, factIds, metric]) => ({
  id,
  title,
  summary: title,
  factIds,
  qaRefs: [],
  binding: { company: title.split('：')[0], metrics: [metric], periods: ['2024', '2023'] },
  status: 'current',
}));

export const topicLedgerFixture = { topics, facts };

const resolved = { needed: false, missing: [] };

export const topicRetrievalCases = [
  {
    id: 'R01',
    history: '帮我看看 A 公司 2024 年的年报。\n已定位到这份年报。',
    question: '2024 年和 2023 年，分别做了多少钱的生意？扣掉各种开销和税，算到这家公司自己股东头上的收益又有多少？',
    expected: {
      topicIds: ['W01', 'W02'],
      factIds: ['E-A-REV-2024', 'E-A-REV-2023', 'E-A-PARENT-2024', 'E-A-PARENT-2023'],
      company: 'A 公司',
      periods: ['2024', '2023'],
      clarification: resolved,
    },
  },
  {
    id: 'R02',
    history: 'A 公司 2024 年做了多少钱的生意？\n120 亿元。\n换成 B 公司，同一年呢？\n80 亿元。',
    question: '那前一年呢？',
    expected: {
      topicIds: ['W04'],
      factIds: ['E-B-REV-2023'],
      company: 'B 公司',
      periods: ['2023'],
      clarification: resolved,
    },
  },
  {
    id: 'R03',
    history: '把 A 和 B 公司 2024 年做了多少钱的生意放一起看看。\nA 公司为 120 亿元，B 公司为 80 亿元。',
    question: '它比前一年多了多少？',
    expected: {
      topicIds: ['W01', 'W04'],
      factIds: ['E-A-REV-2024', 'E-A-REV-2023', 'E-B-REV-2024', 'E-B-REV-2023'],
      company: null,
      periods: ['2024', '2023'],
      clarification: { needed: true, missing: ['company'] },
    },
  },
  {
    id: 'R04',
    history: 'A 公司 2024 年做了多少钱的生意？\n120 亿元。\n那扣掉开销后，算到它自己股东头上的收益呢？\n15 亿元。\n再看 B 公司，2024 年做了多少钱的生意？\n80 亿元。',
    question: '回到最开始那家公司，还是最开始问的生意规模，2024 年和 2023 年差多少？',
    expected: {
      topicIds: ['W01'],
      factIds: ['E-A-REV-2024', 'E-A-REV-2023'],
      company: 'A 公司',
      periods: ['2024', '2023'],
      clarification: resolved,
    },
  },
];

export function fixtureMessages(history) {
  return history.split('\n').map((content, index) => ({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content,
  }));
}
