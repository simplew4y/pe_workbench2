/** Adapters consume only successful structured tool output, never model prose. */
import { extractPdfFacts } from './pdf-semantic.mjs';
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
        raw_value:c.value,raw_unit:c.raw_unit || c.display_unit || '',identity,extractor:'workbook-citation-v2',formula:c.formula || null,cache_status:c.formula?'cached_not_recalculated':'not_formula',semantic_review: /[%％]/.test(c.raw_unit || c.display_unit || '') && !/[%％]/.test(String(c.value)) && c.value_encoding!=='percent_points',semantic_review_reason:'excel_percentage_encoding_unknown'});
      if (normalizeValue(c.value,c.raw_unit || c.display_unit || '',c.currency || '').canonical_value != null) facts.push({...identity,raw_value:c.value,raw_unit:c.raw_unit || c.display_unit || '',evidence_key:evidenceKey,origin_type:'disclosed',citation:c});
    }
    return {evidence,facts,coverage: d.coverage || 'returned_cells_only'};
  }
  if (call.name==='pdf_read') {
    const coverage=[];
    for (const e of rows(d.evidence)) if (e.page && e.materialId) {
      const base={key:`${e.materialId}:${e.version}:p.${e.page}:${e.index || 0}`,asset_id:e.materialId,source_version:String(e.version || ''),sha256:e.sha256 || d.sha256 || '',locator:`p.${e.page}`,excerpt:e.text || '',extractor:'pdf-text-v1',scanned:Boolean(e.scanned),truncated:Boolean(d.truncated),raw_value:null,raw_unit:'',identity:{}};
      evidence.push(base);
      const extracted=extractPdfFacts({...e,truncated:d.truncated});coverage.push({page:e.page,...extracted,candidates:extracted.candidates.length});
      for(const candidate of extracted.candidates) {
        const key=`${base.key}:${candidate.locator}`;
        evidence.push({...base,...candidate,key});
        facts.push({...candidate.identity,raw_value:candidate.raw_value,raw_unit:candidate.raw_unit,evidence_key:key,origin_type:'disclosed',reason:candidate.review_reason || undefined});
      }
    }
    return {evidence,facts,coverage:{mode:'conservative_pdf_semantics',pages:coverage}};
  }
  for (const r of (call.name==='calc'?rows(d.results):[d])) if (r.value!=null) facts.push({entity:'',metric:r.name || call.name,period:r.period || '',scope:'',basis_type:'unknown',scenario:'',raw_value:r.value,raw_unit:r.unit || '',currency:r.currency || '',origin_type:'calculated',expression:r.expression || '',reason:'unbound_calculation_inputs'});
  return {evidence,facts,coverage:'calculation_candidates_only'};
}
