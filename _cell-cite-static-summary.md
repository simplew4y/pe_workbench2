# CELL-CITE static 404 hotfix summary

**Branch:** `fix/cell-cite-static` (based on `main` @ `7d1a418`)
**Status:** fixed locally, tests green, **not pushed / merged / deployed**

## Root cause

`ui/chat/cell-citations.js` imported `../../lib/citation-locator.mjs`. The
browser can only fetch statically served paths, and `server/http/respond.mjs`
allows only:

- root `STATIC_FILES`
- `/vendor/*`
- `/ui/*.(js|mjs|css)`

`/lib/` is intentionally **not** a static root, so the import resolved to a
404 and the chat UI failed to bootstrap.

## Fix

Moved the pure A1 locator implementation into the statically served UI tree
and kept `lib/citation-locator.mjs` for Node as a thin re-export wrapper. There
is now one implementation; Node and browser cannot drift.

- `ui/chat/citation-locator.js` (new): canonical pure parser —
  `LOCATOR_SOURCE`, `normalizeLocator`, `locatorKey`,
  `extractLocatorMatches`, `resolveLocatorToken`, default export.
  No Node or DOM dependency.
- `ui/chat/cell-citations.js`: imports `./citation-locator.js` instead of
  `../../lib/citation-locator.mjs`. No UI file imports `/lib` anymore.
- `lib/citation-locator.mjs`: thin Node re-export of
  `../ui/chat/citation-locator.js`; all existing Node consumers
  (`lib/answer-lint.mjs`, `lib/citations.mjs`) keep working unchanged.
- `server/http/respond.mjs`: **unchanged** — `/lib/` was not opened as static.

## Regression test

`scripts/test-cell-cite-render.mjs` now walks the relative import graph from
`ui/chat/cell-citations.js` and asserts:

1. no specifier contains a `/lib/` path segment;
2. every relative/absolute specifier resolves to an existing file **inside**
   `ui/` (a path that `/ui/...` static serving can return);
3. the graph actually reaches `ui/chat/citation-locator.js`.

Because `test:cell-cite` and `test:systemic` both run this file, the guard is
active in both suites.

## How to run

```bash
cd /workspace/projects/pe_workbench2

# focused regression
node scripts/test-cell-cite-render.mjs

# required suites
npm run test:cell-cite
npm run test:systemic
```

Both required suites passed after the change.

Static-serving probe (fake request/response against `serveStatic`):

```
/ui/chat/cell-citations.js    -> handled=true  status=200 bytes=4184
/ui/chat/citation-locator.js  -> handled=true  status=200 bytes=4294
/lib/citation-locator.mjs     -> handled=false status=null bytes=0
```

## Commits

- `18fd971` `fix(cell-cite): serve locator from /ui to fix static 404` —
  implementation + regression test.
- Docs commit for this summary (same branch).

## Limits / not covered

- No real-browser click-through test was run in this environment. The static
  path and dependency graph are verified to be served under `/ui`; chip render
  behavior is covered by `test-cell-cite-render` (U1–U7), but the final manual
  check (open project → chip appears → click opens preview and jumps to the
  cell) remains for the browser environment.
- `/lib/` is still not statically served by design; this hotfix does not change
  the static allow-list.
- Node imports of `lib/citation-locator.mjs` now reach into `ui/chat/`. This is
  safe for the current single-repo runtime, but any future packaging that
  excludes `ui/` would need the shared module copied or relocated.
- No push, merge, or deploy was performed.
