# main合并与定向验证（2026-11-09）

将origin/main `6c3a1af`合并到fix/p0-research-reliability（合并前HEAD `d454a17`）。此前最终报告描述合并前状态；本记录补充本次合并验证，不覆盖历史失败。

保留main的DT-1单位换算/回答检查、DT-2台账用户主张/自查门禁，以及DT-3至9的比例、比较基准、未命中证据、角色、阈值、检查清单与币种检查。

冲突处理：

- turn-context：保留main的severity参数和新门禁，同时保留fix对普通“无关”语境的排除。
- workbook-query：保留fix的单位/比例语义、图表与结构化证据；从纠正后的unit计算main的display_unit，保留role展示和miss/coverage元数据。
- 精确引用：显式地址错误仍立即失败，不允许关键词回退；未命中原因同时提供可读文本。将main中“混合地址查询允许降级”的测试改成严格失败正反例，未删除其余DT-5断言。
- package.json：合并双方测试入口及main扩展的systemic脚本。

12项定向脚本通过：research-quantities（32案及5个入口）、research-reproduction、workbook-references、workbook-query-semantics、workbook-semantics、turn-context、dt-regression、calc-tool、ratio-tool、ledger-claims、answer-lint、post-answer。

未跑全量回归、未新增模型调用、未重放复杂报告保存。此前真实场景中的剩余问题仍需合并后专门验证，不能用main新增机制推定已全部修复。

本地日志：`/home/simpleway/pe_workbench2_docs/证据/07-main合并/`。
