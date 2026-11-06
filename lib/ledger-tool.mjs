import {Type} from 'typebox';
import {appendFact,appendCorrection,appendOpen,resolveOpen} from './ledger.mjs';
import {scanCorrection} from './artifact-revision.mjs';
const evidence=Type.Object({type:Type.Union(['cell','page','url','tool','user'].map(v=>Type.Literal(v))),ref:Type.String()});
const value=Type.Union([Type.String(),Type.Number(),Type.Boolean()]);
export function createLedgerTool({ctx,getSessionId,getTurn,broadcast=()=>{},onChange=()=>{}}) {
 return {name:'ledger_record',label:'记录会话台账',description:'记录本会话事实、更正、待核项或解决待核项；更正必须有证据，受影响产物将请求人工审批。不能批准或直接应用更正。',
 promptSnippet:'ledger_record：记录本会话事实与有证据的更正',promptGuidelines:['用户或自查更正数字/判断时，先以证据记录 correction，再回答；自查必须先 transcript_search，本工具链的 transcript_search 会同时读取本会话台账。'],
 parameters:Type.Object({kind:Type.Union(['fact','correction','open','resolve'].map(v=>Type.Literal(v))),id:Type.Optional(Type.String()),claim:Type.Optional(Type.String()),value:Type.Optional(value),unit:Type.Optional(Type.String()),period:Type.Optional(Type.String()),from:Type.Optional(value),to:Type.Optional(value),evidence:Type.Optional(evidence),reason:Type.Optional(Type.String()),text:Type.Optional(Type.String())}),
 execute:async(_id,p)=>{
  try {
   const sessionId=getSessionId(),params={...p,turn:getTurn()};let record,scan;
   if(p.kind==='fact')record=await appendFact(ctx.root,sessionId,params);
   else if(p.kind==='correction'){record=await appendCorrection(ctx.root,sessionId,params);scan=await scanCorrection({ctx,sessionId,correction:record,broadcast});}
   else if(p.kind==='open')record=await appendOpen(ctx.root,sessionId,params);
   else if(p.kind==='resolve')record=await resolveOpen(ctx.root,sessionId,p.id);
   else throw new Error('invalid kind');
   await onChange(); const details={record,...(scan?{scan}: {})};return {content:[{type:'text',text:JSON.stringify(details)}],details};
  } catch(e){await onChange();return {content:[{type:'text',text:e.message}],isError:true};}
 }};
}
