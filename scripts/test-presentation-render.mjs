import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { renderFrameworkPresentation as renderPresentation } from '../ui/chat/presentation.js';
// Existing price fixtures belong to the turn beginning at 02:00; keep all assertions intact.
const renderFrameworkPresentation = (state, options = {}) => renderPresentation(state, {turnStartedAt:'2026-11-03T02:00:00Z', ...options});
const state={presentation:{verdict:{id:'verdict',text:'752 港元仅为复现值。',status:'条件判断',value_identity:'复现值'},review_items:[{id:'R1',question:'核日期<script>',reason:'时点未知',impact:'不能直接采信'}],key_drivers:[{reference_id:'A1',weight:0.6}],highlights:['verdict','R1','S1','F1','V1','missing']},assumptions:[{id:'A1',statement:'收入增长'}],sensitivities:[{id:'S1',baseline:'0',perturbation:'-5%',result:'-10 港元'}],falsifiers:[{id:'F1',threshold:'连续两季 <15%',observed:0,status:'warning',action:'复核'}],valuations:[{id:'V1',value:752,unit:'港元',formula:'SOTP',limitations:'历史缓存'}]};
const html=renderFrameworkPresentation(state);
assert.ok(html.startsWith('<section'));
let at=-1; for(const title of ['752 港元仅为复现值。','需人工复核','核心驱动','敏感性','进入跟踪的失效条件','估值依据']) { const next=html.indexOf(title); assert.ok(next>at,title); at=next; }
assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
assert.ok(html.includes('disabled')); assert.ok(html.includes('60%')); assert.ok(html.includes('单期预警'));
assert.ok(html.includes('<td>0</td>')); assert.ok(html.includes('752 港元')); assert.ok(html.includes('历史缓存'));
assert.equal((html.match(/class="hl-(decision|review)"/g)||[]).length,4);
assert.ok(html.includes('关键判断：')); assert.ok(html.includes('需复核：'));
assert.equal(renderFrameworkPresentation({}), '');
assert.equal(renderFrameworkPresentation({presentation:{}}), '');

// Optional sections disappear when absent or empty; core prices remain visible.
for (const value of [undefined, []]) {
  const empty = {presentation: {verdict: state.presentation.verdict, review_items: value, key_drivers: value}, sensitivities: value, falsifiers: value, valuations: value};
  const rendered = renderFrameworkPresentation(empty);
  for (const title of ['需人工复核', '核心驱动', '敏感性', '进入跟踪的失效条件', '估值依据']) {
    assert.ok(!rendered.includes(`<h3>${title}</h3>`), `${title} is hidden without records`);
  }
  assert.ok(!rendered.includes('暂无'));
  assert.ok(rendered.includes('模型价 未获取'));
  assert.ok(rendered.includes('现价 未获取'));
  assert.ok(rendered.includes('空间 未获取'));
}
const noReview = structuredClone(state);
noReview.presentation.review_items = [];
const noReviewHTML = renderFrameworkPresentation(noReview);
assert.ok(!noReviewHTML.includes('<h3>需人工复核</h3>'));
assert.ok(noReviewHTML.includes('<h3>敏感性</h3>'), 'other populated sections remain');
const retiredValuation = structuredClone(noReview);
retiredValuation.valuations[0].status = 'superseded';
assert.ok(!renderFrameworkPresentation(retiredValuation).includes('<h3>估值依据</h3>'));

state.falsifiers[0].status='triggered'; assert.ok(renderFrameworkPresentation(state).includes('数据不足'));
state.presentation.highlights=['missing']; assert.equal((renderFrameworkPresentation(state).match(/class="hl-/g)||[]).length,0);
const renderer=fs.readFileSync(new URL('../ui/chat/renderer.js',import.meta.url),'utf8');
// Reports must expose preview content without a closed details ancestor.
const card = vm.runInNewContext(`${renderer.slice(renderer.indexOf('function reportCardHTML('), renderer.indexOf('const reportCache ='))}; reportCardHTML('exports/report.md')`, {
  reportKey: () => 'report-key', reportCache: new Map([['report-key', '假报告']]),
  esc: value => value, icon: () => '', renderMarkdownHTML: text => `<p>${text}</p>`,
});
assert.ok(!card.includes('<details'), 'report preview must not use native hidden details');
assert.ok(card.includes('假报告'));
assert.ok(card.includes('aria-expanded="false"'));
assert.ok(card.includes('data-report-toggle'));
// Hydration binds the toggle even when the report is already cached.
const attributes = new Map([['aria-expanded', 'false']]);
const toggle = {getAttribute: key => attributes.get(key), setAttribute: (key, value) => attributes.set(key, value)};
const classes = new Set();
const node = {dataset: {reportPath: 'exports/report.md'}, classList: {toggle: (key, enabled) => enabled ? classes.add(key) : classes.delete(key)}};
const reportBody = {dataset: {reportKey: 'cached'}};
await vm.runInNewContext(`${renderer.slice(renderer.indexOf('async function hydrateReports('), renderer.indexOf('function messageHTML('))}; hydrateReports({})`, {
  $$: () => [node], $: selector => selector === '[data-report-toggle]' ? toggle : reportBody,
  reportKey: () => 'cached',
});
toggle.onclick();
assert.equal(attributes.get('aria-expanded'), 'true');
assert.equal(toggle.textContent, '收起');
assert.ok(classes.has('is-expanded'));
toggle.onclick();
assert.equal(attributes.get('aria-expanded'), 'false');
assert.equal(toggle.textContent, '展开全文');
assert.ok(!classes.has('is-expanded'));
state.falsifiers[0].statement='连续三个季度低于阈值'; state.falsifiers[0].threshold='15%'; state.falsifiers[0].status='triggered'; state.falsifiers[0].observations=[{period:'2026Q1',value:1},{period:'2026Q2',value:1}];
assert.ok(renderFrameworkPresentation(state).includes('数据不足'));
console.log('presentation rendering passed');
state.presentation.verdict.valuation_id='V1';
state.market={price:600,currency:'HKD',fetched_at:'2026-11-03T02:00:00Z',price_date:'2026-11-03',source:'westock_query'};
let priced=renderFrameworkPresentation(state,{asOf:'2026-11-03T02:10:00Z'});
assert.ok(priced.includes('模型价 752 港元'));
assert.ok(priced.includes('现价 600 HKD'));
assert.ok(priced.includes('+25.33%'));
assert.ok(priced.includes('2026-11-03T02:00:00Z'));
state.market.price=800;
assert.ok(renderFrameworkPresentation(state,{asOf:'2026-11-03T02:10:00Z'}).includes('-6.00%'));
state.market.price=null;
assert.ok(renderFrameworkPresentation(state,{asOf:'2026-11-03T02:10:00Z'}).includes('现价 未获取'));
state.market.price=600; delete state.market.fetched_at;
assert.ok(renderFrameworkPresentation(state,{asOf:'2026-11-03T02:10:00Z'}).includes('现价 未获取'));
state.market.fetched_at='2026-11-03T02:00:00Z';state.market.currency='USD';
assert.ok(renderFrameworkPresentation(state,{asOf:'2026-11-03T02:10:00Z'}).includes('空间 未获取'));
delete state.market.currency; delete state.valuations[0].unit;
assert.ok(renderFrameworkPresentation(state,{asOf:'2026-11-03T02:10:00Z'}).includes('空间 未获取'));
const freshState = structuredClone(state);
freshState.market={price:600,currency:'HKD',source:'westock_query',fetched_at:'2020-01-02T00:00:00Z'};
freshState.valuations[0].unit='港元';
assert.ok(renderFrameworkPresentation(freshState, {asOf:'2026-11-03T02:10:00Z'}).includes('现价 未获取'));
assert.ok(renderFrameworkPresentation(freshState, {asOf:'2026-11-03T02:10:00Z'}).includes('空间 未获取'));
for (const fetched_at of ['invalid','2026-11-04T02:00:00Z','2026-11-02T02:00:00Z']) {
  freshState.market.fetched_at=fetched_at;
  assert.ok(renderFrameworkPresentation(freshState,{asOf:'2026-11-03T02:10:00Z'}).includes('现价 未获取'));
}
freshState.market.fetched_at='2026-11-03T02:00:00Z';
assert.ok(renderFrameworkPresentation(freshState,{asOf:'2026-11-03T02:10:00Z'}).includes('+25.33%'));
freshState.presentation.highlights=['verdict','R1','S1','F1'];
const budget={remaining:4};
const first=renderFrameworkPresentation(freshState,{highlightBudget:budget});
const second=renderFrameworkPresentation(freshState,{highlightBudget:budget});
assert.equal(((first+second).match(/class="hl-/g)||[]).length,4,'reply renderers share one highlight budget');
// Run the real sanitizer with a small span-only DOM adapter, without a browser.
const previews=fs.readFileSync(new URL('../ui/previews/previews.js',import.meta.url),'utf8');
// Minimal DOM tree adapter supports real traversal, unwrapping and attribute mutation.
class TestNode {
  constructor(tagName = '', text = '') {
    this.nodeType = tagName ? 1 : 3;
    this.tagName = tagName.toUpperCase();
    this.text = text;
    this.childNodes = [];
    this.attributes = [];
  }
  get children() { return this.childNodes.filter(n => n.nodeType === 1); }
  get firstChild() { return this.childNodes[0]; }
  get textContent() { return this.text + this.childNodes.map(n => n.textContent).join(''); }
  appendChild(node) { node.remove(); node.parent = this; this.childNodes.push(node); return node; }
  prepend(node) { node.remove(); node.parent = this; this.childNodes.unshift(node); }
  remove() {
    if (this.parent) this.parent.childNodes.splice(this.parent.childNodes.indexOf(this), 1);
    this.parent = null;
  }
  replaceWith(fragment) {
    const parent = this.parent;
    const index = parent.childNodes.indexOf(this);
    const nodes = [...fragment.childNodes];
    for (const node of nodes) node.remove();
    parent.childNodes.splice(index, 1, ...nodes);
    for (const node of nodes) node.parent = parent;
    this.parent = null;
  }
  removeAttribute(name) { this.attributes = this.attributes.filter(a => a.name !== name); }
  setAttribute(name, value) { this.removeAttribute(name); this.attributes.push({name, value}); }
  get innerHTML() {
    return this.childNodes.map(n => n.nodeType === 3 ? n.text : `<${n.tagName.toLowerCase()}${n.attributes.map(a => ` ${a.name}="${a.value}"`).join('')}>${n.innerHTML}</${n.tagName.toLowerCase()}>`).join('');
  }
}
const documentAdapter={
  createTextNode: text => new TestNode('', text),
  createDocumentFragment: () => new TestNode(),
  createElement() {
    const root = new TestNode();
    return {
      set innerHTML(html) {
        const stack = [root];
        for (const [token] of html.matchAll(/<[^>]+>|[^<]+/g)) {
          if (token.startsWith('</')) { stack.pop(); continue; }
          const match = token.match(/^<([a-z]+)([^>]*)>/i);
          if (!match) { stack.at(-1).appendChild(new TestNode('', token)); continue; }
          const node = new TestNode(match[1]);
          node.attributes = [...match[2].matchAll(/([a-z-]+)="([^"]*)"/gi)].map(([,name,value]) => ({name,value}));
          stack.at(-1).appendChild(node);
          stack.push(node);
        }
      },
      get innerHTML() { return root.innerHTML; },
      get content() { return root; },
    };
  },
};
const sanitize=vm.runInNewContext(`${previews.slice(previews.indexOf('const MD_TAGS'),previews.indexOf('async function mountMarkdown'))}; sanitizeMarkdown`,{document:documentAdapter,Node:{ELEMENT_NODE:1,COMMENT_NODE:8}});
const rawHighlights=Array.from({length:6},()=>'<span class="hl-review">复核</span>').join('');
const markdown=vm.runInNewContext(`${renderer.slice(renderer.indexOf('const mdCache'),renderer.indexOf('function toolRowHTML'))}; renderMarkdownHTML`,{
  window:{marked:{parse:text=>text}},sanitizeMarkdown:sanitize,mdToHtml:()=>{throw Error('unexpected fallback');},
});
for (const summaryCount of [0,2,4]) {
  const shared={remaining:4};
  freshState.presentation.highlights=['verdict','R1','S1','F1'].slice(0,summaryCount);
  const summary=renderFrameworkPresentation(freshState,{highlightBudget:shared});
  const report1=markdown(rawHighlights,'report.md',shared);
  const report2=markdown(rawHighlights,'second.md',shared);
  assert.equal(((summary+report1+report2).match(/class="hl-/g)||[]).length,4,'summary and multiple cached Markdown reports share budget');
}
// Lazy report hydration reserves highlights already present elsewhere in the reply.
const lazyBody={dataset:{},contains:()=>false,querySelectorAll:()=>[],innerHTML:''};
const lazyNode={dataset:{reportPath:'lazy.md'},closest:()=>({querySelectorAll:()=>[{}, {}, {}]})};
await vm.runInNewContext(`${renderer.slice(renderer.indexOf('async function hydrateReports('),renderer.indexOf('function messageHTML('))}; hydrateReports({})`,{
  $$:()=>[lazyNode],$:selector=>selector==='[data-report-toggle]'?null:lazyBody,
  reportKey:()=> 'lazy-key',reportCache:new Map([['lazy-key',rawHighlights]]),renderMarkdownHTML:markdown,
  esc:value=>value,
});
assert.equal((lazyBody.innerHTML.match(/class="hl-/g)||[]).length,1,'async report receives only the remaining reply budget');
const groupHTML=vm.runInNewContext(`${renderer.slice(renderer.indexOf('function toolGroupHTML('),renderer.indexOf('function reportPathsFor('))}; toolGroupHTML`,{icon:()=>'',esc:v=>v,renderMarkdownHTML:markdown});
assert.equal((groupHTML([],{processText:rawHighlights,highlightBudget:{remaining:1}}).match(/class="hl-/g)||[]).length,1,'process text also consumes the reply budget');

// Unwrapped descendants must still lose arbitrary styling and consume the shared budget.
const nestedClean=sanitize('<div><div><span style="color:red" class="evil">正文</span></div></div>',{});
assert.ok(nestedClean.includes('正文'));
assert.ok(!/style=|class=|<div/.test(nestedClean), 'unwrapped descendants are sanitized recursively');
const nestedBudget={remaining:4};
const nestedHighlights=sanitize('<div>'+Array.from({length:5},()=>'<span class="hl-review">嵌套</span>').join('')+'</div>',{},nestedBudget);
assert.equal((nestedHighlights.match(/class="hl-review"/g)||[]).length,4, 'unwrapped highlights share the four-item budget');
assert.equal(nestedBudget.remaining,0);
assert.equal((sanitize('<div><span class="hl-decision">判断</span></div>',{},nestedBudget).match(/class="hl-/g)||[]).length,0);

// A quote fetched ten minutes ago in the previous turn must not supply price or upside.
const turnOptions = {asOf:'2026-11-03T02:10:00Z', turnStartedAt:'2026-11-03T02:05:00Z'};
freshState.market.fetched_at='2026-11-03T02:00:00Z';
let turnPrice=renderPresentation(freshState,turnOptions);
assert.ok(turnPrice.includes('现价 未获取'), 'previous-turn cached price is unavailable');
assert.ok(turnPrice.includes('空间 未获取'), 'previous-turn price cannot calculate upside');
freshState.market.fetched_at='2026-11-03T02:05:00Z';
turnPrice=renderPresentation(freshState,turnOptions);
assert.ok(turnPrice.includes('现价 600 HKD'), 'fetch at the turn boundary is current');
assert.ok(turnPrice.includes('+25.33%'));
freshState.market.fetched_at='2026-11-03T02:09:00Z';
assert.ok(renderPresentation(freshState,turnOptions).includes('现价 600 HKD'));
assert.ok(renderPresentation(freshState,{asOf:turnOptions.asOf}).includes('现价 未获取'), 'missing turn boundary falls back to generation time');

// Exercise the actual message renderer so a lost snapshot boundary cannot silently hide current quotes.
const messageRenderer=vm.runInNewContext(`${renderer.slice(renderer.indexOf('function messageHTML('),renderer.indexOf('let renderScheduled'))}; messageHTML`,{
  renderFrameworkPresentation: (s, options) => renderPresentation(s,{asOf:'2026-11-03T02:10:00Z',...options}),
  renderMarkdownHTML: () => '', toolGroupHTML: () => '', reportPathsFor: () => [],
  esc: value => value, icon: () => '',
});
freshState.market.fetched_at='2026-11-03T02:09:00Z';
assert.ok(messageRenderer({role:'assistant',analysisState:freshState,turnStartedAt:'2026-11-03T02:05:00Z'}).includes('现价 600 HKD'));
freshState.market.fetched_at='2026-11-03T02:00:00Z';
assert.ok(messageRenderer({role:'assistant',analysisState:freshState,turnStartedAt:'2026-11-03T02:05:00Z'}).includes('空间 未获取'));

// An unknown turn boundary must never make historical quotes current.
freshState.market.fetched_at='2020-01-02T00:00:00Z';
for (const turnStartedAt of [null, undefined, 'invalid']) {
  const unavailable=renderPresentation(freshState,{asOf:turnOptions.asOf,turnStartedAt});
  assert.ok(unavailable.includes('现价 未获取'), `unknown turn boundary ${turnStartedAt} rejects historical price`);
  assert.ok(unavailable.includes('空间 未获取'), `unknown turn boundary ${turnStartedAt} cannot calculate upside`);
}
// Even a quote at generation time requires a known turn boundary.
freshState.market.fetched_at=turnOptions.asOf;
assert.ok(renderPresentation(freshState,{asOf:turnOptions.asOf}).includes('现价 未获取'));
assert.ok(renderPresentation(freshState,{asOf:turnOptions.asOf}).includes('空间 未获取'));

// Zero, NaN and empty turn boundaries must never make historical quotes current.
freshState.market.fetched_at='2020-01-02T00:00:00Z';
for (const turnStartedAt of [0, NaN, '']) {
  const unavailable=renderPresentation(freshState,{asOf:turnOptions.asOf,turnStartedAt});
  assert.ok(unavailable.includes('现价 未获取'), `invalid turn boundary ${String(turnStartedAt)} rejects historical price`);
  assert.ok(unavailable.includes('空间 未获取'), `invalid turn boundary ${String(turnStartedAt)} cannot calculate upside`);
}
