import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Type } from 'typebox';
import { workspaceRel, insideProjectRealRoot } from './workspace-path.mjs';
import { parseCellRef } from './workbook-trace.mjs';
import * as engine from './calc-engine.mjs';
function ref(value){const p=parseCellRef(value);if(!p?.sheet||p.range||p.start.row>1048576||p.start.col>16384)throw Error('需要单个 Sheet!A1 引用');return `${p.sheet}!${p.start.coord}`;}
export function createModelWhatifTool({workspace,calculator=engine}){
 let busy=false;
 return {name:'model_whatif',label:'副本情景重算',description:'仅在临时副本上改数值常量并用LibreOffice分别重算基准/情景，返回输出差额及原缓存漂移。禁止覆盖公式、原文件；只支持xlsx。不保证Excel兼容性，失败不可用心算冒充重算。',parameters:Type.Object({path:Type.String(),changes:Type.Array(Type.Object({cell:Type.String(),value:Type.Number()}),{minItems:1,maxItems:10}),outputs:Type.Array(Type.String(),{minItems:1,maxItems:10})}),async execute(_id,args){let dir;let acquired=false;try{
  if(busy)throw Error('该项目已有情景重算在运行，请稍后重试');busy=true;acquired=true;
  const rel=workspaceRel(workspace,args.path),source=path.resolve(workspace,rel);
  if(!insideProjectRealRoot(workspace,source)||!rel.toLowerCase().endsWith('.xlsx'))throw Error('只支持项目内真实xlsx文件');
  if(!Array.isArray(args.changes)||!args.changes.length||args.changes.length>10||!Array.isArray(args.outputs)||!args.outputs.length||args.outputs.length>10)throw Error('changes/outputs需1–10项');
  const changes=args.changes.map(c=>({cell:ref(c.cell),value:c.value})),outputs=[...new Set(args.outputs.map(ref))];
  if(changes.some(c=>typeof c.value!=='number'||!Number.isFinite(c.value))||new Set(changes.map(c=>c.cell)).size!==changes.length)throw Error('修改必须是有限数值且单元格不重复');
  const info=await calculator.sofficeInfo();if(!info.available)throw Error('LibreOffice不可用，未执行重算');
  dir=await fs.mkdtemp(path.join(os.tmpdir(),'pe-whatif-'));const copy=path.join(dir,'source.xlsx');await fs.copyFile(source,copy);
  const inputs=await calculator.readCells(copy,changes.map(c=>c.cell),{formulas:true});
  for(const c of changes)if(typeof inputs[c.cell]!=='number'||!Number.isFinite(inputs[c.cell]))throw Error(`${c.cell}不是数值常量（可能是公式/空值），禁止独立扰动`);
  const cached=await calculator.readCells(copy,outputs);
  const baselineFile=await calculator.recalculateXlsx(copy,{outDir:path.join(dir,'baseline'),timeoutMs:90000});
  const baseline=await calculator.readCells(baselineFile,outputs);
  const edited=path.join(dir,'scenario.xlsx');await calculator.writeCells(copy,edited,changes.map(c=>`${c.cell}=${c.value}`));
  const scenarioFile=await calculator.recalculateXlsx(edited,{outDir:path.join(dir,'scenario'),timeoutMs:90000});
  const scenario=await calculator.readCells(scenarioFile,outputs);
  const rows=outputs.map(cell=>{
   if(!Number.isFinite(baseline[cell])||!Number.isFinite(scenario[cell]))throw Error(`${cell}重算后不是有限数值；未取得有效情景`);
   return {cell,cached:cached[cell]??null,baseline:baseline[cell],scenario:scenario[cell],delta:scenario[cell]-baseline[cell],cacheDrift:Number.isFinite(cached[cell])?baseline[cell]-cached[cell]:null};
  });
  const result={engine:info.version||'LibreOffice',scope:'temporary_copy_recalculation',changes,outputs:rows,compatibility:'未验证与Excel等价；动态引用、外部链接、插件及特殊函数需原引擎复核。缓存漂移单列，不混入扰动影响。',originalModified:false};
  return {content:[{type:'text',text:JSON.stringify(result)}],details:result};
 }catch(e){return {content:[{type:'text',text:'model_whatif 失败：'+e.message}],details:{error:e.message,recalculationVerified:false},isError:true};}
 finally{if(dir)await fs.rm(dir,{recursive:true,force:true});if(acquired)busy=false;}}
 };
}
