/** Chat transcript, live run, composer and attachments/upload. */

import {
  $, $$, esc, icon, threadEl, attachmentsEl, inputEl, sendBtn, fileInput,
  HERO_URL, kindOf, extOf, AUDIO_PREVIEW, nextId, nowHM,
} from "../shared/dom.js";
import { state, selectors } from "../state/store.js";
import { api, uploadFile, withProject } from "../api/client.js";
import { toast } from "../shared/toast.js";
import { approvalsShelfHTML } from "../approvals/approvals.js";
import { renderToolPresentation } from "../tool-renderers/registry.js";
import { sanitizeMarkdown } from "../previews/previews.js";
import { renderFrameworkPresentation } from "./presentation.js";
import { linkCitations } from "./cell-citations.js";
import { runtime } from "../runtime.js";
import { getThreadScroll } from "./thread-scroll.js";

const fileById = (id) => selectors.fileById(id);
const latest = (file) => selectors.latest(file);
const refreshFileCards = () => runtime.refreshFileCards?.();
const upsertMaterial = (material) => runtime.upsertMaterial?.(material);
const syncStop = () => runtime.syncStop?.();
const createSession = () => runtime.createSession?.();
const renderPanel = () => runtime.renderPanel?.();
const renderTraceHitl = () => runtime.renderTraceHitl?.();


function fileInline(id) {
  const f = fileById(id);
  if (!f) return '';
  const k = kindOf(f.name);
  return `<button class="file-inline" data-file="${f.id}" aria-label="查看 ${esc(f.name)}">
      ${icon(k.icon, 14)}<span>${esc(f.name)}</span><span class="ver ver-inline">v${latest(f).v}</span></button>`;
}

function mdInline(text) {
  return text
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
}

function mdToHtml(md = '') {
  const lines = esc(md).split('\n');
  let html = '';
  let inCode = false;
  let code = [];
  let buffer = [];
  let list = null;
  const flushP = () => { if (buffer.length) { html += `<p>${buffer.join('<br>')}</p>`; buffer = []; } };
  const closeList = () => { if (list) { html += `</${list}>`; list = null; } };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      flushP(); closeList();
      if (inCode) {
        html += `<pre class="code-block"><code>${code.join('\n')}</code></pre>`;
        code = []; inCode = false;
      } else inCode = true;
      continue;
    }
    if (inCode) { code.push(line); continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      flushP(); closeList();
      html += `<p class="md-h md-h${heading[1].length}">${mdInline(heading[2])}</p>`;
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      flushP();
      if (list !== 'ul') { closeList(); list = 'ul'; html += '<ul class="md-list">'; }
      html += `<li>${mdInline(bullet[1])}</li>`;
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ordered) {
      flushP();
      if (list !== 'ol') { closeList(); list = 'ol'; html += '<ol class="md-list">'; }
      html += `<li>${mdInline(ordered[1])}</li>`;
      continue;
    }
    if (!line.trim()) { flushP(); closeList(); continue; }
    closeList();
    buffer.push(mdInline(line));
  }
  flushP(); closeList();
  if (inCode) html += `<pre class="code-block"><code>${code.join('\n')}</code></pre>`;
  return html;
}

const TOOL_LABELS = {
  read: '读取文件',
  write: '写入文件',
  edit: '修改文件',
  grep: '检索资料',
  find: '查找文件',
  ls: '查看目录',
  workbook_query: '查询模型',
  workbook_trace: '追踪公式',
  validate_state: '校验状态',
  westock_query: '查询行情',
  anysearch_search: '搜索网络',
  web_fetch: '读取网页',
  bash: '执行命令',
};

const RUNNING_LABELS = {
  read: '正在读取文件',
  write: '正在撰写报告',
  edit: '正在修改报告',
  grep: '正在检索资料',
  find: '正在查找文件',
  ls: '正在查看目录',
  workbook_query: '正在读取模型',
  workbook_trace: '正在追踪公式链',
  validate_state: '正在校验状态',
  westock_query: '正在查询行情',
  anysearch_search: '正在搜索网络',
  web_fetch: '正在读取网页',
  bash: '正在执行命令',
};

const THINKING_LABELS = ['正在思考', '正在分析问题', '正在梳理资料', '正在核对数据', '正在组织结论', '正在撰写报告'];

function toolLabel(name) {
  return TOOL_LABELS[name] || name;
}

function toolRunningLabel(name) {
  return RUNNING_LABELS[name] || '正在调用工具';
}

function liveStatusText() {
  const tools = state.live.tools || [];
  const running = tools.filter(tool => tool.status === 'running');
  if (running.length) return toolRunningLabel(running[running.length - 1].name);
  if (tools.length) return state.live.text ? '正在整理结论' : '正在核对资料';
  const started = state.live.startedAt || Date.now();
  return THINKING_LABELS[Math.floor((Date.now() - started) / 5000) % THINKING_LABELS.length];
}

function updateLiveStatus() {
  const el = $('#liveStatus');
  if (!el) return;
  const text = liveStatusText();
  if (el.textContent !== text) el.textContent = text;
}

let liveTicker = null;
function syncLiveTicker() {
  if (state.streaming && !liveTicker) liveTicker = setInterval(updateLiveStatus, 3500);
  if (!state.streaming && liveTicker) {
    clearInterval(liveTicker);
    liveTicker = null;
  }
}

const mdCache = new Map();
function renderMarkdownHTML(text, relPath = '', highlightBudget = { remaining: 4 }) {
  const src = String(text || '');
  if (!src) return '';
  const key = `${window.marked ? 'm' : 'f'}\u0000${relPath}\u0000${src}`;
  if (window.marked) {
    try {
      // Cache parsing only: sanitization must consume this reply's current budget.
      let parsed = mdCache.get(key);
      if (parsed == null) {
        parsed = window.marked.parse(src, { gfm: true, breaks: false });
        if (mdCache.size > 160) mdCache.clear();
        mdCache.set(key, parsed);
      }
      return sanitizeMarkdown(parsed, { relPath }, highlightBudget);
    } catch {
      return mdToHtml(src);
    }
  }
  return mdToHtml(src);
}

function toolRowHTML(tool) {
  const status = tool.status === 'running' ? '运行中' : tool.status === 'error' ? '失败' : '完成';
  const glyph = tool.status === 'running' ? 'refresh' : tool.status === 'error' ? 'x' : 'check';
  const card = renderToolPresentation(tool);
  return `<div class="tool-row ${tool.status || 'done'}">
      ${icon(glyph, 12)}
      <span class="tool-name">${esc(toolLabel(tool.name))}</span>
      ${tool.detail ? `<span class="tool-detail">${esc(tool.detail)}</span>` : ''}
      <span class="tool-status">${status}</span>
    </div>${card ? `<div class="tool-card-slot">${card}</div>` : ''}`;
}

function toolGroupHTML(tools = [], { live = false, processText = '', highlightBudget = { remaining: 4 } } = {}) {
  if (!tools.length && !processText) return '';
  const errors = tools.filter(tool => tool.status === 'error').length;
  const label = live ? liveStatusText() : (tools.length ? `过程 · ${tools.length} 个工具调用` : '过程');
  const meta = live ? (tools.length ? `第 ${tools.length} 步` : '') : (errors ? `${errors} 个失败` : '已完成');
  const status = live ? ' id="liveStatus" aria-live="polite"' : '';
  return `<details class="tool-group">
      <summary class="tool-summary">
        ${icon('chevron-right', 12)}
        <span class="tool-summary-label"${status}>${esc(label)}</span>
        ${meta ? `<span class="tool-summary-meta">${esc(meta)}</span>` : ''}
      </summary>
      ${processText ? `<div class="process-text">${renderMarkdownHTML(processText, '', highlightBudget)}</div>` : ''}
      ${tools.length ? `<div class="tool-list">${tools.map(toolRowHTML).join('')}</div>` : ''}
    </details>`;
}

function reportPathsFor(m) {
  const paths = [];
  for (const tool of m.tools || []) {
    if (tool.name !== 'write' && tool.name !== 'edit') continue;
    if (tool.status === 'error') continue;
    const path = String(tool.detail || '').trim();
    if (!path || !/\.(md|markdown)$/i.test(path)) continue;
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

function reportKey(path) {
  const file = state.files.find(item => item.relPath === path);
  const version = file && latest(file) ? latest(file).v : '';
  return `${state.project.id}|${path}#${version || ''}`;
}

function reportCardHTML(path, highlightBudget = { remaining: 4 }) {
  const name = path.split('/').pop();
  const key = reportKey(path);
  const cached = reportCache.get(key);
  const body = cached != null
    ? `<div class="md-preview report-md">${renderMarkdownHTML(cached, path, highlightBudget)}</div>`
    : `<div class="report-loading">正在加载报告…</div>`;
  return `<section class="msg-report" data-report-path="${esc(path)}">
      <div class="report-summary">
        ${icon('file-text', 13)}
        <span class="report-title">完整报告</span>
        ${typeof state !== 'undefined' && (state.pendingMerges || []).some(a => a.path === path) ? '<span class="ap-badge warn">待并入</span>' : ''}
        <span class="report-name">${esc(name)}</span>
      </div>
      <div class="report-body" data-report-body${cached != null ? ` data-report-key="${esc(key)}"` : ''}>${body}</div>
      <button type="button" class="report-toggle" data-report-toggle aria-expanded="false">展开全文</button>
    </section>`;
}

const reportCache = new Map();
async function hydrateReports(root = threadEl) {
  const nodes = $$('[data-report-path]', root);
  for (const node of nodes) {
    const toggle = $('[data-report-toggle]', node);
    if (toggle) toggle.onclick = () => {
      const expanded = toggle.getAttribute('aria-expanded') !== 'true';
      node.classList.toggle('is-expanded', expanded);
      toggle.setAttribute('aria-expanded', String(expanded));
      toggle.textContent = expanded ? '收起' : '展开全文';
    };
    const path = node.dataset.reportPath;
    const body = $('[data-report-body]', node);
    if (!path || !body) continue;
    const key = reportKey(path);
    if (body.dataset.reportKey === key) continue;
    try {
      let text = reportCache.get(key);
      if (text == null) {
        const res = await fetch(withProject(`/api/file?path=${encodeURIComponent(path)}`));
        if (res.status === 404) throw new Error("报告文件已不存在（可能来自已清理的测试会话）");
        if (!res.ok) throw new Error(`读取失败（${res.status}）`);
        text = await res.text();
        reportCache.set(key, text);
      }
      // Count highlights already allocated anywhere in this reply, including cached reports.
      const article = node.closest?.('article.msg');
      const allocated = article ? [...article.querySelectorAll('.hl-decision, .hl-review')].filter(el => !body.contains(el)).length : 0;
      const highlightBudget = { remaining: Math.max(0, 4 - allocated) };
      body.innerHTML = `<div class="md-preview report-md">${renderMarkdownHTML(text, path, highlightBudget)}</div>`;
      body.dataset.reportKey = key;
      body.querySelectorAll('a[href]').forEach(link => {
        if (/^https?:/i.test(link.getAttribute('href') || '')) {
          link.setAttribute('target', '_blank');
          link.setAttribute('rel', 'noopener noreferrer');
        }
      });
    } catch (error) {
      body.innerHTML = `<div class="report-error">无法加载报告：${esc(error.message || String(error))}</div>`;
    }
  }
}

function messageHTML(m) {
  const highlightBudget = { remaining: 4 };
  const isUser = m.role === 'user';
  let body = isUser
    ? esc(m.text).split(/\n{2,}/).map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')
    : (renderFrameworkPresentation(m.analysisState, { highlightBudget, turnStartedAt: m.turnStartedAt, pendingMerge: typeof state !== 'undefined' && (state.pendingMerges || []).some(a => a.path === m.analysisStatePath) }) || renderMarkdownHTML(m.text || '', '', highlightBudget));
  const citations = (m.tools || []).flatMap(tool => Array.isArray(tool.citations) ? tool.citations : []);
  // The vm-based renderer test intentionally omits the module binding.
  if (typeof linkCitations === 'function' && citations.length) body = linkCitations(body, citations);
  const group = isUser ? '' : toolGroupHTML(m.tools || [], { processText: m.processText || '', highlightBudget });
  const reports = isUser ? '' : reportPathsFor(m).map(path => reportCardHTML(path, highlightBudget)).join('');
  return `<article class="msg ${isUser ? 'user' : 'assistant'}">
      <span class="msg-avatar">${isUser ? '林' : icon('spark', 15)}</span>
      <div>
        <div class="msg-head"><span class="msg-name">${isUser ? '林默' : 'Workbench'}</span><span class="msg-time">${esc(m.time || '')}</span></div>
        <div class="msg-body${isUser ? '' : ' md-preview'}">${body}</div>
        ${group}
        ${reports}
      </div>
    </article>`;
}

// Keep matching nodes (including text nodes) alive while Markdown grows.
// Only structural changes, such as a paragraph becoming a list, replace nodes.
function patchLiveChildren(parent, next) {
  const wanted = Array.from(next.childNodes);
  for (let i = 0; i < wanted.length; i += 1) {
    const source = wanted[i];
    const current = parent.childNodes[i];
    if (!current) {
      parent.appendChild(source.cloneNode(true));
    } else if (current.nodeType !== source.nodeType || current.nodeName !== source.nodeName) {
      current.replaceWith(source.cloneNode(true));
    } else if (current.nodeType === Node.ELEMENT_NODE) {
      for (const attr of Array.from(current.attributes)) {
        if (!source.hasAttribute(attr.name)) current.removeAttribute(attr.name);
      }
      for (const attr of Array.from(source.attributes)) {
        if (current.getAttribute(attr.name) !== attr.value) current.setAttribute(attr.name, attr.value);
      }
      patchLiveChildren(current, source);
    } else if (current.nodeValue !== source.nodeValue) {
      current.nodeValue = source.nodeValue;
    }
  }
  while (parent.childNodes.length > wanted.length) parent.lastChild.remove();
}

let renderScheduled = false;
let scheduledScroll = false;
let liveArticle = null;
let threadScroll = null;
function scheduleThread(scroll = 'follow') {
  // A later request in the same frame must not lose its scroll intent.
  if (scroll === true || scheduledScroll !== true && scroll === 'follow') scheduledScroll = scroll;
  if (renderScheduled) return;
  renderScheduled = true;
  requestAnimationFrame(() => {
    const intent = scheduledScroll;
    renderScheduled = false;
    scheduledScroll = false;
    renderThread(intent);
  });
}

function citationsFromTools(tools = []) {
  return tools.flatMap(tool => Array.isArray(tool.citations) ? tool.citations : []);
}

function liveMessageHTML() {
  const live = state.live;
  const hasContent = Boolean(live.text || live.tools.length);
  const status = esc(liveStatusText());
  const citations = citationsFromTools(live.tools);
  const liveBody = live.text ? renderMarkdownHTML(live.text, '') : '';
  const inlineStatus = live.tools.length
    ? ''
    : `<div class="live-status" id="liveStatusHost"><span class="live-dot"></span><span id="liveStatus" aria-live="polite">${status}</span>${hasContent ? '' : '<span class="typing"><i></i><i></i><i></i></span>'}</div>`;
  return `<article class="msg assistant" id="liveMsg">
      <span class="msg-avatar">${icon('spark', 15)}</span>
      <div>
        <div class="msg-head"><span class="msg-name">Workbench</span><span class="msg-time">正在输出</span></div>
        <div class="msg-body md-preview" id="liveBody">${live.text ? (citations.length ? linkCitations(liveBody, citations) : liveBody) : ''}</div>
        ${inlineStatus}
        <div id="liveTools">${live.tools.length ? toolGroupHTML(live.tools, { live: true }) : ''}</div>
      </div>
    </article>`;
}

function updateLiveMessage() {
  if (!liveArticle) return;
  const live = state.live;
  const hasContent = Boolean(live.text || live.tools.length);

  const body = liveArticle.querySelector('#liveBody');
  if (body) {
    if (live.text) {
      const markdown = renderMarkdownHTML(live.text, '');
      const citations = citationsFromTools(live.tools);
      const html = citations.length ? linkCitations(markdown, citations) : markdown;
      if (body.innerHTML !== html) {
        const template = document.createElement('template');
        template.innerHTML = html;
        patchLiveChildren(body, template.content);
      }
    } else {
      if (body.innerHTML) body.innerHTML = '';
    }
  }

  let statusHost = liveArticle.querySelector('#liveStatusHost');
  if (live.tools.length) {
    statusHost?.remove();
  } else {
    if (!statusHost) {
      statusHost = document.createElement('div');
      statusHost.className = 'live-status';
      statusHost.id = 'liveStatusHost';
      statusHost.innerHTML = '<span class="live-dot"></span><span id="liveStatus" aria-live="polite"></span>';
      const toolsHost = liveArticle.querySelector('#liveTools');
      if (toolsHost) toolsHost.before(statusHost);
    }
    const statusEl = statusHost.querySelector('#liveStatus');
    const text = liveStatusText();
    if (statusEl && statusEl.textContent !== text) statusEl.textContent = text;
    const typing = statusHost.querySelector('.typing');
    if (hasContent && typing) typing.remove();
    if (!hasContent && !typing) statusHost.insertAdjacentHTML('beforeend', '<span class="typing"><i></i><i></i><i></i></span>');
  }

  const toolsHost = liveArticle.querySelector('#liveTools');
  if (toolsHost) {
    const signature = live.tools.map(tool => `${tool.id}:${tool.status}:${String(tool.output || '').length}`).join('|');
    if (toolsHost.dataset.signature !== signature) {
      const wasOpen = Boolean(toolsHost.querySelector('details')?.open);
      toolsHost.innerHTML = live.tools.length ? toolGroupHTML(live.tools, { live: true }) : '';
      toolsHost.dataset.signature = signature;
      const details = toolsHost.querySelector('details');
      if (wasOpen && details) details.open = true;
    } else {
      const label = toolsHost.querySelector('#liveStatus');
      const text = liveStatusText();
      if (label && label.textContent !== text) label.textContent = text;
    }
  }
}

function pendingMergesBadgeHTML() {
  return (state.pendingMerges || []).length ? '<div class="tc-note"><span class="ap-badge warn">有待并入的更正</span></div>' : '';
}

function renderThread(scroll = false) {
  threadScroll ||= getThreadScroll(threadEl);
  const restoreScroll = threadScroll.capture(scroll);
  const messages = state.messages;
  if (!messages.length && !state.streaming) {
    const shelf = pendingMergesBadgeHTML() + approvalsShelfHTML();
    threadEl.innerHTML = shelf
      ? `<div class="thread-inner">${shelf}</div>`
      : `<div class="thread-empty">
        <div><div class="empty-mark">${icon('spark', 17)}</div><p class="empty-title">还没有消息</p></div>
      </div>`;
    liveArticle = null;
    threadScroll.reset();
    renderTraceHitl();
    void hydrateReports(threadEl);
    return;
  }
  if (state.streaming) {
    if (!liveArticle || !threadEl.contains(liveArticle)) {
      threadEl.innerHTML = `<div class="thread-inner">${pendingMergesBadgeHTML()}${approvalsShelfHTML()}${messages.map(messageHTML).join('')}${liveMessageHTML()}</div>`;
      liveArticle = threadEl.querySelector('#liveMsg');
      renderTraceHitl();
      void hydrateReports(threadEl);
    } else {
      updateLiveMessage();
      renderTraceHitl();
    }
    restoreScroll();
    return;
  }
  threadEl.innerHTML = `<div class="thread-inner">${pendingMergesBadgeHTML()}${approvalsShelfHTML()}${messages.map(messageHTML).join('')}</div>`;
  liveArticle = null;
  renderTraceHitl();
  void hydrateReports(threadEl);
  restoreScroll();
}

/* ---------- right panel: inputs / outputs / plans ---------- */


export function resetLive() {
  liveArticle = null;
}

export function clearCaches() {
  reportCache.clear();
  mdCache.clear();
}

export {
  fileInline, mdInline, mdToHtml, toolLabel, renderMarkdownHTML, toolRowHTML,
  toolGroupHTML, messageHTML, renderThread, scheduleThread, liveMessageHTML,
  updateLiveMessage, syncLiveTicker,
};
