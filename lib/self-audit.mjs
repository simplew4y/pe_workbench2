/**
 * Deterministic self-audit for money claims. Shared by tests and the speech gate.
 * It uses the same exact-decimal engine as unit_convert; the model-facing protocol
 * still tells the model to call unit_convert/calc explicitly.
 */
import {convertExact, formatDecimal, relativeErrorExceeds} from './calc-tool.mjs';
import {correctedValues} from './ledger.mjs';
const rows=v=>Array.isArray(v)?v:[];

const numeric=v=>{const s=String(v??'').replaceAll(',','').trim();return /^[+-]?\d+(?:\.\d+)?$/.test(s)?s:null;};
const TENFOLD=/^(?:十倍|10倍|十倍错|十倍错误|order[-_ ]?of[-_ ]?magnitude|oom)$/i;
const display=(value,unit)=>value==null?'—':`${value}${unit?` ${unit}`:''}`;
const ratioOf=(a,b)=>{const na=numeric(a),nb=numeric(b);if(na==null||nb==null) return null;const x=Number(na),y=Number(nb);return Number.isFinite(x)&&Number.isFinite(y)&&x!==0?Number((Math.abs(y/x)).toFixed(4)):null;};
function expectedForClaim(c,cell) {
  if(numeric(c.correctValue)!=null) {
    try {return c.unit?formatDecimal(convertExact(c.correctValue,c.correctUnit||c.unit,c.unit)):String(c.correctValue);} catch { /* period/unknown unit */ }
  }
  if(cell&&numeric(cell.value)!=null&&cell.unit&&c.unit) {
    try {return formatDecimal(convertExact(cell.value,cell.unit,c.unit));} catch { /* incompatible units */ }
  }
  return null;
}
export function formatSelfAuditTable(candidates=[]) {
  if(!Array.isArray(candidates)||!candidates.length) return '未发现候选人。';
  const lines=['| 角色 | 类型 | 主张 | 应为 | 依据 | 状态 |','|---|---|---|---|---|---|'];
  for(const c of candidates) lines.push(`| ${c.role||'user'} | ${c.type||'user_claim'} | ${c.claimed||'—'} | ${c.expected||'—'} | ${c.basis||'—'} | ${c.status} |`);
  return lines.join('\n');
}
export function auditLedgerClaims(ledger,{query='',cell=null,limit=50}={}) {
  const rawTerms=String(query||'').trim().split(/\s+/).filter(Boolean).slice(0,20);
  const tenfold=rawTerms.some(t=>TENFOLD.test(t));
  const terms=rawTerms.filter(t=>!TENFOLD.test(t)).map(t=>t.toLowerCase());
  const candidates=[];
  const cs=rows(ledger?.corrections).filter(Boolean);
  const corrected=correctedValues(ledger);
  for(const c of rows(ledger?.claims).filter(Boolean)) {
    if(c.type==='doubt') continue;
    const value=numeric(c.value);
    if(value==null) continue;
    const expected=expectedForClaim(c,cell);
    const basis=expected==null?'—':(numeric(c.correctValue)!=null?'claim.correctValue':(cell?'cell':'unit_convert'));
    const status=expected==null?'unverified':(relativeErrorExceeds(value,expected,'0.005')?'mismatch':'match');
    const ratio=ratioOf(c.value,expected);
    const hay=[c.claim,c.value,c.unit,c.correctValue,c.correctUnit,c.period].join(' ').toLowerCase();
    if(!terms.every(t=>hay.includes(t))) continue;
    if(tenfold&&!(/十倍|10倍/.test(hay)||(ratio!=null&&ratio>=5&&ratio<=20))) continue;
    candidates.push({
      id:c.id,role:c.role||'user',type:c.type||'user_claim',turn:c.turn??null,
      claim:c.claim,claimed:display(c.value,c.unit),expected:expected==null?null:display(expected,c.unit),
      value,expectedValue:expected,unit:c.unit||'',ratio,basis,method:'unit_convert',
      superseded:c.status==='superseded',status,
    });
  }
  for(const [i,c] of cs.entries()) {
    const from=numeric(c.from),to=numeric(c.to);
    if(from==null||to==null) continue;
    const final=corrected[i]?.to??c.to;
    const status=relativeErrorExceeds(from,final,'0.005')?'mismatch':'match';
    const ratio=ratioOf(from,final);
    const hay=[c.claim,c.from,c.to,c.unit,c.reason].join(' ').toLowerCase();
    if(!terms.every(t=>hay.includes(t))) continue;
    if(tenfold&&!(/十倍|10倍/.test(hay)||(ratio!=null&&ratio>=5&&ratio<=20))) continue;
    candidates.push({
      id:c.id,role:c.evidence?.type==='user'?'user':'assistant',type:'correction',turn:c.turn??null,
      claim:c.claim,claimed:display(c.from,c.unit),expected:display(final,c.unit),
      value:from,expectedValue:final,unit:c.unit||'',ratio,basis:'correction',method:'unit_convert',
      superseded:String(final)!==String(c.to),status,
    });
  }
  candidates.sort((a,b)=>(Number(a.turn)||0)-(Number(b.turn)||0)||String(a.id).localeCompare(String(b.id)));
  const limited=candidates.slice(0,Math.max(1,Math.min(50,Number(limit)||50)));
  return {candidates:limited,totalMatches:candidates.length,table:formatSelfAuditTable(limited)};
}
