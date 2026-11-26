import { collectCitationsFromToolCalls } from "./citations.mjs";
import { workbookScenarioDelivery } from "./workbook-scenario-delivery.mjs";

const priceMetric=/(?:target price|\bTP\b|每股价值|目标股价|目标价)/i;

export function reportLimitEvidence(history) {
  const current=history.slice(history.findLastIndex(message=>message.role==="user")+1);
  const results=new Map(current.filter(message=>message.role==="toolResult").map(message=>[message.toolCallId,message]));
  const calls=current.flatMap(message=>message.role==="assistant" && Array.isArray(message.content) ?
    message.content.filter(block=>block.type==="toolCall") : [])
    .flatMap(block=>{
      const result=results.get(block.id);
      if(!result || result.isError || result.details?.error)return [];
      return [{id:block.id,name:block.name,args:block.arguments,result,details:result.details,success:true}];
    });
  const changed=new Set(calls.filter(call=>["write","edit","update_model"].includes(call.name))
    .flatMap(call=>[call.args?.path,call.args?.file].filter(Boolean)));
  const reads=calls.filter(call=>["workbook_trace","workbook_query"].includes(call.name) &&
    !changed.has(call.details?.path));
  const citations=collectCitationsFromToolCalls(reads);
  const targets=new Map();
  for(const call of reads) {
    const trace=call.details;
    if(!trace?.path || !/^[a-f0-9]{64}$/i.test(trace.sha256 || ""))continue;
    for(const cell of [trace.target,...(trace.cells || [])]){
      if(!cell || !Number.isFinite(cell.value) || cell.cacheStatus!=="cached" || !cell.formula ||
        !priceMetric.test([cell.label,cell.rowLabel,cell.metric].filter(Boolean).join(" ")))continue;
      const citation=citations.find(item=>item.sha256===trace.sha256 && item.materialId===trace.materialId &&
        item.version===trace.version && item.locator===cell.ref && item.value===cell.value);
      if(citation)targets.set(citation.id,{cell,citation});
    }
  }
  const versions=new Map();
  for(const citation of citations){
    if(!versions.has(citation.materialId))versions.set(citation.materialId,new Set());
    versions.get(citation.materialId).add(citation.version);
  }
  const singleVersion=citations.filter(citation=>versions.get(citation.materialId)?.size===1);
  const scenarios=workbookScenarioDelivery(calls,singleVersion,{}, {overview:true});
  const safeTargets=[...targets.values()].filter(({citation})=>versions.get(citation.materialId)?.size===1);
  if(!safeTargets.length && !scenarios.text)return null;
  const targetText=safeTargets.slice(0,6).map(({cell,citation})=>
    `- 工作簿目标价：${cell.value}${citation.display_unit && citation.display_unit!=="unit_unknown" ? " "+citation.display_unit : ""}（[${citation.filename}]${cell.ref}，原工作簿缓存值）。`);
  return {text:["**已核验的模型证据（部分交付）**",targetText.join("\n"),scenarios.text,
    "报告未通过发布校验，本轮不再重试。这里只列源工作簿读数和成功重算，不代表完整投研结论已经核验。"].filter(Boolean).join("\n\n"),
    citations:[...new Map([...safeTargets.slice(0,6).map(item=>item.citation),...scenarios.citations].map(citation=>[citation.id,citation])).values()]};
}
