// A falsification threshold is a proposed decision rule, not an observed fact.
// This exemption only addresses automatic numeric binding; the research audit
// still checks the rule's provenance, scope and logical falsification strength.
export function isResearchCondition(statement, question='') {
  if (!/可证伪|证伪条件|推翻条件|失效条件|观察(?:指标|信号)|跟踪(?:指标|命题)|检验|验证.*(?:方法|假设)|命题|尽调|如何改变判断/.test(question)) return false;
  const s=String(statement).replace(/[*`]/g,'').trim().replace(/^\d+[.)、]\s*/,'');
  if (!/^(?:(?:证伪|推翻|失效|触发)(?:条件|信号|阈值)?\s*[：:]|(?:若|如果|假如|假使))/.test(s)) return false;
  return !/已(?:经)?(?:实现|发生|披露|达到|确认|核实)|实际(?:为|达到|发生)|(?:年报|公告|原文|数据显示)(?:显示|披露|记载|为)|据(?:年报|公告|原文)/.test(s);
}
