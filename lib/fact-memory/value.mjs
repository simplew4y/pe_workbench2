/** Exact decimal normalization; missing values never become zero. */
import { calculate, convertExact, formatDecimal, unitInfo } from '../calc-tool.mjs';
export const norm = value => String(value ?? '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, '');
export const periodKey = value => norm(value).replace(/^fy(?=20\d{2})/, '').replace(/(?<=20\d{2})a$/, '');
export function normalizeValue(raw, rawUnit = '', currency = '') {
  if (raw == null || typeof raw === 'boolean') return { canonical_value: null, reason: 'missing_or_non_numeric' };
  let value = String(raw).trim().replaceAll(',', '').replaceAll('−', '-');
  if (!value || /^[-—–]+$/.test(value)) return { canonical_value: null, reason: 'missing_value' };
  if (/^\([\d.]+\)$/.test(value)) value = `-${value.slice(1,-1)}`;
  let unit = rawUnit.trim();
  if (/%$/.test(value)) { value = value.slice(0,-1); if (unit && !['%', '％'].includes(unit)) return { canonical_value:null, reason:'unit_conflict' }; unit = '%'; }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return { canonical_value:null, reason:'non_numeric' };
  try {
    value = calculate({expression:value}).value;
    if (['倍','x','decimal','个百分点','pp'].includes(unit)) return { canonical_value:value, canonical_unit:['倍','x'].includes(unit)?'multiple':['pp','个百分点'].includes(unit)?'percentage_point':'decimal', multiplier:'1', currency:'' };
    const info = unitInfo(unit.replace('％','%'));
    const declared=String(currency || '').replace(/^RMB$/i,'CNY').toUpperCase();
    const inferred=String(info.currency || '').replace(/^RMB$/i,'CNY').toUpperCase();
    if(declared && inferred && declared!==inferred) return {canonical_value:null,reason:'currency_conflict'};
    const canonical_unit = info.kind === 'ratio' ? 'decimal' : '元';
    return { canonical_value:formatDecimal(convertExact(value, unit.replace('％','%'),canonical_unit)), canonical_unit,
      multiplier:formatDecimal(info.factor), currency:String(currency || info.currency || '').replace(/^RMB$/i,'CNY').toUpperCase() };
  } catch { return { canonical_value:value, canonical_unit:unit || 'unknown', multiplier:null, currency:currency || '', reason:'unknown_unit' }; }
}
export function sameIdentity(a,b) {
  return ['entity','metric','period','scope','basis_type','scenario','currency','canonical_unit'].every(k => (k==='period'?periodKey(a[k])===periodKey(b[k]):norm(a[k])===norm(b[k])));
}
