import path from 'node:path';
import {validateState} from './validate-state.mjs';

/** A single write entry: report review stays mandatory, without a failed call
 * just to tell the model to resubmit the same body under another tool name. */
export function createResearchWriteTool({rawWrite, review, authorizeWrite=()=>undefined}) {
  return {...rawWrite,
    description:rawWrite.description+' exports/ 下的 Markdown 报告自动先审校后保存，不绕过证据核验。analysis-state.json 写入后自动返回完整结构校验结果；未通过时修复字段，无需另一次调用来发现错误。',
    execute:async(id,args,signal,update,context)=>{
      const denied=authorizeWrite(args);
      if(denied?.block)return {isError:true,content:[{type:'text',text:denied.reason}]};
      if(review.takeSavingWrite(args))return rawWrite.execute(id,args,signal,update,context);
      if(review.isReportWrite(args) && !review.isApprovedWrite(args) && !/^> 已撤回：[^\n]+\n/.test(args.content || '')) {
        const reviewed=await review.tool.execute(id,{path:args.path,content:args.content,save:true},signal,update,{
          ...context,executeTool:async(name,write)=>{
            if(name!=='write')throw new Error('报告保存只允许 write');
            const blocked=authorizeWrite(write);
            if(blocked?.block)return {isError:true,result:{isError:true,content:[{type:'text',text:blocked.reason}]}};
            return {result:await rawWrite.execute(id,write,signal,update,context)};
          },
        });
        return {...reviewed,details:{...reviewed.details,researchWriteHandled:true}};
      }
      const guard=review.before('write',args);
      if(guard?.block)return {isError:true,content:[{type:'text',text:guard.reason}]};
      const result=await rawWrite.execute(id,args,signal,update,context);
      if(result.isError || path.basename(args.path)!=='analysis-state.json')return result;
      let validation;
      try {validation=validateState(JSON.parse(args.content));}
      catch {validation={ok:false,errors:['状态不是有效 JSON 对象'],warnings:[]};}
      // Saved and validated are distinct facts. Do not turn a validation
      // failure into an IO failure or silently change research semantics.
      const stateValidation={...validation,structureValid:validation.ok,factVerification:'not_performed'};
      return {...result,details:{...result.details,stateValidation},content:[...(result.content || []),
        {type:'text',text:'状态已保存；结构校验：'+JSON.stringify(stateValidation)}]};
    },
  };
}
