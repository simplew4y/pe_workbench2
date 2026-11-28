import {extractLocatorMatches,normalizeLocator} from './citation-locator.mjs';
import {currentCitation} from './citations.mjs';

// Canonicalize presentation names before lint and recovery. A qualifier can
// identify a file but never establishes the truth of the adjacent assertion.
export function canonicalWorkbookRefs(text,citations,versions,attachments=[]) {
  if(!text.includes('!'))return text;
  const files=new Map();
  for(const c of citations){
    if(!c.materialId || !c.version || c.derivedFrom || !currentCitation(c,versions))continue;
    const id=c.materialId+'@v'+c.version;
    if(!files.has(id))files.set(id,{id,materialId:c.materialId,version:c.version,names:new Set(),cells:new Set()});
    const f=files.get(id);
    for(const n of [c.filename,c.storedFilename])if(n)f.names.add(n);
    f.cells.add(normalizeLocator(c.locator)?.toLowerCase());
  }
  if(!files.size)return text;
  const base=s=>s.replace(/^(?:\d{10,17}[-_])+/,'').toLowerCase();
  const uploads=attachments.map(path=>path.split('/').at(-1));
  const candidates=[...files.values()];
  const pick=name=>{
    const exact=candidates.filter(f=>f.id===name || f.names.has(name));
    if(exact.length)return exact.length===1?exact[0]:null;
    const short=name.match(/^([a-f0-9]{8,}(?:-[a-f0-9]+)*)@v(\d+)$/i);
    const found=short?candidates.filter(f=>f.materialId.startsWith(short[1]) && f.version===Number(short[2])):
      candidates.filter(f=>[...f.names].some(n=>base(n)===name.toLowerCase()));
    if(found.length!==1 || (!short && uploads.some(n=>base(n)===name.toLowerCase() && !found[0].names.has(n))))return null;
    return found[0];
  };
  const aliases=new Map();
  for(const m of text.matchAll(/(?:^|\n)\s*(?:下文|以下|文中)?\s*\[([^\]\n]{1,30})\]\s*(?:指|代表|是)\s*(?:上传的|附件中的|附件)?\s*[*\x60“《]*([^*\x60”》\n]+?\.xls[xmb])[*\x60”》]*(?=[。，\s]|$)/gi)){
    const f=pick(m[2].trim());
    aliases.set(m[1],aliases.has(m[1]) && aliases.get(m[1])!==f?null:f);
  }
  let cursor=0,out='';
  for(const m of extractLocatorMatches(text)){
    if(m.index<cursor)continue;
    const qualifier=m.raw.match(/^\[([^\]]+)\]/)?.[1];
    if(!qualifier)continue; // Bare and bracket-enclosed source lists retain their native syntax.
    const f=pick(qualifier) || (!candidates.some(f=>f.names.has(qualifier)) && aliases.get(qualifier));
    if(!f || !f.cells.has(m.key))continue;
    const canonical=[...f.names].find(n=>candidates.filter(x=>x.names.has(n)).length===1) || f.id;
    const prefix='['+canonical+']';
    let value=qualifier && !f.names.has(qualifier) && qualifier!==f.id?prefix+m.locator:m.raw;
    let end=m.index+m.raw.length;
    const sheet=m.locator.slice(0,m.locator.lastIndexOf('!'));
    for(const short of text.slice(end).matchAll(/、(\$?[A-Z]{1,3}\$?[1-9]\d*)(?![a-zA-Z0-9_!:])/gy)){
      const cell=sheet+'!'+short[1];
      if(!f.cells.has(normalizeLocator(cell)?.toLowerCase()))break;
      value+='、'+prefix+cell;end+=short[0].length;
    }
    out+=text.slice(cursor,m.index)+value;cursor=end;
  }
  return out+text.slice(cursor);
}
