# G1 / 目标价偏离答文修复 — Dev Summary

| 字段 | 内容 |
|------|------|
| 分支 | `fix/g1-target-deviation` |
| 基线 | `2c42e0d`（含 CELL-CITE static hotfix） |
| 代码提交 | `0179173`、`f40e4f7`、`71c5ef0` |
| 推送 | 未 push / 未 merge |
| 结论 | P0、P1 已完成；P2 未做（仅由 turn-context 路由覆盖提示） |

## 改了什么

### P0 — Skill / 协议

- `skills/investment-framework/SKILL.md`
  - 在「工具失败不是来源事实」后新增两条硬规则：
    - `G*` / `gaps[].id` 永远是缺口 ID，禁止写成「目标价单元格（G1）」「没有独立目标价单元格（G1）」。
    - 目标价 / 偏离 / 上行空间问题：先取模型目标价（`valuations` 的 `V*.output=target_price`、`workbook_trace` 估值输出格、或明确 `target_price` locator），再 `westock_query` 现价；首句必须给模型价、现价、空间。
    - 禁止开场「先纠正前提 / 无法精确回答 / 模型没有独立目标价单元格」；读失败写 `unverified` + gap；本会话或状态已有可读目标价（如 `SOTP!J134=752`）必须使用。
  - 结论卡/判词段补充：偏离类问题同样必须同时展示模型价、现价、空间；券商目标价只作对照附录。
- `skills/model-qa/SKILL.md`
  - 新增短节「目标价 / 偏离」，复述上述硬规则；负向「没有目标价」前必须 `workbook_trace` 覆盖估值输出路径；语义 miss ≠ 不存在。
- `lib/turn-context.mjs`
  - 新增 `target` 路由协议（目标价 / 偏离 / 上行空间 / target price / upside / deviation），注入 5 条对应硬约束，未另造长协议。
- `scripts/test-turn-context.mjs`
  - 覆盖 target 路由分类与注入内容。

### P1 — 确定性 answer-lint

`lib/answer-lint.mjs` 新增三条 finding（均带 `code`）：

| code | rule | severity | 说明 |
|------|------|----------|------|
| G1 | `gap_id_as_cell` | error | `单元格（G1）`、`目标价单元格（G1）`、`没有独立目标价单元格（G1）`、`目标价单元格 G3` 等把 gap id 当 cell |
| G2 | `target_missing_claim` | warning → error | 「没有（独立）目标价」「模型底层没有目标价」「无法（精确）回答…目标价…偏离」；当上下文已有目标价（`valuations` / 显式 targetPrice / 本轮或往轮 citation 中可解析的目标值）升 error |
| G3 | `deviation_no_model_price` | warning | 偏离问（`context.userAsksDeviation` 或答文自标偏离小节）且未同时出现可解析模型价与现价/「未获取」 |

- 新增导出 `contextModelTarget()`：从 `valuations`、显式 `targetPrice/target_price`、citation（role/unit/locator）解析模型目标价；仅用于判级与纠正提示。
- 新增导出 `asksDeviationQuestion()`：post-answer 用用户问题判定 `userAsksDeviation`。
- 防误杀：
  - `gaps: G1 tool open`、`缺口 G2 待补`、`gaps[].id=G3` 等台账/状态表不触发。
  - 「没有目标价变化/调整」不触发 G2。
  - broker 标签（券商/卖方/市场共识/consensus 等）后的目标价不算模型价。
  - `目标价单元格（G1）` 中的 `G1` 不会被解析成价格。
- `server/agent/post-answer.mjs`
  - 基于用户问题注入 `userAsksDeviation`。
  - 支持 `entry.answerLintContext` 与 `options.answerLintContext` 传入 `valuations`/`targetPrice`。
  - G1/G2 走专用纠正 prompt：要求用本轮工具/会话状态中的模型目标价与 `westock_query` 现价重写首句；明确 `G1/G2` 只是缺口 ID，禁止当作单元格/挡箭牌。仍沿用最多自动纠正 1 次。
  - 往轮 `entry.citationIndex` 作为目标价 fallback（不改 CELL-CITE 的「只认本轮 citations」语义）；所以早轮读过 `SOTP!J134=752` 时，纠正提示会带上 752。
- `package.json`
  - 补充缺失的 `test:answer-lint` 脚本（原来只有 `test:cell-cite` 间接跑）。
- 新增 fixture：`scripts/fixtures/g1-answer-section2.md`（第二节坏文重建，见「限制」）。

## 验收用例对照

| ID | 结果 |
|----|------|
| A1 坏文「没有独立目标价单元格（G1）…无法精确回答」 | `scripts/test-answer-lint.mjs` 用 fixture 断言命中 G1（error）、G2、G3；实测 `G1:gap_id_as_cell:error` ×2 |
| A2 偏离问 + 只有券商目标价 | 断言 `deviation_no_model_price`（G3 warning） |
| A3 正确首句「模型目标价 752 vs 现价 418.4，空间约 +79.7%」 | 断言无 G1/G2/G3 |
| A4 skill 文本含「G* 是缺口 ID」「偏离须先模型价」 | grep 可见 `skills/investment-framework/SKILL.md:58/60`、`skills/model-qa/SKILL.md:21-24` |
| A5 `test:answer-lint` + `test:systemic` | 均 exit 0（见下） |
| A6 mock「SOTP!J134=752 + 现价」偏离问纠正后首句含 752 与现价 | `scripts/test-post-answer.mjs`：valuations 上下文与往轮 citation 两种路径都断言纠正 prompt 含 752、要求首句重写；纠正后答文通过 lint |

## 测试命令与结果

```text
$ npm run test:answer-lint
answer lint passed
cell citation lint L1-L4 passed
target deviation lint G1-G3 passed
exit=0

$ npm run test:systemic
...
target deviation post-answer correction passed
...
cell cite render U1-U6 passed
cell cite durable bridge U7 passed
dt regression: passed
exit=0
```

`test:systemic` 全链路通过，DT 回归、CELL-CITE（L1-L4 / U1-U7）、post-answer、turn-context、ledger/self-audit 均未回退。

## 已知限制

1. **原始坏例文件缺失**：本环境 `/tmp/g1-answer-full.md` 不存在（`/tmp` 为空），workspace 里只有 BRIEF 的引文。因此按 BRIEF 描述和引文重建了第二节坏文到 `scripts/fixtures/g1-answer-section2.md`；该 fixture 可稳定触发 G1/G2/G3。拿到原始 full answer 后建议替换/补充 fixture。
2. **启发式保守**：G1/G2/G3 优先漏报而非误杀。异常措辞的「没有目标价」、非标准 broker 标签、或只有图片/表格而无文本价格的答文可能漏报。
3. **G3 不自动纠正**：按 severity 表保持 warning；现有 post-answer 只为 error 触发纠正（G1、G2 升级后）。因此「只有券商价」的偏离答文会被标记，但不会被自动重写。
4. **目标价上下文来源有限**：post-answer 能读本轮 cites、`entry.citationIndex`（往轮 cites）以及调用方传入的 `answerLintContext`；它不会自行扫描 `analysis-state.json`。若某目标价只存在于状态文件且从未被工具引用，需要宿主把 `valuations` 传入 lint context，才能触发 G2 升级/纠正提示中的具体数值。
5. **无真实 westock / 模型 E2E**：A6 用 mock 上下文验证确定性纠正逻辑；未在本任务中调用真实行情或真实腾讯模型。
6. **P2 未做**：未新增「语义路由 miss 自动要求 workbook_trace」的独立逻辑；该要求已写入 skill 与 turn-context 协议。
