/** Conservative, advisory checks. Never alter an answer or trigger generation. */
export function lintAnswer(text='') {
 const warnings=[];const clean=String(text).trim();if(!clean)return warnings;
 const fenceCount=(clean.match(/^\s*```/gm)||[]).length;
 // Only a dangling opener at the end. Counting all parentheses mislabels URLs/code.
 if(fenceCount%2 || /[（(【\[]\s*$/.test(clean)) warnings.push({code:'INCOMPLETE_ANSWER',message:'回答疑似未完成：末尾有未完成结构，请复核。',severity:'warning'});
 // Only explicit equations, excluding quoted/code lines and correction/negation sentences.
 let inCode=false;
 for(const line of clean.split('\n')){
  if(/^\s*```/.test(line)){inCode=!inCode;continue;}if(inCode)continue;
  if(/^\s*[>`]/.test(line)||/错误|误写|不是|不等于|应为|更正|原话/.test(line))continue;
  const re=/([\d,]+(?:\.\d+)?)\s*(?:百万元|million)\s*(?:=|＝|等于|折合(?:约)?)\s*([\d,]+(?:\.\d+)?)\s*亿元/g;
  for(const m of line.matchAll(re)){const from=Number(m[1].replaceAll(',','')),to=Number(m[2].replaceAll(',',''));if(Number.isFinite(from)&&Number.isFinite(to)&&Math.abs(from/100-to)>Math.max(.02,Math.abs(from/100)*.01))warnings.push({code:'UNIT_CONVERSION',message:'显式百万元→亿元换算疑似不一致：'+m[0]+'。请用 calc 核验。',severity:'warning'});}
 }
 return warnings;
}
