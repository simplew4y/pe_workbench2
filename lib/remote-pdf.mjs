import * as OpenCC from 'opencc-js';
const toSimplified=OpenCC.Converter({from:'hk',to:'cn'});
export const pdfSearchKey=text=>toSimplified(String(text).normalize('NFKC')).toLowerCase().replace(/\s+/g,'');
/** Parse already-downloaded bytes; this module never follows URLs. */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run=promisify(execFile);
export async function extractRemotePdf(buffer,{signal,timeoutMs=20000}={}) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'workbench-source-pdf-'));
  try {
    const file=path.join(dir,'source.pdf');await fs.writeFile(file,buffer);
    const {stdout}=await run(process.env.PYTHON_BIN || 'python3',['-c',
      'import pymupdf as fitz,json,sys\ndoc=fitz.open(sys.argv[1])\nif len(doc)>1500: raise ValueError("PDF exceeds 1500 pages")\nprint(json.dumps({"pages":[{"page":i+1,"text":p.get_text(sort=True)} for i,p in enumerate(doc)]},ensure_ascii=False))',file],
      {timeout:timeoutMs,signal,maxBuffer:24*1024*1024});
    return JSON.parse(stdout).pages;
  } finally {await fs.rm(dir,{recursive:true,force:true});}
}
export function selectPdfPages(pages,query,maxChars) {
  const terms=toSimplified(String(query || '').normalize('NFKC')).toLowerCase().split(/[\s,，;；]+/).filter(Boolean);
  const ranked=pages.map(p=>({...p,score:terms.reduce((n,t)=>n+(pdfSearchKey(p.text).includes(pdfSearchKey(t))?1:0),0)}));
  const matches=terms.length?ranked.filter(p=>p.score):ranked;
  const candidates=(matches.length?matches:ranked).sort((a,b)=>b.score-a.score || a.page-b.page);
  const selected=[];let remaining=maxChars;
  for(const page of candidates) {
    if(remaining<100)break;
    if(!page.text.trim())continue;
    const heading=`[PDF第${page.page}页]\n`;
    const text=page.text.slice(0,Math.max(0,remaining-heading.length));
    selected.push({page:page.page,text:heading+text,clipped:text.length<page.text.length});remaining-=heading.length+text.length+2;
  }
  selected.sort((a,b)=>a.page-b.page);
  return {text:selected.map(p=>p.text).join('\n\n'),pages:selected.map(p=>p.page),
    truncated:selected.length<pages.length || selected.some(p=>p.clipped),queryMatched:!terms.length || matches.length>0};
}
