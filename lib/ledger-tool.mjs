import {Type} from 'typebox';
import {appendFact,appendClaim,appendCorrection,appendOpen,resolveOpen} from './ledger.mjs';
import {scanCorrection} from './artifact-revision.mjs';
const evidence=Type.Object({type:Type.Union(['cell','page','url','tool','user'].map(v=>Type.Literal(v))),ref:Type.String()});
const value=Type.Union([Type.String(),Type.Number(),Type.Boolean()]);
export function createLedgerTool({ctx,getSessionId,getTurn,broadcast=()=>{},onChange=()=>{}}) {
 return {name:'ledger_record',label:'记录会话台账',description:'记录本会话事实、用户主张（claim）、更正（correction）、待核项或解决待核项；更正必须有证据，受影响产物将请求人工审批。不能批准或直接应用更正。',
  promptSnippet:'ledger_record：记录本会话事实、用户主张与有证据的更正',promptGuidelines:['用户口述「写成了/应为/有人写成」等明确纠错时，先用 kind=claim 记录 user_claim（不要从长文自动抽取所有数字），确认后用 kind=correction（可带 claimId）记录更正；自查必须先 transcript_search（同时返回台账 ledgerMatches），逐条核对 claim/correction，不得靠记忆声称全部正确。'],
  parameters:Type.Object({kind:Type.Union(['fact','claim','correction','open','resolve'].map(v=>Type.Literal(v))),id:Type.Optional(Type.String()),claim:Type.Optional(Type.String()),value:Type.Optional(value),unit:Type.Optional(Type.String()),period:Type.Optional(Type.String()),correctValue:Type.Optional(value),correctUnit:Type.Optional(Type.String()),claimId:Type.Optional(Type.String()),role:Type.Optional(Type.String()),claimType:Type.Optional(Type.String()),from:Type.Optional(value),to:Type.Optional(value),evidence:Type.Optional(evidence),reason:Type.Optional(Type.String()),text:Type.Optional(Type.String())}),
  execute:async(_id,p)=>{
   try {
    const sessionId=getSessionId(),params={...p,turn:getTurn()};let record,scan;
    if(p.kind==='fact')record=await appendFact(ctx.root,sessionId,params);
    else if(p.kind==='claim')record=await appendClaim(ctx.root,sessionId,{...params,type:p.claimType==='doubt'?'doubt':'user_claim'});
    else if(p.kind==='correction'){record=await appendCorrection(ctx.root,sessionId,params);scan=await scanCorrection({ctx,sessionId,correction:record,broadcast});}
    else if(p.kind==='open')record=await appendOpen(ctx.root,sessionId,params);
    else if(p.kind==='resolve')record=await resolveOpen(ctx.root,sessionId,p.id);
    else throw new Error('invalid kind');
    await onChange(); const details={record,...(scan?{scan}: {})};return {content:[{type:'text',text:JSON.stringify(details)}],details};
   } catch(e){await onChange();return {content:[{type:'text',text:e.message}],isError:true};}
  }};
}
