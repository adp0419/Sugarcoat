"""Headless-Chrome checks for the VoiceFlow page: watchdog, fallbacks, speak errors, names, happy path, keyboard, contrast.

Needs Playwright in any venv (`pip install playwright`; Chromium from `playwright install chromium`) and two servers:
  .venv/bin/python frontend/e2e/scenario_server.py --port 8002          # misbehaving fake backend
  MOCK=1 .venv/bin/python -m uvicorn backend.main:app --port 8003       # real backend, fixtures only
Run:  python frontend/e2e/e2e.py [case ...]      (no args = all; screenshots go to docs/screenshots/)
Never uses a real microphone: the fake-device flags feed Chrome's built-in test tone, and most cases use the demo clip.
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]
SHOTS = ROOT / "docs" / "screenshots"
SCEN = "http://localhost:8002/"
MOCK = "http://localhost:8003/"
ARGS = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"]
results = []


def check(name, cond, detail=""):
    results.append((name, bool(cond)))
    print(("PASS " if cond else "FAIL ") + name + (f"  [{detail}]" if detail and not cond else ""))


def scenario(name):
    req = urllib.request.Request(SCEN + "__scenario", data=json.dumps({"name": name}).encode(), headers={"Content-Type": "application/json"})
    urllib.request.urlopen(req).read()


def shot(pg, name, full=True):
    SHOTS.mkdir(parents=True, exist_ok=True)
    pg.screenshot(path=str(SHOTS / f"{name}.png"), full_page=full)


def state(pg):
    return pg.evaluate("document.body.dataset.state")


def wait_visible(pg, sel, timeout_s):
    t = time.time()
    pg.wait_for_selector(sel, state="visible", timeout=timeout_s * 1000)
    return time.time() - t


def start(pg, url, terms=""):
    pg.goto(url)
    pg.evaluate("localStorage.clear()")
    pg.fill("#terms", terms)
    pg.click("#demo")


# ---------------------------------------------------------------- cases
def case_offline_hang(b):
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    start(pg, MOCK + "?mock=1&hang=1")
    took = wait_visible(pg, "#watch", 17)
    check("offline ?hang=1: watchdog message appears within 15 s", took <= 15.5, f"{took:.1f}s")
    msg = pg.inner_text("#watch-msg")
    check("offline hang: message names the AI editor", "AI editor" in msg, msg)
    t1 = pg.inner_text('#stages li[data-stage="edit"] .s-ms'); pg.wait_for_timeout(1200)
    t2 = pg.inner_text('#stages li[data-stage="edit"] .s-ms')
    check("offline hang: elapsed seconds tick on the active stage", t1 != t2 and t2.endswith("s"), f"{t1} -> {t2}")
    pg.click("#wd-plain")
    pg.wait_for_selector("#result:not([hidden])", timeout=5000)
    final = pg.input_value("#final-text")
    check("use text without AI edit: fillers stripped, words kept", " um " not in final.lower() and "Monday" in final, final)
    check("use text without AI edit: rung box explains it", "skip the AI edit" in pg.inner_text("#rung-text"))
    pg.wait_for_timeout(1000)
    # The plain text keeps "Friday, no wait, Monday" (only the AI resolves self-corrections), so the mock guard blocks it:
    # the page must say so and gate speaking behind the explicit override.
    blocked = state(pg) == "guard-failed"
    check("use text without AI edit: meaning check ran on the plain text", blocked and "Blocked" in pg.inner_text("#guard-verdict"))
    check("use text without AI edit: speak gated until override", pg.is_disabled("#speak"))
    pg.check("#override")
    check("use text without AI edit: override enables speak", not pg.is_disabled("#speak"))
    pg.close()


def case_hang_edit(b):
    scenario("hang-edit")
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    t0 = time.time()
    start(pg, SCEN)
    took = wait_visible(pg, "#watch", 17)
    check("SSE hang at Edit (keep-alives only): warning within 15 s", took <= 15.5, f"{took:.1f}s")
    pg.locator("#watch").scroll_into_view_if_needed()
    pg.mouse.wheel(0, 250)
    pg.wait_for_timeout(300)
    shot(pg, "watchdog-slow-edit", full=False)
    pg.wait_for_function("document.body.dataset.state === 'error'", timeout=65000)
    stopped = time.time() - t0
    check("hard stop at 60 s puts the page in an error state", 58 <= stopped <= 63, f"{stopped:.1f}s")
    check("hard stop message is explicit", "stopped waiting after 60 seconds" in pg.inner_text("#watch-msg"))
    check("hard stop keeps the way-out buttons", pg.is_visible("#wd-plain") and pg.is_visible("#wd-retry"))
    pg.locator("#watch").scroll_into_view_if_needed()
    pg.mouse.wheel(0, 250)
    pg.wait_for_timeout(300)
    shot(pg, "watchdog-hard-stop", full=False)
    pg.click("#wd-plain")
    pg.wait_for_selector("#result:not([hidden])", timeout=8000)
    pg.wait_for_function("!document.getElementById('speak').disabled", timeout=8000)
    check("after hard stop, plain text is usable and speakable", "Ariane" in pg.input_value("#final-text"))
    pg.close()


def case_stall_poll(b):
    scenario("stall-poll")
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    start(pg, SCEN)
    took = wait_visible(pg, "#watch", 18)
    msg = pg.inner_text("#watch-msg")
    check("poll fallback, frozen snapshot: stall detected (slow or silent)", took <= 16, f"{took:.1f}s")
    pg.wait_for_function("document.getElementById('watch-msg').textContent.includes('No update from the server')", timeout=8000)
    check("stall message says the server went quiet", "No update from the server" in pg.inner_text("#watch-msg"), msg)
    scenario("ok")
    pg.click("#wd-retry")
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    check("Try again resubmits the recording and completes", state(pg) == "ready" and pg.is_hidden("#watch"))
    pg.close()


def case_hang_asr(b):
    scenario("hang-asr")
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    start(pg, SCEN)
    wait_visible(pg, "#watch", 17)
    check("hang in Hear: message is about speech recognition", "Speech recognition" in pg.inner_text("#watch-msg"))
    pg.click("#wd-plain")
    pg.wait_for_function("document.getElementById('watch-msg').textContent.includes('no transcript yet')", timeout=8000)
    check("no transcript yet: says so instead of showing empty text", pg.is_hidden("#result"))
    pg.close()


def case_fallbacks(b):
    scenario("fallback-minimal")
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    rung = pg.inner_text("#rung-text")
    check("minimal rung: says AI editor had an error", "AI editor (Gemma 4) had an internal error" in rung, rung)
    check("minimal rung: says what was and wasn't changed", "only removed filler words" in rung and "Nothing was reworded" in rung, rung)
    notes = pg.inner_text("#notes")
    check("notes: Decisions outage explained", "OpenAI Decisions) was unavailable" in notes, notes)
    pg.click(".trace summary")
    tr = pg.inner_text("#trace")
    check("trace: 429 -> out of credits", "out of credits or rate-limited" in tr, tr)
    check("trace: 500 -> internal error", "had an internal error" in tr, tr)
    check("trace: raw error kept behind details", pg.locator("#trace details").count() == 2)
    pg.locator("#trace details").first.click()
    shot(pg, "fallback-minimal")
    pg.close()

    scenario("fallback-original")
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    rung = pg.inner_text("#rung-text")
    check("original rung: timeout explained", "didn't answer in time" in rung, rung)
    check("original rung: nothing changed, exactly what we heard", "nothing was changed" in rung and "exactly what we heard" in rung, rung)
    pg.close()

    scenario("fallback-watchdog")
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    start(pg, SCEN)
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    rung = pg.inner_text("#rung-text")
    check("backend watchdog: blames the slow AI, not the meaning check", "took too long" in rung and "meaning check" not in rung, rung)
    check("backend watchdog: raw note not shown", pg.is_hidden("#notes"))
    pg.close()


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
        pg = b.new_page(viewport={"width": 1280, "height": 900})
        start(pg, SCEN)
        pg.wait_for_selector("#result:not([hidden])", timeout=15000)
        pg.click("#speak")
        pg.wait_for_selector("#error:not([hidden])", timeout=10000)
        text = pg.inner_text("#error")
        check(f"speak {code}: friendly message + fix steps", msg in text and step in text, text)
        if code == "job_unverified":
            check("job_unverified: speak button locked for this job", pg.is_disabled("#speak") and "Not resent" in pg.inner_text("#speak"))
            pg.fill("#final-text", pg.input_value("#final-text") + " ")
            pg.wait_for_timeout(1200)
            check("job_unverified: stays locked after editing", pg.is_disabled("#speak"))
            pg.locator("#error").scroll_into_view_if_needed()
            shot(pg, "speak-job-unverified", full=False)
        if code == "twinly_offline":
            pg.locator("#error").scroll_into_view_if_needed()
            shot(pg, "speak-twinly-offline", full=False)
        pg.close()
    scenario("ok")


def case_names(b):
    scenario("ok")
    pg = b.new_page(viewport={"width": 1280, "height": 900})
    start(pg, SCEN, terms="Aryan Patel")
    pg.wait_for_selector("#result:not([hidden])", timeout=15000)
    names = pg.inner_text("#names")
    check("names: ASR mishearing surfaced", "heard “Ariane Patel” instead" in names, names)
    pg.locator("#names").scroll_into_view_if_needed()
    shot(pg, "names-check", full=False)
    pg.click("#names-list button")
    pg.wait_for_timeout(1500)
    check("names: one click fixes the final text", "Aryan Patel" in pg.input_value("#final-text"))
    check("names: now shows as fixed", "the final text uses “Aryan Patel”" in pg.inner_text("#names"), pg.inner_text("#names"))
    pg.reload()
    check("names: field remembered across reloads", pg.input_value("#terms") == "Aryan Patel")
    pg.close()


def case_happy(b, video_dir=None):
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, record_video_dir=video_dir, record_video_size={"width": 1280, "height": 800} if video_dir else None)
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)))
    pg.goto(MOCK)
    pg.evaluate("localStorage.clear()")
    pg.wait_for_timeout(800)
    if not video_dir:
        shot(pg, "idle", full=False)
    check("happy: idle state", state(pg) == "idle")
    pg.fill("#terms", "Gator Hack")
    pg.click("#demo")
    pg.wait_for_function("document.body.dataset.state === 'processing'", timeout=5000)
    check("happy: processing state", True)
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    check("happy: ready state", state(pg) == "ready")
    pg.wait_for_timeout(800)
    if video_dir:  # let viewers read the diff, then scroll to the panels
        pg.wait_for_timeout(2500); pg.mouse.wheel(0, 500); pg.wait_for_timeout(2000)
    if not video_dir:
        shot(pg, "ready")
    pg.check("#bad")
    pg.wait_for_function("document.body.dataset.state === 'guard-failed'", timeout=8000)
    check("happy: simulate bad rewrite -> guard blocks", pg.is_disabled("#speak"))
    pg.locator("#guard-verdict").scroll_into_view_if_needed()
    pg.wait_for_timeout(2500 if video_dir else 800)
    if not video_dir:
        shot(pg, "guard-blocked", full=False)
    pg.uncheck("#bad")
    pg.wait_for_function("document.body.dataset.state === 'ready'", timeout=8000)
    pg.click("#speak")
    pg.wait_for_function("document.body.dataset.state === 'playing'", timeout=15000)
    check("happy: approve -> playing", True)
    pg.locator("#output").scroll_into_view_if_needed()
    pg.wait_for_timeout(3500 if video_dir else 1500)
    if not video_dir:
        shot(pg, "playing", full=False)
    check("happy: no page errors", not errs, "; ".join(errs))
    ctx.close()
    return pg.video.path() if video_dir else None


def case_dark(b):
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, color_scheme="dark")
    pg = ctx.new_page()
    pg.goto(MOCK)
    pg.click("#demo")
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    pg.wait_for_timeout(500)
    shot(pg, "ready-dark")
    ctx.close()


def case_keyboard(b):
    pg = b.new_page(viewport={"width": 1280, "height": 800})
    pg.goto(MOCK)
    order = []
    for _ in range(4):
        pg.keyboard.press("Tab")
        order.append(pg.evaluate("document.activeElement.id || document.activeElement.className"))
    check("keyboard: Tab reaches skip link, record, demo, names field", order == ["skip", "record", "demo", "terms"], str(order))
    pg.keyboard.press("Shift+Tab")
    pg.keyboard.press("Enter")  # demo clip
    pg.wait_for_selector("#result:not([hidden])", timeout=20000)
    ring = pg.evaluate("""() => { const b = document.getElementById('copy'); b.focus();
        return getComputedStyle(b).outlineStyle + ' ' + getComputedStyle(b).outlineWidth; }""")
    check("keyboard: visible focus ring", ring.startswith("solid") and not ring.endswith(" 0px"), ring)
    pg.focus("#copy")
    for _ in range(30):
        pg.keyboard.press("Tab")
        if pg.evaluate("document.activeElement.id") == "speak":
            break
    check("keyboard: Approve reachable by Tab", pg.evaluate("document.activeElement.id") == "speak")
    pg.keyboard.press("Enter")
    pg.wait_for_function("document.body.dataset.state === 'playing'", timeout=15000)
    check("keyboard: Enter on Approve plays audio", True)
    pg.focus("body")
    pg.keyboard.press("Space")
    pg.wait_for_timeout(2500)
    check("keyboard: Space starts recording (fake mic)", state(pg) == "recording", state(pg))
    pg.keyboard.press("Space")
    pg.wait_for_function("document.body.dataset.state !== 'recording'", timeout=5000)
    check("keyboard: Space stops recording", True)
    pg.close()


AUDIT_JS = """() => {
  const parse = (c) => { const m = c.match(/[\\d.]+/g).map(Number); return m.length > 3 ? m : [...m, 1]; };
  const lum = ([r, g, b]) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = (el) => { for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0.5) return c; } return parse(getComputedStyle(document.body).backgroundColor); };
  const out = { small: [], low: [], checked: 0 };
  for (const el of document.querySelectorAll('body *')) {
    if (!el.offsetParent && el.tagName !== 'BODY') continue;
    const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!own) continue;
    const cs = getComputedStyle(el); out.checked++;
    if (parseFloat(cs.fontSize) < 18) out.small.push(el.tagName + '#' + el.id + '.' + el.className + ' ' + cs.fontSize);
    const a = lum(parse(cs.color)), b = lum(bgOf(el));
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 4.5) out.low.push(el.tagName + '.' + el.className + ' "' + el.textContent.trim().slice(0, 30) + '" ' + ratio.toFixed(2));
  }
  return out;
}"""


def case_audit(b):
    for scheme in ("light", "dark"):
        ctx = b.new_context(viewport={"width": 1280, "height": 800}, color_scheme=scheme)
        pg = ctx.new_page()
        pg.goto(MOCK)
        pg.click("#demo")
        pg.wait_for_selector("#result:not([hidden])", timeout=20000)
        pg.click(".trace summary")
        r = pg.evaluate(AUDIT_JS)
        check(f"audit {scheme}: all visible text >= 18 px ({r['checked']} elements)", not r["small"], "; ".join(r["small"][:8]))
        check(f"audit {scheme}: text contrast >= 4.5:1", not r["low"], "; ".join(r["low"][:8]))
        ctx.close()


def case_gif(b):
    """Record the happy path (MOCK=1 data) and convert it to docs/demo.gif with ffmpeg."""
    import subprocess, tempfile
    with tempfile.TemporaryDirectory() as tmp:
        webm = case_happy(b, video_dir=tmp)
        out = ROOT / "docs" / "demo.gif"
        vf = "fps=8,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer"
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", webm, "-vf", vf, str(out)], check=True)
        check(f"gif: docs/demo.gif written ({out.stat().st_size // 1024} KB)", out.stat().st_size > 10000)


CASES = {"offline_hang": case_offline_hang, "hang_edit": case_hang_edit, "stall_poll": case_stall_poll, "hang_asr": case_hang_asr,
         "fallbacks": case_fallbacks, "speak_errors": case_speak_errors, "names": case_names, "happy": case_happy,
         "dark": case_dark, "keyboard": case_keyboard, "audit": case_audit, "gif": case_gif}

if __name__ == "__main__":
    pick = sys.argv[1:] or list(CASES)
    with sync_playwright() as p:
        b = p.chromium.launch(args=ARGS)
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
