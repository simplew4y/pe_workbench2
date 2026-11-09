# CELL-CITE 开发摘要

| 字段 | 内容 |
|------|------|
| 分支 | `feat/cell-citations` |
| 基线 | `main` @ `6c3a1af` |
| 执行器 | DeepSeek / `dsh` |
| 状态 | P0 / P1 / P2 完成；P3 未做 |
| 推送 | **未 push / 未 merge** |

## 提交

| 切片 | Commit | 内容 |
|------|--------|------|
| P0 | `3919dd5` | Citation 契约 + workbook_query/workbook_trace/unit_convert/ratio 产出 `details.citations` |
| P1 | `3f9a48c` | `unverified_locator` 软告警 + 每轮最多一次引用纠正 |
| P2 | `1f9f86d` | 已核验 locator 渲染为可点 chip、点击打开 Excel 预览、citation 持久化 |

## 核心不变量

- **可点引用 ⊆ 本轮工具 citations**：UI 只把 `tool.citations` 中 `materialId + locator` 都存在的坐标变成按钮。
- 没有 citation 的 `Sheet!A1` 永不伪造链接：无 citation 时保持纯文本；同一条消息有 citation 时，未核验坐标渲染为 `<span class="cell-ref-unverified">`（不可点）。
- 工具 miss 返回空 citations，不补造 locator。
- `unit_convert` / `ratio` 只有在调用方传入 `citations` 时才产出结果 citation 与 `derivedFrom`；未传则 `citations: []`。
- 答文 lint 的 `unverified_locator` 是 **warning**；自动纠正最多 1 次，prompt 明确要求“不改数字、单位、结论或格式”。

## 文件

### P0 · 契约与工具

- `lib/contracts/citation.mjs`：TypeBox `Citation` / `CitationInput` 契约，`validateCitation` / `validateCitations` / `validCitations`。
- `lib/citation-locator.mjs`：纯 A1 locator 解析/规范化（支持 `Sheet!A1`、`Sheet!A1:B2`、引号 sheet、`$`）。
- `lib/citations.mjs`：从 query/trace 单元格生成 citation、派生 citation、会话汇总、按 locator 建索引。
- `lib/workbook-tool.mjs`：`details.citations`（含 `toolCallId`、materialId、version、locator、value、role）。
- `lib/workbook-trace-tool.mjs`：target / direct / tree / range / path / impact 中的真实格 → citations；空单元格不产出。
- `lib/calc-tool.mjs`：`unit_convert` / `ratio` 新增可选 `citations` 入参，结果 citation 带 `derivedFrom`。
- `scripts/test-citations.mjs`：C1 命中格有 citation；C2 miss 无可点 citation；C3 派生 citation/derivedFrom；C4 schema 拒收缺 materialId/locator。

### P1 · 答文对齐

- `lib/answer-lint.mjs`：新增 `unverified_locator`（code `L2`，severity `warning`）；只有调用方传入 `context.citations` 时才启用，旧调用行为不变。
- `server/agent/post-answer.mjs`：每轮从 tool events / tool messages 汇总 citations，注入 lint；引用纠正最多 1 次，`answerLint.citations` 持久化到 custom entry。
- `scripts/test-answer-lint.mjs`：L1 已核验；L2 未核验；L3 引号/区域归一化；L4 无坐标不报。
- `scripts/test-post-answer.mjs`：未核验触发 1 次纠正；已核验不纠正；prompt 不改数字。

### P2 · UI 与刷新

- `ui/chat/cell-citations.js`：纯函数 `linkCitations(textHtml, citations)`；只认 citations；已存在的 `<a>/<button>` 不再嵌套；HTML 属性转义。
- `ui/chat/renderer.js`：消息正文合并本条消息所有 `tool.citations` 后调用 `linkCitations`；live 消息同样处理。
- `ui/bootstrap.js`：点击 `[data-cell-cite]` → `openFile(materialId, version, locator)`；live `tool.completed` 接收 citations。
- `ui/previews/previews.js`：`gotoXlsxCell` 支持区域（跳到锚点）和带引号 sheet 名。
- `store.mjs`：新增 `tool_citations` 表与 `save/get/listToolCitations`。
- `server/agent/event-bridge.mjs`：校验并持久化 `details.citations`，同时向 live SSE 广播。
- `server/agent/snapshot.mjs`：刷新后把持久化 citations 放回 `tool.citations`，供消息渲染。
- `styles.css`：`.cell-cite` / `.cell-ref-unverified` 样式。
- `scripts/test-cell-cite-render.mjs`：U1 已核验可点；U2 无 citations 不可点；U3 引号/区域/$ 归一化；U4 混合答案只有已核验项可点且幂等；U5 注入转义；U6 snapshot 刷新仍有 citations；U7 event bridge 持久化。
- `package.json`：新增 `test:cell-cite`，并把 citation/render 测试并入 `test:systemic`。

## 跑法

```bash
# 依赖未安装时（本工作区曾缺 node_modules）
npm ci --cache /tmp/npm-cache

# CELL-CITE 专项
npm run test:cell-cite

# 完整系统性回归（DT-1～9 保持通过）
npm run test:systemic

# 展示层回归
npm run test:presentation

# 服务端模块/迁移回归
npm run test:server
```

本次实际结果：

- `npm run test:cell-cite`：通过（C1–C4、L1–L4、U1–U7）。
- `npm run test:systemic`：通过，DT-1～9 未回退。
- `npm run test:presentation`：通过。
- `npm run test:server`：通过（11/11）。

## 手工验收建议

1. 启动现有服务，在新会话问带单元格的题（如“2025 年收入是多少，出处是哪一格？”）。
2. 等 `workbook_query` / `workbook_trace` 返回后，答文中的 `Sheet!A1` 应显示为 chip；点击应打开预览并跳到对应格。
3. 答文故意写一个工具未返回的坐标（如 `Model!Z99`）：应显示为 `未核验` 下划线文本，不可点；post-answer 可能做一次引用纠正。
4. 刷新页面：chip 应仍在（来自 `tool_citations` / snapshot）。
5. 区域引用 `Sheet!A1:B2` 点击跳到 `A1` 锚点。

## 限制与未做

- **P3 未做**：没有 `[[cite:id]]` skill 标记，没有悬停浮层再读格。
- `calc` 工具本身不产出 citation；只有 `unit_convert` / `ratio` 在调用方传入 `citations` 时产出 `derivedFrom`。
- `workbook_query` 只为**实际返回**的单元格产出 citation；被 `maxCells/maxChars` 截断的格不可点，这是有意的 fail-closed。
- 工具卡片里的 `wb-ref` 仍是纯文本；本轮只把答文 locator 变为可点 chip。
- `unverified_locator` 是软告警，且仅当 post-answer 注入 `context.citations` 时启用；直接调用 `lintAnswer` 且不传 citations 的旧路径行为不变。
- 自动纠正最多 1 次，不保证模型一定照做；未纠正时仍保持“不可点”。
- 点击依赖 material 仍在当前项目 `state.files` 中；文件被删除时 `openFile` 为 no-op。
- CopilotKit 实时流的 tool result 不含 details，chip 通常在最终 snapshot 落盘后出现；legacy SSE 实时流会直接带 citations。
- 未执行浏览器级手工点击验收；UI 纯函数、snapshot、event bridge 已由 Node 单测覆盖。
- `_chief` 目录当前不存在/不可写，未写 `_chief/tasks/cell-cite/dev-summary.md` 副本。
