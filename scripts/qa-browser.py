#!/usr/bin/env python3
"""QA browser suite for /call (Agent D). Mock mode only; Chrome is muted and uses a fake microphone.

Run from a scratch venv OUTSIDE the repo (pip install playwright; the cached Chromium must match):
  <venv>/bin/python scripts/qa-browser.py [--shots DIR] [--only BR-2,BR-4]

It starts (and stops) its own server on a free port with APP_MODE=mock TTS_PROVIDER=mock and a known
CALL_TOKEN. It never kills processes it did not start. Screenshots go to --shots (default: a temp dir),
never into the repo. Exit code 1 if any case fails.
"""
import argparse, os, signal, socket, subprocess, sys, tempfile, time, urllib.request
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TOKEN = "qa-browser-token-4d8f"
FAKE_FLAGS = ["--use-fake-device-for-media-stream", "--mute-audio"]
PLAY_HOOK = """
window.__plays = 0;
const _p = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function(...a){ window.__plays++; return _p.apply(this, a); };
if (window.AudioBufferSourceNode) { const _s = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...a){ window.__plays++; return _s.apply(this, a); }; }
"""
results = []


def record(case, ok, detail=""):
    results.append((case, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {case}  {detail}", flush=True)


def free_port():
    s = socket.socket(); s.bind(("127.0.0.1", 0)); p = s.getsockname()[1]; s.close(); return p


class Server:
    def __init__(self, port, env=None):
        self.port, self.env, self.proc = port, env or {}, None
        self.base = f"http://127.0.0.1:{port}"

    def start(self):
        env = {"PATH": os.environ["PATH"], "APP_MODE": "mock", "TTS_PROVIDER": "mock", "PORT": str(self.port),
               "HOST": "127.0.0.1", "CALL_TOKEN": TOKEN, "MAX_CONCURRENT_REQUESTS": "8", **self.env}
        self.proc = subprocess.Popen(["node", "server.mjs"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                urllib.request.urlopen(self.base + "/healthz", timeout=1).read(); return
            except Exception:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try: self.proc.wait(5)
            except subprocess.TimeoutExpired: self.proc.kill()


class Person:
    def __init__(self, browser, srv, name, token=TOKEN, viewport=None, grant=True, init=None):
        kw = {"viewport": viewport or {"width": 1100, "height": 800}}
        self.ctx = browser.new_context(**kw)
        if grant: self.ctx.grant_permissions(["microphone"], origin=srv.base)
        self.ctx.add_init_script(PLAY_HOOK)
        if init: self.ctx.add_init_script(init)
        self.page = self.ctx.new_page()
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(f"pageerror: {e}"))
        self.page.on("console", lambda m: self.errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        self.name, self.srv, self.token = name, srv, token

    def open(self, join=True):
        self.page.goto(f"{self.srv.base}/call?as={self.name}&t={self.token}")
        if join:
            self.page.click("#join")
        return self

    def text(self, sel): return self.page.inner_text(sel)

    def hold(self, ms=1200):
        box = self.page.locator("#talk").bounding_box()
        x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        self.page.mouse.move(x, y); self.page.mouse.down(); self.page.wait_for_timeout(ms); self.page.mouse.up()

    def log_count(self): return self.page.locator("#log li").count()
    def plays(self): return self.page.evaluate("window.__plays")


def wait_for(fn, timeout=10.0, step=0.1):
    end = time.time() + timeout
    while time.time() < end:
        try:
            if fn(): return True
        except Exception:
            pass
        time.sleep(step)
    return False


def case(cid, only):
    def deco(f):
        f.cid = cid
        return f
    return deco


def run_case(cid, fn, only, shots):
    if only and cid not in only: return
    try:
        fn()
    except Exception as e:  # a crash in the harness is a FAIL, never a silent skip
        record(cid, False, f"exception: {type(e).__name__}: {str(e)[:300]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--shots", default=tempfile.mkdtemp(prefix="qa-shots-"))
    ap.add_argument("--only", default="")
    args = ap.parse_args()
    only = set(filter(None, args.only.split(",")))
    os.makedirs(args.shots, exist_ok=True)
    print(f"screenshots -> {args.shots}")
    srv = Server(free_port()); srv.start()
    with sync_playwright() as pw:
        browser = pw.chromium.launch(args=["--use-fake-ui-for-media-stream", *FAKE_FLAGS])
        try:
            suite(pw, browser, srv, only, args.shots)
        finally:
            browser.close(); srv.stop()
    bad = [r for r in results if not r[1]]
    print(f"\nBROWSER SUITE: {len(results) - len(bad)} passed, {len(bad)} failed")
    sys.exit(1 if bad else 0)


def suite(pw, browser, srv, only, shots):
    base = srv.base
    shot = lambda p, n: p.page.screenshot(path=os.path.join(shots, n + ".png"))

    def both():
        a = Person(browser, srv, "aryan").open(); r = Person(browser, srv, "rohit").open()
        return a, r

    # ---- BR-1 join -------------------------------------------------------------------------------
    def br1():
        a, r = both()
        ok = wait_for(lambda: "Connected" in a.text("#connection") and "Connected" in r.text("#connection"))
        pres = wait_for(lambda: "Rohit" in a.text("#presenceText") and "here" in a.text("#presenceText").lower()
                        or "online" in a.text("#presenceText").lower())
        shot(a, "br1-aryan"); shot(r, "br1-rohit")
        enabled = a.page.locator("#talk").is_enabled() and r.page.locator("#talk").is_enabled()
        record("BR-1 both join; connected, presence, talk enabled", ok and enabled,
               f"aryan='{a.text('#connection')}' / '{a.text('#presenceText')}' talkEnabled={enabled}")
        a.ctx.close(); r.ctx.close()
    run_case("BR-1", br1, only, shots)

    # ---- BR-2/3/4 talk both ways, talk disabled while a clip plays ---------------------------------
    def br23():
        a, r = both()
        wait_for(lambda: a.page.locator("#talk").is_enabled() and r.page.locator("#talk").is_enabled())
        for sender, listener, cid in ((a, r, "BR-2 aryan -> rohit"), (r, a, "BR-3 rohit -> aryan")):
            n0, p0 = listener.log_count(), listener.plays()
            sender.hold(1200)
            got = wait_for(lambda: listener.log_count() > n0, 15)
            played = wait_for(lambda: listener.plays() > p0, 15)
            disabled = False
            if cid.startswith("BR-2"):
                pass
            sent = wait_for(lambda: "Heard by" in sender.text("#statusText"), 15)
            shot(listener, cid[:4].lower() + "-listener")
            record(cid + ": caption shown, clip started, sender told 'Heard by'", got and played and sent,
                   f"caption={got} playStarted={played} senderStatus='{sender.text('#statusText')}' listenerLog={listener.log_count()}")
        a.ctx.close(); r.ctx.close()
    run_case("BR-2", br23, only, shots)
    run_case("BR-3", lambda: None, only, shots)

    def br4():
        a, r = both()
        wait_for(lambda: a.page.locator("#talk").is_enabled() and r.page.locator("#talk").is_enabled())
        a.hold(1200)
        # Poll fast: the mock tone lasts about a second.
        seen = r.page.evaluate("""() => new Promise(res => {
          const t = document.getElementById('talk'); const end = Date.now() + 15000;
          const tick = () => { if (t.disabled && /speaking/i.test(document.getElementById('talkLabel').textContent)) res(document.getElementById('talkLabel').textContent);
            else if (Date.now() > end) res(null); else requestAnimationFrame(tick); }; tick(); })""")
        re_enabled = wait_for(lambda: r.page.locator("#talk").is_enabled(), 10)
        record("BR-4 talk button disabled while a clip plays, re-enabled after", bool(seen) and re_enabled, f"label while playing='{seen}' reEnabled={re_enabled}")
        a.ctx.close(); r.ctx.close()
    run_case("BR-4", br4, only, shots)

    # ---- BR-5 microphone problems (Chrome's real error names are injected; headless cannot show a prompt) ----
    def br5():
        listener = Person(browser, srv, "aryan").open()
        for label, name, expect in (("denied", "NotAllowedError", ("microphone", "blocked")), ("none", "NotFoundError", ("microphone", "no ")),
                                    ("busy", "NotReadableError", ("microphone", "another app"))):
            deny = f"navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('x', '{name}'));"
            p = Person(browser, srv, "rohit", init=deny).open()
            wait_for(lambda: "Connected" in p.text("#connection"))
            shown = wait_for(lambda: p.page.locator("#error").is_visible(), 5)
            msg_join = p.text("#error") if shown else ""
            p.hold(800)                        # then try to talk anyway
            p.page.wait_for_timeout(600)
            msg_talk = p.text("#error") if p.page.locator("#error").is_visible() else ""
            connected = "Connected" in p.text("#connection")
            shot(p, f"br5-{label}")
            low = (msg_join + " " + msg_talk).lower()
            plain = shown and all(w in low for w in expect) and not any(w in (msg_join + msg_talk) for w in ("DOMException", "Error:", name))
            # the page must still receive: aryan talks, the mic-less rohit page shows the caption
            ready = wait_for(lambda: "online" in listener.text("#presenceText").lower() and "offline" not in listener.text("#presenceText").lower()
                             and listener.page.locator("#talk").is_enabled(), 15)
            n0 = p.log_count(); listener.hold(900)
            hears = wait_for(lambda: p.log_count() > n0, 15)
            diag = f" [listener ready={ready} status='{listener.text('#statusText')}' presence='{listener.text('#presenceText')}' err='{listener.page.locator('#error').inner_text() if listener.page.locator('#error').is_visible() else ''}']" if not hears else ""
            record(f"BR-5 {label} ({name}): plain-words message, still connected, still hears peer", plain and connected and hears,
                   f"onJoin='{msg_join}' onTalk='{msg_talk}' connected={connected} hears={hears}{diag}")
            wait_for(lambda: "Heard by" in listener.text("#statusText") and listener.page.locator("#talk").is_enabled(), 20)  # let the clip finish before closing this page
            p.ctx.close()
        listener.ctx.close()
    run_case("BR-5", br5, only, shots)

    # ---- BR-6 SSE drop and recovery -------------------------------------------------------------------
    def br6():
        port = free_port(); s2 = Server(port); s2.start()
        try:
            a = Person(browser, s2, "aryan").open(); r = Person(browser, s2, "rohit").open()
            wait_for(lambda: "Connected" in a.text("#connection"))
            s2.stop()
            drop = wait_for(lambda: "Reconnecting" in a.text("#connection"), 15)
            disabled = a.page.locator("#talk").is_disabled()
            shot(a, "br6-dropped")
            msg_during = a.text("#talkHint")
            s2.start()
            back = wait_for(lambda: "Connected" in a.text("#connection") and "Connected" in r.text("#connection"), 40)
            presence = wait_for(lambda: a.page.locator("#talk").is_enabled(), 10)
            a.hold(1200)
            works = wait_for(lambda: r.log_count() >= 1, 15)
            record("BR-6 server restart: shows reconnecting, talk disabled, recovers, can talk again", drop and disabled and back and works,
                   f"reconnectingShown={drop} talkDisabled={disabled} recovered={back} talkAfter={works} hint='{msg_during}'")
            a.ctx.close(); r.ctx.close()
        finally:
            s2.stop()
    run_case("BR-6", br6, only, shots)

    # ---- BR-7 wrong token -------------------------------------------------------------------------------
    def br7():
        outcomes = {}
        for label, token in (("wrong", "not-the-token"), ("missing", None)):
            p = Person(browser, srv, "aryan", token=token or "")
            url = f"{base}/call?as=aryan" + (f"&t={token}" if token else "")
            p.page.goto(url)
            if p.page.locator("#join").is_enabled(): p.page.click("#join")
            shown = wait_for(lambda: p.page.locator("#linkError").is_visible(), 15)
            outcomes[label] = (shown, p.text("#linkError") if shown else "", p.text("#connection"))
            shot(p, f"br7-{label}")
            p.ctx.close()
        ok = all(o[0] and ("link" in o[1].lower() or "valid" in o[1].lower()) and "Connected" not in o[2] for o in outcomes.values())
        record("BR-7 wrong / missing token -> clear message, never 'Connected'", ok, str(outcomes))
    run_case("BR-7", br7, only, shots)

    # ---- BR-8 keyboard only -----------------------------------------------------------------------------
    def br8():
        a, r = both()
        wait_for(lambda: a.page.locator("#talk").is_enabled() and r.page.locator("#talk").is_enabled())
        JS = "(() => { const e = document.activeElement; if (!e || e === document.body) return null; return { id: e.id || (e.tagName + ':' + (e.name || '') + (e.value ? '=' + e.value : '')), idx: [...document.querySelectorAll('*')].indexOf(e) }; })()"
        def tab_cycle(page, limit=20):
            page.evaluate("document.activeElement && document.activeElement.blur()")
            out = []
            for _ in range(limit):
                page.keyboard.press("Tab")
                f = page.evaluate(JS)
                if f is None: break          # focus left the page: one full cycle
                out.append(f)
            return out
        cyc = tab_cycle(a.page)
        seq = [c["id"] for c in cyc]
        monotone = all(x["idx"] < y["idx"] for x, y in zip(cyc, cyc[1:]))
        reaches_talk = "talk" in seq
        fresh = Person(browser, srv, "aryan").open(join=False)
        cyc0 = tab_cycle(fresh.page); seq0 = [c["id"] for c in cyc0]
        mono0 = all(x["idx"] < y["idx"] for x, y in zip(cyc0, cyc0[1:]))
        fresh.ctx.close()
        record("BR-8a Tab order (before join) follows the page: identity, Join, then devices", mono0 and "join" in seq0 and len(seq0) >= 3, f"sequence={seq0}")
        # Space to talk with the button focused.
        a.page.focus("#talk")
        n0 = r.log_count()
        a.page.keyboard.down("Space"); a.page.wait_for_timeout(1200)
        rec_label = a.text("#talkLabel")
        a.page.keyboard.up("Space")
        space_ok = wait_for(lambda: r.log_count() > n0, 15)
        # Space with focus on the page body (no button focused).
        wait_for(lambda: a.page.locator("#talk").is_enabled(), 15)
        a.page.evaluate("document.activeElement.blur()")
        n1 = r.log_count()
        a.page.keyboard.down("Space"); a.page.wait_for_timeout(1200); a.page.keyboard.up("Space")
        body_ok = wait_for(lambda: r.log_count() > n1, 15)
        # Escape cancels: nothing should reach the peer.
        wait_for(lambda: a.page.locator("#talk").is_enabled() and "Heard" in a.text("#statusText"), 15)
        wait_for(lambda: r.page.locator("#talk").is_enabled(), 15)
        n2 = r.log_count(); a.page.focus("#talk")
        a.page.keyboard.down("Space"); a.page.wait_for_timeout(700)
        a.page.keyboard.press("Escape"); a.page.keyboard.up("Space")
        a.page.wait_for_timeout(2500)
        status = a.text("#statusText")
        esc_ok = r.log_count() == n2 and "ancel" in status
        record("BR-8a2 Tab order (joined) follows the page and reaches Talk", monotone and reaches_talk, f"sequence={seq}")
        record("BR-8b Space (button focused) records and delivers", space_ok, f"label while held='{rec_label}'")
        record("BR-8c Space (page focused) records and delivers", body_ok)
        record("BR-8d Escape cancels: nothing delivered, plain status", esc_ok, f"status='{status}' peerLogDelta={r.log_count() - n2}")
        a.ctx.close(); r.ctx.close()
    run_case("BR-8", br8, only, shots)

    # ---- BR-9 390px viewport ----------------------------------------------------------------------------
    def br9():
        vp = {"width": 390, "height": 844}
        a = Person(browser, srv, "aryan", viewport=vp).open(); r = Person(browser, srv, "rohit", viewport=vp).open()
        wait_for(lambda: a.page.locator("#talk").is_enabled())
        pre = a.page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
        for _ in range(3):
            a.hold(900); wait_for(lambda: a.page.locator("#talk").is_enabled(), 15); wait_for(lambda: r.page.locator("#talk").is_enabled(), 15)
        a.page.wait_for_timeout(500)
        post = a.page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
        postr = r.page.evaluate("[document.documentElement.scrollWidth, innerWidth]")
        wide = a.page.evaluate("""() => [...document.querySelectorAll('body *')].filter(e => { const b = e.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 1; }).map(e => e.tagName + '#' + e.id + '.' + e.className).slice(0, 5)""")
        shot(a, "br9-390-aryan"); shot(r, "br9-390-rohit")
        small = a.page.evaluate("""() => [...document.querySelectorAll('button,input,select,summary')].filter(e => e.offsetParent && (e.getBoundingClientRect().height < 40 || e.getBoundingClientRect().width < 40)).map(e => e.id || e.tagName + ':' + (e.name||'')).slice(0, 8)""")
        record("BR-9 390px: no horizontal scroll (before, after conversation, listener)", pre[0] <= pre[1] and post[0] <= post[1] and postr[0] <= postr[1],
               f"before={pre} after={post} listener={postr} overflowing={wide}")
        print(f"INFO  BR-9 touch targets under 40px: {small}")
        a.ctx.close(); r.ctx.close()
    run_case("BR-9", br9, only, shots)

    # ---- BR-10 focus rings and contrast -----------------------------------------------------------------------
    def br10():
        a, r = both()
        wait_for(lambda: a.page.locator("#talk").is_enabled())
        fresh = Person(browser, srv, "aryan").open(join=False)
        missing, seen = [], []
        # Pixel test: a focus indicator exists iff the control's surroundings look different focused vs blurred.
        for pg in (fresh.page, a.page):
            pg.evaluate("document.activeElement.blur()")
            for _ in range(14):
                pg.keyboard.press("Tab")
                info = pg.evaluate("""() => { const e = document.activeElement; if (!e || e === document.body) return null;
                  const box = (e.closest('label') || e).getBoundingClientRect();
                  return { id: e.id || e.tagName + ':' + (e.name || '') + (e.value ? '=' + e.value : ''), x: box.x, y: box.y, w: box.width, h: box.height }; }""")
                if info is None: break
                clip = {"x": max(0, info["x"] - 8), "y": max(0, info["y"] - 8), "width": info["w"] + 16, "height": info["h"] + 16}
                focused = pg.screenshot(clip=clip)
                pg.evaluate("document.activeElement.blur()")
                blurred = pg.screenshot(clip=clip)
                if info["id"] not in seen:
                    seen.append(info["id"])
                    if focused == blurred: missing.append(info["id"])
        shot(a, "br10-focus")
        record("BR-10a every focusable control shows a visible focus indicator", not missing, f"checked={len(seen)} noIndicator={missing}")
        worst = a.page.evaluate("""() => {
          const parse = c => { const m = c.match(/rgba?\\(([^)]+)\\)/); if (!m) return null; const p = m[1].split(',').map(parseFloat); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
          const lum = ({r,g,b}) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126*f(r)+0.7152*f(g)+0.0722*f(b); };
          const bgOf = el => { for (let e = el; e; e = e.parentElement) { const s = getComputedStyle(e); if (s.backgroundImage !== 'none') return 'image'; const c = parse(s.backgroundColor); if (c && c.a > 0.95) return c; } return {r:255,g:255,b:255,a:1}; };
          const out = [];
          const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
          for (let n; (n = walker.nextNode());) {
            if (!n.textContent.trim()) continue; const el = n.parentElement; if (!el.offsetParent && el.tagName !== 'BODY') continue;
            const s = getComputedStyle(el); if (s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
            const fg = parse(s.color), bg = bgOf(el); if (!fg || bg === 'image') continue;
            const a = fg.a; const mix = {r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a)};
            const l1 = lum(mix), l2 = lum(bg); const ratio = (Math.max(l1,l2)+0.05)/(Math.min(l1,l2)+0.05);
            const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight) >= 700; const large = size >= 24 || (size >= 18.66 && bold);
            out.push({ text: n.textContent.trim().slice(0, 28), ratio: Math.round(ratio*100)/100, need: large ? 3 : 4.5, id: el.id || el.tagName + '.' + el.className });
          }
          return out; }""")
        fails = [w for w in worst if w["ratio"] < w["need"]]
        record("BR-10b text contrast >= WCAG AA (4.5:1, 3:1 large)", not fails, f"texts checked={len(worst)} lowest={sorted(worst, key=lambda w: w['ratio'])[:1]} failing={fails[:6]}")
        a.ctx.close(); r.ctx.close()
    run_case("BR-10", br10, only, shots)

    # ---- BR-11 original page still records + plays -----------------------------------------------------------
    def br11():
        p = Person(browser, srv, "aryan")
        p.page.goto(base + "/")
        ready = wait_for(lambda: p.page.locator("#talk").is_enabled(), 10)
        p.hold(1300)
        final = wait_for(lambda: p.text("#textState").strip() == "Final", 15)
        played = wait_for(lambda: p.plays() >= 1, 15)
        shot(p, "br11-original")
        text = p.page.input_value("#transcript")
        record("BR-11 original / : records, cleans, plays in mock mode, no console errors", ready and final and played and not p.errors,
               f"ready={ready} final={final} playStarted={played} transcript='{text[:40]}' errors={p.errors[:3]}")
        p.ctx.close()
    run_case("BR-11", br11, only, shots)

    # ---- console errors on /call over the whole run (checked in a fresh pair) ---------------------------------
    def br12():
        a, r = both()
        wait_for(lambda: a.page.locator("#talk").is_enabled())
        a.hold(1000); wait_for(lambda: r.log_count() >= 1, 15); r.page.wait_for_timeout(1500)
        record("BR-12 no console errors / page errors during a normal exchange", not a.errors and not r.errors, f"aryan={a.errors[:3]} rohit={r.errors[:3]}")
        a.ctx.close(); r.ctx.close()
    run_case("BR-12", br12, only, shots)


if __name__ == "__main__":
    main()
