/** Temporary workbook recalculation. Project workbooks are never written. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type } from "typebox";
import * as calcEngine from "./calc-engine.mjs";
import { workspaceRel, insideProjectRealRoot } from "./workspace-path.mjs";
import { parseCellRef } from "./workbook-trace.mjs";

function exactRef(value) {
  const parsed = parseCellRef(value);
  if (!parsed || !parsed.sheet || parsed.range) throw new Error(`需要完整单格引用 Sheet!A1：${value}`);
  return `${parsed.sheet}!${parsed.start.coord}`;
}

export function createModelWhatifTool({ workspace, calcInfo, engine = calcEngine }) {
  return {
    name: "model_whatif",
    label: "模型敏感性重算",
    description: "在临时副本修改硬编码输入，使用 LibreOffice 全工作簿重算，对比目标单元格前后值；从不修改源工作簿。不可用时明确报错，不估算。",
    promptSnippet: "model_whatif：临时副本全模型重算敏感性",
    promptGuidelines: ["敏感性必须用 model_whatif 全模型重算；否则明确标注局部（单支路）。", "只能修改硬编码输入；公式派生量不能当作输入。"],
    parameters: Type.Object({
      path: Type.String({ description: "当前项目内 .xlsx/.xlsm 文件路径" }),
      inputs: Type.Array(Type.Object({ cell: Type.String({ description: "Sheet!A1" }), value: Type.Number() }), { minItems: 1, maxItems: 100 }),
      targets: Type.Array(Type.String({ description: "待比较的 Sheet!A1" }), { minItems: 1, maxItems: 100 }),
    }),
    execute: async (_id, params = {}) => {
      let temp;
      try {
        if (!calcInfo?.available) throw new Error("LibreOffice 不可用，无法执行全模型敏感性；不会降级为估算。");
        const rel = workspaceRel(workspace, params.path);
        const source = path.resolve(workspace, rel);
        if (!insideProjectRealRoot(workspace, source)) throw new Error("路径必须位于当前项目内");
        if (!fs.existsSync(source) || !/\.(xlsx|xlsm)$/i.test(source)) throw new Error("未找到有效的 Excel 工作簿");
        if (!Array.isArray(params.inputs) || !params.inputs.length || params.inputs.length > 100 || !Array.isArray(params.targets) || !params.targets.length || params.targets.length > 100) throw new Error("inputs 和 targets 各需 1–100 个单元格");
        const inputs = params.inputs.map((item) => {
          if (!Number.isFinite(item.value)) throw new Error("输入值必须是有限数值");
          return { cell: exactRef(item.cell), value: item.value };
        });
        if (new Set(inputs.map((item) => item.cell)).size !== inputs.length) throw new Error("输入单元格不可重复");
        const targets = params.targets.map(exactRef);
        temp = await fsp.mkdtemp(path.join(os.tmpdir(), "pe-whatif-"));
        const base = path.join(temp, "base.xlsx");
        await fsp.copyFile(source, base);
        const inputValues = await engine.readCells(base, inputs.map((item) => item.cell), { formulas: true });
        for (const input of inputs) {
          if (typeof inputValues[input.cell] === "string" && inputValues[input.cell].startsWith("=")) throw new Error(`${input.cell} 是公式派生量，不能作为硬编码输入`);
        }
        const baseline = await engine.recalculateXlsx(base, { outDir: path.join(temp, "before") });
        const before = await engine.readCells(baseline, targets);
        const edited = path.join(temp, "edited.xlsx");
        await engine.writeCells(base, edited, inputs.map((input) => `${input.cell}=${JSON.stringify(input.value)}`));
        const recalculated = await engine.recalculateXlsx(edited, { outDir: path.join(temp, "after") });
        const after = await engine.readCells(recalculated, targets);
        const results = targets.map((cell) => ({ cell, before: before[cell] ?? null, after: after[cell] ?? null }));
        const details = { path: rel, inputs, results, recalculated: true };
        return { content: [{ type: "text", text: `临时副本已用 LibreOffice 全模型重算。\n${results.map((r) => `${r.cell}：${r.before ?? "无值"} → ${r.after ?? "无值"}`).join("\n")}` }], details };
      } catch (error) {
        return { content: [{ type: "text", text: `model_whatif 失败：${error.message}` }], details: { error: error.message }, isError: true };
      } finally {
        if (temp) await fsp.rm(temp, { recursive: true, force: true }).catch(() => {});
      }
    },
  };
}

export default createModelWhatifTool;
