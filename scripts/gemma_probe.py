"""Retest Gemma 4 on the configured Gemini key with the real rewrite prompt.

    .venv/bin/python scripts/gemma_probe.py [--repeat 3] [--timeout 30]

3 inputs (short, canonical, the user's backtrack sentence) x `repeat`, sequential. Prints HTTP-ish status,
latency and whether the reply parsed as rewrite JSON. Stops at the first account error (402/401/403):
those will not change by retrying. Never prints the key.
"""
import argparse
import asyncio
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from backend import rewrite as rw  # noqa: E402
from backend.config import settings  # noqa: E402

INPUTS = {
    "short": "So um we should meet on Tuesday, no wait, Wednesday at 3.",
    "canonical": ("So, um, I just wanted to, uh, announce that we're going to have our meeting on Friday—actually, "
                  "sorry, Monday, at 5 PM, and, um, everyone should be there."),
    "backtrack": ("I'm a computer science major here at the University of Florida. Wait, I'm actually a computer "
                  "science major, but with a minor business administration here at the University of Florida."),
}


async def one(name: str, text: str, timeout: float) -> tuple[str, float, bool, str]:
    prompt = rw.build_prompt(text, "natural")
    t = time.perf_counter()
    try:
        raw = await asyncio.wait_for(rw._generate(prompt, settings.GEMMA_MODEL), timeout)
    except asyncio.TimeoutError:
        return "no answer", time.perf_counter() - t, False, f"no reply within {timeout:.0f} s"
    except Exception as e:  # noqa: BLE001
        code = getattr(e, "code", None) or str(e)[:3]
        return str(code), time.perf_counter() - t, False, str(e).split("{")[0][:90]
    secs = time.perf_counter() - t
    try:
        res = rw.parse(raw)
        return "200", secs, True, res.rewrite[:90]
    except Exception:  # noqa: BLE001
        return "200", secs, False, f"unparsable: {raw[:80]!r}"


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repeat", type=int, default=3)
    ap.add_argument("--timeout", type=float, default=30.0)
    a = ap.parse_args()
    if not settings.GEMINI_API_KEY:
        print("GEMINI_API_KEY is not set")
        return 2
    print(f"model {settings.GEMMA_MODEL}, {a.repeat}x each, timeout {a.timeout:.0f} s, "
          f"{time.strftime('%Y-%m-%d %H:%M')}")
    print(f"{'input':<10} {'try':>3} {'status':<10} {'secs':>6} {'json':<5} detail")
    for name, text in INPUTS.items():
        for i in range(a.repeat):
            st, secs, ok, detail = await one(name, text, a.timeout)
            print(f"{name:<10} {i + 1:>3} {st:<10} {secs:6.1f} {str(ok):<5} {detail}")
            if st in ("402", "401", "403"):
                print("account error: retrying will not help; stopping.")
                return 1
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
