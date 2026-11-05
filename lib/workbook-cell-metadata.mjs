export function periodLabelFromHeader(value) {
 const label=String(value||'').trim();
 return /^(?:FY)?(?:(?:19|20|21)[0-9]{2}|[1-4]Q[0-9]{2,4}|Q[1-4][0-9]{2,4}|[0-9]{4}Q[1-4]|[12]H[0-9]{2,4}|H[12][0-9]{2,4}|[0-9]{4}H[12])(?:[EA])?$/i.test(label.replace(/\s/g,''))?label:null;
}
export function formatCellLabels(cell) {
 return [cell.rowLabel?`行标签=${cell.rowLabel}`:'行标签未提供',cell.columnLabel?`列标签=${cell.columnLabel}${periodLabelFromHeader(cell.columnLabel)?'':' · 期间状态=未识别，需核对'}`:'列标签未提供（该格期间未确认）'].join(' · ');
}
/** Mechanical provenance; does not infer financial meaning from nearby text. */
export function cellMetadata(cell, graph) {
 const formula=Boolean(cell.formula);
 const sheet=(graph.doc.sheets||[]).find(s=>s.name===cell.sheet);
 const nearbyRowLabels=Object.entries(sheet?.rowLabels||{}).filter(([row])=>Number(row)>=cell.row-5&&Number(row)<=cell.row+2).map(([row,label])=>({row:Number(row),label}));
 return {role:formula?'formula':'constant',independentInput:!formula && typeof cell.value==='number' && (graph.downstream.get(cell.id)||[]).length>0,
  nearbyRowLabels,
  isOutputCandidate:(graph.doc.outputs||[]).includes(cell.id),labelProvenance:'parser_inferred',unit:null,headerLabel:cell.colLabel||null,periodLabel:periodLabelFromHeader(cell.colLabel),
  warning:'标签由解析器推断；单位、期间及业务含义须查原表。图只含已解析引用。'};
}

/** Row labels have no proven column coordinate or block ownership. */
export function rowMetadata(doc, {sheet, rowStart=1, rowEnd=Infinity, query}={}) {
 const q=String(query||'').trim().toLowerCase();
 const sheets=doc.sheets||[];
 const exact=sheets.find(s=>s.name.toLowerCase()===q);
 const hits=[];
 if(!exact)for(const s of sheets){
  const name=s.name.toLowerCase();if(!name)continue;
  for(let at=q.indexOf(name);at>=0;at=q.indexOf(name,at+name.length)){
   if(!/[\p{L}\p{N}_]/u.test(q[at-1]||' ') && !/[\p{L}\p{N}_]/u.test(q[at+name.length]||' '))hits.push({sheet:s,start:at,end:at+name.length});
  }
 }
 const chosen=[];
 for(const hit of hits.sort((a,b)=>(b.end-b.start)-(a.end-a.start)))if(!chosen.some(c=>hit.start<c.end&&hit.end>c.start))chosen.push(hit);
 const named=exact?[exact]:[...new Set(chosen.map(h=>h.sheet))];
 const selected=sheet?(doc.sheets||[]).filter(s=>s.name===sheet):named;
 const all=[];
 for(const s of selected)for(const [row,text] of Object.entries(s.rowLabels||{})){
  if(Number(row)>=rowStart && Number(row)<=rowEnd)all.push({sheet:s.name,row:Number(row),text:String(text),provenance:'parser_row_label',column:null});
 }
 all.sort((a,b)=>a.sheet.localeCompare(b.sheet)||a.row-b.row);
 const metadata=[];let chars=0;
 for(const m of all){if(metadata.length>=40||chars>=2400)break;const text=m.text.slice(0,300);metadata.push({...m,text});chars+=text.length+60;}
 return {metadata,metadataTruncated:metadata.length<all.length||metadata.some((m,i)=>m.text!==all[i].text)};
}

export function metadataLines(result) {
 const lines=(result.metadata||[]).map(m=>`行标签 ${m.sheet} 行${m.row}：${m.text}（解析记录；列位置未知，不是该区域内某个单元格的精确定位）`);
 if(result.metadataTruncated)lines.push('行标签已截断；不能据此判断未返回行没有信息。');
 return lines;
}

export function boundText(lines, maxChars) {
 const text=lines.join('\n'),suffix='\n…（输出已截断，请缩小范围；未返回不代表不存在）';
 return text.length<=maxChars?text:text.slice(0,Math.max(0,maxChars-suffix.length))+suffix;
}
