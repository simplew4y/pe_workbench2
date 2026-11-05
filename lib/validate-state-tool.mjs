/**
 * Pi custom tool: validate_state.
 *
 * The framework skill asks the agent to validate analysis-state.json, but the
 * runtime intentionally does not enable bash. This tool runs the same rules as
 * skills/investment-framework/scripts/validate_state.mjs inside the Node
 * process: no shell, no child_process, no Python.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { validateState } from "./validate-state.mjs";
import { insideProjectRealRoot, workspaceRel } from "./workspace-path.mjs";

const TARGET_NAME = "analysis-state.json";

function failure(message, details = {}) {
  return {
    content: [{ type: "text", text: `validate_state 失败：${message}` }],
    details: { error: message, ...details },
    isError: true,
  };
}

function insideRealRoot(workspace, absolute) {
  return insideProjectRealRoot(workspace, absolute);
}

function summarize({ rel, state, result }) {
  const { errors, warnings } = result;
  const lines = [
    `校验 ${rel}${state.subject?.company ? ` · ${state.subject.company}` : ""}` +
      ` · revision ${state.revision ?? "?"} · ${state.stage ?? "?"} · schema ${state.schema_version ?? "?"}`,
    result.ok
      ? `结果：通过（0 error，${warnings.length} warning）`
      : `结果：未通过（${errors.length} error，${warnings.length} warning）`,
  ];

  const showErrors = errors.slice(0, 20);
  const showWarnings = warnings.slice(0, 20);
  if (showErrors.length) {
    lines.push("error：");
    for (const item of showErrors) lines.push(`- ${item}`);
    if (errors.length > showErrors.length) {
      lines.push(`- …另有 ${errors.length - showErrors.length} 条 error（见结构化结果）`);
    }
  }
  if (showWarnings.length) {
    lines.push("warning：");
    for (const item of showWarnings) lines.push(`- ${item}`);
    if (warnings.length > showWarnings.length) {
      lines.push(`- …另有 ${warnings.length - showWarnings.length} 条 warning（见结构化结果）`);
    }
  }
  lines.push("判定规则：无 error 即通过；warning 不阻断，但要理解。");
  return lines.join("\n");
}

export function createValidateStateTool({ workspace, getSourceStatus = () => ({}) }) {
  return {
    name: "validate_state",
    label: "校验状态",
    description:
      "校验当前项目内的 analysis-state.json：检查方法身份、驱动引用、归因闭合、可比性、证据类型与同日反向修正。" +
      "只读结构，不判断假设对错；无 error 即通过（warning 不阻断）。有本工具时必须用它，不要因为“没有 bash”跳过校验。",
    promptSnippet: "validate_state：校验 analysis-state.json，返回结构化 error / warning",
    promptGuidelines: [
      "写完或更新 analysis-state.json 后必须调用 validate_state，path 用项目内相对路径，例如 exports/xxx/analysis-state.json。",
      "先修完所有 error；warning 可以保留，但要在报告第 7 节说明。",
      "不要用 read 手工猜结构，也不要用 bash / python / child_process；本工具与技能脚本共用同一套规则。",
    ],
    parameters: Type.Object({
      path: Type.String({
        description: "当前项目内的 analysis-state.json 相对路径，例如 exports/腾讯/analysis-state.json",
      }),
    }),
    execute: async (_toolCallId, params = {}) => {
      try {
        const rel = workspaceRel(workspace, params.path);
        if (path.posix.basename(rel) !== TARGET_NAME) {
          throw Object.assign(
            new Error(`path 必须指向 ${TARGET_NAME}（收到 ${path.posix.basename(rel) || "空路径"}）`),
            { status: 400, code: "invalid_target" },
          );
        }
        const absolute = path.join(path.resolve(workspace), rel);
        if (!fs.existsSync(absolute)) {
          throw Object.assign(new Error(`文件不存在：${rel}`), { status: 404, code: "not_found" });
        }
        if (!insideRealRoot(workspace, absolute)) {
          throw Object.assign(new Error("path must stay inside the current project"), {
            status: 403,
            code: "outside_project",
          });
        }
        if (!fs.statSync(absolute).isFile()) {
          throw Object.assign(new Error(`不是文件：${rel}`), { status: 400, code: "not_a_file" });
        }

        let state;
        try {
          state = JSON.parse(fs.readFileSync(absolute, "utf8"));
        } catch (error) {
          return failure(`无法解析 ${rel}：${error.message}`, {
            path: rel,
            ok: false,
            errorCount: 1,
            warningCount: 0,
            errors: [`无法解析 JSON：${error.message}`],
            warnings: [],
          });
        }
        if (state === null || typeof state !== "object" || Array.isArray(state)) {
          return failure("顶层必须是对象", {
            path: rel,
            ok: false,
            errorCount: 1,
            warningCount: 0,
            errors: ["顶层必须是对象"],
            warnings: [],
          });
        }

        const result = validateState(state, {sourceStatus: await getSourceStatus(state)});
        return {
          content: [{ type: "text", text: summarize({ rel, state, result }) }],
          ...(!result.ok ? {isError:true} : {}),
          details: {
            path: rel,
            ok: result.ok,
            passed: result.ok,
            errorCount: result.errors.length,
            warningCount: result.warnings.length,
            errors: result.errors,
            warnings: result.warnings,
            schemaVersion: state.schema_version ?? null,
            revision: state.revision ?? null,
            stage: state.stage ?? null,
          },
        };
      } catch (error) {
        const message = error?.message || String(error);
        return failure(message, { code: error?.code, status: error?.status });
      }
    },
  };
}

export default createValidateStateTool;
