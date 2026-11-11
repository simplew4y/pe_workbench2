# Fact-lock Phase 1 acceptance fixes

## Changes

- Explicit, narrowly detected user corrections now also append a `source=user_correction`, `status=current` fact using the correction's normalized `to` value and unit. The fact keeps the correction text as its claim and a conservative partial binding; it does not supersede other facts when that binding is incomplete.
- `lintLedgerAnswer` now treats effective correction `to` values as sources. The corrected value is no longer falsely flagged, while the superseded value remains subject to `repeats_corrected_value`.
- Orphan-number detection now checks every captured money value against current/conflict facts, current-turn citations, and effective correction values. A registered 100亿元 alongside a bad locator no longer triggers `orphaned_number`; unsourced 90亿元 with a bad locator still triggers it.
- Added the C03 regression using 7053亿元 → 70534亿元, the registered-number false-positive case, R3 answer-only/no-tool coverage, and a numeric C10/R16 post-answer case proving auto-correction is capped at one.
- `appendFact` now preserves optional register metadata used by callers, including `source`, `binding`, and `status`.

## Acceptance status

Both reported repros are closed by tests: corrected 70534亿元 is sourced while 7053亿元 remains blocked; registered 100亿元 is not orphaned by an invalid locator while unsourced 90亿元 is.

## Verification

- `npm run test:answer-lint` — PASS
- `npm run test:cell-cite` — PASS
- `npm run test:fact-register` — PASS
- `npm run test:systemic` — PASS
- `git diff --check` — PASS

No Phase 2/3 work was performed. No push or merge.

## Commits

- `1f24376` `fix(fact-lock): source user corrections and stop orphaned false positives`
- Docs commit for this summary (same branch). Codex could not commit (sandbox `.git` read-only); the host re-ran the suites and created the local commit. **Not pushed / not merged.**
