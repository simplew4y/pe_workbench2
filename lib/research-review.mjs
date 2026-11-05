import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {Type} from "typebox";
import {insideProjectRealRoot} from "./workspace-path.mjs";

const hash = text => crypto.createHash("sha256").update(text).digest("hex");
const uncertain = /待核实|待验证|未核实|未知|无法确认|无法推导|待定|不可直接比较/;
const numericLines = content => content.split(/\r?\n/).filter(line => /\d/.test(line));
const unitKey = unit => String(unit || "").replace(/\s/g, "").replace(/USD/g, "US$");
const thresholdWords = /阈值|失效|临界|threshold|break.?even/i;
function displayedValue(claim) {
  const match = String(claim.valueText || "").match(/^(-?\d+(?:,\d{3})*(?:\.\d+)?)(%)?$/);
  if (!match || !claim.text.includes(claim.valueText)) return null;
  const number = match[1].replace(/,/g, "");
  const scale = match[2] ? 100 : 1;
  const digits = (number.split('.')[1] || '').length;
  return {value: Number(number) / scale, tolerance: 0.5 * 10 ** -digits / scale + 1e-10};
}

// Values and provenance are checked by the host. This does not certify financial truth.
export async function reviewClaims({content, claims = [], workbooks, store, evidence = new Map()}) {
  const errors = [], checked = new Map(), sources = [];
  for (const [i,original] of claims.entries()) {
    let c = original;
    const fail = message => errors.push(`claims[${i}]: ${message}`);
    if (!c || typeof c !== "object") { fail("claim 必须是对象"); continue; }
    if (!c.id || checked.has(c.id)) { fail("缺少或重复 id"); continue; }
    if (typeof c.text !== "string" || !c.text || !content.includes(c.text)) { fail("text 必须逐字出现在报告中"); continue; }
    let valid = true;
    const reject = message => { valid=false; fail(message); };
    if (c.kind === "unknown") {
      if (!uncertain.test(c.text)) reject("无证据的数字必须明确标为待验证，不能写成确定事实或阈值");
    } else if (c.kind === "cell") {
      const material=store.findMaterialByPath(c.file);
      if (!material) { reject("来源文件不存在"); }
      else {
        const result=await workbooks.queryMaterial(material.id,c.ref,{maxCells:1});
        const cell=result.cells?.[0];
        if (result.error || !cell || result.seeds?.[0] !== cell.ref) reject("单元格引用没有精确命中");
        else {
          sources.push({file:c.file, ref:cell.ref, rawValue:cell.value, rowLabel:cell.rowLabel,
            period:cell.period === undefined ? cell.columnLabel : cell.period, header:cell.header,
            numeratorRef:cell.ratioEvidence?.numerator?.ref, denominatorRef:cell.ratioEvidence?.denominator?.ref});
          if (!c.ref?.includes("!") || cell.ref.toLowerCase() !== c.ref.replace(/\$/g, "").replace(/^'([^']+)'!/, "$1!").toLowerCase()) reject("必须使用精确 Sheet!A1");
          if (typeof c.value !== "number" || typeof cell.value !== "number") reject("value 必须是数字缓存值");
          const period = cell.period === undefined ? cell.columnLabel : cell.period;
          if (period && c.period !== period) reject(`期间不符，应为 ${period}`);
          if (!period && c.period) reject("该格未识别到独立期间。标量参数请省略 period，勿把情景名当作年份");
          let display = displayedValue(c);
          if (display && c.unit === "亿元" && cell.amount?.unit === "百万元") {
            display = {value: display.value * 100, tolerance: display.tolerance * 100};
          }
          const statedPeriods = c.text.match(/(?:[1-4]Q(?:\d{4}|\d{2})|(?:19|20)\d{2})[AE]?/gi) || [];
          if (period && statedPeriods.length && !statedPeriods.includes(period)) reject(`正文期间与来源不符：${period}`);
          if (typeof c.value==='number' && typeof cell.value==='number' && Math.abs(c.value-cell.value)>Math.max(1e-8,Math.abs(cell.value)*1e-8)
            && (!display || Math.abs(c.value-display.value)>1e-8 || Math.abs(display.value-cell.value)>display.tolerance)) reject(`数值与原表不符：${cell.value}；value 可用原始值或与 valueText 一致的舍入值`);
          if (!display || Math.abs(display.value-cell.value)>display.tolerance) reject("报告中的 valueText 与原表数值不符（允许显示舍入及百分数）");
          if (!c.unit) reject("缺少单位；比例使用 ratio");
          else if (c.unit !== 'ratio' && !unitKey(c.text).includes(unitKey(c.unit))) reject("正文必须包含声明的单位，且 GB/Gb 大小写一致");
          if (!content.includes(c.period || '') || !content.includes(c.ref || '')) reject("正文必须包含核验的期间和单元格引用");
          c = {...c, thresholdEvidence: thresholdWords.test(cell.rowLabel || '')};
          const label=cell.rowLabel || "";
          const unit=label.match(/\(([^()]*(?:US\$|Rmb|Gb|GB|kwpm)[^()]*)\)/)?.[1];
          if (unit && unitKey(c.unit) !== unitKey(unit)) reject(`单位与原表不符：${unit}`);
          if (cell.ratioEvidence && (c.numeratorRef !== cell.ratioEvidence.numerator?.ref || c.denominatorRef !== cell.ratioEvidence.denominator?.ref)) reject("比例必须列出真实分子和分母引用");
        }
      }
    } else if (c.kind === "source") {
      const source=evidence.get(c.evidenceId);
      if (!source || !c.quote || !source.includes(c.quote)) reject("引文不是本会话实际工具返回的原文");
      if (!c.locator || !source?.includes(c.locator)) reject("缺少工具结果中真实出现的来源定位");
      if (!c.period || !c.unit || !c.entity || !c.metric) reject("来源事实必须声明主体、指标、单位和期间");
      const display = displayedValue(c);
      if (!display || typeof c.value !== 'number' || Math.abs(display.value-c.value)>display.tolerance || !c.quote?.includes(c.valueText)) reject("正文 valueText 必须出现在引文中，并与 value 一致");
      for (const field of ['period','entity','metric']) {
        if (!c.quote?.includes(c[field])) reject(`引文必须包含声明的 ${field}，请使用原文措辞`);
      }
      if (c.unit && c.unit !== 'ratio' && (!unitKey(c.quote).includes(unitKey(c.unit)) || !unitKey(c.text).includes(unitKey(c.unit)))) reject("原文和正文单位不符");
      c = {...c, thresholdEvidence: thresholdWords.test(c.quote || '')};
    } else if (c.kind === "threshold") {
      const basis=checked.get(c.basisId);
      if (!basis || !["cell","source"].includes(basis.kind)) reject("阈值必须引用先前通过核验的模型单元格或原始来源；无推导依据时使用 unknown，不得编造数值");
      if (!c.rationale) reject("缺少阈值依据与适用条件");
      if (basis && !basis.thresholdEvidence) reject("来源只给出普通数值，不能据此宣布失效阈值；需要明确阈值原文，否则标为 unknown");
      const display = displayedValue(c);
      if (!display || typeof c.value !== 'number' || Math.abs(display.value-c.value)>display.tolerance) reject("阈值正文与 value 不符");
      if (basis && (c.value !== basis.value || c.unit !== basis.unit)) reject("阈值数值或单位与依据不一致；自主推断应标为 unknown");
    } else if (c.kind === "comparison") {
      const left=checked.get(c.leftId),right=checked.get(c.rightId);
      if (!left || !right || [left.kind,right.kind].some(k=>!["cell","source"].includes(k))) reject("比较两端必须先通过来源核验");
      else for(const field of ["entity","product","metric","unit","period","valueType"]) {
        if (!left[field] || left[field] !== right[field]) reject(`不可直接比较：${field} 不一致或缺失；请解释差异并标为 unknown`);
      }
    } else reject("kind 必须是 cell/source/threshold/comparison/unknown");
    if(valid) checked.set(c.id,c);
  }
  for(const line of numericLines(content)) {
    const covering = [...checked.values()].filter(c=>c.text.includes(line.trim()) || line.includes(c.text));
    if (covering.some(c=>c.kind==='unknown')) continue;
    let remaining = line.trim().replace(/^\d+[.)]\s+/, '').replace(/\bP[0-3]\b/g, '');
    // File names and already-verified periods are metadata, not fresh numeric claims.
    const metadata = [...checked.values()].flatMap(c=>[c.file,c.period,c.ref]).filter(x=>typeof x==='string' && x);
    for(const token of metadata.sort((a,b)=>b.length-a.length)) remaining=remaining.split(token).join('');
    const tokens = covering.flatMap(c=>[c.valueText,c.period,c.ref,c.file,c.locator,c.entity,c.product,c.metric,c.unit]).filter(x=>typeof x==='string' && x);
    for (const token of tokens.sort((a,b)=>b.length-a.length)) remaining=remaining.split(token).join('');
    if(/\d/.test(remaining)) errors.push(`含数字的行缺少对应数值或引用核验：${line.slice(0,100)}`);
  }
  const result = {ok:errors.length===0,errors,checked:[...checked.keys()]};
  if (errors.length) {
    result.sourceCells = sources;
    result.nextStep = "根据 sourceCells 修正引用、单位和期间，重新核验完整报告。无法证明的部分说明具体证据缺口，保留已核实结论。通过后写入同一路径。";
  }
  return result;
}

export function createResearchReview({ctx}) {
  const evidence=new Map(),approved=new Map();
  const resolve = relative => {
    const absolute=path.resolve(ctx.root,relative || "");
    let existing=absolute;
    while(!fs.existsSync(existing) && path.dirname(existing)!==existing) existing=path.dirname(existing);
    if(!absolute.startsWith(path.resolve(ctx.root)+path.sep) || !insideProjectRealRoot(ctx.root,existing)) throw new Error("路径必须在当前项目内");
    return absolute;
  };
  const baseline = absolute => fs.existsSync(absolute) ? hash(fs.readFileSync(absolute)) : null;
  const tool={name:"review_research",label:"核验研究报告",
    description:"研究报告写入前的必经核验。传 path、完整 content 和 claims。数字须由claims的text覆盖，行内每个数字须匹配valueText/period/ref等字段；同一行多个数值需多条claim。已核验的文件路径、引用和期间可在标题中复用。优先写简短核验报告，每个指标一行，不要为无关日期/算式扩充报告。cell: id,text,kind,file,ref,value(原始缓存值或与valueText一致的舍入值),valueText(正文数字字符串如8.34或2.1%，必须与原值舍入相符),unit(原表单位或ratio),period,entity,product,metric,valueType(actual/forecast/assumption)；正文写引用、已识别的期间及单位。无期间的标量参数省略 period。比例另附 numeratorRef/denominatorRef。source: id,text,kind,evidenceId(工具返回research_evidence_id),quote(原文),locator,period,unit,entity,product,metric,value,valueText,valueType；period/entity/metric须逐字出现在quote中，valueText同时出现在quote和正文。threshold: basisId,value,valueText,unit,rationale，依据原文必须明确给出阈值，普通预测值不代表阈值；comparison: leftId,rightId，引用前面的证据。无证据或不可比时 kind=unknown，text 明确写待核实/不可直接比较。最小单元格例：content=2026E HBM ASP 8.34 US$/GB（Assumption!AH122），claim 的 kind=cell，value=8.34，valueText=8.34，unit=US$/GB，period=2026E，ref=Assumption!AH122，text=完整content。通过后用 write 原样写入；修改内容须重新核验。retracted 可列要撤回的旧错误原句，检查 exports 下仍含该句的有效报告。",
    parameters:Type.Object({path:Type.String(),content:Type.String(),claims:Type.Array(Type.Object({
      id:Type.String(), kind:Type.Union(['cell','source','threshold','comparison','unknown'].map(v=>Type.Literal(v))),
      text:Type.String({description:'逐字复制正文的数字所在行或片段，不要改写。unknown 必须含待核实/无法推导/不可直接比较等措辞。'}),
      ...Object.fromEntries(['file','ref','valueText','unit','period','entity','product','metric','valueType','numeratorRef','denominatorRef','evidenceId','quote','locator','basisId','rationale','leftId','rightId'].map(key=>[key,Type.Optional(Type.String())])),
      value:Type.Optional(Type.Number())
    })),retracted:Type.Optional(Type.Array(Type.String()))}),
    execute:async(_id,args)=>{
      try{
        const absolute=resolve(args.path);
        if(!absolute.endsWith(".md") || !path.relative(ctx.root,absolute).startsWith("exports/")) throw new Error("仅核验 exports/ 下 Markdown 研究报告");
        const result=await reviewClaims({...args,workbooks:ctx.workbooks,store:ctx.store,evidence});
        // Catch verbatim stale quantitative conclusions in sibling reports even
        // when the model forgets to list the retracted phrase explicitly.
        const previous = fs.existsSync(absolute) ? fs.readFileSync(absolute,'utf8') : '';
        const removed = numericLines(previous).map(line=>line.trim()).filter(line=>line.length>=20 && !args.content.includes(line));
        for(const phrase of new Set([...(args.retracted || []), ...removed])) {
          if(!phrase.trim()) continue;
          if(args.content.includes(phrase)) result.errors.push(`新报告仍残留撤回原句：${phrase}`);
          const scan=dir=>{
            if(!fs.existsSync(dir))return;
            for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
              if(entry.isSymbolicLink() || entry.name==='backups')continue;
              const file=path.join(dir,entry.name);
              if(entry.isDirectory())scan(file);
              else if(file!==absolute && file.endsWith('.md')){
                const text=fs.readFileSync(file,'utf8');
                if(text.includes(phrase) && !/^> 已撤回：[^\n]+\n/.test(text)) result.errors.push(`关联报告仍含旧结论：${path.relative(ctx.root,file)}；请先更正或在首行明确标记 > 已撤回：原因及新报告路径`);
              }
            }
          };scan(path.join(ctx.root,'exports'));
        }
        result.ok=result.errors.length===0;
        if(result.ok)approved.set(absolute,{digest:hash(args.content),baseline:baseline(absolute)});
        else approved.delete(absolute);
        return {content:[{type:"text",text:JSON.stringify(result)}],details:result,isError:!result.ok};
      }catch(error){return {content:[{type:"text",text:error.message}],isError:true};}
    }};
  function before(name,args){
    if(!["write","edit"].includes(name) || !args.path)return;
    let absolute;try{absolute=resolve(args.path);}catch(error){return {block:true,reason:error.message};}
    if(!absolute.endsWith('.md') || !path.relative(ctx.root,absolute).startsWith('exports/'))return;
    // A withdrawal marker preserves history without republishing its numbers as current.
    if(name==='write' && /^> 已撤回：[^\n]+\n/.test(args.content || '')) {
      const old=fs.existsSync(absolute)?fs.readFileSync(absolute,'utf8'):null;
      if(old!==null && args.content.slice(args.content.indexOf('\n')+1)===old)return;
    }
    const review=approved.get(absolute);
    if(name==='edit' || !review || review.digest!==hash(String(args.content)) || review.baseline!==baseline(absolute)) return {block:true,reason:"研究报告必须先调用 review_research 核验完整 content，再用 write 原样写入；禁止未经核验的局部 edit。"};
    approved.delete(absolute);
  }
  function record({toolCall,args,result,isError}) {
    if(isError || result?.isError)return;
    if(toolCall.name==='write' && typeof args?.path==='string') {
      const absolute=resolve(args.path);
      if(absolute.endsWith('.md') && path.relative(ctx.root,absolute).startsWith('exports/')) {
        if(!fs.existsSync(absolute) || fs.readFileSync(absolute,'utf8')!==args.content) return {isError:true,content:[{type:'text',text:'写入后全文校验失败；不能宣称更正完成。'}]};
        return {content:[...(result.content || []),{type:'text',text:`[research_write_verified] ${args.path} sha256=${hash(args.content)}`}],structuredContent:result.structuredContent};
      }
    }
    if(!["read","pdf_read","web_fetch","deepseek_fetch","deepseek_search","anysearch_search","westock_query"].includes(toolCall.name))return;
    const text=(result.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n');
    const id=toolCall.id;
    evidence.set(id,text);
    while(evidence.size>100)evidence.delete(evidence.keys().next().value);
    return {content:[...(result.content || []),{type:'text',text:`[research_evidence_id] ${id}`} ], structuredContent:result.structuredContent};
  }
  return {tool,before,record};
}
