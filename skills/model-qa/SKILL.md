---
name: model-qa
description: 模型问答与追问，核对假设、口径、敏感性、依赖路径、证据和失效条件。
---

# 模型追问

遵循 `skills/investment-framework/SKILL.md`；宿主每轮通过 `lib/turn-context.mjs` 注入相同协议。

- 假设解释：追公式来源，对齐单位、期间，区分区块内同名指标。
- 敏感性：沿真正输入传播，调用 model_whatif 或明确「局部」范围；派生数调用 calc。
- 证据：预测不等于兑现，多篇转述不算独立证据，单期不证明连续多期。
- 代码：查询 Cover/元数据；未命中报告 coverage，不等于不存在。
- 失效条件：阈值无依据写「待定」及 calibration；区分短期修订、置信度调整和机制失效。
- 更正：使用台账当前值，不复述已被替代的数值。
- 负向依赖结论：先 workbook_trace mode=path，交代解析覆盖限制。
