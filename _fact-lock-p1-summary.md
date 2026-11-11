# Fact Lock Phase 1 Delivery Summary

Branch: `feat/fact-lock`  
Scope: Phase 1 only. No push or merge performed.

## Implemented

- `lib/westock-tool.mjs`: deterministically parses quote tables into `details.quotes[]` with ticker, price, currency, optional quote time, and fetch time. Existing CLI text and `[meta] fetched_at=` output remain intact; failures return empty quotes.
- `lib/fact-register.mjs`, `lib/ledger.mjs`: adds atomic structured fact registration on the existing v1 session ledger, conservative binding comparisons, same-source superseding, cross-source conflict marking, cross-day price expiry, stale material version marking, and project-scope validated state projections. Legacy `appendFact` remains append-only.
- `server/agent/post-answer.mjs`: registers successful structured tool results from completion events and a pre-lint sweep, then lints against the full ledger. Automated sessions still bypass this wrapper. Citation rehydration only reuses complete current identities whose values occur in the answer.
- `lib/claim-detect.mjs`: explicit detected corrections still record claims and now append effective corrections in the same turn, converting known units where possible. Capture errors remain non-blocking.
- `lib/turn-context.mjs`, `lib/ledger.mjs`: injects the current ledger facts with conflict and expired-price labels, question relevance/recent ordering, a 16,000-character limit, and an omitted-item count.
- `lib/answer-lint.mjs`: adds stable `unsourced_number`, `orphaned_number`, and `stale_price` rules while preserving prior lint checks. Locator repair now handles its orphaned number and no longer asks the model to preserve every number.
- `lib/citations.mjs`: adds strict `rehydrateCitations` behavior; it does not infer identities from locator or number text.
- Tests updated or added in `scripts/test-westock-ticker.mjs`, `scripts/test-fact-register.mjs`, `scripts/test-post-answer.mjs`, `scripts/test-citations.mjs`, `scripts/test-ledger-claims.mjs`, `scripts/test-ledger-lint.mjs`, `scripts/test-ledger.mjs`, `scripts/test-turn-context.mjs`, and `scripts/test-validate-state-warnings.mjs`. `package.json` wires the fact-register and westock fixtures into `test:systemic`.

## Verification

- `npm run test:answer-lint` — passed.
- `npm run test:cell-cite` — passed.
- `npm run test:systemic` — passed, including deterministic fixtures for unsourced 90亿, yesterday 418 vs today, project target-price projection, auto-registration, conflicts, stale versions, and citation rehydration.
- `npm run test:fact-register` — passed.
- `git diff --check` — passed.

No live LLM regression was run.

## Limits and Deferred Work

- Structured tool results without sufficient binding identity are retained without automatic replacement, as required by the conservative matching rule.
- Price freshness is based on Hong Kong calendar day and the named 24-hour TTL; a latest/now answer also requires a successful westock quote in that turn.
- Citation rehydration requires a complete material/version/locator/value identity and a matching value in the answer. Current material versions are checked when available from the session or this turn's tool citations.
- Phase 2 topic indexing and two-layer retrieval were not implemented.
- Phase 3 multi-turn LLM regression was not implemented.
- AutoDL and automated-watch write paths were not changed.

## Commits

- `5f0a487` `feat(fact-lock): auto-register verified facts, lint unsourced numbers, rehydrate citations` — implementation + R1–R17 tests.
- Docs commit for this summary (same branch). Codex wrote the tree but could not commit (sandbox `.git` was read-only); the host re-ran the required suites and created the local commit. **Not pushed / not merged.**
