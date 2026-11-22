// The public citation label can be a product name. Recover the actual metric
// and product from the structured tool result that produced that citation.
// Never infer these fields from arbitrary nearby excerpt words.
export function enrichFinancialSources(citations,calls=[]) {
  const cells=new Map();
  for(const call of calls) {
    if(call.success!==true || call.result?.isError || !['workbook_query','workbook_trace'].includes(call.name))continue;
    const d=call.result?.details || call.details || {};
    if(!d.materialId || !d.version)continue;
    const add=cell=>{
      if(!cell)return;
      const ref=cell.ref || cell.locator;
      if(ref && cell.metricContext?.product)cells.set(`${d.materialId}:${d.version}:${ref}`,cell);
      for(const child of cell.children || [])add(child);
    };
    for(const cell of [...(d.cells || []),...(d.researchEvidence || []),...(d.direct || []),...(d.outputs || []),...(d.paths || []).flat()])add(cell);
    add(d.target);add(d.tree);
  }
  return citations.map(c=>{
    if(c.derivedFrom?.length || c.role?.startsWith('derived'))return c;
    const cell=cells.get(`${c.materialId}:${c.version}:${c.locator}`);
    if(!cell)return c;
    const label=String(cell.metricContext.label || '').trim();
    // A row heading is not a business segment merely because the workbook
    // parser repeats it in product. Preserve its observed metric and units.
    if (label && (label === String(cell.metricContext.product).trim() ||
        /^(?:total\s+(?:revenues?|sales)|(?:net|gross|operating)\s+(?:profits?|income)(?:[,\s]+(?:non[- ]?)?(?:GAAP|IFRS))?|%?\s*(?:yoy|qoq)(?:\s+change)?|(?:非GAAP)?净利润?|总收入|营业总收入|合计)$/i.test(String(cell.metricContext.product).trim())))
      return {...c,metric:c.metric || cell.rowLabel || label};
    let metric=/^(?:revenues?|sales)$/i.test(label)?'收入':/^(?:gm|gross margin)$/i.test(label)?'毛利率':/^gross profits?$/i.test(label)?'毛利':'';
    if(/^mix$/i.test(label)) {
      const denominator=cell.ratioEvidence?.denominator?.label || '';
      metric=/^revenues?$/i.test(denominator)?'收入占比':/^gross profits?$/i.test(denominator)?'毛利占比':'';
    }
    return {...c,metric,segment:String(cell.metricContext.product),semanticMetricUnresolved:!metric};
  });
}
