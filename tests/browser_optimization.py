"""Real Chromium check of local mock-only app; no microphone or provider requests.
Start MOCK=1 server on 127.0.0.1:8017 before running. Screenshots are optional.
"""
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    errors=[]
    page.on('pageerror', lambda error: errors.append(str(error)))
    page.goto('http://127.0.0.1:8017')
    page.click('#demo')
    page.wait_for_function("!!app.job && !app.checking", timeout=15000)
    assert page.locator('#speak').is_enabled()
    # Route only speech status to deterministic delayed chunks; server processing/rewrite is real MOCK=1.
    page.route('**/api/speak/async', lambda route: route.fulfill(json={'speak_id':'browser-test','status':'queued'}))
    calls=[0]
    chunk={'url':'/api/audio/backup_demo.m4a','seconds':3.84,'cached':False}
    def poll(route):
        calls[0]+=1
        if calls[0]==1:
            body={'status':'queued','chunks':[]}
        elif calls[0]<5:
            body={'status':'rendering','chunks':[chunk]}
        else:
            body={'status':'done','chunks':[chunk,chunk]}
        route.fulfill(json=body)
    page.route('**/api/speak/browser-test', poll)
    page.click('#speak')
    page.wait_for_function("play.chunks.length === 1 && !play.complete", timeout=5000)
    assert page.evaluate("player.src.endsWith('backup_demo.m4a')")
    assert page.locator('#speak').is_disabled()
    page.wait_for_function("play.chunks.length === 2 && play.complete",timeout=5000)
    assert calls[0] >= 5
    page.evaluate('stopPlayback()')
    # Synchronous invalidation before the debounce sends any verification request.
    page.click('#edit-btn')
    page.fill('#final-text','We will meet on Friday.')
    assert page.locator('#speak').is_disabled()
    assert page.evaluate('app.job.guard === null')
    page.wait_for_function('!app.checking',timeout=5000)
    assert page.locator('#speak').is_disabled()
    # Starting a new recording/job clears the old checking state.
    page.click('#demo')
    page.wait_for_function('!!app.job && !app.checking',timeout=15000)
    assert page.locator('#speak').is_enabled()
    assert not errors, errors
    browser.close()
    print('PASS: real Chromium first-chunk playback, polling, approval invalidation, reset; no page errors')
