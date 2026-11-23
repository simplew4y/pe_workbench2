"""Render a recorded offline delivery using production UI modules; no live app/API."""
import json, mimetypes, sys
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
record=json.loads(Path(sys.argv[1]).read_text())
assert record['network'] is False
delivery=record['delivery']; out=Path(sys.argv[2]); out.mkdir(parents=True,exist_ok=True)
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1100,'height':900})
    errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
    def serve(route):
        url=urlparse(route.request.url)
        if url.hostname!='answer.local':route.abort();return
        file=(ROOT/url.path.lstrip('/')).resolve()
        if url.path=='/vendor/marked.umd.js':file=ROOT/'node_modules/marked/lib/marked.umd.js'
        if url.path=='/fixture-font':file=Path('/mnt/c/Windows/Fonts/msyh.ttc')
        if file.is_file():route.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file.name)[0] or 'text/plain')
        else:route.fulfill(body='<html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><main id="thread" style="width:min(760px,100%);margin:30px auto;padding:16px;box-sizing:border-box"></main></body></html>',content_type='text/html')
    page.route('**/*',serve);page.goto('http://answer.local/')
    page.add_script_tag(url='/vendor/marked.umd.js')
    page.add_style_tag(content="@font-face{font-family:Fixture;src:url('/fixture-font')}body{font-family:Fixture,sans-serif}")
    page.evaluate("document.fonts.load('16px Fixture')")
    page.evaluate('''async d=>{
      const {messageHTML}=await import('/ui/chat/renderer.js');
      document.querySelector('#thread').innerHTML=messageHTML({...d,role:'assistant',turnId:'offline',tools:[]});
    }''',delivery)
    body=page.locator('.msg-body');visible=body.inner_text()
    assert '本次尚未完成全部核验' not in visible
    assert '报告文件未完成' not in visible
    assert page.locator('.answer-note, .answer-diagnostics').count()==0
    assert page.locator('a[href*=".md"]').count()>0
    page.screenshot(path=str(out/'recorded-desktop.png'))
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    page.screenshot(path=str(out/'recorded-mobile.png'))
    assert not errors,errors
    (out/'visible.txt').write_text(visible)
    (out/'browser-check.json').write_text(json.dumps({'network':False,'fixture':True,'productionRenderer':True,'pageErrors':errors,'desktop':True,'mobile':True,'bodyChars':len(visible)},ensure_ascii=False,indent=2))
    browser.close()
print('PASS recorded offline delivery: production renderer, file links, hidden footer, desktop and mobile; not live model acceptance')
