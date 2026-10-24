"""Headless-Chrome checks for the VoiceFlow page: 3-step flow, live meter + draft, watchdog, fallbacks, speak errors,
names, service status, keyboard, accessibility audit, 1280x720 and 200% zoom.

Needs Playwright in any venv (`pip install playwright fastapi uvicorn python-multipart`; Chromium from
`playwright install chromium`), ffmpeg, and two servers:
  python frontend/e2e/scenario_server.py --port 8002                    # misbehaving fake backend
  MOCK=1 .venv/bin/python -m uvicorn backend.main:app --port 8003       # real backend, fixtures only
Optional: the real backend on 8000 for `real` (non-speaking: demo clip -> review screenshot, never /api/speak).
Run:  python frontend/e2e/e2e.py [case ...]      (no args = all except `real`; screenshots go to docs/screenshots/)
Never uses a real microphone or speakers: Chrome's fake capture device plays frontend/demo-clip.m4a (as WAV).
"""
import json
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "docs" / "screenshots"
SCEN = "http://localhost:8002/"
MOCK = "http://localhost:8003/"
REAL = "http://localhost:8000/"
TMP = Path(tempfile.mkdtemp(prefix="vf-e2e-"))
FAKE_MIC = TMP / "fake-mic.wav"
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def scenario(name, **extra):
    req = urllib.request.Request(SCEN + "__scenario", data=json.dumps({"name": name, **extra}).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req).read()


def live_calls():
    return json.loads(urllib.request.urlopen(SCEN + "__live_calls").read())


def shot(pg, name, full=False):
    SHOTS.mkdir(parents=True, exist_ok=True)
    pg.mouse.move(1, 1)  # no stray hover styles in the docs
    pg.wait_for_timeout(200)
    pg.screenshot(path=str(SHOTS / f"{name}.png"), full_page=full)


def state(pg):
    return pg.evaluate("document.body.dataset.state")


def steps(pg):
    return pg.evaluate("[...document.querySelectorAll('.step')].map(s => s.dataset.status).join(',')")


def wait_visible(pg, sel, timeout_s):
    t = time.time()
    pg.wait_for_selector(sel, state="visible", timeout=timeout_s * 1000)
    return time.time() - t


def page(b, url, w=1280, h=720, **ctx):
    c = b.new_context(viewport={"width": w, "height": h}, **ctx)
    pg = c.new_page()
    pg.errs = []
    pg.on("pageerror", lambda e: pg.errs.append(str(e)))
    pg.goto(url)
    pg.evaluate("localStorage.clear()")
    return pg


def start(pg, url, terms=""):
    pg.goto(url)
    pg.fill("#terms", terms)
    pg.click("#demo")


def done(pg):
    pg.context.close()


# ---------------------------------------------------------------- happy path + live (MOCK=1 backend)
def case_happy(b, video_dir=None):
    """Fake mic -> live draft -> stop -> progress -> review -> simulate bad edit -> blocked -> speak -> playing."""
    ctx = b.new_context(viewport={"width": 1280, "height": 720}, record_video_dir=video_dir,
                        record_video_size={"width": 1280, "height": 720} if video_dir else None)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(MOCK)
    pg.evaluate("localStorage.clear()")
    pg.reload()
    pg.wait_for_timeout(800)
    if not video_dir:
        shot(pg, "idle")
        check("happy: idle, step 1 current, steps 2 and 3 waiting", state(pg) == "idle" and steps(pg) == "current,waiting,waiting", steps(pg))
        check("happy: first-run tip shown", pg.is_visible("#first-run"))
        check("happy: empty states say what to do", "after you record" in pg.inner_text("#review-empty") and "Nothing is spoken until you do" in pg.inner_text("#hear-empty"))
    pg.click("#record")
    pg.wait_for_function("document.body.dataset.state === 'recording'", timeout=5000)
    pg.wait_for_function("document.getElementById('meter-label').dataset.s === 'speech'", timeout=6000)
    check("happy: meter says Speaking for the fake mic voice", pg.inner_text("#meter-label") == "Speaking")
    check("happy: meter has a text alternative", pg.get_attribute("#meter", "aria-valuetext") == "speaking")
    pg.wait_for_function("document.getElementById('live').dataset.s === 'text'", timeout=9000)
    check("happy: live draft fills in from POST /api/live (T1 MOCK)", len(pg.inner_text("#live-text").split()) >= 3, pg.inner_text("#live-text"))
    pg.wait_for_timeout(2500 if video_dir else 600)
    if not video_dir:
        shot(pg, "recording-live")
    pg.click("#record")
    pg.wait_for_function("['uploading','processing'].includes(document.body.dataset.state)", timeout=5000)
    check("happy: after stop, step 2 shows progress", steps(pg) == "done,current,waiting" and pg.is_visible("#stages"), steps(pg))
    pg.wait_for_selector("#result:not([hidden])", timeout=25000)
    check("happy: ready state", state(pg) == "ready")
    check("happy: steps 1 done, 2 current, 3 next", steps(pg) == "done,current,next", steps(pg))
    check("happy: focus moved to the Review step", pg.evaluate("document.activeElement.id") == "h-review")
    check("happy: one meaning-check line says passed", pg.get_attribute("#check", "data-s") == "pass" and "passed" in pg.inner_text("#check"))
    check("happy: technical detail is behind one closed panel", not pg.evaluate("document.getElementById('how').open") and pg.is_hidden("#trace"))
    check("happy: diff shows removed and added words", pg.locator("#diff del").count() > 0 and pg.locator("#diff ins").count() > 0)
    pg.locator("#diff .hunk").first.focus()
    check("happy: focusing a change shows why", pg.is_visible("#diff .hunk:focus .chip"))
    pg.click("#show-said")
    check("happy: compare toggle shows what you said", pg.is_visible("#verbatim") and pg.is_hidden("#diff"))
    pg.click("#show-final")
    pg.wait_for_timeout(2000 if video_dir else 400)
    if not video_dir:
        shot(pg, "ready")
    pg.click("#how summary")
    pg.wait_for_timeout(1500 if video_dir else 0)
    pg.check("#bad")
    pg.wait_for_function("document.body.dataset.state === 'guard-failed'", timeout=8000)
    check("happy: simulate bad edit -> blocked with one-sentence reason", "Blocked" in pg.inner_text("#check") and "Friday" in pg.inner_text("#check"))
    check("happy: speak disabled with a reason", pg.is_disabled("#speak") and "blocked" in pg.inner_text("#speak-reason"))
    pg.evaluate("document.getElementById('how').open = false; window.scrollTo(0, 0)")
    pg.wait_for_timeout(2500 if video_dir else 400)
    if not video_dir:
        shot(pg, "guard-blocked")
    pg.evaluate("document.getElementById('how').open = true")
    pg.uncheck("#bad")
    pg.wait_for_function("document.body.dataset.state === 'ready'", timeout=8000)
    pg.evaluate("document.getElementById('how').open = false; window.scrollTo(0, 0)")
    pg.click("#speak")
    pg.wait_for_function("document.body.dataset.state === 'playing'", timeout=15000)
    check("happy: approve -> playing, step 3 current", steps(pg) == "done,done,current", steps(pg))
    check("happy: synthetic label shown", "synthetic audio" in pg.inner_text("#output"))
    check("happy: focus moved to the player", pg.evaluate("document.activeElement.id") == "play-btn")
    pg.wait_for_timeout(1500)
    check("happy: playback progress moves", float(pg.get_attribute("#bar", "aria-valuenow")) > 0)
    pg.wait_for_timeout(2000 if video_dir else 0)
    if not video_dir:
        shot(pg, "playing")
    check("happy: download link present", pg.locator("#downloads a[download]").count() >= 1)
    check("happy: no page errors", not errs, "; ".join(errs))
    ctx.close()
    return pg.video.path() if video_dir else None


def case_live(b):
    """Contract checks against the scenario server: cumulative audio, increasing seq, one in flight, 429, 404."""
    scenario("ok", live="slow")
    pg = page(b, SCEN)
    pg.click("#record")
    pg.wait_for_function("document.getElementById('live').dataset.s === 'text'", timeout=10000)
    pg.wait_for_timeout(7000)
    pg.click("#record")
    stopped = len(live_calls()["calls"])
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    pg.wait_for_timeout(3500)
    lc = live_calls()
    calls = lc["calls"]
    seqs = [c["seq"] for c in calls]
    check("live: several requests while recording", len(calls) >= 3, str(seqs))
    check("live: seq increases", seqs == sorted(seqs) and len(set(seqs)) == len(seqs), str(seqs))
    check("live: audio is cumulative (grows each time)", all(calls[i]["bytes"] < calls[i + 1]["bytes"] for i in range(len(calls) - 1)), str([c["bytes"] for c in calls]))
    check("live: every request starts with the webm header", all(c["webm_header"] for c in calls))
    check("live: never more than one request in flight", lc["max_inflight"] == 1, str(lc["max_inflight"]))
    check("live: no requests after recording stops", len(calls) == stopped, f"{stopped} -> {len(calls)}")
    check("live: draft hidden once the final text is ready", pg.is_hidden("#live"))
    done(pg)

    scenario("ok", live="busy")
    pg = page(b, SCEN)
    pg.click("#record")
    pg.wait_for_timeout(10000)
    text = pg.inner_text("#live-text")
    pg.click("#record")
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    check("live 429 busy: ticks skipped quietly, draft still fills", len(text.split()) >= 5 and not pg.errs, text)
    done(pg)

    scenario("ok", live="404")
    pg = page(b, SCEN)
    pg.click("#record")
    pg.wait_for_timeout(4500)
    check("live 404: live area hidden gracefully", pg.is_hidden("#live"))
    check("live 404: meter keeps working", pg.inner_text("#meter-label") in ("Speaking", "Silence"))
    pg.click("#record")
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    check("live 404: final transcript still comes from /api/process", "Ariane" in pg.inner_text("#verbatim"))
    done(pg)
    scenario("ok")


def case_escape(b):
    scenario("hang-edit")
    pg = page(b, SCEN)
    pg.focus("body")
    pg.keyboard.press("Space")
    pg.wait_for_function("document.body.dataset.state === 'recording'", timeout=5000)
    pg.wait_for_timeout(1500)
    pg.keyboard.press("Escape")
    pg.wait_for_function("document.body.dataset.state === 'idle'", timeout=5000)
    check("Escape while recording cancels, nothing is sent", steps(pg) == "current,waiting,waiting" and "cancelled" in pg.inner_text("#announce").lower())
    pg.click("#demo")
    pg.wait_for_function("document.body.dataset.state === 'processing'", timeout=5000)
    pg.keyboard.press("Escape")
    pg.wait_for_function("document.body.dataset.state === 'idle'", timeout=5000)
    check("Escape while processing cancels the job", steps(pg) == "current,waiting,waiting" and pg.evaluate("document.activeElement.id") == "record")
    done(pg)
    scenario("ok")


# ---------------------------------------------------------------- watchdog + fallbacks (scenario server)
def case_offline_hang(b):
    pg = page(b, MOCK + "?mock=1&hang=1")
    start(pg, MOCK + "?mock=1&hang=1")
    took = wait_visible(pg, "#watch", 17)
    check("offline ?hang=1: watchdog message appears within 15 s", took <= 15.5, f"{took:.1f}s")
    check("offline hang: message names the AI editor", "AI editor" in pg.inner_text("#watch-msg"))
    t1 = pg.inner_text("#elapsed"); pg.wait_for_timeout(1200); t2 = pg.inner_text("#elapsed")
    check("offline hang: elapsed seconds tick", t1 != t2 and t2.endswith("s"), f"{t1} -> {t2}")
    pg.click("#wd-plain")
    pg.wait_for_selector("#result:not([hidden])", timeout=5000)
    final = pg.input_value("#final-text")
    check("use text without AI edit: fillers stripped, words kept", " um " not in final.lower() and "Monday" in final, final)
    check("use text without AI edit: rung note explains it", "skip the AI edit" in pg.inner_text("#rung-text"))
    pg.wait_for_function("document.body.dataset.state === 'guard-failed'", timeout=5000)
    check("use text without AI edit: meaning check ran and blocked", pg.get_attribute("#check", "data-s") == "block")
    check("use text without AI edit: speak gated until override", pg.is_disabled("#speak"))
    pg.check("#override")
    check("use text without AI edit: override enables speak", not pg.is_disabled("#speak"))
    done(pg)


def case_hang_edit(b):
    scenario("hang-edit")
    pg = page(b, SCEN)
    t0 = time.time()
    start(pg, SCEN)
    took = wait_visible(pg, "#watch", 17)
    check("SSE hang at Edit (keep-alives only): warning within 15 s", took <= 15.5, f"{took:.1f}s")
    check("hang at Edit: Edit is the active step in the progress line", pg.get_attribute('#stages li[data-stage="edit"]', "data-status") == "start")
    shot(pg, "watchdog-slow-edit")
    pg.wait_for_function("document.body.dataset.state === 'error'", timeout=65000)
    stopped = time.time() - t0
    check("hard stop at 60 s puts the page in an error state", 58 <= stopped <= 63, f"{stopped:.1f}s")
    check("hard stop message is explicit", "stopped waiting after 60 seconds" in pg.inner_text("#watch-msg"))
    check("hard stop keeps the way-out buttons", pg.is_visible("#wd-plain") and pg.is_visible("#wd-retry"))
    check("hard stop shown as an error (red)", pg.get_attribute("#watch", "data-tone") == "bad")
    shot(pg, "watchdog-hard-stop")
    pg.click("#wd-plain")
    pg.wait_for_selector("#result:not([hidden])", timeout=8000)
    pg.wait_for_function("!document.getElementById('speak').disabled", timeout=8000)
    check("after hard stop, plain text is usable and speakable", "Ariane" in pg.input_value("#final-text"))
    done(pg)


def case_stall_poll(b):
    scenario("stall-poll")
    pg = page(b, SCEN)
    start(pg, SCEN)
    took = wait_visible(pg, "#watch", 18)
    check("poll fallback, frozen snapshot: stall detected", took <= 16, f"{took:.1f}s")
    pg.wait_for_function("document.getElementById('watch-msg').textContent.includes('No update from the server')", timeout=8000)
    check("stall message says the server went quiet", "No update from the server" in pg.inner_text("#watch-msg"))
    scenario("ok")
    pg.click("#wd-retry")
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    check("Try again resubmits the recording and completes", state(pg) == "ready" and pg.is_hidden("#watch"))
    done(pg)


def case_hang_asr(b):
    scenario("hang-asr")
    pg = page(b, SCEN)
    start(pg, SCEN)
    wait_visible(pg, "#watch", 17)
    check("hang in Hear: message is about speech recognition", "Speech recognition" in pg.inner_text("#watch-msg"))
    pg.click("#wd-plain")
    pg.wait_for_function("document.getElementById('watch-msg').textContent.includes('no transcript yet')", timeout=8000)
    check("no transcript yet: says so instead of showing empty text", pg.is_hidden("#result"))
    done(pg)
    scenario("ok")


def case_fallbacks(b):
    scenario("fallback-minimal")
    pg = page(b, SCEN, h=900)
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    rung = pg.inner_text("#rung-text")
    check("minimal rung: says AI editor had an error", "AI editor (Gemma 4) had an internal error" in rung, rung)
    check("minimal rung: says what was and wasn't changed", "only removed filler words" in rung and "Nothing was reworded" in rung, rung)
    notes = pg.inner_text("#notes")
    check("notes: Decisions outage explained", "OpenAI Decisions) was unavailable" in notes, notes)
    pg.click("#how summary")
    tr = pg.inner_text("#trace")
    check("trace (in How this was made): 429 -> out of credits", "out of credits or rate-limited" in tr, tr)
    check("trace: 500 -> internal error", "had an internal error" in tr, tr)
    check("trace: raw error kept behind details", pg.locator("#trace details").count() == 2)
    shot(pg, "fallback-minimal")
    done(pg)

    scenario("fallback-selfcorrected")
    pg = page(b, SCEN)
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    rung = pg.inner_text("#rung-text")
    check("no-credits rung: blames credits, not the meaning check", "out of credits" in rung and "meaning check" not in rung, rung)
    check("no-credits rung: says corrections were kept by rules", "only the correction was kept" in rung, rung)
    check("no-credits: raw backend notes not repeated", pg.is_hidden("#notes"))
    done(pg)

    scenario("fallback-original")
    pg = page(b, SCEN)
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    rung = pg.inner_text("#rung-text")
    check("original rung: timeout explained", "didn't answer in time" in rung, rung)
    check("original rung: nothing changed, exactly what we heard", "nothing was changed" in rung and "exactly what we heard" in rung, rung)
    done(pg)

    scenario("fallback-watchdog")
    pg = page(b, SCEN)
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    rung = pg.inner_text("#rung-text")
    check("backend watchdog: blames the slow AI, not the meaning check", "took too long" in rung and "meaning check" not in rung, rung)
    check("backend watchdog: raw note not shown", pg.is_hidden("#notes"))
    done(pg)
    scenario("ok")


SPEAK_EXPECT = {
    "voice_starting": ("still starting up", "Wait about a minute."),
    "voice_not_set_up": ("isn't set up in Twinly", "Build my clone"),
    "twinly_offline": ("can't reach the Twinly app", "quit Twinly (Cmd+Q) and reopen it"),
    "rate_limited": ("Too many voice requests", "Wait one minute."),
    "job_unverified": ("couldn't confirm whether it spoke", "Do not press speak again"),
}


def case_speak_errors(b):
    for code, (msg, step) in SPEAK_EXPECT.items():
        scenario("speak-" + code)
        pg = page(b, SCEN, h=900)
        start(pg, SCEN)
        pg.wait_for_selector("#result:not([hidden])", timeout=15000)
        pg.click("#speak")
        pg.wait_for_selector("#err-hear:not([hidden])", timeout=10000)
        text = pg.inner_text("#err-hear")
        check(f"speak {code}: message + fix steps right under the button", msg in text and step in text, text)
        check(f"speak {code}: page error-free", not pg.errs, "; ".join(pg.errs))
        if code == "job_unverified":
            check("job_unverified: speak locked for this job, with the reason", pg.is_disabled("#speak") and "Locked" in pg.inner_text("#speak-reason"))
            pg.click("#edit-btn")
            pg.fill("#final-text", pg.input_value("#final-text") + " ")
            pg.wait_for_timeout(1200)
            pg.click("#edit-done")
            check("job_unverified: stays locked after editing", pg.is_disabled("#speak"))
            pg.evaluate("window.scrollTo(0, 0)")
            shot(pg, "speak-job-unverified")
        if code == "twinly_offline":
            check("twinly_offline: speak disabled, reason says text-only", pg.is_disabled("#speak") and "offline" in pg.inner_text("#speak-reason"))
            pg.evaluate("window.scrollTo(0, 0)")
            shot(pg, "speak-twinly-offline")
        done(pg)
    scenario("ok")


def case_names(b):
    scenario("ok")
    pg = page(b, SCEN)
    start(pg, SCEN, terms="Aryan Patel")
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    names = pg.inner_text("#names")
    check("names: ASR mishearing surfaced", "heard “Ariane Patel” instead" in names, names)
    check("happy: demo clip length shown", pg.inner_text("#timer") != "0:00", pg.inner_text("#timer"))
    pg.evaluate("window.scrollTo(0, 0)")
    shot(pg, "names-check")
    pg.click("#names-list button")
    pg.wait_for_timeout(1500)
    check("names: one click fixes the final text", "Aryan Patel" in pg.input_value("#final-text"))
    check("names: now shows as fixed", "the text now uses “Aryan Patel”" in pg.inner_text("#names"), pg.inner_text("#names"))
    pg.reload()
    check("names: field remembered across reloads", pg.input_value("#terms") == "Aryan Patel")
    done(pg)


def case_health(b):
    scenario("ok", health={"gemma": "no_credits", "decisions": "auth_error"})
    pg = page(b, SCEN)
    pg.wait_for_function("document.getElementById('status-dot').dataset.s === 'warn'", timeout=5000)
    check("status: degraded AI shown calmly in the header", pg.inner_text("#status-sum") == "2 services limited", pg.inner_text("#status-sum"))
    pg.click("#status-btn")
    pop = pg.inner_text("#status-pop")
    check("status: no_credits in plain words", "AI editor (Gemma 4)" in pop and "Unavailable (no credits): rule-based edits only" in pop, pop)
    check("status: auth_error in plain words", "Unavailable (API key rejected): fixed meaning checks only" in pop, pop)
    shot(pg, "status-popover")
    pg.keyboard.press("Escape")
    check("status: Escape closes the popover and returns focus", pg.is_hidden("#status-pop") and pg.evaluate("document.activeElement.id") == "status-btn")
    done(pg)

    scenario("ok", health={"twinly": {"online": False, "voice_ready": False}})
    pg = page(b, SCEN)
    pg.wait_for_function("document.getElementById('status-dot').dataset.s === 'bad'", timeout=5000)
    check("status: voice offline in the header", pg.inner_text("#status-sum") == "Voice offline", pg.inner_text("#status-sum"))
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    check("voice offline: you still get text; speak disabled with reason", pg.is_disabled("#speak") and "offline" in pg.inner_text("#speak-reason"))
    done(pg)
    scenario("ok")


# ---------------------------------------------------------------- keyboard + accessibility + layout
def tab_until(pg, target, limit=40):
    for _ in range(limit):
        pg.keyboard.press("Tab")
        if pg.evaluate("document.activeElement.id") == target:
            return True
    return False


def case_keyboard(b):
    pg = page(b, MOCK)
    pg.reload()
    order = []
    for _ in range(6):
        pg.keyboard.press("Tab")
        order.append(pg.evaluate("document.activeElement.id || document.activeElement.className"))
    want = ["skip", "status-btn", "first-run-close", "record", "demo", "terms"]
    check("keyboard: Tab order follows the page (header, then step 1)", order == want, str(order))
    pg.focus("#status-btn"); pg.keyboard.press("Enter")
    check("keyboard: Enter opens the status popover", pg.is_visible("#status-pop"))
    pg.keyboard.press("Escape")
    pg.focus("#demo"); pg.keyboard.press("Enter")
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    check("keyboard: focus lands on step 2 when the text is ready", pg.evaluate("document.activeElement.id") == "h-review")
    seen = []
    for _ in range(40):
        pg.keyboard.press("Tab")
        i = pg.evaluate("document.activeElement.id || document.activeElement.className")
        seen.append(i)
        if i == "speak":
            break
    check("keyboard: from Review, Tab reaches Speak in my voice (step 3)", seen[-1] == "speak", str(seen))
    check("keyboard: Review controls come before step 3", seen.index("show-final") < seen.index("speak") and "hunk" in seen)
    rings = pg.evaluate("""() => ['record','speak','show-final','edit-btn','status-btn'].map(id => {
        const e = document.getElementById(id); e.focus(); const cs = getComputedStyle(e);
        return [id, cs.outlineStyle, parseFloat(cs.outlineWidth)]; })""")
    check("keyboard: visible focus ring on key controls", all(s == "solid" and w >= 2 for _, s, w in rings), str(rings))
    pg.focus("#speak")
    pg.keyboard.press("Enter")
    pg.wait_for_function("document.body.dataset.state === 'playing'", timeout=15000)
    check("keyboard: Enter on Speak plays audio and focus moves to the player", pg.evaluate("document.activeElement.id") == "play-btn")
    pg.keyboard.press("Enter")
    check("keyboard: Enter on the player pauses", pg.get_attribute("#play-btn", "aria-label") == "Play")
    pg.evaluate("document.activeElement.blur()")
    pg.keyboard.press("Space")
    pg.wait_for_function("document.body.dataset.state === 'recording'", timeout=5000)
    check("keyboard: Space starts recording (fake mic)", True)
    pg.wait_for_timeout(1500)
    pg.keyboard.press("Space")
    pg.wait_for_function("document.body.dataset.state !== 'recording'", timeout=5000)
    check("keyboard: Space stops recording and submits", state(pg) in ("uploading", "processing", "ready"))
    pg.focus("#record")
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    pg.focus("#record")
    pg.keyboard.press("Enter")
    pg.wait_for_function("document.body.dataset.state === 'recording'", timeout=5000)
    check("keyboard: Enter on the record button records", True)
    pg.keyboard.press("Escape")
    pg.wait_for_function("document.body.dataset.state === 'idle'", timeout=5000)
    check("keyboard: Escape cancels the recording", True)
    pg.click("#demo")
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    pg.click("#edit-btn")
    check("keyboard: Edit focuses the text box", pg.evaluate("document.activeElement.id") == "final-text")
    pg.keyboard.type(" Extra words.")
    pg.keyboard.press("Escape")
    check("keyboard: Escape cancels the edit and restores the text", "Extra words" not in pg.input_value("#final-text") and pg.evaluate("document.activeElement.id") == "edit-btn")
    check("keyboard: no page errors", not pg.errs, "; ".join(pg.errs))
    done(pg)


AUDIT_JS = """() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return m.length > 3 ? m : [...m, 1]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0.5) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
  const vis = (el) => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const out = { small: [], primary: [], low: [], ui: [], checked: 0, controls: 0 };
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || el.closest('.chip, .sr-only')) continue;  // tooltips are checked by hand: white on near-black
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el); out.checked++;
    if (parseFloat(cs.fontSize) < 16) out.small.push(el.tagName + '#' + el.id + '.' + el.className + ' ' + cs.fontSize);
    if (el.closest('#diff, #verbatim, #live-text, #final-text') && parseFloat(cs.fontSize) < 18) out.primary.push(el.tagName + ' ' + cs.fontSize);
    const r = ratio(parse(cs.color), bgOf(el));
    if (r < 4.5) out.low.push(el.tagName + '.' + el.className + ' "' + el.textContent.trim().slice(0, 30) + '" ' + r.toFixed(2));
  }
  // UI boundaries: bordered controls need 3:1 against what is behind them; filled ones need their fill to.
  for (const el of document.querySelectorAll('input[type=text], textarea, .btn, .seg, .status-btn, .record, .play-btn, .override, input[type=checkbox]')) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el), behind = bgOf(el.parentElement); out.controls++;
    const bw = parseFloat(cs.borderTopWidth), border = parse(cs.borderTopColor), fill = parse(cs.backgroundColor);
    const shadow = cs.boxShadow !== 'none';
    const best = Math.max(bw > 0 && border[3] > 0.5 ? ratio(border, behind) : 0, fill[3] > 0.5 ? ratio(fill, behind) : 0, shadow ? 3 : 0,
                          el.type === 'checkbox' ? 3 : 0, el.classList.contains('btn-quiet') ? 3 : 0);
    if (best < 3) out.ui.push((el.id || el.className) + ' ' + best.toFixed(2));
  }
  // Focus ring colour vs the page and the step surface.
  const ring = parse(getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim().replace('#', '').match(/../g).map((h) => parseInt(h, 16)).join(','));
  out.focus = Math.min(ratio(ring, [255, 255, 255]), ratio(ring, parse(getComputedStyle(document.body).backgroundColor))).toFixed(2);
  return out;
}"""


def audit(pg, label):
    pg.wait_for_timeout(300)  # let colour transitions (160 ms) settle
    r = pg.evaluate(AUDIT_JS)
    check(f"audit {label}: all visible text >= 16 px ({r['checked']} elements)", not r["small"], "; ".join(r["small"][:8]))
    check(f"audit {label}: primary text (transcript, final text, live draft) >= 18 px", not r["primary"], "; ".join(r["primary"][:5]))
    check(f"audit {label}: text contrast >= 4.5:1", not r["low"], "; ".join(r["low"][:8]))
    check(f"audit {label}: control boundaries >= 3:1 ({r['controls']} controls)", not r["ui"], "; ".join(r["ui"][:8]))
    check(f"audit {label}: focus ring >= 3:1", float(r["focus"]) >= 3, r["focus"])


def case_audit(b):
    pg = page(b, MOCK)
    pg.reload()
    audit(pg, "idle")
    pg.click("#record")
    pg.wait_for_function("document.getElementById('live').dataset.s === 'text'", timeout=10000)
    audit(pg, "recording + live draft")
    pg.click("#record")
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    pg.click("#how summary")
    pg.click("#show-said"); audit(pg, "what you said"); pg.click("#show-final")
    pg.check("#bad")
    pg.wait_for_function("document.body.dataset.state === 'guard-failed'", timeout=8000)
    audit(pg, "review + blocked + how panel open")
    pg.click("#status-btn")
    audit(pg, "status popover")
    done(pg)
    scenario("speak-twinly_offline", health={"gemma": "no_credits"})
    pg = page(b, SCEN)
    start(pg, SCEN, terms="Aryan Patel")
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    pg.click("#speak")
    pg.wait_for_selector("#err-hear:not([hidden])", timeout=10000)
    audit(pg, "speak error + names")
    done(pg)
    scenario("hang-edit")
    pg = page(b, SCEN)
    start(pg, SCEN)
    wait_visible(pg, "#watch", 17)
    audit(pg, "watchdog")
    done(pg)
    scenario("ok")


def overflow(pg):
    return pg.evaluate("document.documentElement.scrollWidth - window.innerWidth")


def case_layout(b):
    pg = page(b, MOCK)
    pg.reload()
    tops = pg.evaluate("[...document.querySelectorAll('.step h2')].map(h => h.getBoundingClientRect().bottom)")
    check("1280x720: all three steps visible without scrolling", all(t < 720 for t in tops), str(tops))
    check("1280x720: record button visible without scrolling", pg.evaluate("document.getElementById('record').getBoundingClientRect().bottom") < 720)
    check("1280x720: no horizontal scroll", overflow(pg) <= 0, str(overflow(pg)))
    pg.click("#demo")
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    check("1280x720: text and Speak button both visible after review is ready",
          pg.evaluate("document.getElementById('speak').getBoundingClientRect().bottom < 720 && document.getElementById('diff').getBoundingClientRect().top < 720"))
    done(pg)
    # 200% zoom of a 1280x720 screen = 640x360 CSS px at device scale 2.
    pg = page(b, MOCK, w=640, h=360, device_scale_factor=2)
    pg.reload()
    check("200% zoom: no horizontal scroll (idle)", overflow(pg) <= 0, str(overflow(pg)))
    check("200% zoom: steps stack in order", pg.evaluate("""(() => { const s = [...document.querySelectorAll('.step')].map(e => e.getBoundingClientRect());
        return s[0].bottom <= s[1].top && s[1].bottom <= s[2].top; })()"""))
    shot(pg, "zoom-200")
    pg.click("#demo")
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    pg.click("#how summary")
    check("200% zoom: no horizontal scroll (review + panel open)", overflow(pg) <= 0, str(overflow(pg)))
    clipped = pg.evaluate("""[...document.querySelectorAll('button, a.btn, .step h2, .check, label')].filter(e => e.getClientRects().length && e.scrollWidth > e.clientWidth + 1).map(e => e.id || e.className)""")
    check("200% zoom: no clipped buttons or labels", not clipped, str(clipped))
    pg.focus("#speak")
    check("200% zoom: Speak button reachable", pg.is_visible("#speak"))
    done(pg)


def case_motion(b):
    pg = page(b, MOCK + "?mock=1&hang=1", reduced_motion="reduce")
    start(pg, MOCK + "?mock=1&hang=1")
    pg.wait_for_selector('#stages li[data-status="start"]', timeout=5000)
    anim = pg.evaluate("getComputedStyle(document.querySelector('#stages li[data-status=\"start\"] .st-ic')).animationName")
    dur = pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--dur').trim()")
    check("reduced motion: spinner and transitions off", anim == "none" and dur == "0ms", f"{anim} {dur}")
    done(pg)


def case_gif(b):
    """Record the happy path (MOCK=1 data, fake mic) and convert it to docs/demo.gif with ffmpeg."""
    with tempfile.TemporaryDirectory() as tmp:
        webm = case_happy(b, video_dir=tmp)
        out = ROOT / "docs" / "demo.gif"
        vf = "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=64[p];[b][p]paletteuse=dither=bayer"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", webm, "-vf", vf, str(out)], check=True)
        check(f"gif: docs/demo.gif written ({out.stat().st_size // 1024} KB)", out.stat().st_size > 10000)


def case_real(b):
    """Non-speaking run on the real backend (T1, port 8000): demo clip -> review. Never presses Speak."""
    pg = page(b, REAL, h=900)
    pg.reload()
    pg.wait_for_function("document.getElementById('status-dot').dataset.s !== 'unknown'", timeout=10000)
    pg.click("#demo")
    pg.wait_for_selector("#result:not([hidden])", timeout=70000)
    pg.wait_for_timeout(800)
    pg.evaluate("window.scrollTo(0, 0)")
    check("real backend: demo clip reaches Review", "Ariane" in pg.inner_text("#verbatim") or len(pg.inner_text("#verbatim")) > 20, pg.inner_text("#verbatim")[:80])
    shot(pg, "real-run")
    print("  real run: rung=", pg.evaluate("app.job.rung"), " check=", pg.inner_text("#check"), " status=", pg.inner_text("#status-sum"))
    done(pg)


CASES = {"happy": case_happy, "live": case_live, "escape": case_escape, "offline_hang": case_offline_hang, "hang_edit": case_hang_edit,
         "stall_poll": case_stall_poll, "hang_asr": case_hang_asr, "fallbacks": case_fallbacks, "speak_errors": case_speak_errors,
         "names": case_names, "health": case_health, "keyboard": case_keyboard, "audit": case_audit, "layout": case_layout,
         "motion": case_motion, "gif": case_gif, "real": case_real}

if __name__ == "__main__":
    pick = sys.argv[1:] or [c for c in CASES if c != "real"]
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", str(ROOT / "frontend" / "demo-clip.m4a"), "-ar", "48000", "-ac", "1", str(FAKE_MIC)], check=True)
    args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={FAKE_MIC}",
            "--autoplay-policy=no-user-gesture-required", "--mute-audio"]
    with sync_playwright() as p:
        b = p.chromium.launch(args=args)
        for name in pick:
            print(f"--- {name}")
            try:
                CASES[name](b)
            except Exception as e:  # noqa: BLE001 - report and continue with the other cases
                check(f"{name} raised", False, f"{type(e).__name__}: {str(e).splitlines()[0]}")
        b.close()
    failed = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(failed)}/{len(results)} checks passed")
    sys.exit(1 if failed else 0)
