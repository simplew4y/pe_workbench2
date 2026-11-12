/** Adapters consume only successful structured tool output, never model prose. */
import { normalizeValue } from './value.mjs';
export const CAPTURE_TOOLS = new Set(['workbook_query','workbook_trace','pdf_read','calc','ratio','unit_convert']);
const rows = value => Array.isArray(value) ? value : [];
export function adaptToolResult(call) {
  if (!call?.success || call.result?.isError || !CAPTURE_TOOLS.has(call.name)) return { evidence:[], facts:[], coverage:'not_applicable' };
  const d=call.details || call.result?.details || {};
  const evidence=[], facts=[];
  if (call.name.startsWith('workbook_')) {
    for (const c of rows(d.citations)) {
      if (!c.materialId || !c.locator) continue;
      const evidenceKey=`${c.materialId}:${c.version}:${c.locator}`;
      const identity={entity:c.company || '',metric:c.metric || '',period:c.period || '',scope:c.scope || '',basis_type:c.basis_type || 'unknown',scenario:c.scenario || '',currency:c.currency || ''};
      evidence.push({key:evidenceKey,asset_id:c.materialId,source_version:String(c.version || ''),sha256:c.sha256 || d.sha256 || '',locator:c.locator,
        excerpt:c.excerpt || [c.company,c.metric,c.period,c.scope,c.basis_type,c.scenario,c.value,c.display_unit].filter(x=>x!=null).join(' | '),
        raw_value:c.value,raw_unit:c.raw_unit || c.display_unit || '',identity,extractor:'workbook-citation-v2',formula:c.formula || null,cache_status:c.formula?'cached_not_recalculated':'not_formula'});
      if (normalizeValue(c.value,c.raw_unit || c.display_unit || '',c.currency || '').canonical_value != null) facts.push({...identity,raw_value:c.value,raw_unit:c.raw_unit || c.display_unit || '',evidence_key:evidenceKey,origin_type:'disclosed',citation:c});
    }
    return {evidence,facts,coverage: d.coverage || 'returned_cells_only'};
  }
  if (call.name==='pdf_read') {
    for (const e of rows(d.evidence)) if (e.page && e.materialId) evidence.push({key:`${e.materialId}:${e.version}:p.${e.page}:${e.index || 0}`,asset_id:e.materialId,source_version:String(e.version || ''),sha256:e.sha256 || d.sha256 || '',locator:`p.${e.page}`,excerpt:e.text || '',extractor:'pdf-text-v1',scanned:Boolean(e.scanned),truncated:Boolean(d.truncated),raw_value:null,raw_unit:'',identity:{}});
    // PDF text is durable evidence, not automatically verified numeric facts.
    return {evidence,facts,coverage:evidence.length?'text_evidence_only':'no_extractable_evidence'};
  }
  for (const r of (call.name==='calc'?rows(d.results):[d])) if (r.value!=null) facts.push({entity:'',metric:r.name || call.name,period:r.period || '',scope:'',basis_type:'unknown',scenario:'',raw_value:r.value,raw_unit:r.unit || '',currency:r.currency || '',origin_type:'calculated',expression:r.expression || '',reason:'unbound_calculation_inputs'});
  return {evidence,facts,coverage:'calculation_candidates_only'};
}
