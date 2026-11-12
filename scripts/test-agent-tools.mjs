#!/usr/bin/env node
/**
 * Dedicated tests for the non-bash agent tools added for issue #3:
 *   validate_state  (legal + illegal state, path guard)
 *   workbook_trace  (fixture xlsx: point cell + at least one upstream layer)
 *
 * The workbook part uses the existing deterministic fixture generator. If
 * Python/openpyxl is unavailable it is skipped, but validate_state still runs.
 */

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { Store } from "../store.mjs";
import { WorkbookStore } from "../lib/workbook-store.mjs";
import { createValidateStateTool } from "../lib/validate-state-tool.mjs";
import { createWorkbookTraceTool } from "../lib/workbook-trace-tool.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT = path.dirname(HERE);
const EXAMPLE = path.join(PROJECT, "skills/investment-framework/assets/analysis-state.example.json");
const FIXTURE_SCRIPT = path.join(HERE, "fixtures", "make-workbook-fixture.py");
const PYTHON = process.env.PYTHON_BIN || "python3";

let passed = 0;
const failures = [];

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`  FAIL ${name}`);
    console.error(`       ${(error.message || String(error)).split("\n")[0]}`);
  }
}

function pythonAvailable() {
  const check = spawnSync(PYTHON, ["-c", "import openpyxl"], { encoding: "utf8" });
  return !check.error && check.status === 0;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function main() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "pe-agent-tools-"));
  const workspace = path.join(root, "project");
  await fsp.mkdir(path.join(workspace, "exports", "legal"), { recursive: true });
  await fsp.mkdir(path.join(workspace, "exports", "broken"), { recursive: true });
  await fsp.mkdir(path.join(workspace, "uploads"), { recursive: true });

  try {
    console.log("\nvalidate_state");
    const exampleText = await fsp.readFile(EXAMPLE, "utf8");
    const example = JSON.parse(exampleText);
    const legalRel = "exports/legal/analysis-state.json";
    await fsp.writeFile(path.join(workspace, legalRel), exampleText);

    const validateTool = createValidateStateTool({ workspace });

    await test("legal analysis-state.json passes with structured empty errors", async () => {
      const result = await validateTool.execute("call-1", { path: legalRel });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.ok, true);
      assert.equal(result.details.passed, true);
      assert.deepEqual(result.details.errors, []);
      assert.ok(Array.isArray(result.details.warnings));
      assert.match(result.content[0].text, /结果：通过/);
    });

    await test("draft without counter evidence preserves internal warnings and stage checks", async () => {
      const draft = structuredClone(example);
      draft.stage = "draft";
      draft.theses[0].counter_ids = [];
      await fsp.writeFile(path.join(workspace, legalRel), JSON.stringify(draft));
      const result = await validateTool.execute("call-draft", { path: legalRel });
      assert.equal(result.details.ok, true);
      assert.ok(result.details.warnings.some(item => item.includes("COUNTER_EVIDENCE_MISSING")));
      assert.equal(result.details.warningCount, result.details.warnings.length);
      draft.stage = "reviewed";
      await fsp.writeFile(path.join(workspace, legalRel), JSON.stringify(draft));
      const reviewed = await validateTool.execute("call-reviewed", { path: legalRel });
      assert.equal(reviewed.details.ok, false);
      assert.ok(reviewed.details.errors.some(item => item.includes("必须有反面证据")));
      await fsp.writeFile(path.join(workspace, legalRel), exampleText);
    });

    await test("illegal analysis-state.json returns structured errors", async () => {
      const broken = structuredClone(example);
      broken.evidence[0].source_ids = ["SRC404"];
      const brokenRel = "exports/broken/analysis-state.json";
      await fsp.writeFile(path.join(workspace, brokenRel), JSON.stringify(broken, null, 2));
      const result = await validateTool.execute("call-2", { path: brokenRel });
      assert.equal(result.isError, undefined);
      assert.equal(result.details.ok, false);
      assert.equal(result.details.passed, false);
      assert.ok(result.details.errors.some((item) => item.includes("SRC404")));
      assert.match(result.content[0].text, /结果：未通过/);
      assert.match(result.content[0].text, /SRC404/);
    });

    await test("rejects a path outside the current project", async () => {
      const result = await validateTool.execute("call-3", {
        path: "../outside/analysis-state.json",
      });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /project/);
    });

    await test("rejects a file that is not analysis-state.json", async () => {
      const result = await validateTool.execute("call-4", { path: "exports/legal/other.json" });
      assert.equal(result.isError, true);
      assert.match(result.content[0].text, /analysis-state\.json/);
    });

    await test("both tools are registered in config and per-project customTools", () => {
      const configSource = fs.readFileSync(path.join(PROJECT, "server/config.mjs"), "utf8");
      const contextSource = fs.readFileSync(path.join(PROJECT, "server/project-context.mjs"), "utf8");
      assert.match(configSource, /"create_tracking", "validate_state"/);
      assert.match(configSource, /toolNames\.push\("workbook_query", "workbook_trace"\)/);
      assert.match(contextSource, /createWorkbookTraceTool/);
      assert.match(contextSource, /createValidateStateTool/);
      assert.match(contextSource, /workbookTraceTool, validateStateTool/);
    });

    console.log("\nworkbook_trace");    if (!pythonAvailable()) {
      console.log(`  SKIP ${PYTHON} + openpyxl not available (set PYTHON_BIN to override)`);
    } else {
      const dataDir = path.join(root, "data");
      await fsp.mkdir(path.join(dataDir, "blobs"), { recursive: true });
      const db = new DatabaseSync(path.join(dataDir, "workbench.db"));
      const store = new Store(db, { workspace, dataDir });
      store.migrate();
      const workbooks = new WorkbookStore({ store, cacheDir: path.join(dataDir, "doc-cache") });

      try {
        const fixture = path.join(workspace, "uploads", "test-model.xlsx");
        const generated = spawnSync(PYTHON, [FIXTURE_SCRIPT, fixture], { encoding: "utf8" });
        assert.equal(generated.status, 0, generated.stderr || "fixture generation failed");
        const material = store.indexFile("uploads/test-model.xlsx", {
          kind: "input",
          source: "upload",
          author: "test",
          note: "trace fixture",
          status: "synced",
        });
        const traceTool = createWorkbookTraceTool({ store, workbooks, workspace });

        await test("point cell returns formula, cached value and one upstream layer", async () => {
          const result = await traceTool.execute("trace-1", {
            path: "uploads/test-model.xlsx",
            cell: "Model!B6",
            depth: 1,
            maxCells: 50,
          });
          assert.equal(result.isError, undefined);
          assert.equal(result.details.mode, "cell");
          assert.equal(result.details.target.ref, "Model!B6");
          assert.match(result.details.target.formula, /SUM/);
          assert.ok(
            result.details.direct.some((cell) => cell.ref === "Model!B2"),
            "direct dependencies should include Model!B2",
          );
          assert.ok(
            result.details.tree.children.some((cell) => cell.ref === "Model!B2"),
            "upstream tree should expand at least one layer",
          );
          assert.match(result.content[0].text, /直接上游/);
          assert.match(result.content[0].text, /重算为准/);
        });

        await test("range returns formulas, values and direct dependency refs", async () => {
          const result = await traceTool.execute("trace-2", {
            path: "uploads/test-model.xlsx",
            cell: "Model!B4:C5",
            maxCells: 20,
          });
          assert.equal(result.isError, undefined);
          assert.equal(result.details.mode, "range");
          assert.equal(result.details.returned, 4);
          assert.ok(result.details.cells.some((cell) => cell.formula && cell.formula.startsWith("=")));
          assert.ok(result.details.cells.some((cell) => Array.isArray(cell.upstreamRefs)));
        });

        await test("sheet + row range enumerates the requested rows", async () => {
          const result = await traceTool.execute("trace-3", {
            path: "uploads/test-model.xlsx",
            sheet: "Assumption",
            rows: "1-3",
            maxCells: 50,
          });
          assert.equal(result.isError, undefined);
          assert.equal(result.details.mode, "rows");
          assert.ok(result.details.returned > 0);
          assert.ok(
            result.details.cells.every((cell) => cell.sheet === "Assumption" && cell.row >= 1 && cell.row <= 3),
          );
          assert.match(result.content[0].text, /行枚举/);
        });

        await test("depth and maxCells are clamped to hard limits", async () => {
          const result = await traceTool.execute("trace-4", {
            path: "uploads/test-model.xlsx",
            cell: "Model!B6",
            depth: 99,
            maxCells: 9999,
          });
          assert.equal(result.isError, undefined);
          assert.equal(result.details.depth, 15);
          assert.equal(result.details.maxCells, 500);
        });

        await test("rejects paths outside the project", async () => {
          const result = await traceTool.execute("trace-5", {
            path: "../outside.xlsx",
            cell: "Model!B2",
          });
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /project/);
        });

        await test("requires a cell or sheet+rows mode", async () => {
          const result = await traceTool.execute("trace-6", {
            path: "uploads/test-model.xlsx",
          });
          assert.equal(result.isError, true);
          assert.match(result.content[0].text, /cell|sheet/);
        });

        await test("tracing does not modify the workbook (read-only)", async () => {
          const before = sha256(fixture);
          await traceTool.execute("trace-7", {
            path: "uploads/test-model.xlsx",
            cell: "Model!B6",
            depth: 3,
          });
          assert.equal(sha256(fixture), before);
          assert.equal(store.findMaterialByPath("uploads/test-model.xlsx").id, material.id);
        });
      } finally {
        try {
          db.close();
        } catch {
          /* already closed */
        }
      }
    }
  } finally {
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) {
    for (const failure of failures) {
      console.error(`\n${failure.name}\n${failure.error.stack || failure.error.message}`);
    }
    process.exitCode = 1;
  }
}

await main();
