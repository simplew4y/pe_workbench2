/** Pure, escaped rendering of the state contract; never calculates new valuations. */
const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const rows = value => Array.isArray(value) ? value.filter(x => x && typeof x === 'object') : [];

export function renderFrameworkPresentation(state, { asOf = Date.now(), turnStartedAt, highlightBudget = { remaining: 4 } } = {}) {
  const p = state?.presentation;
  if (!p?.verdict?.text) return '';
  const review = rows(p.review_items).slice(0, 3);
  const collections = ['assumptions','theses','evidence','sensitivities','falsifiers','valuations','gaps','sources','changes'];
  const index = new Map(collections.flatMap(key => rows(state[key])).map(row => [row.id, row]));
  const valid = new Set([...index.keys(), p.verdict.id, ...review.map(x => x.id)].filter(Boolean));
  const highlights = new Set((Array.isArray(p.highlights) ? p.highlights : []).filter(id => typeof id === 'string' && valid.has(id)).slice(0,4));
  const used = new Set();
  const mark = (id, text, review = false) => {
    if (!highlights.has(id) || used.has(id) || highlightBudget.remaining <= 0) return esc(text);
    used.add(id);
    highlightBudget.remaining -= 1;
    return `<span class="hl-${review ? 'review' : 'decision'}">${review ? '需复核：' : '关键判断：'}${esc(text)}</span>`;
  };
  const section = (name, body, cls='') => `<section class="framework-section ${cls}"><h3>${name}</h3>${body}</section>`;
  const table = (heads, body) => `<div class="framework-table"><table><thead><tr>${heads.map(h=>`<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${body || `<tr><td colspan="${heads.length}">暂无记录</td></tr>`}</tbody></table></div>`;
  const valuation = rows(state.valuations).find(v => v.id === p.verdict.valuation_id && v.status !== 'superseded');
  const market = state.market || {};
  const modelPrice = valuation?.value;
  // Only quotes fetched during this delivery can supply current price and upside.
  // Without a known turn boundary, no quote can be treated as current.
  const generatedAt = new Date(asOf).getTime();
  const boundary = (typeof turnStartedAt === 'number' && Number.isFinite(turnStartedAt) && turnStartedAt > 0)
    || (typeof turnStartedAt === 'string' && turnStartedAt.trim() !== '')
    ? new Date(turnStartedAt).getTime() : NaN;
  const fetchedAt = Date.parse(market.fetched_at);
  const latest = Number.isFinite(boundary) && boundary > 0 && fetchedAt >= boundary && fetchedAt <= generatedAt && Number.isFinite(market.price) && market.price > 0 && market.fetched_at && market.source;
  const currency = unit => /港元|HKD|HK\$/i.test(unit || '') ? 'HKD' : /人民币|CNY|RMB/i.test(unit || '') ? 'CNY' : /美元|USD/i.test(unit || '') ? 'USD' : unit;
  const comparable = latest && Number.isFinite(modelPrice) && currency(valuation.unit) && currency(market.currency) && currency(valuation.unit) === currency(market.currency);
  const upside = comparable ? (modelPrice / market.price - 1) * 100 : null;
  const prices = `<p class="framework-prices">模型价 ${esc(Number.isFinite(modelPrice) ? `${modelPrice} ${valuation.unit || ''}` : '未获取')} · 现价 ${esc(latest ? `${market.price} ${market.currency || ''}` : '未获取')} · 空间 ${upside === null ? '未获取' : esc(`${upside >= 0 ? '+' : ''}${upside.toFixed(2)}%`)}</p><p class="framework-meta">获取时间：${esc(market.fetched_at || '未获取')} · 行情时间：${esc(market.quote_at || market.price_date || '未获取')} · 来源：${esc(market.source || '未获取')}</p>`;
  const verdict = `<p class="framework-verdict">${mark(p.verdict.id,p.verdict.text)}</p><p class="framework-meta">${esc(p.verdict.status)} · ${esc(p.verdict.value_identity)}</p>${prices}`;
  const reviews = review.map(item=>`<li><strong>${mark(item.id,item.question,true)}</strong><span>原因：${esc(item.reason)}；影响：${esc(item.impact)}</span><button type="button" disabled title="本阶段仅展示，尚不支持写回">待人工复核</button></li>`).join('');
  const drivers = rows(p.key_drivers).slice(0,3).map(d=>{
    const ref=index.get(d.reference_id);
    return `<li>${mark(d.reference_id,ref?.statement ?? ref?.question ?? ref?.method ?? '引用缺失')} <span class="framework-meta">权重 ${Number.isFinite(d.weight) ? esc(`${Math.round(d.weight*100)}%`) : '—'} · ${esc(d.reference_id)}</span></li>`;
  }).join('');
  const sensitivity = rows(state.sensitivities).map(s=>`<tr><td>${esc(s.baseline)}</td><td>${esc(s.perturbation)}</td><td>${mark(s.id,s.result)}</td><td>${esc(s.fixed_conditions)}<br>${esc(s.limitations)}</td></tr>`).join('');
  const falsifiers = rows(state.falsifiers).map(f=>{
    const periodRule=`${f.statement || ''} ${f.threshold || ''}`;
    const multi=/连续|持续|consecutive/i.test(periodRule) || f.required_periods > 1;
    const count=new Set(rows(f.observations).filter(o=>o.period && Number.isFinite(o.value)).map(o=>o.period)).size;
    const match=periodRule.match(/(?:连续|consecutive)\s*([2-9二两三四五六七八九])(?:个)?/i);
    const inferred=match ? (Number(match[1]) || ({二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9}[match[1]])) : 2;
    const insufficient=multi && count < Math.max(f.required_periods || 1,inferred);
    let status = {triggered:['red','已确认触发'],warning:['amber',insufficient ? '单期预警' : '接近阈值 / 预警'],armed:['green','跟踪中'],unknown:['amber','数据不足'],retired:['neutral','已退役']}[f.status] || ['amber','数据不足'];
    if (f.status==='triggered' && insufficient) status=['amber','数据不足（多期条件未核实）'];
    return `<tr><td>${mark(f.id,f.statement ?? f.metric)}</td><td>${esc(f.threshold)}</td><td>${esc(f.observed)}</td><td><span class="falsifier-status is-${status[0]}">${status[1]}</span></td><td>${esc(f.action)}</td></tr>`;
  }).join('');
  const valuations = rows(state.valuations).filter(v=>v.status!=='superseded').map(v=>`<li><strong>${mark(v.id,`${v.value ?? '待核'} ${v.unit ?? ''}`)}</strong> · ${esc(v.method)}<br>${esc(v.formula)}<br><span class="framework-meta">${esc(v.limitations)}</span></li>`).join('');
  return `<section class="framework-presentation" aria-label="投资框架执行摘要">${section('结论',verdict,'verdict-card')}${section('需人工复核',`<ul class="framework-reviews">${reviews || '<li>暂无复核项</li>'}</ul>`,'review-card')}${section('核心驱动',`<ul>${drivers || '<li>暂无记录</li>'}</ul>`)}${section('敏感性',table(['基线','扰动','结果','固定条件 / 局限'],sensitivity))}${section('进入跟踪的失效条件',table(['条件','阈值','观察值','状态','行动'],falsifiers))}${section('估值依据',`<ul>${valuations || '<li>暂无记录</li>'}</ul>`)}</section>`;
}
