# `pe` CLI

`pe` 是 pe_workbench2 的命令行客户端。它不直接读写数据库，也不复制业务逻辑，而是调用本地服务现有的 `/api/*` HTTP 接口。UI 能完成、且背后有业务 API 的操作，尽量在 CLI 中一一对应；没有 API 的界面状态不伪造命令。

- 用户操作 / API / CLI 可行性盘点：[`docs/user-ops-api-cli.md`](./user-ops-api-cli.md)（§13、§13.1、§15）
- **操作 ↔ 命令一览表**：[`docs/ops-cli-map.md`](./ops-cli-map.md)
- 服务端路由以 `server/create-app.mjs` 的 `handleApi()` 分发为准
- 当前 CLI 入口：`bin/pe.mjs`；实现：`cli/`

## 1. 安装与运行

无需全局安装即可运行：

```bash
node bin/pe.mjs --help
node bin/pe.mjs doctor
```

安装到当前 Node 环境（会按 `package.json` 的 `bin` 字段创建 `pe` 命令）：

```bash
npm install
npm link          # 或者：npm install -g .
pe --help
```

也可以直接在仓库里用 npm 脚本跑测试：

```bash
npm run test:cli
```

先启动服务：

```bash
npm start
# 默认 http://127.0.0.1:8080
```

CLI 默认连接 `http://127.0.0.1:8080`。服务不在默认地址时：

```bash
pe doctor --base-url http://127.0.0.1:18080
```

## 2. 全局参数

| 参数 | 说明 |
| --- | --- |
| `--base-url <url>` | 服务地址。优先级：参数 > `PE_BASE_URL` > `~/.pe/config.json` 的 `baseUrl` > `http://127.0.0.1:8080`（若设置了 `PORT` 且非 0，则用该端口）。 |
| `--project <id>` | 项目 id，作为 `?project=` 附加到项目数据请求。优先级：参数 > `PE_PROJECT` > `~/.pe/config.json` 的 `project` > 服务端默认项目。 |
| `--json` | 机器可读输出。除 `events tail` 外，stdout 是一条完整的 JSON；错误只写 stderr。 |
| `--yes` | 确认危险写操作。delete / restore / approve / reject / undo / 模型绑定 / 采纳判断等默认拒绝。 |
| `--wait[=seconds]` | 等待长任务结束，默认 120 秒。也可用 `--timeout <seconds>` 覆盖。 |
| `--help`, `-h` | 显示当前命令帮助。`pe --help` 和每个子命令的 `--help` 都可用。 |
| `--cli-version` | 显示 CLI 版本（取自 `package.json`）。资料命令的 `--version` 是版本号，二者不冲突。 |

全局参数可以放在子命令前或后，例如 `pe --json material list` 与 `pe material list --json` 等价。

### 2.1 本地默认项目（可选）

`pe project use <project-id>` 只改本地文件，不调用服务端写接口：

```bash
pe project use product-eng
pe material list          # 自动带上 --project product-eng
```

配置文件默认是 `~/.pe/config.json`，可用 `PE_CONFIG` 指向别的路径。文件只保存 `project`（以及可选的 `baseUrl`），**不保存任何 API Key 或 secret**。

```json
{
  "project": "product-eng",
  "baseUrl": "http://127.0.0.1:8080"
}
```

## 3. `--wait` 语义与退出码

`--wait` 统一表示“命令已经成功发起后，继续轮询直到后台任务结束”：

| 命令 | 等待条件 |
| --- | --- |
| `session send --wait` | 会话不再 streaming，且消息数超过发送前 |
| `plan run --wait` | 计划 DTO 的 `running` 变为 false |
| `track run --wait` | 跟踪 DTO 的 `running` 变为 false |
| `track monitor check --wait` | 跟踪运行结束 |
| `watch check --wait` | 出现新的检查记录且状态不再 running；无候选时会在短暂等待后返回总览 |
| `watch ask --wait` | 出现该问题之后的 assistant 回答 |
| `material asr --start --wait` | 转写状态变为 `done`；`failed/unconfigured/paused` 直接失败 |

约定：

- 默认超时 **120 秒**；`--wait=30` 或 `--timeout 30` 可改。
- 超时不是成功：命令以非零退出码结束，stderr 说明超时秒数和最后状态。
- `--wait` 只管“等多久”，不会把异步接口变成同步接口；不带 `--wait` 时命令会立即输出启动结果（runId/sessionId 等），供脚本自行轮询。
- 服务端自身还有更长的运行上限（例如 tracking/watch 的 watchdog），CLI 的 120 秒只是客户端等待上限。

退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 成功（含 `--help`） |
| `1` | HTTP 错误、网络错误、业务失败、`--wait` 超时 |
| `2` | 参数错误、未知命令、缺少 `--yes` 的危险操作 |
| `130` | 终端中断 `events tail` 等长连接（由 Node 处理 SIGINT） |

## 4. 命令总览

```text
pe doctor

pe project list | use | create | update

pe session list | new | show | send | stop | model

pe material list | show | upload | file | download | restore | delete
           query | workbook | pdf | asr

pe plan list | show | enable | disable | run

pe track list | show | create | enable | disable | schedule | run | delete
         events [add|refresh]
         model [show|prepare|bind]
         monitor [list|plan|sync|check|update]

pe notification list | read

pe watch status | start | show | update | delete | check | ask | logs | read | rebuild

pe approval list | show | approve | reject

pe trace show | judge | confirm

pe dashboard get
pe run undo
pe events tail
```

所有命令都支持 `--help`。完整参数以 `pe <group> <command> --help` 为准。

### 4.1 健康检查

```bash
pe doctor
pe doctor --json
```

`doctor` 调用 `GET /api/health`，只输出模型、项目、调度器开关和 capability（ASR/搜索/Web Fetch/Calc 等）。**不输出任何密钥**。`workbook/pdf` 能力没有在该接口暴露，可用 `material workbook` / `material pdf` 实际探测。

### 4.2 项目

```bash
pe project list
pe project use product-eng
pe project create --name "新项目" --note "备注"
pe project update <project-id> --name "改名" --accent "#3366ff"
```

`project use` 是本地默认项目，不修改服务端。项目删除没有 API，CLI 不提供。

### 4.3 会话

```bash
pe session list
pe session new
pe session show <session-id>
pe session send <session-id> --text "帮我看看这份资料" --file report.xlsx --wait
pe session stop <session-id>
pe session model <session-id> --model deepseek-flash
```

- `session send` 走现有的 `POST /api/sessions/:id/messages`（旧版传输），不是 CopilotKit/AG-UI 协议客户端。
- `session model` 默认使用 `deepseek-flash`；需要推理模型时显式传 `--model deepseek-v4-pro`。
- `--file` 会先调用 `POST /api/upload`，再把返回的项目内相对路径作为 attachments。这与 UI 的附件流程一致。
- AG-UI run 活跃时服务端返回 409 `ag_ui_run_active`；CLI 原样报错。此时应先用 UI 或等待 run 结束。
- `--wait` 通过轮询 `GET /api/sessions/:id/state` 判断流式结束。

### 4.4 资料

```bash
pe material list
pe material show <material-id>
pe material upload ./a.pdf ./b.xlsx
pe material file exports/report.md --output -
pe material download <material-id> --version 2 --output ./downloads/
pe material restore <material-id> --version 2 --yes
pe material delete <material-id> --yes
pe material query <material-id> --query "毛利" --max-cells 200
pe material workbook <material-id> --version 1 --sheet Sheet1
pe material pdf <material-id> --version 1 --page 2-4
pe material pdf <material-id> --version 1 --query "风险因素" --max-chars 8000
pe material asr <material-id> --start --wait
pe material asr <material-id> --version 1 --format srt --output ./transcript.srt
```

- 上传使用原始字节流和 `X-File-Name`，不是 multipart；音频上限 120 MB，其他文件 30 MB。
- `download` 默认写当前目录下的原文件名；`--output -` 把二进制写到 stdout。
- 能力开关 `WORKBOOK_QUERY=0` / `PDF_READ=0` / `ASR=0` 时，对应接口返回 404 `disabled`，CLI 会把该错误原样报出，不会伪装成空结果。
- `material asr --format` 不主动启动转写；需要先 `--start`，或由上传/恢复自动排队。

### 4.5 计划

```bash
pe plan list
pe plan list --id <plan-id>
pe plan show <plan-id>
pe plan enable <plan-id>
pe plan disable <plan-id>
pe plan run <plan-id> --wait
```

服务端没有单条 `GET /api/plans/:id`，`plan show` 由 `GET /api/plans` 过滤。`enable/disable` 基于现有 toggle 接口实现幂等语义：已经是目标状态时不重复调用。

**没有** create / edit / delete API，因此 CLI 不造“伪创建/伪编辑”。

### 4.6 跟踪 / 来源事件 / 模型 / 监测项

```bash
pe track list
pe track show <tracking-id>
pe track create --target <material-id> --freq weekly --weekday 5 --time 09:00
pe track create --target <material-id> --run-now
pe track enable <tracking-id>
pe track disable <tracking-id>
pe track schedule <tracking-id> --freq monthly --day 15 --time 10:30
pe track run <tracking-id> --wait
pe track delete <tracking-id> --yes

pe track events <tracking-id>
pe track events add <tracking-id> --title "线索" --url https://example.com --snippet "..."
pe track events refresh <tracking-id>

pe track model show <tracking-id>
pe track model prepare <tracking-id>
pe track model bind <tracking-id> --file bindings.json --yes

pe track monitor list <tracking-id>
pe track monitor plan <tracking-id>
pe track monitor sync <tracking-id>
pe track monitor sync <tracking-id> --file monitor-plan.json
pe track monitor check <tracking-id> --item <monitor-id> --wait
pe track monitor update <monitor-id> --frequency daily --status active
```

`track model bind` 的 JSON 形如：

```json
{
  "bindings": [{ "metric": "收入", "sheet": "Model", "cell": "B2", "kind": "input", "verified": true }],
  "outputs": [{ "label": "目标价", "sheet": "Model", "cell": "B20" }],
  "writeEnabled": false
}
```

该命令会真实修改跟踪状态文件，默认拒绝，必须 `--yes`。`track monitor update` 接受嵌套字段时可用 `--file` 传对象。

### 4.7 通知

```bash
pe notification list
pe notification list --unread --limit 50
pe notification list --tracking <tracking-id>
pe notification read <notification-id>
```

### 4.8 盯盘

```bash
pe watch status
pe watch start --interval-minutes 30 --deep-check-time 18:30
pe watch show <watch-id>
pe watch update <watch-id> --disable
pe watch update <watch-id> --interval-minutes 60
pe watch delete <watch-id> --yes
pe watch check <watch-id> --deep --wait
pe watch ask <watch-id> --text "今天有什么新风险？" --wait
pe watch logs <watch-id> --run <check-id> --limit 200
pe watch read <watch-id>
pe watch rebuild <watch-id>
```

`--interval-minutes` / `--deep-check-time` 是运维参数，UI 目前不展示；检查会消耗搜索/模型额度。`watch check --wait` 在没有候选、服务端跳过检查时不会无限等，会在短暂等待后返回当前总览。

### 4.9 审批

```bash
pe approval list --status pending
pe approval list --tracking <tracking-id>
pe approval show <approval-id>
pe approval approve <approval-id> --yes
pe approval reject <approval-id> --reason "假设不成立" --yes
```

批准会真实写文件；拒绝必须提供 `--reason`。两者都需要 `--yes`。

### 4.10 Trace

```bash
pe trace show
pe trace judge <entry-id> --verdict fair --note "假设仍成立"
pe trace judge <entry-id> --verdict high --adopt --yes
pe trace confirm <judgment-id> --action adjust --yes
pe trace confirm <judgment-id> --action cancel
```

`trace judge` 不做 silent batch；`--adopt` 和 `confirm --action adjust` 会触发后续写入，需要 `--yes`。`record` / `reset` 被刻意保留为内部/开发接口，没有做成普通用户命令。

### 4.11 Dashboard / 撤销

```bash
pe dashboard get --tracking <tracking-id>
pe dashboard get --tracking <tracking-id> --run <run-id>
pe dashboard get --tracking <tracking-id> --material-version 3
pe run undo <run-id> --yes
```

Dashboard 只读，输出服务端校验过的 JSON。撤销会恢复运行前版本并写通知，必须 `--yes`。

### 4.12 实时事件

```bash
pe events tail
pe events tail --session <session-id>
pe events tail --json
```

`events tail` 是 SSE 长连接，默认不进入普通脚本。人类模式每行输出时间、事件类型和简短摘要；`--json` 输出 **NDJSON**（每个事件一行完整 JSON，不是单个 JSON 数组）。按 Ctrl-C 退出。

## 5. 与 UI 的对照

逐个操作的详细盘点见 [`docs/user-ops-api-cli.md`](./user-ops-api-cli.md)。下表只列命令组与 UI 入口的对应关系：

| UI 入口 | UI 动作 | CLI |
| --- | --- | --- |
| 页面加载 | 健康检查 | `pe doctor` |
| 左上工作区菜单 | 项目列表 / 新建项目 | `pe project list` / `pe project create` |
| 工作区菜单（无 UI 的 API-only 管理） | 改名称/备注/主题色 | `pe project update` |
| 左栏会话 | 列表、新建、打开、发送、停止、切模型 | `pe session list/new/show/send/stop/model` |
| 右栏「资料」 | 列表、上传、预览、版本、下载、恢复、删除 | `pe material list/show/upload/file/download/restore/delete` |
| 资料预览（Excel/PDF/音频） | 结构、查询、指定页、检索、ASR | `pe material workbook/query/pdf/asr` |
| 任务条 / `#task=` | 计划列表、启用/暂停、立即运行 | `pe plan list/show/enable/disable/run` |
| 右栏「自动更新」 | 跟踪列表/详情、新建、暂停、排期、立即运行 | `pe track list/show/create/enable/disable/schedule/run` |
| 跟踪详情「监测项」 | 查看、同步、检查 | `pe track monitor list/sync/check` |
| 跟踪详情「模型写回」 | 查看、准备、绑定 | `pe track model show/prepare/bind` |
| 跟踪详情来源区 | 查看/刷新来源 | `pe track events/events refresh` |
| 顶部通知铃铛 | 通知列表、标记已读 | `pe notification list/read` |
| 右栏「盯」 | 总览、开始、设置、删除、检查、提问、日志、已读、重建 | `pe watch status/start/show/update/delete/check/ask/logs/read/rebuild` |
| 会话流审批架 | 审批列表、详情、批准、拒绝 | `pe approval list/show/approve/reject` |
| 右栏「追踪」 | 时间线、人工判断、确认调整 | `pe trace show/judge/confirm` |
| 跟踪详情 Dashboard | 读取 Dashboard | `pe dashboard get` |
| 通知卡 / 跟踪详情通知区 | 撤销一次运行 | `pe run undo` |
| 页面 SSE | 实时事件 | `pe events tail` |

## 6. 未 CLI 化及原因

### 6.1 纯前端状态，无业务 API

这些操作没有服务端读写，做成 CLI 没有业务意义；CLI 用参数或直接输出替代：

| 操作 | 原因 / CLI 替代 |
| --- | --- |
| 切换当前项目 | 浏览器 `localStorage` 状态；CLI 用 `--project` / `pe project use` |
| 切换当前会话、会话高亮 | 前端状态；CLI 把 session id 作为参数 |
| 面板折叠、资料筛选 Tab、标签页 | 纯展示状态 |
| 复制文件路径 | 浏览器剪贴板；CLI 直接输出 `path` / `relPath` |
| 引用资料到输入框 | 前端 `pending` 状态；CLI 用 `session send --file` |
| 文件版本选择 | 前端弹窗状态；CLI 用 `--version` |
| Excel 缩放、冻结、值/公式切换 | 前端渲染状态；CLI 输出结构/数据 |
| 账户设置 | 当前按钮没有绑定处理器，也没有 API |
| 打开外链发现来源 | 浏览器跳转；CLI 输出 URL |

### 6.2 有 UI、但服务端没有 API

| 操作 | 缺口 |
| --- | --- |
| 删除项目 | 无 `DELETE /api/projects/:id` |
| 新建/编辑/删除计划 | 只有 list/toggle/run，无 create/update/delete |
| 删除/重命名会话 | 只有 list/create/state/events/messages/abort/model |
| 重命名/移动资料 | 只有上传、索引、删除、恢复版本 |
| 创建审批 | 审批由 Agent 提案产生，无公开创建接口 |
| 账户设置 | 无处理器、无接口 |

### 6.3 刻意省略或仅内部使用

| 能力 | 原因 |
| --- | --- |
| `POST /api/trace/record`、`POST /api/trace/current/reset` | 内部/开发维护动作；普通用户命令不暴露，避免误重置历史 |
| `/api/testing/*` | 仅 `WORKBENCH_TEST=1` 测试桩，不是用户操作 |
| `/api/ag-ui/*`、`/api/copilotkit/*` 的 run/connect/stop | 传输层协议客户端；CLI 的 `session send/stop` 走现有 messages/abort 路径，不复制第二套协议 |
| Agent 工具 `westock_query`、`anysearch_search`、`deepseek_search`、`deepseek_fetch`、`web_fetch` | 没有对应 HTTP 用户接口，属于对话/后台 Agent 数据源适配，不作为 `pe` 一级命令 |
| `material grep/find/ls`、Agent 的 `write/edit` | 没有 HTTP 接口；CLI 不绕过审批/版本链直接写项目文件 |
| 计划单条 GET | 服务端没有该路由；`plan show` 由 list 过滤，行为等价但会取全量列表 |

### 6.4 安全边界

- 仓库和 CLI 输出都不包含 API Key；`doctor` 只显示 capability 的 `configured` 布尔值。
- CLI 连接的是本地服务，当前项目没有鉴权/多用户模型。若把服务暴露到网络，需要额外的访问控制（不在本 CLI 范围内）。
- 危险操作必须显式 `--yes`；拒绝原因和 trace 判断等需要人输入的字段不会被默认填充。
- `--json` 模式下 stdout 只放结果，诊断信息走 stderr。
