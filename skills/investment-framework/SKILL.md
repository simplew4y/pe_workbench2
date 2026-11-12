---
name: investment-framework
description: 从既有估值模型或研究材料形成七节投资框架，并把结论落成可跟踪的 analysis-state.json：观点 T、假设 A、敏感性 S、失效条件 F 一一关联。用户说形成/生成/复核/更新投资框架时使用；后续定时跟踪由 framework-update 读取同一状态文件。
---

# 投资框架：从模型到可跟踪的观点

目标不是写一份好看的报告，而是留下**能被后续跟踪运行逐条复核的东西**：几个观点、每个观点依赖什么、做过哪些敏感性、什么情况下算错。

因此每次形成框架都交付三件套：

1. `analysis-state.json` —— 框架快照（观点、假设、敏感性、失效条件、事实引用、版本）。
2. `投资框架报告.md` —— 七节视图，正文用 ID 引用状态对象。
3. 附件（可选）—— 复算表、图表；不改源模型。

状态文件与报告放在同一个 `exports/` 目录，文件名固定。


## 项目数字事实与版本化交付

宿主提供 `fact_query` / `fact_bind` / `fact_calculate` / `fact_correct` / `framework_commit` 时：

- SQLite 项目事实库是数字与证据的持久化登记；`analysis-state.json` 是框架快照，Markdown 是可读视图。旧文件保持兼容，不据此自动升级为已核事实。
- 先用 `fact_query` 按主体、指标、期间、口径、实际/预测/假设及情景查数；`ambiguous` 要明确身份，`retrieval_failed` 不能说成未披露，`stale` 不能当现值。
- Excel/PDF 工具成功返回后，宿主会持久化结构化证据。看 `factMemory.status` 确认保存结果；仅包含本次实际读取范围，不代表全部文件数字均已登记。
- `source_checked` 仅表示结构化来源支持该取数与身份；公式缓存、缺少主体/口径、PDF 文本语义尚未核实的记录保留 `needs_review`。`fact_bind` 可补身份候选，但不能自行宣布核验通过。
- 计算使用固定 `fact_id` 与 `fact_version` 的 `fact_calculate`。支持 ratio/add/subtract/multiple；跨币种或期间不静默计算，复杂模型仍走既有工具和审批。
- 明确更正时用 `fact_correct` 指定事实 ID、预期版本与完整身份。新值是待核用户主张；修改工作模型或已有研究产物仍走原审批。
- 新版框架先写草稿并 `validate_state`，再 `framework_commit` 固定引用版本。使用返回的 `exports/fact-memory/<framework_id>/rN/` 交付路径。`pending` 是导出待完成，不是已发布；用 retry_export 重试，不重复新建修订。
- 当前提交只验证事实引用版本及 JSON/报告一致导出，`numeric_validation=references_only`。它没有验证报告每一处数字或状态里每个字段与引用逐一对应，不能说“全文事实已核验”。
- 不直接写 `.pi/ledger`、事实库文件或 `exports/fact-memory` 发布目录。已发布视图损坏需报告，不逆向覆盖事实。
- 后台任务保留 `run_id`，仅登记待核候选，不自动变成已核事实，不自动发布新框架。


## 开始前

- 确认研究对象、证券/主体、模型文件、研究问题、信息截止日与输出目录。只有对象或文件不明确时才追问。
- 记录模型文件的相对路径、修改时间与大小；有 bash 时再算内容指纹（如 `shasum -a 256`），供后续版本对比。
- 源文件只读。复算、图表、状态、报告都另存到 `exports/`。
- 先读同目录已有的 `analysis-state.json` 和报告；有则沿用 ID 和未受影响的结论，不另起一套。

## 七节结构

报告固定七节，顺序不变。没有内容也要保留小节并说明原因，不能删节。

| 节 | 必须回答 | 主要引用 |
|---|---|---|
| 1 研究设定 | 对象、问题、期限、截止日、币种单位、模型版本 | `subject` |
| 2 当前判断 | 值不值得研究、目标价区间、估值方法与可比性、最大不确定性、相比上版的变化 | `valuations`、`changes` |
| 3 模型与经营驱动 | 原模型怎么算、真正输入、驱动链、核对结果 | `model.understanding`、`model.checks`、`A` |
| 4 观点台账 | 每条观点的主张、机制、依赖假设、正反证据、替代解释、置信度 | `T` |
| 5 估值、敏感性与回报 | 三情景、方法/倍数口径、敏感性类别与传播、市场对照与 bridge、回报路径 | `V`、`S`、`market` |
| 6 失效条件与监控 | 每条的指标、阈值、来源、频率、触发后动作 | `F` |
| 7 证据、缺口与版本变化 | 证据质量、未解决问题、本次改了什么 | `E`、`G`、`C`、`review` |

详细写法见 [报告模板](references/report-template.md)。报告是文件，可以用表格；聊天回复里给结论摘要即可。

状态文件新建或实质更新用 `schema_version: "2.1"`；`2.0` 只读兼容，不重写历史文件。2.1 的关键不是多几个字段，而是把“方法、口径、驱动、可比性”写成结构化事实，避免把不同模型的目标价接成一条序列。

## 执行顺序

### 1. 还原模型（有模型时）

按收入 → 成本利润 → 现金流 → 估值四条链，各选一条代表路径追到真正输入，写明哪些是设定、哪些是沿用、哪些是公式算出。

把结论写进 `model.understanding` 四段，核对项写进 `model.checks`（`pass` / `difference` / `plug` / `unverified`）。没有模型时留空并说明，不要编造 Excel 来源。

**工具失败不是来源事实。** workbook 读取报错、超时、图片/公式损坏（例如内嵌 WMF/EMF 触发 `ZeroDivisionError`）导致整本表读不到时：

- 记 `result: "unverified"`、`reason: "tool_failure"`，写 `locator`（实际检查的 sheet/单元格）、`attempted`（试过的读取路径）和 `gap_ids`；
- 把缺口写进 `gaps`，`kind: "tool"`、`status: "open"`；
- **不要**在 `item` / `note` 里写“未披露”。只有成功读取到空值或硬编码，才能记 `not_disclosed`。
- 修复读取路径后要回到原模型复核；模型有 DCF 表且参数可读时，不得以“未披露”为由永久放弃 DCF。

**缺口 ID 不是单元格。** `G*` / `gaps[].id` 永远是缺口编号，不是 Excel 单元格。答文禁止写“目标价单元格（G1）”“没有独立目标价单元格（G1）”；`G1` 只能出现在 gaps/待核台账，引用单元格必须写 `sheet!cell`。

**目标价 / 偏离 / 上行空间（硬规则）。** 先取模型目标价：当前 `valuations` 中 `V*.output=target_price`（或 `per_share_value`）、`workbook_trace` 的估值输出格、或明确 `target_price` locator；再调 `westock_query` 取现价。首句直接写“模型目标价 <值> vs 现价 <值>，空间 ≈ X%”（行情失败则现价“未获取”），再写驱动、方法与时点。禁止开场“先纠正前提”“无法精确回答”“模型没有独立目标价单元格”。读失败写 `unverified` + `gap`；但本会话或状态里已有可读目标价（如 `SOTP!J134=752`）时必须使用已有值，不得假装没有。券商目标价只作对照附录，不能替代模型价。

### 2. 建假设台账

只保留**观点会用到**的假设，每条一个 `A` ID，写清期间、值/单位、`kind`、证据。模型没写选值理由就记“模型未记录理由”，不要替分析师编动机。

假设分两类，别混：

- **公式驱动**：直接进入某个 `V.drivers` 的操作数（ARR、倍数、EPS、汇率、股数、折现率、终值增长率、净现金等）。公式里每个数都要有 A，汇率和股数也不例外。
- **叙述/观点依赖**：支撑观点但不直接进入估值公式。

不进入公式的假设可以写进观点、风险、第 4 节，**不能**写进目标价变化的归因。

### 3. 立观点（3–5 条，按问题定）

每条 `T` 必须能回答：什么变化、通过什么机制、在什么期限内、带来什么回报。然后补齐：

- 支持证据 `support_ids`、反面证据 `counter_ids`；
- 替代解释 `alternatives`（同一证据还能怎么解释）；
- 未知问题 `unknowns`；
- 置信度与依据 `confidence_reason`。

几条硬规则：

- 只保留有实质区别的观点，合并重复，不凑数量。
- 商业机制与“当前价格有没有吸引力”分开写；后者放第 5 节。
- 模型预测本身不是兑现证据；多篇转述同一来源不算独立证据。
- 证据不足就写“还不能判断”，允许观点为空，但要在第 7 节写缺口。

### 4. 做敏感性（2–3 个真正输入）

先复现原基准，再扰动模型**真正独立设置**的上游输入，沿实际公式传播。每条一个 `S` ID，写清方法、基准、扰动、固定条件、结果、影响对象。

- 增长率、毛利率可能是输入，也可能是算出来的结果；按依赖方向判断，不按行名。
- 区分 `model_input`（经营输入扰动）与 `price_condition`（给定 EPS×倍数的价格对照），后者不能冒充前者。
- 区间按历史波动、经营约束或模型临界值定，不默认 ±10%；百分比与百分点分开。
- 只测了部分路径就说明范围，不宣称“全表已测试”。
- 只扰动进入公式的输入；不进入某个 V 的 `drivers` 的假设，只能做观点/情景说明，不能写成该 V 的估值敏感性。

### 5. 估值与市场对照

每条 `V` 一个情景（`bear` / `base` / `bull` / `reverse`），先声明口径，再写公式：

- `method_key`：稳定机器键，同一模型、同一输出口径、同一倍数口径才复用；换模型或换口径就是新 key。
- `output`：`target_price` / `equity_value` / `enterprise_value` / `per_share_value`。
- `drivers`：只列公式直接操作数，每项都要有 `assumption_id`；`assumption_ids` 再补间接依赖。
- 有 `multiple` 驱动时必须写 `multiple_basis` + `multiple_period`，如 `11x 2026E ARR`。10x 是输入，458 是输出；不要把 `10x → 11x` 写成“目标价 +10%”，也不要把 ARR 倍数简称“PE”。
- `status` / `superseded_by`：`current` 或 `superseded`。多方法并列时不合成加权目标价；报告写清哪个是基准、哪个是对照、为什么。
- **比率硬规则**：报告占比/增速/倍数前必须调用 `ratio` 或 `calc`，禁止心算；以 NAV 为分母的占比必须声明 `valuation_basis`（`pre_discount` / `post_discount` / `other`）并在旁注展示。

**方法切换（硬规则）**：DCF → ARR 倍数法这类变化不是“目标价更新”，不能把两个值写成 `1560 → 320`。按下面做：

1. 旧 V 保留原值和原 `method_key`，标 `status: "superseded"`，`superseded_by` 指向新 V；
2. 新 V 用新 ID、新 `method_key`；
3. `changes` 写 `kind: "method_switch"`、`comparability: "not_comparable"`、`from/to`、`comparability_reason` 和 `bridge`（至少列方法、基准指标、倍数口径）；
4. **不写 `attribution`**。两个不同模型之间没有可加/可乘的“贡献”；
5. 报告第 5 节并列两种方法 + bridge，不写成连续目标价。

**同方法改假设**：写 `kind: "assumption_update"`。`attribution` 要覆盖所有变化的驱动，`combination` / `residual` 说明闭合；`320 → 458` 必须同时写 ARR `20 → 26` 和倍数 `10 → 11`，只写倍数会让残差暴露。归因里出现不在 `V.drivers` 的 A（例如 ARR 倍数法里的利润率 A3）是错误，不是“辅助解释”。

**稳定性**：同一 `data_cutoff` 内不得对同一 V 做反向修正；确需修正时写 `stability_note`，并引用新增的非推断证据。只凭“人工判断偏高/偏低”或现价距离调 base，不升 revision，标 `needs_review`。

`market` 记录价格、价格日、共识与来源、现价隐含条件。没有行情就留 `null` 并写缺口，不用模型缓存价充当实时价。

### 6. 写失效条件（这一步决定能不能跟踪）

每个观点至少一条 `F`。这是**后续跟踪唯一要逐条核对的对象**，所以必须可观测：

```
指标（含口径）→ 阈值与依据 → 数据源与频率 → 预警 → 触发后的动作
```

- 指标要能取到数：如“季度合约价环比”“月度出货量”“毛利率（半年报口径）”，不写“竞争力下降”。
- 阈值要有依据：历史波动、模型临界值、经营约束；没有依据就写“待定”，并说明如何定。
- 区分三类信号：单期偏差、持续假设偏离、核心机制被推翻。三者动作不同。
- 触发 = 核验/改判/重算，不是自动交易。
- 定性事件也可以，但要写清核验方式与来源。

写法与例子见 [失效条件设计](references/monitoring-design.md)。

### 7. 组装、校验、交付

1. 把状态映射成七节报告，正文引用 ID（`T1`、`S2`、`F3`），不复制整段 JSON。
2. 校验（优先专用工具，不要因为“没有 bash”跳过）：
   - **有 `validate_state` 工具时（必须调用）**：`validate_state({ "path": "<analysis-state.json 项目内相对路径>" })`，读取返回的 `errors` / `warnings`；它与本 skill 的 `scripts/validate_state.mjs` 共用同一套规则，不需要 bash 或 child_process。
   - 没有该工具、但会话有 bash 时：`node <本 skill 目录>/scripts/validate_state.mjs <analysis-state.json>`（技能加载时会给出目录）。
   - 两者都没有时：才按 [状态契约](references/state-contract.md) 的自查清单逐项核对，并在第 7 节写“脚本校验未执行（当前会话无 validate_state / bash）”。
3. 修掉所有 error；warning 可以保留但要理解。校验器会检查方法身份、驱动引用、归因闭合、可比性、证据类型和同日反向修正的稳定性，具体规则见 [状态契约](references/state-contract.md)。
4. 人工再查三件事：**最大驱动是否在 `attribution` 里？有没有把不进入公式的 A 写成目标价变化原因？报告有没有把不同方法写成一条目标价序列？**
   - **数字自查（十倍错）硬规则**：先 `transcript_search`（同时返回台账 `ledgerMatches`）→ 列出候选人（可空，写「未发现候选人」）→ 金额逐条 `unit_convert`/`calc`（百万元 ÷ 100 = 亿元）→ 输出 `角色 | 主张 | 应为 | 依据` 表。未检索不得写「全部正确 / 没有十倍错误」；允许「核对 N 条后均与单元格一致」。用户口述「写成了/应为/有人写成」先记 `ledger_record kind=claim`，确认后 `kind=correction`。
5. `stage` 设为 `draft` 或 `reviewed`。`reviewed` 要求每个 active 观点都有失效条件和反证。
6. 回复给结论摘要 + 两个路径（报告、状态），不要逐字贴报告。

## 补建状态（已有报告但没有 analysis-state.json）

老报告要纳入跟踪时，先补状态，不要直接让跟踪去猜：

- 只抽取报告里**明确写过**的观点、假设、敏感性、失效条件；报告没写的，进 `gaps`，不补造。
- 每条抽出来的证据标 `kind: inference`，`limitations` 写“来自报告转述，未回原始文件核对”；回到原始文件核对后再改 `kind`。
- `stage` 保持 `draft`，`review.notes` 写“由报告回溯补建，未完成证据核验”。
- 补建后跑校验；确认观点与失效条件可执行，再升级为 `reviewed`。
- 补建不是重写报告：报告结构与结论保持不变，只补 ID 和状态文件。

## 交接给跟踪

跟踪运行会：

1. 读 `analysis-state.json`，拿到观点、失效条件、上次截止日；
2. 用新数据逐条核对 `F`，更新 `status` / `observed` / `last_checked_at`；
3. 只在证据支持时改观点状态，追加 `changes`，`revision` +1；
4. 只改报告受影响的小节，并在末尾追加 `## 跟踪记录`；
5. 输出结构化结果（观点状态 + 触发的失效条件），宿主展示在跟踪页。

所以交付前自查三件事：**每条观点有没有 F？每个 F 有没有可取的数？阈值和动作写没写清？** 缺一项，跟踪就会退化成“重读一遍报告”。

## 边界

- 不改源 Excel，不把新实际倒灌进历史模型。
- 不把一份券商模型当市场共识，不把模型里的价格当实时行情。
- 不生成没有证据支持的“精准概率”，不用偏好替代判断。
- 不自动启动监控或交易；是否纳入跟踪由用户在界面上决定。

## 首屏展示契约（presentation）

新增和实质更新状态时必须同步 `presentation`（历史文件缺省可读取）：

- `verdict`: `{id: "verdict", text: "第一句直接回答用户问题", status: "可采信|条件判断|暂不能判断", value_identity: "复现值|自建情景|当前判断"}`。状态与值身份各选一项；技术校验通过不代表投资判断可采信。
- `review_items`: 最多三项 `{id: "R1", question: "核什么", reason: "为什么", impact: "影响及核实后处理"}`；模型时点、倍数选取及证据不足优先前置。ID 全局唯一。
- `key_drivers`: 最多三项 `{reference_id: "A1", weight: 0.6}`；引用状态已有 ID，权重为 0–1 的相对重要性，不编造统计概率。
- `highlights`: 优先只标 1–2 处（通常 `verdict` + 最关键的一条 `R*`），最多四个去重 ID；只引用已有状态记录、verdict 或 review_items，不得另塞文本、数字或 HTML。卡片渲染时会把对应那一两句标成红色并附“关键判断 / 需复核”标签，不能用颜色独自表达方向。
- 敏感性、进入跟踪的失效条件、估值依据分别直接读取 `sensitivities`、`falsifiers`、`valuations`，不在 presentation 另抄数字。

回复与报告执行摘要严格依次：**结论 → 需人工复核 → 核心驱动 → 敏感性 → 进入跟踪的失效条件 → 估值依据 → 报告链接**。结论与复核优先控制在首屏，摘要约 250–400 中文字符；细节留报告。删掉“已完成/已充分掌握”等自述、对象计数、重复交付说明和推销尾句。报告全文默认折叠。不要另用行内 style 标红；若 Markdown 里需要强调，必须写成 HTML：`<span class="hl-decision">关键判断：……</span>` 或 `<span class="hl-review">需复核：……</span>`（合计不超过两处，优先一处结论句），禁止把 `hl-decision` / `hl-review` 当纯文本前缀。优先依赖 presentation.highlights，由结论卡自动标红。

失效条件必须区分已确认触发、单期预警、接近阈值、数据不足。多期规则填写 `required_periods`（正整数）与 `observations: [{period: "2026Q1", value: -1}]`；单一观察值或重复同一期不能证明连续多期触发。无法确认连续期间和完整复合条件时保持 warning/unknown，不能写 triggered。warnings 含原因码，须按根因写复核项，不得把基线缺失解释成已核实。

为保留同轮可复现展示，实质更新后必须用 write 写完整 analysis-state.json（正文与状态同目录）。不要用 edit，也不要用 edits 数组做最后一次交付；否则会话快照可能丢 presentation，结论卡与标红都不会出现。


判词只写判断，直接表达增长逻辑和估值结论，不写“仅供参考”“不能作为当前可执行目标价”等防御或免责声明。风险与限制只以事实写入“需人工复核”（如“分部乘数未记录依据”）。交付前调用 westock_query 获取最新行情；先去除 ticker 中文后缀、括号和空白并转换市场格式（02513.HK（港股）→hk02513）。market.price/currency/price_date/source 分别记录真实现价、币种、行情日期和来源；`fetched_at` 必须抄 westock_query 返回末尾 `[meta] fetched_at=` 的时间戳，禁止自己编造或回填历史日期。可用 quote_at 记录行情时间；失败时 price=null，记录获取时间和 fetch_error，显示“未获取”，不得沿用缓存价冒充实时价。verdict.valuation_id 引用原 valuations 中的模型价；结论卡同时展示模型价、现价、获取时间及空间=(模型价/现价-1)×100%；行情缺失或币种不一致则空间“未获取”。**偏离类问题同样适用**：结论卡必须同时给出模型价、现价与空间；券商目标价只能作对照附录，不能替代模型价。
