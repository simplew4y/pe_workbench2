/**
 * Explicit user-correction detection for the session ledger.
 * Deliberately narrow: only sentences with a correction marker are recorded.
 * We do not auto-NER every number from long user text (DT-2.1).
 */
import {appendClaim, readLedger} from './ledger.mjs';

const NUM=String.raw`[+-]?\d[\d,]*(?:\.\d+)?`;
const UNIT=String.raw`(?:(?:RMB|HKD|USD)\s*(?:mn|million|mm|m)|百万元|十亿元|十亿|亿元|万元|千元|元|亿|mn)`;
const PERIOD=String.raw`(?:\d{4}\s*H[12]|[12]H\d{2}|\d{4}\s*Q[1-4]|\d{4}\s*年度?|(?:19|20)\d{2})`;
const WRITE_WITH_CORRECT=new RegExp(`(${NUM})\\s*(${UNIT})\\s*(?:被|有人|用户|前文|之前|模型|助手)?\\s*(?:误|错)?写成(?:了|为)?\\s*(${NUM})\\s*(${UNIT})`,'i');
const WRITE_ONLY=new RegExp(`(?:有人|用户|前文|之前|模型|助手)?\\s*(?:误|错)?写成(?:了|为)?\\s*(${NUM})\\s*(${UNIT})`,'i');
const SHOULD_BE=new RegExp(`(?:应为|应该是|正确(?:值|数)?(?:应)?为|实际(?:应)?为|应更正为|更正为|改为|修正为)\\s*(${NUM})\\s*(${UNIT})`,'i');
const SHOULD_BE_PERIOD=new RegExp(`(?:应为|更正为|改为|修正为|实际为)\\s*(${PERIOD})`,'i');

const clean=s=>String(s??'').replace(/[<>]/g,' ').trim().slice(0,2000);
const num=v=>String(v??'').replaceAll(',','').trim();
export function detectUserClaims(text,{turn=1}={}) {
  const source=clean(text);
  if(!source||source.length>4000) return [];
  const sentences=source.match(/[^。！？；\n]+[。！？；]?/g)||[];
  const found=[];
  for(const raw of sentences) {
    const sentence=raw.trim();
    if(!sentence) continue;
    let value=null,unit='',correctValue=null,correctUnit='',period='',pattern='';
    const both=WRITE_WITH_CORRECT.exec(sentence);
    if(both) {
      correctValue=num(both[1]);correctUnit=both[2];value=num(both[3]);unit=both[4];pattern='write';
    } else {
      const wrong=WRITE_ONLY.exec(sentence);
      if(wrong) {value=num(wrong[1]);unit=wrong[2];pattern='write';}
    }
    const should=SHOULD_BE.exec(sentence);
    if(should&&correctValue==null) {correctValue=num(should[1]);correctUnit=should[2];pattern=pattern||'should_be';}
    if(period==='') {
      const p=SHOULD_BE_PERIOD.exec(sentence);
      if(p) {period=p[1].replace(/\s+/g,'');}
    }
    if(value==null&&correctValue==null&&period==='') continue;
    // "应为 1H27" is a period assertion, not an erroneous numeric claim.
    if(value==null&&correctValue==null&&period) {
      found.push({claim:sentence,value:period,unit:'period',correctValue:period,correctUnit:'period',period,type:'user_claim',role:'user',pattern:'period',turn});
      continue;
    }
    found.push({
      claim:sentence,
      value:value??correctValue,
      unit:value==null?(correctUnit||unit):unit,
      correctValue:correctValue??null,
      correctUnit:correctValue==null?'':correctUnit,
      period,
      type:'user_claim',
      role:'user',
      pattern:pattern||'should_be',
      turn,
    });
  }
  const seen=new Set();
  return found.filter(c=>{
    const key=[c.claim,c.value,c.unit,c.correctValue,c.correctUnit].join('|');
    if(seen.has(key)) return false;
    seen.add(key); return true;
  }).slice(0,5);
}

/** Host/helper write path used before the model turn. Never throws into the turn. */
export async function recordUserClaims(root,sessionId,text,{turn=1}={}) {
  if(!root||!sessionId) return [];
  const claims=detectUserClaims(text,{turn});
  if(!claims.length) return [];
  const ledger=await readLedger(root,sessionId);
  const existing=Array.isArray(ledger?.claims)?ledger.claims:[];
  const appended=[];
  for(const claim of claims) {
    const duplicate=existing.some(c=>c&&c.claim===claim.claim&&String(c.value)===String(claim.value)&&String(c.unit)===String(claim.unit));
    if(duplicate) continue;
    try {
      appended.push(await appendClaim(root,sessionId,{
        ...claim,
        evidence:{type:'user',ref:`turn ${turn}`},
        turn,
      }));
    } catch { /* claim capture must never block the user turn */ }
  }
  return appended;
}
