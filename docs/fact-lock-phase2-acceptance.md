# Phase 2 live retrieval acceptance

**Phase 2 live acceptance remains unmet.** The OpenRouter rerun is documented below, followed by the original DeepSeek run.

## OpenRouter follow-up

The OpenRouter follow-up started from `89d462157f03572ea47f77f40e2775ab8a843eb8` in the same isolated worktree. The final code under test is `78d5b04e5f371775536e0d46c7c472370d94824c`. Every live attempt used OpenRouter's exact model ID `baidu/ernie-5.5-flash-preview:free` for both the locator and the chat answer, with temporary project storage and synthetic fixtures.

| Case | First batch | Post-fix batch |
| --- | --- | --- |
| R01 | Upstream 429, malformed output, malformed output | Three account-quota 429s |
| R02 | Upstream 429, PASS, PASS | Three account-quota 429s |
| R03 | Upstream 429, PASS, missing clarification | Three account-quota 429s |
| R04 | PASS, PASS, PASS | Three account-quota 429s |

The [first batch](fact-lock-phase2-evidence/openrouter-ernie-initial.jsonl) passed 6 of 12 attempts. A separate [R01 reproduction](fact-lock-phase2-evidence/openrouter-ernie-r01-diagnosis.jsonl) captured valid topic IDs with an array of metrics that the parser rejected. The shared parser now accepts a list, and the evaluator still judges requested metrics through the selected topics and expanded fact IDs. One locator run retained both R03 topics but omitted the company clarification. The [first R03 chat smoke](fact-lock-phase2-evidence/openrouter-ernie-r03-initial.jsonl) calculated both candidates while the referent was unresolved. The locator now distinguishes an unresolved singular reference from an explicit comparison. The turn context instructs the answer model to ask and wait when the locator flags an ambiguity.

The [post-fix batch](fact-lock-phase2-evidence/openrouter-ernie-revised.jsonl) and [post-fix R03 chat smoke](fact-lock-phase2-evidence/openrouter-ernie-r03-revised.jsonl) each exited 1. All received OpenRouter HTTP 429 `free-models-per-day` with zero requests remaining. This was an account-wide limit across free models. The provider reported a reset of 2026-11-12 08:00 Asia/Shanghai. The live effect of the parsing and clarification changes remains unverified. The separate [OpenRouter missing-key check](fact-lock-phase2-evidence/openrouter-ernie-missing-key.jsonl) exited 0 with 12 explicit skips.

The [offline R03 endpoint check](fact-lock-phase2-evidence/openrouter-ernie-r03-deterministic.jsonl) passed with the clarification instruction and all four expanded fact IDs. [All five required deterministic suites and `test:server`](fact-lock-phase2-evidence/openrouter-regression-exits.txt) exited 0. The topic-index suite includes a regression for expanding both metrics when the locator returns a metric array.

### OpenRouter replay

Set `PI_OPENROUTER_MODELS` to the pinned ID before loading local credentials. Use the in-process loader below if credentials exist only in the original checkout. The 1.5-second interval matches the final batch. Run the same command with the last import changed to `./scripts/test-topic-r03-chat.mjs` for the live chat smoke.

```sh
PI_OPENROUTER_MODELS='baidu/ernie-5.5-flash-preview:free' \
TOPIC_RETRIEVAL_INTERVAL_MS=1500 \
ORIGINAL_WORKBENCH_ROOT="/path/to/original/checkout" node --input-type=module -e '
  import path from "node:path";
  import { loadEnvFile } from "./server/config.mjs";
  const root = process.env.ORIGINAL_WORKBENCH_ROOT;
  loadEnvFile(path.join(root, ".env"));
  loadEnvFile(path.join(root, ".env.local"));
  await import("./scripts/test-topic-retrieve-live.mjs");
'
```

## Original DeepSeek run

On 2026-11-12 Asia/Shanghai, DeepSeek returned HTTP 402 `insufficient_balance_error` on all 12 candidate locator runs and the R03 chat answer smoke. The provider supplied no locator JSON or live answer. Live topic selection, fact expansion with a live selection, and R03's answer behavior remain unverified.

The starting revision was `fbcb4bb01c93d8bccc7986efbe51f9f57962f5ee`. The isolated worktree was clean at handoff and included zero uncommitted changes from the original checkout. The live attempts ran on code commit `3b9aaf5a73df6aa1997f99491734811013f9d4e5`. Dependencies were installed from that base's lockfile. Each retrieval run used its own ledger inside temporary project storage. The R03 HTTP smoke used separate temporary storage.

### Candidate results

Provider `deepseek`, locator model `deepseek-flash`. The live answer smoke used `deepseek-flash` as well. The timestamps in this report refer to the test environment. Latency measures elapsed time from fixture setup through result recording.

| Case | Expected topics | Expected company and periods | Expected clarification | Attempts |
| --- | --- | --- | --- | --- |
| R01 | W01, W02 | A 公司, 2024 and 2023 | None | FAIL 852 ms, FAIL 580 ms, FAIL 576 ms |
| R02 | W04 | B 公司, 2023 | None | FAIL 581 ms, FAIL 583 ms, FAIL 564 ms |
| R03 | W01, W04 | Unresolved, 2024 and 2023 | `company` | FAIL 609 ms, FAIL 586 ms, FAIL 574 ms |
| R04 | W01 | A 公司, 2024 and 2023 | None | FAIL 568 ms, FAIL 583 ms, FAIL 557 ms |

All 12 failures occurred at the provider. Empty topic and fact lists record the absence of a usable selection. A null clarification records the absence of a locator result. The [candidate JSONL](fact-lock-phase2-evidence/retrieval.jsonl) includes expected and actual fact IDs and exact per-attempt provider errors. The [preflight JSONL](fact-lock-phase2-evidence/retrieval-preflight.jsonl) contains the first three attempts per case against the shared locator during development. Its 12 attempts also returned 402. In the separate [missing-credential check](fact-lock-phase2-evidence/retrieval-missing-key.jsonl), all 12 attempts were `SKIPPED` and the command exited 0.

The [live R03 smoke](fact-lock-phase2-evidence/r03-chat-live.jsonl) seeded the exact history in a fresh session and submitted the exact final question to `POST /api/sessions/:id/messages`. The answer provider returned 402. The [deterministic R03 endpoint check](fact-lock-phase2-evidence/r03-chat-context.jsonl) used a stub locator response. It confirmed that the locator payload omitted the case ID, financial amounts and ledger fact IDs, and that the production chat path injected `company` clarification and the four expected revenue fact IDs into the turn context.

The [offline scorer follow-up](fact-lock-phase2-evidence/r03-chat-scorer-review.jsonl) checks explicit clarification and rejects unrelated questions about A and B. It also checks that a calculated result before a hidden correction or in visible process text still fails, using the same snapshot serializer as the chat state endpoint. The scoring change only affects the evaluator. The live 402 records above are from the original run, before this offline follow-up.

The [deterministic regressions](fact-lock-phase2-evidence/regression-exits.txt) each exited 0.

| Command | Status |
| --- | --- |
| `npm run test:topic-index` | PASS |
| `npm run test:answer-lint` | PASS |
| `npm run test:cell-cite` | PASS |
| `npm run test:fact-register` | PASS |
| `npm run test:systemic` | PASS |
| `npm run test:topic-retrieve-live` | FAIL, exit 1 with 12 provider errors |

### DeepSeek replay

Use the current evaluator revision for replay. From the isolated worktree, run `npm ci --ignore-scripts` and the commands above. The live runner reads the usual Workbench `.env.local` or process environment. If the configured credentials only exist in the original checkout, this replay reads them in-process with Workbench's loader and keeps them out of the isolated worktree and command output.

```sh
ORIGINAL_WORKBENCH_ROOT="/path/to/original/checkout" node --input-type=module -e '
  import path from "node:path";
  import { loadEnvFile } from "./server/config.mjs";
  const root = process.env.ORIGINAL_WORKBENCH_ROOT;
  loadEnvFile(path.join(root, ".env"));
  loadEnvFile(path.join(root, ".env.local"));
  process.env.PI_OPENROUTER_MODELS = " ";
  await import("./scripts/test-topic-retrieve-live.mjs");
'
```

Use the same loader and import `./scripts/test-topic-r03-chat.mjs` to replay the live chat smoke. For the offline HTTP context and answer scorer checks, run `node scripts/test-topic-r03-chat.mjs --deterministic`.

Both chat and the retrieval runner use the configured locator model, the same prompt, response parser, topic selection, and fact expansion. The fixtures retain the original dialogue and question strings. Chat and the runner format prior turns identically and mask financial amounts in locator history while preserving the years. Topic IDs are sent as available choices alongside topic titles, summaries and bindings. The expected selections and linked facts stay in the fixture and evaluator.
