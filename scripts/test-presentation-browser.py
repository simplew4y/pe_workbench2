"""Real browser checks for chat cards, report collapse and Markdown sanitization."""
from pathlib import Path
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
with sync_playwright() as pw:
  browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
  page=browser.new_page()
  def serve(route):
   from urllib.parse import urlparse
   import mimetypes
   file=ROOT/urlparse(route.request.url).path.lstrip('/')
   if file.is_file(): route.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file.name)[0] or 'text/plain')
   else: route.fulfill(body='<html><body><div id="thread"></div></body></html>',content_type='text/html')
  page.route('http://issue4.local/**',serve)
  page.goto('http://issue4.local/')
  data=page.evaluate('''async () => {
    const {sanitizeMarkdown}=await import('/ui/previews/previews.js');
    const {messageHTML}=await import('/ui/chat/renderer.js');
    const {state}=await import('/ui/state/store.js');
    state.files=[];
    const s={presentation:{verdict:{id:'verdict',text:'不能直接采信 752 港元。',status:'条件判断',value_identity:'复现值'},review_items:[{id:'R1',question:'核时点',reason:'未知',impact:'可比性'}],key_drivers:[],highlights:['verdict','R1']}};
    const html=messageHTML({role:'assistant',text:'旧回复',analysisState:s,tools:[{name:'write',detail:'exports/投资框架报告.md',status:'done'}]});
    const host=document.createElement('div');host.innerHTML=html;
    const raw=Array.from({length:6},()=>'<span class="hl-review evil" style="color:red" onclick="alert(1)">核时点</span>').join('');
    const clean=sanitizeMarkdown(raw,{}); const box=document.createElement('div');box.innerHTML=clean;
    return {html,collapsed:host.querySelector('[data-report-toggle]').getAttribute('aria-expanded')==='false',clean,count:box.querySelectorAll('.hl-review').length,labels:box.textContent.includes('需复核：'),unsafe:!!box.querySelector('[style],[onclick],.evil')};
  }''')
  assert data['collapsed']
  assert '旧回复' not in data['html']
  assert '核时点' in data['html']
  assert not data['unsafe']
  assert data['count']==4,data
  assert data['labels'],data
  nested=page.evaluate('''async () => {
    const {sanitizeMarkdown}=await import('/ui/previews/previews.js');
    const budget={remaining:4};
    const raw='<div><div><span style="color:red" class="evil">正文</span></div>'+Array.from({length:5},()=>'<span style="color:red" class="hl-review evil">复核</span>').join('')+'</div>';
    const box=document.createElement('div');box.innerHTML=sanitizeMarkdown(raw,{},budget);
    return {count:box.querySelectorAll('.hl-review').length,unsafe:!!box.querySelector('div,[style],.evil'),remaining:budget.remaining,text:box.textContent};
  }''')
  assert nested['count']==4,nested
  assert not nested['unsafe'],nested
  assert nested['remaining']==0,nested
  assert '正文' in nested['text'],nested
  # Exercise the real renderer, hydration and toggle with a long local report.
  page.route('http://issue4.local/api/file?**', lambda route: route.fulfill(body='# 假报告\n\n' + '\n\n'.join(['报告正文'] * 30), content_type='text/plain'))
  page.evaluate("""async () => {
    const {state}=await import('/ui/state/store.js');
    const {renderThread}=await import('/ui/chat/renderer.js');
    const style=document.createElement('link');style.rel='stylesheet';style.href='/styles.css';document.head.append(style);
    state.messages=[{role:'assistant',text:'摘要',tools:[{name:'write',detail:'exports/report.md',status:'done'}]}];
    renderThread();
  }""")
  page.wait_for_selector('.report-md')
  report=page.locator('.msg-report')
  body=report.locator('.report-body')
  assert body.is_visible()
  assert '假报告' in body.inner_text()
  toggle=report.locator('[data-report-toggle]')
  assert toggle.get_attribute('aria-expanded') == 'false'
  compact=body.bounding_box()['height']
  assert compact < 190
  assert body.evaluate('(el) => el.scrollHeight > el.clientHeight')
  toggle.click()
  assert body.is_visible()
  assert '假报告' in body.inner_text()
  assert toggle.inner_text() == '收起'
  assert toggle.get_attribute('aria-expanded') == 'true'
  assert body.bounding_box()['height'] > compact
  toggle.click()
  assert toggle.inner_text() == '展开全文'
  assert body.bounding_box()['height'] == compact
  browser.close()
print('presentation browser passed')
