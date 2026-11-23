/** Resolve calculation bindings from the current project, never from copied model values. */
import {PDF_LOCATOR,PDF_PAGE} from './contracts/citation.mjs';
import {citationsFromCells} from './citations.mjs';
import {normalizeLocator} from './citation-locator.mjs';
export function createWorkbookBindingResolver({store,workbooks}) {
  return async input => {
    const locator=normalizeLocator(input.locator);
    if (!locator || locator.includes(':')) throw new Error('计算输入需要完整单格引用');
    const material=store.getMaterial(input.materialId);
    if (!material) throw new Error('当前项目中不存在该输入材料');
    const result=await workbooks.queryMaterial(material.id,locator,{maxCells:1,maxChars:1000});
    if (result.error || result.isError) throw new Error('读取计算输入失败');
    if (input.version != null && Number(input.version)!==result.version) throw new Error('输入材料版本已变化，请重新读取');
    const source=citationsFromCells(result.cells,{id:material.id,name:result.name || material.name,path:result.path,version:result.version,sha256:result.sha256})
      .find(c=>normalizeLocator(c.locator)===locator);
    if (!source || typeof source.value!=='number' || !Number.isFinite(source.value)) throw new Error('计算输入不是已读取的有限数值');
    return source;
  };
}

/** Resolve PDF inputs by their physical observation, including the column header.
 * Any extra claims copied by the caller must agree with the source. */
export function createPdfBindingResolver(pdfs) {
  return async input => {
    const point = PDF_LOCATOR.exec(input.locator);
    const match = point || PDF_PAGE.exec(input.locator);
    if (!match) throw new Error("PDF 计算输入需要完整页码或行列引用");
    if (!pdfs || !Number.isInteger(input.version)) throw new Error('PDF 计算需要已读取的材料版本');
    const sources = await pdfs.calculationSources(input.materialId, Number(match[1]), input.version);
    const hits = sources.filter(c => point ? c.locator === input.locator :
      c.metric === input.metric && c.period === input.period && c.excerpt === input.excerpt);
    if (hits.length !== 1) throw new Error('该页未能唯一定位输入数值');
    const source = hits[0];
    for (const key of ['id','sha256','metric','period','excerpt','currency','display_unit','raw_unit','value']) {
      if (input[key] != null && String(input[key]) !== String(source[key])) throw new Error('PDF 输入与原文不符：'+key);
    }
    return source;
  };
}
