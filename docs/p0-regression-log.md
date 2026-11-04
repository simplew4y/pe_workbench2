# P0 regression log

Branch: `fix/p0-research-reliability`. Baseline: `8089514`.
Existing local `.gitignore` changes are not part of these commits.

## Issue 2: exact workbook references

Commit: `72a2efa`.
- Quoted and unquoted sheet names with spaces, escaped apostrophes, and absolute cell addresses resolve exactly.
- Missing, malformed, and ambiguous explicit references return errors without keyword fallback. Agent tool marks these failures with isError.
- 10 focused assertions passed; existing workbook suite 26 passed.
- A pre-existing Python XML exception wording assertion now accepts ParseError as well as XML/Premature.
- Live 8081/Product Eng: Discount PE!H33=1.49; 'Capacity & capex'!$AK$4=318.75; missing and malformed references return explicit errors.

## Issue 1: ambiguous metric labels

- Query results retain source row context and expose numerator/denominator evidence for direct same-sheet division formulas, independent of neighbor count limits.
- Context is explicitly labeled source context, not a guessed metric definition. Unsupported formulas still require workbook_trace.
- Regression distinguishes AH32 revenue share, AH42 gross margin, AH47 gross-profit contribution and preserves GB/Gb case.
- Focused semantic tests, reference tests and all 26 existing workbook tests passed.
- Live uploaded model: AH32=0.020551839475615; AH42=0.65; AH47=0.0158738949647767, with correct operand references.
- Real DeepSeek session: `fffd4a34-955e-48da-929e-b549b1644543`; correctly answers 2.1% revenue share, 65% gross margin, 1.6% gross-profit share, Beta 1.49 and USD/GB.
- This is a targeted, explicitly instructed model check; it does not establish that unrestricted research or every other P0 issue is fixed. The model chose workbook_trace in this check; the changed workbook_query path was separately exercised by the live API assertions.

Remaining at the end of the first pass: issues 3–8 below. Historical entries are retained; see the continuation results.

## Actual targeted model answer

核验完成。结论如下（均为工作簿缓存值，以 Excel 重算为准）。

## 核验结果

**Assumption!AH32 — HBM 收入占营业收入比（2026E）**
- 公式 `=AH13/AH$7`，分子 HBM 收入 7,293，分母总 Revenues 354,858.747，结果 0.021（约 2.1%）。这是「HBM 收入 ÷ 总营业收入」的占比，不是 65%。

**Assumption!AH42 — HBM 毛利率口径的占比（2026E）**
- 公式 `=AH37/AH13`，分子 HBM 毛利 4,740.45，分母 HBM 收入 7,293，结果 0.65。这就是 65% 的出处。

**关键澄清：65% 不是「HBM 收入占比」，而是「HBM 毛利率（约 65%）」**

因为 AH42 的分母是 AH13（HBM 收入），而非 AH7（总营业收入）。上行 AH37=AH13×AH42 正是「HBM 毛利=HBM 收入×毛利率」。所以 65% 应解读为 HBM 产品的毛利率，而非 HBM 占总收入比重（后者是 AH32 的 2.1%）。

**Assumption!AH47 — HBM 毛利占总毛利比（2026E）**
- 公式 `=AH37/AH$34`，分子 HBM 毛利 4,740.45，分母总 Gross profits 298,631.811，结果 0.016（约 1.6%）。即 HBM 毛利占全公司毛利的比重。

**Discount PE!H33 — Beta**
- 输入值（无公式），数值 **1.49**。

**Assumption!AH122 — HBM ASP 价格单位**
- 公式 `=AH13/AH51/(AH117/8)`：HBM 收入（人民币）÷ 汇率（Rmb/USD=6.995）÷（Bit shipments/8，把 Gb 换算成 GB）。结果 8.34。
- **单位是 USD/GB**（美元每 GB），不是 USD/Gb、也不是人民币价格。即 2026E HBM 平均售价约 8.34 美元/GB。

一句话总结：AH32 是 HBM 收入占比（2.1%）、AH42 是 HBM 毛利率（65%）、AH47 是 HBM 毛利占比（1.6%）；65% 是**毛利率**不是收入占比；AH122 价格单位是 **USD/GB**；Beta=1.49。


## Continuation: ordinary QA policy and quote identity

- Issue 6, commit `6507e9e`: research-qa/1 is injected by the host for ordinary/new/resumed sessions, independent of keyword skill selection. Policy test and 11 server tests passed. Prompt injection alone does not guarantee compliance with every financial reasoning requirement.
- Issue 4, commit `c729d10`: quote requires expectedName and a single matching security code/name before returning prices. Seven identity cases and existing ticker normalization suite passed. Exact name matching is deliberately strict; this does not establish the issuer from a ticker supplied by the model, or validate non-quote commands.

## Issues 3, 5, 8: report preflight

- Added per-session review_research with a write/edit hook for Markdown files under exports/. Full approved content is bound to its SHA-256 and current file baseline; direct partial edits require a new full review. Every numeric line, including headings, requires covered numeric tokens or an explicit unknown statement.
- Issue 3 regression: a 50% threshold without proof is rejected; a normal model ASP value cannot become an invalidation threshold; explicit threshold source accepted; unknown values clearly marked pending are accepted.
- Issue 5 regression: same-basis comparison accepted; company, product, metric, unit, period and actual/forecast mismatches each rejected.
- Issue 8 regression: exact source cell, original cached value, rounded display text, original unit (case-sensitive GB/Gb), column period and ratio operands checked. Wrong body value/unit, wrong year, missing file, extra uncovered number and heading bypass rejected.
- External citations must come from actual successful read/search/fetch/quote tool results in this session. Source excerpts, locator, displayed number and declared period/entity/metric must be present in captured evidence.
- 12 agent-tool tests and 11 server tests passed. Real-model regression follows separately.
- Scope: this is a bounded provenance/consistency preflight, not a semantic financial truth verifier. Unknown claims are explicitly unverified. Product/metric classifications and narrative conclusions still require judgment. Other file formats, non-export paths and free-form chat are outside this write gate.


## Issue 7: correction propagation and truthful write status

- Failed write/edit results no longer trigger onMaterialSaved or enter the trace changedFiles list. Both event-level and result-level errors are handled and rendered as errors.
- Research write results are re-read by the host and compared byte-for-byte with requested content before returning research_write_verified. Missing/mismatched files return an error.
- Review rejects stale approved baselines and partial edits. It scans sibling reports for explicit retracted phrases and removed quantitative lines copied verbatim from the existing report. Old reports can be preserved with a first-line withdrawal marker and correction link.
- Regression passed: failed edit notification/trace exclusion, missing-file false-success prevention, successful write receipt, changed baseline rejection, stale sibling detection, valid withdrawal, traversal and symlink-parent rejection. Existing trace suite passed.
- Scope: exact text/line matching cannot find every paraphrase of an old error; the research policy still requires reviewing all affected reports. The host cannot guarantee that arbitrary final chat prose will honestly describe all tool results.

## Real-model preflight usability regression

- Session `179799f3-8d22-4745-beea-f765a767ee11`, local Product Eng on 8081, same uploaded model. Prompt asked for a brief report, HBM ASP/share/margin, and whether a 50% yield invalidation rule is supported.
- First run was stopped after three failed review attempts. Direct write was correctly blocked, but the model repeatedly confused kind with valueType, and legitimate rounded values and unit whitespace were rejected. No report was published from those failed attempts.
- Fixed the interface: explicit claim schema enum, concise valid example, equivalent USD/US$ and whitespace normalization while preserving GB/Gb, rounding checks against the original cached value, reuse of verified period/reference/file metadata. Added positive regressions for these cases while retaining wrong-value/unit/threshold rejection.
- Resumed-model outcome recorded below. This test is not presented as an uninterrupted first-attempt success.


### Resumed report result

- Resumed the same session after the interface fix, asking for concise completion. After further correction of its claims, review_research passed, write succeeded, and the host emitted a read-back verification receipt.
- Saved test report: projects/product-eng/exports/P0回归-模型核验.md. SHA-256: e92fc733be4e68574b439cd0df7de159603cec97da9d27a009c3e02e4e2ae520.
- Report values: ASP 8.34 US$/GB, revenue share 2.1%, gross margin 65%; the 50% yield invalidation threshold is marked unsupported/pending.
- Residual model limitation observed: the final chat overstates absence of a yield field as a certainty. The saved report marks this pending, but a passed report preflight does not validate arbitrary final chat. A fresh ordinary-QA check is recorded separately.
- Expanded verification: test:p0 passed; agent-tools 12, server 11, tool-contracts 20, protocol 189, workbook 26, and trace passed. Workbook wiring assertion updated to account for the appended per-session review tool.
- test:p1 did not fully pass: test-approvals reports 13 passed / 6 failed because LibreOffice is unavailable, preventing recalculation and cascading through approval-success assertions. This environment limitation is not counted as a pass. Model write-back is already propose-only on this host.
- Added executed CLI fixture tests: mismatched security response is suppressed and a verified quote returns its price. No live market-data calls required for this deterministic regression.
