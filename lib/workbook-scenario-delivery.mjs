import { currentCitation } from './citations.mjs';

// Compare with the result at the precision actually printed in the answer.
export function missingScenarioResult(text,values) {
  const numbers=[...text.replaceAll(',','').matchAll(/(?<![\w.!])[+-]?\d+\.\d+(?![\w.%])/g)].map(m=>m[0]);
  return values.some(value=>!numbers.some(n=>Number(n)===Number(value.toFixed(Math.min(12,n.split('.')[1].length)))));
}

// Build the fallback directly from the executed scenario and the source workbook.
// A scenario belongs to one file version. Mixed inputs are a joint shock.
export function workbookScenarioDelivery(calls, citations, versions,{overview=false}={}) {
  const recalculatedRows=new Set(), callIds=new Set(), results=new Set();
  const rows = new Set(), references = new Map(), outputs = new Map(), shocks = new Map();
  for (const call of calls) {
    const d = call.result?.details || call.details;
    if (call.name !== 'model_whatif' || !call.success || call.result?.isError ||
        d?.recalculated !== true || !/^[a-f0-9]{64}$/i.test(d.sourceSha256 || '') ||
        !Array.isArray(d.baselineChanged) || typeof d.path !== 'string' || d.path !== call.args?.path ||
        !Array.isArray(d.inputs) || !d.inputs.length || !Array.isArray(call.args.inputs) ||
        d.inputs.length !== call.args.inputs.length || !Array.isArray(call.args.targets)) continue;
    // Both copies were recalculated independently by model_whatif. A changed
    // cache cannot certify either scenario on its own. Bind the original read
    // to cached, and compare after only with the same receipt's before.
    if(!Array.isArray(d.results) || !d.results.length ||
       d.baselineChanged.some(cell=>!d.results.some(r=>r.cell===cell)) ||
       d.results.some(r=>!Number.isFinite(r.before) || !Number.isFinite(r.after) ||
         !Number.isFinite(d.cached?.[r.cell]) || d.baselineChanged.includes(r.cell)!==(d.cached[r.cell]!==r.before)))continue;
    const pool = citations.filter(c => !c.derivedFrom && c.sha256 === d.sourceSha256 &&
      c.storedFilename === d.path.split('/').at(-1) && currentCitation(c, versions));
    const source = cell => {
      const matches = pool.filter(c => c.locator === cell);
      return matches.length && matches.every(c => c.id === matches[0].id && c.value === matches[0].value) ? matches[0] : null;
    };
    const inputs = d.inputs.map(({cell, value}, i) => {
      const c = source(cell), arg = call.args.inputs[i];
      if (!arg || !c || !Number.isFinite(c.value) || !Number.isFinite(value) || arg.cell !== cell || arg.value !== value) return null;
      return {c, value};
    });
    if (inputs.some(i => !i)) continue;
    const priceOutputs=overview && d.baselineChanged.length?d.results.filter(r=>
      /(?:value per share|target price|每股价值|目标股价|目标价)(?:\b|[\s（(]|$)/i.test(source(r.cell)?.metric || '')):[];
    for (const r of priceOutputs.length?priceOutputs:d.results) {
      const target = source(r.cell);
      if (!target || !call.args.targets.includes(r.cell) || !Number.isFinite(r.after) ||
          !Number.isFinite(r.before) || d.cached[r.cell] !== target.value ||
          inputs.some(({c}) => c.materialId !== target.materialId || c.version !== target.version)) continue;
      const ref = c => '[' + (c.filename || c.storedFilename) + ']' + c.locator;
      const show = (c, v) => c.raw_unit === 'decimal' && c.display_unit === '%' ? Number((100*v).toPrecision(12))+'%' : String(v);
      const metric=c=>{
        if(!/^(total|合计)$/i.test(c.metric))return c.metric;
        const fields=(c.excerpt || '').split('|').map(x=>x.trim()).filter(Boolean);
        const check=fields.findLastIndex(x=>/^check$/i.test(x));
        const header=fields[check+1];
        return check>0 && fields.at(-2)===c.metric && fields.slice(check+2,-2).length>=2 &&
          /(?:expenses?|costs?|revenues?|费用|成本|收入)$/i.test(header) ? header+' '+c.metric : c.metric;
      };
      const label = c => c.metric ? ((c.period && /^(?:19|20)\d{2}[ae]?$/i.test(c.period)?c.period+' ':'')+metric(c)) + ' ' : '';
      const inputText = inputs.map(({c,value}) => label(c)+ref(c)+' '+show(c,c.value)+' → '+show(c,value)).join('，同时调整 ');
      const unit = target.raw_unit && target.raw_unit !== 'unit_unknown' && target.raw_unit !== 'decimal' ? ' '+target.raw_unit : '';
      const line = '- ' + inputText + '。' + label(target)+ref(target)+' '+show(target,r.before)+' → '+show(target,r.after)+unit+'。';
      if(d.baselineChanged.length) {
        const format=v=>String(Number(v.toPrecision(6)));
        const change=r.before>0?format(100*(r.after/r.before-1))+'%':'—';
        const input=inputs.map(({c,value})=>label(c)+ref(c)+' '+show(c,c.value)+' → '+show(c,value)).join('，');
        results.add(r.after);
        recalculatedRows.add('| '+[input,label(target)+ref(target)+unit,format(target.value),format(r.before),format(r.after),change]
          .map(s=>String(s).replaceAll('|','\\|').replace(/[\r\n]+/g,' ')).join(' | ')+' |');
      } else rows.add(line);
      if(call.id)callIds.add(call.id);
      outputs.set(target.id,target);
      if (!shocks.has(target.id)) shocks.set(target.id,new Set());
      if(inputs.length===1 && r.after!==r.before)shocks.get(target.id).add(inputs[0].c.locator);
      for (const c of [target,...inputs.map(i=>i.c)]) references.set(c.id,c);
    }
  }
  if (!rows.size && !recalculatedRows.size) return {text:'',citations:[]};
  const bridges = new Set(), weights = new Set(), drivers = new Set();
  for (const target of outputs.values()) {
    const cells = new Map();
    for (const call of calls) {
      const snapshot = call.result?.details || call.details;
      if (!call.success || call.result?.isError || !['workbook_trace','workbook_query'].includes(call.name) ||
          snapshot?.sha256 !== target.sha256 || snapshot.materialId !== target.materialId ||
          snapshot.version !== target.version) continue;
      for (const cell of snapshot.cells || []) if (['cached','input'].includes(cell.cacheStatus)) cells.set(cell.ref,cell);
    }
    const cite = new Map(citations.filter(c=>!c.derivedFrom && c.sha256===target.sha256 &&
      c.materialId===target.materialId && c.version===target.version).map(c=>[c.locator,c]));
    const describe = c => (c.metric || c.locator)+' '+Number(c.value.toPrecision(7))+
      (c.raw_unit && c.raw_unit!=='unit_unknown' ? ' '+c.raw_unit : '')+' ['+(c.filename || c.storedFilename)+']'+c.locator;
    const root=cells.get(target.locator);
    for (const cell of [root,...(root?.upstreamRefs || []).map(ref=>cells.get(ref))]) {
      if (!cell?.formula || !cell.upstreamRefs?.length || cell.upstreamRefs.length>6 ||
          cell.upstreamCount!==cell.upstreamRefs.length || cell.formula.length>120 || /[\r\n`]/.test(cell.formula)) continue;
      const members=[cell.ref,...cell.upstreamRefs].map(ref=>cite.get(ref));
      if (members.some(c=>!c || !Number.isFinite(c.value) || cells.get(c.locator)?.value!==c.value)) continue;
      members.forEach(c=>references.set(c.id,c));
      bridges.add('- '+describe(members[0])+'。原表公式 `'+cell.formula+'`，引用 '+members.slice(1).map(describe).join('、')+'。');
    }
    // Only explain multipliers on an observed formula path to this exact output.
    // AVERAGE(A1:A1) is also a single operand; a multi-cell average is not.
    const reachable=new Set(), pending=[target.locator];
    while(pending.length) {
      const ref=pending.pop();
      if(reachable.has(ref))continue;
      reachable.add(ref);
      const node=cells.get(ref);
      if(node?.formula)pending.push(...(node.upstreamRefs || []));
    }
    const examples=new Map();
    for(const [ref,node] of cells) {
      if(!node?.formula || node.upstreamCount!==2)continue;
      const expr=node.formula.replace(/[$\s]/g,'').toUpperCase().replace(/^=\+?/,'')
        .replace(/AVERAGE\(([A-Z]+\d+)(?::\1)?\)/g,'$1');
      const product=/^([A-Z]+\d+)\*([A-Z]+\d+)$/.exec(expr);
      if(!product)continue;
      const refs=product.slice(1).map(coord=>node.sheet+'!'+coord);
      const idx=refs.findIndex(r=>shocks.get(target.id)?.has(r));
      if(idx<0 || !refs.every(r=>node.upstreamRefs.includes(r)))continue;
      const [base,multiple,result]=[refs[1-idx],refs[idx],ref].map(r=>cite.get(r));
      if([base,multiple,result].some(c=>!c || !Number.isFinite(c.value) || c.value<=0 ||
          (cells.has(c.locator) && c.value!==cells.get(c.locator).value)))continue;
      if(Math.abs(base.value*multiple.value-result.value)>1e-8*Math.max(1,Math.abs(result.value)))continue;
      const field=cells.get(base.locator)?.sectionPath?.at(-1)?.trim() || '';
      const basis={PAT:'税后利润',EBIT:'息税前利润',EBITDA:'息税折旧摊销前利润',EPS:'每股收益',Revenue:'收入'}[field];
      const source=c=>'['+(c.filename || c.storedFilename)+']'+c.locator;
      const valuation=/valuat|估值/i.test(node.sectionPath?.at(-1) || '');
      if(!reachable.has(ref) && !valuation)continue;
      // A workbook-wide conversion factor can appear in dozens of rows. Show
      // a representative direct formula per shocked input, favouring its own
      // business line and the source's labelled valuation or earnings field.
      const sameRow=node.row===cells.get(multiple.locator)?.row;
      const score=Number(sameRow)*4+Number(valuation)*2+Number(Boolean(basis));
      if(!score || (examples.get(multiple.id)?.score ?? -1)>=score)continue;
      const name=node.rowLabel || result.metric || ref;
      const explanation='- '+name+'：'+(base.period || '')+(basis || '基数')+' '+Number(base.value.toPrecision(7))+' '+source(base)+' × 系数 '+multiple.value+' '+source(multiple)+' ≈ '+describe(result)+'。';
      examples.set(multiple.id,{score,explanation,refs:[base,multiple,result]});
    }
    for(const example of examples.values()) {
      drivers.add(example.explanation);
      for(const c of example.refs)references.set(c.id,c);
    }
    // A ratio needs an observed numerator and denominator on this formula path.
    // Keep overlapping subtotals separate; summing them could double count.
    const denominators=new Set([target.locator,...(root?.upstreamRefs || [])]);
    for (const call of calls) {
      if (call.name!=='calc' || !call.success || call.result?.isError) continue;
      for (const r of (call.result?.details || call.details)?.results || []) {
        const division=/^\s*([a-z_][a-z_0-9]*)\s*\/\s*([a-z_][a-z_0-9]*)\s*$/i.exec(r.expression || '');
        if (!division || r.unit!=='%' || r.ratioEncoding!=='percentage_points' || r.error) continue;
        const operands=division.slice(1).map(name=>r.bindings?.[name]);
        if (operands.some(b=>!b || b.materialId!==target.materialId || b.sha256!==target.sha256 ||
            b.version!==target.version || cite.get(b.locator)?.value!==b.value || !Number.isFinite(b.value))) continue;
        const [n,den]=operands.map(b=>cite.get(b.locator));
        if (!denominators.has(den.locator) || !den.value || !n.raw_unit || n.raw_unit==='unit_unknown' ||
            n.raw_unit!==den.raw_unit || n.currency!==den.currency || n.period!==den.period) continue;
        const percent=100*n.value/den.value;
        if (!Number.isFinite(Number(r.value)) || Math.abs(Number(r.value)-percent)>1e-7) continue;
        references.set(n.id,n); references.set(den.id,den);
        weights.add('- '+describe(n)+' ÷ '+describe(den)+' = '+Number(percent.toFixed(2))+'%。');
      }
    }
  }
  const sections=[];
  if (drivers.size) sections.push('**输入怎样影响模型结果**\n\n'+[...drivers].join('\n')+'\n\n每行列示一条原表乘法。系数不变时，基数变化 1%，该项价值同向变化 1%。这是该公式的局部变化。最终输出还取决于后续公式，见下列重算。');
  if (bridges.size) sections.push('**基准值的公式与构成**\n\n'+[...bridges].join('\n'));
  if (weights.size) sections.push('**按同一分母核对的权重**\n\n'+[...weights].join('\n'));
  if(rows.size)sections.push('**已用原模型重算的情景**\n\n'+[...rows].join('\n')+
    (rows.size>1 ? '\n\n各行使用各自标明的输入变动。比较驱动强弱时，还需统一冲击幅度和单位。' : ''));
  if(recalculatedRows.size)sections.push('**原表缓存与同次重算的敏感性**\n\n原表保留了保存时的数值。每个情景先按原输入重算基准，再调整输入重算结果；变动幅度以同次重算基准为分母。\n\n| 输入变动 | 输出 | 原表缓存 | 重算基准 | 情景结果 | 相对基准 |\n|---|---|---:|---:|---:|---:|\n'+[...recalculatedRows].join('\n'));
  return {text:sections.join('\n\n'),citations:[...references.values()],callIds:[...callIds],results:[...results],rebased:recalculatedRows.size>0};
}
