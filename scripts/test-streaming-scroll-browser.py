"""Streaming layout regressions; pip install playwright && playwright install chromium.
Set PE_BROWSER_CHANNEL=msedge to use an installed Edge instead.
"""
import json
import mimetypes
import os
from pathlib import Path
from urllib.parse import urlparse
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
with sync_playwright() as pw:
    options = {"headless": True}
    if os.environ.get("PE_BROWSER_CHANNEL"):
        options["channel"] = os.environ["PE_BROWSER_CHANNEL"]
    browser = pw.chromium.launch(**options)
    page = browser.new_page(viewport={"width": 1200, "height": 800})
    def serve(route):
        path = urlparse(route.request.url).path
        if path == "/":
            route.fulfill(content_type="text/html", body='<!doctype html><link rel="stylesheet" href="/styles.css"><div id="thread" class="thread" style="position:fixed;top:0;left:0;width:900px;height:320px;flex:none"></div>')
        else:
            file = ROOT / path.lstrip("/")
            if file.is_file():
                route.fulfill(body=file.read_bytes(), content_type="text/javascript" if file.suffix in (".js", ".mjs") else mimetypes.guess_type(file.name)[0] or "text/plain")
            else:
                route.fulfill(status=404, body="not found")
    page.route("http://stream.test/**", serve)
    page.goto("http://stream.test/")
    page.evaluate(r"""async () => {
        window.renderer = await import('/ui/chat/renderer.js');
        window.state = (await import('/ui/state/store.js')).state;
        window.marked = (await import('/node_modules/marked/lib/marked.esm.js')).marked;
        window.thread = document.querySelector('#thread');
        window.frame = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        window.metrics = () => ({top:thread.scrollTop, height:thread.scrollHeight,
            bottom:thread.scrollHeight-thread.clientHeight-thread.scrollTop,
            width:thread.clientWidth, live:document.querySelector('#liveMsg')?.getBoundingClientRect().top});
        state.messages = Array.from({length:12}, (_,i) => ({role:'user', text:'History '+i}));
        state.streaming = true;
        state.live = {text:'',tools:[],startedAt:Date.now()};
        renderer.renderThread(true);
    }""")
    first = page.evaluate(r"""async () => {
        const before = metrics();
        state.live.text = 'Hello'; renderer.scheduleThread(); await frame();
        return {before, after:metrics()};
    }""")
    assert first['before']['height'] == first['after']['height'], first
    assert first['before']['live'] == first['after']['live'], first
    assert first['before']['width'] == first['after']['width'], first

    stable = page.evaluate(r"""async () => {
        const paragraph = document.querySelector('#liveBody p');
        const text = paragraph.firstChild;
        state.live.text += ' world'; renderer.scheduleThread(); await frame();
        return paragraph === document.querySelector('#liveBody p') && text === paragraph.firstChild && text.textContent === 'Hello world';
    }""")
    assert stable, 'Text updates must preserve the existing DOM nodes'

    follow = page.evaluate(r"""async () => {
        state.live.text += '\n\n' + 'A large streamed paragraph.\n\n'.repeat(35);
        renderer.scheduleThread(); await frame(); return metrics();
    }""")
    assert abs(follow['bottom']) <= 1, follow

    paused = page.evaluate(r"""async () => {
        // Simulate scrolling after scheduling but before the frame is rendered.
        renderer.scheduleThread();
        thread.scrollTop = 120;
        const before = metrics();
        state.live.text += '\n\nNew content';
        await frame();
        return {before, after:metrics()};
    }""")
    assert paused['after']['top'] == paused['before']['top'], paused
    settled = page.evaluate(r"""() => {
        const before = metrics();
        state.messages.push({role:'assistant',text:state.live.text});
        state.streaming = false; renderer.resetLive(); renderer.renderThread('follow');
        return {before,after:metrics()};
    }""")
    assert settled['before']['top'] == settled['after']['top'], settled

    markdown = page.evaluate(r"""async () => {
        state.streaming = true;
        state.live = {text:'',tools:[],startedAt:Date.now()};
        renderer.resetLive(); renderer.renderThread(true);
        const source = '# Heading\n\n**Bold** text\n\n- one\n- two\n\n|A|B|\n|-|-|\n|1|2|\n\n```js\nconst x = 1;\n```';
        let maxBottom = 0;
        for (const char of source) {
            state.live.text += char;
            renderer.scheduleThread(false);
            renderer.scheduleThread();
            await frame();
            maxBottom = Math.max(maxBottom, Math.abs(metrics().bottom));
        }
        const expected = document.createElement('div');
        expected.innerHTML = renderer.renderMarkdownHTML(source);
        return {equal:expected.innerHTML === document.querySelector('#liveBody').innerHTML, maxBottom};
    }""")
    assert markdown['equal'], markdown
    assert markdown['maxBottom'] <= 1, markdown
    forced = page.evaluate(r"""async () => {
        thread.scrollTop = 0;
        renderer.scheduleThread(false); renderer.scheduleThread(true);
        await frame(); return metrics();
    }""")
    assert abs(forced['bottom']) <= 1, forced
    overflow = page.evaluate(r"""async () => {
        state.messages = [{role:'user',text:'Question'}];
        state.live = {text:'',tools:[],startedAt:Date.now()};
        renderer.resetLive(); renderer.renderThread(true);
        const before = metrics();
        const x = document.querySelector('#liveMsg').getBoundingClientRect().x;
        state.live.text = 'A paragraph.\n\n'.repeat(40);
        renderer.scheduleThread(); await frame();
        return {before,after:metrics(),sameX:x === document.querySelector('#liveMsg').getBoundingClientRect().x};
    }""")
    assert overflow['before']['width'] == overflow['after']['width'], overflow
    assert overflow['sameX'], overflow
    assert abs(overflow['after']['bottom']) <= 1, overflow
    print(json.dumps({"firstToken":first,"readerPosition":paused,"completion":settled,"markdown":markdown,"scrollbarWidthStable":overflow["sameX"],"result":"PASS"}))
    browser.close()
