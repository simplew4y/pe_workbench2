# UI 操作 ↔ pe 命令对照

面向日常查阅：左侧是界面上用户能做的操作，右侧是等价 CLI。详细参数、`--wait`/`--yes` 语义见 [`cli.md`](./cli.md)；盘点与缺口见 [`user-ops-api-cli.md`](./user-ops-api-cli.md)。

前提：本地服务已启动（默认 `http://127.0.0.1:8080`）。

```bash
node bin/pe.mjs <命令> …          # 或 npm link 后用 pe
pe doctor --json                  # 确认服务可达
```

全局常用：`--project <id>` · `--base-url <url>` · `--json` · `--yes` · `--wait[=秒]`

---

## 1. 健康 / 项目

| UI 操作 | CLI |
| --- | --- |
| 打开应用时的健康/能力探测 | `pe doctor` |
| 查看工作区/项目列表 | `pe project list` |
| 把某项目设为当前（浏览器存本地；CLI 写 `~/.pe/config.json`） | `pe project use <project-id>` |
| 新建项目 | `pe project create --name "…" [--id …] [--note …] [--accent …]` |
| （无 UI）改名称/备注/主题色 | `pe project update <project-id> --name …` |
| 删除项目 | **无 API / 无 CLI** |

## 2. 会话

| UI 操作 | CLI |
| --- | --- |
| 会话列表 | `pe session list` |
| 新建会话 | `pe session new [--title …]` |
| 打开会话、看消息 | `pe session show <session-id>` |
| 发送消息（可带附件） | `pe session send <session-id> --text "…" [--file path…] [--wait]` |
| 停止生成 | `pe session stop <session-id>` |
| 切换会话模型 | `pe session model <session-id> --model deepseek-flash` |
| 删除/重命名会话 | **无 API / 无 CLI** |

说明：`session send` 走 `POST /api/sessions/:id/messages`，不是 CopilotKit/AG-UI 客户端。

## 3. 资料

| UI 操作 | CLI |
| --- | --- |
| 资料列表 | `pe material list` |
| 打开资料详情 | `pe material show <material-id>` |
| 上传文件 | `pe material upload <本地路径…>` |
| 预览任意项目内文件 | `pe material file <relPath>` |
| 下载某版本 | `pe material download <material-id> [--version N] [--out path]` |
| 恢复历史版本 | `pe material restore <material-id> --version N --yes` |
| 删除资料 | `pe material delete <material-id> --yes` |
| Excel 结构/查询 | `pe material workbook <id>…` / `pe material query <id> …` |
| PDF 摘要/页/检索 | `pe material pdf <id> …` |
| 音频转写查看/启动/下载 | `pe material asr <id> … [--start] [--wait]` |
| 资料筛选 Tab、缩放、冻结、复制路径 | **纯前端 / 无 CLI**（CLI 直接输出 path） |

## 4. 计划

| UI 操作 | CLI |
| --- | --- |
| 计划列表 | `pe plan list` |
| 查看计划 | `pe plan show <plan-id>` |
| 启用 / 暂停 | `pe plan enable <id>` / `pe plan disable <id>` |
| 立即运行 | `pe plan run <id> [--wait]` |
| 新建 / 编辑 / 删除计划 | **无 API / 无 CLI** |

## 5. 自动更新（跟踪）

| UI 操作 | CLI |
| --- | --- |
| 跟踪列表 / 详情 | `pe track list` / `pe track show <id>` |
| 新建跟踪 | `pe track create …` |
| 启用 / 暂停 | `pe track enable <id>` / `pe track disable <id>` |
| 调整排期 | `pe track schedule <id> …` |
| 立即运行 | `pe track run <id> [--wait]` |
| 删除跟踪 | `pe track delete <id> --yes` |
| 来源事件查看/刷新 | `pe track events <id>` / `pe track events refresh <id>` |
| 模型写回：查看 / 准备 / 绑定 | `pe track model show\|prepare\|bind <id> …`（bind 需 `--yes`） |
| 监测项列表/同步/检查/更新 | `pe track monitor list\|sync\|check\|update …`（check 可 `--wait`） |

## 6. 通知 / 运行 / Dashboard

| UI 操作 | CLI |
| --- | --- |
| 通知列表 | `pe notification list` |
| 标记已读 | `pe notification read <notification-id>` |
| 撤销一次跟踪运行 | `pe run undo <run-id> --yes` |
| 打开 Dashboard | `pe dashboard get [--run …] [--version …]` |

## 7. 盯盘（Watch）

| UI 操作 | CLI |
| --- | --- |
| 盯盘总览 | `pe watch status` |
| 开始盯住 | `pe watch start …` |
| 查看 / 更新设置 | `pe watch show <id>` / `pe watch update <id> …` |
| 删除 | `pe watch delete <id> --yes` |
| 立即检查 | `pe watch check <id> [--wait]` |
| 向盯盘助手提问 | `pe watch ask <id> --text "…" [--wait]` |
| 检查日志 | `pe watch logs <id>` |
| 标记消息已读 | `pe watch read <id> …` |
| 按最新报告重建关注点 | `pe watch rebuild <id>` |

## 8. 审批 / Trace / 实时事件

| UI 操作 | CLI |
| --- | --- |
| 审批列表 / 详情 | `pe approval list` / `pe approval show <id>` |
| 批准写回 | `pe approval approve <id> --yes` |
| 拒绝写回 | `pe approval reject <id> --reason "…" --yes` |
| 追踪时间线 | `pe trace show` |
| 人工判断 | `pe trace judge …`（`--adopt` 需 `--yes`） |
| 确认待定调整 | `pe trace confirm …`（adjust 需 `--yes`） |
| 页面 SSE 实时事件 | `pe events tail [--session …] [--json]` |

## 9. 明确不做（有 UI 或看起来像操作，但无 CLI）

| 操作 | 原因 |
| --- | --- |
| 面板折叠、会话高亮、资料 Tab、Excel 缩放/冻结 | 纯前端状态 |
| 账户设置 | 无绑定处理器、无 API |
| 删除项目 / 删改会话 / 新建编辑删除计划 | 无对应业务 API |
| AG-UI / CopilotKit connect·run·stop | 传输层；用 `session send/stop` |
| Agent 工具（westock / anysearch / deepseek_search…） | 无用户 HTTP；经对话触发 |
| `/api/testing/*`、`trace record/reset` | 测试/内部维护 |

---

维护：CLI 子命令变更时，同步改本表与 `docs/cli.md` §5–§6。云电脑冒烟：`pe doctor --json` 应对常驻 `npm start`（默认 8080）。
