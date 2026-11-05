import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Type } from 'typebox';
const script=fileURLToPath(new URL('../services/calc/evaluate.py',import.meta.url));
export function createCalcTool(){return {
 name:'calc',label:'精确计算',description:'50位十进制确定性计算，+ - * / ^，ROUND/ROUNDUP/ROUNDDOWN(x,digits)、ABS、MIN/MAX/SUM、NPV(rate,cf1,cf2...)。NPV从第1期开始。单位换算限同币种金额尺度。两种用法二选一：expression直接算完整换算则不填单位；填from_unit/to_unit时expression只接受源单位数值字面量；复合金额先不带单位计算，再用所得数值换算，不要先除换算因子（例如10000万元→亿元用expression=10000、from_unit=万元、to_unit=亿元，不是10000/10000再填单位）；汇率需明确写入表达式。不是Excel重算。',
 parameters:Type.Object({expression:Type.String({maxLength:2000,description:"不填单位时为数学表达式；填单位时必须是源单位数值字面量（可负数或科学计数法），不接受算式，以避免二次换算"}),from_unit:Type.Optional(Type.String({description:"expression中数值的源单位；仅金额尺度：元、千元、万元、百万元、亿元、million、billion"})),to_unit:Type.Optional(Type.String({description:"目标单位；必须与from_unit成对提供，不是给结果贴标签"}))}),
 async execute(_id,args){try{
  if((args.from_unit||args.to_unit)&&!/^[-+]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/.test(String(args.expression||'').trim()))throw Error('带单位换算仅接受源单位数值，不能同时传入算式。请将原始金额直接传入expression；若原始金额需要计算，先不填单位计算，再将源单位结果作为数值换算。');
  const result=await new Promise((resolve,reject)=>{
   const child=spawn(process.env.PYTHON_BIN||'python3',[script],{stdio:['pipe','pipe','pipe']});let output='';
   const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('计算超时'));},3000);
   child.on('error',e=>{clearTimeout(timer);reject(e);});child.stdout.on('data',b=>{output+=b;if(output.length>20000)child.kill('SIGKILL');});child.stderr.resume();child.stdin.on('error',()=>{});
   child.on('close',()=>{clearTimeout(timer);try{const d=JSON.parse(output);if(!d.ok)reject(Error(d.error));else resolve(d);}catch(e){reject(e);}});
   child.stdin.end(JSON.stringify(args));
  });return {content:[{type:'text',text:JSON.stringify({expression:args.expression,...result})}],details:result};
 }catch(e){return {content:[{type:'text',text:'calc 失败：'+e.message}],details:{error:e.message},isError:true};}}
};}
