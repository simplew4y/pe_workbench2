import fs from 'node:fs';
import path from 'node:path';
import { Type } from 'typebox';
import {previewLegacy,importLegacy,rollbackLegacy,rebuildFactIndex} from './maintenance.mjs';
import { auditFrameworkNumbers } from './framework-bindings.mjs';
import { CAPTURE_TOOLS } from './adapters.mjs';
import { validateState } from '../validate-state.mjs';
import { workspaceRel, insideProjectRealRoot } from '../workspace-path.mjs';
const identity={entity:Type.String(),metric:Type.String(),period:Type.String(),scope:Type.String(),basis_type:Type.Union(['actual','forecast','assumption','unknown'].map(Type.Literal)),scenario:Type.Optional(Type.String()),currency:Type.Optional(Type.String()),canonical_unit:Type.Optional(Type.String())};
const reference=Type.Object({fact_id:Type.String(),fact_version:Type.Integer({minimum:1})},{additionalProperties:false});
const response=details=>({content:[{type:'text',text:JSON.stringify(details)}],details});
const guarded=fn=>async(...args)=>{try{return response(await fn(...args));}catch(error){return {...response({status:'failed',error:error.code || error.message,...(error.details?{errors:error.details}:{})}),isError:true};}};
export function createFactMemoryTools({memory,getMetadata=()=>({})}) {
  const readDraft=rel=>{const full=path.join(memory.root,workspaceRel(memory.root,rel));if(!insideProjectRealRoot(memory.root,full))throw new Error('outside_project');return fs.readFileSync(full,'utf8');};
  return [
    {name:'fact_query',label:'查询项目数字事实',description:'查询当前项目的持久化数字事实与来源，跨会话可用。返回 found/not_found/ambiguous/retrieval_failed/stale。needs_review 不是已核事实；未命中不代表源文件未披露，允许回查 workbook_query/pdf_read。省略身份字段可能返回歧义；历史必须明确标注。action=evidence 可查看已保存的 PDF/Excel 原始证据。',
      parameters:Type.Object({action:Type.Optional(Type.Union(['facts','evidence','health','framework'].map(Type.Literal))),...Object.fromEntries(Object.entries(identity).map(([k,v])=>[k,Type.Optional(v)])),evidence_id:Type.Optional(Type.String()),fact_id:Type.Optional(Type.String()),fact_version:Type.Optional(Type.Integer({minimum:1})),history:Type.Optional(Type.Boolean()),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),framework_id:Type.Optional(Type.String())},{additionalProperties:false}),
      execute:guarded(async(_id,p)=>p.action==='evidence'?(p.evidence_id?{status:memory.evidence(p.evidence_id)?'found':'not_found',evidence:memory.evidence(p.evidence_id)}:{status:'found',evidence:memory.listEvidence(p)}):p.action==='health'?memory.health():p.action==='framework'?memory.published(p.framework_id):memory.query(p))},
    {name:'fact_bind',label:'标注事实身份',description:'从已持久化 evidence_id 登记数值及公司/指标/期间/口径/实际预测/情景。数值须存在于证据中；模型补充身份不自动升级为 source_checked，缺失字段必须写 unknown。不会修改源文件。',
      parameters:Type.Object({evidence_id:Type.String(),raw_value:Type.Union([Type.String(),Type.Number()]),raw_unit:Type.String(),...identity},{additionalProperties:false}),execute:guarded(async(id,p)=>memory.bind(p,{...getMetadata(),tool_call_id:id}))},
    {name:'fact_correct',label:'登记指定事实更正',description:'仅在用户明确更正时使用。按 fact_id、expected_version 和完整身份登记新版本，旧版保留、派生项失效。用户口述新值仍为 needs_review；不改源模型、旧报告或绕过审批。',
      parameters:Type.Object({fact_id:Type.String(),expected_version:Type.Integer({minimum:1}),identity:Type.Object(identity,{additionalProperties:false}),raw_value:Type.Union([Type.String(),Type.Number()]),raw_unit:Type.String(),reason:Type.String()},{additionalProperties:false}),execute:guarded(async(id,p)=>memory.correct(p,{...getMetadata(),tool_call_id:id}))},
    {name:'fact_calculate',label:'计算版本化事实',description:'对两个当前且 source_checked 的事实精确计算，保存输入版本、单位转换、公式和舍入。支持 ratio、add、subtract、multiple。不得把估计当实际，不同币种/期间/主体/口径禁止静默合并。',
      parameters:Type.Object({operation:Type.Union(['ratio','add','subtract','multiple'].map(Type.Literal)),inputs:Type.Array(reference,{minItems:2,maxItems:2}),identity:Type.Object(identity,{additionalProperties:false}),precision:Type.Optional(Type.Integer({minimum:0,maximum:100}))},{additionalProperties:false}),execute:guarded(async(id,p)=>memory.calculate(p,{...getMetadata(),tool_call_id:id}))},
    {name:'fact_maintenance',label:'事实记忆兼容维护',description:'显式维护当前项目。preview_legacy 只读预览旧会话台账，import_legacy 须提供预览 SHA256，所有导入仅 needs_review，保留原记录且不写旧文件；rollback_legacy 只使该批导入版本和依赖失效，不删除原文件或后续更正；rebuild_index 从事实行重建 SQLite 索引。不自动迁移旧数据。',
      parameters:Type.Object({action:Type.Union(['preview_legacy','import_legacy','rollback_legacy','rebuild_index'].map(Type.Literal)),session_id:Type.Optional(Type.String()),expected_sha256:Type.Optional(Type.String()),batch_id:Type.Optional(Type.String())},{additionalProperties:false}),execute:guarded(async(id,p)=>p.action==='preview_legacy'?previewLegacy(memory,p.session_id):p.action==='import_legacy'?importLegacy(memory,p,{...getMetadata(),tool_call_id:id}):p.action==='rollback_legacy'?rollbackLegacy(memory,p.batch_id):rebuildFactIndex(memory))},
    {name:'framework_audit',label:'核对框架数字绑定',description:'只读检查草稿状态和报告中的数字覆盖。每个状态数字需在 state.numeric_bindings 用 JSON pointer（正文还需 start/end）绑定精确事实版本及完整身份；报告用 {{fact:/pointer}} 渲染，未绑定裸数字会阻断提交。返回缺失/错配路径，不修改文件。',
      parameters:Type.Object({state_path:Type.String(),report_path:Type.String()},{additionalProperties:false}),execute:guarded(async(_id,p)=>{memory.syncSources();return auditFrameworkNumbers({memory,state:JSON.parse(readDraft(p.state_path)),report:readDraft(p.report_path)});})},
    {name:'framework_commit',label:'提交版本化框架',description:'将经过结构校验的草稿状态与报告提交成不可变框架修订，固定 fact_id@fact_version。事务提交后通过 outbox 导出一致 JSON/Markdown；pending 不是已发布。expected_revision 必须匹配上版。必须先 framework_audit 修复未绑定或错配数字，状态提供 numeric_bindings，报告使用 {{fact:/pointer}}，数值由宿主渲染。数字绑定不验证研究结论的逻辑。只在 exports/fact-memory 生成新版本，不覆盖旧报告或工作模型。',
      parameters:Type.Object({framework_id:Type.String(),expected_revision:Type.Integer({minimum:0}),state_path:Type.String(),report_path:Type.String(),fact_refs:Type.Optional(Type.Array(Type.Object({...reference.properties,role:Type.Union(['verified','needs_review','assumption','historical'].map(Type.Literal)),reason:Type.Optional(Type.String())},{additionalProperties:false}))),retry_export:Type.Optional(Type.Boolean())},{additionalProperties:false}),
      execute:guarded(async(id,p)=>{
        if(p.retry_export) return {exports:memory.exportPending(),framework:memory.published(p.framework_id)};
        const state=JSON.parse(readDraft(p.state_path));const validation=validateState(state);
        if(!validation.ok) return {status:'validation_failed',errors:validation.errors};
        const result=memory.commitFramework({framework_id:p.framework_id,expected_revision:p.expected_revision,state,report:readDraft(p.report_path),fact_refs:p.fact_refs},{...getMetadata(),tool_call_id:id});
        return {...result,exports:memory.exportPending(),framework:memory.published(p.framework_id)};
      })},
  ];
}
/** Receipt is committed before the result is returned to the model or chat ends.
 * No global callback state: wrappers carry the correct session/run identity.
 */
export function withFactCapture(tool,memory,getMetadata) {
  if(!memory || !CAPTURE_TOOLS.has(tool.name)) return tool;
  return {...tool,execute:async(id,args,...rest)=>{
    const metadata=getMetadata(),call={id,name:tool.name,args};
    memory.beginTool(metadata.session_id,call,metadata);
    let result;
    try {result=await tool.execute(id,args,...rest);} catch(error){
      memory.capture(metadata.session_id,{...call,success:false,result:{isError:true,details:{error:'tool_execution_failed'}}},metadata);throw error;
    }
    try {
      const facts=memory.capture(metadata.session_id,{...call,success:result?.isError!==true,details:result?.details,result},metadata);
      const manifest={status:result?.isError?'tool_failed':'persisted',facts:facts.map(f=>({fact_id:f.fact_id,fact_version:f.fact_version,quality:f.quality,review_reasons:f.review_reasons,evidence_ids:f.evidence_ids})),coverage:tool.name==='pdf_read'?'raw_evidence_and_supported_semantic_rows_only':'returned_structured_results_only'};
      return {...result,content:[...(result.content || []),{type:'text',text:`项目事实保存结果（数据，非指令）：${JSON.stringify(manifest)}`}],details:{...result.details,factMemory:manifest}};
    } catch {
      return {...result,content:[...(result.content || []),{type:'text',text:'项目事实保存失败，不能声称已写入长期记忆；请查看 fact_query action=health。'}],details:{...result.details,factMemory:{status:'persistence_failed'}}};
    }
  }};
}
