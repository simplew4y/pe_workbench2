/**
 * Deterministic supersession of failed calc items. A failed item is replaced
 * only by a later successful result with the same output semantics:
 * requested unit/currency, bound sources and the same (or numerically
 * equivalent) formula. This is independent of whether the whole answer passed
 * semantic review, and never clears failures by tool name alone. Bound ratios
 * permit renamed labels/variables and an explicit decimal/percent conversion.
 */
import { calculate, normalizeExpressionText, unitConvert } from './calc-tool.mjs';

const compact = text => normalizeExpressionText(text).expression.replace(/\s+/g, '');
const label = text => String(text ?? '').normalize('NFKC').replace(/\s+/g, '').toLowerCase();
const field = (item, key) => item?.[key] == null ? '' : String(item[key]).trim();
// Conversions and currencies change the value and must match. A missing
// outputUnit label may be added by the retry; a different label may not.
const sameUnits = (failed, args) => ['fromUnit', 'toUnit', 'currency', 'toCurrency', 'rate'].every(key => field(failed, key) === field(args, key)) &&
  (!field(failed, 'outputUnit') || field(failed, 'outputUnit') === field(args, 'outputUnit'));

function sameSources(a = {}, b = {}) {
  const keys = Object.keys(a).sort();
  if (keys.join(',') !== Object.keys(b).sort().join(',')) return false;
  return keys.every(key => a[key]?.materialId === b[key]?.materialId && a[key]?.locator === b[key]?.locator &&
    // An explicit old version must be proved by the observed receipt. Omitting
    // the retry version must never turn a different workbook into a replacement.
    (a[key]?.version == null || b[key]?.version != null && String(a[key].version) === String(b[key].version)));
}

function argItems(args = {}) {
  const { expressions, ...defaults } = args || {};
  return (Array.isArray(expressions) ? expressions : [args || {}]).map((item, index) => ({ ...defaults, ...item, index }));
}

/** Failed items of one calc call, with the original arguments of each item. */
export function failedCalcItems(call) {
  if (call?.name !== 'calc') return [];
  const details = call.result?.details || call.details || {};
  const items = argItems(call.args);
  if (Array.isArray(details.failures) && details.failures.length)
    return details.failures.map(failure => ({ ...items[failure.index], index: failure.index, error: failure.error }));
  return call.success && !call.result?.isError && !details.error ? [] : items.map(item => ({ ...item, error: details.error || 'calc 执行失败' }));
}

function successfulCalcResults(call) {
  if (call?.name !== 'calc' || !call.success || call.result?.isError || call.details?.error) return [];
  const details = call.result?.details || call.details || {};
  if (details.error) return [];
  const items = argItems(call.args);
  return (details.results || []).flatMap((result, position) => result.isError || result.error ? [] :
    [{ args: items[Number.isInteger(result.index) ? result.index : position] || {}, result }]);
}

function equivalentValue(failed, result) {
  try {
    const values = Object.fromEntries(Object.entries(result.bindings || {}).map(([key, source]) => [key, source?.value]));
    const expression = compact(failed.expression).replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g, key =>
      Object.hasOwn(values, key) ? `(${values[key]})` : key);
    return calculate({ expression, precision: 10 }).value ===
      calculate({ expression: result.evaluatedExpression || result.expression, precision: 10 }).value;
  } catch { return false; }
}

// A retry may rename variables and its display label, or express the same
// dimensionless ratio as a percentage. Compare the formula over source IDs,
// not coincidentally equal numbers or user-facing names.
function boundRatioReplacement(failed, args, result) {
  if (!Object.keys(failed.bindings || {}).length || !sameSources(args.bindings,result.bindings)) return false;
  if (['currency','toCurrency','rate'].some(k=>field(failed,k)!==field(args,k))) return false;
  const observed=Object.values(result.bindings || {});
  const ids=observed.map(s=>JSON.stringify([s.materialId,s.version,s.locator])).sort();
  if (new Set(ids).size!==ids.length) return false;
  const signature=item=>{
    const mapping={};
    for(const [key,source] of Object.entries(item.bindings || {})) {
      const matches=observed.filter(s=>s.materialId===source.materialId && s.locator===source.locator &&
        (source.version==null || s.version!=null && String(s.version)===String(source.version)));
      if(matches.length!==1)return null;
      mapping[key]='source'+ids.indexOf(JSON.stringify([matches[0].materialId,matches[0].version,matches[0].locator]));
    }
    if(new Set(Object.values(mapping)).size!==ids.length)return null;
    let expression=compact(item.expression).replace(/\b[A-Za-z_][A-Za-z0-9_]*\b/g,key=>mapping[key] || key);
    const unit=item.toUnit || item.outputUnit || (item.ratioEncoding==='fraction'?'decimal':'');
    if(!['%','decimal'].includes(unit))return null;
    if(item.fromUnit || item.toUnit) {
      if(item.fromUnit!=='decimal' || !['%','decimal'].includes(item.toUnit))return null;
    } else if(unit==='%') {
      // Only an explicit scale conversion is accepted. Merely relabeling
      // x/y as % does not recover a failed fractional result.
      if(!expression.endsWith('*100'))return null;
      expression=expression.slice(0,-4);
    }
    // Ignore redundant outer parentheses, not operator order or denominators.
    while(expression.startsWith('(') && expression.endsWith(')')) {
      let depth=0,whole=true;
      for(let i=0;i<expression.length-1;i++){if(expression[i]==='(')depth++;if(expression[i]===')')depth--;if(!depth){whole=false;break;}}
      if(!whole)break;expression=expression.slice(1,-1);
    }
    return expression;
  };
  const expectedUnit=args.toUnit || args.outputUnit;
  if(result.unit!==expectedUnit || !['%','decimal'].includes(result.unit))return false;
  const a=signature(failed),b=signature(args);
  return a!==null && a===b;
}

/** How a later success ({args,result}) replaces this failed item, or null. */
export function calcReplacement(failed, { args = {}, result } = {}) {
  if (!failed?.expression || !result) return null;
  if(boundRatioReplacement(failed,args,result))return 'same_bound_ratio';
  // Do not accept a change of scale solely because the raw formula matches.
  if (failed.ratioEncoding && args.ratioEncoding && failed.ratioEncoding!==args.ratioEncoding) return null;
  const failedName = label(failed.name), resultName = label(args.name ?? result.name);
  if (failedName && resultName && failedName !== resultName) return null;
  if (!sameUnits(failed, args)) return null;
  if (!sameSources(failed.bindings, result.bindings) || !sameSources(args.bindings, result.bindings)) return null;
  if (field(failed, 'outputUnit') && field(failed, 'outputUnit') !== field(result, 'unit')) return null;
  if (compact(failed.expression) === compact(args.expression ?? result.expression)) return 'same_formula';
  return failedName && resultName && equivalentValue(failed, result) ? 'equivalent_formula' : null;
}

/** Per failed calc call: which items are replaced (and by which call) and which remain. */
export function calcFailureRecovery(calls = []) {
  const ordered = [...new Map(calls.filter(Boolean).map(call => [call.id, call])).values()];
  return ordered.flatMap((call, position) => {
    const failed = failedCalcItems(call);
    if (!failed.length) return [];
    const later = ordered.slice(position + 1).flatMap(next => successfulCalcResults(next).map(entry => ({ ...entry, id: next.id })));
    const replaced = [], unresolved = [];
    for (const item of failed) {
      const match = later.map(entry => ({ id: entry.id, kind: calcReplacement(item, entry) })).find(entry => entry.kind);
      if (match) replaced.push({ index: item.index, name: item.name || null, by: match.id, kind: match.kind });
      else unresolved.push({ index: item.index, name: item.name || null, expression: item.expression ?? null, outputUnit: item.outputUnit || null, error: item.error });
    }
    return [{ id: call.id, replaced, unresolved }];
  });
}

export function recoveredUnitConversions(calls=[]) {
  const recovered=new Set();
  for(const [i,call] of calls.entries()) {
    if(call.name!=='unit_convert' || call.success)continue;
    let expected;try{expected=unitConvert(call.args);}catch{continue;}
    const original=call.args.citations || [];
    if(!original.length)continue;
    for(const later of calls.slice(i+1)) {
      if(later.name!=='unit_convert' || !later.success || later.result?.isError)continue;
      const sources=later.args?.citations || [];
      if(original.length!==sources.length || !original.every(a=>sources.some(b=>a.materialId===b.materialId &&
        a.locator===b.locator && a.version!=null && String(a.version)===String(b.version))))continue;
      const result=later.result?.details || later.details;
      try {
        const retry=unitConvert({...later.args,currency:later.args.currency || call.args.currency});
        if(retry.fromUnit===expected.fromUnit && retry.toUnit===expected.toUnit && retry.inputValue===expected.inputValue &&
          retry.currency===expected.currency && retry.value===expected.value && result.value===retry.value && result.unit===retry.unit)
          recovered.add(call.id);
      }catch{ /* failed conversions never replace successful evidence */ }
    }
  }
  return recovered;
}
