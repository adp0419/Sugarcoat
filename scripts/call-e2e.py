#!/usr/bin/env python3
"""Two-browser smoke test for the call page (Playwright, Python).

Run from a scratch venv OUTSIDE the repo (see docs/CALL.md), against a server in mock mode:
  python scripts/call-e2e.py --url http://localhost:3000 --token TOKEN

Joins as aryan and rohit in separate contexts, holds talk in one, asserts the other page shows
the caption and starts playback, then the reverse. Chrome runs with a fake mic and --mute-audio.
Playback is detected DOM-agnostically by wrapping HTMLMediaElement.play and AudioBufferSourceNode.start.
"""
import argparse, os, sys, time
from playwright.sync_api import sync_playwright

# Counts playback starts on the page; works for <audio> elements and Web Audio buffer sources.
PLAY_HOOK = """
window.__plays = 0;
const _play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function(...a) { window.__plays++; return _play.apply(this, a); };
if (window.AudioBufferSourceNode) {
  const _start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function(...a) { window.__plays++; return _start.apply(this, a); };
}
"""

TALK_SELECTORS = os.environ.get("CALL_TALK_SELECTOR") or \
    "#talk"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=os.environ.get("CALL_URL", "http://localhost:3000"))
    ap.add_argument("--token", default=os.environ.get("CALL_TOKEN", ""))
    ap.add_argument("--hold", type=float, default=2.0, help="seconds to hold talk")
    ap.add_argument("--timeout", type=float, default=30.0, help="seconds to wait for caption/playback")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--chromium", action="store_true", help="use Playwright's bundled Chromium instead of installed Chrome")
    args = ap.parse_args()
    base = args.url.rstrip("/")
    failures = []

    def check(ok, msg):
        print(("  ok:   " if ok else "  FAIL: ") + msg)
        if not ok:
            failures.append(msg)

    launch_args = ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--mute-audio"]
    with sync_playwright() as p:
        kw = {"headless": not args.headed, "args": launch_args}
        if not args.chromium:
            kw["channel"] = "chrome"
        browser = p.chromium.launch(**kw)
        pages = {}
        for who in ("aryan", "rohit"):
            ctx = browser.new_context(permissions=["microphone"])
            ctx.add_init_script(PLAY_HOOK)
            page = ctx.new_page()
            page.on("pageerror", lambda e, w=who: print(f"  [{w}] page error: {e}"))
            page.goto(f"{base}/call?as={who}&t={args.token}")
            pages[who] = page
            # The page has a Join button (#join); click it if the link did not auto-join.
            join = page.locator("#join")
            try:
                join.wait_for(state="visible", timeout=3000)
                join.click()
            except Exception:  # noqa: BLE001  (already joined)
                pass
        # Talk unlocks only once both people are in the call.
        for who, page in pages.items():
            try:
                page.locator("#talk:not([disabled])").wait_for(timeout=10000)
            except Exception:  # noqa: BLE001
                check(False, f"{who} talk button never became enabled")
        time.sleep(1.5)  # let both connections settle

        def talk(sender, receiver):
            print(f"\n{sender} -> {receiver}")
            s, r = pages[sender], pages[receiver]
            before = r.evaluate("window.__plays")
            before_text = r.inner_text("body")
            # One voice at a time: the page ignores talk while it is still playing the last clip.
            idle_by = time.time() + args.timeout
            while time.time() < idle_by and not s.inner_text("#status").strip().startswith("In call"):
                time.sleep(0.25)
            btn = s.locator(TALK_SELECTORS).first
            btn.wait_for(state="visible", timeout=10000)
            btn.scroll_into_view_if_needed()  # bounding_box() is viewport-relative; mouse.move needs it on screen
            box = btn.bounding_box()
            s.mouse.move(box["x"] + box["width"] / 2, box["y"] + box["height"] / 2)
            s.mouse.down()
            time.sleep(args.hold)
            s.mouse.up()
            deadline = time.time() + args.timeout
            played = False
            while time.time() < deadline:
                if r.evaluate("window.__plays") > before:
                    played = True
                    break
                time.sleep(0.25)
            check(played, f"{receiver} page started playback")
            # A caption is new visible text on the receiver that was not there before the exchange.
            captioned = False
            while time.time() < deadline:
                if r.inner_text("body") != before_text:
                    captioned = True
                    break
                time.sleep(0.25)
            check(captioned, f"{receiver} page text changed (caption shown)")
            r.screenshot(path=f"call-e2e-{sender}-to-{receiver}.png") if os.environ.get("CALL_E2E_SHOTS") else None

        try:
            talk("aryan", "rohit")
            talk("rohit", "aryan")
        except Exception as e:  # noqa: BLE001
            failures.append(str(e))
            print(f"  FAIL: {e}")
        browser.close()

    print("\nPASS" if not failures else f"\nFAILED: {len(failures)} problem(s)")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
