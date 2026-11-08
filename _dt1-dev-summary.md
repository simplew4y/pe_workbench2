# DT-1 开发总结：单位换算 + 数量级门禁

> 说明：`/workspace/projects/_chief/tasks/systemic-fix/` 在 workspace-write 沙箱之外，写入被拒绝；按用户指示改写到仓库内 `_dt1-dev-summary.md`。内容同预期交付摘要。

- 仓库：`/workspace/projects/pe_workbench2`
- 分支：`fix/dt1-unit-oom`（基于 `05ef90e`）
- 范围：仅 DT-1；未打开/实现 DT-2
- 状态：改动已落地，未 commit / 未 merge / 未 push

## 1. 改动文件

| 文件 | 改动 |
|------|------|
| `lib/calc-tool.mjs` | 新增 `unitInfo` 别名归一化；`calculate` 支持 `Rmb mn/RMB mn/rmb mn/mn/HKD mn/亿/%/decimal`；新增 `unitConvert`（精确 Decimal、始终返回 `conversionChain`）与 `unit_convert` 工具；新增 `convertExact`、`formatDecimal`、`relativeErrorExceeds` 供 lint 复用 |
| `lib/answer-lint.mjs` | U1：用 Decimal 重算「X 百万元/Rmb mn = Y 亿元」类断言，相对误差 >0.5% 才报 `unit_conversion`（`severity: error`，`code: U1`），保留既有 1 次自动纠正链路；U2：可选 context（`marketCap` 或 `price×shares`）与市值/股权价值断言做数量级比较，`|log10(ratio)| ≥ 1` 报 `magnitude`（`severity: warning`，`code: U2`）；无市值时跳过 |
| `lib/workbook-query.mjs` | `cellMetadata` 新增 `display_unit`；别名归一到 `百万元/亿元` 等；推断失败返回 `unit_unknown`；`formatResult` 使用 `display_unit` |
| `server/project-context.mjs` | 注册 `createUnitConvertTool()` |
| `server/config.mjs` | 工具白名单加入 `unit_convert` |
| `server/agent/post-answer.mjs` | 纠正 prompt 增加 `unit_convert`；支持可选 `entry.answerLintContext` 传给 lint；`magnitude` 纳入数值类标签 |
| `scripts/test-calc-tool.mjs` | 金标 `7053443 Rmb mn → 70534.43 亿元`、各别名、`%↔decimal`、错误币种/不兼容单位、工具输出链 |
| `scripts/test-answer-lint.mjs` | U1 错误/正确断言、相对误差 0.38% 通过/0.52% 报错、U2 mock marketCap、price×shares、无 cap 跳过、显式 raw unit |
| `scripts/test-workbook-query-semantics.mjs` | `display_unit` 别名归一、`unit_unknown`、`formatResult` 路径 |

## 2. 行为要点

### unit_convert 金标

`7053443 Rmb mn → 亿元` 输出：

- `value: "70534.43"`
- `unit: "亿元"`
- `currency: "RMB"`
- `conversionChain`：`7053443 Rmb mn → 7053443 百万元 × (1000000 / 100000000) = 70534.43 亿元 RMB`

即 ÷100，而不是错误的 ÷1000（7,053 亿元）。

### U1

- 错误：`7053443 百万元 = 7053 亿元` → finding `unit_conversion`，`severity: error`，`code: U1`，`expected: 70534.43`。
- 正确：`7053443 百万元 = 70534.43 亿元` → 无 finding。
- 阈值是相对误差 0.5%，不是旧的绝对位数容差；`70534.44`、`70800` 通过，`70900` 报错。
- 未加入任何全局 ×100/÷100 自动改写。

### U2

- `lintAnswer('公司市值约 5,000 亿元。', { marketCap: 500 })` → `magnitude` warning，差约 1.0 个数量级。
- `{ price: 100, shares: 1e10 }`（约 10,000 亿元）对 `10,000 亿元` 不报，对 `100 亿元` 报。
- 无 `marketCap` 且无 `price+shares` → 不报。
- 默认单位约定：`marketCap` 无单位时，绝对值 ≥ 1e6 按「元」、否则按「亿元」；可用 `marketCapUnit` 显式覆盖。`price` 默认「元」，可用 `priceUnit` 覆盖。

### workbook_query

- `unit` 保留原始推断值；新增 `display_unit`。
- `Rmb mn/RMB mn/rmb mn/mn/HKD mn/百万元/百万` → `百万元`；`亿` → `亿元`。
- 无单位 → `display_unit: "unit_unknown"`，仅 info，不产生 warning。

## 3. 测试与结果

| 命令 | 结果 |
|------|------|
| `npm run test:systemic` | 通过（exit 0），覆盖 calc / answer-lint / workbook-query / post-answer / ledger / F5 等全部子项 |
| `node scripts/test-calc-tool.mjs` | 通过 |
| `node scripts/test-answer-lint.mjs` | 通过 |
| `node scripts/test-workbook-query-semantics.mjs` | 通过 |
| `node scripts/test-tool-contracts.mjs` | 20 passed, 0 failed |
| `node scripts/test-server-modules.mjs` | 11 passed, 0 failed |
| `node scripts/test-agent-tools.mjs` | 12 passed, 0 failed |
| `npm run test:calc` | exit 0；LibreOffice 引擎用例因缺少测试模型 `projects/p-c1db281e/uploads/...长鑫-Model...xlsx` 跳过 |

### 本地错误断言演示

输入：

```text
折价前 7053443 百万元 = 7053 亿元。
```

`lintAnswer` 输出：

```json
[
  {
    "rule": "unit_conversion",
    "severity": "error",
    "message": "单位换算不一致",
    "excerpt": "7053443 百万元 = 7053 亿元",
    "expected": "70534.43",
    "code": "U1"
  }
]
```

同一句改为 `70534.43 亿元` 后输出 `[]`。

## 4. 已知限制

1. **U2 无行情上下文时跳过**：`lintAnswer` 只有收到 `{ marketCap }` 或 `{ price, shares }` 才会做数量级门禁；当前 post-answer 默认没有 westock 市值上下文，需宿主后续把行情注入 `entry.answerLintContext`。
2. **U2 是 warning**：不触发自动纠正，避免把口径不同/行情过期的数字盲目改写；仅提示 `数值待核`。
3. **`unit_unknown` 仅 info**：不会因为无法推断单位而告警。
4. **`unit_convert` 不做汇率**：`Rmb mn ↔ HKD mn` 这类跨币种会拒绝；跨币种需走 `calc` 的显式 `rate`。
5. **未实现 DT-2**：用户口述错数入台账、自查协议等不在本次改动内。
6. **未 commit / 未 push**：工作区保留 9 个修改文件；`git log -1` 仍为 `05ef90e`。`logs/` 是工作区既有未跟踪目录，未改动。

## 5. 确认

- 未执行 `git commit`、`git merge`、`git push`。
- 未打开或修改 DT-2 相关实现。
- 未写入任何密钥或模型 ID。
