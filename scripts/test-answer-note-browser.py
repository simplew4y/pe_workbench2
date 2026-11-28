"""Offline visual/interaction check of partial-answer presentation."""
import mimetypes, os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
OUT=Path(os.getenv('ANSWER_NOTE_SCREENSHOTS',str(ROOT/'out/answer-note-browser')))
OUT.mkdir(parents=True,exist_ok=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1100,'height':760})
    def serve(route):
        url=urlparse(route.request.url)
        if url.hostname!='answer.local':route.abort();return
        file=ROOT/url.path.lstrip('/')
        if url.path=='/fixture-font':file=Path('/mnt/c/Windows/Fonts/msyh.ttc')
        if file.is_file():route.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file.name)[0] or 'text/plain')
        else:route.fulfill(body='<html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><main id="thread" style="width:min(760px,100%);margin:40px auto;padding:16px;box-sizing:border-box"></main></body></html>',content_type='text/html')
    page.route('**/*',serve)
    page.goto('http://answer.local/')
    page.add_style_tag(content="@font-face{font-family:Fixture;src:url('/fixture-font')}body{font-family:Fixture,sans-serif}")
    page.evaluate("document.fonts.load('16px Fixture')")
    page.evaluate(r'''async () => {
      const {messageHTML}=await import('/ui/chat/renderer.js');
      window.fixture={role:'assistant',turnId:'offline',status:'partial',text:'**关键驱动是盈利预测与估值倍数。**\n\n模型中的投资持仓与净现金是补充项。倍数选择依据仍待核实，因此暂不能判断估值是否合理。',reason:'主张数字没有完整登记或本轮结构化出处；工具 calc 执行失败；<script>window.injected=true</script>',tools:[]};
      window.renderFixture=(patch={})=>document.querySelector('#thread').innerHTML=messageHTML({...window.fixture,...patch});
      window.renderFixture();
    }''')
    body=page.locator('.msg-body')
    assert '倍数选择依据仍待核实' in body.inner_text()
    assert '部分结论仍待核实' not in body.inner_text()
    assert page.locator('.answer-note, .answer-diagnostics').count()==0
    assert '主张数字' not in body.inner_text() and 'calc' not in body.inner_text()
    page.screenshot(path=str(OUT/'partial-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT/'partial-mobile.png'),full_page=True)
    assert page.get_by_text('查看核验详情').count()==0
    page.evaluate("window.renderFixture({text:''})")
    assert '尚未形成可交付答复' in body.inner_text()
    page.evaluate("window.renderFixture({status:'completed'})")
    assert page.locator('.answer-note').count()==0
    page.evaluate("window.renderFixture({status:'completed',tools:[{id:'read',name:'read',status:'done',detail:'说明文档',output:'已读取'}]})")
    assert page.locator('.tool-card-error').count()==0
    page.locator('.tool-summary').click()
    assert '无法展示这个工具结果' not in body.inner_text()
    page.screenshot(path=str(OUT/'plain-read-mobile.png'),full_page=True)
    page.evaluate("window.renderFixture({status:'completed',tools:[{id:'broken',name:'read',status:'done',presentationError:'invalid schema'}]})")
    assert page.locator('.tool-card-error').count()==1
    page.evaluate("window.renderFixture({status:'completed',tools:[{id:'state',name:'write',status:'done',validation:{passed:false}}]})")
    page.locator('.tool-summary').click()
    assert page.locator('.tool-status').inner_text()=='已保存 · 校验未通过'
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(OUT/'state-validation-mobile.png'),full_page=True)
    # Promote only explicit page-to-file declarations, preserving code and
    # declining ambiguous mappings to more than one source.
    page.evaluate("""async () => {
      const {linkDeclaredPages}=await import('/ui/chat/answer-presentation.js');
      const reference='<p>来源：2024年报P26/37，<a href="https://example.org/report.pdf">年报</a></p>';
      const raw='<p>合并收现比 [P37]，发货量 [P26]，其他 [P99]。</p><pre>[P26]</pre>';
      const root=document.querySelector('#thread');
      root.innerHTML=linkDeclaredPages(raw+reference);
      if(root.querySelectorAll('p:first-child a').length !== 2 || root.querySelector('pre a'))throw Error('page binding');
      root.innerHTML=linkDeclaredPages(raw+reference+reference.replace('report.pdf','other.pdf'));
      if(root.querySelector('p:first-child a'))throw Error('ambiguous source');
    }""")
    browser.close()
print('PASS offline partial answer: hidden footer, mobile, empty and completed states')
