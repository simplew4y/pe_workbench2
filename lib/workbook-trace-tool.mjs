/**
 * Pi custom tool: workbook_trace.
 *
 * Read-only companion to workbook_query. It lets the agent reproduce a formula
 * chain by cell reference instead of hoping a semantic keyword search finds the
 * synthetic target-price cell. It never writes the workbook or the model.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";

import { insideProjectRealRoot, workspaceRel } from "./workspace-path.mjs";
import {
  TRACE_DEFAULT_DEPTH,
  TRACE_DEFAULT_MAX_CELLS,
  TRACE_MAX_CELLS,
  TRACE_MAX_DEPTH,
} from "./workbook-trace.mjs";

export function createWorkbookTraceTool({ store, workbooks, workspace, onMaterial = () => {} }) {
  return {
    name: "workbook_trace",
    label: "追踪公式",
    description:
      "按单元格复现 Excel 公式链（只读）：cell=\"Sheet!A1\" 或区域返回公式、缓存值和直接依赖；从输出格向上游走 depth 层；" +
      "mode=path + from/to 验证下游可达路径；mode=impact + cell 枚举下游影响。无路径仅限解析图，不能证明Excel不存在依赖。也可按 sheet + 行范围枚举（单次最多 1000 行），便于人工式扫读 SOTP 表。缓存值可能不是最新，以 Excel/LibreOffice 重算为准。",
    promptSnippet: "workbook_trace：按格/区域/行范围追踪公式、缓存值和上游依赖",
    promptGuidelines: [
      "workbook_query 按关键词捞不到合成目标价、折价、股本、汇率、分部倍数等链路时，改用 workbook_trace 指定 Sheet!A1 或区域。",
      "验证输入是否影响输出：mode=path，from=输入格，to=输出格，沿下游走；反向不通不能否定正向依赖。",
      "要知道某格从哪来：cell 指定输出格并给 depth（默认 5，最大 15），向上游展开直接依赖。",
      "单项核查先取得所问格的值、公式与用途证据；这些已足够时直接回答，无需为补充旁证扩大到整块或其他期间。行标签只引用工作表与行号，不补未知列坐标。",
      "要扫 SOTP 表：给 sheet 与 rows（如 \"5-40\"），或 rowStart/rowEnd；返回有硬上限。",
      "结果里的数值是工作簿缓存值，可能不是最新；回答时注明以 Excel/LibreOffice 重算为准。不要写入模型。",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("path"),Type.Literal("impact")])),
      from: Type.Optional(Type.String({description:"被扰动输入/原因起点 Sheet!A1；例如资本开支格。方向为输入→受影响输出，不能倒置"})),
      to: Type.Optional(Type.String({description:"受影响输出/结果终点 Sheet!A1；例如目标价格"})),
      path: Type.String({
        description: "当前项目内的 .xlsx/.xlsm 路径，例如 uploads/model.xlsx",
      }),
      cell: Type.Optional(
        Type.String({
          description: '单个格或区域，例如 "SOTP!D20"、"SOTP!B2:D10"；不填则用 sheet+rows',
        }),
      ),
      sheet: Type.Optional(
        Type.String({ description: "按行枚举时的工作表名，例如 SOTP" }),
      ),
      rows: Type.Optional(
        Type.String({ description: '按行枚举的行范围，例如 "5" 或 "5-40"' }),
      ),
      rowStart: Type.Optional(
        Type.Number({ minimum: 1, description: "按行枚举的起始行（与 rows 二选一）" }),
      ),
      rowEnd: Type.Optional(
        Type.Number({ minimum: 1, description: "按行枚举的结束行（与 rows 二选一）" }),
      ),
      depth: Type.Optional(
        Type.Number({
          minimum: 0,
          maximum: TRACE_MAX_DEPTH,
          description: `从目标格向上游展开的层数，默认 ${TRACE_DEFAULT_DEPTH}，最大 ${TRACE_MAX_DEPTH}`,
        }),
      ),
      maxCells: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: TRACE_MAX_CELLS,
          description: `返回单元格上限，默认 ${TRACE_DEFAULT_MAX_CELLS}，最大 ${TRACE_MAX_CELLS}`,
        }),
      ),
      maxChars: Type.Optional(
        Type.Number({
          minimum: 1000,
          maximum: 16000,
          description: "文本输出字符上限，默认 16000",
        }),
      ),
    }),
    execute: async (_toolCallId, params = {}) => {
      try {
        const rel = workspaceRel(workspace, params.path);
        const absolute = path.join(path.resolve(workspace), rel);
        if (fs.existsSync(absolute) && !insideProjectRealRoot(workspace, absolute)) {
          throw Object.assign(new Error("path must stay inside the current project"), {
            status: 403,
            code: "outside_project",
          });
        }
        let material = store.findMaterialByPath(rel);
        if (!material) {
          if (!fs.existsSync(absolute)) {
            throw Object.assign(new Error(`文件不存在：${rel}`), { status: 404 });
          }
          material = store.indexFile(rel, {
            source: "agent",
            author: "Workbench",
            note: "公式链追踪",
            status: "draft",
          });
          onMaterial(material);
        }

        const result = await workbooks.traceMaterial(material.id, {
          mode: params.mode, from: params.from, to: params.to,
          cell: params.cell,
          sheet: params.sheet,
          rows: params.rows,
          rowStart: params.rowStart,
          rowEnd: params.rowEnd,
          depth: params.depth,
          maxCells: params.maxCells,
          maxChars: params.maxChars,
        });
        const { text, ...details } = result;
        return {
          content: [{ type: "text", text }],
          details,
        };
      } catch (error) {
        const message = error?.message || String(error);
        return {
          content: [{ type: "text", text: `workbook_trace 失败：${message}` }],
          details: { error: message, code: error?.code, status: error?.status },
          isError: true,
        };
      }
    },
  };
}

export default createWorkbookTraceTool;
