/** Match obsolete values without mistaking 7.3 for 17.3/7.33. */
const esc=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function correctionMatches(text,c,{context='',allowOld=false}={}) {
  text=String(text);const from=String(c.from);if(!from) return [];
  const normalized=from.replace(/,/g,'').trim();
  const numeric=/^[+-]?\d+(?:\.\d+)?$/.test(normalized);
  let pattern=[...from.replace(/\s+/g,'')].map(esc).join('\\s*');
  if(numeric) {
    const negative=normalized.startsWith('-');
    const [whole,fraction]=normalized.replace(/^[+-]/,'').split('.');
    const digits=whole.split('').map(esc).join(',?');
    const tail=fraction?.replace(/0+$/,'');
    pattern=(negative?'[-−]':'\\+?')+digits+(tail?`\\.${esc(tail)}0*`:'(?:\\.0+)?');
  }
  const re=new RegExp(pattern,'gi');const matches=[];
  for(const m of text.matchAll(re)) {
    const start=m.index,end=start+m[0].length;
    if(numeric&&(/[\d.,+−-]/.test(text[start-1]||'')||/[\d.]/.test(text[end]||''))) continue;
    if(!numeric&&(/[A-Za-z0-9_]/.test(text[start-1]||'')||/[A-Za-z0-9_]/.test(text[end]||''))) continue;
    const near=text.slice(Math.max(0,start-60),end+60)+' '+context;
    if(numeric&&!((c.unit&&text.slice(end,end+15).replace(/\s/g,'').startsWith(String(c.unit).replace(/\s/g,'')))||(c.claim&&near.includes(c.claim)))) continue;
    // An old-value marker must be local to this occurrence, not in another sentence.
    const local=text.slice(Math.max(0,start-20),start).split(/[。！？；\n]/).at(-1);
    const after=text.slice(end,end+20).split(/[。！？；\n]/)[0];
    if(!allowOld&&/原为|原值|此前误写|已更正|旧值|错误值|误写|误为/.test(local+' '+after)) continue;
    matches.push({start,end,text:m[0]});
  }
  return matches;
}
