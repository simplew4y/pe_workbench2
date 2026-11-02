#!/usr/bin/env node
/**
 * End-to-end smoke test for `bin/pe.mjs`.
 *
 * Starts the real HTTP stack with createWorkbench() on an ephemeral port and
 * drives the CLI as a child process. PI_FAKE_AGENT=1 keeps model calls local and
 * the storage root is a temporary directory; no secrets or real projects touch
 * the test.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../server/config.mjs";
import { createWorkbench } from "../server/create-app.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CLI = path.join(ROOT, "bin", "pe.mjs");
const silent = { log() {}, warn() {}, error() {} };

let passed = 0;
let failed = 0;
async function run(name, fn) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
    passed += 1;
  } catch (error) {
    console.error(`  fail ${name}`);
    console.error(`       ${error.stack || error.message}`);
    failed += 1;
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pe-cli-test-"));
let app = null;
let baseUrl = "";
let defaultProject = "";

function cliEnv() {
  return {
    ...process.env,
    PE_CONFIG: path.join(tmp, "pe-config.json"),
    PE_BASE_URL: "",
    PE_PROJECT: "",
    PI_FAKE_AGENT: "1",
    WORKBENCH_STORAGE_ROOT: tmp,
    WORKBENCH_PROJECTS_DIR: path.join(tmp, "projects"),
    TRACKING_SCHEDULER: "0",
    MONITOR_SCHEDULER: "0",
    SOURCE_SCHEDULER: "0",
    WATCH_SCHEDULER: "0",
    WORKBOOK_QUERY: "0",
    PDF_READ: "0",
    WESTOCK_QUERY: "0",
    ANYSEARCH_QUERY: "0",
    ASR: "0",
  };
}

function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: cliEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({
      code,
      stdout: Buffer.concat(stdout).toString("utf8"),
      stderr: Buffer.concat(stderr).toString("utf8"),
    }));
  });
}

function parseJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${label} 输出不是 JSON：${error.message}\nstdout=${result.stdout}\nstderr=${result.stderr}`);
  }
}

async function main() {
  const config = await loadConfig({
    env: {
      ...cliEnv(),
      PORT: "0",
      WORKBENCH_TEST: "1",
    },
  });
  app = await createWorkbench({ config, logger: silent });
  const address = await app.listen(0, "127.0.0.1");
  baseUrl = address.url;
  defaultProject = app.defaultStore.listProjects()[0].id;

  const base = ["--base-url", baseUrl, "--json"];

  console.log("\nCLI help");
  await run("pe --help exits 0 and lists command groups", async () => {
    const result = await runCli(["--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /doctor/);
    assert.match(result.stdout, /material/);
  });

  await run("pe doctor --help exits 0", async () => {
    const result = await runCli(["doctor", "--help"]);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /pe doctor/);
  });

  console.log("\nread commands");
  await run("doctor returns a secret-free health summary", async () => {
    const result = await runCli(["doctor", ...base]);
    assert.equal(result.code, 0, result.stderr);
    const health = parseJson(result, "doctor");
    assert.equal(health.ok, true);
    assert.ok(health.model);
    assert.equal(typeof health.asr?.configured, "boolean");
    assert.equal(JSON.stringify(health).includes("API_KEY"), false);
  });

  const uploadFile = path.join(tmp, "cli-fixture.txt");
  fs.writeFileSync(uploadFile, "hello from pe cli\n");

  await run("material list starts empty and material upload works", async () => {
    const before = await runCli(["material", "list", ...base]);
    assert.equal(before.code, 0, before.stderr);
    assert.deepEqual(parseJson(before, "material list"), []);

    const upload = await runCli(["material", "upload", uploadFile, ...base]);
    assert.equal(upload.code, 0, upload.stderr);
    const uploaded = parseJson(upload, "material upload");
    assert.equal(uploaded.length, 1);
    assert.ok(uploaded[0].material?.id);
    assert.equal(uploaded[0].name, "cli-fixture.txt");

    const after = await runCli(["material", "list", ...base]);
    assert.equal(after.code, 0, after.stderr);
    const materials = parseJson(after, "material list");
    assert.equal(materials.length, 1);
    assert.equal(materials[0].name, "cli-fixture.txt");
    assert.match(materials[0].relPath, /^uploads\//);
  });

  await run("material show/download/file round-trip the uploaded version", async () => {
    const materials = parseJson(
      await runCli(["material", "list", ...base]),
      "material list",
    );
    const material = materials[0];
    const shown = await runCli(["material", "show", material.id, ...base]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(parseJson(shown, "material show").relPath, material.relPath);

    const downloaded = path.join(tmp, "downloaded.txt");
    const download = await runCli([
      "material", "download", material.id,
      "--version", String(material.versions[0].v),
      "--output", downloaded,
      ...base,
    ]);
    assert.equal(download.code, 0, download.stderr);
    assert.equal(fs.readFileSync(downloaded, "utf8"), "hello from pe cli\n");

    const copied = path.join(tmp, "copied.txt");
    const file = await runCli(["material", "file", material.relPath, "--output", copied, ...base]);
    assert.equal(file.code, 0, file.stderr);
    assert.equal(fs.readFileSync(copied, "utf8"), "hello from pe cli\n");
  });

  await run("material restore creates a new version", async () => {
    const materials = parseJson(
      await runCli(["material", "list", ...base]),
      "material list",
    );
    const material = materials[0];
    const currentVersion = material.versions[0].v;
    const restored = await runCli([
      "material", "restore", material.id,
      "--version", String(currentVersion),
      "--yes",
      ...base,
    ]);
    assert.equal(restored.code, 0, restored.stderr);
    const next = parseJson(restored, "material restore");
    assert.equal(next.versions[0].v, currentVersion + 1);
  });

  await run("track lifecycle: create/show/schedule/toggle/events/monitors/delete", async () => {
    const materials = parseJson(
      await runCli(["material", "list", ...base]),
      "material list",
    );
    const targetId = materials[0].id;
    const created = await runCli([
      "track", "create",
      "--target", targetId,
      "--template", "model",
      "--freq", "weekly",
      "--weekday", "3",
      "--time", "09:30",
      ...base,
    ]);
    assert.equal(created.code, 0, created.stderr);
    const tracking = parseJson(created, "track create").tracking;
    assert.equal(tracking.targetId, targetId);

    const shown = await runCli(["track", "show", tracking.id, ...base]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(parseJson(shown, "track show").id, tracking.id);

    const scheduled = await runCli([
      "track", "schedule", tracking.id,
      "--freq", "daily",
      "--time", "08:15",
      ...base,
    ]);
    assert.equal(scheduled.code, 0, scheduled.stderr);
    assert.equal(parseJson(scheduled, "track schedule").schedule.freq, "daily");

    const disabled = await runCli(["track", "disable", tracking.id, ...base]);
    assert.equal(disabled.code, 0, disabled.stderr);
    assert.equal(parseJson(disabled, "track disable").tracking.enabled, false);

    const enabled = await runCli(["track", "enable", tracking.id, ...base]);
    assert.equal(enabled.code, 0, enabled.stderr);
    assert.equal(parseJson(enabled, "track enable").tracking.enabled, true);

    const events = await runCli(["track", "events", tracking.id, ...base]);
    assert.equal(events.code, 0, events.stderr);
    parseJson(events, "track events");

    const monitors = await runCli(["track", "monitor", "list", tracking.id, ...base]);
    assert.equal(monitors.code, 0, monitors.stderr);
    parseJson(monitors, "track monitor list");

    const deleted = await runCli(["track", "delete", tracking.id, "--yes", ...base]);
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal(parseJson(deleted, "track delete").id, tracking.id);
  });

  await run("approval list/show/reject uses the real approval DTO", async () => {
    const approval = app.defaultStore.createApprovalRequest({
      kind: "model_write",
      payload: { summary: "CLI 审批测试" },
      status: "pending_approval",
    });
    const list = await runCli(["approval", "list", "--status", "pending_approval", "--project", defaultProject, ...base]);
    assert.equal(list.code, 0, list.stderr);
    assert.ok(parseJson(list, "approval list").some((item) => item.id === approval.id));

    const shown = await runCli(["approval", "show", approval.id, "--project", defaultProject, ...base]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(parseJson(shown, "approval show").id, approval.id);

    const rejected = await runCli([
      "approval", "reject", approval.id,
      "--reason", "CLI 测试拒绝",
      "--yes",
      "--project", defaultProject,
      ...base,
    ]);
    assert.equal(rejected.code, 0, rejected.stderr);
    const result = parseJson(rejected, "approval reject");
    assert.equal(result.ok, true);
    assert.equal(result.approval.status, "rejected");
  });

  await run("session and other read-only groups return parseable JSON", async () => {
    const created = await runCli(["session", "new", ...base]);
    assert.equal(created.code, 0, created.stderr);
    const session = parseJson(created, "session new");
    assert.ok(session.id);

    const shown = await runCli(["session", "show", session.id, ...base]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.equal(parseJson(shown, "session show").sessionId, session.id);

    const list = await runCli(["session", "list", ...base]);
    assert.equal(list.code, 0, list.stderr);
    assert.ok(parseJson(list, "session list").some((item) => item.id === session.id));

    const reads = [
      ["plan", "list"],
      ["track", "list"],
      ["approval", "list"],
      ["watch", "status"],
      ["trace", "show"],
    ];
    for (const args of reads) {
      const result = await runCli([...args, "--project", defaultProject, ...base]);
      assert.equal(result.code, 0, `${args.join(" ")}\n${result.stderr}`);
      parseJson(result, args.join(" "));
    }
  });

  console.log("\nwrite paths");
  let createdProject = null;
  await run("project create writes a real project", async () => {
    const result = await runCli([
      "project", "create",
      "--name", "CLI 测试项目",
      "--note", "issue-2",
      ...base,
    ]);
    assert.equal(result.code, 0, result.stderr);
    createdProject = parseJson(result, "project create");
    assert.match(createdProject.id, /^p-/);
    assert.equal(createdProject.name, "CLI 测试项目");

    const list = await runCli(["project", "list", ...base]);
    assert.equal(list.code, 0, list.stderr);
    const projects = parseJson(list, "project list");
    assert.ok(projects.some((project) => project.id === createdProject.id));
  });

  await run("project update changes name and note", async () => {
    const result = await runCli([
      "project", "update", createdProject.id,
      "--name", "CLI 改名项目",
      "--note", "updated-by-cli",
      ...base,
    ]);
    assert.equal(result.code, 0, result.stderr);
    const updated = parseJson(result, "project update");
    assert.equal(updated.name, "CLI 改名项目");
    assert.equal(updated.note, "updated-by-cli");
  });

  await run("project use stores the default project in PE_CONFIG", async () => {
    const result = await runCli(["project", "use", createdProject.id, ...base]);
    assert.equal(result.code, 0, result.stderr);
    const used = parseJson(result, "project use");
    assert.equal(used.project, createdProject.id);
    const saved = JSON.parse(fs.readFileSync(path.join(tmp, "pe-config.json"), "utf8"));
    assert.equal(saved.project, createdProject.id);
  });

  await run("saved default project scopes project-data requests", async () => {
    const result = await runCli(["material", "list", "--base-url", baseUrl, "--json"]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parseJson(result, "scoped material list"), []);
  });

  await run("notification read marks a real notification", async () => {
    const notification = app.defaultStore.createNotification({
      severity: "info",
      title: "CLI 测试通知",
      body: "由 test-cli.mjs 创建",
    });
    const list = await runCli(["notification", "list", "--project", defaultProject, ...base]);
    assert.equal(list.code, 0, list.stderr);
    const notifications = parseJson(list, "notification list");
    assert.ok(notifications.some((item) => item.id === notification.id));

    const read = await runCli(["notification", "read", notification.id, "--project", defaultProject, ...base]);
    assert.equal(read.code, 0, read.stderr);
    const updated = parseJson(read, "notification read");
    assert.ok(updated.readAt);
  });

  console.log("\ndanger guard");
  await run("material delete refuses without --yes", async () => {
    const materials = parseJson(
      await runCli(["material", "list", "--project", defaultProject, ...base]),
      "material list",
    );
    const id = materials[0].id;
    const denied = await runCli(["material", "delete", id, "--project", defaultProject, ...base]);
    assert.equal(denied.code, 2);
    assert.match(denied.stderr, /--yes/);
    const stillThere = parseJson(
      await runCli(["material", "show", id, "--project", defaultProject, ...base]),
      "material show",
    );
    assert.equal(stillThere.id, id);
  });

  await run("material delete succeeds with --yes and removes it from the list", async () => {
    const materials = parseJson(
      await runCli(["material", "list", "--project", defaultProject, ...base]),
      "material list",
    );
    const id = materials[0].id;
    const deleted = await runCli(["material", "delete", id, "--yes", "--project", defaultProject, ...base]);
    assert.equal(deleted.code, 0, deleted.stderr);
    assert.equal(parseJson(deleted, "material delete").id, id);
    const after = parseJson(
      await runCli(["material", "list", "--project", defaultProject, ...base]),
      "material list",
    );
    assert.equal(after.length, 0);
  });
}

try {
  await main();
} catch (error) {
  console.error(error.stack || error.message);
  failed += 1;
} finally {
  if (app) await app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
