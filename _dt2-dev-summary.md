# DT-2 开发摘要：ledger user_claim + 自查协议

| 字段 | 内容 |
|------|------|
| 分支 | `fix/dt2-ledger-claims`（基线 DT-1 `d7806bf`） |
| 执行器 | DeepSeek Harness（dsh）；收尾自测与摘要由 Dev 完成（dsh 中途报 `QUOTA: Insufficient Balance`） |
| 推送 | **未 push** |
| 状态 | T1–T8 单测绿；`npm run test:systemic` 绿；DT-1 U1 金标未回退 |

## 改动文件
- `lib/ledger.mjs` — `appendClaim` / `claims[]`、`searchLedger`、supersede；与既有 facts/corrections/open 兼容
- `lib/ledger-tool.mjs` — `kind=claim`（user_claim / doubt）
- `lib/claim-detect.mjs` — 显式纠错句式检测（写成了/应为/有人写成…），不做全自动 NER
- `lib/self-audit.mjs` — 自查组装：search→列表→金额 unit_convert/calc；话术门禁
- `lib/transcript-search-tool.mjs` — 检索结果附带 ledgerMatches
- `lib/turn-context.mjs` — selfaudit 路由/门禁强化
- `server/agent/post-answer.mjs` — 接入 claim 检测 / 自查相关
- `skills/model-qa/SKILL.md`、`skills/investment-framework/SKILL.md` — 自查硬句
- `package.json` — systemic 纳入 `test-ledger-claims.mjs`
- `scripts/test-ledger-claims.mjs` — T1–T8
- `_dt2-brief.md`（任务简报副本，未纳入实现）

## 如何跑测
```bash
cd /workspace/projects/pe_workbench2
node scripts/test-ledger-claims.mjs   # T1–T8
node scripts/test-answer-lint.mjs     # DT-1 U1 金标
node scripts/test-calc-tool.mjs
npm run test:systemic                 # 含 ledger/F5/transcript + T1–T8
```

本机结果（Asia/Shanghai）：`ledger claims/self-audit T1-T8 PASS`；`answer lint passed`；`npm run test:systemic` 全绿。

## 已知限制
- 不做长文全自动数字 claim 抽取（留给 DT-2.1）
- I1/I2 线上 RETEST（B4/B3）留给合并部署后 Chief 复测
- 未开 DT-3+
- dsh 在收尾阶段额度不足；实现已落盘且自测绿

## Git
- 建议本地 commit（不 push）便于一起验收；由 Dev 执行。
