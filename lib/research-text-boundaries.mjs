import {Lexer} from 'marked';

// Qualify a complete statement, not an arbitrary string fragment. Delimiters
// inside references, formulas and quoted text do not end the statement.
export function replaceResearchSpan(draft,excerpt,replacement) {
  const start=draft.indexOf(excerpt),end=start+excerpt.length;
  if(start<0)return draft;
  let cursor=0,regionStart=0,regionEnd=draft.length;
  for(const token of Lexer.lex(draft)) {
    const offset=draft.indexOf(token.raw,cursor);
    if(offset<0)continue;
    cursor=offset+token.raw.length;
    if(start<offset || end>cursor)continue;
    regionStart=offset;regionEnd=cursor;
    if(token.type==='code')return draft.slice(0,offset)+replacement+'\n\n'+draft.slice(cursor);
    if(token.type==='table') {
      let lineAt=offset;
      const rows=token.raw.trimEnd().split(/\r?\n/).map((text,index)=>{
        const from=draft.indexOf(text,lineAt);lineAt=from+text.length;
        return {text,index,hit:from<end && from+text.length>start};
      });
      if(rows.slice(0,2).some(r=>r.hit))return draft.slice(0,offset)+replacement+'\n\n'+draft.slice(cursor);
      const retained=rows.filter(r=>r.index<2 || !r.hit && !/合计|总计|因此|据此|结论/.test(r.text));
      const table=retained.length>2?retained.map(r=>r.text).join('\n')+'\n\n':'';
      return draft.slice(0,offset)+table+replacement+'\n\n'+draft.slice(cursor);
    }
    break;
  }
  const openings={'[':']','(':')','（':'）','【':'】','{':'}','“':'”','‘':'’'};
  const stack=[],boundaries=[{pos:regionStart}];let code=false;
  for(let i=regionStart;i<regionEnd;i++) {
    const ch=draft[i];
    if(ch==='`'){code=!code;continue;}
    if(code)continue;
    if(openings[ch])stack.push(openings[ch]);
    else if(stack.at(-1)===ch)stack.pop();
    if(!stack.length && /[。！？；\n]/.test(ch))boundaries.push({pos:i+1,newline:ch==='\n'});
  }
  const left=boundaries.findLast(b=>b.pos<=start)?.pos ?? regionStart;
  const boundary=boundaries.find(b=>b.pos>=end);
  const right=boundary?(boundary.pos===end?end:boundary.pos-(boundary.newline?1:0)):regionEnd;
  return draft.slice(0,left)+replacement+draft.slice(right);
}
