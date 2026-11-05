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

// Strip presentation metadata, never a whole arbitrary numeric heading/paragraph.
function claimNumbers(line, files) {
  let text = line.trim().replace(/^>\s*/, '');
  text = /^#{1,6}\s+/.test(text)
    ? text.replace(/^#{1,6}\s+/, '').replace(/^\d+(?:\.\d+)*[.)、]?\s+/, '')
    : text.replace(/^\d+[.)、]\s+/, '');
  text = text.replace(/^\|\s*[A-Z]\d+\s*\|/, '|');
  if (/^(?:证据截止|信息截止|资料截止|报告日期|更新日期)[：:]\s*\d{4}-\d{2}-\d{2}\s*$/.test(text)) return '';
  for (const file of files) text = text.split(file).join('[来源文件]');
  // Only an entire version-label line qualifies, not a financial assertion.
  if (/^(?:模型|来源模型|模型版本|版本)[：:]\s*(?:`?\[来源文件\]`?|[^\d\n]*\bModel\s+\d{8})\s*(?:[（(](?:\.xlsx[，,]\s*)?\d{4}-\d{2}-\d{2}\s*版[）)])?\s*$/.test(text)) return '';
  return text.replace(/\bP[0-3]\b/g, '').replace(/\b(?:LPDDR|DDR|HBM|GDDR)\d+[A-Z0-9]*\b/gi,'');
}
const evidenceLiteral = text => String(text || '').replace(/(?<=\d)\s+(?=\d)/g,'\u0000').replace(/\s+/g,'').replace(/\u0000/g,' ');
const containsLiteral = (text, part) => !!part && evidenceLiteral(text).includes(evidenceLiteral(part));
function removeVerifiedToken(text, token) {
  if (/^-?\d+(?:,\d{3})*(?:\.\d+)?%?$/.test(token)) {
    const escaped=token.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    return text.replace(new RegExp(`(?<![\\d.,+\\-])${escaped}(?![\\d.,%])`,'g'),'');
  }
  return text.split(token).join('');
}
const evidenceText = entry => typeof entry === 'string' ? entry : entry?.text;

function resolveSource(claim, evidence) {
  if (claim.evidenceId || !claim.quote || !claim.locator) return claim;
  // Recover a missing ID only from one exact, already-recorded source. Never
  // guess from a stock name, URL alone, a summary, or an unrelated document.
  const matches = [...evidence].filter(([,entry]) => {
    const text = evidenceText(entry);
    return containsLiteral(text,claim.quote) && text.includes(claim.locator);
  });
  return matches.length === 1 ? {...claim,evidenceId:matches[0][0]} : claim;
}

function excerptText(c, entry) {
  const label=entry?.kind==='search_lead'?'搜索线索（未独立验证）':'来源原文（不等于独立验证）';
  return `${label}：\n${c.quote.split(/\r?\n/).map(line=>'> '+line).join('\n')}\n来源：${c.locator}`;
}

// External quotations, like workbook cells, are bound and rendered by the host.
// The model need not duplicate every field/value in a second hand-written claim.
function expandSourceCitations(args, evidence) {
  const refs=[...new Set([...args.content.matchAll(/\{\{source:([\w-]+)\}\}/g)].map(m=>m[1]))];
  if(!refs.length)return args;
  let content=args.content;
  const claims=[...(args.claims || [])];
  for(const id of refs) {
    const matches=(args.sources || []).filter(s=>s.id===id);
    if(matches.length!==1)throw new Error(`来源引用 ${id} 需要 sources 中唯一的同名条目：id、evidenceId、quote、locator`);
    const c=resolveSource(matches[0],evidence),entry=evidence.get(c.evidenceId),source=evidenceText(entry);
    if(!source)throw new Error(`来源引用 ${id} 的 evidenceId 不在实际工具证据中`);
    if(!c.quote || !source.includes(c.quote) || !c.locator || !source.includes(c.locator))
      throw new Error(`来源引用 ${id} 的 quote/locator 必须逐字复制实际工具原文（保留换行）；实际来源片段：${source.slice(0,1800)}`);
    const text=excerptText(c,entry);
    claims.push({...c,id:`source:${id}`,kind:'excerpt',text});
    content=content.replaceAll(`{{source:${id}}}`,()=>text);
  }
  return {...args,content,claims};
}

// Values and provenance are checked by the host. This does not certify financial truth.
export async function reviewClaims({content, claims = [], workbooks, store, evidence = new Map(), file}) {
  const errors = [], checked = new Map(), sources = [], resolvedEvidence = [], sourceRepairs = [], coverageRepairs = [];
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
    } else if (c.kind === "excerpt") {
      const entry=evidence.get(c.evidenceId),source=evidenceText(entry);
      if(!source || !c.quote || !source.includes(c.quote) || !c.locator || !source.includes(c.locator) || c.text!==excerptText(c,entry))
        reject("来源摘录必须由实际证据原文生成，不能更改数值或省略来源标识");
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
          c = {...c, sourceFormula:cell.formula, thresholdEvidence: thresholdWords.test(cell.rowLabel || '')};
          if (cell.amount && !["亿元","百万元"].includes(c.unit)) reject("金额单位与原表不符：百万元；可换算为亿元");
          const label=cell.rowLabel || "";
          const unit=label.match(/\(([^()]*(?:US\$|Rmb|Gb|GB|kwpm)[^()]*)\)/)?.[1];
          if (unit && unitKey(c.unit) !== unitKey(unit)) reject(`单位与原表不符：${unit}`);
          if (cell.ratioEvidence && (c.numeratorRef !== cell.ratioEvidence.numerator?.ref || c.denominatorRef !== cell.ratioEvidence.denominator?.ref)) reject("比例必须列出真实分子和分母引用");
        }
      }
    } else if (c.kind === "source") {
      c = resolveSource(c,evidence);
      const entry=evidence.get(c.evidenceId);
      const source=evidenceText(entry);
      const repairSource = () => {
        if (!source) return;
        const at = Math.max(0,source.indexOf(c.quote));
        sourceRepairs.push({id:c.id,evidenceId:c.evidenceId,sourceExcerpt:source.slice(Math.max(0,at-500),at+1500),
          instruction:"这是实际来源原文。quote/contextQuote及entity、period、metric使用此处措辞，不扩写期间，不翻译字段。"});
      };
      if (!source) {
        reject(c.evidenceId ? `evidenceId=${c.evidenceId} 不在已读取的证据中；使用工具返回的 [research_evidence_id]` : '缺少 evidenceId，且无法按 quote + locator 唯一关联来源；填写工具返回的 [research_evidence_id]');
        continue;
      }
      if (c.evidenceId !== original.evidenceId) resolvedEvidence.push({id:c.id,evidenceId:c.evidenceId});
      if (entry?.kind==="search_lead" && /证实|官方确认|权威|已验证|业内共识/.test(c.text)) reject("搜索摘要只能作为线索，需读取原始来源后再判断证据强度");
      if (!c.quote || !containsLiteral(source,c.quote)) reject("quote 必须逐字复制工具原文，不能改写或把表格重组为句子；可复制完整表头和数据行");
      if (!c.locator || !source.includes(c.locator)) reject("locator 必须是该工具结果中真实出现的来源地址或文件定位");
      if (!c.period || !c.unit || !c.entity || !c.metric) reject("来源事实必须声明主体、指标、单位和期间");
      const display = displayedValue(c);
      if (!display) reject('valueText 必须是正文中的纯数值，如 "8.66" 或 "70%"，不要填写整句话');
      else if (typeof c.value !== 'number' || Math.abs(display.value-c.value)>display.tolerance || !containsLiteral(c.quote,c.valueText)) reject('value 必须与 valueText 一致（如 "70%" 对应 0.7），且 valueText 须原样出现在 quote');
      // Headlines/table headers can establish the subject and period of an
      // adjacent quote. The bounded context must itself be verbatim evidence.
      const context = c.contextQuote || c.quote || '';
      const validContext = context.length <= 2000 && containsLiteral(source,context) && containsLiteral(context,c.quote);
      if (c.contextQuote && !validContext) reject('contextQuote 须逐字复制同一来源、包含 quote，且不超过2000字符');
      for (const field of ['period','entity','metric']) {
        if (!validContext || !containsLiteral(context,c[field])) reject(`quote 或 contextQuote 须包含 ${field} 的原文措辞；可连同标题、日期和表头一起引用，不要翻译或改写字段`);
      }
      if (c.unit && c.unit !== 'ratio' && (!unitKey(c.quote).includes(unitKey(c.unit)) || !unitKey(c.text).includes(unitKey(c.unit)))) reject("原文和正文单位不符");
      if (!valid) repairSource();
      c = {...c, thresholdEvidence: entry?.kind !== "search_lead" && thresholdWords.test(c.quote || '')};
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
    const covering = [...checked.values()].filter(c=>c.text.includes(line.trim()) || line.includes(c.text) ||
      (c.kind==='excerpt' && content.split(/\n\s*\n/).some(block=>block.includes(c.text) && block.split(/\r?\n/).includes(line))));
    if (covering.some(c=>c.kind==='unknown')) continue;
    const files = [...new Set([file,...sources.map(c=>c.file)].filter(f=>f && store.findMaterialByPath(f)))];
    let remaining = claimNumbers(line,files);
    if(covering.some(c=>c.kind==='excerpt' && c.text.split(/\r?\n/).includes(line))) continue;
    // File names and already-verified periods are metadata, not fresh numeric claims.
    if (/Gb\s*(?:→|->)\s*GB/.test(remaining))
      remaining=remaining.replace(/(?:除以|÷)\s*8(?!\d)/g,"");
    if (/GB\s*(?:→|->)\s*Gb/.test(remaining))
      remaining=remaining.replace(/(?:乘以|×)\s*8(?!\d)/g,"");
    const metadata = [...checked.values()].flatMap(c=>[...(c.kind==='excerpt'?[...c.quote.matchAll(/(?:19|20)\d{2}(?=年|[-/])/g)].map(m=>m[0]):[]),c.file,c.period,c.period?.match(/^(?:19|20)\d{2}/)?.[0],c.ref,c.sourceFormula]).filter(x=>typeof x==='string' && x);
    for(const token of metadata.sort((a,b)=>b.length-a.length)) remaining=removeVerifiedToken(remaining,token);
    const tokens = covering.flatMap(c=>[...(c.kind==='excerpt'?[c.quote,...c.quote.split(/\r?\n/),...(c.quote.match(/-?\d+(?:,\d{3})*(?:\.\d+)?%?/g) || [])]:[]),c.valueText,c.period,c.ref,c.file,c.locator,c.entity,c.product,c.metric,c.unit]).filter(x=>typeof x==='string' && x);
    for (const token of tokens.sort((a,b)=>b.length-a.length)) remaining=removeVerifiedToken(remaining,token);
    if(/\d/.test(remaining)) {
      errors.push(`含数字的行缺少对应数值或引用核验：${line.slice(0,180)}`);
      const candidates=[...checked.values()].filter(c=>(c.kind==='source' && line.includes(c.valueText)) || (c.kind==='excerpt' && (c.quote.match(/\d+(?:\.\d+)?%?/g) || []).some(n=>line.includes(n))));
      if(candidates.length) coverageRepairs.push({text:line,sourceClaimIds:candidates.map(c=>c.id),
        instruction:"若本行确实复述同一主体、指标和期间的来源事实，可以在本段重复相应 {{source:条目id}} 来绑定来源；或改写为“该比例/上述期间”避免重复数字。旧source claim接口可复制对应source claim，使用新id，并把text改为本行；不要修改其他字段。若不是同一事实，须另查依据。也可改用不重复数字的描述。"});
    }
  }
  const result = {ok:errors.length===0,errors,checked:[...checked.keys()],resolvedEvidence};
  if (errors.length) {
    result.sourceCells = sources;
    result.sourceRepairs = sourceRepairs;
    result.coverageRepairs = coverageRepairs;
    result.nextStep = [
      "按 errors 修正对应 claim 和正文，不要删除全部引用重写。text 必须逐字复制当前正文；valueText 只填纯数字或百分数，70% 的 value=0.7。",
      "外部资料优先改用 {{source:s1}} + sources（id、evidenceId、原文quote、locator），由宿主插入摘录，不再重复填claims。使用旧claims时保留工具返回的 evidenceId、原文 quote、真实 locator；quote 不含标题/期间时用 contextQuote 复制含这些信息的连续原文。无法取得可靠来源则删除确定性断言，明确待核实及缺口。",
      "原表数字使用 file + {{Sheet!A1}}；save=true 通过后自动保存，无需再调用 write。"
    ].join("\n");
  }
  return result;
}

// Resolve inline citations from the same workbook that query/trace use. The
// author supplies prose and references once; the host supplies the evidence.
async function expandCellCitations(args, ctx) {
  const refs = [...new Set(Array.from(args.content.matchAll(/\{\{([^{}\n]+![^{}\n]+)\}\}/g), m => m[1]))];
  if (!refs.length) return args;
  const material = args.file && ctx.store.findMaterialByPath(args.file);
  if (!material) throw new Error("使用原表引用时需提供本项目内的 file");
  let content = args.content;
  const claims = [...(args.claims || [])];
  for (const ref of refs) {
    if (!/^.+!\$?[A-Z]{1,3}\$?[1-9]\d*$/i.test(ref)) throw new Error(`无效单元格引用：${ref}`);
    const result = await ctx.workbooks.queryMaterial(material.id, ref, {maxCells:1});
    const cell = result.cells?.[0];
    if (result.error || !Number.isFinite(cell?.value) || result.seeds?.[0] !== cell.ref) {
      throw new Error(`引用缺少可核验的数值：${ref}`);
    }
    const ratio = cell.ratioEvidence;
    const period = cell.period === undefined ? cell.columnLabel : cell.period;
    const sourceUnit = cell.rowLabel?.match(/\(([^()]*(?:US\$|Rmb|Gb|GB|kwpm)[^()]*)\)/)?.[1];
    const isRatio=/^(?:GM|mix|.*margin|.*ratio|YoY|QoQ)$/i.test(cell.metricContext?.label || cell.rowLabel || "");
    const unit = sourceUnit || cell.amount?.unit || (isRatio ? "ratio" : "原表缓存值");
    const value = unit === "ratio" ? cell.value*100 : cell.value;
    const valueText = Number(value.toFixed(4)).toString()+(unit === "ratio"?"%":"");
    const metric = [cell.metricContext?.label,cell.rowLabel].filter((x,i,a)=>x && a.indexOf(x)===i).join(" / ") || "指标含义待核实";
    const text = [period, metric, valueText, unit === "ratio" ? "" : unit, `（${cell.ref}）`].filter(Boolean).join(" ");
    claims.push({id:`cell:${cell.ref}`,kind:"cell",file:args.file,ref:cell.ref,period,metric,
      text,value:cell.value,valueText,unit,numeratorRef:ratio?.numerator?.ref,denominatorRef:ratio?.denominator?.ref});
    content = content.replaceAll(`{{${ref}}}`, () => text);
  }
  return {...args, content, claims, resolvedCells: claims.slice((args.claims || []).length)};
}

export function createResearchReview({ctx, authorizeWrite = () => undefined}) {
  const evidence=new Map(),approved=new Map(),lastFailure=new Map(),readBaselines=new Map(),workbookPaths=new Set(),workbookEvidence=new Map();
  let auditor=null;
  const resolve = relative => {
    const absolute=path.resolve(ctx.root,relative || "");
    let existing=absolute;
    while(!fs.existsSync(existing) && path.dirname(existing)!==existing) existing=path.dirname(existing);
    if(!absolute.startsWith(path.resolve(ctx.root)+path.sep) || !insideProjectRealRoot(ctx.root,existing)) throw new Error("路径必须在当前项目内");
    return absolute;
  };
  const baseline = absolute => fs.existsSync(absolute) ? hash(fs.readFileSync(absolute)) : null;
  const tool={name:"review_research",label:"核验研究报告",
    reachesTools: args => args.save ? ["write"] : [],
    description: [
      "核验并保存研究报告。写新报告时提供 path、content、save=true；只有引用Excel时才提供 file（外部网页报告省略file）；在 content 中用 {{Sheet!A1}} 代替手抄的每个模型数字。宿主会填入实际期间、原表行标签、数值、单位或缓存值、来源地址，并通过受控 write 工具保存。无需再调用 write。",
      "例如 content=目标估值采用折现目标市盈率法。折现后的模型目标价为 {{Valuation!D9}}。把分析写在引用旁，避免在其他位置重复抄数字。每个引用只填写单个单元格。",
      '外部资料优先使用 {{source:s1}}，并传 sources:[{id:"s1",evidenceId:"工具返回的ID",quote:"逐字复制含主体/期间的原文（保留换行）",locator:"工具结果中的URL"}]。宿主核对来源并插入原文和来源标识，不需要再写claims或手抄数字。分析用“该比例/上述期间”等引用，重复数字时可重复使用同一占位符。原文只证明来源如此披露，结论仍需独立审校。',
      "需要结构化数值比较时才使用原接口：外部数字用 source claim 提供本轮 evidenceId、原文 quote、locator、entity、metric、period、unit、value 和 valueText；text 逐字复制报告相应段落。没有可靠来源时说明缺口。非数字的解释可直接写正文。",
      'source 示例：{id:"s1",kind:"source",text:"甲公司2026年营业利润率70%（来源披露）",evidenceId:"工具返回的ID",quote:"甲公司2026年营业利润率70%",locator:"工具原文中的URL",entity:"甲公司",metric:"营业利润率",period:"2026年",unit:"ratio",value:0.7,valueText:"70%"}。valueText 只能是数字或百分数，不能是句子。quote 须逐字复制原文；主体/期间在标题或表头时，可用 contextQuote 提供包含 quote 的连续原文（最多2000字符），字段使用原文语言。',
      "也支持原接口：提供完整 content 和 claims（cell/source/comparison/threshold/unknown）仅核验，核验通过后用 write 原样保存。撤回错误原句时提供 retracted。"
    ].join("\n"),
    parameters:Type.Object({path:Type.String(),content:Type.String(),
      sources:Type.Optional(Type.Array(Type.Object({id:Type.String({pattern:"^[A-Za-z0-9_-]+$"}),evidenceId:Type.String(),quote:Type.String({maxLength:4000,description:"逐字复制实际工具原文，保留换行，最好包含标题主体和期间"}),locator:Type.String()}))),file:Type.Optional(Type.String({description:"来源Excel路径，例如 uploads/model.xlsx；不是报告文件名"})),save:Type.Optional(Type.Boolean()),allowPartial:Type.Optional(Type.Boolean({description:"只有已明确决定交付部分核验记录时才启用，默认false，不替代完整报告修正"})),claims:Type.Optional(Type.Array(Type.Union([
      Type.Object({
        id:Type.String(),kind:Type.Literal("source"),
        text:Type.String({description:"逐字复制报告正文的事实片段，不要改写"}),
        evidenceId:Type.String({description:"实际工具返回的 [research_evidence_id]"}),
        quote:Type.String({description:"逐字复制来源原文，不要改写或拼接"}),
        contextQuote:Type.Optional(Type.String({maxLength:2000,description:"包含quote及标题/日期/表头的连续原文，用于确认主体、指标和期间"})),
        locator:Type.String(),entity:Type.String({description:"来源原文的主体措辞"}),metric:Type.String({description:"来源原文的指标措辞"}),
        period:Type.String({description:"来源原文中的期间，如2026年，不扩写成2026年全年实际"}),unit:Type.String(),
        value:Type.Number({description:"与显示数值一致，70% 对应0.7"}),
        valueText:Type.String({pattern:"^-?[0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?%?$",description:"正文中的纯数字或百分数，如8.66或70%，不能是句子"}),
        product:Type.Optional(Type.String()),valueType:Type.Optional(Type.String())
      }),
      Type.Object({
        id:Type.String(),kind:Type.Union(['cell','threshold','comparison','unknown'].map(v=>Type.Literal(v))),
        text:Type.String({description:'逐字复制正文的数字所在行或片段。unknown 必须含待核实/无法推导/不可直接比较等措辞。'}),
        ...Object.fromEntries(['file','ref','valueText','unit','period','entity','product','metric','valueType','numeratorRef','denominatorRef','basisId','rationale','leftId','rightId'].map(key=>[key,Type.Optional(Type.String())])),
        value:Type.Optional(Type.Number())
      })
    ]))),retracted:Type.Optional(Type.Array(Type.String()))}),
    execute:async(_id,args,_signal,_update,toolContext)=>{
      try{
        const absolute=resolve(args.path);
        if(!args.file && workbookPaths.size===1) args={...args,file:[...workbookPaths][0]};
        if(args.file && !ctx.store.findMaterialByPath(args.file)) throw new Error("file 仅用于已上传的来源 Excel，不是报告文件名或网页URL。只引用外部来源时请省略 file，使用 source claims。当前读取过的工作簿："+[...workbookPaths].join("、"));
        if(!absolute.endsWith(".md") || !path.relative(ctx.root,absolute).startsWith("exports/")) throw new Error("仅核验 exports/ 下 Markdown 研究报告");
        const originalDigest = baseline(absolute);
        args = expandSourceCitations(args,evidence);
        args = await expandCellCitations(args,ctx);
        let result=await reviewClaims({...args,workbooks:ctx.workbooks,store:ctx.store,evidence});
        let partial = false;
        // A new report may publish its verified portion after a failed repair.
        // Never replace an existing report or skip a requested correction.
        if (!result.ok && args.allowPartial && args.save && originalDigest === null && !args.retracted?.length &&
            lastFailure.has(absolute) && args.resolvedCells?.length) {
          const facts = args.resolvedCells.filter(c => result.checked.includes(c.id));
          if (facts.length) {
            const content = ["# 模型核验记录（部分完成）", "",
              "以下数据已按引用读取并核对。草稿中的其余数字和分析判断仍待核验。", "",
              ...facts.map(c => "- " + c.text)].join("\n");
            const checked = await reviewClaims({content, claims:facts,workbooks:ctx.workbooks,store:ctx.store,evidence});
            if (checked.ok) {
              args = {...args,content,claims:facts};
              result = checked;
              partial = true;
            }
          }
        }
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
        const related=[];
        const scanRelated=dir=>{
          if(!fs.existsSync(dir))return;
          for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
            if(entry.isSymbolicLink() || entry.name==="backups")continue;
            const file=path.join(dir,entry.name);
            if(entry.isDirectory())scanRelated(file);
            else if(file.endsWith(".md")) related.push({path:path.relative(ctx.root,file),
              sha256:baseline(file),content:fs.readFileSync(file,"utf8")});
          }
        };
        scanRelated(path.join(ctx.root,"exports"));
        if(result.ok && auditor && !partial) {
          const verdict=await auditor(args.content,{targetPath:args.path,retracted:args.retracted || [],
            relatedReports:related,mode:"report"});
          const findings=(verdict.issues || []).filter(i=>i.check!=="audit");
          if(!verdict.ok && findings.length)result.errors.push(...findings.map(i=>i.reason));
          if(!findings.length && (verdict.status==="unavailable" || (verdict.issues || []).some(i=>i.check==="audit"))) {
            // Numeric/provenance checks have already passed. An auditor outage
            // does not imply the report is false; save with an honest status.
            const note="> 补充复核暂未完成。以下按来源披露、模型假设和分析判断区分陈述，不代表全部结论已获独立验证。\n\n";
            if(!args.content.startsWith(note))args={...args,content:note+args.content};
            result.reviewStatus="unavailable";
          }
          result.ok=result.errors.length===0;
        }
        if(result.ok) {
          approved.set(absolute,{digest:hash(args.content),baseline:originalDigest,
            related:related.map(item=>({path:item.path,sha256:item.sha256}))});
          lastFailure.delete(absolute);
        } else {
          approved.delete(absolute);
          lastFailure.set(absolute,true);
        }
        if(result.ok && args.save) {
          if (!toolContext?.executeTool) throw new Error("缺少写入工具上下文");
          const write = {path:args.path,content:args.content};
          // The installed SDK routes nested calls through its own extension
          // hooks, not the agent.beforeToolCall/afterToolCall overrides.
          const denial = authorizeWrite(write) ?? before("write",write);
          if (denial?.block) throw new Error(denial.reason);
          const saved = await toolContext.executeTool("write",write);
          if (saved.isError || saved.result?.isError) return {...saved.result,isError:true};
          const verified = record({toolCall:{name:"write"},args:write,result:saved.result});
          if (verified?.isError) return verified;
          if (partial) return {...saved.result,...verified,content:[...verified.content,{type:"text",
            text:`[research_partial_delivery] 已保存部分核验记录 ${args.path}。原表数据已核对，草稿中的其余数字和研究判断仍待核验。\n${args.claims.slice(0,4).map(c=>"- "+c.text).join("\n")}`}]};
          return {...saved.result,...verified,isError:false};
        }
        // Keep every field-level error visible. Cutting at eight errors hid
        // later claims and numeric false positives, causing repeated blind edits.
        const response=result.ok?result:{...result,errorCount:result.errors.length};
        return {content:[{type:"text",text:JSON.stringify(response)}],details:response,isError:!result.ok};
      }catch(error){return {content:[{type:"text",text:error.message}],isError:true};}
    }};
  function before(name,args){
    if(!["write","edit"].includes(name) || !args.path)return;
    let absolute;try{absolute=resolve(args.path);}catch(error){return {block:true,reason:error.message};}
    if(!absolute.endsWith('.md') || !path.relative(ctx.root,absolute).startsWith('exports/')) {
      if(name==="edit" && (!readBaselines.has(absolute) || readBaselines.get(absolute)!==baseline(absolute)))
        return {block:true,reason:"编辑前须读取当前文件；失败后重新读取，再基于实际内容生成补丁。"};
      return;
    }
    // A withdrawal marker preserves history without republishing its numbers as current.
    if(name==='write' && /^> 已撤回：[^\n]+\n/.test(args.content || '')) {
      const old=fs.existsSync(absolute)?fs.readFileSync(absolute,'utf8'):null;
      if(old!==null && args.content.slice(args.content.indexOf('\n')+1)===old)return;
    }
    const review=approved.get(absolute);
    if(name==='edit' || !review || review.digest!==hash(String(args.content)) || review.baseline!==baseline(absolute) || review.related?.some(item=>baseline(resolve(item.path))!==item.sha256)) return {block:true,reason:"研究报告须调用 review_research，传 path、完整 content、来源 file（如有）、claims 和 save=true，通过后自动保存，无需重复 write。禁止未经核验的局部 edit。"};
    approved.delete(absolute);
  }
  function rememberEvidence(toolCall, result) {
    if (!["read","pdf_read","web_fetch","deepseek_fetch","deepseek_search","anysearch_search","westock_query"].includes(toolCall.name)) return;
    const text=(result.content || []).filter(c=>c.type==='text').map(c=>c.text).join('\n')
      .replace(/\n?\[research_evidence_id\] [^\n]+/g,'');
    evidence.set(toolCall.id,{text,kind:/search/.test(toolCall.name)?"search_lead":
      /fetch/.test(toolCall.name)?"fetched_document":toolCall.name==="westock_query"?"market_quote":"local_document"});
    while(evidence.size>100)evidence.delete(evidence.keys().next().value);
    return true;
  }
  function restoreEvidence(messages) {
    const calls = new Map();
    for (const message of messages) {
      if (message.role==='assistant') for (const part of message.content || []) {
        if (part.type==='toolCall') calls.set(part.id,part);
      }
      const call = calls.get(message.toolCallId);
      if (message.role==='toolResult' && call && !message.isError) {
        if(['workbook_query','workbook_trace'].includes(call.name)) record({toolCall:call,args:call.arguments,result:message});
        else rememberEvidence(call,message);
      }
    }
  }
  function record({toolCall,args,result,isError}) {
    if(["workbook_query","workbook_trace"].includes(toolCall.name) && args?.path && !isError && !result?.isError) {
      workbookPaths.add(args.path);
      const details=result.details || {};
      const cells=[...(details.researchEvidence || details.cells || (details.target?[details.target]:[]))];
      const flatten=node=>{
        if(!node)return;
        const {children,...cell}=node;
        if(cell.ref)cells.push(cell);
        for(const child of children || [])flatten(child);
      };
      flatten(details.tree);
      for(const cell of cells) if(cell?.ref)workbookEvidence.set(args.path+"!"+cell.ref,{...cell,file:args.path});
      while(workbookEvidence.size>500)workbookEvidence.delete(workbookEvidence.keys().next().value);
    }
    if(isError || result?.isError) {
      if(toolCall.name==="edit" && args?.path)readBaselines.delete(resolve(args.path));
      return;
    }
    if(toolCall.name==="read" && args?.path) {
      const absolute=resolve(args.path);
      if(fs.existsSync(absolute) && fs.statSync(absolute).isFile())readBaselines.set(absolute,baseline(absolute));
    }
    if(toolCall.name==='write' && typeof args?.path==='string') {
      const absolute=resolve(args.path);
      if(absolute.endsWith('.md') && path.relative(ctx.root,absolute).startsWith('exports/')) {
        if(!fs.existsSync(absolute) || fs.readFileSync(absolute,'utf8')!==args.content) return {isError:true,content:[{type:'text',text:'写入后全文校验失败；不能宣称更正完成。'}]};
        return {content:[...(result.content || []),{type:'text',text:`[research_write_verified] ${args.path} sha256=${hash(args.content)}`}],structuredContent:result.structuredContent};
      }
    }
    if (!rememberEvidence(toolCall,result)) return;
    const id=toolCall.id;
    return {content:[...(result.content || []),{type:'text',text:`[research_evidence_id] ${id}`} ], structuredContent:result.structuredContent};
  }
  return {tool,before,record,restoreEvidence,evidenceSnapshot:()=>[...workbookEvidence.values()],setAuditor:fn=>{auditor=fn;},startRun:()=>{lastFailure.clear();approved.clear();readBaselines.clear();}};
}
