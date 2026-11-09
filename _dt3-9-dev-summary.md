# DT-3～DT-9 + DT-R 开发摘要

- **分支**：`fix/dt3-9-deterministic`
- **基线**：`fix/dt2-ledger-claims` @ `05d3a17`（`git merge-base --is-ancestor 05d3a17 HEAD` 通过）
- **范围**：只改代码 + 单测；未 push；未做 merge、部署、全自动 NER、大段叙事重写、无脑 ×÷100。
- **模型调用**：DT-R 与全部新增单测均不调用模型。

## 1. 文件列表

### 实现

| 文件 | 变更 |
|------|------|
| `lib/calc-tool.mjs` | 新增 `ratioCalc`、`shareOfNav`、`createRatioTool`；Decimal/BigInt fraction，返回 `value` + `formula`；`ratio` 工具可选 `valuation_basis`（DT-3/4 合并为同一工具）。 |
| `lib/answer-lint.mjs` | 新增 `ratio_recompute`（R1，0.5% 相对误差，Decimal 重算）、`mixed_valuation_basis`（B4）、`role_mismatch`（D6）、`currency_symbol`（C9）、`missing_section`（D8）；保留原有 U1/U2/percent_change/incomplete。 |
| `lib/turn-context.mjs` | `ratio` 计入敏感性合格计算工具；新增 `missing_miss_proof`（soft warning）。 |
| `lib/workbook-query.mjs` | 增加 `miss` / `missReason` / `degraded` / `direct` / `exact`、`coverage.namedSheetsOk`、逐格 `matchType`/`exact`；地址未命中可关键词降级但绝不标精确；`formatResult` 未命中首行「未找到」+ 已检索表；query 文本始终输出角色。 |
| `lib/workbook-trace.mjs` | trace 文本行始终输出 `角色`。 |
| `lib/validate-state.mjs` | 接受/推导 `threshold_status`（`calibrated`/`pending`），缺省 warn；pending 沿用 calibration/armed 逻辑；新增 `THRESHOLD_MODEL_ONLY`。 |
| `server/agent/post-answer.mjs` | 仅当 `options.requiredSections` 或 `entry.requiredSections` 传入时启用 checklist；默认不改变现有会话；沿用最多 1 次纠正是/续写。 |
| `server/project-context.mjs` | 注册 `createRatioTool()`。 |
| `skills/model-qa/SKILL.md` | 硬句：占比/增速/倍数必须先 `ratio` 或 `calc`；NAV 占比声明 `valuation_basis`。 |
| `skills/investment-framework/SKILL.md` | 同上，放在估值章节。 |
| `skills/investment-framework/references/state-contract.md` | 增加 `threshold_status` 一行说明。 |

### 测试

| 文件 | 内容 |
|------|------|
| `scripts/test-ratio-tool.mjs` | 新增：R1–R5、B1–B3、`ratio` 工具契约。 |
| `scripts/test-dt-regression.mjs` | 新增：DT-1 金标、DT-2 T1 摘要、ratio、miss flag、role lint、currency lint、pending/THRESHOLD_MODEL_ONLY、miss proof。 |
| `scripts/test-workbook-query-semantics.mjs` | 扩 M1–M3 + degraded 断言。 |
| `scripts/test-validate-state-warnings.mjs` | 扩 F1–F3 + `threshold_status` 缺省/非法断言。 |
| `scripts/test-post-answer.mjs` | 扩 DT-8 checklist 启用/默认关闭两条路径，确认续写路径不回归。 |
| `package.json` | `test:systemic` 追加 `test-ratio-tool.mjs`、`test-dt-regression.mjs`。 |

## 2. 跑法

```bash
cd /workspace/projects/pe_workbench2
git checkout fix/dt3-9-deterministic
npm run test:systemic
# 或单跑新增护栏
node scripts/test-ratio-tool.mjs
node scripts/test-dt-regression.mjs
node scripts/test-workbook-query-semantics.mjs
node scripts/test-validate-state-warnings.mjs
node scripts/test-post-answer.mjs
```

附加验证：

```bash
npm run test:framework   # 44 passed
npm run test:trace       # trace / trace hook ok
npm run test:calc        # 本机缺少 projects/.../长鑫 Model.xlsx，按既有逻辑跳过
```

`npm run test:systemic` 最近一次全绿（含 DT-1 金标与 DT-2 T1–T8）。

## 3. 与已有雏形的差分（没有推倒重写）

| 能力 | 已有 | 本次只补 |
|------|------|----------|
| 算术/单位 | `calculate`、`unitConvert`、Decimal fraction、U1/U2 | 在其上加 `ratioCalc`，复用 `decimal`/`mul`/`div`/`format`；未改 U1 路径。 |
| 答案 lint | U1/U2、`%`、`a/b-1=%`、`incomplete` | 新增裸 `A/B=X%`、`X%（A/B）` 重算；保留旧规则和旧测试。 |
| 截断续写 | `incomplete` + post-answer 最多 1 次 | 只增加可选 `requiredSections`，未另造第二套截断/续写逻辑。 |
| 工作簿检索 | `cellRole`、`display_unit`、`coverage.sheetsSearched` | 增加 `miss`/`degraded`/`namedSheetsOk` 与文本「未找到」；角色枚举保持 `hardcoded_input|constant|linked|formula|output`。 |
| 失效阈值 | `pendingThreshold`、`calibration_plan`、pending armed 警告 | 增加 `threshold_status` 推导与 `THRESHOLD_MODEL_ONLY`；旧 pending 行为保留。 |
| 台账 | `summarizeLedger`、T1–T8 | 未改实现，仅回归固化。 |

## 4. 每包已知限制

- **DT-3**：`A/B=X%` 只匹配明确写成除法的断言；不推断叙述性「占比约三成」。`context.toolNumbers` 不作为唯一触发条件（无 context 也会做裸断言重算），以免漏掉心算断言。`percent_change` 旧规则仍保留原有按小数位的容差，未改其判定方式。
- **DT-4**：`mixed_valuation_basis` 是启发式：同一段落同时出现折价前/后 + 两个不同百分数即 warn，可能对已经逐句标注的答文误报（soft warning，不阻断）；不会自动改写数值。`shareOfNav` 只支持 `pre_discount|post_discount|other`。
- **DT-5**：`miss` 表示本次查询未命中（含关键词无结果）；精确地址未命中但关键词有结果时同时 `miss=true`、`degraded=true`，文本会明确「降级」。`missing_miss_proof` 只在答文出现「未找到/不存在」且带表/单元格/数据等查表语境时触发，宁可漏报。
- **DT-6**：role lint 只在调用方传 `context.cellRoles` 时启用；不做全篇猜测。role 枚举沿用现码，未改成计划里的 `formula_derived/output_display` 别名。
- **DT-7**：缺省 `threshold_status` 只推导并 warn，不回写调用方对象（避免同一 state 多次校验时把旧推导值固化）。仅模型预测增速的检测是文本正则，覆盖「本模型预测/模型预测增速/仅依据…预测增速」。
- **DT-8**：`requiredSections` 默认空；只有路由/调用方显式传入才启用。章节匹配是子串匹配，不做 Markdown 标题层级解析。缺章节报 error，沿用 post-answer 最多 1 次纠正。
- **DT-9**：HKD→禁 `¥` 已实现；RMB/CNY→大量 `HK$` 仅在 ≥2 处时 warn（可选规则）。
- **DT-R**：不调模型；`_chief/tasks/systemic-fix/RETEST-QUESTIONS.md` 在本工作区不可写/未引用，回归只固化机制断言。`_chief` 目录当前 `not-writable`，故未写 `dev-summary-dt3-9.md` 副本。

## 5. 提交

本地提交：见 `git log -1 --oneline`（`fix/dt3-9-deterministic`）。未 push。

## 6. 验收对照

- [x] 分支 `fix/dt3-9-deterministic`，基于 `05d3a17`
- [x] DT-3～9 单测绿；`npm run test:systemic` 全绿（含 DT-1/2 不回退）
- [x] `_dt3-9-dev-summary.md`：文件、跑法、限制、差分
- [x] 未 push；可本地 commit
- [x] 未做：全自动 NER claim、部署、大段叙事重写、无脑 ×÷100
