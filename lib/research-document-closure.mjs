import {Lexer} from 'marked';

const plain=s=>String(s || '').replace(/[*`#]/g,'').replace(/\s+/g,' ').trim();
const identifier=/\b[A-Z]{1,4}\d{1,4}\b/g;
export const researchCropMarkerPattern='此处数值或单位尚需核对，暂不据此判断。|此项判断证据不足，暂不能确定。|指标定义与口径仍需核对，此项结论待定。|现有来源尚不足以支持该确定性结论。|比较口径尚未对齐，暂不能据此下结论。|具体失效门槛尚缺推导依据，暂不能确定。';
function refs(text) {
  const ids=new Set(text.match(identifier) || []);
  for(const m of text.matchAll(/\b([A-Z]{1,4})(\d{1,4})\s*[-—–至]\s*(?:\1)?(\d{1,4})\b/g))
    if(+m[3]-+m[2]<=100)for(let i=+m[2];i<=+m[3];i++)ids.add(m[1]+i);
  return ids;
}
export function researchDefinitions(text) {
  const found=new Set();
  for(const token of Lexer.lex(text)) {
    if(token.type==='heading') {
      const id=plain(token.text).match(/^([A-Z]{1,4}\d{1,4})(?:\s|[：:、])/ )?.[1];
      if(id)found.add(id);
    }
    if(token.type==='table')for(const row of token.rows) {
      const id=plain(row[0]?.text).match(/^([A-Z]{1,4}\d{1,4})$/)?.[1];
      if(id)found.add(id);
    }
  }
  return found;
}
const gap='> 本节的证据或结构化条目不完整，相关判断与监控条件暂不交付；需补齐后再形成结论。';

/** Close references over the final Markdown, not just over the original draft.
 * Removed definitions cannot leave live dependants in tables, prose or lists.
 * A damaged evidence table also withdraws its unbound narrative conclusions.
 */
export function closeResearchDocument(original,text,{invalidateIds=[]}={}) {
  const defined=researchDefinitions(original),invalid=new Set(invalidateIds);
  const before=Lexer.lex(original),after=Lexer.lex(text);
  const tablesBySection=new Map();let section='';
  for(const t of before){if(t.type==='heading')section=plain(t.text);if(t.type==='table'){
    const list=tablesBySection.get(section) || [];list.push(...t.raw.trim().split('\n').slice(2).map(plain));tablesBySection.set(section,list);
  }}
  const finalRows=new Set(after.filter(t=>t.type==='table').flatMap(t=>t.raw.trim().split('\n').slice(2).map(plain)));
  const damaged=new Set([...tablesBySection].filter(([,rows])=>rows.some(row=>!finalRows.has(row))).map(([key])=>key));
  let body=text;const removed=new Set();
  for(let pass=0;pass<=defined.size+1;pass++) {
    const present=researchDefinitions(body);
    const missing=new Set([...defined].filter(id=>!present.has(id)));for(const id of invalid)missing.add(id);
    const bad=s=>[...refs(s)].some(id=>missing.has(id));
    const out=[];let current='',blockedDepth=0,noticed=false;
    const omit=()=>{if(!noticed){out.push(gap);noticed=true;}};
    const retain=(raw,table=false)=>{
      if(bad(raw)){for(const id of refs(raw))if(defined.has(id))removed.add(id);omit();return;}
      // A removed assertion cannot retain an anaphoric explanation such as
      // "this proves..." after the replacement notice in the same paragraph.
      const marker=!table && raw.match(new RegExp('^\\s*(?:'+researchCropMarkerPattern+')'));
      if(marker) {
        let tail=raw.slice(marker[0].length);
        while(/^\s*(?:这是|这说明|这表明|这意味着|因此|所以|由此|据此|该结果|上述结果)/.test(tail)) {
          const sentence=tail.match(/^[^。！？\n]*[。！？\n]?/)[0];
          if(!sentence)break;tail=tail.slice(sentence.length);
        }
        out.push(marker[0].trim()+tail);return;
      }
      // The table was the premise of this section. A heading or an ordinal
      // list does not independently substantiate its sensitivity ranking.
      const qualified=/^\s*(?:> |未核验[：:]|未核实[：:])/.test(raw);
      const ownSource=/https?:\/\/|![A-Z]+\d+|\[来源|\[source/.test(raw);
      if(!table && damaged.has(current) && !qualified && !ownSource){omit();return;}
      out.push(raw.trim());
    };
    for(const t of Lexer.lex(body)) {
      if(t.type==='space')continue;
      if(t.type==='heading') {
        if(blockedDepth && t.depth>blockedDepth)continue;
        blockedDepth=0;current=plain(t.text);noticed=false;
        if(bad(t.raw)){blockedDepth=t.depth;omit();continue;}
        out.push(t.raw.trim());continue;
      }
      if(blockedDepth)continue;
      if(t.type==='table') {
        const lines=t.raw.trimEnd().split('\n');const rows=lines.slice(2).filter(row=>!bad(row));
        if(rows.length)retain([...lines.slice(0,2),...rows].join('\n'),true);
        if(rows.length!==lines.length-2)omit();
      } else if(t.type==='list')for(const item of t.items)retain(item.raw);
      else if(t.type==='hr')out.push(t.raw.trim());
      else retain(t.raw);
    }
    const next=out.join('\n\n').replace(/(> 本节[^\n]+)(?:\s*\n\s*> 本节[^\n]+)+/g,'$1');
    if(next===body)break;body=next;
  }
  // Collapse empty section shells into an explicit scope notice. Keep the
  // missing section names, rather than a sequence of headings and templates.
  const tokens=Lexer.lex(body),empty=[],compact=[];
  const onlyGap=raw=>!raw.trim() || /^\s*(?:>\s*)?(?:本节(?:部分内容|的证据或结构化条目)|此项判断证据不足|此处数值或单位尚需核对)/.test(raw);
  for(let i=0;i<tokens.length;i++) {
    const t=tokens[i];
    if(t.type==='heading' && t.depth>=2) {
      let j=i+1;while(j<tokens.length && tokens[j].type!=='heading')j++;
      const contents=tokens.slice(i+1,j);
      if(contents.length && contents.every(x=>x.type==='space' || x.type==='hr' || onlyGap(x.raw))) {
        empty.push(plain(t.text));i=j-1;continue;
      }
    }
    compact.push(t.raw);
  }
  if(empty.length)body=compact.join('').trim()+'\n\n> 未交付的部分：'+empty.join('；')+'。这些部分的证据或关联条目尚不完整，暂不形成投资结论与监控条件。';
  return {text:body,removedIds:[...removed],incompleteSections:[...new Set([...damaged,...empty])],changed:body!==text};
}
