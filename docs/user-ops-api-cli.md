# 用户操作 / API / CLI 化盘点（Issue #1）

> 状态：盘点完成，未实现 CLI。
> 盘点日期：2026-10-29
> 范围：`server/create-app.mjs`、`server/routes/*.mjs`、`ui/api/client.js`、`index.html`、`ui/**` 面板入口。
> 参考：`docs/projects.md`、`docs/foundation.md`、`docs/watch.md`、`docs/auto-update.md`、`docs/file-preview.md`、`docs/interactive-tools.md`、`docs/model-trace-guide.md`、`docs/ag-ui-protocol.md`、`docs/copilotkit-headless-pilot.md`。

本文只回答三个问题：**用户在界面上能做什么、背后调用哪条 HTTP 接口、这件事适不适合做成 CLI**。不新增 CLI，不改路由，不改业务运行时逻辑。

## 0. 阅读约定

### 0.1 项目作用域

除 `GET /api/health`、`GET /api/projects`、`POST /api/projects`、`PATCH /api/projects/:id` 外，所有 `/api/*` 请求都会经过 `projectFor()`：

- 查询参数：`?project=<project-id>`
- 或请求头：`X-Project-Id: <project-id>`

两者都没有时使用默认项目。本文的 API 路径默认省略这个作用域参数；写 CLI 草案时统一用全局参数 `--project` 表达。

### 0.2 CLI 评估口径

| 结论 | 含义 |
| --- | --- |
| 可 CLI | 参数明确、结果是结构化 JSON 或文件流、没有必须依赖可视化才能完成的步骤，可直接包装。 |
| 部分可 CLI | 核心动作能脚本化，但需要人工确认、文件选择、长任务等待、实时流或复杂嵌套 JSON，CLI 只能覆盖其中一段。 |
| 不宜 CLI | 强依赖可视化、持续交互或纯浏览器本地状态，做成 CLI 收益很低。 |
| 内部 / 测试 | 不是面向用户的业务动作，或只在测试模式/协议客户端中使用；列出是为了证明路由已被覆盖。 |

### 0.3 UI 入口写法

「右栏 → 资料 / 盯 / 自动更新 / 追踪」指 `index.html` 右侧面板的筛选与标签页。会话、项目、通知、模型切换等位于左栏或顶部栏。当前 UI 没有独立的「计划」筛选按钮，计划入口较弱，后文会单独说明。

---

## 1. 健康 / 项目

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 打开工作台时做健康检查 | 页面加载自动执行，无按钮 | `GET /api/health`，无参数 | **可 CLI**。只读诊断，返回模型、项目列表、调度器开关、ASR/搜索/web_fetch/calc 能力；适合做 `doctor`。注意只输出能力开关，不输出密钥。 |
| 查看与切换项目 | 左上角工作区菜单 → 项目列表 | `GET /api/projects`；切换本身没有写接口，后续请求改带 `?project=` 或 `X-Project-Id` | **部分可 CLI**。列表可脚本化；「当前项目」是浏览器状态，CLI 需要自己保存默认项目或用 `--project`。 |
| 新建项目 | 工作区菜单 → 新建项目 → 创建项目 | `POST /api/projects`，body `{ name, note? }` | **可 CLI**。参数简单，返回项目 id；注意名称必填、长度上限 40，备注上限 60。 |
| 修改项目名称 / 备注 / 主题色 | **无 UI**（目前只有接口） | `PATCH /api/projects/:id`，body `{ name?, note?, accent? }` | **可 CLI**。属于 API 已有、UI 未暴露的管理动作，适合补 `project update`。 |
| 账户设置 | 左下角「账户设置」按钮 | **无**（当前没有绑定处理器） | **不宜 CLI**。没有接口也没有业务动作，属于待补 UI，不应为它造命令。 |

> 缺口：没有「删除项目」路由；项目改名/改主题色只有 API，没有 UI。

---

## 2. 会话 / 事件 / 消息

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看会话列表 | 左栏「会话」列表 | `GET /api/sessions`，项目作用域 | **可 CLI**。只读列表，返回 id、标题、消息数、更新时间；内部计划会话已被服务端过滤。 |
| 新建会话 | 左栏「会话」标题旁 `+` | `POST /api/sessions`，无 body | **可 CLI**。返回新会话 id；适合 `session new` 后接 `session send`。 |
| 切换 / 打开会话 | 点击左栏会话项 | **无切换接口**；客户端设置 `activeSession` 后读取 `GET /api/sessions/:id/state` 并连 `GET /api/sessions/:id/events` | **部分可 CLI**。会话 id 是显式参数，CLI 不需要「切换」；但浏览器里的高亮、滚动位置是本地状态，不可复刻。 |
| 读取会话快照 | 打开会话、流式结束后自动刷新 | `GET /api/sessions/:id/state`，无 query | **可 CLI**。返回消息、标题、模型、是否流式、审批等结构化状态，是 headless 读取会话的首选接口。 |
| 订阅单会话实时事件 | 打开会话时自动建立 SSE | `GET /api/sessions/:id/events`（SSE） | **部分可 CLI**。可做 `events tail`，但需要处理长连接、断线重连和事件 ID；纯一次性脚本通常改用 `state` 快照。 |
| 订阅全局实时事件 | 页面加载后自动建立 SSE | `GET /api/events`（SSE，项目作用域） | **部分可 CLI**。适合 `pe events tail` 或守护进程；一次性命令价值有限，且要处理重连。 |
| 发送消息（旧版传输） | 输入框 → 发送，或回车 | `POST /api/sessions/:id/messages`，body `{ text, attachments? }`；`attachments` 是项目内相对路径数组 | **部分可 CLI**。纯文本可脚本化；附件需要先上传并解析路径；回复是异步流，CLI 要等 SSE 或轮询 state；AG-UI run 活跃时此接口返回 409。 |
| 停止生成 | 输入框右侧停止按钮 | `POST /api/sessions/:id/abort`，无 body | **可 CLI**。动作明确、无参数；在 CopilotKit 模式下 UI 实际调用 `/api/copilotkit/agent/pi/stop/:threadId`。 |
| 切换当前会话模型 | 顶部模型 chip → 选择模型 | `POST /api/sessions/:id/model`，body `{ model }`，只接受 `deepseek-v4-pro` / `deepseek-flash` | **可 CLI**。枚举值清晰；错误会返回 400。 |
| 查看消息里的工具卡 / 附件 / 审批卡 | 会话流内渲染 | 数据来自 `state` / SSE / `GET /api/approvals`；渲染本身无接口 | **不宜 CLI**。这是展示层组合，CLI 更适合直接输出消息与工具结果 JSON。 |

---

## 3. 资料 / 上传 / 文件

### 3.1 资料列表、上传与文件操作

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 加载资料列表 | 右栏 → 资料 | `GET /api/materials`，项目作用域 | **可 CLI**。返回资料、版本、来源链路、ASR 摘要；是 `material list` 的基础。 |
| 上传资料 | 输入框「添加附件」、拖拽文件到输入区 | `POST /api/upload`，原始字节流，请求头 `X-File-Name: <urlencoded-name>`；不是 multipart | **可 CLI**。可用 `curl --data-binary` 或 Node 流式上传；需要注意音频上限 120 MB、其他 30 MB。 |
| 打开资料预览 | 点击右栏资料卡 | **无单一预览接口**；按类型调用版本文件、工作簿、PDF、ASR 接口（见 3.2） | **部分可 CLI**。CLI 可直接取某个版本的原始文件或解析结果，但「预览」本身是前端渲染。 |
| 切换历史版本 | 文件弹窗 → 版本历史 → 点击某版 | **无写接口**；版本由路径参数选择，例如 `GET /api/materials/:id/versions/:v/file` | **可 CLI**。CLI 用 `--version` 直接指定即可，不需要模拟点击。 |
| 恢复历史版本 | 文件弹窗 → 恢复为 vN | `POST /api/materials/:id/versions/:v/restore`，无 body；会生成新版本 | **部分可 CLI**。接口明确，但属于破坏性/可追溯操作，建议要求 `--yes` 并打印新版本号。 |
| 删除资料 | 文件弹窗 → 删除 | `DELETE /api/materials/:id`，无 body；服务端软删除 | **部分可 CLI**。不可逆感强，必须有确认；删除后广播 `material.deleted`。 |
| 下载当前版本 | 文件弹窗 → 下载 | `GET /api/materials/:id/versions/:v/file?download=1` | **可 CLI**。文件流，适合 `material download`；支持 `Range`，可用断点续传。 |
| 复制文件路径 | 文件弹窗 → 复制路径 | **无**，浏览器剪贴板本地操作 | **不宜 CLI**。CLI 直接打印路径即可，不需要接口。 |
| 引用资料到输入框 | 勾选资料卡 → 引用到输入框；或文件弹窗 → 引用 | **无**，纯前端 `state.pending` | **不宜 CLI**。CLI 应直接用 `--file` 或附件参数表达，不应模拟 UI 引用状态。 |
| 过滤资料 / 收起右栏 / 切换标签页 | 右栏筛选按钮、面板开关、`资料 / 盯` 标签 | **无**，纯前端状态 | **不宜 CLI**。属于界面状态，不是业务动作。 |
| 读取单个资料 | **无直接 UI**（列表已带数据） | `GET /api/materials/:id` | **可 CLI**。适合按 id 查详情、做脚本前置校验。 |
| 读取项目内任意文件 | Markdown/文本预览、附件预览会取原文件 | `GET /api/file?path=<项目内相对路径>&download=1` | **可 CLI**。适合 `material cat` / `download`；服务端会阻止 `..` 越界，CLI 仍应只传项目内路径。 |

### 3.2 工作簿、PDF、音频解析

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看 Excel 预览结构 | 打开 `.xlsx/.xlsm` → 工作簿预览 | `GET /api/materials/:id/versions/:v/workbook` | **可 CLI**。返回 manifest（工作表、统计、样式等）；适合 `material workbook summary`。 |
| 切换工作表 / 值公式 / 缩放 | Excel 预览内的标签和按钮 | `GET /api/materials/:id/versions/:v/workbook/sheets/:sheet`；值/公式与缩放是前端状态 | **部分可 CLI**。单表数据可脚本化；值/公式切换、缩放、冻结行列是纯展示，不宜 CLI。 |
| 查询工作簿子图（Agent 同款） | Excel 预览不直接提供查询框；用户通常通过对话触发 Agent | `GET /api/materials/:id/workbook` 摘要；`POST /api/materials/:id/query`，body `{ query, maxCells? }` | **可 CLI**。输出是结构化子图，参数清晰，非常适合 `material query`；也是 `workbook_query` 工具的 HTTP 对应面。 |
| 查看 PDF 结构摘要 | 打开 `.pdf` → PDF 预览 | `GET /api/materials/:id/pdf`；版本级是 `GET /api/materials/:id/versions/:v/pdf` | **可 CLI**。返回页/章节概览，适合先取目录再定位。 |
| 读取 PDF 指定页 | PDF 预览 → 文本 / 页码 | `GET /api/materials/:id/versions/:v/pdf?page=<页码或范围>&maxChars=<1000-40000>` | **可 CLI**。适合 `material pdf --page 2-4`；注意扫描页可能无文字。 |
| 检索 PDF 正文 | PDF 预览 → 检索框 → 检索 | `GET /api/materials/:id/versions/:v/pdf?query=<关键词>`；另有 `POST /api/materials/:id/pdf/search`，body `{ query, maxSnippets? }` | **可 CLI**。检索结果是带页码的命中片段，非常适合脚本化阅读。 |
| 版本级 PDF 摘要 | 打开 PDF 预览时自动读取 | `GET /api/materials/:id/versions/:v/pdf` | **可 CLI**。与“读取指定页”同一端点，只是不带 `page/query`。 |
| 查看音频转写状态 | 打开 `.mp3/.wav` → 音频预览 | `GET /api/materials/:id/versions/:v/asr`；资料级 `GET /api/materials/:id/asr` | **可 CLI**。只读状态，适合轮询；资料级接口当前 UI 不直接调用。 |
| 开始 / 重试 / 强制转写 | 音频预览 → 开始转写 / 重试转写 / 重新转写 | `POST /api/materials/:id/asr`，body `{ version?, force? }` | **部分可 CLI**。动作可脚本化，但异步、可能计费、需要轮询；适合 `material asr start --wait`。 |
| 读取某版本转写全文 | 音频预览 → 文本 / SRT | `GET /api/materials/:id/versions/:v/asr` | **可 CLI**。返回该版本的状态与全文；版本号显式。 |
| 下载转写 TXT / SRT | 音频预览 → 下载 TXT / SRT | `GET /api/materials/:id/versions/:v/asr/content?format=txt` 或 `?format=srt` | **可 CLI**。纯文件流，适合 `material asr download --format srt`。 |

> 能力开关：`WORKBOOK_QUERY=0`、`PDF_READ=0`、`ASR=0` 时对应接口会返回 404/`disabled`。CLI 应先用 `doctor` 或探测结果区分「能力未启用」与「资料没有内容」，不要把两者都当成空结果。

---

## 4. 计划

> 当前右栏没有独立的「计划」筛选按钮。计划弹窗的可见入口主要是文件详情里的任务条，以及深链 `#task=<id>`；`state.tasks` 仍由 `GET /api/plans` 加载。计划本身是服务端/历史数据生成的，当前没有“新建计划”UI。

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 加载计划与运行记录 | 启动时 `GET /api/plans`；文件详情任务条 / `#task=` | `GET /api/plans`，项目作用域 | **可 CLI**。只读列表，含计划、排期、运行记录；适合 `plan list`。 |
| 启用 / 暂停计划 | 计划弹窗 → 暂停计划 / 启用计划 | `POST /api/plans/:id/toggle`，无 body | **可 CLI**。幂等切换语义，返回更新后的计划。 |
| 立即运行计划 | 计划弹窗 → 立即运行 | `POST /api/plans/:id/run`，无 body；返回 202 与 runId/sessionId | **可 CLI**。启动容易；完整等待运行结束需要轮询计划或监听 SSE，适合 `plan run --wait`。 |
| 查看运行记录 | 计划弹窗底部运行记录 | **无独立接口**；由 `GET /api/plans` 的计划 DTO 一并返回 | **可 CLI**。可随 `plan show` 输出。 |
| 新建 / 编辑 / 删除计划 | **无 UI，也无接口** | **无** | **不适用**。属于明确缺口；CLI 不应先于 API 造动作。 |

---

## 5. 跟踪 / 监测 / 通知 / runs

### 5.1 跟踪任务

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看跟踪列表 | 右栏 → 自动更新 | `GET /api/trackings` | **可 CLI**。返回目标、模板、排期、运行状态、结论；适合 `track list`。 |
| 查看跟踪详情 | 点击跟踪卡片 | `GET /api/trackings/:id` | **可 CLI**。详情含 monitors、runs、result、notifications；UI 轮询也用它。 |
| 新建跟踪 | 右栏自动更新 → `+` / 资料卡「加入跟踪」 | `POST /api/trackings`，body `{ targetId, templateId?, freq?, weekday?, day?, time? }` | **可 CLI**。参数清晰；`targetId` 需先由资料列表解析；模板与排期省略时按文件类型和默认值补全。注意 `in_place` 模板只允许 `exports/` 下的产出。 |
| 启用 / 暂停跟踪 | 跟踪详情 → 暂停跟踪 / 启用跟踪 | `POST /api/trackings/:id/toggle`，无 body | **可 CLI**。幂等切换。 |
| 调整运行时间 | 跟踪详情 → 调整时间 → 保存 | `PATCH /api/trackings/:id/schedule`（也接受 `POST`），body `{ freq, weekday?, day?, time }` | **可 CLI**。参数简单；服务端会重新计算 nextRun。 |
| 立即运行跟踪 | 跟踪详情 → 立即运行 | `POST /api/trackings/:id/run`，无 body；返回 202 | **可 CLI**。启动简单；完整等待需要轮询 `GET /api/trackings/:id` 或订阅 SSE。 |
| 删除跟踪 | **无 UI** | `DELETE /api/trackings/:id` | **部分可 CLI**。API 已存在但 UI 没入口；删除有破坏性，建议确认并输出影响范围。 |
| 打开跟踪目标文件 | 跟踪详情 → 打开目标文件 | **无专用接口**；走资料版本文件接口 | **可 CLI**。直接 `material download --id <targetId>` 即可，不需要跟踪接口。 |

### 5.2 来源事件与模型写回

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看来源事件与绑定 | 跟踪详情 → 监测项区域 | `GET /api/trackings/:id/events`，返回 events + bindings | **可 CLI**。只读；适合 `track events list`。 |
| 手动添加来源事件 | **无 UI** | `POST /api/trackings/:id/events`，body `{ title, url?, snippet?, content?, sourceTier? }` | **可 CLI**。参数明确；`title` 必填，会自动分诊。适合自动化导入外部线索。 |
| 刷新来源 | 跟踪详情 → 刷新来源 | `POST /api/trackings/:id/events/refresh`，无 body | **可 CLI**。会同步绑定并轮询各来源；外部请求耗时不定，适合 `track events refresh --wait`。 |
| 查看模型写回状态 | 跟踪详情 → 模型写回 | `GET /api/trackings/:id/model` | **可 CLI**。只读状态、绑定、可用性；适合 `track model show`。 |
| 准备工作模型 | 跟踪详情 → 准备工作模型 | `POST /api/trackings/:id/model/prepare`，无 body | **可 CLI**。生成工作副本并返回 material；属于有副作用的准备工作，建议打印新路径。 |
| 保存模型绑定 | **无 UI**（详情只展示绑定） | `POST /api/trackings/:id/model/bindings`，body `{ bindings: [...], outputs: [...], writeEnabled }` | **部分可 CLI**。JSON 嵌套较复杂且直接决定写回行为，适合 CLI 读取/校验后再确认写入。 |

### 5.3 监测项

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看监测项 | 跟踪详情 → 监测项 | `GET /api/trackings/:id/monitors` | **可 CLI**。只读列表。 |
| 生成监测方案 | **无 UI**（对话技能可辅助生成） | `POST /api/trackings/:id/monitors/plan`，无 body | **可 CLI**。从 analysis-state 派生方案，返回 items + existing，适合先 plan 后 activate。 |
| 同步 / 激活监测项 | 跟踪详情 → 从分析状态同步监测项 / 重新同步 | `POST /api/trackings/:id/monitors/activate`，body `{ items? }`；省略 items 时从状态派生 | **部分可 CLI**。省略 items 时很简单；传入自定义 items 时嵌套复杂，需要校验后确认。 |
| 检查监测项 | 跟踪详情 → 检查监测项 | `POST /api/trackings/:id/monitors/check`，body `{ itemIds?, trigger? }` | **可 CLI**。启动异步 run；等待结果需轮询/SSE，建议 `--wait`。 |
| 修改监测项（频率/自治/状态） | **无 UI** | `PATCH /api/monitors/:id`（也接受 `POST`），body 可含 `{ trackingId?, frequency?, nextCheckAt?, ... }` | **部分可 CLI**。字段多、语义依赖监测契约，适合先 `show` 再 `update`，并限制高风险字段。 |

### 5.4 通知、撤销与 Dashboard

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看通知 | 顶部通知铃铛；打开弹窗时刷新 | `GET /api/notifications?limit=20`；接口还支持 `unread=1`、`tracking=<id>` | **可 CLI**。只读；适合 `notification list --unread`，也适合 cron 轮询。 |
| 标记通知已读 | 点击某条通知 | `POST /api/notifications/:id/read`，无 body | **可 CLI**。幂等、参数简单。 |
| 打开通知对应跟踪 | 点击通知项 | **无专用接口**；客户端用 `trackingId` 调用 `GET /api/trackings/:id` | **可 CLI**。CLI 直接按 trackingId 查询即可。 |
| 撤销一次运行 | 通知卡 / 跟踪详情通知区 → 撤销 | `POST /api/runs/:id/undo`，无 body | **部分可 CLI**。会恢复运行前版本并写撤销通知，破坏性较强，必须有确认与结果输出。 |
| 查看投资 Dashboard | 跟踪详情 → Dashboard | `GET /api/trackings/:id/dashboard`；可选 `?materialVersion=<v>`；单次运行用 `GET /api/trackings/:id/runs/:runId/dashboard` | **可 CLI**。只读、可校验的 JSON，适合 `dashboard get` / 导出；图表交互本身不宜 CLI。 |

---

## 6. 盯盘 Watch

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 加载盯盘总览 | 右栏 → 盯 | `GET /api/watch`，项目作用域 | **可 CLI**。返回 watch、最近消息、检查记录；未开启时返回 detection。适合 `watch status`。 |
| 开始盯住 | 盯盘识别卡 → 开始盯住 | `POST /api/watch`，body 可空；服务端也接受 `{ intervalMinutes, deepCheckTime }` | **可 CLI**。创建动作简单；UI 目前只发空 body，节奏用服务端默认值/环境变量。 |
| 查看单个 watch | **无直接 UI**（总览已包含 view） | `GET /api/watch/:id` | **可 CLI**。只读详情，适合脚本按 id 查询。 |
| 启用 / 暂停、改节奏 | 盯盘设置 → 勾选启用 → 保存；节奏不在 UI 展示 | `PATCH /api/watch/:id`（也接受 `POST`），body 可含 `{ enabled, intervalMinutes, deepCheckTime }` | **部分可 CLI**。启用/暂停简单；间隔与深度复核时间属运维参数，CLI 可做但应显式提示影响成本。 |
| 删除盯盘 | 盯盘设置 → 删除盯盘 | `DELETE /api/watch/:id`，无 body | **部分可 CLI**。会级联清空消息/检查/日志，必须确认。 |
| 立即检查 | 状态条刷新图标 / “现在检查一次” | `POST /api/watch/:id/check`，body `{ deep?: true }` | **部分可 CLI**。返回 202 后异步跑；CLI 需要等待或轮询消息/日志。 |
| 深度复核 | 日志/设置入口触发（UI 传 `deep`） | `POST /api/watch/:id/check`，body `{ deep: true }` | **部分可 CLI**。同上，且会消耗模型/搜索额度。 |
| 查看检查日志 | 状态条历史图标 / 设置 → 查看检查日志 | `GET /api/watch/:id/logs?limit=600&run=<runId>` | **可 CLI**。只读审计日志，非常适合排查；`run` 可过滤单次。 |
| 查看消息列表 | 打开盯标签时加载；SSE 增量 | `GET /api/watch/:id/messages?limit=200&after=<messageId>` | **可 CLI**。只读；`after` 适合增量拉取。 |
| 向盯盘助手提问 | 底部输入框 / 快捷问题 chip | `POST /api/watch/:id/messages`，body `{ text }`；返回 202 | **部分可 CLI**。发送简单；回答异步经 SSE 到达，CLI 要等待或轮询。 |
| 标记已读 | 打开盯标签自动标记 | `POST /api/watch/:id/read`，无 body | **可 CLI**。幂等。 |
| 重建关注点 | 设置 → 重建关注点 | `POST /api/watch/:id/refresh`，无 body | **可 CLI**。按最新报告/状态重建 brief；有副作用但可重放。 |
| 打开发现来源 | 发现卡的本地文件 / 外链 | **无专用接口**；本地文件走资料预览，外链是浏览器跳转 | **不宜 CLI**。外链跳转是浏览器行为；CLI 应输出 URL 或本地路径。 |
| 展开/聚焦关注点 | 识别卡展开、聚焦按钮 | **无**，纯前端状态 | **不宜 CLI**。展示层交互。 |

---

## 7. 审批

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看待审批 / 最近审批 | 会话流顶部审批架（`approvalsShelfHTML`） | `GET /api/approvals?status=&threadId=&trackingId=&limit=100` | **可 CLI**。只读；支持按会话、跟踪、状态过滤，适合 `approval list`。 |
| 查看单个审批 | **无直接 UI**（审批卡已展示 payload） | `GET /api/approvals/:id` | **可 CLI**。适合审批前拉取完整 payload 做差异检查。 |
| 批准模型写回 | 审批卡 → 批准 | `POST /api/approvals/:id/approve`，无 body | **部分可 CLI**。服务端会重新读取项目/工作模型/状态文件再应用；属于高风险写操作，CLI 必须要求人工确认并打印结果。 |
| 拒绝模型写回 | 审批卡 → 拒绝，可填原因 | `POST /api/approvals/:id/reject`，body `{ reason? }` | **部分可 CLI**。动作可脚本化，但拒绝原因需要人判断；建议 `--reason` 必填或强提示。 |
| 审批历史过滤 | **无 UI**（列表默认全部，只保留少量已决定项） | `GET /api/approvals` 的 `status` / `threadId` / `trackingId` 参数 | **可 CLI**。参数已具备，适合补齐 `approval list --status pending`。 |
| 创建审批 | **无 UI、无公开创建接口** | **无**；由 Agent 写回提案时产生，并广播 `approval.created` | **不适用**。这不是用户主动操作，CLI 不应伪造审批。 |

---

## 8. Trace（模型追踪）

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 查看追踪时间线 | 右栏 → 追踪 | `GET /api/trace/current` | **可 CLI**。只读，返回当前/历史条目、judgment、pendingJudgment；适合 `trace show`。 |
| 重新读取 / 展开长理由 | 追踪面板 → 重新读取 / 展开全文 | `GET /api/trace/current`；展开是前端状态 | **可 CLI**。数据读取可脚本化；展开/折叠不宜 CLI。 |
| 记录一次模型变更 | **无 UI**（服务端在 run 结束时自动记录） | `POST /api/trace/record`，body `{ sessionId?, runId?, changedFiles?, text?, at? }` | **可 CLI**。适合导入/回放历史，但普通用户不应手工调用；建议标为高级/内部命令。 |
| 记录人工判断 | 会话内 Trace HITL 卡 → 选“偏高/合理/偏低” → 记录判断 | `POST /api/trace/entries/:id/judge`，body `{ verdict: high / fair / low, note?, adopt? }` | **部分可 CLI**。参数清晰，但本质是人的判断；CLI 可做但必须显式传入 verdict/note，并避免默认采纳。 |
| 采纳提案并自动发起调整 | HITL → 确认采纳 / 只记录判断 | judge 返回 `adoption.prompt` 后，UI 再发消息：旧传输走 `POST /api/sessions/:id/messages`，CopilotKit 模式走 run | **部分可 CLI**。涉及跨接口编排和人工确认，不建议一条命令静默完成。 |
| 确认待定调整 | HITL 确认卡 → 确认调整 / 先不改 | `POST /api/trace/judgments/:id/confirm`，body `{ action: adjust / cancel }` | **部分可 CLI**。二选一明确；仍建议人工确认，尤其是 `adjust` 会触发后续写入。 |
| 重置追踪 | **无 UI**（开发/测试用） | `POST /api/trace/current/reset`，无 body | **不宜 CLI**。会从旧卡/文件重新播种，属于内部维护动作；如需保留，放 `debug trace reset` 并加环境限制。 |

---

## 9. CopilotKit / AG-UI

> 这两组是**传输层**，不是并列的业务功能。UI 默认走旧版会话 SSE；只有 URL 带 `?agentTransport=copilotkit` 或 `health.features.copilotkit === true` 时才安装 CopilotKit pilot。AG-UI 是 CopilotKit facade 的底层实现，也可被其他协议客户端直接调用。所有路径都受项目作用域约束。

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 读取协议信息 | 无直接 UI，pilot 初始化握手 | `GET /api/ag-ui/info`；`GET /api/copilotkit/info` | **内部 / 部分可 CLI**。只读元数据，可用于连通性检查；不是用户业务动作。 |
| 发送消息（pilot 模式） | 输入框 → 发送 | `POST /api/copilotkit/agent/pi/run`，body 含 `threadId?`、`messages`、`forwardedProps: { projectId, attachments, threadId? }`；返回 SSE | **部分可 CLI**。文本可脚本化；SSE、重连、附件、thread 生命周期都需处理。 |
| 直接使用 AG-UI 发送 | 无直接 UI（协议客户端） | `POST /api/ag-ui/agent/pi/run`，body `{ threadId?, messages, forwardedProps? }`；返回 SSE | **部分可 CLI**。与 CopilotKit run 同源，适合协议集成；不适合作为普通用户命令。 |
| 连接 / 重放 / 断线重连 | 刷新页面、网络恢复后自动执行 | `POST /api/copilotkit/agent/pi/connect`；`POST /api/ag-ui/agent/pi/connect`，body `{ threadId, afterEventId? }` 或 `Last-Event-ID` | **内部 / 部分可 CLI**。长连接重放逻辑复杂，CLI 只在做诊断或事件回放时需要。 |
| 停止 pilot 运行 | 停止按钮 | `POST /api/copilotkit/agent/pi/stop/:threadId`；`POST /api/ag-ui/agent/pi/stop/:threadId` | **可 CLI**。路径参数明确；无活动 run 时返回 `stopped: false`。 |
| 读取重连游标 | 刷新/重连时自动读取 | `GET /api/copilotkit/thread/:threadId/state` | **内部 / 可 CLI**。只读诊断接口；仅对当前进程内活跃 thread 有效，不打开新会话。 |

---

## 10. 测试桩（内部）

| 操作 | UI 入口 | API（方法 + 路径 + 关键参数） | CLI 评估与理由 |
| --- | --- | --- | --- |
| 播种审批场景 | 无 UI（浏览器测试用） | `POST /api/testing/approvals`，body `{ scenario? }`；仅 `WORKBENCH_TEST=1` 可用 | **内部 / 测试**。会生成真实文件与审批数据，不是用户动作，CLI 不应暴露。 |
| 播种 Dashboard 场景 | 无 UI | `POST /api/testing/dashboard`，body `{ scenario? }`；仅测试模式 | **内部 / 测试**。同上。 |
| 清理测试数据 | 无 UI | `POST /api/testing/reset`；仅测试模式 | **内部 / 测试**。破坏性测试清理，CLI 不应暴露。 |

---

## 11. 纯前端本地操作（无 HTTP）

这些操作在验收里也属于「用户能做什么」，但没有业务 API；列出来是为了避免把「界面状态」误判成接口缺口。

| 操作 | UI 入口 | API | CLI 评估与理由 |
| --- | --- | --- | --- |
| 切换当前项目 | 工作区菜单 | **无**；客户端保存 `localStorage` 并重拉项目数据 | **部分可 CLI**。CLI 用 `--project` 或本地配置表达，不需要模拟 UI。 |
| 切换当前会话 | 左栏会话列表 | **无**；客户端设置 activeSession 后读 state/SSE | **不宜 CLI**。CLI 用会话 id 作为参数即可。 |
| 资料筛选 / 面板开关 / 标签页 | 右栏筛选、面板按钮 | **无** | **不宜 CLI**。纯展示状态。 |
| 文件版本选择 | 文件弹窗版本列表 | **无写接口**；读取时用版本路径参数 | **可 CLI**。用 `--version` 表达即可。 |
| 复制路径 | 文件弹窗按钮 | **无**，剪贴板 API | **不宜 CLI**。直接打印路径。 |
| 引用资料到输入框 | 勾选 + 引用按钮 | **无**，前端 pending 状态 | **不宜 CLI**。用 `--file` 参数表达。 |
| Excel 缩放 / 冻结 / 值公式切换 | 预览工具栏 | **无**，前端渲染状态 | **不宜 CLI**。CLI 输出数据即可。 |
| 账户设置 | 左下角按钮 | **无**，当前无处理器 | **不宜 CLI**。属于未实现 UI。 |

---

## 12. 路由覆盖核对

| 路由族 | 覆盖位置 | 说明 |
| --- | --- | --- |
| `/api/health`、`/api/projects`、`/api/projects/:id` | 第 1 节 | 含 `PATCH` 的 API-only 管理动作 |
| `/api/sessions`、`/api/sessions/:id/*`、`/api/events` | 第 2 节 | 含 state/events/messages/abort/model |
| `/api/materials`、`/api/materials/:id/*`、`/api/upload`、`/api/file` | 第 3 节 | 含版本、工作簿、PDF、ASR、恢复、删除 |
| `/api/plans`、`/api/plans/:id/*` | 第 4 节 | 只有 list/toggle/run，无 create/edit/delete |
| `/api/trackings`、`/api/trackings/:id/*`、`/api/monitors/:id`、`/api/runs/:id/undo`、`/api/notifications` | 第 5 节 | 含 events/model/monitors/dashboard |
| `/api/watch`、`/api/watch/:id/*` | 第 6 节 | 含 overview/create/update/delete/check/messages/read/refresh/logs |
| `/api/approvals`、`/api/approvals/:id/*` | 第 7 节 | 含 list/detail/approve/reject |
| `/api/trace/current`、`/api/trace/current/reset`、`/api/trace/record`、`/api/trace/entries/:id/judge`、`/api/trace/judgments/:id/confirm` | 第 8 节 | record/reset 标为高级/内部 |
| `/api/ag-ui/*`、`/api/copilotkit/*` | 第 9 节 | 传输层，非并列业务域 |
| `/api/testing/*` | 第 10 节 | 仅测试模式，显式标内部 |

补充核对：

- 名称相近但不同的路由已区分：`GET /api/materials/:id/workbook`（摘要）与 `GET /api/materials/:id/versions/:v/workbook`（版本预览）；`POST /api/materials/:id/query` 与 Agent 工具 `workbook_query`。
- `POST /api/watch/:id` 是 `PATCH` 的别名，均走 `updateWatch`。
- `POST /api/trackings/:id/schedule` 与 `PATCH` 等价，均走 `updateTrackingSchedule`。
- `GET /api/materials/:id/versions/:v/file` 同时支持 `HEAD`；`GET /api/file` 不支持 HEAD。
- `POST /api/sessions/:id/messages` 在 AG-UI run 活跃时返回 409 `ag_ui_run_active`；反向 AG-UI run 遇到旧接口流式时返回 409 `thread_busy`。
- `/api/testing/*` 在非测试模式统一 404，不进入用户操作清单。

---

## 13. 可优先 CLI 化（按价值排序）

筛选原则：先做**只读、结构化、可重复执行**的；再做**单步写操作**；最后做需要长任务等待或人工判断的。共 13 条，落在要求的 5–15 条区间。

| 优先级 | 能力 | 为什么优先 | 风险 / 前置 |
| --- | --- | --- | --- |
| 1 | `doctor`：健康与能力检查 | 一条命令确认服务、模型、项目、调度器、ASR/搜索/web_fetch/calc 是否就绪；排障价值最高 | 只输出开关与版本，不输出密钥 |
| 2 | 资料上传、列表、下载 | 最高频的输入/输出动作；JSON + 文件流，参数清晰 | 上传大小上限、文件名编码、项目作用域 |
| 3 | 工作簿 / PDF 检索 | 把长文档阅读变成可脚本化的 `query` / `page`，对研究和自动化价值高 | 扫描 PDF 无文字；工作簿子图有 `maxCells` 限制 |
| 4 | 跟踪列表与立即运行 | 定时更新是核心卖点；`run` 可被 cron/CI 调用 | 运行 1–3 分钟，需 `--wait` 或轮询 |
| 5 | 盯盘状态与立即检查 | 只读状态 + 单步检查，适合每日巡检 | 检查会消耗搜索/模型额度；有 5 分钟单飞限制 |
| 6 | 计划列表、启用/暂停、运行 | 旧计划链路已有完整 API，包装成本低 | 计划运行异步；无创建/编辑 API |
| 7 | 通知列表与已读 | 适合 cron 拉取未读、接桌面/IM 通知 | 需要处理分页/limit |
| 8 | 会话发送与读取 | 让 Agent 能力进入脚本；`state` 可直接读结果 | 流式/附件/409 冲突；等待策略要设计 |
| 9 | 审批列表、批准、拒绝 | 模型写回是高风险动作，CLI 先做“看”，再做“批” | 必须人工确认；批准会真实写文件 |
| 10 | 监测项列表与检查 | 监测是跟踪的核心增量能力 | `check` 异步；自定义 items 结构复杂 |
| 11 | Trace 查看与人工判断 | 模型治理需要留痕；只读 + 单步判断 | 判断本质靠人；`adopt` 会触发后续写入 |
| 12 | 资料版本恢复 / 删除 / ASR | 版本与转写是常见运维动作 | 均为破坏性或计费动作，强确认 |
| 13 | Dashboard 读取 | 只读结构化 JSON，适合导出/报表 | 图表交互仍留在 UI |

### 13.1 CLI 命令分组草案（仅命名与参数草图）

> 以下是命名与参数草案，不是实现。统一全局参数：`--project <id>`、`--base-url <url>`、`--json`、`--yes`（危险动作）、`--wait`（长任务）。

```text
pe doctor [--json]

pe project list
pe project use <project-id>
pe project create --name <name> [--note <note>]
pe project update <project-id> [--name <name>] [--note <note>] [--accent <color>]

pe session list
pe session new
pe session show <session-id>
pe session send <session-id> --text <text> [--file <path> ...] [--wait]
pe session stop <session-id>
pe session model <session-id> --model deepseek-v4-pro|deepseek-flash

pe material list
pe material show <material-id>
pe material upload <path>...
pe material download <material-id> [--version <n>] [--output <path>]
pe material restore <material-id> --version <n> --yes
pe material delete <material-id> --yes
pe material query <material-id> --query <text> [--max-cells <n>]
pe material workbook <material-id> [--version <n>] [--sheet <name>]
pe material pdf <material-id> [--version <n>] [--page <range> | --query <text>] [--max-chars <n>]
pe material asr <material-id> [--version <n>] [--start] [--force] [--format txt|srt] [--wait]

pe plan list [--id <plan-id>]
pe plan show <plan-id>  # 由 list 结果过滤，当前无单条 GET
pe plan enable <plan-id>
pe plan disable <plan-id>
pe plan run <plan-id> [--wait]

pe track list
pe track show <tracking-id>
pe track create --target <material-id> [--template <id>] [--freq daily|weekly|monthly] [--weekday <1-7>] [--day <1-28>] [--time HH:MM] [--run-now]
pe track enable <tracking-id>
pe track disable <tracking-id>
pe track schedule <tracking-id> --freq <...> [--weekday <...>] [--day <...>] --time <HH:MM>
pe track run <tracking-id> [--wait]
pe track delete <tracking-id> --yes
pe track events <tracking-id>
pe track events add <tracking-id> --title <text> [--url <url>] [--snippet <text>] [--tier <n>]
pe track events refresh <tracking-id> [--wait]
pe track model show <tracking-id>
pe track model prepare <tracking-id>
pe track model bind <tracking-id> --file <json> --yes
pe track monitor list <tracking-id>
pe track monitor plan <tracking-id>
pe track monitor sync <tracking-id> [--file <json>]
pe track monitor check <tracking-id> [--item <id> ...] [--wait]
pe track monitor update <monitor-id> [--frequency <...>] [--status <...>] [--file <json>]

pe notification list [--unread] [--tracking <id>] [--limit <n>]
pe notification read <notification-id>

pe watch status
pe watch start [--interval-minutes <n>] [--deep-check-time HH:MM]
pe watch show <watch-id>
pe watch update <watch-id> [--enable|--disable] [--interval-minutes <n>] [--deep-check-time HH:MM]
pe watch delete <watch-id> --yes
pe watch check <watch-id> [--deep] [--wait]
pe watch ask <watch-id> --text <text> [--wait]
pe watch logs <watch-id> [--run <run-id>] [--limit <n>]
pe watch read <watch-id>
pe watch rebuild <watch-id>

pe approval list [--status <status>] [--tracking <id>] [--thread <id>]
pe approval show <approval-id>
pe approval approve <approval-id> --yes
pe approval reject <approval-id> --reason <text> --yes

pe trace show
pe trace judge <entry-id> --verdict high|fair|low [--note <text>] [--adopt]
pe trace confirm <judgment-id> --action adjust|cancel

pe run undo <run-id> --yes
pe dashboard get --tracking <tracking-id> [--run <run-id>] [--material-version <v>]
pe events tail [--session <session-id>]
```

命名说明：

- `material workbook` / `material pdf` 是「读取/检索」动词，避免和 Agent 工具同名造成误解。
- `track monitor` 单独成组，因为监测项有自己的 id 与契约。
- `approval`、`trace` 保留为一级组，强调它们需要人工判断，不做静默批处理。
- `events tail` 是长连接能力，默认不进入普通脚本；需要显式调用。

---

## 14. 附录 A：Agent 工具（与用户操作分开）

这些工具**不能由用户在资料面板直接点选**，只能经对话由 Agent 调用，或在跟踪/盯盘的后台 run 中调用。它们不是「用户操作」，所以不在第 1–10 节混排。

| 工具 | 用途 | 触发方式 | 对应 HTTP / 数据面 | 与 CLI 的关系 |
| --- | --- | --- | --- | --- |
| `read` | 读取项目内文本文件 | 对话/计划/跟踪 Agent | 文件系统；预览侧对应 `/api/file` | 不应单独 CLI 化，CLI 用 `material cat` 更直观 |
| `write` | 写项目内文件（受写根限制） | 对话/计划/跟踪 Agent | 写入后经 SSE 产生 material 更新 | 不直接 CLI 化；CLI 不应绕过审批/版本链 |
| `edit` | 局部编辑项目内文件 | 对话/计划/跟踪 Agent | 同上 | 同上 |
| `grep` | 按内容搜索项目文件 | 对话 Agent | 文件系统 | CLI 可用 `material grep` 包装，但当前无 HTTP |
| `find` | 按路径查找项目文件 | 对话 Agent | 文件系统 | 同上 |
| `ls` | 列目录 | 对话 Agent | 文件系统 | 同上 |
| `workbook_query` | 查询 `.xlsx/.xlsm` 的单元格、公式、上下游 | 对话/跟踪 Agent | `GET /api/materials/:id/workbook`、`POST /api/materials/:id/query` | 适合 `material query`；工具参数与 API 不完全相同 |
| `pdf_read` | 读 PDF 章节、指定页、检索、表格 | 对话/跟踪 Agent | `GET /api/materials/:id/versions/:v/pdf`、`POST /api/materials/:id/pdf/search` | 适合 `material pdf` |
| `asr_read` | 读取音频转写状态或全文 | 对话 Agent | `GET /api/materials/:id/versions/:v/asr` | 适合 `material asr show`；启动转写仍走 POST |
| `create_tracking` | 用自然语言建立跟踪，并可激活监测项 | 对话 Agent | `POST /api/trackings`、`POST /api/trackings/:id/monitors/activate` | CLI 可用 `track create`，但应要求显式参数，不解析自然语言 |
| `westock_query` | 查询行情、财报、公告、资金、宏观 | 对话/跟踪/盯盘 Agent | 服务端 `westock` CLI；无对应 HTTP | 不宜直接暴露为 `pe` 一级命令；属于数据源适配 |
| `anysearch_search` | 公开互联网搜索 | 对话/跟踪/盯盘 Agent | 外部 AnySearch；无对应 HTTP | 同上 |
| `deepseek_search` | 公开网页搜索（支持 `site:` / `after:`） | 对话/跟踪/盯盘 Agent | DeepSeek Search；无对应 HTTP | 同上 |
| `deepseek_fetch` | 抓取网页正文，适合 Reuters 等 | 对话/跟踪/盯盘 Agent | DeepSeek Fetch；无对应 HTTP | 同上 |
| `web_fetch` | 读取用户给出的具体 http(s) 链接 | 对话 Agent | 外部网页；无对应 HTTP | CLI 可另做 `web fetch`，但不要与业务 API 混在一起 |

安全与边界：

- 工具运行在项目上下文内，`read`/`write`/`edit` 等受项目路径和写根限制；本仓库的 Agent 没有 `bash` 工具。
- `web_fetch` / `anysearch_search` / `deepseek_search` 返回的是外部不可信内容，只能当资料，不能当指令。
- 本文不记录、不回显任何 API Key；`/api/health` 只返回 capability，不返回 secret。
- `workbook_query`、`pdf_read`、`asr_read` 与 HTTP 解析接口共享底层存储，但工具参数、错误语义和截断策略可能不同，CLI 应以 HTTP 契约为准。

---

## 15. 缺口与后续建议

### 15.1 有 API、但当前没有清晰 UI 动作

| 能力 | 现状 | 建议 |
| --- | --- | --- |
| 项目改名 / 备注 / 主题色 | `PATCH /api/projects/:id` 已实现，UI 只有新建 | 补项目设置；CLI 可先做 `project update` |
| 计划创建 / 编辑 / 删除 | 只有 list/toggle/run；无 create/update/delete API 与 UI | 先定义 API，再谈 CLI；当前不要造“伪创建” |
| 跟踪删除 | `DELETE /api/trackings/:id` 已实现，详情没有删除按钮 | 补 UI 或明确只允许 CLI/管理端 |
| 手动来源事件 | `POST /api/trackings/:id/events` 已实现，UI 只展示/刷新 | 补“导入线索”或只保留自动化入口 |
| 模型绑定编辑 | `POST /api/trackings/:id/model/bindings` 已实现，UI 只展示 | 补“确认绑定/启用写回”界面；CLI 必须二次确认 |
| 监测方案编辑 | `POST .../monitors/plan`、`PATCH /api/monitors/:id` 已实现，UI 只能同步/检查 | 补方案预览与逐项编辑 |
| 审批详情 / 历史过滤 | `GET /api/approvals/:id` 与过滤参数已实现，UI 只展示卡片 | 补审批中心或 CLI 先覆盖 |
| Trace 记录 / 重置 | `POST /api/trace/record`、`POST /api/trace/current/reset` 已实现，UI 无入口 | 标为内部/开发工具；不要做普通用户命令 |
| 资料级 ASR / PDF / 工作簿摘要 | 已有 API，部分只被 Agent 或列表使用 | 若要 CLI，直接按 HTTP 契约实现，不必等 UI |
| Watch 间隔 / 深度复核时间 | API 接受，UI 不展示（产品口径是服务端默认） | CLI 若暴露，应标注“运维参数”，并提示成本 |

### 15.2 有 UI、但没有业务 API

| 能力 | 现状 | 结论 |
| --- | --- | --- |
| 账户设置 | 左下角按钮，无处理器 | 未实现；不是 CLI 缺口 |
| 复制路径 / 引用到输入框 / 筛选 / 折叠面板 | 浏览器本地状态或剪贴板 | 不应为它们造 API |
| 版本选择 / Excel 缩放 / 值公式切换 | 前端渲染状态 | CLI 用 `--version` 或直接输出数据表达 |

### 15.3 接口层面缺口

- **计划缺少写接口**：无法创建、编辑、删除计划，也无法改 prompt/频率/目标；这是当前最大的自动化缺口。
- **项目缺少删除接口**：只有创建与 patch。
- **会话缺少删除/重命名接口**：目前只有 list/create/state/events/messages/abort/model。
- **资料缺少重命名/移动接口**：只有上传、索引、删除、恢复版本。
- **审批没有公开创建接口**：审批由 Agent 提案产生，CLI 只能消费，不能主动发起。
- **没有鉴权/多用户模型**：当前 CLI 若暴露到网络，需要额外的访问控制；本文不把“加鉴权”当作 CLI 任务，但必须作为部署前置。
- **长任务统一等待语义缺失**：tracking run、plan run、watch check、monitor check、approval apply 都是异步；CLI 需要统一 `--wait`、超时、退出码和结果查询方式。

### 15.4 建议的落地顺序

1. **只读命令先落地**：`doctor`、`material list/show/download`、`track list/show`、`watch status/logs`、`plan list`、`notification list`、`trace show`。
2. **单步写命令**：`material upload`、`material restore/delete`、`track create/toggle/schedule/run`、`plan toggle/run`、`notification read`、`watch start/check`。
3. **需要人工确认的命令**：`approval approve/reject`、`trace judge/confirm`、`run undo`、`material delete`，统一 `--yes` 和结果摘要。
4. **最后做长连接/复杂编排**：`session send --wait`、`events tail`、`watch ask --wait`、AG-UI/CopilotKit 客户端。

---

## 16. 维护与复核

- 路由以 `server/create-app.mjs` 的 `handleApi()` 分发和 `server/routes/*.mjs` 的 `pathname` 判断为准；本文按 2026-10-29 的代码盘点。
- 新增路由时，至少补三件事：本文对应功能域表格、第 12 节覆盖核对、第 13 节是否进入优先 CLI 列表。
- 新增 UI 操作时，先判断它是否只是本地状态；只有产生服务端读写或文件流时才需要 API 行。
- 变更 `docs/` 之外的文件不属于本 Issue；本文不包含 CLI 实现、不改 `server/`、`ui/`、`package.json`，也不自动 commit/push。
