import {createHash} from 'node:crypto';
const normalize=x=>String(x || '').replace(/[*`]/g,'').replace(/\s+/g,' ').trim();
const workflow=new Set(['write','edit','review_research','validate_state']);
// Wording changes and another failed report write are not new research.
// A changed claim, source receipt, or deterministic result permits a retry.
// This key never grants approval; a repeated failure remains unresolved.
export function repairFingerprint(findings,calls) {
 const issues=findings.map(f=>f.claim ? {rule:f.rule,field:f.field,claim:f.claim,expected:f.expected} :
  {rule:f.rule || f.check,excerpt:normalize(f.excerpt),reason:normalize(f.expected || f.reason || f.message)});
 const evidence=calls.filter(c=>!workflow.has(c.name || c.toolName)).map(c=>({id:c.id || c.toolCallId,
  name:c.name || c.toolName,args:c.args || c.arguments,isError:c.isError ?? c.result?.isError ?? c.success===false,
  result:c.result || c.text || c.details}));
 return createHash('sha256').update(JSON.stringify({issues:issues.map(i=>JSON.stringify(i)).sort(),evidence})).digest('hex');
}
