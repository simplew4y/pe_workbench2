// Earlier workbook and PDF readers returned source records on each cell/page.
// Accept observations only from the corresponding successful read, never from
// a draft's encoded link, a search hit or an unrelated document's catalogue.
export function archivedReadEvidence(call) {
  if(!['pe_excel_range','pe_pdf_read'].includes(call.name) || call.success!==true || call.result?.isError)return [];
  const d=call.result?.details || call.details, doc=d?.document;
  if(!doc?.doc_id || !doc.filename || !Number.isInteger(doc.version_no) || doc.version_no<1 ||
      (d.doc_id && d.doc_id!==doc.doc_id) || (d.version_no && d.version_no!==doc.version_no))return [];
  const common={materialId:doc.doc_id,version:doc.version_no,filename:doc.filename,storedFilename:doc.filename,toolCallId:call.id};
  if(call.name==='pe_pdf_read')return (d.pages || []).flatMap(p=>{
    if(!Number.isInteger(p.page_number) || p.page_number<d.page_start || p.page_number>d.page_end ||
        !/^page:[\w-]+$/.test(p.evidence_id) || p.text_quality!=='passed' || !p.content)return [];
    return [{...common,id:p.evidence_id,locator:'p.'+p.page_number,role:'page',excerpt:p.content.slice(0,10000)}];
  });
  return (d.cells || []).flatMap(c=>{
    if(!c.sheet_name || !/^[A-Z]{1,3}[1-9]\d*$/.test(c.cell_ref) || !/^source:[\w-]+=*$/.test(c.evidence_id))return [];
    let key;
    try{key=JSON.parse(Buffer.from(c.evidence_id.slice(7),'base64url').toString('utf8'));}catch{return [];}
    if(!Array.isArray(key) || key.length!==4 || key[0]!==doc.doc_id || key[1]!=='excel' || key[2]!==c.sheet_name || key[3]!==c.cell_ref)return [];
    if(c.is_formula && c.formula_cache_status!=='present')return [];
    const value=Number.isFinite(c.numeric_value)?c.numeric_value:(c.is_formula?c.cached_value:c.raw_value);
    if(value==null || typeof value==='object' || /^#(?:REF!|NAME\?|N\/A|VALUE!|DIV\/0!|NUM!)/.test(String(value)))return [];
    const label=(d.cells || []).find(x=>x.sheet_name===c.sheet_name && x.row_index===c.row_index &&
      (x.col_index===1 || x.col_index===c.col_index-1) && !x.is_formula && ['str','string','text'].includes(x.value_type) && typeof x.raw_value==='string');
    return [{...common,id:c.evidence_id,locator:c.sheet_name+'!'+c.cell_ref,value,
      role:c.is_formula?'formula':'input',...(c.formula?{formula:c.formula}:{}),...(label?{metric:label.raw_value}:{}),
      ...(c.comment?.text?{excerpt:c.comment.text.slice(0,10000)}:{})}];
  });
}
