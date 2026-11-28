"""Reading-mode citation check using the real chat renderer and styles."""
from pathlib import Path
from urllib.parse import urlparse
import mimetypes, os
from playwright.sync_api import sync_playwright
ROOT=Path(__file__).resolve().parent.parent
FONT=Path('/mnt/c/Windows/Fonts/msyh.ttc')
with sync_playwright() as pw:
    browser=pw.chromium.launch(headless=True,args=['--no-sandbox'])
    page=browser.new_page(viewport={'width':1100,'height':760},device_scale_factor=1)
    def serve(route):
        file=ROOT/urlparse(route.request.url).path.lstrip('/')
        if urlparse(route.request.url).path=='/fixture-font' and FONT.is_file():
            route.fulfill(body=FONT.read_bytes(),content_type='font/collection');return
        if file.is_file():route.fulfill(body=file.read_bytes(),content_type=mimetypes.guess_type(file.name)[0] or 'text/plain')
        else:route.fulfill(body='<html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"></head><body><main id="thread" style="width:min(760px,100%);margin:40px auto;padding:16px;box-sizing:border-box"></main></body></html>',content_type='text/html')
    page.route('http://reading.local/**',serve)
    page.goto('http://reading.local/')
    if FONT.is_file():
        page.add_style_tag(content="@font-face{font-family:ReadingFixture;src:url('/fixture-font')}body{font-family:ReadingFixture,sans-serif}")
        page.evaluate("document.fonts.load('16px ReadingFixture')")
    page.evaluate(r"""async () => {
        const {messageHTML}=await import('/ui/chat/renderer.js');
        const citations=['Model!A1','Model!B2','Model!C3'].map((locator,i)=>({id:'cite:'+i,materialId:'fixture',filename:'估值模型.xlsx',version:2,locator}));
        const text='**估值差距主要来自对未来利润和估值倍数的不同预期。** 模型结果不能直接等同于市场应有价格。（[估值模型.xlsx]Model!A1）\n\n游戏业务决定了盈利预测能否兑现，广告业务则影响增长与利润率的组合。需要重点看收入增长能否持续转化为利润，而不是只看一个目标价。（Model!B2、C3）\n\n如果增长放缓，同时市场愿意支付的估值倍数下降，目标价会承受双重压力。下一步最有价值的跟踪信号，是核心业务利润增长与模型预期的差距。（Model!A1）';
        const host=document.querySelector('#thread');host.innerHTML=messageHTML({role:'assistant',turnId:'fixture',status:'completed',text,citations,tools:[]});
        host.addEventListener('click',e=>{const b=e.target.closest('[data-cell-cite]');if(b)window.clickedSource={...b.dataset};});
    }""")
    body=page.locator('.msg-body')
    assert 'Model!' not in body.inner_text()
    assert '估值模型.xlsx' not in body.inner_text()
    assert body.locator('[data-cell-cite]').count()==4
    assert body.locator('[data-cell-cite]').all_text_contents()==['[1]','[2]','[3]','[1]']
    source=body.locator('[data-cell-cite]').first
    assert source.get_attribute('aria-label')=='查看来源 1：估值模型.xlsx · Model!A1'
    source.focus();page.keyboard.press('Enter')
    assert page.evaluate('window.clickedSource.locator')=='Model!A1'
    assert page.evaluate('window.clickedSource.version')=='2'
    screenshots=os.getenv('READING_SCREENSHOTS')
    if screenshots:
        target=Path(screenshots);target.mkdir(parents=True,exist_ok=True)
        page.screenshot(path=str(target/'reading-desktop.png'),full_page=True)
    page.set_viewport_size({'width':390,'height':844})
    assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
    assert source.is_visible()
    if screenshots:page.screenshot(path=str(target/'reading-mobile.png'),full_page=True)
    browser.close()
print('PASS chat reading mode: compact citations, original source identity, keyboard activation and mobile width')
