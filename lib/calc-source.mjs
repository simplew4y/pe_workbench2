/** Resolve calculation bindings from the current project, never from copied model values. */
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
