import {createHash} from 'node:crypto';
import {Lexer} from 'marked';
const hash=s=>createHash('sha256').update(s).digest('hex');
const sourceTools=new Set(['workbook_query','workbook_trace','model_whatif','calc','unit_convert','ratio','web_fetch','deepseek_fetch','deepseek_search','anysearch_search','westock_query','pdf_read']);

export function numericAuditPassages(answer) {
 const passages=Lexer.lex(answer).flatMap(token=>token.type==='table'
  ? token.raw.trimEnd().split(/\r?\n/).slice(2)
  : token.type==='space'?[]:[token.raw.trim()]);
 return [...new Set(passages.filter(p=>/\d/.test(p) && answer.includes(p)))].slice(0,80);
}

export function bindVerifiedPassages(answer,passages=[]) {
 return passages.filter(p=>typeof p.text==='string' && p.text.trim() && answer.includes(p.text) && Array.isArray(p.evidenceIds) && p.evidenceIds.length)
  .map(p=>({text:p.text,sha256:hash(p.text),evidenceIds:[...new Set(p.evidenceIds)]}));
}

// A partial audit may verify particular passages even when another passage or
// an artifact failed. Its exact-draft receipt resolves parser gaps, never an
// explicit source contradiction, wrong unit, currency, identity or value.
export function applyPassageVerification(findings,answer,receipt,calls=[]) {
 if(!['reviewed','limited'].includes(receipt?.status) || receipt.draftHash!==hash(answer))return findings;
 const ids=new Set(calls.filter(c=>sourceTools.has(c.name) && c.success===true && !c.result?.isError).map(c=>c.id));
 const passages=(receipt.verifiedPassages || []).filter(p=>p.sha256===hash(p.text || '') && answer.includes(p.text) &&
  p.evidenceIds?.length && p.evidenceIds.every(id=>ids.has(id)));
 return findings.map(f=>{
  if(!['unsourced_number','evidence_identity_mismatch'].includes(f.rule) || !['missing_source','metadata_missing','parser_unresolved'].includes(f.evidenceStatus))return f;
  const text=f.sourceText || f.excerpt;
  const passage=passages.find(p=>text && p.text.includes(text));
  return passage?{...f,severity:'info',evidenceStatus:'semantic_supported',evidenceIds:passage.evidenceIds,message:'本段已对照实际工具来源复核，保留原文的数值与口径'}:f;
 });
}
