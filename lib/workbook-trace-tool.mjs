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
import { citationsFromTrace, calculationSourceText, traceCells } from "./citations.mjs";
import {
  TRACE_DEFAULT_DEPTH,
  TRACE_DEFAULT_MAX_CELLS,
  TRACE_MAX_CELLS,
  TRACE_MAX_DEPTH,
} from "./workbook-trace.mjs";

const MAX_BATCH = 4;
const queryFields = {
  cell: Type.Optional(Type.String()),
  sheet: Type.Optional(Type.String()),
  rows: Type.Optional(Type.String()),
  rowStart: Type.Optional(Type.Integer({ minimum: 1 })),
  rowEnd: Type.Optional(Type.Integer({ minimum: 1 })),
  depth: Type.Optional(Type.Integer({ minimum: 0, maximum: TRACE_MAX_DEPTH })),
  maxCells: Type.Optional(Type.Integer({ minimum: 1, maximum: TRACE_MAX_CELLS })),
  maxChars: Type.Optional(Type.Integer({ minimum: 1000, maximum: 4000 })),
};

async function runTraceBatch(workbooks, material, batch, toolCallId) {
  const unique = new Map();
  const positions = batch.map(query => {
    const normalized = { ...query, maxChars: query.maxChars ?? 4000 };
    const key = JSON.stringify(normalized,Object.keys(normalized).sort());
    if (!unique.has(key)) unique.set(key,{ query:normalized,index:unique.size });
    return unique.get(key).index;
  });
  const results = await workbooks.traceMaterial(material.id,[...unique.values()].map(entry=>entry.query));
  const first = new Map();
  const lines = [];
  const subtraces = [];
  const allCells = new Map();
  const allCitations = new Map();
  let metadata;
  for (const [position,index] of positions.entries()) {
    const label = `#${position + 1}`;
    if (first.has(index)) {
      lines.push(`${label} 请求重复，结果同 #${first.get(index)}。`);
      subtraces.push({ duplicateOf:first.get(index) });
      continue;
    }
    first.set(index,position + 1);
    const {text,...details} = results[index];
    subtraces.push(details);
    if (details.error) {
      lines.push(`${label} 追踪失败：${details.error}`);
      continue;
    }
    metadata ??= details;
    lines.push(`${label}\n${text}`);
    for (const cell of traceCells(details)) if (!allCells.has(cell.ref)) allCells.set(cell.ref,cell);
    for (const citation of citationsFromTrace(details,{ id:material.id,name:details.name,path:details.path,
      version:details.version,sha256:details.sha256 },{toolCallId})) allCitations.set(citation.id,citation);
  }
  const citations = [...allCitations.values()];
  const partial = subtraces.some(trace=>trace.error);
  const text = lines.join("\n\n")+calculationSourceText(citations);
  return {content:[{type:"text",text}],details:{
    mode:"batch",status:metadata ? "ready" : "error",partial,
    path:metadata?.path,materialId:material.id,version:metadata?.version,sha256:metadata?.sha256,
    cells:[...allCells.values()],citations,subtraces,
  },...(!metadata ? {isError:true} : {})};
}

export function createWorkbookTraceTool({ store, workbooks, workspace, onMaterial = () => {} }) {
  return {
    name: "workbook_trace",
    label: "追踪公式",
    description:
      "按单元格复现 Excel 公式链（只读）：cell=\"Sheet!A1\" 或区域返回公式、缓存值和直接依赖；从输出格向上游走 depth 层；" +
      "也可按 sheet + 行范围枚举，或用 batch 一次查询同一工作簿内多个独立格/区域。缓存值可能不是最新，以 Excel/LibreOffice 重算为准。",
    promptSnippet: "workbook_trace：按格/区域/行范围追踪公式、缓存值和上游依赖",
    promptGuidelines: [
      "在声称 X 不影响 Y 之前，必须用 mode=path、from=X、to=Y 核验已解析依赖图；不可达仅限本次解析范围。",
      "敏感性必须使用 model_whatif；否则明确标注为局部（单支路），不得声称全模型影响。",
      "workbook_query 按关键词捞不到合成目标价、折价、股本、汇率、分部倍数等链路时，改用 workbook_trace 指定 Sheet!A1 或区域。",
      "要知道某格从哪来：cell 指定输出格并给 depth（默认 5，最大 15），向上游展开直接依赖。",
      "要扫 SOTP 表：给 sheet 与 rows（如 \"5-40\"），或 rowStart/rowEnd；返回有硬上限。",
      "同一版本已展示的行和公式直接引用，不要重复扫包含它们的行段。若截断、缺格或需要完整上游链，只查缺失的格或更窄的范围。多个已知且互不依赖的目标可在同一批发出，后续依赖结果的调用再顺序执行。",
      "已知多个独立坐标或行段时，优先用同一 path 下的 batch（最多 4 项），不必每读一个格就重新推理一次。批量仅查格/区域，不替代 mode=path/impact 或 model_whatif。",
      "结果里的数值是工作簿缓存值，可能不是最新；回答时注明以 Excel/LibreOffice 重算为准。不要写入模型。",
    ],
    parameters: Type.Object({
      mode: Type.Optional(Type.Union([Type.Literal("cell"), Type.Literal("path"), Type.Literal("impact")])),
      from: Type.Optional(Type.String({ description: "path 起点 Sheet!A1" })),
      to: Type.Optional(Type.String({ description: "path 终点 Sheet!A1" })),
      path: Type.String({
        description: "当前项目内的 .xlsx/.xlsm 路径，例如 uploads/model.xlsx",
      }),
      batch: Type.Optional(Type.Array(Type.Object(queryFields,{additionalProperties:false}),{
        minItems:1,maxItems:MAX_BATCH,description:"同一工作簿已知且互不依赖的格、矩形区域或行段；每项独立返回并标明截断。",
      })),
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

        if (params.batch !== undefined) {
          const keys = new Set(Object.keys(queryFields));
          if (!Array.isArray(params.batch) || !params.batch.length || params.batch.length > MAX_BATCH ||
            Object.keys(params).some(key=>!["path","batch"].includes(key)) ||
            params.batch.some(query=>!query || Object.keys(query).some(key=>!keys.has(key)) ||
              Boolean(query.cell) === Boolean(query.sheet) ||
              query.maxChars != null && (!Number.isInteger(query.maxChars) || query.maxChars < 1000 || query.maxChars > 4000))) {
            throw new Error("batch 只能和 path 一起使用；每项指定格/矩形或工作表与行范围。路径/影响查询须单独调用。");
          }
          return await runTraceBatch(workbooks,material,params.batch,_toolCallId);
        }
        const result = await workbooks.traceMaterial(material.id, {
          mode: params.mode,
          from: params.from,
          to: params.to,
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
        const version = result.version ?? material.versions?.[0]?.v ?? 1;
        const citations = citationsFromTrace(result, {
          id: material.id, name: result.name || material.name, path: result.path, version, sha256: result.sha256,
        }, { toolCallId: _toolCallId });
        return {
          content: [{ type: "text", text:text+calculationSourceText(citations) }],
          details: { ...details, citations },
        };
      } catch (error) {
        const message = error?.message || String(error);
        return {
          content: [{ type: "text", text: `workbook_trace 失败：${message}` }],
          details: { error: message, code: error?.code, status: error?.status, citations: [] },
          isError: true,
        };
      }
    },
  };
}

export default createWorkbookTraceTool;
