/**
 * Pi custom tool: workbook_query.
 *
 * Kept outside server.mjs so the tool can be tested directly and reused by a
 * future RPC surface.
 */

import fs from "node:fs";
import path from "node:path";
import { Type } from "typebox";
import { workbookPresentationFromQuery } from "./workbook-presentation.mjs";
import { citationsFromCells } from "./citations.mjs";
import { workspaceRel } from "./workspace-path.mjs";

export { workspaceRel } from "./workspace-path.mjs";

export function createWorkbookTool({ store, workbooks, workspace, onMaterial = () => {} }) {
  return {
    name: "workbook_query",
    label: "查询 Excel 模型",
    description:
      "查询当前项目里的 Excel 模型（.xlsx/.xlsm）：按中文或英文关键词、年份，或 Sheet!A1 返回相关单元格、公式、缓存值和上下游依赖。" +
      "只返回相关子图，不返回整表。问收入、毛利率、EBITDA、FCF、WACC、某年假设或“这个数从哪来”时优先使用。",
    promptSnippet: "workbook_query：查询 Excel 模型的单元格、公式和上下游依赖",
    promptGuidelines: [
      "查询 .xlsx/.xlsm 时优先用 workbook_query，不要用 read 直接读二进制，也不要临时写 python。",
      "结果里的数值是工作簿缓存值；回答时给出 Sheet!A1 引用，并提醒用户以 Excel 重算为准。",
    ],
    parameters: Type.Object({
      path: Type.String({
        description:
          "当前项目内的 .xlsx/.xlsm 路径，例如 uploads/foo.xlsx",
      }),
      query: Type.String({
        description: "中文/英文关键词、年份，或 Sheet!A1；例如“2026 收入”“毛利率”“DCF!D5”",
      }),
      sheet: Type.Optional(Type.String({ description: "可选的精确工作表名；未找到会报错" })),
      maxCells: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 120,
          description: "返回的相关单元格上限，默认 40",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      try {
        const rel = workspaceRel(workspace, params.path);
        let material = store.findMaterialByPath(rel);
        if (!material) {
          const absolute = path.join(workspace, rel);
          if (!fs.existsSync(absolute)) {
            throw Object.assign(new Error(`文件不存在：${rel}`), { status: 404 });
          }
          material = store.indexFile(rel, {
            source: "agent",
            author: "Workbench",
            note: "模型查询",
            status: "draft",
          });
          onMaterial(material);
        }

        const result = await workbooks.queryMaterial(material.id, params.query, {
          maxCells: params.maxCells,
          sheet: params.sheet,
        });
        if (result.isError) return { content: [{ type: "text", text: result.text }], details: { ...result, citations: [] }, isError: true };
        const version = material.versions?.[0];
        const materialRef = {
          id: material.id,
          version: version?.v || 1,
          sha256: result.sha256,
        };
        const citations = citationsFromCells(result.cells, materialRef, { toolCallId: _toolCallId });
        const presentation = workbookPresentationFromQuery(result, {
          material: {
            id: material.id,
            path: result.path,
            version: version?.v || 1,
            sha256: result.sha256,
          },
        });
        // `content` is the only text the model sees. The structured payload is
        // a UI side channel; the host persists it so a refresh can rebuild the
        // card even when Pi's JSONL does not keep details.
        return {
          content: [{ type: "text", text: result.text }],
          details: {
            materialId: material.id,
            sha256: result.sha256,
            matchedCells: result.matchedCells,
            returned: result.returned,
            coverage: result.coverage,
            cells: result.cells,
            citations,
            presentation: {
              schema: { name: "pe.workbook-query.result", version: 1 },
              payload: presentation,
            },
          },
        };
      } catch (error) {
        const message = error?.message || String(error);
        return {
          content: [{ type: "text", text: `workbook_query 失败：${message}` }],
          details: { error: message, code: error?.code, citations: [] },
          isError: true,
        };
      }
    },
  };
}

export default createWorkbookTool;
